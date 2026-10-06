#!/usr/bin/env bash
# Isolated Linux only. This script is called inside the privileged test container.
set -euo pipefail
for ns in daemon cpe observer; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
ip link add d0 type veth peer name c0
ip link set d0 netns daemon; ip link set c0 netns cpe
ip link add c1 type veth peer name o0
ip link set c1 netns cpe; ip link set o0 netns observer
ip -n daemon addr add 10.0.0.2/24 dev d0
ip -n daemon link set d0 up
ip -n daemon route add default via 10.0.0.1
ip -n cpe addr add 10.0.0.1/24 dev c0
ip -n cpe addr add 198.51.100.1/24 dev c1
ip -n cpe link set c0 up; ip -n cpe link set c1 up
ip netns exec cpe sysctl -qw net.ipv4.ip_forward=1
ip -n observer addr add 198.51.100.10/24 dev o0
ip -n observer addr add 198.51.100.11/24 dev o0
ip -n observer link set o0 up
ip -n observer route add default via 198.51.100.1

# Public, deterministic TEST key; never read or copy a deployment credential.
python3 - <<'PY' > /tmp/merkur-discovery-env
import base64, hashlib, hmac, os, time
enc = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
key = bytes([3]) * 64
prefix = b'\x01' + (int(time.time()) + 600).to_bytes(8, 'big') + os.urandom(16)
ticket = prefix + hmac.digest(key, b'merkur-stun-ticket-v1' + prefix, 'sha256')[:16]
secret = hmac.digest(key, b'merkur-stun-message-integrity-v1' + ticket, 'sha256')
print('export MERKUR_STUN_TICKET_KEY=' + enc(key))
print('export MERKUR_STUN_TEST_TICKET=' + enc(ticket))
print('export MERKUR_STUN_TEST_SECRET=' + enc(secret))
PY
source /tmp/merkur-discovery-env
# 3480 is change-only: the daemon probes 3478 on both addresses, and a
# CHANGE-PORT answer from a port it never probes is what keeps the contact
# ledger exact and the `masquerade` case honest.
export MERKUR_STUN_BIND=198.51.100.10,198.51.100.11 MERKUR_STUN_PORTS=3478,3479 MERKUR_STUN_CHANGE_PORTS=3480
ip netns exec observer /target/debug/merkur-stun > /tmp/merkur-discovery-observer.log 2>&1 &
observer_pid=$!
# portmap.sh runs next in the same container and creates its own `daemon` and `cpe`.
teardown() {
  kill "$observer_pid" 2>/dev/null || true
  for ns in daemon cpe observer; do ip netns del "$ns" 2>/dev/null || true; done
}
trap teardown EXIT
sleep 0.3
kill -0 "$observer_pid"

mapping() {
  local port="$1"
  ip netns exec cpe nft delete table ip mapping 2>/dev/null || true
  ip netns exec cpe nft -f - <<NFT
table ip mapping {
 chain inbound { type nat hook prerouting priority dstnat;
   ip daddr 198.51.100.1 udp dport $port dnat to 10.0.0.2:44300
 }
 chain outbound { type nat hook postrouting priority srcnat;
   oifname "c1" ip saddr 10.0.0.2 udp sport 44300 snat to 198.51.100.1:$port
 }
}
NFT
  ip netns exec cpe conntrack -F >/dev/null 2>&1
}

# Plain conntrack masquerade: source port preserved, 5-tuple filtering. This is
# the box host's own NAT shape, and the one that misread an endpoint-independent
# NAT as symmetric when CHANGE-PORT answers came from an observer port.
masquerade() {
  ip netns exec cpe nft delete table ip mapping 2>/dev/null || true
  ip netns exec cpe nft -f - <<'NFT'
table ip mapping {
 chain outbound { type nat hook postrouting priority srcnat;
   oifname "c1" ip saddr 10.0.0.2 masquerade
 }
}
NFT
  ip netns exec cpe conntrack -F >/dev/null 2>&1
}

for mode in open loss address port masquerade; do
  ip netns exec cpe nft flush ruleset
  if [ "$mode" = masquerade ]; then
    masquerade
  else
    mapping 50000
  fi
  if [ "$mode" = address ] || [ "$mode" = port ]; then
    ip netns exec cpe nft -f - <<'NFT'
table ip filtering {
 set contacted { type ipv4_addr; flags timeout; timeout 60s; }
 chain forward { type filter hook forward priority filter; policy drop;
   ct state established,related accept
   iifname "c0" update @contacted { ip daddr } accept
 }
}
NFT
    if [ "$mode" = address ]; then
      ip netns exec cpe nft add rule ip filtering forward iifname c1 ip saddr @contacted accept
    fi
  fi
  if [ "$mode" = loss ]; then
    # Lose every changed-source Binding response while ordinary Binding works.
    # The change-only port is the only source of those answers.
    ip netns exec cpe nft -f - <<'NFT'
table ip loss {
 chain forward { type filter hook forward priority filter; policy accept;
   iifname "c1" udp sport 3480 drop
 }
}
NFT
  fi
  rm -f /tmp/merkur-discovery-rebind-ready /tmp/merkur-discovery-rebound
  if [ "$mode" = open ]; then
    (
      for attempt in $(seq 1 500); do
        if [ -f /tmp/merkur-discovery-rebind-ready ]; then
          mapping 50001
          touch /tmp/merkur-discovery-rebound
          exit 0
        fi
        sleep 0.02
      done
      exit 1
    ) &
    rebind_pid=$!
  fi
  echo "discovery lab: $mode"
  MERKUR_NATLAB_CASE="$mode" ip netns exec daemon "$MERKUR_DISCOVERY_TEST_BIN" \
    natlab_live_discovery --ignored --nocapture --test-threads=1
  if [ "$mode" = open ]; then wait "$rebind_pid"; fi
done
echo 'DISCOVERY_LAB=PASS'
