#!/usr/bin/env bash
# Runs as root on the app host, fed over SSH by stage-daemon-release.sh. Checks the staged
# daemon archives against their signed manifest's sizes and digests, then publishes the
# release into the store with one rename, so the server's watcher only ever sees it whole.
# The store keeps the newest three releases: the one before, the running one and the next.
set -euo pipefail
version="${1:?usage: install-daemon-release.sh <version>}"
case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a release version: $version" >&2; exit 1 ;;
esac
src=/tmp/merkur-daemon-release
store=/usr/local/lib/merkur/daemon-releases
install -d -m 0755 "$store"
if [ -e "$store/$version" ]; then
  # A rerun of a release ships the same retained bytes; a version whose bytes differ is refused.
  diff --recursive --brief "$src" "$store/$version"
  rm -rf "$src"
  exit 0
fi
python3 - "$src" <<'CHECK'
import hashlib, json, os, sys
directory = sys.argv[1]
manifest = json.load(open(os.path.join(directory, 'merkur-release.json')))
for artifact in manifest['artifacts']:
    with open(os.path.join(directory, artifact['name']), 'rb') as archive:
        data = archive.read()
    assert len(data) == artifact['size'], f"{artifact['name']}: size"
    assert hashlib.sha512(data).hexdigest() == artifact['sha512'], f"{artifact['name']}: digest"
CHECK
incoming="$store/.incoming"
rm -rf "$incoming"
install -d -m 0755 "$incoming"
cp "$src"/merkur-release.json "$src"/merkur-release.sig "$src"/merkur-daemon-*.tar.gz "$incoming/"
chmod 0444 "$incoming"/*
mv -T "$incoming" "$store/$version"
rm -rf "$src"
find "$store" -maxdepth 1 -name 'v*' -type d | sort -V | head -n -3 | xargs -r rm -rf
