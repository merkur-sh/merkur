#!/usr/bin/env bash
# Runs as root on the app host, fed over SSH by deploy-app-host.sh. Installs the signed
# deployment staged in /tmp/merkur-app-release, restarts the server, waits for it to log
# that it is serving, and prints what now runs as one JSON line.
set -euo pipefail
version="${1:?usage: install-app-release.sh <version>}"
case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a release version: $version" >&2; exit 1 ;;
esac
src=/tmp/merkur-app-release
# Secrets are provisioned once and never shipped; a host without them is unfinished.
test -s /etc/merkur/server.env
test -s /etc/merkur/data.env
test -s /etc/merkur/backup.env

install -m 0644 "$src/compose.yaml" /srv/app/compose.yaml
docker compose --project-directory /srv/app up --detach --remove-orphans --quiet-pull

# The unit binds the daemon release store; stage-daemon-release.sh filled it before this.
install -d -m 0755 /usr/local/lib/merkur/daemon-releases
root=/usr/local/lib/merkur/server
release="$root/$version"
staging="$root/.staging"
rm -rf "$staging"
install -d -m 0755 "$staging"
tar -xzf "$src/deployment.tar.gz" -C "$staging" --no-same-owner
# Normalize unsigned mode bits; only the server is executable.
find "$staging" -type d -exec chmod 0555 {} +
find "$staging" -type f -exec chmod 0444 {} +
chmod 0555 "$staging/server/server"
# A rerun of a release ships the same retained bytes, and the running server reads the
# installed copy, so that copy stays; a version whose bytes differ is refused.
if [ -e "$release" ]; then
  diff --recursive --brief "$staging" "$release"
  rm -rf "$staging"
else
  mv -T "$staging" "$release"
fi
ln -sfn "$version" "$root/.current.new"
mv -Tf "$root/.current.new" "$root/current"
install -m 0644 "$src/merkur-server.service" "$src/merkur-site.service" \
  "$src/merkur-backup@.service" "$src/merkur-backup@.timer" /etc/systemd/system/
install -m 0755 "$src/install-site" /usr/local/lib/merkur/install-site
install -m 0755 "$src/merkur-backup" /usr/local/lib/merkur/merkur-backup
install -m 0644 "$src/backup-recipient.txt" /usr/local/lib/merkur/backup-recipient.txt
systemctl daemon-reload
systemctl enable --quiet merkur-server merkur-site
systemctl enable --quiet --now merkur-backup@app.timer

since=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
systemctl restart merkur-server
# The server logs this once it listens; the bound only decides how long a broken
# start may take to be reported.
for attempt in $(seq 1 90); do
  journalctl --unit merkur-server --since "$since" --output cat | grep -q '"message":"server_started"' && break
  if systemctl is-failed --quiet merkur-server || [ "$attempt" = 90 ]; then
    echo 'merkur-server never logged server_started' >&2
    journalctl --unit merkur-server --since "$since" --output cat --lines 40 >&2
    exit 1
  fi
  sleep 1
done

rm -rf "$src"
# Keep the running release and the one before it, for a manual roll-forward fix.
find "$root" -maxdepth 1 -name 'v*' -type d | sort -V | head -n -2 | xargs -r rm -rf

printf '{"version":"%s","server":"%s","active":"%s"}\n' "$version" \
  "$(sha512sum "$root/current/server/server" | cut -d' ' -f1)" "$(systemctl is-active merkur-server)"
