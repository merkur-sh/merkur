#!/bin/sh
# Install the Fly egress backstop before dropping all privileges. Fail closed.
set -eu
umask 077

rate="${MERKUR_STUN_EGRESS_RATE_MBIT:-}"
case "$rate" in
  '' | *[!0-9]* | 0*)
    echo "merkur-stun-entrypoint: MERKUR_STUN_EGRESS_RATE_MBIT must be a positive integer (Mbit/s), got '$rate'" >&2
    exit 1
    ;;
esac

# Metering and shaping must name the same interface explicitly.
iface="${MERKUR_STUN_EGRESS_INTERFACE:?MERKUR_STUN_EGRESS_INTERFACE is required}"
ip link show dev "$iface" >/dev/null

# Ten milliseconds of the ceiling as burst (rate in Mbit/s × 1250 bytes): a
# redraw's packet train leaves at line rate, and only sustained traffic above
# the ceiling is shaped. HTB's computed default is one MTU, which would pace
# every multi-packet frame even far below the cap.
burst=$((rate * 1250))
tc qdisc replace dev "$iface" root handle 1: htb default 1
tc class replace dev "$iface" parent 1: classid 1:1 htb rate "${rate}mbit" ceil "${rate}mbit" \
  burst "$burst" cburst "$burst" quantum 1514
tc qdisc replace dev "$iface" parent 1:1 handle 10: fq_codel
echo "merkur-stun-entrypoint: egress on $iface capped at ${rate} Mbit/s" >&2

exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all --ambient-caps=-all \
  --bounding-set=-all --no-new-privs "$@"
