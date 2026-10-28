import { isObject } from '../util/is-object.js';
import { refuse } from '../util/result.js';
import { ANY_TWO_PAIRS, checkSignaturesDecode } from './account-signatures.js';

/**
 * The door's checks on the four follow-up routes, /attestation,
 * /assisted-transfer-cancel, /guardian-vote and /escrow-signature. A
 * follow-up is { payload, signatures }: payload.type names its kind,
 * payload.transactionId the held transaction it attaches to, the kind's
 * signer field the signer's account id, payload.signedAt when it was
 * signed; the signatures are the signer's account keys, any two pairs.
 *
 * followUpCheck(kinds) builds the check of one route from the kinds its
 * worker handler allows. Each kind is { type, signerField } as the worker's
 * kind modules export them (src/assisted-transfers/, src/fund/guardian-vote.js,
 * src/escrow/); what else a kind has there (its table, its stake, its own
 * fields and checks, its effect) stays on the worker. The shape is the
 * common part of attachments.service.js checkAttachmentShape, with the same
 * reasons; then account-signatures.js checkSignaturesDecode. The held row,
 * the signer's account and stake and the verification against its keys are
 * the worker's.
 */

/** An attestor vouching for an assisted transfer. */
export const attestation = Object.freeze({ type: 'attestation', signerField: 'attestorId' });

/** The sender taking an assisted transfer back. */
export const assistedTransferCancel = Object.freeze({ type: 'assistedTransferCancel', signerField: 'accountId' });

/** A guardian's vote on an open fund proposal. */
export const guardianVote = Object.freeze({ type: 'guardianVote', signerField: 'guardianId' });

/** The seller confirming the buyer paid, which releases the escrow. */
export const escrowSuccess = Object.freeze({ type: 'escrowSuccess', signerField: 'accountId' });

/** The buyer calling the deal off. */
export const escrowCancel = Object.freeze({ type: 'escrowCancel', signerField: 'accountId' });

/** Either party handing the escrow to the arbitrators. */
export const escrowDispute = Object.freeze({ type: 'escrowDispute', signerField: 'accountId' });

/** An arbitrator deciding a disputed escrow. */
export const escrowVerdict = Object.freeze({ type: 'escrowVerdict', signerField: 'arbitratorId' });

/**
 * The check of a follow-up route whose handler allows `kinds`: the shape,
 * then the signatures. Returns a function of the parsed body that answers
 * null or { status, reason }.
 */
export function followUpCheck(kinds) {
  return (body) => {
    const shape = checkAttachmentShape(body, kinds);
    if (shape.reason) return refuse(400, shape.reason);
    const bad = checkSignaturesDecode(body.signatures, ANY_TWO_PAIRS);
    return bad ? refuse(400, bad) : null;
  };
}

/**
 * The common shape of a follow-up. Returns { kind } for the kind
 * payload.type names among `kinds`, or { reason } for the first problem.
 */
function checkAttachmentShape(body, kinds) {
  if (!isObject(body)) return { reason: 'body must be a JSON object' };
  if (!isObject(body.payload)) return { reason: 'payload must be an object' };
  const { payload } = body;
  const kind = kinds.find((candidate) => candidate.type === payload.type);
  if (!kind) {
    return { reason: `payload.type must be ${kinds.map(({ type }) => `"${type}"`).join(' or ')}` };
  }
  if (typeof payload.transactionId !== 'string') return { reason: 'payload.transactionId must be a string' };
  if (typeof payload[kind.signerField] !== 'string') return { reason: `payload.${kind.signerField} must be a string` };
  if (typeof payload.signedAt !== 'string') return { reason: 'payload.signedAt must be a string' };
  if (!isObject(body.signatures)) return { reason: 'signatures must be an object' };
  return { kind };
}
