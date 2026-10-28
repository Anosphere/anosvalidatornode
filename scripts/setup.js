import { existsSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Writes this doorman's machine file, on the VM, once:
 *
 *   npm run setup -- --worker-ip <ip>
 *
 * --worker-ip is the worker VM's internal IP, the one value that differs
 * per doorman; everything shared by every doorman is in network/testnet.env.
 * .env is written with the exclusive flag and holds the one line
 * WORKER_IP=<ip>; if it exists the script says so and writes nothing. The
 * doorman's make-keys, in the other two repos' terms, except that it makes
 * no key: the doorman has none of its own. The TLS key belongs to acme.sh
 * and nginx (README, "The doorman VM", step 4) and nothing here touches it.
 */

const USAGE = 'usage: npm run setup -- --worker-ip <ip>';

/** The repo root: where .env goes. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** True when `ip`, dotted IPv4, is in 10/8, 172.16/12 or 192.168/16. */
function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

let args;
try {
  args = parseArgs({ options: { 'worker-ip': { type: 'string' } } }).values;
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(1);
}

const ip = args['worker-ip'];
if (ip === undefined) {
  console.error(`--worker-ip is required: the worker VM's internal IP.\n${USAGE}`);
  process.exit(1);
}
if (!isIPv4(ip)) {
  console.error(`--worker-ip must be an IPv4 address, got "${ip}".\n${USAGE}`);
  process.exit(1);
}
if (!isPrivate(ip)) {
  console.error(
    `--worker-ip must be in a private range (10/8, 172.16/12 or 192.168/16), got "${ip}": the worker has an internal IP only.\n${USAGE}`,
  );
  process.exit(1);
}

const envPath = resolve(REPO_ROOT, '.env');
if (existsSync(envPath)) {
  console.error(`${envPath} already exists; nothing written.`);
  process.exit(1);
}

writeFileSync(
  envPath,
  [
    "# The worker VM's internal IP, the only value that differs per doorman.",
    '# Written by npm run setup; everything shared is in network/testnet.env.',
    `WORKER_IP=${ip}`,
    '',
  ].join('\n'),
  { flag: 'wx', mode: 0o644 },
);

console.log(`Doorman for worker ${ip}`);
console.log('');
console.log(`Wrote ${envPath}.`);
console.log('Next (README, "The doorman VM", steps 3 to 5): the system files, the certificate, the system files again:');
console.log('');
console.log('  sudo sh scripts/install-system-files.sh');
console.log('  the certificate, as root: README, "The doorman VM", step 4');
console.log('  sudo sh scripts/install-system-files.sh');
