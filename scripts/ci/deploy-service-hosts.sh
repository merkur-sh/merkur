#!/usr/bin/env bash
# Deploys the retained edge and STUN binaries to every host in
# deploy/service-hosts.json and verifies each host runs exactly them.
#
# SSH pins each host's key from the manifest; nothing is trusted on first use.
# Only non-secret configuration travels: the hosts hold their secrets in
# /etc/merkur/*.secrets.env.
set -euo pipefail
: "${VERSION:?}" "${SERVER_ORIGIN:?}" "${SERVICE_HOSTS_SSH_KEY:?}" "${RUNNER_TEMP:?}"
work="$RUNNER_TEMP/service-hosts"
mkdir -p "$work" dist/service-proofs
umask 077
printf '%s\n' "$SERVICE_HOSTS_SSH_KEY" > "$work/id"
bun run scripts/service-hosts.ts known-hosts > "$work/known_hosts"
ssh_options=(-i "$work/id" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts")

hosts=$(bun run scripts/service-hosts.ts list)
while IFS=$'\t' read -r name address; do
  bundle="$work/$name"
  mkdir -p "$bundle"
  bun run scripts/service-hosts.ts render "$name" "$VERSION" "$SERVER_ORIGIN" "$bundle"
  cp dist/ci-release/merkur-edge dist/ci-release/merkur-stun "$bundle/"
  cp apps/edge/egress-cap.sh "$bundle/edge-egress-cap"
  cp apps/edge/merkur-edge.service apps/stun/merkur-stun.service \
    apps/stun/merkur-stun-addrs.service "$bundle/"
  tar -C "$bundle" -cf - . | ssh "${ssh_options[@]}" "root@$address" \
    'rm -rf /tmp/merkur-release && mkdir -m 0700 /tmp/merkur-release && tar -C /tmp/merkur-release -xf -'
  ssh "${ssh_options[@]}" "root@$address" bash -s -- "$VERSION" \
    < scripts/ci/install-service-release.sh > "dist/service-proofs/$name.json"
  python3 scripts/ci/service-proof.py verify "$name"
done <<< "$hosts"
