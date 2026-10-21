#!/usr/bin/env bash
set -euo pipefail
python3 scripts/ci/release_state.py assert
bun run scripts/ci-release-verify.ts dist/ci-release "$VERSION" "$SEQUENCE"
bun run deployment:verify -- --directory deployment --commit "$COMMIT"
: "${SERVICE_HOSTS_SSH_KEY:?}" "${SERVER_ORIGIN:?}"
mkdir -p dist/service-proofs
python3 scripts/ci/service-proof.py record
# Before the server of this release: the running server's daemons stage it from the store.
bash scripts/ci/stage-daemon-release.sh
bash scripts/ci/deploy-app-host.sh
bun run deployment:check-server -- --directory deployment --commit "$COMMIT" --origin "$SERVER_ORIGIN"
bash scripts/ci/deploy-service-hosts.sh
python3 scripts/ci/release_state.py advance services dist/service-proofs/identities.json
# Resolve annotated tags to a commit without trusting the tag object itself.
git fetch origin "refs/tags/$VERSION" --no-tags
test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$COMMIT"
gh release edit "$VERSION" --repo "$GITHUB_REPOSITORY" --draft=false --latest
# Public download has no token and must match the retained manifest and archives.
python3 scripts/ci/verify-public.py
python3 scripts/ci/release_state.py advance published
