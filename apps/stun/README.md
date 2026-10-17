# Merkur STUN responder

The responder is Merkur's ticketed STUN service. It answers authenticated Binding requests so
a daemon can learn its public address and classify the NAT in front of it. It holds no
terminal keys, keeps no per-source state, never dials anyone, and never relays terminal
traffic. This document covers the ticket model, the network layout a responder needs, its
configuration, and how to verify it locally.

## Ticket model

The application server issues short-lived tickets to daemons from `STUN_TICKET_KEY`. The
responder holds the same 64-byte master key as `MERKUR_STUN_TICKET_KEY` and verifies the HMAC
on every Binding request against it. Only the Rust daemon presents tickets; the browser never
talks to the responder.

Every rejection is silence. A request with a missing, forged, or expired ticket, a wrong
source, or malformed framing gets no response at all, so the responder cannot be used as a
reflector and reveals nothing about which tickets exist. Every Binding response is at most the
request's size.

## Network layout

NAT classification needs two independently routed public IP addresses on the same responder
host, plus one change-only port. Two ports, DNS names, replicas, or regions that share one
public address do not provide address independence, and a load balancer that rewrites both
addresses to one cannot either. `infer_nat_behavior` in the daemon calls a NAT
endpoint-independent only when observers on different addresses saw the same mapping, so the
server's `STUN_SERVERS` must name at least two IPv4 addresses, written `A:3478,B:3478`. IPv6
literals use brackets.

A responder on the box host is no observer for the boxes on it: they reach it over the host's
bridge without crossing their NAT. List its `STUN_SERVERS` entries in the server's
`BOX_HOST_STUN_OBSERVERS` too, and box daemons are handed the list without them.

The change-only port answers CHANGE-PORT requests and is never a mapping observer. It exists
because a CHANGE-PORT answer has to come from a port the daemon has never addressed: the
daemon's contact ledger discounts a reply from any endpoint it probed, and on a conntrack NAT
an unsolicited reply from a probed port is tracked as a flow before the daemon's own probe,
which then collides with it and is translated to a fresh external port. That reads an
endpoint-independent NAT as symmetric and withholds every reflexive candidate. A port nothing
dials cannot collide. The change-only port is never listed in `STUN_SERVERS`.

The operating system must own both addresses and preserve the selected source address on
outbound packets. Bind each address explicitly: a wildcard socket cannot identify an
independent source. Both addresses must belong to one process, because a changed-address
answer is sent from the sibling socket that process holds. The responder supports both
address families; each changed-address response, and the OTHER-ADDRESS attribute that
advertises it, stays within the request's family and is derived from the bound set rather
than configured. A container deployment must expose both addresses to the process without
source NAT; on Linux, host networking does that when the host owns them.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `MERKUR_STUN_TICKET_KEY` | required | Canonical base64url of the 64-byte master key; the same value as the server's `STUN_TICKET_KEY`, never a daemon's ticket secret. |
| `MERKUR_STUN_PORTS` | `3478,3479,3480` | Mapping-observer ports, bound on every address. |
| `MERKUR_STUN_CHANGE_PORTS` | unset | Change-only ports, bound on every address. A port present in both lists is refused at startup. |
| `MERKUR_STUN_BIND` | unset (wildcard) | Comma-separated explicit IP addresses to bind. Set it for any multi-address responder. |

Bazel builds the release binary from the workspace's lockfile and the vendored QUIC and
WebTransport patches, on Linux x86_64, and the release installs it on every host in
`deploy/service-hosts.json`:

```sh
bazel run --config=release //tools/bazel/release:service_binaries
```

On a host, `merkur-stun.service` runs it as a transient user with no capabilities and a
system-call filter, bound to the host's IPv4 and two addresses from its routed IPv6 /64, which
`merkur-stun-addrs.service` adds to the interface on every boot. Both read
`/etc/merkur/stun.env`, rendered per release by `scripts/service-hosts.ts`, and the ticket key
from `/etc/merkur/stun.secrets.env`, which never leaves the host. The server's `STUN_SERVERS`
for the hosts is `bun run service-hosts stun-servers`.

Allow inbound UDP to the listener ports, outbound UDP from them, and outbound QUIC from
ephemeral ports on both addresses with its reply traffic. The responder has no HTTP listener,
no public CA certificate, no terminal credential, and no configurable callback URL.

## Verify Locally

```sh
bash scripts/natlab/run-discovery.sh
```

Docker runs the real responder binary and a daemon listener in isolated Linux network
namespaces. The lab checks translated public ports, rebinding the mapping while the same
listener stays open, independent versus familiar observer evidence, address-restricted and
port-restricted filtering, a plain conntrack masquerade, lost changed-source responses, and
the absence of terminal-peer creation. It does not change the host firewall. Unit tests cover
forged responses, malformed framing, and responses never larger than their requests.
