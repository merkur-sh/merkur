#!/bin/sh
# Installs the edge host's aggregate egress ceiling with `tc`. `merkur-edge.service`
# runs it with full privileges (`ExecStartPre=+`) before every start of the relay,
# which itself runs with none.
#
# The ceiling is the host's line rate, a backstop rather than a budget: the edge's
# monthly ledger (`MERKUR_EDGE_DATA_BUDGET_GB`) is what keeps a month inside the
# host's included traffic. The rate comes from `MERKUR_EDGE_EGRESS_RATE_MBIT`,
# rendered per host from deploy/service-hosts.json. It is required: an edge that
# cannot install its cap does not start, rather than starting uncapped.
#
# HTB holds the aggregate ceiling; fq_codel under it keeps queues short when the
# ceiling binds, so a flood on one session does not add standing delay to
# another. Below the ceiling HTB adds no queueing at all.
#
# Every start builds the tree from nothing. The host keeps its qdiscs across
# restarts of the relay, and the kernel refuses to change an existing HTB root in
# place ("Change operation not supported by specified qdisc"), so the root this
# script installed last time is removed first. Any other root is replaced.
set -eu

rate="${MERKUR_EDGE_EGRESS_RATE_MBIT:-}"
case "$rate" in
  '' | *[!0-9]* | 0*)
    echo "edge-egress-cap: MERKUR_EDGE_EGRESS_RATE_MBIT must be a positive integer (Mbit/s), got '$rate'" >&2
    exit 1
    ;;
esac

# Metering and shaping must name the same interface explicitly.
iface="${MERKUR_EDGE_EGRESS_INTERFACE:?MERKUR_EDGE_EGRESS_INTERFACE is required}"
ip link show dev "$iface" >/dev/null

if tc qdisc show dev "$iface" root | grep -q '^qdisc htb 1: root'; then
  tc qdisc del dev "$iface" root
fi

# Ten milliseconds of the ceiling as burst (rate in Mbit/s × 1250 bytes): a
# redraw's packet train leaves at line rate, and only sustained traffic above
# the ceiling is shaped. HTB's computed default is one MTU, which would pace
# every multi-packet frame even far below the cap.
burst=$((rate * 1250))
tc qdisc replace dev "$iface" root handle 1: htb default 1
tc class add dev "$iface" parent 1: classid 1:1 htb rate "${rate}mbit" ceil "${rate}mbit" \
  burst "$burst" cburst "$burst" quantum 1514
tc qdisc add dev "$iface" parent 1:1 handle 10: fq_codel
echo "edge-egress-cap: egress on $iface capped at ${rate} Mbit/s" >&2
