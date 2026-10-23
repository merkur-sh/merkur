#!/usr/bin/env bash
# Build a disposable Linux copy of the real session stack; host programs stay untouched.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
case "$(docker info --format '{{.Architecture}}')" in
  x86_64) platform=--config=linux_x86_64 ;;
  aarch64) platform=--config=linux_aarch64 ;;
  *) echo "natlab: unsupported Docker architecture" >&2; exit 1 ;;
esac

targets=(
  //tools/bazel/native:natlab_runtime
  //apps/daemon/dataplane:merkur-dataplane
  //packages/merkur-image-worker:merkur-image-worker
  //apps/tui:merkur-tui
  //apps/edge:merkur-edge
  //apps/stun:merkur-stun
)
bazel build "$platform" --config=release "${targets[@]}"
bun run build:wasm
execution_root="$(bazel info "$platform" execution_root)"
snapshot="$(mktemp -d)"
trap 'rm -rf "$snapshot"' EXIT
mkdir -p "$snapshot/runtime" "$snapshot/bin" "$snapshot/repo"

# Copy working bytes, including the implementation under test, without dependencies, caches,
# credentials or a developer's installed programs. Browser WASM is platform-independent.
python3 - "$REPO_ROOT" "$snapshot/repo" <<'PY'
from pathlib import Path
import shutil, subprocess, sys
source, target = map(Path, sys.argv[1:])
files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=source)
for name in files.decode().split('\0'):
    if not name or not (source / name).is_file():
        continue
    destination = target / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / name, destination)
for package in (source / 'packages').glob('*/pkg'):
    if package.is_dir():
        shutil.copytree(package, target / package.relative_to(source), dirs_exist_ok=True)
PY

for file in $(bazel cquery "$platform" --config=release --output=files //tools/bazel/native:natlab_runtime); do
  cp "$execution_root/$file" "$snapshot/runtime/$(basename "$file")"
done
for target in "${targets[@]:1}"; do
  file="$(bazel cquery "$platform" --config=release --output=files "$target")"
  cp "$execution_root/$file" "$snapshot/bin/$(basename "$file")"
done
mkdir -p "$snapshot/repo/apps/daemon/dist" "$snapshot/repo/apps/edge/dist"
for program in merkur-dataplane merkur-image-worker merkur-tui; do
  cp "$snapshot/bin/$program" "$snapshot/repo/apps/daemon/dist/$program"
done
cp "$snapshot/bin/merkur-edge" "$snapshot/repo/apps/edge/dist/merkur-edge"

evidence="$REPO_ROOT/test-results/natlab-native/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$evidence"
docker run --rm --init --privileged \
  -v "$snapshot/repo:/repo" -v "$snapshot/runtime:/runtime:ro" \
  -v "$snapshot/bin:/natlab:ro" -v "$evidence:/evidence" -w /repo \
  mirror.gcr.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f \
  bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive PATH=/runtime:/usr/sbin:/usr/bin:/sbin:/bin
    apt-get update -qq
    apt-get install -y -qq nftables iproute2 conntrack python3 miniupnpd-nftables procps tcpdump redis-server ca-certificates >/dev/null
    bun x "$(bun -p "JSON.parse(require(\"fs\").readFileSync(\"package.json\", \"utf8\")).packageManager")" install --frozen-lockfile
    node node_modules/playwright/cli.js install --with-deps chromium
    bash scripts/natlab/native.sh "$@"
  ' bash "$@"
echo "NATIVE_NATLAB_EVIDENCE=$evidence"
