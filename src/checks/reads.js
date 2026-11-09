import { ECDSA_P256, ML_DSA_87 } from '../crypto/signatures.js';
import { isObject } from '../util/is-object.js';
import { refuse } from '../util/result.js';
import { decodesAsSignature, parseSignedRequest } from './signed-request.js';

/**
 * The door's checks on the validator's reads: the seven signed reads,
 * /get-account, /list-transactions, /list-escrows, /get-assisted-transfer
 * and /get-locked-transfer (the account level) and /list-assisted-transfers
 * and /list-disputed-escrows (the attestor level), under signedReadCheck,
 * and the three public reads, /list-dao-stakes (2026-11-08, docs/schemas.md
 * section 6) and /list-fund-proposals and /get-fund-proposal (2026-11-08,
 * section 7), under publicReadCheck below. A signed read: the envelope with
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

/**
 * The public reads: the body is an object, else 400 bad request shape, the
 * worker's own first check (src/reads/reads.service.js listDaoStakes,
 * listFundProposals, getFundProposal). No envelope and no signature;
 * nothing in the body is read at the door. The worker reads nothing in a
 * /list-dao-stakes body either; the fields of the fund proposal reads
 * (status, limit, offset, from, to, transactionId) are its own, refused
 * with its own words (400 invalid status and the rest, 404 unknown
 * proposal).
 */
export function publicReadCheck(body) {
  if (!isObject(body)) return refuse(400, 'bad request shape');
  return null;
}
