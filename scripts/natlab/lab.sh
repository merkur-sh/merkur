#!/bin/bash
# NAT/firewall lab: IPv6 punch/pinhole, then the IPv4 port-dependent filter.
#
# Topology, all inside one container via network namespaces:
#
#   [daemon]  2001:db8:1::2  <--veth-->  2001:db8:1::1  [cpe]  2001:db8:2::1  <--veth-->  2001:db8:2::2  [client]
#
# `cpe` models a consumer CPE's stateful IPv6 firewall. The interesting class is
# ADDRESS-restricted: inbound from any port of an address the inside host has
# already sent to is admitted. Linux conntrack alone gives PORT-restricted
# (5-tuple) semantics, which is NOT the class the punch targets, so the lab
# models address-restricted explicitly with a dynamic nftables set.
set -euo pipefail

DAEMON_V6=2001:db8:1::2
CLIENT_V6=2001:db8:2::2
CPE_IN=2001:db8:1::1
CPE_OUT=2001:db8:2::1
PORT=44433

setup() {
  for ns in daemon cpe client; do ip netns add $ns; ip netns exec $ns ip link set lo up; done

  ip link add d0 type veth peer name c0
  ip link set d0 netns daemon; ip link set c0 netns cpe
  ip link add c1 type veth peer name k0
  ip link set c1 netns cpe; ip link set k0 netns client

  ip netns exec daemon ip -6 addr add $DAEMON_V6/64 dev d0
  ip netns exec daemon ip link set d0 up
  ip netns exec daemon ip -6 route add default via $CPE_IN

  ip netns exec cpe ip -6 addr add $CPE_IN/64 dev c0
  ip netns exec cpe ip -6 addr add $CPE_OUT/64 dev c1
  ip netns exec cpe ip link set c0 up; ip netns exec cpe ip link set c1 up
  ip netns exec cpe sh -c 'echo 1 > /proc/sys/net/ipv6/conf/all/forwarding'

  ip netns exec client ip -6 addr add $CLIENT_V6/64 dev k0
  ip netns exec client ip link set k0 up
  ip netns exec client ip -6 route add default via $CPE_OUT

  # Settle DAD so the first packet is not silently dropped.
  sleep 2
}

# Address-restricted stateful firewall.
firewall_address_restricted() {
  ip netns exec cpe nft -f - <<'NFT'
table inet cpe {
  set punched {
    type ipv6_addr
    flags timeout
    timeout 30s
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    # Outbound (inside -> outside): record the destination ADDRESS, then allow.
    # This is what makes the firewall address-restricted rather than
    # port-restricted: the port is deliberately not part of the key.
    iifname "c0" update @punched { ip6 daddr } accept
    # Inbound: admitted only from an address the inside host has spoken to.
    iifname "c1" ip6 saddr @punched accept
    counter drop
  }
}
NFT
}

# PORT-restricted: plain 5-tuple conntrack, which is the Linux default and the
# stricter of the two common CPE behaviours. A punch toward the client's address
# only opens the exact (daemon:PORT <-> client:PORT) flow, so a browser dialing
# from any other source port is still dropped. This is the class the punch
# provably cannot cover and PCP can.
firewall_port_restricted() {
  ip netns exec cpe nft -f - <<'NFT'
table inet cpe {
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    iifname "c0" accept
    counter drop
  }
}
NFT
}

# Same firewall, plus an explicit pinhole of the kind a PCP MAP would install.
add_pcp_pinhole() {
  # `insert`, not `add`: `add` appends AFTER the chain's terminal `drop`, so the
  # pinhole would never be reached. A real PCP daemon has the same ordering
  # obligation, which is worth having the lab encode.
  ip netns exec cpe nft insert rule inet cpe forward iifname "c1" ip6 daddr $DAEMON_V6 udp dport $PORT accept
}

# Does an unsolicited datagram from client reach the daemon? Prints ARRIVED/BLOCKED.
probe() {
  local sport="${1:-0}"
  ip netns exec daemon python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
s.bind(('::', $PORT)); s.settimeout(3)
print('READY', flush=True)
try:
    d, _ = s.recvfrom(64); print('ARRIVED')
except socket.timeout:
    print('BLOCKED')
" &
  local pid=$!
  sleep 1
  ip netns exec client python3 -c "
import socket
s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
if $sport: s.bind(('::', $sport))
s.sendto(b'hello', ('$DAEMON_V6', $PORT))
" || true
  wait $pid
}

# The daemon sends one inert byte toward the client's ADDRESS, exactly as
# side_channel::punch does. Port 44433 on the client is closed; that is fine and
# intended — the point is the outbound packet, not a reply.
punch() {
  ip netns exec daemon python3 -c "
import socket
s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
s.bind(('::', $PORT))
s.sendto(b'\x00', ('$CLIENT_V6', $PORT))
"
}

setup
firewall_address_restricted

echo "=== 1. unsolicited inbound, no punch (expect BLOCKED) ==="
R1=$(probe 51000 | tail -1); echo "  -> $R1"

echo "=== 2. after the daemon punches the client's address (expect ARRIVED) ==="
punch
# Deliberately a DIFFERENT source port than the punch destination: this is the
# whole claim. A port-restricted firewall would still drop this; an
# address-restricted one admits it.
R2=$(probe 52000 | tail -1); echo "  -> $R2"

echo "=== 3. fresh firewall, no punch, explicit PCP-style pinhole (expect ARRIVED) ==="
ip netns exec cpe nft flush ruleset
firewall_address_restricted
add_pcp_pinhole
R3=$(probe 53000 | tail -1); echo "  -> $R3"

echo "=== 4. PORT-restricted firewall + punch, browser on another port (expect BLOCKED) ==="
ip netns exec cpe nft flush ruleset
firewall_port_restricted
punch
R4=$(probe 54000 | tail -1); echo "  -> $R4"

echo "=== 5. PORT-restricted firewall + PCP-style pinhole (expect ARRIVED) ==="
ip netns exec cpe nft flush ruleset
firewall_port_restricted
add_pcp_pinhole
R5=$(probe 55000 | tail -1); echo "  -> $R5"

# ---------------------------------------------------------------------------
# IPv4 port-dependent filtering.
#
#   [daemon4] 10.0.0.2  <--veth-->  10.0.0.1 [cpe4] 198.51.100.1  <--veth-->  198.51.100.2 [client4]
#
# `cpe4` is a plain conntrack masquerade: endpoint-independent mapping with
# port-preserving allocation, and 5-tuple (port-dependent) filtering — the
# Linux default and the shape the daemon classifies as `port_dependent`. The
# adjacent-port punch cannot open it: it admits only the exact
# (daemon:PORT <-> client:punched-port) flows, and a browser dials from an
# ephemeral port nothing can learn beforehand. This is why the daemon sends no
# punch under `port_dependent` filtering; such a daemon needs a lease, a global
# IPv6 address, or the relay.
# ---------------------------------------------------------------------------

DAEMON_V4=10.0.0.2
CPE4_IN=10.0.0.1
CPE4_OUT=198.51.100.1
CLIENT_V4=198.51.100.2
CLIENT_SOCKETS=16

setup_v4() {
  for ns in daemon4 cpe4 client4; do ip netns add $ns; ip netns exec $ns ip link set lo up; done
  ip link add e0 type veth peer name f0
  ip link set e0 netns daemon4; ip link set f0 netns cpe4
  ip link add f1 type veth peer name g0
  ip link set f1 netns cpe4; ip link set g0 netns client4
  ip netns exec daemon4 ip addr add $DAEMON_V4/24 dev e0
  ip netns exec daemon4 ip link set e0 up
  ip netns exec daemon4 ip route add default via $CPE4_IN
  ip netns exec cpe4 ip addr add $CPE4_IN/24 dev f0
  ip netns exec cpe4 ip addr add $CPE4_OUT/24 dev f1
  ip netns exec cpe4 ip link set f0 up; ip netns exec cpe4 ip link set f1 up
  ip netns exec cpe4 sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  ip netns exec cpe4 nft -f - <<'NFT'
table ip nat4 {
  chain postrouting { type nat hook postrouting priority srcnat;
    oifname "f1" masquerade
  }
}
table ip filter4 {
  chain forward { type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "f0" accept
    counter drop
  }
}
NFT
  ip netns exec client4 ip addr add $CLIENT_V4/24 dev g0
  ip netns exec client4 ip link set g0 up
  ip netns exec client4 ip route add default via $CPE4_OUT
}

# Several browser sockets from the OS ephemeral range, each sending one
# datagram to the daemon's public port. Prints how many the daemon saw.
probe_v4() {
  local k="$1"
  ip netns exec daemon4 python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('0.0.0.0', $PORT)); s.settimeout(2)
print('READY', flush=True)
seen = set()
try:
    while True:
        d, a = s.recvfrom(64); seen.add(a)
except socket.timeout:
    pass
print('ARRIVED', len(seen))
" &
  local pid=$!
  sleep 1
  ip netns exec client4 python3 -c "
import socket
socks = [socket.socket(socket.AF_INET, socket.SOCK_DGRAM) for _ in range($k)]
for s in socks:
    s.sendto(b'hello', ('$CPE4_OUT', $PORT))
" || true
  wait $pid
}

setup_v4

echo "=== 6. v4 masquerade, adjacent-port punch, $CLIENT_SOCKETS browser sockets (expect ARRIVED 0) ==="
ip netns exec daemon4 python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(('0.0.0.0', $PORT))
for p in ($PORT, $PORT + 1): s.sendto(b'\\x00', ('$CLIENT_V4', p))
"
R6=$(probe_v4 $CLIENT_SOCKETS | tail -1); echo "  -> $R6"

echo
echo "RESULTS addr_no_punch=$R1 addr_punch=$R2 addr_pcp=$R3 port_punch=$R4 port_pcp=$R5 v4_punch='$R6'"
if [ "$R1" = "BLOCKED" ] && [ "$R2" = "ARRIVED" ] && [ "$R3" = "ARRIVED" ] \
   && [ "$R4" = "BLOCKED" ] && [ "$R5" = "ARRIVED" ] && [ "$R6" = "ARRIVED 0" ]; then
  echo "LAB=PASS"
else
  echo "LAB=FAIL"
fi
