import { envelopeCheck } from '../checks/keyholder.js';

/**
 * The route table of the keyholder door: port 3200, forwarded to
 * WORKER_IP:3200. The keyholder's nine POST routes, each with the envelope
 * shape of its level (src/checks/keyholder.js) and a 32 KB cap (nginx caps
 * the port at 32k too; a receive-share measures under 21 KB), plus nothing
 * else: GET /health is the door's own. Shape and size only; the keys of
 * every level live elsewhere.
 */

/** The pod level: signer anopodId, both signatures. */
const pod = envelopeCheck('anopodId', { mldsa: true });

/** The moderator (or attestor) level: signer accountId, both signatures. */
const moderator = envelopeCheck('accountId', { mldsa: true });

/** The keyholder level: signer yubikey, the ecdsa signature only. */
const yubikey = envelopeCheck('yubikey', { mldsa: false });

export const keyholderRoutes = Object.freeze([
  // Level none: the worker does not read the body, so no check beyond the cap.
  { method: 'POST', path: '/get-keyholder-public-key', maxBytes: 32 * 1024, check: null },

  { method: 'POST', path: '/receive-share', maxBytes: 32 * 1024, check: pod },

  { method: 'POST', path: '/get-security-bucket-one-key', maxBytes: 32 * 1024, check: moderator },
  { method: 'POST', path: '/get-security-bucket-two-key', maxBytes: 32 * 1024, check: moderator },
  { method: 'POST', path: '/get-public-ledger-id', maxBytes: 32 * 1024, check: moderator },

  { method: 'POST', path: '/get-break-glass-key', maxBytes: 32 * 1024, check: yubikey },
  { method: 'POST', path: '/get-backup-code', maxBytes: 32 * 1024, check: yubikey },
  { method: 'POST', path: '/decrypt-break-glass-key', maxBytes: 32 * 1024, check: yubikey },
  { method: 'POST', path: '/decrypt-backup-code', maxBytes: 32 * 1024, check: yubikey },
].map(Object.freeze));
