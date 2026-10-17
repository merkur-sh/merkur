#!/usr/bin/env bash
# The only command the site deploy key may run on the app host. install-app-release.sh
# installs it as /usr/local/lib/merkur/install-site, and the key's authorized_keys entry
# forces it (`restrict,command="/usr/local/lib/merkur/install-site"`), so the `site`
# environment can replace the website and nothing else: the release, not the site
# deploy, decides what this script does.
#
# Reads the site deployment tarball (`site-server` and `dist/`) on stdin, the commit it
# was built from as the SSH command, installs it, restarts the site, waits for it to log
# that it is serving, and prints what now runs as one JSON line.
set -euo pipefail
commit="${SSH_ORIGINAL_COMMAND:-}"
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'usage: ssh <app host> <commit> < site-deployment.tar.gz' >&2
  exit 1
fi

root=/usr/local/lib/merkur/site
release="$root/$commit"
staging="$root/.staging"
rm -rf "$staging"
install -d -m 0755 "$staging"
tar -xzf - -C "$staging" --no-same-owner
test -f "$staging/site-server" && test -d "$staging/dist"
# Root-owned and read-only; only the executable carries an execute bit.
find "$staging" -type d -exec chmod 0555 {} +
find "$staging" -type f -exec chmod 0444 {} +
chmod 0555 "$staging/site-server"
# A commit's site is built once; deploying it again must ship the same bytes.
if [ -e "$release" ]; then
  diff --recursive --brief "$staging" "$release"
  rm -rf "$staging"
else
  mv -T "$staging" "$release"
fi
ln -sfn "$commit" "$root/.current.new"
mv -Tf "$root/.current.new" "$root/current"

since=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
systemctl restart merkur-site
for attempt in $(seq 1 30); do
  journalctl --unit merkur-site --since "$since" --output cat | grep -q '"message":"site_server_started"' && break
  if systemctl is-failed --quiet merkur-site || [ "$attempt" = 30 ]; then
    echo 'merkur-site never logged site_server_started' >&2
    journalctl --unit merkur-site --since "$since" --output cat --lines 40 >&2
    exit 1
  fi
  sleep 1
done

# Keep the running site and the one before it.
current=$(readlink "$root/current")
find "$root" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' -printf '%T@ %f\n' | sort -n \
  | awk -v current="$current" '$2 != current {print $2}' | head -n -1 | sed "s#^#$root/#" \
  | xargs -r rm -rf

printf '{"commit":"%s","site-server":"%s","active":"%s"}\n' "$commit" \
  "$(sha512sum "$release/site-server" | cut -d' ' -f1)" "$(systemctl is-active merkur-site)"
