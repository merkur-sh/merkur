#!/usr/bin/env python3
"""Generate deterministic EIM/EDM source-port translations for controlled socket ranges."""

import ipaddress
import sys


def port_map(base, offset, daemon):
    mapping = {port: base + offset + port - 40000 for port in range(40000, 50000)}
    mapping.update({port: 10000 + offset + port - 30000 for port in range(30000, 35000)})
    if daemon:
        mapping[40000] = 65000 + offset
        mapping[24400] = base + offset
    if len(set(mapping.values())) != len(mapping):
        raise ValueError("NAT translation is not injective")
    if any(local == external or not 0 < external <= 65535 for local, external in mapping.items()):
        raise ValueError("NAT translation must change every controlled port")
    return mapping


def render(public, base, dependent, peer):
    public = str(ipaddress.IPv4Address(public))
    peer = str(ipaddress.IPv4Address(peer))
    if base not in (51000, 52000):
        raise ValueError("unknown lab mapping range")
    profiles = [("ordinary", 0)]
    if dependent:
        profiles.extend([("first", 110), ("second", 120), ("peer", 130)])
    lines = ["table ip natlab {"]
    for name, offset in profiles:
        mapping = port_map(base, offset, base == 51000)
        lines.extend([
            f"  map {name} {{",
            "    type inet_service : inet_service;",
            "    elements = { " + ", ".join(f"{local} : {external}" for local, external in sorted(mapping.items())) + " }",
            "  }",
        ])
    lines.extend([
        "  chain prerouting { type nat hook prerouting priority -110; }",
        "  chain postrouting {",
        "    type nat hook postrouting priority 110;",
        # Coordination proxies own separate sockets. They do not consume native mappings.
        '    oifname "wan0" ip daddr 198.51.100.254 masquerade',
    ])
    if dependent:
        for target, name in [("198.51.100.10", "first"), ("198.51.100.11", "second"), (peer, "peer")]:
            lines.append(f'    oifname "wan0" ip daddr {target} meta l4proto udp snat to {public} : udp sport map @{name}')
    lines.extend([
        f'    oifname "wan0" meta l4proto udp snat to {public} : udp sport map @ordinary',
        '    oifname "wan0" masquerade',
        "  }",
        "}",
    ])
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    public, base, dependent, peer = sys.argv[1:]
    if dependent not in ("eim", "edm"):
        raise SystemExit("mapping must be eim or edm")
    sys.stdout.write(render(public, int(base), dependent == "edm", peer))
