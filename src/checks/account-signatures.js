import { ECDSA_P256, ML_DSA_87 } from '../crypto/signatures.js';
import { decodesAsSignature } from './signed-request.js';

/**
 * Signatures an account makes over a payload: the three signing pairs, the
 * break-glass pair and the two signing rules, copied from anossoftware's
 * src/accounts/account-signatures.js, and the door's half of its
 * verifyAccountSignatures. The keys to verify with live in the worker's
 * accounts table, never in the object itself, so the door walks the pairs
 * exactly as the worker does, with the same reasons, up to the point where
 * a key would be needed: every signature present is a string that decodes
 * for its algorithm, the rule's pairs are among them, and under the
 * break-glass rule no other pair is (2026-11-08, docs/schemas.md section
 * 5). The worker verifies them against the account's keys as it does today.
 */

/**
 * The three signing pairs that may sign for an account under any two pairs:
 * pair 1, pair 2 and the wallet pair, each a classical P-256 key with its
 * post-quantum ML-DSA-87 partner. `publicKey` names the field of the
 * worker's account row that holds the key to verify with; the door has no
 * account row and does not use it. An object signed by a pair carries both
 * keys' signatures: a pair with only one present is a malformed object. The
 * break-glass pair is not among them: it signs under its own rule
 * (BREAK_GLASS_KEYS, 2026-11-08, section 5).
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

/** The break-glass pair: signs a breakGlassTransfer and a breakGlassCancel, nothing else. Not among SIGNING_PAIRS: it never counts toward any two pairs. The worker's constant as it is; the door reads the names and algorithms only. */
export const BREAK_GLASS_KEYS = Object.freeze([
  { name: 'breakGlassKey', algorithm: ECDSA_P256, publicKey: 'breakGlassPk' },
  { name: 'breakGlassPostQuantumKey', algorithm: ML_DSA_87, publicKey: 'breakGlassPkPq' },
].map(Object.freeze));

/**
 * Signing rule: at least two of the three pairs, both keys of each. Every
 * transfer kind but the break-glass transfer, transfers to the fund, fund
 * proposals and every follow-up but the break-glass cancel use it: their
 * one rule since 2026-11-07, when the assisted transfer's own rule, pair
 * one and the wallet pair, was dropped.
 */
export const ANY_TWO_PAIRS = 'anyTwoPairs';

/**
 * Signing rule: the break-glass pair alone, both keys present and no
 * signature from the three user pairs beside them; the worker verifies the
 * two against break_glass_pk and break_glass_pk_pq. The rule of the
 * breakGlassTransfer and the breakGlassCancel (2026-11-08, section 5).
 */
export const BREAK_GLASS_PAIR = 'breakGlassPair';

/** How many of SIGNING_PAIRS the ANY_TWO_PAIRS rule needs. */
const MIN_SIGNING_PAIRS = 2;

/**
 * verifyAccountSignatures without an account. Checks `signatures`, the
 * signatures object of a transfer or a follow-up, under `rule`
 * (ANY_TWO_PAIRS or BREAK_GLASS_PAIR): for every signing pair with a
 * signature present, both halves are present, each a string, each decoding
 * for its algorithm (checkPair); then the rule says which pairs had to be
 * among them. Under ANY_TWO_PAIRS at least two of the three; a stray
 * break-glass signature is ignored, as any unknown field is. Under
 * BREAK_GLASS_PAIR none of the three may be present, and the break-glass
 * pair goes through the same per-key checks. Returns null when it all
 * holds, else the worker's reason, safe to send back.
 */
export function checkSignaturesDecode(signatures, rule) {
  const signed = [];
  for (const pair of SIGNING_PAIRS) {
    if (pair.every(({ name }) => signatures[name] === undefined)) continue;
    const bad = checkPair(signatures, pair);
    if (bad) return bad;
    signed.push(pair);
  }

  if (rule === ANY_TWO_PAIRS) {
    if (signed.length < MIN_SIGNING_PAIRS) {
      return `signatures must come from at least ${MIN_SIGNING_PAIRS} of the key pairs key1, key2 and walletKey`;
    }
    return null;
  }
  if (rule === BREAK_GLASS_PAIR) {
    if (signed.length > 0) return 'a breakGlassTransfer is signed by the break-glass pair alone';
    return checkPair(signatures, BREAK_GLASS_KEYS);
  }
  throw new TypeError(`Unknown signing rule: ${rule}`);
}

/**
 * One pair's checks, the worker's checkPair up to the point where a key
 * would be needed: both keys present, each a string, each decoding to a
 * signature of its algorithm. Returns a reason or null. The walk over
 * SIGNING_PAIRS and the break-glass branch share it, so every reason
 * string exists once.
 */
function checkPair(signatures, pair) {
  const present = pair.filter(({ name }) => signatures[name] !== undefined);
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
  return null;
}
