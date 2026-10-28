import { env } from '../config/env.js';
import { clientIp } from './refused.js';

/**
 * The relay to the worker: a request that passed the door goes to the same
 * path on the worker's port, the connection is held open until the worker
 * answers, and the answer is relayed as it came. The worker's CORS headers
 * travel back with it, which is why the door has no cors of its own.
 */

/** The request headers passed along when present; everything else stops at the door. */
const COPIED_REQUEST_HEADERS = ['content-type', 'origin', 'access-control-request-method', 'access-control-request-headers'];

/** The response headers not relayed: the hop-by-hop ones, and the two fetch has already consumed. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);

/**
 * Forwards `req` to http://WORKER_IP:<workerPort><req.originalUrl> with
 * its method, the copied headers, x-forwarded-for set to the client IP and,
 * on POST, `body`, the original bytes the door read (never a
 * re-serialization, so the canonical form the worker hashes and verifies
 * is exactly what the wallet sent). Redirects are not followed; the wait
 * is capped at WORKER_TIMEOUT_SECONDS, since a submission waits for every
 * other validator. The answer is relayed: its status, every header but the
 * dropped ones, and its body as a Buffer. A timeout answers 504
 * { "error": "worker timeout" }, any other failure 502
 * { "error": "worker unavailable" }; both log `worker <port> <message>`.
 */
export async function forward(req, res, { workerPort, body }) {
  const headers = {};
  for (const name of COPIED_REQUEST_HEADERS) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  headers['x-forwarded-for'] = clientIp(req);

  let answer;
  let bytes;
  try {
    answer = await fetch(`http://${env.workerIp}:${workerPort}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(env.timeouts.workerSeconds * 1000),
    });
    bytes = Buffer.from(await answer.arrayBuffer());
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    console.log(`worker ${workerPort} ${err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message}`);
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'worker timeout' : 'worker unavailable' });
    return;
  }

  res.status(answer.status);
  for (const [name, value] of answer.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) res.set(name, value);
  }
  res.send(bytes);
}
