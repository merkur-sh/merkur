#!/usr/bin/env bash
# The port-mapping lease against a real miniupnpd. Isolated Linux only: this
# script is called inside the privileged natlab container, after discovery.sh,
# with MERKUR_DISCOVERY_TEST_BIN naming the dataplane test binary.
#
# miniupnpd serves UPnP IGD, NAT-PMP and PCP from one table, so it is both what
# most consumer routers ship and the case the "exactly one protocol maps" rule
# protects. Four cases:
#
#   all              every protocol on      a datagram protocol maps, one rule
#   upnp-only        PCP/NAT-PMP off        UPnP maps in well under the datagram schedule
#   datagram-silent  5351 silently dropped  UPnP still maps without waiting on it
#   double-nat       miniupnpd behind NAT   nothing published (gateway:inner_nat)
#
# Each mapped case also proves the lease end to end: a datagram from outside
# the NAT reaches the daemon's port through it, and release empties the table.
set -euo pipefail

BIN="${MERKUR_DISCOVERY_TEST_BIN:?}"
PUBLIC=5.5.5.1
CLIENT=5.5.5.2
MAPPED=/tmp/natlab-portmap-mapped

teardown() {
  pkill -x miniupnpd 2>/dev/null || true
  for ns in daemon cpe outer client; do ip netns del "$ns" 2>/dev/null || true; done
  rm -f "$MAPPED"
}
trap teardown EXIT

veth() {
  ip link add "$1" type veth peer name "$3"
  ip link set "$1" netns "$2"
  ip link set "$3" netns "$4"
}

addr() {
  ip -n "$1" addr add "$2" dev "$3"
  ip -n "$1" link set "$3" up
}

# daemon 10.0.0.2 -- 10.0.0.1 [cpe] $PUBLIC -- $CLIENT client
single_nat() {
  for ns in daemon cpe client; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
  veth d0 daemon c0 cpe
  veth c1 cpe k0 client
  addr daemon 10.0.0.2/24 d0
  ip -n daemon route add default via 10.0.0.1
  addr cpe 10.0.0.1/24 c0
  addr cpe "$PUBLIC/24" c1
  ip netns exec cpe sysctl -qw net.ipv4.ip_forward=1
  addr client "$CLIENT/24" k0
}

# daemon 10.0.0.2 -- 10.0.0.1 [cpe] 172.30.0.2 -- 172.30.0.1 [outer] $PUBLIC -- client
# `cpe` is the user's own router, whose WAN side is the ISP modem's LAN.
double_nat() {
  for ns in daemon cpe outer client; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
  veth d0 daemon c0 cpe
  veth c1 cpe o0 outer
  veth o1 outer k0 client
  addr daemon 10.0.0.2/24 d0
  ip -n daemon route add default via 10.0.0.1
  addr cpe 10.0.0.1/24 c0
  addr cpe 172.30.0.2/24 c1
  ip -n cpe route add default via 172.30.0.1
  ip netns exec cpe sysctl -qw net.ipv4.ip_forward=1
  addr outer 172.30.0.1/24 o0
  addr outer "$PUBLIC/24" o1
  ip netns exec outer sysctl -qw net.ipv4.ip_forward=1
  ip netns exec outer nft -f - <<'NFT'
table ip outer {
  chain postrouting { type nat hook postrouting priority srcnat; oifname "o1" masquerade; }
}
NFT
  addr client "$CLIENT/24" k0
}

# miniupnpd on `cpe`, with WAN `c1` and LAN `c0`.
start_miniupnpd() {
  local pcp_pmp="$1" extra="${2:-}"
  ip netns exec cpe sh /etc/miniupnpd/nft_init.sh >/dev/null
  cat > /tmp/miniupnpd.conf <<CONF
ext_ifname=c1
listening_ip=c0
enable_upnp=yes
enable_pcp_pmp=$pcp_pmp
secure_mode=yes
uuid=3d3cec3a-8cf0-11e0-98ee-001a6bd2d07b
allow 1024-65535 10.0.0.0/24 1024-65535
deny 0-65535 0.0.0.0/0 0-65535
$extra
CONF
  ip netns exec cpe miniupnpd -f /tmp/miniupnpd.conf -d > /tmp/miniupnpd.log 2>&1 &
  for _ in $(seq 1 100); do
    if ip netns exec cpe ss -lun | grep -q ':1900 '; then return 0; fi
    sleep 0.05
  done
  echo "miniupnpd did not start:" >&2
  cat /tmp/miniupnpd.log >&2
  return 1
}

# Port-forward rules miniupnpd currently holds, across all three protocols.
rules() {
  ip netns exec cpe nft list chain inet filter prerouting_miniupnpd 2>/dev/null | grep -c dnat || true
}

run_case() {
  local case="$1"
  rm -f "$MAPPED"
  echo "portmap lab: $case"
  MERKUR_NATLAB_CASE="$case" MERKUR_NATLAB_REFLEXIVE="$PUBLIC" \
    ip netns exec daemon "$BIN" natlab_portmap --ignored --nocapture --test-threads=1 &
  local test_pid=$!
  if [ "$case" != double-nat ]; then
    for _ in $(seq 1 200); do
      [ -f "$MAPPED" ] && break
      kill -0 "$test_pid" 2>/dev/null || break
      sleep 0.05
    done
    [ -f "$MAPPED" ] || { wait "$test_pid"; echo "PORTMAP_LAB=FAIL ($case: no mapping)"; exit 1; }
    local held
    held=$(rules)
    if [ "$held" != 1 ]; then
      cat /tmp/miniupnpd.log
      echo "PORTMAP_LAB=FAIL ($case: $held rules, expected exactly one)"
      exit 1
    fi
    local ip port
    read -r ip port < "$MAPPED" || true
    ip netns exec client python3 -c "
import socket
socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'through', ('$ip', $port))
"
  fi
  wait "$test_pid"
  local left
  left=$(rules)
  if [ "$left" != 0 ]; then
    echo "PORTMAP_LAB=FAIL ($case: $left rules left after release)"
    exit 1
  fi
}

single_nat
start_miniupnpd yes
run_case all
teardown

single_nat
start_miniupnpd no
run_case upnp-only
teardown

single_nat
start_miniupnpd yes
ip netns exec cpe nft -f - <<'NFT'
table inet silence {
  chain input { type filter hook input priority -10; udp dport 5351 drop; }
}
NFT
run_case datagram-silent
teardown

double_nat
# A private WAN address is exactly the inner router's situation; allow it so
# miniupnpd answers as consumer routers do instead of refusing outright.
start_miniupnpd yes "ext_allow_private_ipv4=yes"
run_case double-nat
teardown

echo 'PORTMAP_LAB=PASS'
