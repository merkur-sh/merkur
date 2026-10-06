#!/usr/bin/env bash
set -euo pipefail
python3 scripts/ci/release_state.py assert
bun run scripts/ci-release-verify.ts dist/ci-release "$VERSION" "$SEQUENCE"
bun run deployment:verify -- --directory deployment --commit "$COMMIT"
: "${RAILWAY_TOKEN:?}" "${FLY_API_TOKEN:?}" "${SERVER_ORIGIN:?}"
: "${RAILWAY_PROJECT_ID:?}" "${RAILWAY_ENVIRONMENT_ID:?}" "${RAILWAY_SERVICE_ID:?}"
railway variable set "MERKUR_BUILD_COMMIT=$COMMIT" "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY" \
  --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID" --skip-deploys >/dev/null
upload_dir="$RUNNER_TEMP/railway-upload"
mkdir "$upload_dir"
git archive "$COMMIT" | tar -x -C "$upload_dir"
cp -R deployment "$upload_dir/deployment"
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
flyctl auth docker
docker load -i dist/ci-release/edge-image.tar.gz
docker load -i dist/ci-release/stun-image.tar.gz
replicas=$(bun run scripts/edge-fly-config.ts list)
mkdir -p dist/service-proofs
cp "$RUNNER_TEMP/railway-up.json" dist/service-proofs/railway.json
# Registry manifests are resolved and recorded before deploying any Fly machine.
while IFS=$'\t' read -r edge_id edge_app _edge_region; do
  docker tag merkur-edge:release "registry.fly.io/$edge_app:$VERSION"
  docker push "registry.fly.io/$edge_app:$VERSION"
  docker inspect --format '{{json .RepoDigests}}' "registry.fly.io/$edge_app:$VERSION" | \
    jq -er --arg prefix "registry.fly.io/$edge_app@sha256:" '.[] | select(startswith($prefix))' > "dist/service-proofs/$edge_app.image"
done <<< "$replicas"
for stun_app in $STUN_APPS; do
  docker tag merkur-stun:release "registry.fly.io/$stun_app:$VERSION"
  docker push "registry.fly.io/$stun_app:$VERSION"
  docker inspect --format '{{json .RepoDigests}}' "registry.fly.io/$stun_app:$VERSION" | \
    jq -er --arg prefix "registry.fly.io/$stun_app@sha256:" '.[] | select(startswith($prefix))' > "dist/service-proofs/$stun_app.image"
done
python3 scripts/ci/service-proof.py record
while IFS=$'\t' read -r edge_id edge_app _edge_region; do
  config=$(bun run scripts/edge-fly-config.ts render "$edge_id" "$VERSION")
  flyctl deploy --app "$edge_app" --config "$config" --image "$(cat "dist/service-proofs/$edge_app.image")" --yes
  flyctl machine list --app "$edge_app" --json > "dist/service-proofs/$edge_app.machines.json"
  python3 scripts/ci/service-proof.py verify "$edge_app"
done <<< "$replicas"
for stun_app in $STUN_APPS; do
  flyctl deploy --app "$stun_app" --config apps/stun/fly.toml --image "$(cat "dist/service-proofs/$stun_app.image")" --yes
  flyctl machine list --app "$stun_app" --json > "dist/service-proofs/$stun_app.machines.json"
  python3 scripts/ci/service-proof.py verify "$stun_app"
done
python3 scripts/ci/release_state.py advance services dist/service-proofs/identities.json
# Resolve annotated tags to a commit without trusting the tag object itself.
git fetch origin "refs/tags/$VERSION" --no-tags
test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$COMMIT"
gh release edit "$VERSION" --repo "$GITHUB_REPOSITORY" --draft=false --latest
# Public download has no token and must match the retained manifest and archives.
python3 scripts/ci/verify-public.py
python3 scripts/ci/release_state.py advance published
