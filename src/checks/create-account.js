import { decodePublicKey, decodeSignature, verifySignature } from '../crypto/signatures.js';
import { isObject } from '../util/is-object.js';
import { refuse } from '../util/result.js';
import { ACCOUNT_KEYS } from './account-keys.js';
import { BAD_SHAPE, canonicalBytes } from './signed-request.js';

/**
 * The door's check on POST /create-account, { payload, signatures }: the
 * worker's accounts.service.js verifyCreateAccount up to its database. The
 * shape, copied with its reasons, then, over the eight keys of
 * account-keys.js in order, the public key decodes for its algorithm, the
 * signature decodes, and the signature verifies against that key over the
 * canonical bytes of payload. A create-account carries its own keys, so the
 * door verifies it in full; the id hashes (accountId, transactionId), the
 * uniqueness lookups and the binding check are the worker's. Every reason
 * is the worker's.
 */

/**
 * The account types a submission may ask for, as anossoftware's
 * src/accounts/account-types.js lists them.
 */
const ACCOUNT_TYPES = Object.freeze(['spending', 'guarded', 'vault', 'assisted']);

/** Returns null when the submission passes, else { status, reason }. */
export function createAccountCheck(body) {
  const problem = checkShape(body);
  if (problem) return refuse(400, problem);

  const { payload, signatures } = body;
  const { publicKeys } = payload;
  const message = canonicalBytes(payload);
  if (message === null) return refuse(400, BAD_SHAPE);

  for (const { name, algorithm } of ACCOUNT_KEYS) {
    const publicKey = decodePublicKey(algorithm, publicKeys[name]);
    if (!publicKey) {
      return refuse(400, `payload.publicKeys.${name} is not a valid ${algorithm} public key`);
    }
    const signature = decodeSignature(algorithm, signatures[name]);
    if (!signature) {
      return refuse(400, `signatures.${name} is not a valid ${algorithm} signature`);
    }
    if (!verifySignature(algorithm, publicKey, message, signature)) {
      return refuse(400, `signatures.${name} does not verify against payload.publicKeys.${name}`);
    }
  }
  return null;
}

/** Returns a description of the first structural problem, or null if the shape is right. */
function checkShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (typeof body.payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof body.payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (!ACCOUNT_TYPES.includes(body.payload.accountType)) {
    return `payload.accountType must be one of ${ACCOUNT_TYPES.join(', ')}`;
  }
  if (!isObject(body.payload.publicKeys)) return 'payload.publicKeys must be an object';
  if (!isObject(body.signatures)) return 'signatures must be an object';

  for (const { name } of ACCOUNT_KEYS) {
    if (typeof body.payload.publicKeys[name] !== 'string') {
      return `payload.publicKeys.${name} must be a string`;
    }
    if (typeof body.signatures[name] !== 'string') {
      return `signatures.${name} must be a string`;
    }
  }
  return null;
}
