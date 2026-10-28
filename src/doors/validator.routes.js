import { createAccountCheck } from '../checks/create-account.js';
import {
  assistedTransferCancel,
  attestation,
  escrowCancel,
  escrowDispute,
  escrowSuccess,
  escrowVerdict,
  followUpCheck,
  guardianVote,
} from '../checks/follow-ups.js';
import { signedReadCheck } from '../checks/reads.js';
import { anosTransferCheck, fundProposalCheck, transferToFundCheck } from '../checks/transfers.js';
import {
  attachmentApprovalCheck,
  finalDeclarationCheck,
  officialListCheck,
  proofOfAcceptanceCheck,
  proofOfAttachmentAcceptanceCheck,
  readyAnnouncementCheck,
  transactionApprovalCheck,
} from '../checks/validator-messages.js';

/**
 * The route table of the validator door: port 3000, forwarded to
 * WORKER_IP:3000. Every path the validator answers bar GET / (not
 * forwarded) and GET /health (the door answers its own, with the worker's
 * embedded), each { method, path, maxBytes, check }: `maxBytes` is the body
 * cap the door reads the body with (KB is 1024 bytes; nginx caps the whole
 * port at the largest, 256k), `check` a function of the parsed body
 * answering null or { status, reason }. The caps are generous so nothing
 * legitimate hits them: a create-account measures 57.7 KB, a transfer or
 * follow-up with three pairs 28 KB, a signed read 9.5 KB, a proof with 24
 * receipts 8.5 KB, an official list of 1000 ids 65.7 KB.
 */
export const validatorRoutes = Object.freeze([
  // What a wallet submits.
  { method: 'POST', path: '/create-account', maxBytes: 96 * 1024, check: createAccountCheck },
  { method: 'POST', path: '/anos-transfer', maxBytes: 64 * 1024, check: anosTransferCheck },
  { method: 'POST', path: '/transfer-to-fund', maxBytes: 64 * 1024, check: transferToFundCheck },
  { method: 'POST', path: '/fund-proposal', maxBytes: 64 * 1024, check: fundProposalCheck },

  // The follow-ups, each route with the kinds its worker handler allows.
  { method: 'POST', path: '/attestation', maxBytes: 64 * 1024, check: followUpCheck([attestation]) },
  { method: 'POST', path: '/assisted-transfer-cancel', maxBytes: 64 * 1024, check: followUpCheck([assistedTransferCancel]) },
  { method: 'POST', path: '/guardian-vote', maxBytes: 64 * 1024, check: followUpCheck([guardianVote]) },
  {
    method: 'POST',
    path: '/escrow-signature',
    maxBytes: 64 * 1024,
    check: followUpCheck([escrowSuccess, escrowCancel, escrowDispute, escrowVerdict]),
  },

  // The signed reads: the account level and the attestor level.
  { method: 'POST', path: '/get-account', maxBytes: 16 * 1024, check: signedReadCheck },
  { method: 'POST', path: '/list-transactions', maxBytes: 16 * 1024, check: signedReadCheck },
  { method: 'POST', path: '/list-assisted-transfers', maxBytes: 16 * 1024, check: signedReadCheck },
  { method: 'POST', path: '/list-disputed-escrows', maxBytes: 16 * 1024, check: signedReadCheck },

  // Validator to validator, verified against the registry.
  { method: 'POST', path: '/transaction-approval', maxBytes: 96 * 1024, check: transactionApprovalCheck },
  { method: 'POST', path: '/proof-of-acceptance', maxBytes: 64 * 1024, check: proofOfAcceptanceCheck },
  { method: 'POST', path: '/attachment-approval', maxBytes: 64 * 1024, check: attachmentApprovalCheck },
  { method: 'POST', path: '/proof-of-attachment-acceptance', maxBytes: 64 * 1024, check: proofOfAttachmentAcceptanceCheck },
  { method: 'POST', path: '/ready-announcement', maxBytes: 4 * 1024, check: readyAnnouncementCheck },
  { method: 'POST', path: '/official-list', maxBytes: 256 * 1024, check: officialListCheck },
  { method: 'POST', path: '/final-declaration', maxBytes: 256 * 1024, check: finalDeclarationCheck },
].map(Object.freeze));
