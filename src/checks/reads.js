import { ECDSA_P256, ML_DSA_87 } from '../crypto/signatures.js';
import { refuse } from '../util/result.js';
import { decodesAsSignature, parseSignedRequest } from './signed-request.js';

/**
 * The door's check on the four signed reads of the validator: /get-account
 * and /list-transactions (the account level) and /list-assisted-transfers
 * and /list-disputed-escrows (the attestor level). The envelope with
 * accountId as the signer field and both signatures (parseSignedRequest,
 * 400 bad request shape), then signatures.ecdsa decodes as a P-256
 * signature and signatures.mldsa as an ML-DSA-87 one, else 401 bad
 * signature, the worker's answer to a signature that does not decode. The
 * path, the timestamp, the account, its keys, its stake and the nonce are
 * the worker's (src/auth/require-account.js, require-attestor.js).
 */
export function signedReadCheck(body) {
  const parsed = parseSignedRequest(body, 'accountId', { mldsa: true });
  if (parsed.reason) return refuse(400, parsed.reason);
  const { signatures } = parsed;
  if (!decodesAsSignature(ECDSA_P256, signatures.ecdsa) || !decodesAsSignature(ML_DSA_87, signatures.mldsa)) {
    return refuse(401, 'bad signature');
  }
  return null;
}
