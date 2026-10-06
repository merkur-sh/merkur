#!/usr/bin/env bash
# Run the IPv6 NAT/firewall lab (`lab.sh`) inside a privileged Linux container.
#
# # Why this exists
#
# From inside the daemon a successful `webtransport/portmap` v6 pinhole and a
# silently-filtered address are indistinguishable. That is true of a real CPE.
# It is not true here — the lab owns the firewall, so the two are trivially
# distinguishable, which is what makes the pinhole's effect testable at all.
#
# It is also the only place the *punch* (`webtransport/side_channel.rs`) is proven
# rather than argued. Against a real NAT you cannot separate "the punch worked"
# from "that NAT was already open".
#
# # What it establishes
#
#   firewall class        punch      PCP pinhole
#   address-restricted    ARRIVED    ARRIVED
#   port-restricted       BLOCKED    ARRIVED
#
# So the punch covers address-restricted only, and a pinhole covers a strictly
# larger class. Port-restricted is plain 5-tuple conntrack — the Linux default —
# so it is not an exotic case. What the lab deliberately cannot tell you is how
# many real CPEs speak PCP v6; that is a deployment question, not a mechanism one.
#
# The IPv4 half shows why the daemon sends no punch under port-dependent
# filtering: against a conntrack masquerade the adjacent-port punch admits
# nothing when the browser's source port is not the punched one.
#
# Requires Docker with a Linux VM. Namespaces are created inside the container,
# so the host network is never touched.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "natlab: Docker is not available; this lab needs a Linux kernel." >&2
  exit 1
fi

docker run --rm --privileged \
  -v "${LAB_DIR}/lab.sh:/lab.sh:ro" \
  debian:stable-slim \
  sh -c '
    export DEBIAN_FRONTEND=noninteractive PATH=/usr/sbin:/sbin:$PATH
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq nftables iproute2 conntrack python3 >/dev/null 2>&1
    bash /lab.sh
  '

# The real Rust live-socket and WT verification path complements the IPv6 mechanism lab.
bash "${LAB_DIR}/run-discovery.sh"
