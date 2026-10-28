/**
 * The per-IP rate limit of one door: a token bucket per source IP, with an
 * allowlist that skips it. Each door gets its own limiter (server.js), so
 * the rate is per IP and per port. The limiter lives in the Node door
 * rather than in nginx because the allowlist is dynamic, the registry's
 * doormen plus the env list, and nginx would need a rendered config and a
 * reload after every pull.
 */

/** How long a bucket may go untouched before the pruner drops it, and how often the pruner runs. */
const IDLE_MS = 60_000;

/**
 * Returns `allow(ip)`: true when the request may go on, false when it is to
 * be answered 429. `allowlist` is a Set of IP strings that are always
 * allowed. Every other IP has a bucket { tokens, updatedAt }, starting full
 * at `burst`: on each call the tokens are refilled by the seconds elapsed
 * times `perSecond`, capped at `burst`, and one is taken when one is there.
 * A pruning interval, unref'd so it never keeps the process alive, drops
 * buckets untouched for IDLE_MS; such a bucket is full again anyway.
 */
export function createLimiter({ perSecond, burst, allowlist }) {
  const buckets = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of buckets) {
      if (now - bucket.updatedAt >= IDLE_MS) buckets.delete(ip);
    }
  }, IDLE_MS).unref();

  return function allow(ip) {
    if (allowlist.has(ip)) return true;

    const now = Date.now();
    let bucket = buckets.get(ip);
    if (bucket === undefined) {
      bucket = { tokens: burst, updatedAt: now };
      buckets.set(ip, bucket);
    } else {
      bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.updatedAt) / 1000) * perSecond);
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}
