import express from 'express';
import { env } from '../config/env.js';
import { createLimiter } from '../limit/rate-limit.js';
import { errorHandler } from './error-handler.js';
import { forward } from './forward.js';
import { createHealth } from './health.js';
import { notFound } from './not-found.js';
import { clientIp, logRefused } from './refused.js';

/**
 * One door: the Express app in front of one worker port, bound to
 * 127.0.0.1 by server.js, so nothing but nginx reaches it. The pipeline,
 * every step answering JSON:
 *
 *   1. no x-powered-by; the client IP is the X-Real-IP header nginx sets,
 *      or the socket address (refused.js clientIp);
 *   2. the rate limit: an IP that is not allowlisted and has no token left
 *      gets 429 { "error": "too many requests" } with Retry-After: 1, and
 *      no log line;
 *   3. GET /health: the door's own answer with the worker's embedded;
 *   4. OPTIONS on a path in the table: forwarded with no body and no
 *      checks, so the worker's cors answers a browser's preflight;
 *   5. a POST to a path in the table: the body is read as a Buffer up to
 *      the route's cap, whatever its content type; a Content-Type that is
 *      not application/json leaves the parsed body undefined, so the
 *      route's own check refuses it with its own reason, as the worker
 *      would; otherwise JSON.parse, a parse error answering 400
 *      { "error": "invalid JSON" }; then the route's check, a refusal
 *      logged and answered { "error": reason } with its status; a pass
 *      forwards the original bytes;
 *   6. anything else: 404 { "error": "Not Found", "path" } (not-found.js);
 *   7. the error handler, which maps a body over the cap to 413.
 */

/** True when `value`, a Content-Type header, is application/json, parameters allowed. */
function isJson(value) {
  return typeof value === 'string' && /^\s*application\/json\s*(;|$)/i.test(value);
}

/**
 * The parsed body of a POST whose bytes express.raw left in req.body:
 * { body } with the parsed JSON, or with undefined when there was no body
 * or the content type was not JSON (the worker's own parser treats both
 * the same), or { invalid: true } when the bytes are not JSON.
 */
function parseJson(req) {
  if (!Buffer.isBuffer(req.body) || !isJson(req.headers['content-type'])) return { body: undefined };
  try {
    return { body: JSON.parse(req.body.toString('utf8')) };
  } catch {
    return { invalid: true };
  }
}

/**
 * Builds the app of one door: `routes` its table (src/doors/), `workerPort`
 * the worker port it forwards to, `allowlist` the Set of IPs that skip the
 * rate limit, built once in server.js.
 */
export function createDoor({ routes, workerPort, allowlist }) {
  const app = express();
  app.disable('x-powered-by');

  // 2. The rate limit, per IP and per door.
  const allow = createLimiter({ perSecond: env.rate.perSecond, burst: env.rate.burst, allowlist });
  app.use((req, res, next) => {
    if (allow(clientIp(req))) return next();
    res.set('Retry-After', '1').status(429).json({ error: 'too many requests' });
  });

  // 3. Health.
  app.get('/health', createHealth({ workerPort }));

  // 4. and 5. The table.
  for (const route of routes) {
    app.options(route.path, (req, res) => forward(req, res, { workerPort }));

    app[route.method.toLowerCase()](
      route.path,
      express.raw({ type: () => true, limit: route.maxBytes }),
      (req, res) => {
        const parsed = parseJson(req);
        if (parsed.invalid) {
          logRefused(req, 400, 'invalid JSON');
          return res.status(400).json({ error: 'invalid JSON' });
        }
        const refusal = route.check === null ? null : route.check(parsed.body);
        if (refusal) {
          logRefused(req, refusal.status, refusal.reason);
          return res.status(refusal.status).json({ error: refusal.reason });
        }
        return forward(req, res, { workerPort, body: Buffer.isBuffer(req.body) ? req.body : undefined });
      },
    );
  }

  // 6. and 7. Order matters: these must come after every route.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
