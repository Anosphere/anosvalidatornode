import { decodeDigest } from '../crypto/hash.js';
import { ECDSA_P256, decodeSignature, verifySignature } from '../crypto/signatures.js';
import { registry } from '../registry/registry.js';
import { isObject } from '../util/is-object.js';
import { refuse } from '../util/result.js';
import { BAD_SHAPE, canonicalBytes } from './signed-request.js';

/**
 * The door's checks on the validator-to-validator routes: the seven of
 * doorman build 1 and, since the catch-up build (docs/schemas.md section
 * 3), the chain chunk read, the two vote messages, the no-answer report
 * and the three join messages. Every message is { payload, signature }: the
 * payload signed as its RFC 8785 canonical bytes by the sending validator's
 * P-256 key, signature.key that signature as hex. The door holds every
 * validator's key, in the registry copy, so it verifies the sender in
 * full. One check per message type, each running the worker's shape
 * function for that type, copied with its reasons (validators.service.js
 * for the transaction approval, the proof of acceptance and the three
 * leader calls; attachments.service.js for the attachment approval and
 * the proof of attachment acceptance; garlic-chain/chain-links.service.js
 * for the chunk read; votes/votes.messages.js for the votes and the
 * report; validators/join.service.js for the join), then what every
 * message gets (fromValidator). The embedded transaction or attachment
 * gets nothing beyond what the shape function requires of it; whether the
 * leader is the leader, whether the sender is counted or the next in the
 * ring, the held rows and the receipts' signatures are the worker's.
 */

/** payload.type of a transaction approval receipt: the call. */
const TRANSACTION_APPROVAL = 'transactionApproval';

/** payload.type of a transaction approved receipt: the answer to that call, inside a proof. */
const TRANSACTION_APPROVED = 'transactionApproved';

/** payload.type of a proof of transaction acceptance. */
const PROOF_OF_ACCEPTANCE = 'proofOfTransactionAcceptance';

/** payload.type of an attachment approval: the call that carries a follow-up. */
const ATTACHMENT_APPROVAL = 'attachmentApproval';

/** payload.type of an attachment approved receipt: the answer to that call, inside a proof. */
const ATTACHMENT_APPROVED = 'attachmentApproved';

/** payload.type of a proof of attachment acceptance. */
const PROOF_OF_ATTACHMENT_ACCEPTANCE = 'proofOfAttachmentAcceptance';

/** payload.type of the leader's ready announcement. */
const READY_ANNOUNCEMENT = 'readyAnnouncement';

/** payload.type of the leader's official list. */
const OFFICIAL_LIST = 'officialList';

/** payload.type of the leader's final declaration. */
const FINAL_DECLARATION = 'finalDeclaration';

/** payload.type of the chain chunk read: the call. */
const CHAIN_LINKS = 'chainLinks';

/** payload.type of a vote request. */
const IGNORE_VOTE = 'ignoreVote';

/** payload.type of a vote: the answer to a request, inside a proof. */
const IGNORE_VOTED = 'ignoreVoted';

/** payload.type of the proof of a passed vote. */
const PROOF_OF_IGNORE_VOTE = 'proofOfIgnoreVote';

/** payload.type of a report that a validator gave no answer. */
const NO_ANSWER_REPORT = 'noAnswerReport';

/** payload.type of the three join messages a joiner sends the leader. */
const JOIN_REQUEST = 'joinRequest';
const HELD_ROWS = 'heldRows';
const READY = 'ready';

/** The two directions of a vote. */
const ACTIONS = Object.freeze(['ignore', 'include']);

/** The two ways a voter answers. */
const VOTES = Object.freeze(['yes', 'no']);

/** The five holding tables a held rows request may name. */
const HELD_ROW_TABLES = Object.freeze(['pending', 'locked_transactions', 'assisted_transfers', 'escrow_transfers', 'fund_proposals']);

/** POST /transaction-approval. */
export function transactionApprovalCheck(body) {
  return fromValidator(body, { shape: checkTransactionApprovalShape, senderField: 'originatingValidator' });
}

/** POST /proof-of-acceptance: every receipt is a transaction approved receipt whose signature decodes. */
export function proofOfAcceptanceCheck(body) {
  return fromValidator(body, {
    shape: checkProofOfAcceptanceShape,
    senderField: 'originatingValidator',
    receiptShape: checkApprovedShape,
  });
}

/** POST /attachment-approval. */
export function attachmentApprovalCheck(body) {
  return fromValidator(body, { shape: checkAttachmentApprovalShape, senderField: 'originatingValidator' });
}

/** POST /proof-of-attachment-acceptance: every receipt is an attachment approved receipt whose signature decodes. */
export function proofOfAttachmentAcceptanceCheck(body) {
  return fromValidator(body, {
    shape: checkProofOfAttachmentAcceptanceShape,
    senderField: 'originatingValidator',
    receiptShape: checkAttachmentApprovedShape,
  });
}

/** POST /ready-announcement. */
export function readyAnnouncementCheck(body) {
  return fromValidator(body, { shape: (call) => checkLeaderCallShape(call, READY_ANNOUNCEMENT), senderField: 'leader' });
}

/** POST /official-list. */
export function officialListCheck(body) {
  return fromValidator(body, { shape: (call) => checkLeaderCallShape(call, OFFICIAL_LIST), senderField: 'leader' });
}

/** POST /final-declaration. */
export function finalDeclarationCheck(body) {
  return fromValidator(body, { shape: (call) => checkLeaderCallShape(call, FINAL_DECLARATION), senderField: 'leader' });
}

/** POST /chain-links: the asker is an active row, ignored or not; the cap on `limit` is the worker's. */
export function chainLinksCheck(body) {
  return fromValidator(body, { shape: checkChainLinksShape, senderField: 'validator' });
}

/** POST /ignore-vote: the starter is an active row; whether it may start the vote is the worker's. */
export function ignoreVoteCheck(body) {
  return fromValidator(body, { shape: checkIgnoreVoteShape, senderField: 'startedBy' });
}

/** POST /proof-of-ignore-vote: every receipt is a vote whose signature decodes. */
export function proofOfIgnoreVoteCheck(body) {
  return fromValidator(body, {
    shape: checkProofOfIgnoreVoteShape,
    senderField: 'startedBy',
    receiptShape: checkIgnoreVotedShape,
  });
}

/** POST /no-answer-report. */
export function noAnswerReportCheck(body) {
  return fromValidator(body, { shape: checkNoAnswerReportShape, senderField: 'reporter' });
}

/** POST /join-request: the joiner is an active row, ignored or not. */
export function joinRequestCheck(body) {
  return fromValidator(body, { shape: checkJoinRequestShape, senderField: 'validator' });
}

/** POST /held-rows: likewise; the cap on `limit` and the join in progress are the worker's. */
export function heldRowsCheck(body) {
  return fromValidator(body, { shape: checkHeldRowsShape, senderField: 'validator' });
}

/** POST /ready: likewise. */
export function readyCheck(body) {
  return fromValidator(body, { shape: checkReadyShape, senderField: 'validator' });
}

/**
 * What every validator message gets, in order: `shape`, the worker's shape
 * function for its type; the sender, payload.<senderField>, is an active
 * row of the registry; signature.key decodes as a P-256 signature and
 * verifies against that row's key over the canonical bytes of payload (the
 * logic of validators.signing.js verifyPayloadSignature, with its reasons);
 * and, when `receiptShape` is given (the two proofs), every element of
 * payload.receipts passes it and its own signature.key decodes, the reason
 * prefixed `receipts[<i>]: ` as the worker does. Receipts are not verified
 * at the door. Returns null or { status, reason }.
 */
function fromValidator(body, { shape, senderField, receiptShape }) {
  const problem = shape(body);
  if (problem) return refuse(400, problem);

  const { payload, signature } = body;
  const sender = registry.validators.get(payload[senderField]);
  if (!sender || !sender.active) {
    return refuse(400, `${senderField} ${payload[senderField]} is not an active validator`);
  }
  const badSignature = verifyPayloadSignature(payload, signature, sender);
  if (badSignature) return refuse(400, badSignature);

  if (receiptShape) {
    for (const [i, receipt] of payload.receipts.entries()) {
      const bad = receiptShape(receipt) ?? decodes(receipt.signature);
      if (bad) return refuse(400, `receipts[${i}]: ${bad}`);
    }
  }
  return null;
}

/** Null when signature.key decodes as a P-256 signature, else the worker's reason. */
function decodes(signature) {
  return decodeSignature(ECDSA_P256, signature.key) ? null : `signature.key is not a valid ${ECDSA_P256} signature`;
}

/**
 * Checks the signature on `payload` against `validator`'s public key, the
 * registry row. Returns null when it verifies, otherwise a reason that is
 * safe to send back.
 */
function verifyPayloadSignature(payload, signature, validator) {
  const bad = decodes(signature);
  if (bad) return bad;
  const message = canonicalBytes(payload);
  if (message === null) return BAD_SHAPE;
  if (!verifySignature(ECDSA_P256, validator.publicKey, message, decodeSignature(ECDSA_P256, signature.key))) {
    return `signature.key does not verify against validator ${validator.id}'s ${ECDSA_P256} public key`;
  }
  return null;
}

/** Returns a description of the first structural problem with an approval receipt, or null. */
function checkTransactionApprovalShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== TRANSACTION_APPROVAL) return `payload.type must be "${TRANSACTION_APPROVAL}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!isObject(payload.transaction)) return 'payload.transaction must be an object';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a proof of acceptance, or null. */
function checkProofOfAcceptanceShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== PROOF_OF_ACCEPTANCE) return `payload.type must be "${PROOF_OF_ACCEPTANCE}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!Array.isArray(payload.receipts)) return 'payload.receipts must be an array';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with an approved receipt, or null. */
function checkApprovedShape(receipt) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== TRANSACTION_APPROVED) return `payload.type must be "${TRANSACTION_APPROVED}"`;
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a leader call of `type`, or null. */
function checkLeaderCallShape(body, type) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== type) return `payload.type must be "${type}"`;
  if (!Number.isInteger(payload.leader) || payload.leader < 1) {
    return 'payload.leader must be a positive integer';
  }
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (type !== READY_ANNOUNCEMENT) {
    if (!Array.isArray(payload.transactionIds) || !payload.transactionIds.every((id) => decodeDigest(id))) {
      return 'payload.transactionIds must be an array of SHA-256 digests';
    }
  }
  if (type === FINAL_DECLARATION && (!Number.isInteger(payload.nextLeader) || payload.nextLeader < 1)) {
    return 'payload.nextLeader must be a positive integer';
  }
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with an attachment approval, or null. */
function checkAttachmentApprovalShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== ATTACHMENT_APPROVAL) return `payload.type must be "${ATTACHMENT_APPROVAL}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.attachmentId !== 'string') return 'payload.attachmentId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!isObject(payload.attachment)) return 'payload.attachment must be an object';
  if (!isObject(payload.attachment.payload)) return 'payload.attachment.payload must be an object';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a proof of attachment acceptance, or null. */
function checkProofOfAttachmentAcceptanceShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== PROOF_OF_ATTACHMENT_ACCEPTANCE) return `payload.type must be "${PROOF_OF_ATTACHMENT_ACCEPTANCE}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.attachmentId !== 'string') return 'payload.attachmentId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!Array.isArray(payload.receipts)) return 'payload.receipts must be an array';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with an attachment approved receipt, or null. */
function checkAttachmentApprovedShape(receipt) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== ATTACHMENT_APPROVED) return `payload.type must be "${ATTACHMENT_APPROVED}"`;
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.attachmentId !== 'string') return 'payload.attachmentId must be a string';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a chunk read, or null. */
function checkChainLinksShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== CHAIN_LINKS) return `payload.type must be "${CHAIN_LINKS}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) {
    return 'payload.validator must be a positive integer';
  }
  if (!Number.isInteger(payload.afterPosition) || payload.afterPosition < 0) {
    return 'payload.afterPosition must be an integer of 0 or more';
  }
  if (!Number.isInteger(payload.limit) || payload.limit < 1) return 'payload.limit must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** The rule every list of validator ids meets: a non-empty array of positive integers, distinct, ascending. Null or a reason. */
function checkIdList(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 'must be a non-empty array';
  for (const [i, id] of ids.entries()) {
    if (!Number.isInteger(id) || id < 1) return 'must hold positive integers';
    if (i > 0 && id <= ids[i - 1]) return 'must be distinct and ascending';
  }
  return null;
}

/** Returns a description of the first structural problem with a vote request, or null. */
function checkIgnoreVoteShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== IGNORE_VOTE) return `payload.type must be "${IGNORE_VOTE}"`;
  if (!ACTIONS.includes(payload.action)) return `payload.action must be "${ACTIONS[0]}" or "${ACTIONS[1]}"`;
  const ids = checkIdList(payload.validatorIds);
  if (ids) return `payload.validatorIds ${ids}`;
  if (typeof payload.voteId !== 'string') return 'payload.voteId must be a string';
  if (!Number.isInteger(payload.startedBy) || payload.startedBy < 1) return 'payload.startedBy must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a vote receipt, or null. */
function checkIgnoreVotedShape(receipt) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== IGNORE_VOTED) return `payload.type must be "${IGNORE_VOTED}"`;
  if (typeof payload.voteId !== 'string') return 'payload.voteId must be a string';
  if (!VOTES.includes(payload.vote)) return `payload.vote must be "${VOTES[0]}" or "${VOTES[1]}"`;
  if (!isObject(payload.results)) return 'payload.results must be an object';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a proof of a vote, or null. */
function checkProofOfIgnoreVoteShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== PROOF_OF_IGNORE_VOTE) return `payload.type must be "${PROOF_OF_IGNORE_VOTE}"`;
  if (typeof payload.voteId !== 'string') return 'payload.voteId must be a string';
  if (!isObject(payload.request) || !isObject(payload.request.payload) || !isObject(payload.request.signature)) {
    return 'payload.request must be an object with an object payload and an object signature';
  }
  if (!Array.isArray(payload.receipts)) return 'payload.receipts must be an array';
  if (!Number.isInteger(payload.startedBy) || payload.startedBy < 1) return 'payload.startedBy must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a no-answer report, or null. */
function checkNoAnswerReportShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== NO_ANSWER_REPORT) return `payload.type must be "${NO_ANSWER_REPORT}"`;
  const ids = checkIdList(payload.validatorIds);
  if (ids) return `payload.validatorIds ${ids}`;
  if (!Number.isInteger(payload.reporter) || payload.reporter < 1) return 'payload.reporter must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** The envelope and signature.key of the three join messages (the worker's checkEnvelope). */
function checkJoinEnvelope(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';
  if (typeof body.signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** The tail a join request and a ready carry (the worker's checkTailFields). */
function checkTailFields(payload) {
  if (!Number.isInteger(payload.tailPosition) || payload.tailPosition < 0) return 'payload.tailPosition must be an integer of 0 or more';
  if (typeof payload.tailRecordHash !== 'string') return 'payload.tailRecordHash must be a string';
  return null;
}

/** Returns a description of the first structural problem with a join request, or null. */
function checkJoinRequestShape(body) {
  const problem = checkJoinEnvelope(body);
  if (problem) return problem;
  const { payload } = body;
  if (payload.type !== JOIN_REQUEST) return `payload.type must be "${JOIN_REQUEST}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) return 'payload.validator must be a positive integer';
  const tail = checkTailFields(payload);
  if (tail) return tail;
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}

/** Returns a description of the first structural problem with a held rows request, or null. */
function checkHeldRowsShape(body) {
  const problem = checkJoinEnvelope(body);
  if (problem) return problem;
  const { payload } = body;
  if (payload.type !== HELD_ROWS) return `payload.type must be "${HELD_ROWS}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) return 'payload.validator must be a positive integer';
  if (!HELD_ROW_TABLES.includes(payload.table)) return `payload.table must be one of ${HELD_ROW_TABLES.join(', ')}`;
  if (payload.afterTransactionId !== null && typeof payload.afterTransactionId !== 'string') {
    return 'payload.afterTransactionId must be a string or null';
  }
  if (!Number.isInteger(payload.limit) || payload.limit < 1) return 'payload.limit must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}

/** Returns a description of the first structural problem with a ready, or null. */
function checkReadyShape(body) {
  const problem = checkJoinEnvelope(body);
  if (problem) return problem;
  const { payload } = body;
  if (payload.type !== READY) return `payload.type must be "${READY}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) return 'payload.validator must be a positive integer';
  const tail = checkTailFields(payload);
  if (tail) return tail;
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}
