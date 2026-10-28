# doormansoftware: design record

## 1. Doorman build 1 (2026-10-27)

Built 2026-10-27 straight from
`~/Desktop/Z-TestNet/forclaude/doorman-build-1-code-ready.md` (FINAL,
decided in its planning chat), as a new repo next to anossoftware and
keyholdersoftware in the testnet tree. One edit outside it: step 3 of
anossoftware's `docs/operator-guide.md` became the Network section. Nothing
about the protocol, the tables, the routes that carry traffic, the worker's
code or the wallet changed. No check ran but `node --check` on each
JavaScript file and `npm install` once, for the lock file: the first boot on
the doorman VM is the test.

### 1.1 The decisions, as they apply to the code

- **What the doorman is.** A second VM per operator with the static
  external IP. nginx terminates TLS on 3000 and 3200
  (`deploy/nginx/doorman.conf`) and proxies to one Node process with two
  listeners on 127.0.0.1, 8000 and 8200 (`src/server.js`,
  `src/door/door.js`), each a door in front of one worker port. A door
  checks shape, size and signatures against its route table
  (`src/doors/`), forwards the original bytes to `WORKER_IP:<port>` and
  relays the answer (`src/door/forward.js`). The worker has no external IP
  and reaches the internet through the doorman's NAT (`deploy/nftables.conf`,
  `deploy/sysctl-doorman.conf`).
- **Signature checks at the door.** Every signed field must decode as a
  signature of its algorithm and length (`src/checks/signed-request.js`,
  `account-signatures.js`). Cryptographic verification only for the two
  kinds the door has keys for: validator-to-validator messages against the
  registry copy (`checks/validator-messages.js`) and create-account, whose
  keys are in its own payload (`checks/create-account.js`). Transfers,
  follow-ups and signed reads pass after shape, size and decoding
  (`checks/transfers.js`, `follow-ups.js`, `reads.js`); the keyholder's
  port is shape and size only (`checks/keyholder.js`). Every shape function
  is the worker's, copied as it stood on 2026-10-27, with the worker's
  reason strings.
- **Certificates.** IPs, no DNS names. acme.sh 3.1.6 from a git clone as
  root, Let's Encrypt IP certificates on the `shortlived` profile, renewed
  by acme.sh's own cron with `--days 3`, HTTP-01 through the webroot
  `/var/www/acme` on port 80 (`deploy/nginx/doorman-acme.conf`). The key
  is root's, 0600, pre-created empty by the install script; the chain is
  world-readable and the health reads its expiry. The nginx config carries
  no IP, so it is the same on every doorman. A failed renewal shows as
  `degraded` health once under 2 days are left.
- **The registry copy and the allowlist.** `network/testnet.registry.json`
  is anossoftware's file byte for byte, committed in both repos.
  `src/registry/registry.js` reads it once at import with the validator's
  shape checks and messages, no own-row check, plus one of its own: every
  active row's url host is an IPv4 literal. It exports the validators (key
  as a 33-byte Buffer), the doorman IPs, the active count and the
  validator's hash (SHA-256 of the canonical JSON of the rows ordered by
  id, each `{ id, publicKey, url, active }`), so a doorman and a worker
  with the same rows answer the same hash. The allowlist is those IPs plus
  `ALLOWLIST_IPS`, shipped `<fill in>` and filled by us with the wallet
  proxy servers' public IPs.
- **No anti-spam challenge now.** Rate limits, body caps and fail2ban; a
  proof-of-work token is testnet-month work.
- **nginx for TLS, caps, timeouts, the access log and the ACME path; the
  limiter in Node** (`src/limit/rate-limit.js`), since the allowlist is
  dynamic. fail2ban reads nginx's access log (`deploy/fail2ban/`).
- **Body caps per route.** Port 3000: 96 KB for `/create-account` and
  `/transaction-approval`; 64 KB for the eight wallet submission routes,
  `/attachment-approval` and both proof routes; 16 KB for the four signed
  reads; 4 KB for `/ready-announcement`; 256 KB for `/official-list` and
  `/final-declaration`. Port 3200: 32 KB for every route. nginx caps each
  port at its largest route (256k, 32k); the door caps per route with
  `express.raw`, answering 413 `request body too large` either way.
- **Rates.** Per source IP and per port, a bucket of 20 refilled at 5 per
  second; over it 429 `too many requests` with `Retry-After: 1`, no log
  line. fail2ban: 20 answers of 429 within 60 seconds ban the IP 10
  minutes on all ports (`nftables-allports`); the sshd jail is off. nginx
  timeouts 10 s headers and body, 15 s keep-alive, 5 s connect, 60 s send,
  600 s read; the door's forward has the same 600 s cap
  (`WORKER_TIMEOUT_SECONDS`), the health fetch 5 s.
- **The NAT.** IP forwarding on the doorman, a VPC route for `0.0.0.0/0`
  with the doorman as next hop for instances tagged `worker`, an nftables
  masquerade for the private ranges. The forward chain drops everything
  but established traffic and the private ranges. Firewall and route are
  the operator guide's Network section; not Cloud NAT.
- **The egress cap.** A named quota `egress-month` of 102400 mbytes in a
  postrouting rule for every packet to an address outside the private, the
  link-local and the IAP ranges, dropping once over; the timer
  `doorman-quota-reset.timer` resets it at 00:05 on the 1st. SSH through
  IAP and the worker path survive a trip.
- **Logs.** nginx's combined access log at `/var/log/nginx/doorman-access.log`,
  rotated by Debian's logrotate; the door logs its boot lines and one line
  per refusal (`refused <ip> <method> <path> <status>: <reason>`) and per
  502 or 504 (`worker <port> <message>`), nothing for a forwarded request
  or a 429.
- **Health.** `GET /health` on both ports, answered by the door: version,
  registry hash and active count, certificate expiry (`notAfter`,
  `daysLeft`), the worker's `/health` JSON embedded (`src/door/health.js`).
  `ok` 200 when the worker answered 200 and `daysLeft > 2`, else `degraded`
  503.
- **Units.** `deploy/doorman.service`, the validator unit's twin (user
  `doorman`, `/opt/doorman/doormansoftware`, `/usr/bin/node` with the two
  env files, `ProtectSystem=strict`); the rest are system packages' units,
  acme.sh's cron and `doorman-quota-reset.timer`. Every file outside the
  repo ships under `deploy/` and is placed by
  `scripts/install-system-files.sh`, which installs the TLS site only once
  the certificate exists and so runs twice at setup.
- **The machine file.** `.env` holds `WORKER_IP`, written by
  `npm run setup -- --worker-ip <ip>` (`scripts/setup.js`: an IPv4 address
  in a private range, exclusive create, refuses to run twice, prints the
  next commands). Everything else is in `network/testnet.env`.
- **Two listeners, one pipeline.** The keyholder table is the nine POST
  routes by level plus nothing; `OPTIONS` on a table path is forwarded
  with no checks; port 80 serves only the ACME path; anything not in a
  table is 404 from the door; a worker that does not answer is 502
  `worker unavailable`, one over 600 s 504 `worker timeout`.
- **Deploy order.** The doorman first (the worker has no internet until
  the NAT exists), then the worker per the operator guide, then the
  registry row gets `https://<doorman static ip>:3000`. The full install is
  the README's "The doorman VM"; the operator guide's step 3 points at it.

### 1.2 Files and variables

The repo: `package.json` (name `doormansoftware`, version `0.1.0`, ES
modules, Node `>=24`, `express` and `canonicalize`), `package-lock.json`,
`.gitignore`, `.editorconfig` (anossoftware's), `.example.env`, `README.md`,
`docs/schemas.md`.

`src/`: `server.js`; `config/env.js`; `crypto/bytes.js`, `hash.js`,
`canonical.js`, `signatures.js` (verbatim copies of anossoftware's, each
with one line saying so); `util/is-object.js`, `result.js`, `version.js`
(copies); `registry/registry.js`; `limit/rate-limit.js`; `door/door.js`,
`forward.js`, `health.js`, `refused.js`, `not-found.js` (copy),
`error-handler.js` (copy, the 413 mapping added); `doors/validator.routes.js`,
`keyholder.routes.js`; `checks/signed-request.js`, `account-keys.js`
(copy), `account-signatures.js`, `create-account.js`, `transfers.js`,
`follow-ups.js`, `reads.js`, `validator-messages.js`, `keyholder.js`.

`scripts/setup.js`, `scripts/install-system-files.sh`;
`network/testnet.env`, `network/testnet.registry.json`;
`deploy/doorman.service`, `doorman-quota-reset.service`,
`doorman-quota-reset.timer`, `nginx/doorman-acme.conf`, `nginx/doorman.conf`,
`nftables.conf`, `sysctl-doorman.conf`, `fail2ban/doorman.conf`,
`fail2ban/doorman-429.conf`.

Variables, read once by `env.js`: shared, in `network/testnet.env`,
`WORKER_VALIDATOR_PORT=3000`, `WORKER_KEYHOLDER_PORT=3200`,
`DOOR_VALIDATOR_PORT=8000`, `DOOR_KEYHOLDER_PORT=8200`, `RATE_PER_SECOND=5`,
`RATE_BURST=20`, `WORKER_TIMEOUT_SECONDS=600`, `HEALTH_TIMEOUT_SECONDS=5`,
`TLS_FULLCHAIN_FILE=/etc/doorman/tls/fullchain.pem`,
`ALLOWLIST_IPS="<fill in>"`; machine, in `.env`, `WORKER_IP`. `required()`
refuses the literal `<fill in>` with `X is still "<fill in>": fill it in
network/testnet.env or .env`; `requiredIPv4` and the IPv4 check on every
`ALLOWLIST_IPS` item are this repo's additions; the integers are
`optionalInteger` with the values above as defaults. No registry path
variable.

Outside the repo, on the VM: `/etc/sysctl.d/90-doorman.conf`,
`/etc/nftables.conf`, `/var/www/acme/`, `/etc/doorman/tls/{key,fullchain}.pem`,
`/etc/nginx/sites-available/{doorman-acme,doorman}` and their links,
`/var/log/nginx/doorman-access.log`, `/etc/fail2ban/jail.d/doorman.conf`,
`/etc/fail2ban/filter.d/doorman-429.conf`, the three units in
`/etc/systemd/system/`, acme.sh under `/root/.acme.sh` with its cron.

The one change in anossoftware: `docs/operator-guide.md`, step 3, the
Network section (the static IP, IP forwarding, the tags, the four firewall
rules, the worker route, IAP SSH, the budget), with the text the plan gave.

### 1.3 Notes from the build

Where the plan was silent, or named something the code could not take
literally, the simplest thing was chosen and is recorded here; nothing in
1.1 was changed.

- **`createDoor({ routes, workerPort, allowlist })`**, not
  `{ name, routes, workerPort, listenPort }`: the door name and the listen
  port appear only in `server.js`'s boot lines, which `server.js` prints
  from its own table of the two doors, and the allowlist has to come from
  `server.js`, which builds it once (the registry's doorman IPs plus
  `ALLOWLIST_IPS`, one `Set`); each door builds its own limiter from it.
- **`src/door/refused.js`** holds `clientIp(req)` (the `X-Real-IP` header,
  else the socket address) and `logRefused(req, status, reason)`, so
  `door.js`, `forward.js` and `error-handler.js` share one definition of
  the caller and one log line; nothing is set on `req`. The path in the
  line is `req.originalUrl`, as in the 404 body.
- **A check's refusal is `refuse(status, reason)`** from the copied
  `util/result.js`, so it is `{ ok: false, status, reason }`; the door
  reads `status` and `reason`. `ok` and `answer` are unused.
- **`canonicalBytes(payload)`** in `checks/signed-request.js` is the
  worker's `messageOf`, exported: the canonical bytes or null. A payload
  with no canonical form (a lone surrogate) is `400 bad request shape` at
  the door, for create-account as the plan says and for validator
  messages too, where the worker would answer 500.
- **The registry failure is printed by `registry.js` itself**: the file is
  checked at import, so the module catches its own failure, prints
  `Registry failed: <message>` and exits 1. A bad env variable surfaces as
  Node's uncaught error at import, as in the other two servers. The IPv4
  host message goes through the same `fail()` as the copied checks, so it
  is prefixed with the file name like them.
- **`ACCOUNT_TYPES`** (`spending`, `guarded`, `vault`, `assisted`) is a
  constant inside `checks/create-account.js` rather than a copy of
  `account-types.js`: the shape function is its only user.
- **The follow-up kinds are `{ type, signerField }`** constants in
  `checks/follow-ups.js`. The door runs the common shape of
  `checkAttachmentShape` as the plan lists it; a kind's own fields
  (`attestation`'s `accountId`, a vote's `vote`, a verdict's `verdict`) are
  the worker's.
- **`checks/reads.js` and `checks/keyholder.js`** are two files, as the
  plan lists them, though the signed read is the envelope check with
  `accountId` and both signatures; the eight lines are duplicated rather
  than one module importing the other's.
- **`requiredInteger`** is copied into `env.js` with the other helpers and
  has no user today: every integer has a default.
- **`.env` is written 0644 under `wx`** and not chmod-ed afterwards:
  nothing but the door's own user reads it, unlike the validator's, which
  postgres reads.
- **The fail2ban filter regex** is `^<HOST> - \S+ \[[^\]]*\] "[^"]*" 429\s`,
  not the plan's `\[[^\]]+\] ... 429 `: fail2ban cuts the detected date out
  of a line before matching, which leaves `[]` where the timestamp was, so
  the bracket group has to accept zero characters (fail2ban's own
  `nginx-botsearch` writes `\[\]`); and a trailing space does not survive
  the config parser, so the boundary after `429` is written as `\s`.
- **The install script creates `/var/log/nginx/doorman-access.log`**
  (root:adm, 0640, Debian's own mode for nginx logs) when it is missing,
  before fail2ban: on the first pass only the port-80 site is installed,
  and the access log is declared by the TLS site, so without this the jail
  would find no log file. The script also resolves the repo root from its
  own path, so it works from any working directory, and prints the next
  step when the TLS site was skipped.
- **The `worker <port> <message>` line** appends the cause when fetch
  gives one (`fetch failed: connect ECONNREFUSED 10.128.0.2:3000`), since
  fetch's own message says only that it failed.
- **`express.raw` keeps its default `inflate`**: a gzip or deflate body is
  inflated before the cap applies and forwarded inflated, without a
  `content-encoding` header; the wallet never compresses.
- **`HEAD /health`** is answered through Express's own routing of HEAD to
  the GET handler, body stripped; `HEAD` on a table path is 404, like
  `GET`. A method the table does not have on a known path is 404, not 405.
- **The certificate's expiry** is `X509Certificate.validToDate` of the
  first PEM block of the chain file; `daysLeft` is rounded to one decimal.
- **The route tables carry `method`** (always `POST` today) and the door
  registers each route by it, plus `OPTIONS` on the same path.
- **A route with no check** (`/get-keyholder-public-key`) forwards whatever
  body arrived under the cap, with its content type, JSON or not; the
  worker ignores it.
- **The listeners are bound to `127.0.0.1` explicitly** (`LOOPBACK` in
  `server.js`), and the boot lines print that address.
- **The health's `worker` field** is the worker's JSON whatever its HTTP
  status; the `ok` rule compares the status the worker answered with,
  so a worker answering 503 `degraded` with a body makes the doorman
  `degraded` with that body embedded.
