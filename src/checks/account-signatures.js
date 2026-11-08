import { ECDSA_P256, ML_DSA_87 } from '../crypto/signatures.js';
import { decodesAsSignature } from './signed-request.js';

/**
 * Signatures an account makes over a payload: the three key pairs and the
 * signing rule, copied from anossoftware's
 * src/accounts/account-signatures.js, and the door's half of its
 * verifyAccountSignatures. The keys to verify with live in the worker's
 * accounts table, never in the object itself, so the door walks the pairs
 * exactly as the worker does, with the same reasons, up to the point where
 * a key would be needed: every signature present is a string that decodes
 * for its algorithm, and the rule's pairs are among them. The worker
 * verifies them against the account's keys as it does today.
 */

/**
 * The key pairs that may sign for an account: pair 1, pair 2 and the wallet
 * pair, each a classical P-256 key with its post-quantum ML-DSA-87 partner.
 * `publicKey` names the field of the worker's account row that holds the
 * key to verify with; the door has no account row and does not use it. An
 * object signed by a pair carries both keys' signatures: a pair with only
 * one present is a malformed object.
 */
export const SIGNING_PAIRS = Object.freeze([
  Object.freeze([
    { name: 'key1', algorithm: ECDSA_P256, publicKey: 'publicKey1' },
    { name: 'postQuantumKey1', algorithm: ML_DSA_87, publicKey: 'publicKeyPq1' },
  ]),
  Object.freeze([
    { name: 'key2', algorithm: ECDSA_P256, publicKey: 'publicKey2' },
    { name: 'postQuantumKey2', algorithm: ML_DSA_87, publicKey: 'publicKeyPq2' },
  ]),
  Object.freeze([
    { name: 'walletKey', algorithm: ECDSA_P256, publicKey: 'altWalletPk' },
    { name: 'walletPostQuantumKey', algorithm: ML_DSA_87, publicKey: 'altWalletPkPq' },
  ]),
]);

/**
 * Signing rule: at least two of the three pairs, both keys of each. Every
 * transfer kind, transfers to the fund, fund proposals and every follow-up
 * use it: the one rule since 2026-11-07, when the assisted transfer's own
 * rule, pair one and the wallet pair, was dropped.
 */
export const ANY_TWO_PAIRS = 'anyTwoPairs';

/** How many of SIGNING_PAIRS the ANY_TWO_PAIRS rule needs. */
const MIN_SIGNING_PAIRS = 2;

/**
 * verifyAccountSignatures without an account. Checks `signatures`, the
 * signatures object of a transfer or a follow-up, under `rule`
 * (ANY_TWO_PAIRS): for every pair with a signature present, both halves
 * are present, each a string, each decoding for its algorithm; then the
 * rule says which pairs had to be among them. Returns null when it all
 * holds, else the worker's reason, safe to send back.
 */
export function checkSignaturesDecode(signatures, rule) {
  const signed = [];
  for (const pair of SIGNING_PAIRS) {
    const present = pair.filter(({ name }) => signatures[name] !== undefined);
    if (present.length === 0) continue;
    if (present.length !== pair.length) {
      return `signatures.${pair[0].name} and signatures.${pair[1].name} must both be present`;
    }
    for (const { name, algorithm } of pair) {
      if (typeof signatures[name] !== 'string') {
        return `signatures.${name} must be a string`;
      }
      if (!decodesAsSignature(algorithm, signatures[name])) {
        return `signatures.${name} is not a valid ${algorithm} signature`;
      }
    }
    signed.push(pair);
  }

  if (rule === ANY_TWO_PAIRS) {
    if (signed.length < MIN_SIGNING_PAIRS) {
      return `signatures must come from at least ${MIN_SIGNING_PAIRS} of the key pairs key1, key2 and walletKey`;
    }
    return null;
  }
  throw new TypeError(`Unknown signing rule: ${rule}`);
}
