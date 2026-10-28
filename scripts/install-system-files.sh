#!/bin/sh
# Puts every file of deploy/ in place on the doorman VM and starts or
# reloads what reads it: IP forwarding, nftables (the NAT and the egress
# quota), the ACME webroot and the TLS directory, nginx, fail2ban, and the
# three systemd units. Run as root from the repo root:
#
#   sudo sh scripts/install-system-files.sh
#
# Every step is safe to repeat. The TLS site is installed only once the
# certificate exists at /etc/doorman/tls, so the script runs twice at setup
# (before and after acme.sh issues it; README, "The doorman VM") and again
# after any pull that touched deploy/. It restarts the door itself at the
# end.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo sh scripts/install-system-files.sh" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$REPO/deploy"
if [ ! -d "$DEPLOY" ] || [ ! -f "$DEPLOY/doorman.service" ]; then
  echo "deploy/ not found at $DEPLOY; run this script from the doormansoftware checkout" >&2
  exit 1
fi

TLS=/etc/doorman/tls
ACCESS_LOG=/var/log/nginx/doorman-access.log

# 1. IP forwarding, for the worker's outbound path.
install -m 0644 "$DEPLOY/sysctl-doorman.conf" /etc/sysctl.d/90-doorman.conf
sysctl -q -p /etc/sysctl.d/90-doorman.conf

# 2. nftables: the NAT and the egress quota, loaded at boot and now.
install -m 0755 "$DEPLOY/nftables.conf" /etc/nftables.conf
systemctl enable --now nftables
nft -f /etc/nftables.conf

# 3. The ACME webroot and the TLS directory. The key file is created empty
#    and owner-only before any certificate exists, so acme.sh's key lands in
#    a file that is already 0600; the chain file is world-readable and is
#    what the door's health reads.
mkdir -p /var/www/acme/.well-known/acme-challenge "$TLS"
chmod 755 "$TLS"
if [ ! -e "$TLS/key.pem" ]; then
  touch "$TLS/key.pem"
  chmod 600 "$TLS/key.pem"
fi

# 4. nginx: Debian's default site goes; the port-80 site always; the TLS
#    site once both certificate files are non-empty. The access log the TLS
#    site declares is created now if it is missing, so fail2ban (step 5)
#    finds it on the first pass too.
rm -f /etc/nginx/sites-enabled/default
install -m 0644 "$DEPLOY/nginx/doorman-acme.conf" /etc/nginx/sites-available/doorman-acme
ln -sf /etc/nginx/sites-available/doorman-acme /etc/nginx/sites-enabled/doorman-acme
tls_site=installed
if [ -s "$TLS/fullchain.pem" ] && [ -s "$TLS/key.pem" ]; then
  install -m 0644 "$DEPLOY/nginx/doorman.conf" /etc/nginx/sites-available/doorman
  ln -sf /etc/nginx/sites-available/doorman /etc/nginx/sites-enabled/doorman
else
  tls_site=skipped
  echo "TLS site skipped: no certificate at $TLS yet; issue it, then run this script again"
fi
if [ ! -e "$ACCESS_LOG" ]; then
  touch "$ACCESS_LOG"
  chown root:adm "$ACCESS_LOG"
  chmod 640 "$ACCESS_LOG"
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# 5. fail2ban, after nginx so the access log exists.
install -m 0644 "$DEPLOY/fail2ban/doorman.conf" /etc/fail2ban/jail.d/doorman.conf
install -m 0644 "$DEPLOY/fail2ban/doorman-429.conf" /etc/fail2ban/filter.d/doorman-429.conf
systemctl enable --now fail2ban
fail2ban-client reload

# 6. The units: the door, and the monthly quota reset.
install -m 0644 "$DEPLOY/doorman.service" "$DEPLOY/doorman-quota-reset.service" "$DEPLOY/doorman-quota-reset.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now doorman-quota-reset.timer
systemctl enable doorman
systemctl restart doorman

# 7. What happened.
echo "Installed: /etc/sysctl.d/90-doorman.conf, /etc/nftables.conf, /var/www/acme, $TLS,"
echo "  nginx sites doorman-acme and doorman (TLS site: $tls_site),"
echo "  fail2ban jail doorman-429, units doorman.service, doorman-quota-reset.service and .timer."
echo "The door was restarted: journalctl -fu doorman"
if [ "$tls_site" = skipped ]; then
  echo "Next: issue the certificate (README, \"The doorman VM\", step 4), then run this script again."
fi
