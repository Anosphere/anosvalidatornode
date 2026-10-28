import { isIPv4 } from 'node:net';

/**
 * Reads and validates environment variables once at startup.
 * Everything else imports `env` from here instead of touching process.env,
 * so a missing or malformed variable fails at boot rather than mid-request.
 *
 * Two files are loaded, in this order: network/testnet.env, committed, with
 * every value that is the same on every doorman of the network, then .env,
 * the machine file scripts/setup.js writes (the worker VM's internal IP,
 * the one value that differs per doorman), which wins where both name a
 * variable:
 *   node --env-file=network/testnet.env --env-file=.env src/server.js
 *
 * There is no registry path variable: the registry is
 * network/testnet.registry.json, read from there and nowhere else
 * (src/registry/registry.js), as on the validator.
 */

/** The placeholder the shared file ships with for an address that does not exist yet. */
const FILL_IN = '<fill in>';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (value === FILL_IN) {
    throw new Error(`${name} is still "${FILL_IN}": fill it in network/testnet.env or .env`);
  }
  return value;
}

/** A required variable that must be a positive integer. */
function requiredInteger(name) {
  const value = required(name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

/**
 * An optional variable that must be a positive integer when set; `fallback`
 * when it is not set.
 */
function optionalInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

/**
 * A required comma-separated list (the masterpod's parser, without a
 * default): items trimmed, empty ones dropped, at least one.
 */
function requiredList(name) {
  const value = required(name);
  const items = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (items.length === 0) throw new Error(`${name} must list at least one item, got "${value}"`);
  return Object.freeze(items);
}

/** A required variable that must be an IPv4 address in dotted form. */
function requiredIPv4(name) {
  const value = required(name);
  if (!isIPv4(value)) {
    throw new Error(`${name} must be an IPv4 address, got "${value}"`);
  }
  return value;
}

/** A required list (requiredList) in which every item is an IPv4 address. */
function requiredIPv4List(name) {
  const items = requiredList(name);
  for (const item of items) {
    if (!isIPv4(item)) {
      throw new Error(`${name}: "${item}" is not an IPv4 address`);
    }
  }
  return items;
}

export const env = Object.freeze({
  // The worker VM's internal IP, from .env: where both doors forward to
  // (src/door/forward.js) and whose /health the door's own health embeds.
  workerIp: requiredIPv4('WORKER_IP'),

  // The worker's two ports, the validator's and the keyholder's, behind that
  // IP. In network/testnet.env, and duplicated in deploy/nginx/doorman.conf,
  // which nginx reads without any env file.
  workerPorts: Object.freeze({
    validator: optionalInteger('WORKER_VALIDATOR_PORT', 3000),
    keyholder: optionalInteger('WORKER_KEYHOLDER_PORT', 3200),
  }),

  // Where the two doors listen, on 127.0.0.1, for nginx: its port 3000 is
  // proxied to the first, 3200 to the second. Duplicated in doorman.conf as
  // above.
  listenPorts: Object.freeze({
    validator: optionalInteger('DOOR_VALIDATOR_PORT', 8000),
    keyholder: optionalInteger('DOOR_KEYHOLDER_PORT', 8200),
  }),

  // The per-IP token bucket of each door (src/limit/rate-limit.js): refilled
  // at perSecond, holding at most burst.
  rate: Object.freeze({
    perSecond: optionalInteger('RATE_PER_SECOND', 5),
    burst: optionalInteger('RATE_BURST', 20),
  }),

  // IPv4 addresses that skip the bucket: the wallet proxy servers' own
  // public IPs, a comma-separated list in network/testnet.env. The doormen
  // of the registry are added by server.js and are not listed there.
  allowlistIps: requiredIPv4List('ALLOWLIST_IPS'),

  // How long a forwarded request waits for the worker's answer (a
  // submission waits for every other validator) and how long the health
  // fetch of the worker's /health may take, in seconds.
  timeouts: Object.freeze({
    workerSeconds: optionalInteger('WORKER_TIMEOUT_SECONDS', 600),
    healthSeconds: optionalInteger('HEALTH_TIMEOUT_SECONDS', 5),
  }),

  // The certificate chain acme.sh installs for nginx, world-readable: the
  // health reads its expiry (src/door/health.js). The key next to it is
  // root's, mode 0600, and nothing in this repo reads it.
  tls: Object.freeze({
    fullchainFile: process.env.TLS_FULLCHAIN_FILE || '/etc/doorman/tls/fullchain.pem',
  }),
});
