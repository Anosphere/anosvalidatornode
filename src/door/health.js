import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { env } from '../config/env.js';
import { registry } from '../registry/registry.js';
import { version } from '../util/version.js';

/**
 * GET /health, which the door answers itself on both ports: its own fields,
 * the version (commit and tag), the registry hash and active count and the
 * certificate's expiry, with the worker's own /health JSON embedded. The
 * answer is 200 `ok` when the worker answered 200 and the certificate has
 * more than CERTIFICATE_MIN_DAYS left, else 503 `degraded`, which is how a
 * failed renewal shows: acme.sh renews on day 3 of the certificate's 6.7,
 * so under 2 days left means two renewals failed. A health sweep compares
 * the registry hashes across the network and watches daysLeft.
 */

const MS_PER_DAY = 86_400_000;

/** The certificate must have more days than this left for the status to be ok. */
const CERTIFICATE_MIN_DAYS = 2;

/** The handler for the door in front of `workerPort`. Goes through the rate limit like every other request. */
export function createHealth({ workerPort }) {
  return async function health(req, res) {
    const worker = await fetchWorkerHealth(workerPort);
    const certificate = readCertificate();
    const healthy = worker.status === 200 && certificate !== null && certificate.daysLeft > CERTIFICATE_MIN_DAYS;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptime: process.uptime(),
      doorman: {
        version,
        registry: { hash: registry.hash, active: registry.active },
        certificate,
      },
      worker: worker.body,
    });
  };
}

/**
 * The worker's /health, fetched with HEALTH_TIMEOUT_SECONDS, its JSON
 * parsed whatever its status: { status, body }. A failure or an answer
 * that is not JSON gives { status: null, body: null }.
 */
async function fetchWorkerHealth(workerPort) {
  try {
    const answer = await fetch(`http://${env.workerIp}:${workerPort}/health`, {
      signal: AbortSignal.timeout(env.timeouts.healthSeconds * 1000),
    });
    return { status: answer.status, body: await answer.json() };
  } catch {
    return { status: null, body: null };
  }
}

/**
 * The first certificate of TLS_FULLCHAIN_FILE, the one for this doorman's
 * IP: { notAfter (ISO string), daysLeft (one decimal) }, or null when the
 * file is missing (no certificate issued yet) or does not parse.
 */
function readCertificate() {
  try {
    const pem = readFileSync(env.tls.fullchainFile, 'utf8');
    const first = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
    if (!first) return null;
    const validTo = new X509Certificate(first[0]).validToDate;
    return {
      notAfter: validTo.toISOString(),
      daysLeft: Math.round(((validTo.getTime() - Date.now()) / MS_PER_DAY) * 10) / 10,
    };
  } catch {
    return null;
  }
}
