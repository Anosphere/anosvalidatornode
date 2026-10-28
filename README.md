# doormansoftware

The doorman: the second VM in each operator's project, the one with the
static external IP, in front of the worker VM that runs the validator
(anossoftware) and the keyholder (keyholdersoftware). nginx on it terminates
TLS on ports 3000 and 3200 and hands each request to a Node app on
localhost, the door, which checks the request's shape, size and signatures
against a route table, forwards the good ones to the worker over the
internal IP, holds the connection open until the worker answers, and
relays the answer. Everything else is refused at the door with the
worker's own status codes and reasons. The doorman is also the worker's
only way out: the worker has no external IP and routes its outbound
traffic through the doorman, which masquerades it, so every call a
validator makes leaves from its registry IP. The doorman rate limits by
source IP, bans through fail2ban, caps its own monthly internet egress,
and renews a Let's Encrypt certificate for its IP every three days.

What it does not do: it checks no account. It has no database, holds no
account keys and verifies no transfer, follow-up or signed read against
an account; it verifies only what it has keys for, validator-to-validator
messages against the registry copy and create-account submissions against
the keys in their own payload. Everything else passes on shape, size and
decoding, and the worker verifies it as it does today. The protocol, the
tables, the routes and the worker's code are untouched by it.

## Requirements

- Debian 13 (the doorman VM: `e2-small`, IP forwarding on, network tag
  `doorman`)
- nginx (Debian 13's 1.26), fail2ban, nftables, from Debian's packages
- Node.js 24 or newer, from NodeSource
- acme.sh 3.1.6, installed from a git clone as root (Debian's certbot 4.0.0
  cannot issue IP certificates)

## Configuration

Two env files, loaded in this order by `npm start` and by the systemd unit
(`node --env-file=network/testnet.env --env-file=.env src/server.js`); where
both name a variable the later file wins. `src/config/env.js` reads them
once at boot.

- `network/testnet.env`, committed: every value that is the same on every
  doorman. No secrets. Each line has a comment.
- `.env`, git-ignored: what differs per machine, one line, written by
  `npm run setup -- --worker-ip <ip>`. `.example.env` shows it.

Shared values, in `network/testnet.env`:

| Variable                 | Testnet                          | Description                                                  |
| ------------------------ | -------------------------------- | ------------------------------------------------------------ |
| `WORKER_VALIDATOR_PORT`  | `3000`                           | The validator's port on the worker                            |
| `WORKER_KEYHOLDER_PORT`  | `3200`                           | The keyholder's port on the worker                            |
| `DOOR_VALIDATOR_PORT`    | `8000`                           | Where the validator door listens on 127.0.0.1; nginx proxies its port 3000 to it |
| `DOOR_KEYHOLDER_PORT`    | `8200`                           | Where the keyholder door listens on 127.0.0.1; nginx proxies its port 3200 to it |
| `RATE_PER_SECOND`        | `5`                              | Tokens a source IP's bucket refills per second, per door      |
| `RATE_BURST`             | `20`                             | The bucket's size                                             |
| `WORKER_TIMEOUT_SECONDS` | `600`                            | How long a forwarded request waits for the worker's answer    |
| `HEALTH_TIMEOUT_SECONDS` | `5`                              | How long the health's fetch of the worker's `/health` waits   |
| `TLS_FULLCHAIN_FILE`     | `/etc/doorman/tls/fullchain.pem` | The certificate chain acme.sh installs; the health reads its expiry |
| `ALLOWLIST_IPS`          | `<fill in>`                      | IPv4 addresses that skip the rate limit, comma-separated: the wallet proxy servers' own public IPs. The doormen of the registry are added by the server |

The machine value, in `.env`:

| Variable    | Description                                                        |
| ----------- | ------------------------------------------------------------------ |
| `WORKER_IP` | The worker VM's internal IP: where both doors forward to            |

`env.js` checks all of them at boot: `WORKER_IP` as an IPv4 address,
`ALLOWLIST_IPS` as a list of IPv4 addresses with at least one item, the
ports, rates and timeouts as positive integers when set. A value still
`<fill in>` is refused by name: `ALLOWLIST_IPS is still "<fill in>": fill
it in network/testnet.env or .env`. Every value but `WORKER_IP` and
`ALLOWLIST_IPS` keeps its default in the code, though the shared file names
it too.

The four port numbers are also in `deploy/nginx/doorman.conf`, which nginx
reads without any env file: its `listen 3000` and `listen 3200` and its two
`proxy_pass` lines to 8000 and 8200. Change them in both places.

The registry has no variable: `network/testnet.registry.json`, committed,
is the same file as anossoftware's, kept equal by committing every registry
change to both repos, and is read from that path and nowhere else. The door
refuses to boot while it does not pass (a row still `<fill in>`, a url
whose host is not an IPv4 address), like the validator.

## What the door checks

One Node process, two listeners on 127.0.0.1: 8000, the validator door,
forwarding to `WORKER_IP:3000`, and 8200, the keyholder door, forwarding to
`WORKER_IP:3200`. Each door has a route table of `POST` paths with a body
cap and a check. In order, for every request: the rate limit; `GET
/health`, which the door answers itself (section "Health"); `OPTIONS` on a
path in the table, forwarded with no body and no checks so a browser's CORS
preflight gets the worker's answer; a `POST` to a path in the table, read as
bytes up to its cap, parsed as JSON when the `Content-Type` is
`application/json`, checked, and forwarded as the original bytes; anything
else, 404. A pass forwards the bytes the caller sent, never a
re-serialization, so the canonical form the worker hashes and verifies is
exactly what the wallet produced. Every check mirrors the worker: the same
shape function, copied, with the same reason strings, then decoding and,
for the two kinds the door has keys for, verification.

The validator door (port 3000; KB is 1024 bytes):

| Path | Cap | Check |
| --- | --- | --- |
| `/create-account` | 96 KB | the shape; each of the eight public keys decodes for its algorithm, each signature decodes and verifies against its key over the canonical payload. The id hashes, uniqueness and the binding are the worker's |
| `/anos-transfer` | 64 KB | the transfer shape; every signature present is a string that decodes, both halves of each pair, under the type's rule: pair one and the wallet pair for `assistedAnosTransfer`, any two pairs for the other four |
| `/transfer-to-fund` | 64 KB | the transferToFund shape; signatures as above, any two pairs |
| `/fund-proposal` | 64 KB | the fundProposal shape, payouts included; signatures, any two pairs |
| `/attestation` | 64 KB | the follow-up shape with `payload.type` `attestation`, signer `attestorId`; signatures, any two pairs |
| `/assisted-transfer-cancel` | 64 KB | follow-up, kind `assistedTransferCancel`, signer `accountId` |
| `/guardian-vote` | 64 KB | follow-up, kind `guardianVote`, signer `guardianId` |
| `/escrow-signature` | 64 KB | follow-up, kinds `escrowSuccess`, `escrowCancel`, `escrowDispute` (signer `accountId`) and `escrowVerdict` (signer `arbitratorId`) |
| `/get-account`, `/list-transactions`, `/list-assisted-transfers`, `/list-disputed-escrows` | 16 KB | the signed envelope with `accountId`, both signatures (400 `bad request shape`); `ecdsa` decodes as P-256 and `mldsa` as ML-DSA-87 (401 `bad signature`). `path`, `timestamp`, the account and the nonce are the worker's |
| `/transaction-approval` | 96 KB | the worker's shape; `originatingValidator` is an active registry row; `signature.key` decodes as P-256 and verifies against that row's key over the canonical payload |
| `/proof-of-acceptance` | 64 KB | as above, and every receipt has the approved-receipt shape and a decoding `signature.key` (receipts are not verified at the door) |
| `/attachment-approval` | 64 KB | as `/transaction-approval`, with the attachment approval's shape |
| `/proof-of-attachment-acceptance` | 64 KB | as `/proof-of-acceptance`, with the attachment shapes |
| `/ready-announcement` | 4 KB | the leader call's shape; `leader` is an active row; its signature verifies. Whether it is the leader is the worker's |
| `/official-list` | 256 KB | the same, with `transactionIds` an array of digests (about 3,900 ids fit) |
| `/final-declaration` | 256 KB | the same, with `nextLeader` a positive integer |

The keyholder door (port 3200), every route capped at 32 KB, shape and
size only, since the keys of every level live elsewhere:

| Path | Check |
| --- | --- |
| `/get-keyholder-public-key` | none: the worker does not read the body |
| `/receive-share` | the envelope with signer `anopodId`, both signatures present and decoding |
| `/get-security-bucket-one-key`, `/get-security-bucket-two-key`, `/get-public-ledger-id` | the envelope with signer `accountId`, both signatures |
| `/get-break-glass-key`, `/get-backup-code`, `/decrypt-break-glass-key`, `/decrypt-backup-code` | the envelope with signer `yubikey`, `ecdsa` only |

nginx caps each port at its largest route (256k and 32k) before the door
sees the body. The answers a caller can get from the doorman itself, each a
JSON body:

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ "error": "<the worker's reason>" }` | a shape or decoding check failed; `{ "error": "invalid JSON" }` when the body is not JSON |
| 401 | `{ "error": "bad signature" }` | a signed envelope whose signature does not decode |
| 404 | `{ "error": "Not Found", "path": "<path>" }` | a path or method not in the table, the worker's `GET /` included |
| 413 | `{ "error": "request body too large" }` | over the route's cap (the door) or the port's cap (nginx) |
| 429 | `{ "error": "too many requests" }`, `Retry-After: 1` | the source IP's bucket is empty |
| 502 | `{ "error": "worker unavailable" }` | the worker did not answer |
| 504 | `{ "error": "worker timeout" }` | the worker took more than `WORKER_TIMEOUT_SECONDS` |

Everything else is the worker's own answer, relayed with its status and
headers, CORS headers included.

What the door logs, to the journal: at boot, `Doorman for worker
<WORKER_IP>`, `Registry <16 hex>, <n> active, <k> IPs allowlisted`,
`Validator door listening on http://127.0.0.1:8000 for <WORKER_IP>:3000`
and the same for the keyholder door; per request, one line for a refusal,
`refused <ip> <method> <path> <status>: <reason>`, and `worker <port>
<message>` for a 502 or 504. Nothing for a forwarded request and nothing
for a 429: nginx's access log, `/var/log/nginx/doorman-access.log`, has
every request with its status. A boot that fails prints `<What> failed:
<message>` and exits 1; systemd restarts the door every five seconds until
the file is fixed.

## Rate limits and bans

Per source IP and per port, a token bucket of `RATE_BURST` (20) tokens
refilled at `RATE_PER_SECOND` (5); a request takes one, and an empty bucket
answers 429 with `Retry-After: 1`. The source IP is the `X-Real-IP` header
nginx sets. Allowlisted IPs skip the bucket: every doorman IP read from the
active rows of the registry copy, plus the `ALLOWLIST_IPS` line of
`network/testnet.env`, the wallet proxy servers' own public IPs. Not the
masterpod, which makes no outbound call, and not a load balancer's
address, since a Hetzner server's outbound traffic leaves from the server's
own IP. The limiter lives in the Node door rather than in nginx because the
allowlist is dynamic.

fail2ban reads nginx's access log through the jail `doorman-429`
(`deploy/fail2ban/`): an IP that collects 20 answers of 429 within 60
seconds is banned for 10 minutes on every port, through nftables. An
allowlisted IP never gets a 429, so it is never banned. Debian's sshd jail
is off: port 22 only ever sees the IAP range.

```bash
sudo fail2ban-client status doorman-429
sudo fail2ban-client set doorman-429 unbanip <ip>
```

## The egress quota

A named nftables quota, `egress-month`, of 100 GB (102400 mbytes) in
`deploy/nftables.conf`, checked in a postrouting rule for every packet to
an address outside the private ranges, the link-local range (the metadata
server) and the IAP range (SSH). Everything billed as internet egress
counts, the worker's calls through the NAT included; once the month's
quota is used the packets are dropped and the validator goes dark until the
timer `doorman-quota-reset.timer` resets the count at 00:05 on the 1st of
each month. SSH through IAP and the worker path survive a trip; renewals,
updates and the validator itself do not, and the health sweep then shows
the validator unreachable. About $12 a month at the premium tier's
$0.12/GB. Each operator also sets a Cloud Billing budget with email alerts,
for visibility (operator guide, Network, point 7).

```bash
sudo nft list quota inet doorman egress-month
sudo nft reset quota inet doorman egress-month
```

## Health

`GET /health` on both ports, answered by the door itself, through the rate
limit like every other request:

```json
{
  "status": "ok",
  "uptime": 123.4,
  "doorman": {
    "version": { "commit": "abc1234", "tag": null },
    "registry": { "hash": "<64 hex>", "active": 1 },
    "certificate": { "notAfter": "2026-11-03T12:00:00.000Z", "daysLeft": 5.3 }
  },
  "worker": { "...the worker's own /health JSON, or null..." }
}
```

`version` is the commit and tag of the checkout. `registry.hash` is the
hash the validator computes over the same rows, so a sweep sees when the
two copies drift. `certificate` is read from `TLS_FULLCHAIN_FILE`, null
until one is issued. `worker` is the worker's `/health` on that port,
fetched with `HEALTH_TIMEOUT_SECONDS`, null when it does not answer or
does not answer JSON. `status` is `ok` with 200 when the worker answered
200 and the certificate has more than 2 days left, else `degraded` with
503, which is how a failed renewal shows: acme.sh renews on day 3 of the
certificate's 6.7, so under 2 days left means two renewals failed.

## The doorman VM

Before the VM: the project side, in the operator guide's Network section
(`guides/operator-guide.md`, kept beside the repos in the testnet folder, step 2): the static IP, IP
forwarding, the tags, the firewall rules, the route, SSH through IAP, the
budget. The doorman VM is Debian 13 with unattended upgrades on
(`systemctl status unattended-upgrades`), `e2-small`, IP forwarding on,
tag `doorman`. Then, over `gcloud compute ssh operator@doorman --zone <zone>
--tunnel-through-iap` (operator guide, step 2, point 10: the login user
`operator`, the same on every VM), in this order.

1. Packages:

```bash
sudo apt update
sudo apt install -y nginx fail2ban nftables git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install -y nodejs
```

2. The service user and the repo, then the one machine value:

```bash
sudo useradd --system --create-home --home-dir /opt/doorman --shell /bin/bash doorman
sudo -iu doorman
git clone https://github.com/Anosphere/anosvalidatornode.git /opt/doorman/doormansoftware
cd /opt/doorman/doormansoftware && npm ci
npm run setup -- --worker-ip <the worker's internal IP>
exit
```

3. System files, first pass: the NAT, the egress quota, fail2ban, nginx on
   port 80, the units. The script reports that the TLS site was skipped,
   since there is no certificate yet. From this moment the worker has its
   outbound path.

```bash
cd /opt/doorman/doormansoftware && sudo sh scripts/install-system-files.sh
```

4. The certificate, as root:

```bash
sudo -i
git clone --depth 1 --branch 3.1.6 https://github.com/acmesh-official/acme.sh.git /root/acme.sh-src
cd /root/acme.sh-src && ./acme.sh --install -m <your email>
/root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
/root/.acme.sh/acme.sh --issue --server letsencrypt -d <doorman static ip> -w /var/www/acme --cert-profile shortlived --days 3
/root/.acme.sh/acme.sh --install-cert -d <doorman static ip> --ecc --key-file /etc/doorman/tls/key.pem --fullchain-file /etc/doorman/tls/fullchain.pem --reloadcmd "chmod 600 /etc/doorman/tls/key.pem && systemctl reload nginx"
exit
```

   acme.sh installed a daily cron in root's crontab; it renews the
   certificate on day 3 and runs the reload command. `acme.sh --list` shows
   a renewal date computed for a 90-day certificate, which is wrong for
   this one; the health's `daysLeft` is right. The key is root's, mode
   0600, in a file the install script created owner-only before it
   existed; nothing in this repo reads it.

5. System files, second pass: the TLS site, and the doorman unit restarted:

```bash
cd /opt/doorman/doormansoftware && sudo sh scripts/install-system-files.sh
journalctl -fu doorman
curl -k https://127.0.0.1:3000/health
curl -k https://127.0.0.1:3200/health
```

   Until your registry row is in (operator guide, step 9), the door refuses
   to boot: the journal shows `Registry failed: ... publicKey is still
   "<fill in>"` every five seconds and both health calls get nginx's 502.
   Expected; the NAT, port 80 and the certificate do not need the door.
   With the row pulled and the door restarted, the journal shows the four
   boot lines, and health answers 503 `degraded` with `worker: null` until
   the worker is up; `-k` only because the certificate names the public IP,
   not 127.0.0.1. From your own machine,
   `curl https://<doorman static ip>:3000/health` verifies the certificate.

6. The worker, per the operator guide. Once it runs, both health answers
   carry the worker's own health and the status turns `ok`. The address
   for the registry is `https://<doorman static ip>:3000`.

Checking later: `sudo nft list quota inet doorman egress-month`,
`sudo fail2ban-client status doorman-429`, `sudo tail
/var/log/nginx/doorman-access.log`, `journalctl -u doorman`.

## Updating

As `doorman`, `git pull` in `/opt/doorman/doormansoftware`, `npm ci` when
`package-lock.json` changed, then `sudo systemctl restart doorman`; when the
pull touched `deploy/`, `sudo sh scripts/install-system-files.sh` instead,
which restarts the door itself. A registry change arrives the same way, in
both repos: pull and restart on the doorman, pull and restart on the
worker.

## Layout

```
src/
  server.js                      boot: env and the registry first, the boot lines, the two doors on 127.0.0.1, shutdown
  config/env.js                  reads and validates the two env files once (network/testnet.env, then .env)
  crypto/bytes.js                hex / base64 decoding with byte-length checks (copy of anossoftware's)
  crypto/hash.js                 SHA-256 and digest decoding (copy)
  crypto/canonical.js            canonical JSON (canonicalize package) and its hash (copy)
  crypto/signatures.js           P-256 and ML-DSA-87 decoding and verification (copy)
  util/is-object.js              the one helper the shape checks share (copy)
  util/result.js                 ok / refuse: the shape a check's refusal takes (copy)
  util/version.js                the commit and tag git reports, read once at boot, for /health (copy)
  registry/registry.js           the registry copy, read and checked at import; the doorman IPs; the hash
  limit/rate-limit.js            the per-IP token bucket with the allowlist
  door/door.js                   createDoor({ routes, workerPort, allowlist }): the Express app of one door
  door/forward.js                the relay to the worker
  door/health.js                 GET /health
  door/refused.js                the client IP and the refusal log line
  door/not-found.js              404 for anything not in the table (copy)
  door/error-handler.js          the central error handler, with the 413 mapping added (copy)
  doors/validator.routes.js      the route table of port 3000
  doors/keyholder.routes.js      the route table of port 3200
  checks/signed-request.js       parseSignedRequest (the shape half of anossoftware's), the decode helpers
  checks/account-keys.js         the eight account keys, in order, with algorithms (copy)
  checks/account-signatures.js   the three pairs, the two rules, decode-only
  checks/create-account.js       shape, eight keys decode, eight signatures decode and verify
  checks/transfers.js            /anos-transfer, /transfer-to-fund, /fund-proposal
  checks/follow-ups.js           the four follow-up routes and the seven kinds
  checks/reads.js                the four signed reads
  checks/validator-messages.js   the seven validator routes, verified against the registry
  checks/keyholder.js            the nine keyholder routes by level
scripts/
  setup.js                       once, on the VM: writes .env with WORKER_IP
  install-system-files.sh        puts deploy/ in place, reloads, restarts (as root)
network/
  testnet.env                    every value that is the same on every doorman, committed
  testnet.registry.json          the registry copy, the same file as anossoftware's, committed
deploy/
  doorman.service                the door's systemd unit, identical on every doorman
  doorman-quota-reset.service    resets the egress quota (oneshot)
  doorman-quota-reset.timer      runs it at 00:05 on the 1st of each month
  nginx/doorman-acme.conf        port 80: the ACME challenge path only
  nginx/doorman.conf             ports 3000 and 3200: TLS, caps, timeouts, the access log, the proxy
  nftables.conf                  the NAT for the worker and the egress quota
  sysctl-doorman.conf            net.ipv4.ip_forward = 1
  fail2ban/doorman.conf          the jail doorman-429; the sshd jail off
  fail2ban/doorman-429.conf      the filter: an access-log line answered 429
docs/
  schemas.md                     the design record: the decisions, the files, the notes from the build
.example.env                     the one machine line, with its comment
```

## Design record

`docs/schemas.md`: section 1, "Doorman build 1 (2026-10-27)", holds the
decisions as they apply to the code, the files and variables, and the
notes from the build.
