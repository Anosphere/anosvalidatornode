import { ECDSA_P256, ML_DSA_87 } from '../crypto/signatures.js';
import { refuse } from '../util/result.js';
import { decodesAsSignature, parseSignedRequest } from './signed-request.js';

/**
 * The door's checks on the keyholder's signed routes: shape and size only,
 * since the door has none of the keys (a pod's session keys live on the
 * masterpod, a moderator's in the worker's anos database, the YubiKeys'
 * public halves in the keyholder's .env). envelopeCheck(signerField,
 * { mldsa }) builds the check of one level: the envelope
 * (parseSignedRequest, 400 bad request shape), then signatures.ecdsa
 * decodes as a P-256 signature and, when the level carries one,
 * signatures.mldsa as an ML-DSA-87 one, else 401 bad signature. The levels
 * (keyholdersoftware README, "Who may call what"): pod, signer anopodId,
 * both signatures; moderator or attestor, signer accountId, both; keyholder,
 * signer yubikey, ecdsa only, since a PIV slot signs in DER and the
 * post-quantum half is not required there.
 */
export function envelopeCheck(signerField, { mldsa }) {
  return (body) => {
    const parsed = parseSignedRequest(body, signerField, { mldsa });
    if (parsed.reason) return refuse(400, parsed.reason);
    const { signatures } = parsed;
    if (!decodesAsSignature(ECDSA_P256, signatures.ecdsa)) return refuse(401, 'bad signature');
    if (mldsa && !decodesAsSignature(ML_DSA_87, signatures.mldsa)) return refuse(401, 'bad signature');
    return null;
  };
}
