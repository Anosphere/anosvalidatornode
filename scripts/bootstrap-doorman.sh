#!/bin/sh
# Sets up the doorman VM: the operator guide's step 3, point by point, one
# line printed per point, then step 9's pull and restart (point 9.2, which
# is also step 11's point 2) on every later run. Runs on the doorman VM as
# root, over SSH from Cloud Shell; every value is a flag and nothing is
# asked:
#
#   curl -fsSLO https://raw.githubusercontent.com/Anosphere/anosvalidatornode/main/scripts/bootstrap-doorman.sh && sudo sh bootstrap-doorman.sh --worker-ip <worker internal ip> --doorman-ip <doorman static ip> --email <your email>
#
# Safe to run again: every point does what is still missing and answers
# "already" for what is done, then the repo is pulled and the door
# restarted when something changed. Once a value is in the machine files
# its flag may be left out, so every later run is the same line with
# nothing after bootstrap-doorman.sh; a flag that is given must match what
# is on disk. Everything the commands print goes to
# /var/log/doorman-bootstrap.log; the screen gets one line per point and a
# last line: "done: ..." or "failed at step <number> (<name>): see
# /var/log/doorman-bootstrap.log". Nothing here reads or prints a key: the
# TLS key is acme.sh's and nginx's.
set -eu

SCRIPT=bootstrap-doorman.sh
LOG=/var/log/doorman-bootstrap.log
REPO=/opt/doorman/doormansoftware
INSTALL=$REPO/scripts/install-system-files.sh
TLS=/etc/doorman/tls
ACME=/root/.acme.sh/acme.sh
METADATA=http://169.254.169.254/computeMetadata/v1

# 0. Root first: the log and everything below need it.
if [ "$(id -u)" -ne 0 ]; then
  echo "failed at the argument check: run as root: sudo sh $SCRIPT --worker-ip <worker internal ip> --doorman-ip <doorman static ip> --email <your email>" >&2
  exit 1
fi
# acme.sh keeps its files under root's home; apt asks nothing.
HOME=/root
export HOME
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND

# The log holds everything a command prints; the screen, kept on fd 3, gets
# only what say() sends it.
touch "$LOG"
chmod 600 "$LOG"
exec 3>&1
exec >>"$LOG" 2>&1
printf '=== %s %s %s ===\n' "$SCRIPT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"

# say LINE: to the screen and to the log.
say() {
  printf '%s\n' "$*" >&3
  printf '%s\n' "$*"
}

# at NUMBER NAME: the guide point being done, for the failure line.
STEP=''
STEP_NAME=''
at() {
  STEP=$1
  STEP_NAME=$2
}

# fail REASON: the reason goes to the log, the run ends, the EXIT trap
# prints the failure line. Never called inside $(...).
fail() {
  printf '%s\n' "$*"
  exit 1
}

# arg_fail REASON: the argument check failed; nothing has been touched.
ARG_FAILED=0
arg_fail() {
  ARG_FAILED=1
  say "failed at the argument check: $*"
  exit 1
}

TMP=''
on_exit() {
  status=$?
  if [ -n "$TMP" ]; then
    rm -rf "$TMP"
  fi
  if [ "$status" -ne 0 ] && [ "$ARG_FAILED" -eq 0 ]; then
    tail -n 5 "$LOG" >&3
    if [ -n "$STEP" ]; then
      say "failed at step $STEP ($STEP_NAME): see $LOG"
    else
      say "failed at the argument check: see $LOG"
    fi
  fi
}
trap on_exit EXIT

# matches VALUE REGEX: the whole value matches the extended regex.
matches() {
  printf '%s\n' "$1" | grep -Eq "$2"
}

# is_ipv4 VALUE: a dotted quad, four numbers 0 to 255.
is_ipv4() {
  matches "$1" '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' || return 1
  ipv4_ifs=$IFS
  IFS=.
  set -- $1
  IFS=$ipv4_ifs
  for octet; do
    [ "$octet" -le 255 ] || return 1
  done
}

# is_private VALUE: in 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16, the
# rule scripts/setup.js applies to the worker's IP.
is_private() {
  case $1 in
    10.*|192.168.*) return 0 ;;
    172.*)
      second=${1#172.}
      second=${second%%.*}
      if [ "$second" -ge 16 ] && [ "$second" -le 31 ]; then
        return 0
      fi
      ;;
  esac
  return 1
}

# has_line LINES LINE: LINE is one of the lines.
has_line() {
  printf '%s\n' "$1" | grep -Fxq "$2"
}

# metadata PATH: one value from the metadata server; fails on a 404.
metadata() {
  curl -sS -f -H 'Metadata-Flavor: Google' "$METADATA/$1"
}

# as_doorman COMMAND: through the doorman user's login shell, as the guide
# does.
as_doorman() {
  sudo -iu doorman bash -c "$1"
}

# git_doorman ARGS: a git command in the repo, as its owner, output kept
# clean of a login shell's for capture.
git_doorman() {
  sudo -u doorman git -C "$REPO" "$@"
}

# installed PACKAGE: dpkg says so.
installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'
}

# node_is_24: node -v starts with v24.
node_is_24() {
  case $(node -v 2>/dev/null || true) in
    v24.*) return 0 ;;
  esac
  return 1
}

# cert_end: the chain's notAfter, as openssl prints it.
cert_end() {
  openssl x509 -noout -enddate -in "$TLS/fullchain.pem" | sed 's/^notAfter=//'
}

# door_state: active, activating, inactive, failed, ...
door_state() {
  systemctl is-active doorman || true
}

# door_log: the journal of the door's current run (its systemd invocation),
# so a line from an earlier boot is never read.
door_log() {
  journalctl "_SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value doorman || true)" --no-pager -o cat
}

# wait_door: up to ten seconds for the door to be active and to have
# printed its Registry boot line in its current run; sets REGISTRY_LINE. A
# "Registry failed" line ends the run with it.
wait_door() {
  waited=0
  REGISTRY_LINE=''
  while [ -z "$REGISTRY_LINE" ]; do
    REGISTRY_LINE=$(door_log | grep -E '^Registry ' | tail -n 1)
    if [ -n "$REGISTRY_LINE" ]; then
      break
    fi
    if [ "$waited" -ge 10 ]; then
      fail "the door is $(door_state) with no Registry line in 10 seconds; the last one in its journal: $(journalctl -u doorman -n 30 --no-pager -o cat | grep -E '^Registry ' | tail -n 1)"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  case $REGISTRY_LINE in
    'Registry failed'*) fail "$REGISTRY_LINE" ;;
  esac
  [ "$(door_state)" = active ] || fail "the door is $(door_state): journalctl -u doorman"
}

# health PORT: the door's health on PORT through nginx, up to ten seconds
# for an answer that is not nginx's 502; sets HEALTH_LINE and, from the
# JSON, HEALTH_HASH, HEALTH_ACTIVE and HEALTH_DAYS. 503 degraded with the
# worker null is the expected answer until the worker runs.
health() {
  port=$1
  waited=0
  while :; do
    code=$(curl -sk -o "$TMP/health-$port.json" -w '%{http_code}' "https://127.0.0.1:$port/health" || true)
    case $code in
      200|503) break ;;
    esac
    if [ "$waited" -ge 10 ]; then
      fail "port $port answers $code after 10 seconds (502 is nginx with no door behind it, 000 no answer at all): journalctl -u doorman"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  parsed=$(node -e 'const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const d = h.doorman || {}; const r = d.registry || {}; const c = d.certificate; console.log([h.status, String(r.hash || "").slice(0, 16), r.active, c ? c.daysLeft : "none", h.worker === null ? "null" : "present"].join("|"));' "$TMP/health-$port.json")
  health_ifs=$IFS
  IFS='|'
  set -- $parsed
  IFS=$health_ifs
  HEALTH_HASH=$2
  HEALTH_ACTIVE=$3
  HEALTH_DAYS=$4
  HEALTH_LINE="$port: $code $1 (worker $5)"
}

# door_check RESTARTED: the door's boot line and both health answers, after
# a restart in this run (RESTARTED 1) or as the door runs now (0); a door
# that is not running is restarted. Sets DOOR_LINE.
door_check() {
  if [ "$1" -eq 1 ]; then
    wait_door
    DOOR_LINE="door up, $REGISTRY_LINE"
  elif [ "$(door_state)" = active ]; then
    # A door up for weeks may have its boot line rotated out of the
    # journal; the health answer below carries the same facts.
    REGISTRY_LINE=$(door_log | grep -E '^Registry ' | tail -n 1)
    case $REGISTRY_LINE in
      'Registry failed'*) fail "$REGISTRY_LINE" ;;
      '') REGISTRY_LINE='boot line no longer in the journal' ;;
    esac
    DOOR_LINE="door already up, $REGISTRY_LINE"
  else
    was=$(door_state)
    systemctl restart doorman
    wait_door
    DOOR_LINE="door restarted (was $was), $REGISTRY_LINE"
  fi
  health 3000
  DOOR_LINE="$DOOR_LINE; $HEALTH_LINE"
  health 3200
  DOOR_LINE="$DOOR_LINE, $HEALTH_LINE"
}

# 0. The arguments: named flags, each given once, each checked for shape,
#    then against the machine files and the metadata server, before
#    anything is touched.
WORKER_IP=''
DOORMAN_IP=''
EMAIL=''
SEEN=''
while [ $# -gt 0 ]; do
  case $1 in
    --worker-ip|--doorman-ip|--email) ;;
    *) arg_fail "unknown flag \"$1\"; the flags are --worker-ip, --doorman-ip and --email" ;;
  esac
  [ $# -ge 2 ] || arg_fail "$1 needs a value"
  case " $SEEN " in
    *" $1 "*) arg_fail "$1 given twice" ;;
  esac
  SEEN="$SEEN $1"
  case $1 in
    --worker-ip) WORKER_IP=$2 ;;
    --doorman-ip) DOORMAN_IP=$2 ;;
    --email) EMAIL=$2 ;;
  esac
  shift 2
done
case " $SEEN " in
  *" --worker-ip "*)
    is_ipv4 "$WORKER_IP" || arg_fail "--worker-ip must be a dotted quad, four numbers 0 to 255, got \"$WORKER_IP\""
    is_private "$WORKER_IP" || arg_fail "--worker-ip must be in a private range (10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16): the worker has an internal IP only, got \"$WORKER_IP\""
    ;;
esac
case " $SEEN " in
  *" --doorman-ip "*)
    is_ipv4 "$DOORMAN_IP" || arg_fail "--doorman-ip must be a dotted quad, four numbers 0 to 255, got \"$DOORMAN_IP\""
    case $DOORMAN_IP in
      10.*|192.168.*|127.*) arg_fail "--doorman-ip must be a public address, got \"$DOORMAN_IP\"" ;;
      172.*) is_private "$DOORMAN_IP" && arg_fail "--doorman-ip must be a public address, got \"$DOORMAN_IP\"" ;;
    esac
    ;;
esac
case " $SEEN " in
  *" --email "*)
    matches "$EMAIL" '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || arg_fail "--email must be an address with one @ and a dot after it, got \"$EMAIL\""
    ;;
esac

# This VM, from the metadata server.
VM_NAME=$(metadata instance/name) || arg_fail 'cannot read the metadata server at 169.254.169.254: is this a Compute Engine VM?'
[ "$VM_NAME" = doorman ] || arg_fail "this VM is $VM_NAME, not the doorman"
VM_EXTERNAL_IP=$(metadata instance/network-interfaces/0/access-configs/0/external-ip || true)
[ -n "$VM_EXTERNAL_IP" ] || arg_fail 'this VM has no external IP; the doorman holds the static IP (step 1)'

# --worker-ip against .env, --doorman-ip against the VM, --email against
# acme.sh's account; a value left out is taken from there.
if [ -f "$REPO/.env" ]; then
  DISK_WORKER_IP=$(sed -n 's/^WORKER_IP=//p' "$REPO/.env" | head -n 1)
else
  DISK_WORKER_IP=''
fi
if [ -n "$WORKER_IP" ]; then
  if [ -n "$DISK_WORKER_IP" ] && [ "$WORKER_IP" != "$DISK_WORKER_IP" ]; then
    arg_fail "--worker-ip is $WORKER_IP, but $REPO/.env has WORKER_IP=$DISK_WORKER_IP"
  fi
elif [ -n "$DISK_WORKER_IP" ]; then
  WORKER_IP=$DISK_WORKER_IP
else
  arg_fail "--worker-ip is required until $REPO/.env exists: the worker VM's internal IP"
fi
if [ -n "$DOORMAN_IP" ]; then
  [ "$DOORMAN_IP" = "$VM_EXTERNAL_IP" ] || arg_fail "--doorman-ip is $DOORMAN_IP, but this VM's external IP is $VM_EXTERNAL_IP"
elif [ -s "$TLS/fullchain.pem" ]; then
  DOORMAN_IP=$VM_EXTERNAL_IP
else
  arg_fail "--doorman-ip is required until the certificate exists at $TLS/fullchain.pem: the doorman's static IP"
fi
if [ -n "$EMAIL" ]; then
  if [ -f "$ACME" ] && [ -f /root/.acme.sh/account.conf ]; then
    DISK_EMAIL=$(sed -n 's/^ACCOUNT_EMAIL=//p' /root/.acme.sh/account.conf | head -n 1 | tr -d "'\"")
    if [ -n "$DISK_EMAIL" ] && [ "$EMAIL" != "$DISK_EMAIL" ]; then
      arg_fail "--email is $EMAIL, but acme.sh was installed with $DISK_EMAIL"
    fi
  fi
elif [ ! -f "$ACME" ]; then
  arg_fail "--email is required until acme.sh is installed at $ACME: where Let's Encrypt writes about the certificate"
fi

TMP=$(mktemp -d)
if [ -d "$REPO/.git" ]; then
  REPO_EXISTED=1
else
  REPO_EXISTED=0
fi
# Whether any point of step 3 did work in this run, for the done line.
WORK=0

# 3.1 Look first: Debian 13 is required; unattended upgrades are reported.
at 3.1 look
DEBIAN=$(cat /etc/debian_version)
case $DEBIAN in
  13|13.*) ;;
  *) fail "this VM runs Debian $DEBIAN; the guide asks for Debian 13" ;;
esac
UPGRADES=$(systemctl is-active unattended-upgrades || true)
say "3.1 look: Debian $DEBIAN, unattended-upgrades $UPGRADES"

# 3.2 Packages: nginx, fail2ban, nftables and git from Debian 13, Node 24
#     from NodeSource.
at 3.2 packages
if node_is_24 && installed nginx && installed fail2ban && installed nftables && installed git; then
  PACKAGES=already
else
  apt-get update
  apt-get install -y nginx fail2ban nftables git curl
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$TMP/nodesource-setup.sh"
  bash "$TMP/nodesource-setup.sh"
  apt-get install -y nodejs
  node_is_24 || fail "node is \"$(node -v 2>&1 || true)\" after the install, not v24"
  PACKAGES=installed
  WORK=1
fi
NODE_V=$(node -v)
NGINX_V=$(/usr/sbin/nginx -v 2>&1 | sed 's/^nginx version: nginx\///')
say "3.2 packages: node $NODE_V, nginx $NGINX_V, fail2ban, nftables, git $PACKAGES"

# 3.3 The doorman user, the repo under its home, its dependencies, the one
#     machine value.
at 3.3 'user and repo'
if id doorman; then
  USER_LINE='doorman already'
else
  useradd --system --create-home --home-dir /opt/doorman --shell /bin/bash doorman
  USER_LINE='doorman created'
  WORK=1
fi
if [ -d "$REPO/.git" ]; then
  REPO_LINE='repo already'
else
  as_doorman "git clone https://github.com/Anosphere/anosvalidatornode.git $REPO"
  REPO_LINE='repo cloned'
  WORK=1
fi
if [ -d "$REPO/node_modules/express" ]; then
  NPM_LINE='npm ci already'
else
  as_doorman "cd $REPO && npm ci"
  NPM_LINE='npm ci run'
  WORK=1
fi
if [ -f "$REPO/.env" ]; then
  ENV_LINE=".env already (worker $WORKER_IP)"
else
  as_doorman "cd $REPO && npm run setup -- --worker-ip $WORKER_IP"
  ENV_LINE=".env written (worker $WORKER_IP)"
  WORK=1
fi
say "3.3 user and repo: $USER_LINE, $REPO_LINE, $NPM_LINE, $ENV_LINE"

# 3.4 System files, first pass: IP forwarding, the NAT and the egress
#     quota, the ACME webroot, nginx on port 80, fail2ban, the units. Run
#     when any of its products is missing. From here the worker has its
#     outbound path.
at 3.4 'system files, first pass'
missing_product() {
  for product in /etc/sysctl.d/90-doorman.conf /etc/nftables.conf /etc/nginx/sites-enabled/doorman-acme /etc/fail2ban/jail.d/doorman.conf /etc/systemd/system/doorman.service; do
    [ -e "$product" ] || return 0
  done
  return 1
}
if missing_product; then
  sh "$INSTALL"
  FIRST_PASS=installed
  WORK=1
else
  FIRST_PASS=already
fi
say "3.4 system files, first pass: $FIRST_PASS"

# 3.5 The certificate: acme.sh 3.1.6 from a git clone, Let's Encrypt, an
#     IP certificate on the shortlived profile, installed for nginx with
#     the reload command acme.sh's daily cron runs at every renewal.
at 3.5 certificate
if [ -s "$TLS/fullchain.pem" ]; then
  say "3.5 certificate: already, valid to $(cert_end)"
else
  if [ ! -f "$ACME" ]; then
    if [ ! -f /root/acme.sh-src/acme.sh ]; then
      git clone --depth 1 --branch 3.1.6 https://github.com/acmesh-official/acme.sh.git /root/acme.sh-src
    fi
    (cd /root/acme.sh-src && ./acme.sh --install -m "$EMAIL")
  fi
  "$ACME" --set-default-ca --server letsencrypt
  # Exit code 2 is acme.sh's "skipping, not due": a certificate issued by
  # an earlier run that stopped before the install step is in its store.
  issue_status=0
  "$ACME" --issue --server letsencrypt -d "$DOORMAN_IP" -w /var/www/acme --cert-profile shortlived --days 3 || issue_status=$?
  case $issue_status in
    0|2) ;;
    *) fail "acme.sh --issue for $DOORMAN_IP exited $issue_status" ;;
  esac
  "$ACME" --install-cert -d "$DOORMAN_IP" --ecc --key-file /etc/doorman/tls/key.pem --fullchain-file /etc/doorman/tls/fullchain.pem --reloadcmd "chmod 600 /etc/doorman/tls/key.pem && systemctl reload nginx"
  [ -s "$TLS/fullchain.pem" ] || fail "no certificate at $TLS/fullchain.pem after acme.sh --install-cert"
  WORK=1
  say "3.5 certificate: issued for $DOORMAN_IP, valid to $(cert_end)"
fi

# 3.6 System files, second pass, which installs the TLS site now that the
#     certificate exists and restarts the door; then the door's boot line
#     and both health answers.
at 3.6 'system files, second pass and the door'
if [ -e /etc/nginx/sites-enabled/doorman ]; then
  SECOND_PASS='TLS site already'
  RESTARTED=0
else
  RESTARTED=1
  sh "$INSTALL"
  SECOND_PASS='TLS site installed'
  WORK=1
fi
door_check "$RESTARTED"
say "3.6 system files, second pass and the door: $SECOND_PASS; $DOOR_LINE"

# 3.7 The certificate as the world sees it: curl connects to the local
#     port but checks the chain and the name against the IP in the URL.
at 3.7 'certificate as the world sees it'
WORLD=$(curl -sS -o /dev/null -w '%{http_code}' --connect-to "$DOORMAN_IP:3000:127.0.0.1:3000" "https://$DOORMAN_IP:3000/health") || fail "curl could not verify the certificate for $DOORMAN_IP"
[ "$WORLD" != 000 ] || fail "no answer for https://$DOORMAN_IP:3000/health through 127.0.0.1"
say "3.7 certificate as the world sees it: valid for $DOORMAN_IP to $(cert_end)"

# 9.2 Pull and restart, on every run after the first: a new registry row
#     or new software; npm ci when the lock file changed, the install
#     script when deploy/ or itself changed (it restarts the door), else
#     a plain restart. The guide's 11.2 is this same point.
HEAD_MOVED=0
if [ "$REPO_EXISTED" -eq 1 ]; then
  at 9.2 'pull and restart'
  OLD_HEAD=$(git_doorman rev-parse --short HEAD)
  as_doorman "git -C $REPO pull --ff-only"
  NEW_HEAD=$(git_doorman rev-parse --short HEAD)
  if [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
    HEAD_MOVED=1
    CHANGED=$(git_doorman diff --name-only "$OLD_HEAD" "$NEW_HEAD")
    PULL_LINE="Fast-forward to $NEW_HEAD"
    if has_line "$CHANGED" package-lock.json; then
      as_doorman "cd $REPO && npm ci"
      PULL_LINE="$PULL_LINE, npm ci run"
    fi
    if printf '%s\n' "$CHANGED" | grep -Eq '^(deploy/|scripts/install-system-files\.sh$)'; then
      sh "$INSTALL"
      PULL_LINE="$PULL_LINE, system files installed, restarted"
    else
      systemctl restart doorman
      PULL_LINE="$PULL_LINE, restarted"
    fi
    door_check 1
    say "9.2 pull and restart: $PULL_LINE; $DOOR_LINE"
  else
    say "9.2 pull and restart: already up to date ($NEW_HEAD); $REGISTRY_LINE"
  fi
fi

if [ "$HEAD_MOVED" -eq 1 ]; then
  say "done: doorman on registry $HEALTH_HASH, $HEALTH_ACTIVE active"
elif [ "$WORK" -eq 1 ]; then
  say "done: doorman for worker $WORKER_IP is up; the door answers 503 degraded until the worker runs (step 10)"
else
  say "done: nothing to do; registry $HEALTH_HASH, $HEALTH_ACTIVE active, certificate $HEALTH_DAYS days left"
fi
