#!/usr/bin/env python3
"""Generate the controlled CPE's bijective forward and reverse NAT translations."""

import ipaddress
import sys

UNCONTROLLED_PORTS = range(62000, 64000)


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


def outer_port_map():
    # The second CPE sees the first CPE's translated ports, not the host's socket ports.
    inner = port_map(52000, 0, False)
    return {translated: (20000 + local - 40000 if local >= 40000 else 35000 + local - 30000)
            for local, translated in inner.items()}


def inverse(mapping):
    result = {external: local for local, external in mapping.items()}
    if len(result) != len(mapping):
        raise ValueError("reverse NAT translation is not injective")
    return result


def profile_maps(base, dependent, outer=False):
    if outer:
        return {"ordinary": outer_port_map()}
    if not dependent:
        return {"ordinary": port_map(base, 0, base == 51000)}
    # Every inside binding owns four globally distinct external slots. Destination
    # selection changes mapping; permission to use any slot remains a filter decision.
    locals_ = list(range(40000, 50000)) + list(range(30000, 35000))
    if base == 51000:
        locals_.append(24400)
    names = ("ordinary", "first", "second", "peer")
    profiles = {name: {local: 1 + 4 * index + slot for index, local in enumerate(locals_)}
                for slot, name in enumerate(names)}
    if base == 51000:
        owners = {external: (name, local) for name, ports in profiles.items()
                  for local, external in ports.items()}
        # Preserve the fixture's main-listener tuples by swapping complete ownership.
        for name, desired in zip(names, (51000, 51110, 51120, 51130)):
            previous = profiles[name][24400]
            owner_name, owner_local = owners[desired]
            profiles[owner_name][owner_local] = previous
            profiles[name][24400] = desired
            owners[previous] = (owner_name, owner_local)
            owners[desired] = (name, 24400)
    values = [external for ports in profiles.values() for external in ports.values()]
    if len(values) != len(set(values)) or any(not 0 < port <= 65535 for port in values):
        raise ValueError("EDM profiles do not own globally unique UDP slots")
    if any(local == external for ports in profiles.values() for local, external in ports.items()):
        raise ValueError("EDM translation must change every controlled port")
    return profiles


def render(public, base, dependent, peer, inside, outer=False):
    public = str(ipaddress.IPv4Address(public))
    peer = str(ipaddress.IPv4Address(peer))
    inside = str(ipaddress.IPv4Address(inside))
    if base not in (51000, 52000):
        raise ValueError("unknown lab mapping range")
    if outer and (base != 52000 or dependent):
        raise ValueError("the controlled outer CPE requires the client's EIM mapping")
    profiles = profile_maps(base, dependent, outer)
    lines = ["table ip natlab {"]
    lines.extend([
        "  map inside {",
        "    type ipv4_addr : ipv4_addr;",
        f"    elements = {{ {public} : {inside} }}",
        "  }",
    ])
    reverse = {}
    for mapping in profiles.values():
        reverse.update(inverse(mapping))
    reverse_name = "reverse_all" if dependent else "reverse_ordinary"
    uncontrolled = f"{UNCONTROLLED_PORTS.start}-{UNCONTROLLED_PORTS.stop - 1}"
    for name, entries in [*profiles.items(), (reverse_name, reverse)]:
        lines.extend([
            f"  map {name} {{",
            "    type inet_service : inet_service;",
            "    elements = { " + ", ".join(f"{key} : {value}" for key, value in sorted(entries.items())) + " }",
            "  }",
        ])
    targets = [("198.51.100.10", "first"), ("198.51.100.11", "second"), (peer, "peer")]
    lines.extend([
        # Real miniupnpd grants at dstnat/-100 take precedence over the generic static map.
        "  chain prerouting {",
        "    type nat hook prerouting priority -90;",
    ])
    lines.extend([
        f'    iifname "wan0" ip daddr {public} meta l4proto udp udp dport map @{reverse_name} != 0 ct mark set 1 dnat to ip daddr map @inside : udp dport map @{reverse_name}',
        "  }",
        "  chain postrouting {",
        "    type nat hook postrouting priority 110;",
        # Coordination proxies own separate sockets. They do not consume native mappings.
        f'    oifname "wan0" ip daddr 198.51.100.254 meta l4proto {{ tcp, udp }} masquerade to :{uncontrolled}',
    ])
    if dependent:
        for target, name in targets:
            lines.append(f'    oifname "wan0" ip daddr {target} meta l4proto udp snat to {public} : udp sport map @{name}')
    excluded = "ip daddr != { " + ", ".join(target for target, _ in targets) + " } " if dependent else ""
    lines.extend([
        f'    oifname "wan0" {excluded}meta l4proto udp snat to {public} : udp sport map @ordinary',
        f'    oifname "wan0" meta l4proto {{ tcp, udp }} masquerade to :{uncontrolled}',
        '    oifname "wan0" masquerade',
        "  }",
        "}",
    ])
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    public, base, dependent, peer, inside, *layer = sys.argv[1:]
    if dependent not in ("eim", "edm"):
        raise SystemExit("mapping must be eim or edm")
    if layer not in ([], ["outer"]):
        raise SystemExit("only the explicit outer CPE layer is supported")
    sys.stdout.write(render(public, int(base), dependent == "edm", peer, inside, bool(layer)))
