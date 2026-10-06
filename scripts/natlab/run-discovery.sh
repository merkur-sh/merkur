#!/usr/bin/env bash
# Compile and run the real Rust endpoints in isolated routed namespaces: live
# discovery against the STUN responder, then the port-mapping lease against a
# real miniupnpd (Debian trixie ships 2.3.9).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec docker run --rm --privileged \
  -v "$REPO_ROOT:/repo:ro" -v merkur-discovery-cargo:/usr/local/cargo \
  -v merkur-discovery-target:/target -w /repo \
  -e CARGO_TARGET_DIR=/target rust:1-trixie bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nftables iproute2 conntrack python3 libclang-dev miniupnpd-nftables procps >/dev/null
    cargo build --locked -p merkur-stun
    cargo test --locked -p merkur-dataplane --no-run --message-format=json > /tmp/discovery-build.json
    # The lab tests live in the library; the binary target builds a test
    # executable too, and it holds none of them.
    export MERKUR_DISCOVERY_TEST_BIN=$(python3 -c '\''import json; print(next(x["executable"] for x in map(json.loads, open("/tmp/discovery-build.json")) if x.get("executable") and x.get("profile", {}).get("test") and x.get("target", {}).get("kind") == ["lib"]))'\'')
    bash /repo/scripts/natlab/discovery.sh
    bash /repo/scripts/natlab/portmap.sh
  '
