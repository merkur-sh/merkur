#!/usr/bin/env bash
set -euo pipefail
python3 scripts/ci/release_state.py assert
bun run scripts/ci-release-verify.ts dist/ci-release "$VERSION" "$SEQUENCE"
bun run deployment:verify -- --directory deployment --commit "$COMMIT"
: "${RAILWAY_TOKEN:?}" "${SERVICE_HOSTS_SSH_KEY:?}" "${SERVER_ORIGIN:?}"
: "${RAILWAY_PROJECT_ID:?}" "${RAILWAY_ENVIRONMENT_ID:?}" "${RAILWAY_SERVICE_ID:?}"
railway variable set "MERKUR_BUILD_COMMIT=$COMMIT" "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY" \
  --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID" --skip-deploys >/dev/null
upload_dir="$RUNNER_TEMP/railway-upload"
bash scripts/ci/railway-context.sh "$upload_dir"
railway up "$upload_dir" --path-as-root --no-gitignore --detach --json --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID" --message "$VERSION ($COMMIT)" > "$RUNNER_TEMP/railway-up.json"
deployment_id=$(jq -er '.deploymentId' "$RUNNER_TEMP/railway-up.json")
mkdir -p dist/service-proofs
cp "$RUNNER_TEMP/railway-up.json" dist/service-proofs/railway.json
python3 scripts/ci/service-proof.py record
for attempt in $(seq 1 120); do
  deploy_state=$(railway deployment list --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID" --json | jq -r --arg id "$deployment_id" '.[] | select(.id == $id) | .status')
  case "$deploy_state" in
    SUCCESS) break ;;
    FAILED|CRASHED|REMOVED|SKIPPED) exit 1 ;;
  esac
  if [ "$attempt" = 120 ]; then exit 1; fi
  sleep 10
done
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
