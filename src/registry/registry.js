import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../crypto/canonical.js';
import { sha256 } from '../crypto/hash.js';
import { isObject } from '../util/is-object.js';

/**
 * The registry: network/testnet.registry.json, the doorman's copy of the
 * committed list of every validator of the network, the same file as
 * anossoftware's, kept equal by committing every registry change to both
 * repos. Read and checked once here, at import, so a file that does not
 * pass stops the boot before a port opens: server.js imports this module
 * right after env. The file is read from that path and nowhere else, as on
 * the validator.
 *
 * What the doorman takes from it: the key of every active validator, for
 * the signature check on validator-to-validator messages
 * (src/checks/validator-messages.js); the host of every active row's url,
 * the other doormen, which skip the rate limit (src/limit/rate-limit.js);
 * and the hash the validator computes over the same rows, answered by
 * /health so a sweep sees when the two copies drift.
 *
 * The shape checks are the validator's (registry.service.js), copied with
 * the same messages: a top-level object; firstLeader null or the id of a
 * row in the file; validators a non-empty array; each row's id a positive
 * integer, unique; publicKey 66 lowercase hex characters, "<fill in>"
 * refused by name; url starting http:// or https:// with no trailing slash;
 * active a boolean. No own-row check: the doorman has no id. One check of
 * its own: the host of every active row's url must be an IPv4 literal,
 * since this build allowlists IPs only.
 *
 * A failure prints `Registry failed: <message>` and exits 1, as the
 * validator's boot does; systemd retries every five seconds until the file
 * is fixed.
 */

/** The file, as the messages name it. */
const REGISTRY_FILE = 'network/testnet.registry.json';

/** Where it is: the repo root, whatever the working directory. */
const REGISTRY_PATH = fileURLToPath(new URL(`../../${REGISTRY_FILE}`, import.meta.url));

/** The placeholder a row ships with before its validator's key exists. */
const FILL_IN = '<fill in>';

function fail(message) {
  throw new Error(`${REGISTRY_FILE}: ${message}`);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** One row of the file, checked; `ids` collects the ids seen so far. */
function checkRow(row, index, ids) {
  const where = `row ${index + 1}`;
  if (!isObject(row)) fail(`${where} must be an object`);
  if (!isPositiveInteger(row.id)) fail(`${where}: id must be a positive integer`);
  if (ids.has(row.id)) fail(`${where}: id ${row.id} appears twice`);
  ids.add(row.id);

  const at = `${where} (id ${row.id})`;
  if (row.publicKey === FILL_IN) {
    fail(`${at}: publicKey is still "${FILL_IN}": fill it in ${REGISTRY_FILE}`);
  }
  if (typeof row.publicKey !== 'string' || !/^[0-9a-f]{66}$/.test(row.publicKey)) {
    fail(`${at}: publicKey must be 66 lowercase hex characters`);
  }
  if (typeof row.url !== 'string' || !/^https?:\/\//.test(row.url) || row.url.endsWith('/')) {
    fail(`${at}: url must start with http:// or https:// and have no trailing slash`);
  }
  if (typeof row.active !== 'boolean') fail(`${at}: active must be true or false`);
  return { id: row.id, publicKey: row.publicKey, url: row.url, active: row.active };
}

/** Reads and checks the file. Returns its rows, in file order. */
function readRegistry() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    fail(`could not be read: ${err.message}`);
  }
  if (!isObject(parsed)) fail('must be a JSON object');

  const { firstLeader, validators } = parsed;
  if (!Array.isArray(validators) || validators.length === 0) fail('validators must be a non-empty array');
  const ids = new Set();
  const rows = validators.map((row, index) => checkRow(row, index, ids));
  if (firstLeader !== null && !(isPositiveInteger(firstLeader) && ids.has(firstLeader))) {
    fail('firstLeader must be null or the id of a row in the file');
  }
  return rows;
}

/** The host of `url`, or null when it does not parse as a URL. */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** This build's own check: the host of every active row's url is an IPv4 literal. */
function checkHosts(rows) {
  for (const row of rows) {
    if (row.active && !isIPv4(hostOf(row.url))) {
      fail(`registry row ${row.id}: url host must be an IPv4 address; this build allowlists IPs only`);
    }
  }
}

/**
 * The validator's registry hash (registry.service.js registryHash over
 * registry.queries.js findAllRows): the SHA-256 of the canonical JSON
 * (src/crypto/canonical.js) of the rows ordered by id, each
 * { id, publicKey, url, active } with the key as lowercase hex, as 64 hex
 * characters. A doorman and a worker holding the same rows answer the same
 * hash.
 */
function registryHash(rows) {
  const ordered = [...rows]
    .sort((a, b) => a.id - b.id)
    .map(({ id, publicKey, url, active }) => ({ id, publicKey, url, active }));
  return sha256(canonicalize(ordered)).toString('hex');
}

function load() {
  const rows = readRegistry();
  checkHosts(rows);
  const active = rows.filter((row) => row.active);
  return {
    validators: new Map(
      rows.map((row) => [row.id, Object.freeze({ ...row, publicKey: Buffer.from(row.publicKey, 'hex') })]),
    ),
    doormanIps: Object.freeze([...new Set(active.map((row) => hostOf(row.url)))]),
    active: active.length,
    hash: registryHash(rows),
  };
}

let loaded;
try {
  loaded = load();
} catch (err) {
  console.error(`Registry failed: ${err.message}`);
  process.exit(1);
}

/**
 * The registry, frozen: `validators`, a Map from id to
 * { id, publicKey (33-byte Buffer), url, active }; `doormanIps`, the unique
 * hosts of the active rows; `active`, the count of active rows; `hash`, the
 * validator's hash as 64 hex characters.
 */
export const registry = Object.freeze(loaded);
