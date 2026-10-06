#!/bin/sh
# merkur-edge container entrypoint. Runs as root only long enough to:
#
#   1. cap the replica's aggregate egress with `tc`, and
#   2. repair ownership of the identity volume Fly mounts as root,
#
# then drops to UID 10001 with every capability and supplementary group gone
# before the relay binds anything.
#
# The cap is a backstop on the bill, not a budget. Fly bills egress by the byte
# and offers no spending limit, so the worst month a replica can cost is its
# egress rate times the seconds in a month, whatever the relay itself does. The
# rate comes from `MERKUR_EDGE_EGRESS_RATE_MBIT`, rendered per replica from
# apps/edge/replicas.json. It is required: a replica that cannot install its cap
# does not start, rather than starting uncapped.
#
# HTB holds the aggregate ceiling; fq_codel under it keeps queues short when the
# ceiling binds, so a flood on one session does not add standing delay to
# another. Below the ceiling HTB adds no queueing at all.
set -eu
umask 077

rate="${MERKUR_EDGE_EGRESS_RATE_MBIT:-}"
case "$rate" in
  '' | *[!0-9]* | 0*)
    echo "merkur-edge-entrypoint: MERKUR_EDGE_EGRESS_RATE_MBIT must be a positive integer (Mbit/s), got '$rate'" >&2
    exit 1
    ;;
esac

# Metering and shaping must name the same interface explicitly.
iface="${MERKUR_EDGE_EGRESS_INTERFACE:?MERKUR_EDGE_EGRESS_INTERFACE is required}"
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
echo "merkur-edge-entrypoint: egress on $iface capped at ${rate} Mbit/s" >&2

chown -R -P --no-dereference 10001:10001 /data
exec setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all --ambient-caps=-all \
  --bounding-set=-all --no-new-privs "$@"
