#!/bin/sh
# Prepares an operator's Google Cloud project for the two VMs of a
# validator: the operator guide's step 2 (the network) and step 5 (Cloud
# KMS), point by point, one line printed per point. Runs in Cloud Shell, as
# the operator, with the project set first; every value is a flag and
# nothing is asked:
#
#   gcloud config set project <project id> && curl -fsSLO https://raw.githubusercontent.com/Anosphere/anosvalidatornode/main/scripts/bootstrap-project.sh && sh bootstrap-project.sh --zone <zone> --doorman-ip <doorman static ip> --id <N>
#
# Safe to run again: every point does what is still missing and answers
# "already" for what is done. All three flags are required on every run.
# Everything the commands print goes to ./bootstrap-project.log; the screen
# gets one line per point, the values the next lines need, and a last line:
# "done: ..." or "failed at step <number> (<name>): see ./bootstrap-project.log".
# Nothing here reads or prints a key.
set -eu

SCRIPT=bootstrap-project.sh
LOG=./bootstrap-project.log

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
# prints the failure line.
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

# is_private VALUE: in 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 127.0.0.0/8.
is_private() {
  case $1 in
    10.*|192.168.*|127.*) return 0 ;;
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

# has_item LIST ITEM: ITEM is one of the semicolon-separated items gcloud's
# value() format prints for a list field (tags, scopes).
has_item() {
  case ";$1;" in
    *";$2;"*) return 0 ;;
  esac
  return 1
}

# has_line LINES LINE: LINE is one of the lines.
has_line() {
  printf '%s\n' "$1" | grep -Fxq "$2"
}

# vm_value VM FIELD: one field of the VM, as gcloud's value() format prints it.
vm_value() {
  gcloud compute instances describe "$1" --zone "$ZONE" --format="value($2)"
}

# rules_of_default: the names of the firewall rules of the default network,
# one per line, sorted.
rules_of_default() {
  gcloud compute firewall-rules list --filter='network ~ /networks/default$' --format='value(name)' | sort
}

# 0. The arguments: named flags, each given once, each checked for shape
#    before anything is touched.
ZONE=''
DOORMAN_IP=''
ID=''
SEEN=''
while [ $# -gt 0 ]; do
  case $1 in
    --zone|--doorman-ip|--id) ;;
    *) arg_fail "unknown flag \"$1\"; the flags are --zone, --doorman-ip and --id" ;;
  esac
  [ $# -ge 2 ] || arg_fail "$1 needs a value"
  case " $SEEN " in
    *" $1 "*) arg_fail "$1 given twice" ;;
  esac
  SEEN="$SEEN $1"
  case $1 in
    --zone) ZONE=$2 ;;
    --doorman-ip) DOORMAN_IP=$2 ;;
    --id) ID=$2 ;;
  esac
  shift 2
done
for flag in --zone --doorman-ip --id; do
  case " $SEEN " in
    *" $flag "*) ;;
    *) arg_fail "$flag is required on every run" ;;
  esac
done
matches "$ZONE" '^[a-z]+-[a-z0-9]+-[a-z]$' || arg_fail "--zone must look like us-east1-b, got \"$ZONE\""
REGION=${ZONE%-*}
is_ipv4 "$DOORMAN_IP" || arg_fail "--doorman-ip must be a dotted quad, four numbers 0 to 255, got \"$DOORMAN_IP\""
if is_private "$DOORMAN_IP"; then
  arg_fail "--doorman-ip must be a public address, not one in 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 127.0.0.0/8, got \"$DOORMAN_IP\""
fi
matches "$ID" '^[1-9][0-9]*$' || arg_fail "--id must be a positive integer with no leading zero, got \"$ID\""

# The project gcloud is set to, and the two VMs, before anything changes.
PROJECT=$(gcloud config get-value project || true)
[ -n "$PROJECT" ] || arg_fail 'no project set: run gcloud config set project <project id> first'
DOORMAN_NAT=$(vm_value doorman 'networkInterfaces[0].accessConfigs[0].natIP') || arg_fail "no VM named doorman in zone $ZONE"
WORKER_NAT=$(vm_value worker 'networkInterfaces[0].accessConfigs[0].natIP') || arg_fail "no VM named worker in zone $ZONE"
[ "$DOORMAN_NAT" = "$DOORMAN_IP" ] || arg_fail "--doorman-ip is $DOORMAN_IP, but the doorman VM's external IP is \"$DOORMAN_NAT\""
[ -z "$WORKER_NAT" ] || arg_fail "the worker has an external IP $WORKER_NAT; the worker must have none (step 1)"

TMP=$(mktemp -d)

# 2.1 The project.
at 2.1 project
say "2.1 project: $PROJECT"

# 2.2 Look first: the state of the project, read once into variables and
#     written to the log in full. Nothing changes here.
at 2.2 look
echo '--- reserved addresses ---'
gcloud compute addresses list
echo '--- doorman: ip forwarding, tags ---'
DOORMAN_FORWARDING=$(vm_value doorman canIpForward)
DOORMAN_TAGS=$(vm_value doorman tags.items)
echo "$DOORMAN_FORWARDING $DOORMAN_TAGS"
echo '--- worker: internal IP, tags ---'
WORKER_IP=$(vm_value worker 'networkInterfaces[0].networkIP')
WORKER_TAGS=$(vm_value worker tags.items)
echo "$WORKER_IP $WORKER_TAGS"
echo '--- worker: service account and scopes ---'
SA=$(vm_value worker 'serviceAccounts[0].email')
SCOPES=$(vm_value worker 'serviceAccounts[0].scopes')
echo "$SA $SCOPES"
[ -n "$WORKER_IP" ] || fail 'the worker has no internal IP'
[ -n "$SA" ] || fail 'the worker has no service account; the keyholder needs one for Cloud KMS (step 5)'
echo '--- firewall rules of the default network ---'
gcloud compute firewall-rules list --filter='network ~ /networks/default$' --format='table(name,sourceRanges.list(),sourceTags.list(),targetTags.list(),allowed[].map().firewall_rule().list())'
RULES=$(rules_of_default)
echo '--- routes to the internet ---'
gcloud compute routes list --filter='destRange=0.0.0.0/0' --format='table(name,destRange,nextHopGateway.basename(),nextHopInstance.basename(),priority,tags.list())'
say "2.2 look: worker internal IP $WORKER_IP, service account $SA"

# 2.3 The doorman's external IP is a reserved static address.
at 2.3 'static IP'
RESERVED=$(gcloud compute addresses list --filter="address=$DOORMAN_IP" --format='value(name)')
if [ -n "$RESERVED" ]; then
  say "2.3 static IP: $DOORMAN_IP already reserved ($RESERVED)"
else
  gcloud compute addresses create doorman-ip --region "$REGION" --addresses "$DOORMAN_IP" --quiet
  say "2.3 static IP: $DOORMAN_IP reserved as doorman-ip"
fi

# 2.4 IP forwarding on the doorman: export, flip canIpForward in a copy,
#     apply at refresh level, no stop.
at 2.4 'IP forwarding on doorman'
if [ "$DOORMAN_FORWARDING" = True ]; then
  say '2.4 IP forwarding on doorman: already on'
else
  gcloud compute instances export doorman --zone "$ZONE" --destination "$TMP/doorman.yaml"
  sed 's/^canIpForward: false/canIpForward: true/' "$TMP/doorman.yaml" > "$TMP/doorman-forwarding.yaml"
  gcloud compute instances update-from-file doorman --zone "$ZONE" --source "$TMP/doorman-forwarding.yaml" --most-disruptive-allowed-action REFRESH --quiet
  DOORMAN_FORWARDING=$(vm_value doorman canIpForward)
  [ "$DOORMAN_FORWARDING" = True ] || fail "IP forwarding on the doorman is still $DOORMAN_FORWARDING after the update"
  say '2.4 IP forwarding on doorman: switched on'
fi

# 2.5 Network tags, which the firewall rules and the route select by.
at 2.5 tags
if has_item "$DOORMAN_TAGS" doorman; then
  DOORMAN_TAGGED='doorman already tagged'
else
  gcloud compute instances add-tags doorman --zone "$ZONE" --tags doorman --quiet
  DOORMAN_TAGGED='doorman tagged'
fi
if has_item "$WORKER_TAGS" worker; then
  WORKER_TAGGED='worker already tagged'
else
  gcloud compute instances add-tags worker --zone "$ZONE" --tags worker --quiet
  WORKER_TAGGED='worker tagged'
fi
say "2.5 tags: $DOORMAN_TAGGED, $WORKER_TAGGED"

# 2.6 Firewall: the four rules of ours, each created when missing, then
#     every other rule of the default network deleted, in one delete.
at 2.6 firewall
FIREWALL=''
rule() {
  rule_name=$1
  shift
  if has_line "$RULES" "$rule_name"; then
    FIREWALL="$FIREWALL, $rule_name already"
  else
    gcloud compute firewall-rules create "$rule_name" --network default --direction INGRESS "$@" --quiet
    FIREWALL="$FIREWALL, $rule_name created"
  fi
}
rule doorman-public --allow tcp:80,tcp:3000,tcp:3200 --source-ranges 0.0.0.0/0 --target-tags doorman
rule iap-ssh --allow tcp:22 --source-ranges 35.235.240.0/20 --target-tags doorman,worker
rule worker-to-doorman --allow all --source-tags worker --target-tags doorman
rule doorman-to-worker --allow tcp:3000,tcp:3200 --source-tags doorman --target-tags worker
FIREWALL=${FIREWALL#, }
OTHERS=''
DELETED=''
for rule_name in $RULES; do
  case $rule_name in
    doorman-public|iap-ssh|worker-to-doorman|doorman-to-worker) ;;
    *)
      OTHERS="$OTHERS $rule_name"
      DELETED="$DELETED, $rule_name"
      ;;
  esac
done
if [ -n "$OTHERS" ]; then
  gcloud compute firewall-rules delete $OTHERS --quiet
  say "2.6 firewall: $FIREWALL; deleted ${DELETED#, }"
else
  say "2.6 firewall: $FIREWALL; no other rules"
fi

# 2.7 The worker's route to the internet, through the doorman.
at 2.7 'route worker-egress'
if gcloud compute routes describe worker-egress --format='value(name)'; then
  say '2.7 route worker-egress: already'
else
  gcloud compute routes create worker-egress --network default --destination-range 0.0.0.0/0 --next-hop-instance doorman --next-hop-instance-zone "$ZONE" --priority 900 --tags worker --quiet
  say '2.7 route worker-egress: created'
fi

# 2.8 The cloud-platform scope on the worker's service account, for Cloud
#     KMS: the worker stopped, the scope set, the worker started.
at 2.8 'scope cloud-platform on worker'
if has_item "$SCOPES" https://www.googleapis.com/auth/cloud-platform; then
  say '2.8 scope cloud-platform on worker: already'
else
  gcloud compute instances stop worker --zone "$ZONE" --quiet
  gcloud compute instances set-service-account worker --zone "$ZONE" --service-account "$SA" --scopes cloud-platform --quiet
  gcloud compute instances start worker --zone "$ZONE" --quiet
  WORKER_IP=$(vm_value worker 'networkInterfaces[0].networkIP')
  say "2.8 scope cloud-platform on worker: set (worker stopped and started, internal IP $WORKER_IP)"
fi

# 2.9 Look again: everything step 2 decides on, read back; anything that
#     differs ends the run naming it.
at 2.9 'look again'
DIFF=''
differs() {
  DIFF="$DIFF; $*"
}
DOORMAN_FORWARDING=$(vm_value doorman canIpForward)
DOORMAN_TAGS=$(vm_value doorman tags.items)
WORKER_TAGS=$(vm_value worker tags.items)
SCOPES=$(vm_value worker 'serviceAccounts[0].scopes')
echo "--- doorman: forwarding, tags --- $DOORMAN_FORWARDING $DOORMAN_TAGS"
echo "--- worker: tags, scopes --- $WORKER_TAGS $SCOPES"
[ "$DOORMAN_FORWARDING" = True ] || differs "doorman: IP forwarding is $DOORMAN_FORWARDING, not True"
has_item "$DOORMAN_TAGS" doorman || differs "doorman: tags are \"$DOORMAN_TAGS\", no doorman tag"
has_item "$WORKER_TAGS" worker || differs "worker: tags are \"$WORKER_TAGS\", no worker tag"
has_item "$SCOPES" https://www.googleapis.com/auth/cloud-platform || differs "worker: scopes are \"$SCOPES\", no cloud-platform"
ROUTE=$(gcloud compute routes describe worker-egress --format='value(destRange,nextHopInstance.basename(),priority,tags)' | tr '\t' ' ')
echo "--- route --- $ROUTE"
[ "$ROUTE" = '0.0.0.0/0 doorman 900 worker' ] || differs "route worker-egress is \"$ROUTE\", not \"0.0.0.0/0 doorman 900 worker\""
echo '--- firewall rules of the default network ---'
gcloud compute firewall-rules list --filter='network ~ /networks/default$' --format='table(name,sourceRanges.list(),sourceTags.list(),targetTags.list(),allowed[].map().firewall_rule().list())'
RULES=$(rules_of_default)
EXPECTED_RULES='doorman-public
doorman-to-worker
iap-ssh
worker-to-doorman'
[ "$RULES" = "$EXPECTED_RULES" ] || differs "firewall rules of the default network are $(printf '%s' "$RULES" | tr '\n' ' '), not exactly doorman-public doorman-to-worker iap-ssh worker-to-doorman"
if [ -n "$DIFF" ]; then
  fail "look again: ${DIFF#; }"
fi
say '2.9 look again: ok'

# 2.10 Cloud Shell's SSH key, made now so the first gcloud compute ssh asks
#      nothing.
at 2.10 'ssh key'
SSH_KEY="${HOME:?HOME is not set}/.ssh/google_compute_engine"
if [ -f "$SSH_KEY" ]; then
  say '2.10 ssh key: already'
else
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  ssh-keygen -q -t rsa -b 3072 -N '' -f "$SSH_KEY"
  say '2.10 ssh key: made'
fi

# 2.11 The budget is a Console page.
at 2.11 budget
say '2.11 budget: a Console page, not done here (Billing, Budgets & alerts, Create budget, alerts at 50, 90 and 100 percent)'

# 5.2 Cloud KMS: the API.
at 5.2 'KMS API'
if [ -n "$(gcloud services list --enabled --filter='config.name=cloudkms.googleapis.com' --format='value(config.name)')" ]; then
  say '5.2 KMS API: already enabled'
else
  gcloud services enable cloudkms.googleapis.com --quiet
  say '5.2 KMS API: enabled'
fi

# 5.2 The key ring, in the VM's region. Right after the API is enabled the
#     first call may fail for a few seconds: up to six tries, five seconds
#     apart.
at 5.2 'key ring anos-testnet'
RING=''
try=1
while [ -z "$RING" ]; do
  if gcloud kms keyrings describe anos-testnet --location "$REGION"; then
    RING=already
  elif gcloud kms keyrings create anos-testnet --location "$REGION" --quiet; then
    RING=created
  elif [ "$try" -ge 6 ]; then
    fail "key ring anos-testnet in $REGION: neither found nor created after $try tries"
  else
    try=$((try + 1))
    sleep 5
  fi
done
say "5.2 key ring anos-testnet in $REGION: $RING"

# 5.2 The key: symmetric encryption, protection level HSM.
at 5.2 "key keyholder-$ID"
KEY_DESC=$(gcloud kms keys describe "keyholder-$ID" --location "$REGION" --keyring anos-testnet --format='value(purpose,versionTemplate.protectionLevel)' | tr '\t' ' ' || true)
case $KEY_DESC in
  '')
    gcloud kms keys create "keyholder-$ID" --location "$REGION" --keyring anos-testnet --purpose encryption --protection-level hsm --quiet
    say "5.2 key keyholder-$ID: created (HSM)"
    ;;
  'ENCRYPT_DECRYPT HSM')
    say "5.2 key keyholder-$ID: already (HSM)"
    ;;
  *)
    fail "key keyholder-$ID in $REGION is \"$KEY_DESC\", not ENCRYPT_DECRYPT HSM: the keyholder needs a symmetric HSM key under that name"
    ;;
esac

# 5.2 The worker's permission on the key, set on every run: the binding is
#     idempotent.
at 5.2 binding
gcloud kms keys add-iam-policy-binding "keyholder-$ID" --location "$REGION" --keyring anos-testnet --member "serviceAccount:$SA" --role roles/cloudkms.cryptoKeyEncrypterDecrypter --quiet
say "5.2 binding: roles/cloudkms.cryptoKeyEncrypterDecrypter for $SA"

# 5.3 Look again: the key as kms keys list prints it, which is the
#     KMS_KEY_NAME the worker script assembles the same way.
at 5.3 'KMS key'
KMS_KEY_NAME="projects/$PROJECT/locations/$REGION/keyRings/anos-testnet/cryptoKeys/keyholder-$ID"
LISTED=$(gcloud kms keys list --location "$REGION" --keyring anos-testnet --format='value(name)')
echo "$LISTED"
has_line "$LISTED" "$KMS_KEY_NAME" || fail "kms keys list does not show $KMS_KEY_NAME"
say "5.3 KMS key: $KMS_KEY_NAME"

# What leaves this script, and the next lines.
say 'Values for the next lines:'
say "  worker internal IP      $WORKER_IP"
say "  worker service account  $SA"
say "  KMS key                 $KMS_KEY_NAME"
say 'Next: SSH to the doorman, then the doorman line (the operator guide, A4):'
say "  gcloud compute ssh banker@doorman --zone $ZONE --tunnel-through-iap"
say "  curl -fsSLO https://raw.githubusercontent.com/Anosphere/anosvalidatornode/main/scripts/bootstrap-doorman.sh && sudo sh bootstrap-doorman.sh --worker-ip $WORKER_IP --doorman-ip $DOORMAN_IP --email <your email>"
say "done: project $PROJECT is ready for the doorman (step 3) and the worker (step 4)"
