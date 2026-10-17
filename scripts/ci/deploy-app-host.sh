#!/usr/bin/env bash
# Deploys the release's verified deployment to the app host (deploy/service-hosts.json's
# `app`) and verifies it runs exactly the retained server. SSH pins the host's key from
# the manifest. Only the deployment and non-secret configuration travel: the host holds
# its secrets in /etc/merkur/server.env and /etc/merkur/data.env.
set -euo pipefail
: "${VERSION:?}" "${SERVICE_HOSTS_SSH_KEY:?}" "${RUNNER_TEMP:?}"
work="$RUNNER_TEMP/app-host"
mkdir -p "$work/bundle" dist/service-proofs
umask 077
printf '%s\n' "$SERVICE_HOSTS_SSH_KEY" > "$work/id"
bun run scripts/service-hosts.ts known-hosts > "$work/known_hosts"
ssh_options=(-i "$work/id" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts")
address=$(bun run scripts/service-hosts.ts app)

# The deployment directory deploy-services.sh verified, not the archive it came from.
tar -C deployment -czf "$work/bundle/deployment.tar.gz" .
cp deploy/app/compose.yaml deploy/app/merkur-server.service deploy/app/merkur-site.service \
  "$work/bundle/"
cp scripts/ci/install-site-release.sh "$work/bundle/install-site"
tar -C "$work/bundle" -cf - . | ssh "${ssh_options[@]}" "root@$address" \
  'rm -rf /tmp/merkur-app-release && mkdir -m 0700 /tmp/merkur-app-release && tar -C /tmp/merkur-app-release -xf -'
ssh "${ssh_options[@]}" "root@$address" bash -s -- "$VERSION" \
  < scripts/ci/install-app-release.sh > dist/service-proofs/app.json
python3 scripts/ci/service-proof.py verify-app
