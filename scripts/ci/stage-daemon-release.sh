#!/usr/bin/env bash
# Stages the release's signed daemon files in the app host's release store before the server
# of that release is deployed. The running server watches the store, and its daemons download
# and verify the release then, so the cutover only swaps binaries. The new server serves the
# same files to every daemon that converges later (docs/releases.md, Convergence).
set -euo pipefail
: "${VERSION:?}" "${SERVICE_HOSTS_SSH_KEY:?}" "${RUNNER_TEMP:?}"
work="$RUNNER_TEMP/daemon-release"
mkdir -p "$work/files"
umask 077
printf '%s\n' "$SERVICE_HOSTS_SSH_KEY" > "$work/id"
bun run scripts/service-hosts.ts known-hosts > "$work/known_hosts"
ssh_options=(-i "$work/id" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts")
address=$(bun run scripts/service-hosts.ts app)

cp dist/ci-release/merkur-release.json dist/ci-release/merkur-release.sig "$work/files/"
cp dist/ci-release/merkur-daemon-*.tar.gz "$work/files/"
tar -C "$work/files" -cf - . | ssh "${ssh_options[@]}" "root@$address" \
  'rm -rf /tmp/merkur-daemon-release && mkdir -m 0700 /tmp/merkur-daemon-release && tar -C /tmp/merkur-daemon-release -xf -'
ssh "${ssh_options[@]}" "root@$address" bash -s -- "$VERSION" < scripts/ci/install-daemon-release.sh
