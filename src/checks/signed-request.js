import { canonicalize } from '../crypto/canonical.js';
import { decodePublicKey, decodeSignature } from '../crypto/signatures.js';
import { isObject } from '../util/is-object.js';

/**
 * The signed request envelope the worker's account level and the keyholder's
 * three levels share: { payload, signatures }, the signatures over the RFC
 * 8785 canonical bytes of payload. The field that names the signer differs
 * by level (accountId, anopodId, yubikey), and the keyholder level carries
 * only an ECDSA signature; the route tables (src/doors/) say which.
 *
 * parseSignedRequest is the shape half of anossoftware's
 * src/auth/signed-request.js (the keyholder's is the same file), copied;
 * the verifying half stays on the worker, which holds the keys. The helpers
 * below are what the door adds: whether a field decodes as a signature or a
 * public key of its algorithm, and the bytes a payload is signed as.
 */

/** The reason every shape failure answers with. */
export const BAD_SHAPE = 'bad request shape';

/**
 * Checks the envelope: `payload` an object with string `signerField`, path,
 * timestamp and nonce and an object body; `signatures` an object with
 * string ecdsa and, when `mldsa` is true, string mldsa. Returns
 * { payload, signatures } or { reason }.
 */
export function parseSignedRequest(body, signerField, { mldsa }) {
  if (!isObject(body) || !isObject(body.payload) || !isObject(body.signatures)) {
    return { reason: BAD_SHAPE };
  }
  const { payload, signatures } = body;
  if (typeof signatures.ecdsa !== 'string') return { reason: BAD_SHAPE };
  if (mldsa && typeof signatures.mldsa !== 'string') return { reason: BAD_SHAPE };
  for (const field of [signerField, 'path', 'timestamp', 'nonce']) {
    if (typeof payload[field] !== 'string') return { reason: BAD_SHAPE };
  }
  if (!isObject(payload.body)) return { reason: BAD_SHAPE };
  return { payload, signatures };
}

/**
 * True when `value` decodes as a signature of `algorithm` (ECDSA_P256 or
 * ML_DSA_87 of src/crypto/signatures.js): hex or base64 of a length the
 * algorithm accepts. The worker's decodeSignature, as a yes or no.
 */
export function decodesAsSignature(algorithm, value) {
  return decodeSignature(algorithm, value) !== null;
}

/** True when `value` decodes as a public key of `algorithm`, likewise. */
export function decodesAsPublicKey(algorithm, value) {
  return decodePublicKey(algorithm, value) !== null;
}

/**
 * The bytes a payload is signed as: its canonical form as UTF-8. Null when
 * it has none (a lone surrogate in a string, for instance), which the door
 * answers as a bad request shape where the worker would throw.
 */
export function canonicalBytes(payload) {
  try {
    return Buffer.from(canonicalize(payload), 'utf8');
  } catch {
    return null;
  }
}
