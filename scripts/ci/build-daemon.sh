#!/usr/bin/env bash
# One platform's daemon release: Bazel builds the archive (and, on Linux, the release verifier)
# with the release identity stamped in. `smoke-daemon.sh` tests it on the platform it ships to.
set -euo pipefail
mkdir -p dist/ci-release
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
if [[ "$PLATFORM" == linux-* ]]; then
  cp "$(output //tools/bazel/release:verify)" "dist/ci-release/verify-$PLATFORM"
fi
