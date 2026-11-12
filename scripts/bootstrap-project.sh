#!/bin/sh
# Prepares an operator's Google Cloud project for the two VMs of a
# validator: the operator guide's step 2 (the network and the worker's
# disk), step 5 (Cloud KMS), step 12 (the worker's backups), step 13 (the
# bucket for the key files) and step 14 (the budget), point by point, one
# line printed per point. Runs in Cloud Shell, as the operator, with the
# project set first; every value is a flag and nothing is asked:
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

# 2.11 The budget is made at the end of this run, point 14.1.
at 2.11 budget
say '2.11 budget: made at the end of this run, point 14.1'

# 2.12 The worker's boot disk: 50 GB. A smaller disk is grown, which loses
#      nothing and cannot be undone, and the worker is stopped and started
#      so that Debian takes the new space as it boots. A worker that is not
#      running is started, so a run that ended between the stop and the
#      start is mended by the next one.
at 2.12 'worker disk'
WORKER_DISK=$(vm_value worker 'disks[0].source.basename()')
[ -n "$WORKER_DISK" ] || fail 'the worker has no boot disk'
DISK_GB=$(gcloud compute disks describe "$WORKER_DISK" --zone "$ZONE" --format='value(sizeGb)')
matches "$DISK_GB" '^[0-9]+$' || fail "the size of the disk $WORKER_DISK reads \"$DISK_GB\", not a number of GB"
if [ "$DISK_GB" -ge 50 ]; then
  DISK_LINE="already $DISK_GB GB"
  STOPPED=''
else
  gcloud compute disks resize "$WORKER_DISK" --zone "$ZONE" --size 50 --quiet
  gcloud compute instances stop worker --zone "$ZONE" --quiet
  DISK_LINE="grown from $DISK_GB GB to 50 GB"
  STOPPED='stopped and '
fi
if [ "$(vm_value worker status)" = RUNNING ]; then
  say "2.12 worker disk: $DISK_LINE"
else
  gcloud compute instances start worker --zone "$ZONE" --quiet
  WORKER_IP=$(vm_value worker 'networkInterfaces[0].networkIP')
  say "2.12 worker disk: $DISK_LINE; worker ${STOPPED}started (internal IP $WORKER_IP)"
fi

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

# 12.1 Backups of the worker, by Google's Backup and DR service: the API.
at 12.1 'Backup and DR API'
if [ -n "$(gcloud services list --enabled --filter='config.name=backupdr.googleapis.com' --format='value(config.name)')" ]; then
  say '12.1 Backup and DR API: already enabled'
else
  gcloud services enable backupdr.googleapis.com --quiet
  say '12.1 Backup and DR API: enabled'
fi

# 12.2 The vault, in the worker's region: every backup kept at least 14
#      days, this project only, the 14 days locked from seven days after
#      today. Right after the API is enabled the first call may fail for a
#      few seconds: up to six tries, five seconds apart.
at 12.2 'vault worker-vault'
LOCK_DATE=$(date -u -d '+7 days' +%Y-%m-%d 2>/dev/null || date -u -v+7d +%Y-%m-%d)
matches "$LOCK_DATE" '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || fail "the lock date reads \"$LOCK_DATE\", not a date like 2026-11-20"
VAULT=''
try=1
while [ -z "$VAULT" ]; do
  if gcloud backup-dr backup-vaults describe worker-vault --location "$REGION"; then
    VAULT=already
  elif gcloud backup-dr backup-vaults create worker-vault --location "$REGION" --backup-min-enforced-retention p14d --access-restriction within-project --effective-time "$LOCK_DATE" --description 'the worker disk, every 4 hours, kept 14 days' --no-async; then
    VAULT="created, the 14 days locked from $LOCK_DATE"
  elif [ "$try" -ge 6 ]; then
    fail "vault worker-vault in $REGION: neither found nor created after $try tries"
  else
    try=$((try + 1))
    sleep 5
  fi
done
say "12.2 vault worker-vault in $REGION: $VAULT"

# 12.3 The plan: a backup every 4 hours around the clock, each kept 14 days.
at 12.3 'plan worker-plan'
if gcloud backup-dr backup-plans describe worker-plan --location "$REGION"; then
  say '12.3 plan worker-plan: already'
else
  gcloud backup-dr backup-plans create worker-plan --location "$REGION" --resource-type compute.googleapis.com/Instance --backup-vault worker-vault --backup-rule rule-id=worker-rule,recurrence=HOURLY,hourly-frequency=4,time-zone=UTC,backup-window-start=0,backup-window-end=23,retention-days=14 --no-async
  say '12.3 plan worker-plan: created, a backup every 4 hours, kept 14 days'
fi

# 12.4 The plan attached to the worker VM.
at 12.4 'association worker-association'
if gcloud backup-dr backup-plan-associations describe worker-association --location "$REGION"; then
  say '12.4 association worker-association: already'
else
  gcloud backup-dr backup-plan-associations create worker-association --location "$REGION" --workload-project "$PROJECT" --backup-plan worker-plan --resource "projects/$PROJECT/zones/$ZONE/instances/worker" --resource-type compute.googleapis.com/Instance --no-async
  say '12.4 association worker-association: created, the first backup within 4 hours'
fi

# 12.5 Look again: the attachment's state, its plan and its VM. Google may
#      need a moment to take a new attachment: up to two minutes for the
#      state ACTIVE, then the run ends naming the state it found.
at 12.5 'look again'
try=1
while :; do
  ASSOCIATION=$(gcloud backup-dr backup-plan-associations describe worker-association --location "$REGION" --format='value(state,backupPlan.basename(),resource.basename())' | tr '\t' ' ')
  if [ "${ASSOCIATION%% *}" = ACTIVE ]; then
    break
  fi
  if [ "$try" -ge 24 ]; then
    fail "the association worker-association is \"$ASSOCIATION\", not ACTIVE"
  fi
  try=$((try + 1))
  sleep 5
done
say "12.5 look again: $ASSOCIATION"

# 13.1 The bucket for the keyholder GUI's key files: in the worker's
#      region, closed to the public, every file kept 365 days.
at 13.1 "bucket $PROJECT-key-backup"
BUCKET="gs://$PROJECT-key-backup"
if gcloud storage buckets describe "$BUCKET"; then
  say "13.1 bucket $PROJECT-key-backup: already"
else
  gcloud storage buckets create "$BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention --retention-period 365d
  say "13.1 bucket $PROJECT-key-backup: created in $REGION, every file kept 365 days"
fi

# 13.2 The 365 days locked, which cannot be undone: from then on nobody can
#      shorten them or take them off the bucket. gcloud asks before it locks
#      and takes no for an answer under --quiet, so the yes is piped in.
at 13.2 'bucket lock'
# bucket_locked: the bucket's description says its retention is locked.
bucket_locked() {
  gcloud storage buckets describe "$BUCKET" --format=json | grep -q '"isLocked": true'
}
if bucket_locked; then
  say '13.2 bucket lock: already locked'
else
  printf 'y\n' | gcloud storage buckets update "$BUCKET" --lock-retention-period
  say '13.2 bucket lock: locked'
fi

# 13.3 Look again: the lock, read back.
at 13.3 'look again'
bucket_locked || fail "the 365 days of $BUCKET are not locked: paste gcloud storage buckets update $BUCKET --lock-retention-period and answer y"
say "13.3 look again: $PROJECT-key-backup is locked"

# 14.1 The budget: 100 USD a month for this project, or about that much in
#      the billing account's own currency, with email alerts at 90 and 100
#      percent of it. Visibility, not a cap. This point never ends the run:
#      when the budget cannot be made here the line says so and names the
#      Console page, and the log holds the reason.
at 14.1 budget
BUDGET_NAME="anos validator $PROJECT"
# budget_amount CURRENCY: about 100 USD in that currency; nothing for a
# currency that is not listed.
budget_amount() {
  case $1 in
    USD) echo 100 ;;
    THB) echo 3500 ;;
    EUR) echo 90 ;;
    GBP) echo 80 ;;
    CAD) echo 140 ;;
    AUD) echo 150 ;;
    SGD) echo 135 ;;
    JPY) echo 15000 ;;
  esac
}
# make_budget: sets BUDGET_LINE and returns 0 when the budget is there or
# was made; returns 1 otherwise, the reason in the log.
make_budget() {
  gcloud services enable cloudbilling.googleapis.com billingbudgets.googleapis.com --quiet || return 1
  billing=$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)') || return 1
  billing=${billing#billingAccounts/}
  if [ -z "$billing" ]; then
    echo 'the project has no billing account'
    return 1
  fi
  currency=$(gcloud billing accounts describe "$billing" --format='value(currencyCode)') || return 1
  amount=$(budget_amount "$currency")
  if [ -z "$amount" ]; then
    echo "no budget amount is listed for the currency \"$currency\""
    return 1
  fi
  try=1
  until budgets=$(gcloud billing budgets list --billing-account "$billing" --format='value(displayName)'); do
    if [ "$try" -ge 6 ]; then
      return 1
    fi
    try=$((try + 1))
    sleep 5
  done
  if has_line "$budgets" "$BUDGET_NAME"; then
    BUDGET_LINE=already
    return 0
  fi
  gcloud billing budgets create --billing-account "$billing" --display-name "$BUDGET_NAME" --budget-amount "$amount$currency" --calendar-period month --filter-projects "projects/$PROJECT" --threshold-rule percent=0.9 --threshold-rule percent=1.0 || return 1
  BUDGET_LINE="made, $amount $currency a month, alerts at 90 and 100 percent"
}
if make_budget; then
  say "14.1 budget: $BUDGET_LINE"
else
  say '14.1 budget: not made here; make it on the Console page (Billing, Budgets & alerts, Create budget: 100 USD a month for this project, alerts at 90 and 100 percent)'
fi

# What leaves this script, and the next lines.
say 'Values for the next lines:'
say "  worker internal IP      $WORKER_IP"
say "  worker service account  $SA"
say "  KMS key                 $KMS_KEY_NAME"
say 'Next: SSH to the doorman, then the doorman line (the operator guide, A4):'
say "  gcloud compute ssh banker@doorman --zone $ZONE --tunnel-through-iap"
say "  curl -fsSLO https://raw.githubusercontent.com/Anosphere/anosvalidatornode/main/scripts/bootstrap-doorman.sh && sudo sh bootstrap-doorman.sh --worker-ip $WORKER_IP --doorman-ip $DOORMAN_IP --email <your email>"
say "done: project $PROJECT is ready for the doorman (step 3) and the worker (step 4); the worker's backups (step 12) and the key bucket (step 13) are set up"
