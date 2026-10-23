#!/usr/bin/env bash
# The writable repository lives in Docker's disposable anonymous volume.
set -euo pipefail
owner_uid="${MERKUR_NATLAB_UID:?host UID required}"
owner_gid="${MERKUR_NATLAB_GID:?host GID required}"
[[ $owner_uid =~ ^[0-9]+$ && $owner_gid =~ ^[0-9]+$ ]] || exit 2

finish() {
  local status=$?
  trap - EXIT
  if ! chown -hR "$owner_uid:$owner_gid" /evidence; then
    echo 'natlab: could not return evidence ownership to the invoking user' >&2
    if [[ $status == 0 ]]; then status=1; fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

export DEBIAN_FRONTEND=noninteractive PATH=/runtime:/usr/sbin:/usr/bin:/sbin:/bin
cp -a /source/. /repo/
cd /repo
apt-get update -qq
apt-get install -y -qq nftables iproute2 conntrack python3 miniupnpd-nftables procps tcpdump redis-server ca-certificates >/dev/null
bun x "$(bun -p "JSON.parse(require(\"fs\").readFileSync(\"package.json\", \"utf8\")).packageManager")" install --frozen-lockfile
playwright_cli="$(node -p 'require.resolve("@playwright/test/cli")')"
node "$playwright_cli" install --with-deps chromium
bash scripts/natlab/native.sh "$@"
