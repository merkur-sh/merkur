#!/usr/bin/env bash
# Runs as root on a service host, fed over SSH by deploy-service-hosts.sh. Installs
# the release staged in /tmp/merkur-release, restarts the edge and STUN units, waits
# for each to log that it is serving, and prints what now runs as one JSON line.
set -euo pipefail
version="${1:?usage: install-service-release.sh <version>}"
case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a release version: $version" >&2; exit 1 ;;
esac
src=/tmp/merkur-release
# Secrets are provisioned once and never shipped; a host without them is unfinished.
test -s /etc/merkur/edge.secrets.env
test -s /etc/merkur/stun.secrets.env

release="/usr/local/lib/merkur/$version"
install -d -m 0755 "$release"
install -m 0755 "$src/merkur-edge" "$src/merkur-stun" "$release/"
install -m 0755 "$src/edge-egress-cap" /usr/local/lib/merkur/edge-egress-cap
for binary in merkur-edge merkur-stun; do
  ln -sfn "$release/$binary" "/usr/local/bin/.$binary.new"
  mv -Tf "/usr/local/bin/.$binary.new" "/usr/local/bin/$binary"
done
install -d -m 0700 /etc/merkur
install -m 0600 "$src/edge.env" "$src/stun.env" /etc/merkur/
install -m 0644 "$src/merkur-edge.service" "$src/merkur-stun.service" \
  "$src/merkur-stun-addrs.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet merkur-stun-addrs merkur-stun merkur-edge

since=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
systemctl restart merkur-stun-addrs merkur-stun merkur-edge

# Each service logs a line once it is serving; that line is the signal, and the
# bound only decides how long a broken start may take to be reported.
wait_for() {
  local unit="$1" line="$2"
  for _ in $(seq 1 90); do
    journalctl --unit "$unit" --since "$since" --output cat | grep -q "$line" && return 0
    systemctl is-failed --quiet "$unit" && break
    sleep 1
  done
  echo "$unit never logged: $line" >&2
  journalctl --unit "$unit" --since "$since" --output cat --lines 40 >&2
  exit 1
}
wait_for merkur-stun 'stun: listening'
wait_for merkur-edge 'registration established'

rm -rf "$src"
# Keep the running release and the one before it, for a manual roll-forward fix.
find /usr/local/lib/merkur -maxdepth 1 -name 'v*' -type d | sort -V | head -n -2 | xargs -r rm -rf

digest() { sha512sum "$(readlink -f "/usr/local/bin/$1")" | cut -d' ' -f1; }
printf '{"version":"%s","merkur-edge":"%s","merkur-stun":"%s","active":{"merkur-edge":"%s","merkur-stun":"%s"}}\n' \
  "$version" "$(digest merkur-edge)" "$(digest merkur-stun)" \
  "$(systemctl is-active merkur-edge)" "$(systemctl is-active merkur-stun)"
