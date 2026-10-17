#!/usr/bin/env bash
# One platform's daemon archive, smoke-tested on the platform it ships to: an x86_64 Mac's image
# worker cannot start its sandbox under Rosetta, so each archive runs on its own runner.
set -euo pipefail
mkdir -p dist/smoke
tar -xzf "dist/ci-release/merkur-daemon-$PLATFORM.tar.gz" -C dist/smoke
if [[ "$PLATFORM" == linux-* ]]; then
  # Linux daemons ship to Debian 12 and later: the smoke test runs them there.
  docker run --rm --pull missing -v "$PWD:/work:ro" -e VERSION -e SEQUENCE \
    mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 \
    sh -ec 'apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 > /dev/null
      python3 /work/scripts/ci/release_smoke.py /work/dist/smoke "$VERSION" "$SEQUENCE" -'
else
  python3 scripts/ci/release_smoke.py dist/smoke "$VERSION" "$SEQUENCE" -
fi
