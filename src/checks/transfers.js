import { isObject } from '../util/is-object.js';
import { refuse } from '../util/result.js';
import { ANY_TWO_PAIRS, PAIR_ONE_AND_WALLET, checkSignaturesDecode } from './account-signatures.js';

/**
 * The door's checks on the three transaction routes a wallet submits to
 * besides /create-account: /anos-transfer, /transfer-to-fund and
 * /fund-proposal. Each is the worker's shape function, copied with its
 * reasons (transfer.service.js checkShape, fund.service.js
 * checkTransferToFundShape and checkProposalShape), then the signatures
 * object walked under the type's signing rule (account-signatures.js
 * checkSignaturesDecode). The ids, the sender's account and its type, the
 * balance and the verification against the account's keys are the worker's.
 */

/** The transactionType of a plain transfer, out of a spending account, as the web app sends it. */
const ANOS_TRANSFER = 'anosTransfer';

/** The transactionType of a transfer out of a guarded account. */
const GUARDED_ANOS_TRANSFER = 'guardedAnosTransfer';

/** The transactionType of a transfer out of a vault account. */
const VAULT_ANOS_TRANSFER = 'vaultAnosTransfer';

/** The transactionType of a transfer out of an assisted account, which two attestors must attest to. */
const ASSISTED_ANOS_TRANSFER = 'assistedAnosTransfer';

/** The transactionType of an escrow transfer, out of a spending account. */
const ESCROW_TRANSFER = 'escrowTransfer';

/** The transactionType of a stake: a transfer from a spending account to the fund, naming its purpose. */
const TRANSFER_TO_FUND = 'transferToFund';

/** The transactionType of a fund proposal. */
const FUND_PROPOSAL = 'fundProposal';

/**
 * The five transfer types, each with the signing rule its signatures must
 * meet (the worker's TRANSFER_TYPES, reduced to the rule): pair 1 and the
 * wallet pair for an assisted transfer, any two pairs for the rest.
 */
const TRANSFER_RULES = new Map([
  [ANOS_TRANSFER, ANY_TWO_PAIRS],
  [GUARDED_ANOS_TRANSFER, ANY_TWO_PAIRS],
  [VAULT_ANOS_TRANSFER, ANY_TWO_PAIRS],
  [ASSISTED_ANOS_TRANSFER, PAIR_ONE_AND_WALLET],
  [ESCROW_TRANSFER, ANY_TWO_PAIRS],
]);

/** True when `transactionType` is one of the five transfer types. */
function isTransferType(transactionType) {
  return TRANSFER_RULES.has(transactionType);
}

/** POST /anos-transfer: the transfer shape, then the signatures under the type's rule. */
export function anosTransferCheck(body) {
  const problem = checkTransferShape(body);
  if (problem) return refuse(400, problem);
  const bad = checkSignaturesDecode(body.signatures, TRANSFER_RULES.get(body.payload.transactionType));
  return bad ? refuse(400, bad) : null;
}

/** POST /transfer-to-fund: the transferToFund shape, then the signatures, any two pairs. */
export function transferToFundCheck(body) {
  const problem = checkTransferToFundShape(body);
  if (problem) return refuse(400, problem);
  const bad = checkSignaturesDecode(body.signatures, ANY_TWO_PAIRS);
  return bad ? refuse(400, bad) : null;
}

/** POST /fund-proposal: the fundProposal shape, then the signatures, any two pairs. */
export function fundProposalCheck(body) {
  const problem = checkProposalShape(body);
  if (problem) return refuse(400, problem);
  const bad = checkSignaturesDecode(body.signatures, ANY_TWO_PAIRS);
  return bad ? refuse(400, bad) : null;
}

/** Returns a description of the first structural problem with a transfer, or null if the shape is right. */
function checkTransferShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  const { payload } = body;
  if (typeof payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.previousTransactionId !== 'string') return 'payload.previousTransactionId must be a string';
  if (!isTransferType(payload.transactionType)) {
    return `payload.transactionType must be "${ANOS_TRANSFER}", "${GUARDED_ANOS_TRANSFER}", "${VAULT_ANOS_TRANSFER}", "${ASSISTED_ANOS_TRANSFER}" or "${ESCROW_TRANSFER}"`;
  }
  if (typeof payload.amount !== 'string') return 'payload.amount must be a string';
  if (typeof payload.accountIdTo !== 'string') return 'payload.accountIdTo must be a string';
  if (typeof payload.createdAt !== 'string') return 'payload.createdAt must be a string';
  if (!isObject(body.signatures)) return 'signatures must be an object';
  return null;
}

/** Returns a description of the first structural problem with a transferToFund, or null. */
function checkTransferToFundShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  const { payload } = body;
  if (typeof payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.previousTransactionId !== 'string') return 'payload.previousTransactionId must be a string';
  if (payload.transactionType !== TRANSFER_TO_FUND) return `payload.transactionType must be "${TRANSFER_TO_FUND}"`;
  if (typeof payload.amount !== 'string') return 'payload.amount must be a string';
  if (typeof payload.accountIdTo !== 'string') return 'payload.accountIdTo must be a string';
  if (typeof payload.createdAt !== 'string') return 'payload.createdAt must be a string';
  if (typeof payload.stakeFor !== 'string') return 'payload.stakeFor must be a string';
  if (!isObject(body.signatures)) return 'signatures must be an object';
  return null;
}

/** Returns a description of the first structural problem with a fundProposal, or null. */
function checkProposalShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  const { payload } = body;
  if (typeof payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof payload.guardianId !== 'string') return 'payload.guardianId must be a string';
  if (payload.transactionType !== FUND_PROPOSAL) return `payload.transactionType must be "${FUND_PROPOSAL}"`;
  if (typeof payload.createdAt !== 'string') return 'payload.createdAt must be a string';
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (!Array.isArray(payload.payouts) || payload.payouts.length === 0) {
    return 'payload.payouts must be an array with at least one payout';
  }
  for (const [i, payout] of payload.payouts.entries()) {
    if (!isObject(payout)) return `payload.payouts[${i}] must be an object`;
    if (typeof payout.accountIdTo !== 'string') return `payload.payouts[${i}].accountIdTo must be a string`;
    if (typeof payout.amount !== 'string') return `payload.payouts[${i}].amount must be a string`;
    if (typeof payout.reason !== 'string') return `payload.payouts[${i}].reason must be a string`;
    if (payout.stakeFor !== undefined && typeof payout.stakeFor !== 'string') {
      return `payload.payouts[${i}].stakeFor must be a string when present`;
    }
  }
  if (!isObject(body.signatures)) return 'signatures must be an object';
  return null;
}
