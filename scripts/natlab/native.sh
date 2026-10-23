#!/usr/bin/env bash
# This script runs only inside the disposable privileged Linux test container.
set -euo pipefail
LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
evidence=/evidence
children=()
captures=()

stop_children() {
  for pid in "${captures[@]}"; do kill -INT "$pid" 2>/dev/null || true; done
  for pid in "${captures[@]}"; do wait "$pid" 2>/dev/null || true; done
  captures=()
  for pid in "${children[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${children[@]}"; do wait "$pid" 2>/dev/null || true; done
  children=()
  rm -f /tmp/merkur-native-topology/proxy-*.pid
}

cleanup() {
  stop_children
  bash "$LAB_DIR/native-topology.sh" teardown
}
trap cleanup EXIT

ready() {
  local pid="$1" file="$2" marker="$3"
  for attempt in $(seq 1 500); do
    kill -0 "$pid" 2>/dev/null || { cat "$file" >&2; return 1; }
    if grep -qF "$marker" "$file"; then return 0; fi
    sleep 0.02
  done
  echo "natlab: readiness event absent: $marker" >&2
  cat "$file" >&2
  return 1
}

proxy() {
  local name="$1" namespace="$2" protocol="$3" listen="$4" target="$5" directory="$6"
  if [ -n "$namespace" ]; then
    ip netns exec "$namespace" python3 "$LAB_DIR/forward.py" "$protocol" "$listen" "$target" > "$directory/$name.log" 2>&1 &
  else
    python3 "$LAB_DIR/forward.py" "$protocol" "$listen" "$target" > "$directory/$name.log" 2>&1 &
  fi
  local pid=$!
  printf '%s\n' "$pid" > "/tmp/merkur-native-topology/proxy-$name.pid"
  children+=("$pid")
  ready "$pid" "$directory/$name.log" NATLAB_PROXY_READY
}

cases=("$@")
if [ "${#cases[@]}" -eq 0 ]; then
  while IFS= read -r topology; do cases+=("$topology"); done < <(bash "$LAB_DIR/native-topology.sh" cases)
fi

export STUN_TICKET_KEY="$(bun -e 'process.stdout.write(Buffer.alloc(64, 0x72).toString("base64url"))')"
export MERKUR_STUN_TICKET_KEY="$STUN_TICKET_KEY"
export MERKUR_E2E_DAEMON_NETNS=merkur-natlab-daemon
export MERKUR_E2E_CLIENT_NETNS=merkur-natlab-client
export PW_E2E_GPU=swiftshader FORCE_EDGE=0
PYTHONDONTWRITEBYTECODE=1 python3 "$LAB_DIR/native-topology.test.py"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$LAB_DIR" -p 'test_*.py'
bash "$LAB_DIR/native-topology.sh" setup eim-pdf
python3 "$LAB_DIR/native-cpe-boundary.py" pdf "$evidence/cpe-boundary-pdf.json"
bash "$LAB_DIR/native-topology.sh" teardown
for filtering in eif adf; do
  bash "$LAB_DIR/native-topology.sh" setup edm-daemon-eif
  bash "$LAB_DIR/native-topology.sh" boundary-filter daemon "$filtering"
  python3 "$LAB_DIR/native-cpe-boundary.py" "$filtering" "$evidence/cpe-boundary-$filtering.json"
  bash "$LAB_DIR/native-topology.sh" teardown
done

for topology in "${cases[@]}"; do
  directory="$evidence/$topology"
  bash "$LAB_DIR/native-topology.sh" setup "$topology"
  mkdir -p "$directory"
  export MERKUR_NATLAB_CASE="$topology" PW_E2E_OUTPUT_DIR="$directory/playwright"
  if [ "$topology" = ipv6-pdf ]; then
    export MERKUR_STUN_BIND=198.51.100.10,198.51.100.11,2001:db8:ffff::10,2001:db8:ffff::11
    export STUN_SERVERS='198.51.100.10:3478,198.51.100.11:3478,[2001:db8:ffff::10]:3478,[2001:db8:ffff::11]:3478'
  else
    export MERKUR_STUN_BIND=198.51.100.10,198.51.100.11
    export STUN_SERVERS=198.51.100.10:3478,198.51.100.11:3478
  fi
  export MERKUR_STUN_PORTS=3478,3479 MERKUR_STUN_CHANGE_PORTS=3480
  /natlab/merkur-stun > "$directory/stun.log" 2>&1 &
  children+=("$!")
  ready "$!" "$directory/stun.log" 'stun: listening'
  proxy origin '' tcp 198.51.100.254:24332 127.0.0.1:24331 "$directory"
  for role in daemon client; do
    proxy "$role-origin" "merkur-natlab-$role" tcp 127.0.0.1:24331 198.51.100.254:24332 "$directory"
    proxy "$role-relay" "merkur-natlab-$role" udp 127.0.0.1:4433 198.51.100.254:4433 "$directory"
  done
  tcpdump -i merkur-wan -n -s 0 -U -w "$directory/wan.pcap" udp 2> "$directory/wan.stderr" &
  captures+=("$!")
  ready "$!" "$directory/wan.stderr" 'listening on'
  ip netns exec merkur-natlab-client tcpdump -i any -n -s 0 -U -w "$directory/client.pcap" udp 2> "$directory/client.stderr" &
  captures+=("$!")
  ready "$!" "$directory/client.stderr" 'listening on'
  status=0
  bun run "$LAB_DIR/run-native.ts" > >(tee "$directory/session.log") 2> >(tee "$directory/session.stderr" >&2) || status=$?
  bash "$LAB_DIR/native-topology.sh" evidence "$directory"
  stop_children
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  python3 "$LAB_DIR/verify-native.py" --case "$topology" --capture "$directory/wan.pcap" \
    --peer-capture "$directory/client.pcap" --state "$directory" | tee "$directory/verified.json"
  bash "$LAB_DIR/native-topology.sh" teardown
done
echo 'NATIVE_NATLAB=PASS'
