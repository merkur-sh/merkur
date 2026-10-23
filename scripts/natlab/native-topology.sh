#!/usr/bin/env bash
# Network state for the real-client lab. All links and namespaces live inside its container.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE=/tmp/merkur-native-topology
BRIDGE=merkur-wan
DAEMON=merkur-natlab-daemon
CLIENT=merkur-natlab-client
DAEMON_CPE=merkur-natlab-daemon-cpe
CLIENT_CPE=merkur-natlab-client-cpe
OUTER=merkur-natlab-client-outer
DAEMON_PORT=24400

cases() {
  cat <<'CASES'
eim-pdf
blocked
edm-daemon-eif
edm-daemon-adf
edm-client-eif
edm-client-adf
edm-pdf
edm-both
client-lease-pcp
client-lease-natpmp
client-lease-upnp
daemon-lease-pcp
daemon-lease-natpmp
daemon-lease-upnp
inner-lease
ipv6-pdf
ipv6-client-pcp
ipv6-daemon-pcp
ipv6-client-igd
ipv6-daemon-igd
lan
CASES
}

require_container() {
  if [[ $(uname -s) != Linux || $EUID != 0 || ! -f /.dockerenv ]]; then
    echo 'native topology requires the privileged Linux NAT-lab container' >&2
    exit 1
  fi
}

teardown() {
  if [[ -d $STATE ]]; then
    local file pid
    for file in "$STATE"/*.pid; do
      [[ -f $file ]] || continue
      read -r pid < "$file"
      [[ $pid =~ ^[0-9]+$ ]] || continue
      kill "$pid" 2>/dev/null || true
    done
  fi
  local namespace
  for namespace in "$DAEMON" "$CLIENT" "$DAEMON_CPE" "$CLIENT_CPE" "$OUTER"; do
    ip netns del "$namespace" 2>/dev/null || true
  done
  ip link del "$BRIDGE" 2>/dev/null || true
  nft delete table inet merkur_natlab 2>/dev/null || true
  rm -rf "$STATE"
}

namespace() {
  ip netns add "$1"
  ip -n "$1" link set lo up
  ip netns exec "$1" sysctl -qw net.ipv4.conf.all.rp_filter=0
  ip netns exec "$1" sysctl -qw net.ipv4.conf.default.rp_filter=0
  ip netns exec "$1" sysctl -qw 'net.ipv4.ip_local_port_range=40000 49999'
}

veth() {
  local first_ns=$1 first=$2 second_ns=$3 second=$4 host_a=$5 host_b=$6
  ip link add "$host_a" type veth peer name "$host_b"
  ip link set "$host_a" netns "$first_ns"
  ip link set "$host_b" netns "$second_ns"
  ip -n "$first_ns" link set "$host_a" name "$first"
  ip -n "$second_ns" link set "$host_b" name "$second"
  ip -n "$first_ns" link set "$first" up
  ip -n "$second_ns" link set "$second" up
}

wan() {
  local namespace=$1 name=$2 public=$3 public6=$4
  ip link add "$name" type veth peer name mw-peer
  ip link set mw-peer netns "$namespace"
  ip -n "$namespace" link set mw-peer name wan0
  ip -n "$namespace" link set wan0 up
  ip -n "$namespace" addr add "$public/24" dev wan0
  ip -n "$namespace" -6 addr add "$public6/64" dev wan0 nodad
  ip link set "$name" master "$BRIDGE"
  ip link set "$name" up
  ip -n "$namespace" route add default via 198.51.100.254
  ip -n "$namespace" -6 route add default via 2001:db8:ffff::254
}

pair() {
  local role=$1 number=$2 namespace=$3 cpe=$4
  namespace "$namespace"
  namespace "$cpe"
  veth "$namespace" eth0 "$cpe" lan0 "m${number}-host" "m${number}-lan"
  ip -n "$namespace" addr add "10.20.$number.2/24" dev eth0
  ip -n "$namespace" route add default via "10.20.$number.1"
  ip -n "$cpe" addr add "10.20.$number.1/24" dev lan0
  ip netns exec "$cpe" sysctl -qw net.ipv4.ip_forward=1
  ip netns exec "$cpe" sysctl -qw net.ipv6.conf.all.forwarding=1
  wan "$cpe" "mw-$role" "198.51.100.$number" "2001:db8:ffff::$number"
}

ipv6() {
  local number=$1 namespace=$2 cpe=$3
  ip -n "$namespace" -6 addr add "2001:db8:$number::2/64" dev eth0 nodad
  ip -n "$namespace" -6 route add default via "2001:db8:$number::1"
  ip -n "$cpe" -6 addr add "2001:db8:$number::1/64" dev lan0 nodad
  ip -6 route add "2001:db8:$number::/64" via "2001:db8:ffff::$number" dev "$BRIDGE"
}

filter() {
  local namespace=$1 peer=$2 filtering=$3 block=$4 lease=$5
  ip netns exec "$namespace" nft -f - <<NFT
table inet natlab {
  counter peer_drop { }
  counter other_drop { }
  set contacted4 { type ipv4_addr . inet_service . ipv4_addr; flags dynamic; size 1024; }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "wan0" ip saddr $peer meta l4proto udp counter name peer_drop drop
    iifname "wan0" meta l4proto udp counter name other_drop drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "lan0" meta l4proto udp update @contacted4 { ip saddr . udp sport . ip daddr }
  }
}
NFT
  if [[ $block == yes ]]; then
    ip netns exec "$namespace" nft add rule inet natlab forward iifname wan0 ip saddr "$peer" counter name peer_drop drop
  fi
  ip netns exec "$namespace" nft -f - <<'NFT'
add rule inet natlab forward ct state established,related accept
add rule inet natlab forward iifname "lan0" accept
NFT
  if [[ $lease == yes ]]; then
    # Static inverse mappings carry mark 1. Only a real earlier miniupnpd grant opens PDF.
    ip netns exec "$namespace" nft add rule inet natlab forward iifname wan0 ct status dnat ct mark 0 accept
  elif [[ $filtering == eif ]]; then
    ip netns exec "$namespace" nft add rule inet natlab forward iifname wan0 ct status dnat accept
  elif [[ $filtering == adf ]]; then
    ip netns exec "$namespace" nft -f - <<'NFT'
add rule inet natlab forward iifname "wan0" meta l4proto udp ct status dnat ip daddr . udp dport . ip saddr @contacted4 accept
NFT
  fi
  ip netns exec "$namespace" nft add rule inet natlab forward iifname wan0 ip saddr "$peer" counter name peer_drop drop
  ip netns exec "$namespace" nft -f - <<'NFT'
add rule inet natlab forward counter name other_drop drop
NFT
}

mapping() {
  local namespace=$1 public=$2 base=$3 mapping=$4 peer=$5 inside=$6
  local rules="$STATE/$namespace-mapping.nft"
  python3 "$SCRIPT_DIR/native-nat-table.py" "$public" "$base" "$mapping" "$peer" "$inside" "${@:7}" > "$rules"
  ip netns exec "$namespace" nft -f "$rules"
}

boundary_filter() {
  local role=$1 requested=$2 namespace peer
  [[ -f $STATE/case ]] || { echo 'boundary filter requires an active topology' >&2; return 1; }
  case "$role" in
    daemon) namespace=$DAEMON_CPE; peer=198.51.100.2 ;;
    client) namespace=$CLIENT_CPE; peer=198.51.100.1 ;;
    *) echo 'boundary filter role must be daemon or client' >&2; return 1 ;;
  esac
  [[ $requested == eif || $requested == adf ]] || {
    echo 'boundary filter must be eif or adf' >&2; return 1;
  }
  # The kernel preflight changes filtering independently of the installed NAT maps.
  ip netns exec "$namespace" nft delete table inet natlab
  filter "$namespace" "$peer" "$requested" no no
}

record_lifecycle() {
  python3 - "$STATE/lifecycle.json" "$1" <<'PY'
import json, pathlib, sys, time
path = pathlib.Path(sys.argv[1])
state = json.loads(path.read_text()) if path.exists() else {}
state[sys.argv[2]] = time.time_ns()
if sys.argv[2] == 'routeChangedAtNs':
    state['previousPrivateIP'] = '10.20.2.2'
    state['currentPrivateIP'] = '10.20.2.3'
path.write_text(json.dumps(state) + '\n')
PY
}

require_eim_case() {
  [[ -f $STATE/case && $(cat "$STATE/case") == eim-pdf ]] || {
    echo 'lifecycle intervention requires an active eim-pdf topology' >&2
    return 1
  }
}

block_peer() {
  require_eim_case
  local namespace peer
  for namespace in "$DAEMON_CPE" "$CLIENT_CPE"; do
    peer=198.51.100.2
    [[ $namespace == "$CLIENT_CPE" ]] && peer=198.51.100.1
    ip netns exec "$namespace" nft -f - <<NFT
table inet natlab_intervention {
  counter peer_drop { }
  chain forward {
    type filter hook forward priority -20; policy accept;
    ip saddr $peer meta l4proto udp counter name peer_drop drop
    ip daddr $peer meta l4proto udp counter name peer_drop drop
  }
}
NFT
  done
  record_lifecycle blockedAtNs
}

unblock_peer() {
  require_eim_case
  ip netns exec "$DAEMON_CPE" nft delete table inet natlab_intervention
  ip netns exec "$CLIENT_CPE" nft delete table inet natlab_intervention
  record_lifecycle unblockedAtNs
}

move_client() {
  require_eim_case
  record_lifecycle routeChangeStartedAtNs
  # Select the successor's disjoint port space before emitting its first address event.
  ip netns exec "$CLIENT" sysctl -qw 'net.ipv4.ip_local_port_range=30000 34999'
  # Replace forward ownership before the successor can send its first peer packet.
  ip netns exec "$CLIENT_CPE" nft -f - <<'NFT'
delete element ip natlab inside { 198.51.100.2 }
add element ip natlab inside { 198.51.100.2 : 10.20.2.3 }
NFT
  ip -n "$CLIENT" addr del 10.20.2.2/24 dev eth0
  ip -n "$CLIENT" addr add 10.20.2.3/24 dev eth0
  ip -n "$CLIENT" route replace default via 10.20.2.1
  # The loopback listeners stay fixed while their real-network upstreams move with the host.
  local file pid
  for file in "$STATE/proxy-client-origin.pid" "$STATE/proxy-client-relay.pid"; do
    read -r pid < "$file"
    [[ $pid =~ ^[0-9]+$ ]] || return 1
    kill -USR1 "$pid"
  done
  record_lifecycle routeChangedAtNs
}

partition_established() {
  require_eim_case
  local pid
  read -r pid < "$STATE/proxy-client-relay.pid"
  [[ $pid =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid"
  block_peer
  # The relay fixture retires existing local UDP peers, while admitting the next carrier.
  kill -USR2 "$pid"
  record_lifecycle carriersPartitionedAtNs
}

fault() {
  case "$1" in
    gateway-reboot|wait-reacquired-lease) [[ -f $STATE/case ]] ;;
    *) require_eim_case ;;
  esac
  python3 "$SCRIPT_DIR/native-fault.py" "$@"
}

native_phase() {
  [[ -f $STATE/case ]] || { echo 'native phase requires an active topology' >&2; return 1; }
  local recorded
  recorded=$(python3 - "$STATE/lifecycle.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
state = json.loads(path.read_text()) if path.exists() else {}
if 'nativeSessionsStartedAtNs' in state:
    value = state['nativeSessionsStartedAtNs']
    if type(value) is not int or value <= 0:
        raise SystemExit('native session phase has an invalid timestamp')
    print('present')
else:
    print('absent')
PY
)
  [[ $recorded == absent ]] || return 0
  local selected role
  selected=$(cat "$STATE/case")
  case "$selected" in
    ipv6-client-*|ipv6-daemon-*)
      role=${selected#ipv6-}; role=${role%-*}
      # Exclude the real gateway preflight's packets from native-session admission proof.
      ip netns exec "merkur-natlab-$role-cpe" nft -j list table inet filter > "$STATE/pinhole-native-start-nft.json"
      ;;
  esac
  record_lifecycle nativeSessionsStartedAtNs
}

rebind_committed() {
  require_eim_case
  python3 - "$STATE/lifecycle.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
state = json.loads(path.read_text()) if path.exists() else {}
if 'carriersPartitionedAtNs' not in state:
    raise SystemExit('committed rebind marker requires an established-carrier partition')
if 'rebindCommittedAtNs' in state:
    raise SystemExit('committed rebind already recorded for this topology')
PY
  record_lifecycle rebindCommittedAtNs
}

miniupnpd() {
  local role=$1 namespace=$2 number=$3 protocol=$4
  local upnp=no pcp=yes v6=no
  [[ $protocol == upnp || $protocol == igdv6 ]] && upnp=yes && pcp=no
  [[ $protocol == pcpv6 || $protocol == igdv6 ]] && v6=yes
  ip netns exec "$namespace" sh /etc/miniupnpd/nft_init.sh > "$STATE/$role-miniupnpd-init.log" 2>&1
  # Debian's real gateway table defaults to drop. Permit normal LAN egress and
  # existing replies, while keeping the pinhole owner's IPv6 inbound path strict.
  ip netns exec "$namespace" nft flush chain inet filter forward
  if [[ $v6 == yes ]]; then
    ip netns exec "$namespace" nft -f - <<NFT
add counter inet filter pinhole_attempt { }
add counter inet filter pinhole_denied { }
add rule inet filter forward iifname "wan0" ip6 daddr 2001:db8:$number::2 ip6 saddr { 2001:db8:ffff::10, 2001:db8:ffff::11 } udp sport { 3478, 3479, 3480 } ct state established accept
add rule inet filter forward iifname "wan0" ip6 daddr 2001:db8:$number::2 meta l4proto udp counter name pinhole_attempt jump miniupnpd
add rule inet filter forward iifname "wan0" ip6 daddr 2001:db8:$number::2 meta l4proto udp counter name pinhole_denied drop
NFT
    # Admission is decided by the real gateway chain even after both peers sent checks.
    ip netns exec "$namespace" nft insert rule inet natlab forward iifname wan0 meta nfproto ipv6 meta l4proto udp accept
    ip netns exec "$namespace" nft -f - <<'NFT'
table inet v6_gateway_protocol {
  chain input {
    type filter hook input priority -20; policy accept;
    meta nfproto ipv4 udp dport { 1900, 5351 } drop
  }
}
NFT
  fi
  ip netns exec "$namespace" nft -f - <<'NFT'
add rule inet filter forward iifname "lan0" accept
add rule inet filter forward ct state established,related accept
add rule inet filter forward jump miniupnpd
NFT
  local external
  external=$(ip -n "$namespace" -j -4 address show dev wan0 | python3 -c '
import json, sys
addresses = [item["local"] for link in json.load(sys.stdin) for item in link.get("addr_info", []) if item.get("family") == "inet"]
if len(addresses) != 1:
    raise SystemExit("gateway requires one exact IPv4 address on wan0")
print(addresses[0])
')
  cat > "$STATE/$role-miniupnpd.conf" <<CONF
ext_ifname=wan0
ext_ifname6=wan0
ext_ip=$external
listening_ip=lan0
ipv6_disable=no
enable_upnp=$upnp
enable_pcp_pmp=$pcp
secure_mode=yes
ext_allow_private_ipv4=yes
uuid=3d3cec3a-8cf0-11e0-98ee-001a6bd2d0${number}b
CONF
  if [[ $protocol == pcpv6 ]]; then
    printf 'min_lifetime=120\nmax_lifetime=240\n' >> "$STATE/$role-miniupnpd.conf"
  fi
  if [[ $role == daemon ]]; then
    printf 'allow 24400 10.20.%s.0/24 24400\n' "$number" >> "$STATE/$role-miniupnpd.conf"
  fi
  cat >> "$STATE/$role-miniupnpd.conf" <<CONF
allow 30000-34999 10.20.$number.0/24 30000-34999
allow 40000-49999 10.20.$number.0/24 40000-49999
deny 0-65535 0.0.0.0/0 0-65535
CONF
  if [[ $protocol == pcp || $protocol == natpmp ]]; then
    local rejected=0
    [[ $protocol == natpmp ]] && rejected=2
    # PCP starts with version 2, NAT-PMP with version 0, after the UDP header.
    ip netns exec "$namespace" nft -f - <<NFT
table inet protocol_selection {
  chain input {
    type filter hook input priority -10; policy accept;
    udp dport 5351 @th,64,8 $rejected counter drop
  }
}
NFT
  fi
  ip netns exec "$namespace" miniupnpd -f "$STATE/$role-miniupnpd.conf" -d > "$STATE/$role-miniupnpd.log" 2>&1 &
  echo "$!" > "$STATE/$role-miniupnpd.pid"
  local ready=no
  for _ in $(seq 1 100); do
    if ip netns exec "$namespace" ss -lun | grep -Eq ':(5351|1900) '; then ready=yes; break; fi
    sleep 0.05
  done
  if [[ $ready != yes ]]; then cat "$STATE/$role-miniupnpd.log" >&2; return 1; fi
  if [[ $protocol == pcp || $protocol == natpmp ]]; then
    # A positive real epoch in the first native grant makes a subsequent reset observable.
    ip netns exec "merkur-natlab-$role" python3 "$SCRIPT_DIR/native-fault.py" epoch \
      "$protocol" "10.20.$number.2" "10.20.$number.1" 2 > "$STATE/$role-initial-epoch.txt"
  fi
}

inner_nat() {
  # Move the client's first-hop CPE behind one more independent PDF NAT.
  ip link del mw-client
  ip -n "$CLIENT_CPE" route flush default
  ip -n "$CLIENT_CPE" -6 route flush default
  namespace "$OUTER"
  veth "$CLIENT_CPE" wan0 "$OUTER" lan0 mi-client mi-outer
  ip -n "$CLIENT_CPE" addr add 172.30.2.2/24 dev wan0
  ip -n "$CLIENT_CPE" route add default via 172.30.2.1
  ip -n "$OUTER" addr add 172.30.2.1/24 dev lan0
  wan "$OUTER" mw-outer 198.51.100.2 2001:db8:ffff::2
  ip netns exec "$OUTER" sysctl -qw net.ipv4.ip_forward=1
  filter "$OUTER" 198.51.100.1 pdf no no
  mapping "$OUTER" 198.51.100.2 52000 eim 198.51.100.1 172.30.2.2 outer
}

same_lan() {
  # Put both endpoints on the daemon CPE's LAN. Its public-address input remains closed.
  ip -n "$CLIENT" link del eth0
  ip netns del "$CLIENT_CPE"
  ip -n "$DAEMON_CPE" link add lan-bridge type bridge
  ip -n "$DAEMON_CPE" link set lan-bridge up
  ip -n "$DAEMON_CPE" addr del 10.20.1.1/24 dev lan0
  ip -n "$DAEMON_CPE" link set lan0 master lan-bridge
  ip -n "$DAEMON_CPE" addr add 10.20.1.1/24 dev lan-bridge
  veth "$CLIENT" eth0 "$DAEMON_CPE" lan-client ml-client ml-router
  ip -n "$DAEMON_CPE" link set lan-client master lan-bridge
  ip -n "$CLIENT" addr add 10.20.1.3/24 dev eth0
  ip -n "$CLIENT" route add default via 10.20.1.1
  ip netns exec "$DAEMON_CPE" nft flush ruleset
  ip netns exec "$DAEMON_CPE" nft -f - <<'NFT'
table inet natlab {
  counter peer_drop { }
  counter hairpin_drop { }
  chain input {
    type filter hook input priority 0; policy accept;
    ip daddr 198.51.100.1 meta l4proto udp counter name hairpin_drop drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ip saddr 10.20.1.0/24 ip daddr 10.20.1.0/24 accept
    ct state established,related accept
    iifname "lan-bridge" accept
    iifname "lan0" accept
    iifname "lan-client" accept
    counter name peer_drop drop
  }
}
table ip natlab {
  chain postrouting { type nat hook postrouting priority srcnat; oifname "wan0" masquerade; }
}
NFT
}

setup() {
  local selected=$1 known=no item
  while read -r item; do [[ $item == "$selected" ]] && known=yes; done < <(cases)
  [[ $known == yes ]] || { echo "unknown native NAT topology: $selected" >&2; return 1; }
  teardown
  mkdir -p "$STATE"
  printf '%s\n' "$selected" > "$STATE/case"
  ip link add "$BRIDGE" type bridge
  ip link set "$BRIDGE" up
  ip addr add 198.51.100.254/24 dev "$BRIDGE"
  ip addr add 198.51.100.10/24 dev "$BRIDGE"
  ip addr add 198.51.100.11/24 dev "$BRIDGE"
  ip -6 addr add 2001:db8:ffff::254/64 dev "$BRIDGE" nodad
  ip -6 addr add 2001:db8:ffff::10/64 dev "$BRIDGE" nodad
  ip -6 addr add 2001:db8:ffff::11/64 dev "$BRIDGE" nodad
  sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
  # Peer probes to private candidates stay in the lab rather than following its container uplink.
  nft -f - <<'NFT'
table inet merkur_natlab {
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "merkur-wan" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } drop
  }
}
NFT
  pair daemon 1 "$DAEMON" "$DAEMON_CPE"
  pair client 2 "$CLIENT" "$CLIENT_CPE"
  local daemon_map=eim client_map=eim daemon_filter=pdf client_filter=pdf
  local block=no daemon_lease=no client_lease=no v6_role= v6_protocol=
  case "$selected" in
    blocked) block=yes ;;
    edm-daemon-eif) daemon_map=edm; client_filter=eif ;;
    edm-daemon-adf) daemon_map=edm; client_filter=adf ;;
    edm-client-eif) client_map=edm; daemon_filter=eif ;;
    edm-client-adf) client_map=edm; daemon_filter=adf ;;
    edm-pdf|inner-lease) daemon_map=edm ;;
    edm-both) daemon_map=edm; client_map=edm ;;
    client-lease-*) daemon_map=edm; client_lease=yes ;;
    daemon-lease-*) client_map=edm; daemon_lease=yes ;;
    ipv6-pdf) block=yes ;;
    ipv6-client-*|ipv6-daemon-*)
      block=yes
      v6_role=${selected#ipv6-}; v6_role=${v6_role%-*}
      v6_protocol=${selected##*-}
      ;;
  esac
  # Lease fixtures reserve the native local port outside the EIM generic public domain.
  # An EDM/lease combination needs a different allocation model and is not this matrix.
  if [[ $daemon_lease == yes && $daemon_map != eim || $client_lease == yes && $client_map != eim ]]; then
    echo 'native lease topology requires an EIM mapping on its lease-owning CPE' >&2
    return 1
  fi
  if [[ $selected == inner-lease ]]; then inner_nat; client_lease=yes; fi
  filter "$DAEMON_CPE" 198.51.100.2 "$daemon_filter" "$block" "$daemon_lease"
  filter "$CLIENT_CPE" 198.51.100.1 "$client_filter" "$block" "$client_lease"
  mapping "$DAEMON_CPE" 198.51.100.1 51000 "$daemon_map" 198.51.100.2 10.20.1.2
  local client_public=198.51.100.2
  [[ $selected == inner-lease ]] && client_public=172.30.2.2
  mapping "$CLIENT_CPE" "$client_public" 52000 "$client_map" 198.51.100.1 10.20.2.2
  if [[ $selected == ipv6-* ]]; then
    ipv6 1 "$DAEMON" "$DAEMON_CPE"
    ipv6 2 "$CLIENT" "$CLIENT_CPE"
  fi
  if [[ $daemon_lease == yes ]]; then miniupnpd daemon "$DAEMON_CPE" 1 "${selected##*-}"; fi
  if [[ $client_lease == yes ]]; then
    local protocol=${selected##*-}
    [[ $selected == inner-lease ]] && protocol=pcp
    miniupnpd client "$CLIENT_CPE" 2 "$protocol"
  fi
  if [[ -n $v6_role ]]; then
    local v6_number=1
    [[ $v6_role == client ]] && v6_number=2
    miniupnpd "$v6_role" "merkur-natlab-$v6_role-cpe" "$v6_number" "${v6_protocol}v6"
  fi
  [[ $selected != lan ]] || same_lan
  printf 'NATIVE_NATLAB_CASE=%s\nDAEMON_WT_PORT=%s\n' "$selected" "$DAEMON_PORT"
}

evidence() {
  local output=$1 role namespace
  mkdir -p "$output"
  for role in daemon client; do
    namespace="merkur-natlab-$role-cpe"
    if [[ $role == client && $(cat "$STATE/case") == lan ]]; then namespace=$DAEMON_CPE; fi
    ip netns exec "$namespace" conntrack -L -p udp -o extended > "$output/$role-conntrack.txt" 2>&1
    ip netns exec "$namespace" nft -j list ruleset > "$output/$role-nft.json"
  done
  cp -a "$STATE/." "$output/topology/"
  if ip netns list | grep -Eq "^$OUTER( |$)"; then
    ip netns exec "$OUTER" conntrack -L -p udp -o extended > "$output/outer-conntrack.txt" 2>&1
    ip netns exec "$OUTER" nft -j list ruleset > "$output/outer-nft.json"
  fi
}

[[ ${1:-} == cases ]] || require_container
case ${1:-} in
  cases) cases ;;
  setup) setup "${2:?native NAT case required}" ;;
  teardown) teardown ;;
  evidence) evidence "${2:?evidence directory required}" ;;
  boundary-filter) boundary_filter "${2:?boundary role required}" "${3:?boundary filter required}" ;;
  block-peer) block_peer ;;
  unblock-peer) unblock_peer ;;
  move-client) move_client ;;
  partition-established) partition_established ;;
  native-phase) native_phase ;;
  rebind-committed) rebind_committed ;;
  impair-peer|clear-impair|port-rebind|same-ip-route|gateway-reboot|clear-peer-flows) fault "$1" ;;
  wait-reacquired-lease) fault "$1" "${2:?lease role required}" ;;
  *) echo 'usage: native-topology.sh cases|setup CASE|teardown|evidence DIRECTORY|boundary-filter ROLE eif|adf|native-phase|block-peer|unblock-peer|move-client|partition-established|rebind-committed|impair-peer|clear-impair|port-rebind|same-ip-route|gateway-reboot|wait-reacquired-lease ROLE|clear-peer-flows' >&2; exit 2 ;;
esac
