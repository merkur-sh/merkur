#!/usr/bin/env bash
set -euo pipefail
python3 scripts/ci/release_state.py assert
python3 scripts/ci/release_state.py advance signing
python3 scripts/ci/release_assets.py extract dist/ci-release/deployment.tar.gz deployment
seed_file=$(mktemp "$RUNNER_TEMP/merkur-release-seed.XXXXXX")
chmod 600 "$seed_file"
trap 'rm -f "$seed_file"' EXIT
# The secret is neither a command-line argument nor a file in the checkout.
python3 - "$seed_file" <<'PY'
import base64, os, sys
seed = base64.b64decode(os.environ['RELEASE_SEED_BASE64'], validate=True)
if len(seed) != 32: raise ValueError('release seed must contain exactly 32 bytes')
with open(sys.argv[1], 'wb') as stream: stream.write(seed)
PY
unset RELEASE_SEED_BASE64
test "$(bun run scripts/derive-release-public-key.ts --seed-file "$seed_file")" = "$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY"
bun run web:sign -- --directory deployment/web --commit "$COMMIT" --seed-file "$seed_file"
bun run deployment:sign -- --directory deployment --commit "$COMMIT" --seed-file "$seed_file"
expires=$(python3 -c 'import time; print(int(time.time()*1000)+29*24*60*60*1000)')
bun run release:sign -- --directory dist/ci-release --version "$VERSION" --sequence "$SEQUENCE" \
  --minimum-sequence "$MINIMUM_SEQUENCE" --expires-at "$expires" --seed-file "$seed_file"
rm -f "$seed_file"
bun run scripts/ci-release-verify.ts dist/ci-release "$VERSION" "$SEQUENCE"
bun run deployment:verify -- --directory deployment --commit "$COMMIT"
tar -czf dist/ci-release/deployment.tar.gz -C deployment .
python3 scripts/ci/release_assets.py inventory dist/ci-release > "$RUNNER_TEMP/release-assets.json"
# This tag already exists; the workflow never creates or moves it.
gh release create "$VERSION" dist/ci-release/* --repo "$GITHUB_REPOSITORY" --draft --verify-tag --generate-notes
python3 scripts/ci/release_state.py advance retained "$RUNNER_TEMP/release-assets.json"
