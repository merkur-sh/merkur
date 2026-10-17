#!/usr/bin/env bash
# One platform's daemon release: Bazel builds the archive (and, on Linux, the release verifier)
# with the release identity stamped in, then every executable is smoke-tested where it ships.
set -euo pipefail
mkdir -p dist/ci-release dist/smoke
# The CLI embeds the notices of the shipped dependency closure.
bun run scripts/generate-third-party-notices.ts
flags=(
  --config=release
  "--//tools/bazel/release:version=$VERSION"
  "--//tools/bazel/release:sequence=$SEQUENCE"
  "--//tools/bazel/release:release_public_key=$MERKUR_RELEASE_MLDSA87_PUBLIC_KEY"
  "--//tools/bazel/release:public_origin=$SERVER_ORIGIN"
  "--//tools/bazel/release:opaque_pin=$OPAQUE_PIN"
)
# darwin-x64 builds on Apple Silicon and trains its profile under Rosetta: LLVM ships no x86_64
# macOS toolchain.
if [[ "$PLATFORM" == darwin-x64 ]]; then flags+=(--config=macos_x86_64); fi
targets=(//tools/bazel/release:daemon)
if [[ "$PLATFORM" == linux-* ]]; then targets+=(//tools/bazel/release:verify); fi
bazel build "${flags[@]}" "${targets[@]}"
root="$(bazel info "${flags[@]}" execution_root)"
output() { echo "$root/$(bazel cquery "${flags[@]}" --output=files "$1")"; }
cp "$(output //tools/bazel/release:daemon)" "dist/ci-release/merkur-daemon-$PLATFORM.tar.gz"
tar -xzf "dist/ci-release/merkur-daemon-$PLATFORM.tar.gz" -C dist/smoke
if [[ "$PLATFORM" == linux-* ]]; then
  cp "$(output //tools/bazel/release:verify)" "dist/ci-release/verify-$PLATFORM"
  # Linux daemons ship to Debian 12 and later: the smoke test runs them there.
  docker run --rm --pull missing -v "$PWD:/work:ro" -e VERSION -e SEQUENCE \
    mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 \
    sh -ec 'apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 > /dev/null
      python3 /work/scripts/ci/release_smoke.py /work/dist/smoke "$VERSION" "$SEQUENCE" -'
else
  python3 scripts/ci/release_smoke.py dist/smoke "$VERSION" "$SEQUENCE" -
fi
