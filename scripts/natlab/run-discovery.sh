#!/usr/bin/env bash
# Run the real Rust endpoints in isolated routed namespaces: live discovery against the STUN
# responder, then the port-mapping lease against a real miniupnpd (Debian trixie ships 2.3.9).
# Bazel builds both for the Linux the container runs: natively on a Linux host, and through the
# Linux platform configurations on a Mac.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
case "$(docker info --format '{{.Architecture}}')" in
  x86_64) platform=--config=linux_x86_64 ;;
  aarch64) platform=--config=linux_aarch64 ;;
  *) echo "natlab: unsupported Docker architecture" >&2; exit 1 ;;
esac
# The lab tests live in the dataplane library's unit suite.
targets=(//apps/stun:merkur-stun //apps/daemon/dataplane:unit //packages/merkur-traversal:unit)
names=(merkur-stun dataplane-unit traversal-unit)
bazel build "$platform" "${targets[@]}"
root="$(bazel info "$platform" execution_root)"
binaries="$(mktemp -d)"
trap 'rm -rf "$binaries"' EXIT
for index in "${!targets[@]}"; do
  cp "$root/$(bazel cquery "$platform" --output=files "${targets[$index]}")" "$binaries/${names[$index]}"
done
docker run --rm --privileged \
  -v "$REPO_ROOT:/repo:ro" -v "$binaries:/natlab:ro" -w /repo \
  -e MERKUR_DISCOVERY_STUN_BIN=/natlab/merkur-stun \
  -e MERKUR_DISCOVERY_TEST_BIN=/natlab/dataplane-unit \
  -e MERKUR_PORTMAP_TEST_BIN=/natlab/traversal-unit \
  mirror.gcr.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nftables iproute2 conntrack python3 miniupnpd-nftables procps >/dev/null
    bash /repo/scripts/natlab/discovery.sh
    bash /repo/scripts/natlab/portmap.sh
  '
