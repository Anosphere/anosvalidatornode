import { env } from './config/env.js';
import { registry } from './registry/registry.js';
import { createDoor } from './door/door.js';
import { keyholderRoutes } from './doors/keyholder.routes.js';
import { validatorRoutes } from './doors/validator.routes.js';

// env and registry are imported first, so a bad variable or a bad registry
// file stops the boot before a port opens: env throws, as in the other two
// servers; the registry prints `Registry failed: <message>` and exits 1.
console.log(`Doorman for worker ${env.workerIp}`);

// Who skips the rate limit: the doormen of the active registry rows and the
// wallet proxy servers' IPs from network/testnet.env, built once and shared
// by both doors; each door keeps its own buckets.
const allowlist = new Set([...registry.doormanIps, ...env.allowlistIps]);
console.log(`Registry ${registry.hash.slice(0, 16)}, ${registry.active} active, ${allowlist.size} IPs allowlisted`);

/** Both doors listen here and nowhere else; nginx is the only caller. */
const LOOPBACK = '127.0.0.1';

// The worker is not contacted at boot: a door starts whether or not its
// worker is up, and health says so.
const doors = [
  { name: 'Validator', routes: validatorRoutes, workerPort: env.workerPorts.validator, listenPort: env.listenPorts.validator },
  { name: 'Keyholder', routes: keyholderRoutes, workerPort: env.workerPorts.keyholder, listenPort: env.listenPorts.keyholder },
];

const servers = doors.map(({ name, routes, workerPort, listenPort }) => {
  const app = createDoor({ routes, workerPort, allowlist });
  return app.listen(listenPort, LOOPBACK, () => {
    console.log(`${name} door listening on http://${LOOPBACK}:${listenPort} for ${env.workerIp}:${workerPort}`);
  });
});

let shuttingDown = false;

/** Stop accepting connections, let in-flight requests finish, exit. */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);

  // Safety net: never hang forever if a connection refuses to close.
  setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();

  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
