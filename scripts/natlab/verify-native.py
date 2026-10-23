#!/usr/bin/env python3
"""Verify a real-session NAT capture without printing credentials or packet bodies.

The Playwright fixture proves session authentication and terminal I/O. This verifier proves
the separate network fact: the peer checks and admitted QUIC used the same socket mapping.
It checks STUN framing and request/response correlation, not the secret HMAC itself.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
import ipaddress
import json
from pathlib import Path
import re
import struct
import sys
import time
from typing import Any


class VerificationError(Exception):
    """The retained evidence does not establish the claimed network result."""


Endpoint = tuple[str, int]
Pair = tuple[Endpoint, Endpoint]

DAEMON4 = "198.51.100.1"
CLIENT4 = "198.51.100.2"
DAEMON6 = "2001:db8:1::2"
CLIENT6 = "2001:db8:2::2"
DAEMON_LAN = "10.20.1.2"
CLIENT_LAN = "10.20.1.3"
COOKIE = bytes.fromhex("2112a442")
MAX_CHECK_PAIRS = 2 * 10 * 10

POSITIVE_CASES = {
    "eim-pdf", "edm-daemon-eif", "edm-daemon-adf", "edm-client-eif", "edm-client-adf",
    "client-lease-pcp", "client-lease-natpmp", "client-lease-upnp",
    "daemon-lease-pcp", "daemon-lease-natpmp", "daemon-lease-upnp", "ipv6-pdf", "lan",
}
NEGATIVE_CASES = {"blocked", "edm-pdf", "edm-both", "inner-lease"}


@dataclass(frozen=True)
class Packet:
    timestamp_ns: int
    source: Endpoint
    destination: Endpoint
    payload: bytes


@dataclass(frozen=True)
class Capture:
    packets: tuple[Packet, ...]
    records: int


@dataclass(frozen=True)
class Check:
    transaction: bytes
    request: bool
    direction: str | None
    context: bytes | None
    mapped: Endpoint | None


@dataclass(frozen=True)
class RoundTrip:
    request: Packet
    response: Packet
    direction: str


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def canonical_ip(raw: bytes) -> str:
    address = ipaddress.ip_address(raw)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)
    return str(address)


def decode_link(frame: bytes, link_type: int) -> tuple[int, bytes] | None:
    if link_type == 1:  # Ethernet, including VLAN tags.
        require(len(frame) >= 14, "truncated Ethernet header")
        protocol = struct.unpack_from("!H", frame, 12)[0]
        cursor = 14
        while protocol in {0x8100, 0x88A8, 0x9100}:
            require(cursor + 4 <= len(frame), "truncated Ethernet VLAN header")
            protocol = struct.unpack_from("!H", frame, cursor + 2)[0]
            cursor += 4
        return protocol, frame[cursor:]
    if link_type == 113:  # Linux cooked capture v1.
        require(len(frame) >= 16, "truncated Linux cooked header")
        return struct.unpack_from("!H", frame, 14)[0], frame[16:]
    if link_type == 276:  # Linux cooked capture v2 (`tcpdump -i any`).
        require(len(frame) >= 20, "truncated Linux cooked v2 header")
        return struct.unpack_from("!H", frame, 0)[0], frame[20:]
    if link_type == 101:  # Raw IP.
        require(bool(frame), "empty raw-IP frame")
        return (0x0800 if frame[0] >> 4 == 4 else 0x86DD), frame
    raise VerificationError(f"unsupported PCAP link type {link_type}")


def udp_packet(frame: bytes, link_type: int, timestamp_ns: int) -> Packet | None:
    decoded = decode_link(frame, link_type)
    if decoded is None:
        return None
    protocol, body = decoded
    if protocol == 0x0800:
        require(len(body) >= 20 and body[0] >> 4 == 4, "truncated or invalid IPv4 header")
        header_len = (body[0] & 15) * 4
        total_len = struct.unpack_from("!H", body, 2)[0]
        require(header_len >= 20 and header_len <= total_len <= len(body), "invalid IPv4 length")
        if body[9] != 17:
            return None
        require(struct.unpack_from("!H", body, 6)[0] & 0x3FFF == 0,
                "fragmented UDP cannot establish a complete peer exchange")
        source, destination = canonical_ip(body[12:16]), canonical_ip(body[16:20])
        datagram = body[header_len:total_len]
    elif protocol == 0x86DD:
        require(len(body) >= 40 and body[0] >> 4 == 6, "truncated or invalid IPv6 header")
        total_len = 40 + struct.unpack_from("!H", body, 4)[0]
        require(total_len <= len(body), "truncated IPv6 packet")
        source, destination = canonical_ip(body[8:24]), canonical_ip(body[24:40])
        next_header, cursor = body[6], 40
        while next_header in {0, 43, 60, 51}:
            require(cursor + 2 <= total_len, "truncated IPv6 extension header")
            extension_len = (body[cursor + 1] + (2 if next_header == 51 else 1)) * (
                4 if next_header == 51 else 8)
            require(cursor + extension_len <= total_len, "invalid IPv6 extension length")
            next_header, cursor = body[cursor], cursor + extension_len
        require(next_header != 44, "fragmented IPv6 cannot establish a complete peer exchange")
        if next_header != 17:
            return None
        datagram = body[cursor:total_len]
    else:
        return None
    require(len(datagram) >= 8, "truncated UDP header")
    source_port, destination_port, length, _ = struct.unpack_from("!HHHH", datagram)
    require(8 <= length <= len(datagram), "invalid UDP length")
    return Packet(timestamp_ns, (source, source_port), (destination, destination_port),
                  datagram[8:length])


def read_capture(path: Path, live: bool = False) -> Capture:
    with path.open("rb") as stream:
        header = stream.read(24)
        require(len(header) == 24, f"{path.name}: truncated PCAP header")
        formats = {
            b"\xd4\xc3\xb2\xa1": ("<", 1000), b"\xa1\xb2\xc3\xd4": (">", 1000),
            b"\x4d\x3c\xb2\xa1": ("<", 1), b"\xa1\xb2\x3c\x4d": (">", 1),
        }
        require(header[:4] in formats, f"{path.name}: unsupported PCAP magic")
        order, fraction_scale = formats[header[:4]]
        major, minor, _, _, snaplen, network = struct.unpack(order + "HHIIII", header[4:])
        require((major, minor) == (2, 4) and snaplen > 0, "unsupported PCAP header")
        link_type = network & 0xFFFF
        records = 0
        packets: list[Packet] = []
        while record := stream.read(16):
            if live and len(record) < 16:
                break
            require(len(record) == 16, f"{path.name}: truncated PCAP record header")
            seconds, fraction, captured_len, original_len = struct.unpack(order + "IIII", record)
            require(captured_len == original_len and captured_len <= snaplen,
                    f"{path.name}: a packet was truncated by the capture snap length")
            frame = stream.read(captured_len)
            if live and len(frame) < captured_len:
                break
            require(len(frame) == captured_len, f"{path.name}: truncated PCAP packet")
            records += 1
            packet = udp_packet(frame, link_type, seconds * 1_000_000_000 + fraction * fraction_scale)
            if packet is not None:
                packets.append(packet)
    return Capture(tuple(packets), records)


def wait_for_rebind_context(case: str, captures: list[Path], state: Path) -> dict[str, Any]:
    require(case == "eim-pdf", "committed-rebind observation requires the EIM topology")
    lifecycle = json.loads((state / "topology" / "lifecycle.json").read_text())
    event_interval(lifecycle, "carriersPartitionedAtNs", "rebindCommittedAtNs")
    deadline = time.monotonic() + 30
    while True:
        packets = [packet for path in captures for packet in read_capture(path, live=True).packets]
        trips, _ = round_trips(packets, case)
        if successor_trips(lifecycle, packets, trips):
            return {"case": case, "rebindFreshContextObserved": True}
        remaining = deadline - time.monotonic()
        require(remaining > 0, "no fresh successor client-check round trip followed the committed rebind")
        time.sleep(min(0.05, remaining))


def wait_for_port_rebind(case: str, captures: list[Path], state: Path) -> dict[str, Any]:
    require(case == "eim-pdf", "port-rebind observation requires the EIM topology")
    lifecycle = json.loads((state / "topology" / "lifecycle.json").read_text())
    rebind_pairs(lifecycle)
    marker = lifecycle.get("nativeSessionsStartedAtNs")
    require(isinstance(marker, int) and not isinstance(marker, bool) and marker > 0,
            "port-rebind observation has no native-session phase boundary")
    deadline = time.monotonic() + 30
    while True:
        packets = [packet for path in captures for packet in read_capture(path, live=True).packets
                   if packet.timestamp_ns >= marker]
        trips, _ = round_trips(packets, case)
        if port_rebind_packet_proof(lifecycle, quic_packets(packets, case, lifecycle), trips, case) is not None:
            return {"case": case, "portRebindObserved": True}
        remaining = deadline - time.monotonic()
        require(remaining > 0, "port rebind has no checked handshake or previous-CID continuity")
        time.sleep(min(0.05, remaining))


def verify_capture_summary(path: Path, records: int) -> None:
    text = path.read_text()
    captured = re.findall(r"(?m)^(\d+) packets? captured\s*$", text)
    dropped = re.findall(r"(?m)^(\d+) packets? dropped by (kernel|interface)\s*$", text)
    require(len(captured) == 1 and int(captured[0]) == records,
            f"{path.name}: capture summary and retained records disagree")
    require(any(kind == "kernel" for _, kind in dropped),
            f"{path.name}: no completed kernel-drop summary")
    require(all(int(count) == 0 for count, _ in dropped), f"{path.name}: capture dropped packets")


def xor_address(value: bytes, transaction: bytes) -> Endpoint | None:
    if len(value) < 4 or value[0] != 0:
        return None
    family, port = value[1], struct.unpack_from("!H", value, 2)[0] ^ 0x2112
    if port == 0 or (family, len(value)) not in {(1, 8), (2, 20)}:
        return None
    mask = COOKIE + transaction
    raw = bytes(a ^ b for a, b in zip(value[4:], mask))
    return canonical_ip(raw), port


def peer_check(payload: bytes) -> Check | None:
    if not 56 <= len(payload) <= 1200 or len(payload) % 4 != 0 or payload[4:8] != COOKIE:
        return None
    message_type, length = struct.unpack_from("!HH", payload)
    if message_type not in {0x0001, 0x0101} or length + 20 != len(payload):
        return None
    transaction = payload[8:20]
    cursor = 20
    username = None
    mapped = None
    integrity = False
    while cursor < len(payload):
        if integrity or cursor + 4 > len(payload):
            return None
        kind, size = struct.unpack_from("!HH", payload, cursor)
        value_start, value_end = cursor + 4, cursor + 4 + size
        padded_end = value_start + ((size + 3) & ~3)
        if padded_end > len(payload):
            return None
        value = payload[value_start:value_end]
        if kind == 0x0006:
            if username is not None:
                return None
            username = value
        elif kind == 0x0020:
            if mapped is not None:
                return None
            mapped = xor_address(value, transaction)
            if mapped is None:
                return None
        elif kind == 0x001C:
            if size != 32 or padded_end != len(payload):
                return None
            integrity = True
        elif kind != 0x0026 and kind < 0x8000:
            return None
        cursor = padded_end
    if not integrity:
        return None
    if message_type == 0x0001:
        if username is None or re.fullmatch(rb"[0-9a-f]{32}:[cd]", username) is None or mapped is not None:
            return None
        return Check(transaction, True, chr(username[33]), username[:32], None)
    if username is not None or mapped is None:
        return None
    return Check(transaction, False, None, None, mapped)


def quic_long_header(payload: bytes) -> tuple[bytes, bytes] | None:
    # Quinn advertises RFC 9287 and may clear the fixed bit. The long-header
    # form, version and connection IDs remain visible without terminal keys.
    if len(payload) < 21 or payload[0] & 0x80 == 0:
        return None
    version = struct.unpack_from("!I", payload, 1)[0]
    if version not in {1, 0x6B3343CF}:
        return None
    destination_len = payload[5]
    source_len_pos = 6 + destination_len
    if destination_len > 20 or source_len_pos >= len(payload):
        return None
    source_len = payload[source_len_pos]
    if source_len > 20 or source_len_pos + 1 + source_len > len(payload):
        return None
    return payload[6:source_len_pos], payload[source_len_pos + 1:source_len_pos + 1 + source_len]


def quic_packets(packets: list[Packet], case: str,
                 lifecycle: dict[str, Any] | None = None) -> list[Packet]:
    # A CID identifies the endpoint across a NAT source-port change. Keeping the
    # tuple out of this key detects migrated packets; admission below still
    # requires checks or the exact controlled migration's socket evidence.
    connection_ids: dict[str, set[bytes]] = defaultdict(set)
    result: list[Packet] = []
    migration = rebind_pairs(lifecycle) if lifecycle is not None and "portRebind" in lifecycle else None
    migration_client_seen = False
    for packet in sorted(packets, key=lambda value: value.timestamp_ns):
        pair = oriented_pair(packet, case)
        if pair is None:
            continue
        header = quic_long_header(packet.payload)
        if header is not None:
            destination_id, source_id = header
            if destination_id:
                connection_ids[packet.destination[0]].add(destination_id)
            if source_id:
                connection_ids[packet.source[0]].add(source_id)
            result.append(packet)
        elif (len(packet.payload) >= 21 and packet.payload[0] & 0x80 == 0
              and any(packet.payload[1:].startswith(connection_id)
                      for connection_id in connection_ids[packet.destination[0]])):
            result.append(packet)
            if (migration is not None and pair == migration[1] and packet.source == pair[1]
                    and packet.timestamp_ns >= migration[3]):
                migration_client_seen = True
        elif (migration is not None and migration_client_seen and pair == migration[1]
              and packet.source == pair[0] and packet.timestamp_ns >= migration[3]
              and len(packet.payload) >= 21 and packet.payload[0] & 0x80 == 0
              and packet.payload[4:8] != COOKIE):
            # Quinn switches to an unused CID when it validates a peer's migrated
            # address. Its NEW_CONNECTION_ID was encrypted. Only this controlled
            # receiver tuple, after a client packet retaining the old server CID,
            # admits that opaque short header; verify_port_rebind additionally
            # requires both unchanged private sockets. The companion real-session
            # assertion proves sealed terminal I/O on a Direct provider after
            # the controlled socket migration.
            result.append(packet)
    return result


def oriented_pair(packet: Packet, case: str) -> Pair | None:
    daemon, client = (DAEMON_LAN, CLIENT_LAN) if case == "lan" else (
        (DAEMON6, CLIENT6) if case == "ipv6-pdf" else (DAEMON4, CLIENT4))
    if (packet.source[0], packet.destination[0]) == (daemon, client):
        return packet.source, packet.destination
    if (packet.source[0], packet.destination[0]) == (client, daemon):
        return packet.destination, packet.source
    return None


def round_trips(packets: list[Packet], case: str) -> tuple[list[RoundTrip], int]:
    requests: dict[tuple[Endpoint, Endpoint, bytes], list[tuple[Packet, Check]]] = defaultdict(list)
    responses: dict[tuple[Endpoint, Endpoint, bytes], list[tuple[Packet, Check]]] = defaultdict(list)
    targets: dict[tuple[bytes, str], set[Endpoint]] = defaultdict(set)
    request_count = 0
    for packet in packets:
        pair = oriented_pair(packet, case)
        if pair is None:
            continue
        check = peer_check(packet.payload)
        if check is None:
            continue
        key = packet.source, packet.destination, check.transaction
        if check.request:
            expected = "d" if packet.source == pair[0] else "c"
            require(check.direction == expected, "peer check's direction does not match its sender")
            require(check.context is not None, "peer request has no context")
            targets[(check.context, expected)].add(packet.destination)
            request_count += 1
            requests[key].append((packet, check))
        else:
            responses[key].append((packet, check))
    require(all(len(values) <= MAX_CHECK_PAIRS for values in targets.values()),
            "peer checks exceeded the candidate-pair resource bound")
    result: list[RoundTrip] = []
    for (source, destination, transaction), sent in requests.items():
        for response, check in responses.get((destination, source, transaction), []):
            for request, request_check in sent:
                if (request.timestamp_ns <= response.timestamp_ns and check.mapped == source
                        and len(response.payload) <= len(request.payload)):
                    result.append(RoundTrip(request, response, request_check.direction or ""))
                    break
    return result, request_count


def daemon_check_targets(packets: list[Packet], case: str) -> set[Pair]:
    targets: set[Pair] = set()
    for packet in packets:
        pair = oriented_pair(packet, case)
        if pair is None or packet.source != pair[0]:
            continue
        check = peer_check(packet.payload)
        if check is not None and check.request and check.direction == "d":
            targets.add(pair)
    return targets


def named_drop_count(path: Path, name: str = "peer_drop") -> int:
    contents = json.loads(path.read_text())
    count = 0

    def visit(value: Any) -> None:
        nonlocal count
        if isinstance(value, dict):
            counter = value.get("counter")
            if isinstance(counter, dict) and counter.get("name") == name:
                packets = counter.get("packets")
                if isinstance(packets, int) and not isinstance(packets, bool) and packets >= 0:
                    count += packets
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(contents)
    return count


def conntrack_translation(path: Path, own: Endpoint, peer: Endpoint, private_ips: set[str],
                          require_translation: bool = True) -> dict[str, Any]:
    for line in path.read_text().splitlines():
        if re.search(r"\budp\b", line) is None:
            continue
        fields: dict[str, list[str]] = defaultdict(list)
        for key, value in re.findall(r"\b(src|dst|sport|dport)=([^\s]+)", line):
            fields[key].append(value)
        if any(len(fields[key]) != 2 for key in ("src", "dst", "sport", "dport")):
            continue
        try:
            original_source = fields["src"][0], int(fields["sport"][0])
            original_destination = fields["dst"][0], int(fields["dport"][0])
            reply_source = fields["src"][1], int(fields["sport"][1])
            reply_destination = fields["dst"][1], int(fields["dport"][1])
        except ValueError:
            continue
        local_port = None
        private_ip = None
        if (original_source[0] in private_ips and original_destination == peer
                and reply_source == peer and reply_destination == own):
            local_port = original_source[1]
            private_ip = original_source[0]
        elif (original_source == peer and original_destination == own
              and reply_source[0] in private_ips and reply_destination == peer):
            local_port = reply_source[1]
            private_ip = reply_source[0]
        if local_port is not None:
            if require_translation:
                require(local_port != own[1], f"{path.name}: public and private ports were not translated")
            # Linux delays UDP ASSURED for two seconds. The reply bit and the
            # captured responses establish this fact without waiting for it.
            require("[UNREPLIED]" not in line, f"{path.name}: selected mapping has no reply state")
            return {"privateAddress": private_ip, "privatePort": local_port, "publicPort": own[1]}
    raise VerificationError(f"{path.name}: selected peer tuple has no matching NAT translation")


def mapping_from_snapshots(state: Path, role: str, own: Endpoint, peer: Endpoint,
                           private_ips: set[str], require_translation: bool = True) -> dict[str, Any]:
    paths = snapshot_paths(state, role, "conntrack.txt")
    for path in paths:
        if not path.is_file():
            continue
        try:
            return conntrack_translation(path, own, peer, private_ips, require_translation)
        except VerificationError:
            continue
    raise VerificationError(f"{role}: selected peer tuple has no translated bidirectional mapping")


def observer_mapping_ports(state: Path, role: str, local: dict[str, Any]) -> set[int]:
    ports: set[int] = set()
    paths = snapshot_paths(state, role, "conntrack.txt")
    for path in paths:
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            if re.search(r"\budp\b", line) is None or "[UNREPLIED]" in line:
                continue
            fields: dict[str, list[str]] = defaultdict(list)
            for key, value in re.findall(r"\b(src|dst|sport|dport)=([^\s]+)", line):
                fields[key].append(value)
            if any(len(fields[key]) != 2 for key in ("src", "dst", "sport", "dport")):
                continue
            if (fields["src"][0] == local["privateAddress"]
                    and fields["sport"][0] == str(local["privatePort"])
                    and fields["dst"][0] in {"198.51.100.10", "198.51.100.11"}
                    and fields["dport"][0] == "3478"
                    and fields["src"][1] == fields["dst"][0]
                    and fields["sport"][1] == "3478"):
                try:
                    ports.add(int(fields["dport"][1]))
                except ValueError:
                    continue
    return ports


def lease_rule_hits(path: Path, public_port: int, local: dict[str, Any]) -> int:
    contents = json.loads(path.read_text())
    require(isinstance(contents, dict) and isinstance(contents.get("nftables"), list),
            f"{path.name}: invalid nftables JSON")
    hits = 0
    for entry in contents.get("nftables", []):
        if not isinstance(entry, dict) or not isinstance(entry.get("rule"), dict):
            continue
        rule = entry["rule"]
        if rule.get("chain") != "prerouting_miniupnpd":
            continue
        external_port = False
        destination = False
        packets = 0
        for expression in rule.get("expr", []):
            if not isinstance(expression, dict):
                continue
            match = expression.get("match")
            if isinstance(match, dict) and match.get("op") == "==":
                left = match.get("left")
                payload = left.get("payload") if isinstance(left, dict) else None
                if (isinstance(payload, dict) and payload.get("protocol") == "udp" and payload.get("field") == "dport"
                        and match.get("right") == public_port):
                    external_port = True
            dnat = expression.get("dnat")
            if isinstance(dnat, dict):
                destination = (dnat.get("addr") == local["privateAddress"]
                               and dnat.get("port") == local["privatePort"])
            counter = expression.get("counter")
            if isinstance(counter, dict) and isinstance(counter.get("packets"), int):
                packets += counter["packets"]
        if external_port and destination:
            hits += packets
    return hits


def lease_from_snapshots(state: Path, role: str, public_port: int, local: dict[str, Any]) -> int:
    paths = snapshot_paths(state, role, "nft.json")
    hits = max((lease_rule_hits(path, public_port, local) for path in paths if path.is_file()), default=0)
    require(hits > 0, f"{role}: winning mapping has no used miniupnpd lease rule")
    return hits


def snapshot_paths(state: Path, role: str, suffix: str) -> list[Path]:
    return [state / f"{role}-{suffix}", *sorted(state.glob(f"*-{role}-{suffix}")),
            *sorted((state / "topology").glob(f"*-{role}-{suffix}"))]


def event_interval(lifecycle: dict[str, Any], start: str, end: str) -> tuple[int, int]:
    first, last = lifecycle.get(start), lifecycle.get(end)
    require(isinstance(first, int) and not isinstance(first, bool)
            and isinstance(last, int) and not isinstance(last, bool) and 0 < first <= last,
            f"lifecycle evidence has no ordered {start}/{end} timestamps")
    return first, last


def rebind_pairs(lifecycle: dict[str, Any]) -> tuple[Pair, Pair, dict[str, Any], int, int]:
    started, completed = event_interval(lifecycle, "portRebindStartedAtNs", "portReboundAtNs")
    details = lifecycle.get("portRebind")
    require(isinstance(details, dict) and details.get("privateIP") in {"10.20.2.2", "10.20.2.3"}
            and details.get("peerIP") == DAEMON4, "invalid controlled port-rebind endpoints")
    for key in ("localPort", "previousExternalPort", "currentExternalPort", "peerPort"):
        port = details.get(key)
        require(isinstance(port, int) and not isinstance(port, bool) and 0 < port < 65536,
                f"port-rebind evidence has no valid {key}")
    require(details["previousExternalPort"] != details["currentExternalPort"],
            "controlled port rebind did not change the external port")
    daemon = DAEMON4, details["peerPort"]
    return ((daemon, (CLIENT4, details["previousExternalPort"])),
            (daemon, (CLIENT4, details["currentExternalPort"])), details, started, completed)


def bidirectional_after(quic: list[Packet], pair: Pair, boundary: int) -> bool:
    return all(any(packet.source == source and packet.destination == destination
                   and packet.timestamp_ns >= boundary for packet in quic)
               for source, destination in (pair, pair[::-1]))


def port_rebind_packet_proof(lifecycle: dict[str, Any], quic: list[Packet],
                             trips: list[RoundTrip], case: str) -> Pair | None:
    old, new, _, started, completed = rebind_pairs(lifecycle)
    old_trips = [trip for trip in trips if trip.direction == "c"
                 and oriented_pair(trip.request, case) == old
                 and trip.response.timestamp_ns < started]
    if (not old_trips or not bidirectional_after(quic, new, completed)
            or not all(any(packet.source == source and packet.destination == destination
                           and old_trips[0].response.timestamp_ns <= packet.timestamp_ns < started
                           for packet in quic) for source, destination in (old, old[::-1]))):
        return None
    if any(packet.timestamp_ns < started for packet in quic if oriented_pair(packet, case) == new):
        return None
    # A fresh connection must complete its own checks. A short-header migration
    # must retain a CID visible before the intervention; encrypted NEW_CONNECTION_ID
    # contents are deliberately not guessed from arbitrary UDP bytes.
    first = min(packet.timestamp_ns for packet in quic
                if oriented_pair(packet, case) == new and packet.source == new[1])
    new_trips = [trip for trip in trips if trip.direction == "c"
                 and oriented_pair(trip.request, case) == new
                 and trip.response.timestamp_ns <= first]
    new_long = [packet for packet in quic if oriented_pair(packet, case) == new
                and quic_long_header(packet.payload) is not None]
    if new_long and not new_trips:
        return None
    known: dict[str, set[bytes]] = defaultdict(set)
    for packet in quic:
        if oriented_pair(packet, case) != old or packet.timestamp_ns >= started:
            continue
        header = quic_long_header(packet.payload)
        if header is not None:
            destination_id, source_id = header
            if destination_id:
                known[packet.destination[0]].add(destination_id)
            if source_id:
                known[packet.source[0]].add(source_id)
    if not new_trips and not any(packet.source == new[1] and packet.destination == new[0]
                                and packet.timestamp_ns >= completed and packet.payload[0] & 0x80 == 0
                                and any(packet.payload[1:].startswith(cid) for cid in known[new[0][0]])
                                for packet in quic):
        return None
    return new


def verify_port_rebind(lifecycle: dict[str, Any], quic: list[Packet], trips: list[RoundTrip],
                       case: str, state: Path) -> Pair:
    old, new, details, _, _ = rebind_pairs(lifecycle)
    require(port_rebind_packet_proof(lifecycle, quic, trips, case) == new,
            "port rebind has no checked handshake or bidirectional previous-CID continuity")
    private = {details["privateIP"]}
    for pair in (old, new):
        local = mapping_from_snapshots(state, "client", pair[1], pair[0], private)
        require(local["privatePort"] == details["localPort"],
                "port rebind changed the private source socket")
    old_daemon = mapping_from_snapshots(state, "daemon", old[0], old[1], {"10.20.1.2"})
    new_daemon = mapping_from_snapshots(state, "daemon", new[0], new[1], {"10.20.1.2"})
    require(old_daemon["privatePort"] == new_daemon["privatePort"],
            "port rebind changed the private daemon socket")
    return new


def verify_impairment(lifecycle: dict[str, Any], packets: list[Packet], state: Path) -> None:
    first, last = event_interval(lifecycle, "impairedAtNs", "impairmentClearedAtNs")
    require(lifecycle.get("impairment") == {"delayMs": 40, "duplicatePercent": 100, "lossEvery": 7},
            "impairment does not describe the controlled delay/duplication/loss")
    topology = state / "topology"
    qdiscs = json.loads((topology / "impairment-qdisc.json").read_text())
    losses = json.loads((topology / "impairment-nft.json").read_text())
    for role, own_ip in (("daemon", DAEMON4), ("client", CLIENT4)):
        entries = qdiscs.get(role, {}).get("qdisc", [])
        require(any(entry.get("kind") == "netem" and entry.get("handle") == "30:"
                    and entry.get("parent") == "1:3" and entry.get("packets", 0) > 0
                    and entry.get("options", {}).get("delay", {}).get("delay") == 0.04
                    and entry.get("options", {}).get("duplicate", {}).get("duplicate") == 1
                    for entry in entries), f"{role}: delay/duplicate qdisc has no matching used configuration")
        role_loss = losses.get(role, {})
        counts = [entry.get("counter", {}).get("packets", 0) for entry in role_loss.get("nftables", [])
                  if entry.get("counter", {}).get("name") == "peer_loss"]
        require(any(isinstance(count, int) and not isinstance(count, bool) and count > 0 for count in counts),
                f"{role}: deterministic peer loss filtered no packet")
        seen: set[tuple[Endpoint, Endpoint, bytes]] = set()
        duplicated = False
        for packet in packets:
            if packet.source[0] != own_ip or not first <= packet.timestamp_ns <= last:
                continue
            key = packet.source, packet.destination, packet.payload
            if key in seen:
                duplicated = True
                break
            seen.add(key)
        require(duplicated, f"{role}: capture has no duplicated peer datagram during impairment")


def verify_same_ip_route(lifecycle: dict[str, Any], packets: list[Packet], quic: list[Packet],
                         case: str, state: Path) -> None:
    started, completed = event_interval(lifecycle, "sameIPRouteStartedAtNs", "sameIPRouteChangedAtNs")
    details = lifecycle.get("sameIPRoute")
    require(isinstance(details, dict) and details.get("privateIP") in {"10.20.2.2", "10.20.2.3"}
            and details.get("previousGateway") == "10.20.2.1"
            and details.get("currentGateway") == "10.20.2.254", "invalid same-IP route intervention")
    topology = state / "topology"

    def addresses(name: str) -> set[tuple[str, str, int, str]]:
        interfaces = json.loads((topology / name).read_text())
        return {(address["family"], address["local"], address["prefixlen"], address["scope"])
                for interface in interfaces for address in interface.get("addr_info", [])}

    before = addresses("before-same-ip-route-address.json")
    after = addresses("after-same-ip-route-address.json")
    require(before == after and any(address[1] == details["privateIP"] for address in before),
            "same-IP route intervention changed the endpoint addresses")
    routes = json.loads((topology / "after-same-ip-route.json").read_text())
    require(len(routes) == 1 and routes[0].get("gateway") == details["currentGateway"],
            "same-IP route intervention did not install the replacement gateway")
    pairs = {oriented_pair(packet, case) for packet in quic}
    require(any(pair is not None and bidirectional_after(quic, pair, completed) for pair in pairs),
            "same-IP route event has no subsequent bidirectional peer QUIC")


def successor_trips(lifecycle: dict[str, Any], packets: list[Packet],
                    trips: list[RoundTrip]) -> list[RoundTrip]:
    partitioned, committed = event_interval(lifecycle, "carriersPartitionedAtNs", "rebindCommittedAtNs")
    predecessors = {check.context for packet in packets if packet.timestamp_ns < partitioned
                    and (check := peer_check(packet.payload)) is not None and check.request}
    require(bool(predecessors), "committed rebind has no predecessor check context")
    return [trip for trip in trips if trip.direction == "c" and trip.request.timestamp_ns >= committed
            and (check := peer_check(trip.request.payload)) is not None
            and check.context not in predecessors]


def verify_committed_rebind(lifecycle: dict[str, Any], packets: list[Packet],
                            quic: list[Packet], trips: list[RoundTrip], case: str) -> None:
    successors = successor_trips(lifecycle, packets, trips)
    require(bool(successors), "committed rebind has no fresh successor client-check round trip")
    require(any((pair := oriented_pair(trip.request, case)) is not None
                and bidirectional_after(quic, pair, trip.response.timestamp_ns) for trip in successors),
            "committed rebind has no QUIC after its successor client-check round trip")


def verify_gateway_reboot(lifecycle: dict[str, Any], quic: list[Packet], case: str, state: Path) -> None:
    started, completed = event_interval(lifecycle, "gatewayRebootStartedAtNs", "gatewayRebootedAtNs")
    details = lifecycle.get("gatewayReboot")
    require(isinstance(details, dict), "gateway reboot has no process/epoch evidence")
    role, protocol = details.get("role"), details.get("protocol")
    require(role in {"daemon", "client"} and protocol in {"pcp", "natpmp"}
            and case == f"{role}-lease-{protocol}", "gateway reboot does not match its lease topology")
    previous, current = details.get("previousEpoch"), details.get("currentEpoch")
    require(isinstance(previous, int) and isinstance(current, int) and 0 <= current < previous,
            "gateway reboot did not reset its wire epoch")
    old_pid, new_pid = details.get("previousPid"), details.get("currentPid")
    require(isinstance(old_pid, int) and isinstance(new_pid, int) and old_pid > 0 and new_pid > 0
            and old_pid != new_pid, "gateway reboot did not replace its real process")
    topology = state / "topology"
    notice = json.loads((topology / "gateway-announcement.json").read_text())
    wire = bytes.fromhex(notice.get("packet", ""))
    notice_protocol = notice.get("protocol")
    epoch = None
    if notice_protocol == "natpmp" and len(wire) == 12 and wire[:4] == b"\0\x80\0\0":
        epoch = struct.unpack_from("!I", wire, 4)[0]
    elif notice_protocol == "pcp" and len(wire) >= 24 and wire[:4] == b"\x02\x80\0\0":
        epoch = struct.unpack_from("!I", wire, 8)[0]
    number = 1 if role == "daemon" else 2
    require(epoch is not None and epoch == notice.get("epoch") and epoch < previous
            and notice.get("sender") == [f"10.20.{number}.1", 5351]
            and started <= notice.get("receivedAtNs", 0) <= completed,
            "gateway reboot has no authentic-shaped epoch-loss announcement from its real router")
    chains = details.get("flushedChains")
    require(isinstance(chains, list) and bool(chains), "gateway reboot flushed no mapping chains")
    flushed = json.loads((topology / f"flushed-gateway-reboot-{role}-nft.json").read_text())
    names = {(item.get("family"), item.get("table"), item.get("name")) for item in chains}
    present = {(chain.get("family"), chain.get("table"), chain.get("name"))
               for entry in flushed.get("nftables", [])
               if isinstance(chain := entry.get("chain"), dict)}
    require(names <= present, "gateway flushed-state snapshot omits the controlled mapping chains")
    require(not any((rule.get("family"), rule.get("table"), rule.get("chain")) in names
                    for entry in flushed.get("nftables", [])
                    if isinstance(rule := entry.get("rule"), dict)),
            "gateway reboot retained dynamic mapping rules in its flushed state")
    reacquired = lifecycle.get("leaseReacquiredAtNs")
    require(isinstance(reacquired, int) and reacquired >= completed,
            "gateway reboot has no reacquired router lease")
    pairs = {oriented_pair(packet, case) for packet in quic}
    used = False
    for pair in pairs:
        if pair is None or not bidirectional_after(quic, pair, reacquired):
            continue
        own, peer = (pair[0], pair[1]) if role == "daemon" else (pair[1], pair[0])
        local = mapping_from_snapshots(state, role, own, peer, {f"10.20.{number}.2"}, False)
        if lease_rule_hits(topology / f"reacquired-{role}-nft.json", own[1], local) > 0:
            used = True
            break
    require(used, "gateway reboot has no bidirectional QUIC using its reacquired exact router lease")


def verify(case: str, captures: list[Path], state: Path) -> dict[str, Any]:
    require(case in POSITIVE_CASES | NEGATIVE_CASES, f"unknown native NAT case {case}")
    require(bool(captures), "at least one capture is required")
    packets: list[Packet] = []
    records = 0
    for path in captures:
        capture = read_capture(path)
        verify_capture_summary(state / f"{path.stem}.stderr", capture.records)
        packets.extend(capture.packets)
        records += capture.records
    peer_packets = [packet for packet in packets if oriented_pair(packet, case) is not None]
    require(bool(peer_packets), "capture contains no traffic between the configured terminal peers")
    # This also bounds non-STUN traffic, including the browser's existing bounded helper punch.
    destinations: dict[str, set[Endpoint]] = defaultdict(set)
    for packet in peer_packets:
        destinations[packet.source[0]].add(packet.destination)
    require(all(len(values) <= MAX_CHECK_PAIRS for values in destinations.values()),
            "peer UDP traffic enumerated more than the candidate-pair bound")
    lifecycle_path = state / "topology" / "lifecycle.json"
    lifecycle = json.loads(lifecycle_path.read_text()) if lifecycle_path.is_file() else None
    require(lifecycle is None or isinstance(lifecycle, dict), "invalid lifecycle evidence")
    if lifecycle is not None:
        marker = lifecycle.get("nativeSessionsStartedAtNs")
        require(not ({"impairment", "portRebind", "sameIPRoute"} & lifecycle.keys()) or marker is not None,
                "native fault evidence has no native-session phase boundary")
        if marker is not None:
            require(isinstance(marker, int) and not isinstance(marker, bool) and marker > 0,
                    "native-session phase boundary is invalid")
            peer_packets = [packet for packet in peer_packets if packet.timestamp_ns >= marker]
            require(bool(peer_packets), "no peer traffic followed the native-session phase boundary")
    trips, request_count = round_trips(peer_packets, case)
    quic = quic_packets(peer_packets, case, lifecycle)
    summary: dict[str, Any] = {
        "case": case, "captureRecords": records, "peerCheckRequests": request_count,
        "checkRoundTrips": len(trips), "peerQuicPackets": len(quic),
    }
    if case in NEGATIVE_CASES:
        drops = named_drop_count(state / "daemon-nft.json") + named_drop_count(state / "client-nft.json")
        require(request_count > 0, "negative case contains no native peer-check attempt")
        require(drops > 0, "negative topology did not record a peer packet being filtered")
        require(not quic, "an unverified direct QUIC dial escaped the negative topology")
        summary.update({"outcome": "relay", "filteredPeerPackets": drops})
        return summary
    pairs = {oriented_pair(packet, case) for packet in quic}
    punched_pairs = daemon_check_targets(peer_packets, case)
    migrated = None
    if lifecycle is not None and "portRebind" in lifecycle:
        require(case == "eim-pdf", "port-rebind evidence belongs to the EIM topology")
        migrated = verify_port_rebind(lifecycle, quic, trips, case, state)
        summary["portRebindVerified"] = True
    winners: list[tuple[Pair, list[RoundTrip]]] = []
    for pair in pairs:
        if pair is None:
            continue
        candidate_trips = [trip for trip in trips if oriented_pair(trip.request, case) == pair]
        if pair == migrated and not any(quic_long_header(packet.payload) is not None
                                        for packet in quic if oriented_pair(packet, case) == pair):
            winners.append((pair, candidate_trips))
            continue
        directions = {trip.direction for trip in candidate_trips}
        require("c" in directions and (case == "lan" or pair in punched_pairs),
                "a direct QUIC tuple has no matching two-sided check authority")
        first_client_quic = min((packet.timestamp_ns for packet in quic
                                 if packet.source == pair[1] and packet.destination == pair[0]),
                                default=None)
        if first_client_quic is not None:
            require(any(trip.direction == "c" and trip.response.timestamp_ns <= first_client_quic
                        for trip in candidate_trips), "QUIC dial preceded its successful client check")
            if case != "lan":
                require(any(packet.source == pair[0] and packet.destination == pair[1]
                            and packet.timestamp_ns <= first_client_quic
                            and (check := peer_check(packet.payload)) is not None
                            and check.request and check.direction == "d"
                            for packet in peer_packets),
                        "QUIC dial preceded its daemon filter-opening check")
        sent_by_daemon = any(packet.source == pair[0] and packet.destination == pair[1] for packet in quic)
        sent_by_client = any(packet.source == pair[1] and packet.destination == pair[0] for packet in quic)
        if sent_by_daemon and sent_by_client:
            winners.append((pair, candidate_trips))
    require(bool(winners), "no checked peer tuple carries bidirectional QUIC")
    if lifecycle is not None:
        if "impairment" in lifecycle:
            require(case == "eim-pdf", "impairment belongs to the EIM topology")
            verify_impairment(lifecycle, peer_packets, state)
            summary["impairmentVerified"] = True
        if "sameIPRoute" in lifecycle:
            require(case == "eim-pdf", "same-IP route belongs to the EIM topology")
            verify_same_ip_route(lifecycle, peer_packets, quic, case, state)
            summary["sameIPRouteVerified"] = True
        if "gatewayReboot" in lifecycle:
            verify_gateway_reboot(lifecycle, quic, case, state)
            summary["gatewayRebootVerified"] = True
        if "rebindCommittedAtNs" in lifecycle:
            require(case == "eim-pdf", "committed rebind belongs to the EIM topology")
            verify_committed_rebind(lifecycle, peer_packets, quic, trips, case)
            summary["committedRebindVerified"] = True
    client_private_ips = {"10.20.2.2"}
    if lifecycle is not None and "routeChangeStartedAtNs" in lifecycle:
        require(case == "eim-pdf", "invalid address-change lifecycle evidence")
        route_started = lifecycle.get("routeChangeStartedAtNs")
        route_changed = lifecycle.get("routeChangedAtNs")
        require(isinstance(route_started, int) and not isinstance(route_started, bool)
                and isinstance(route_changed, int) and not isinstance(route_changed, bool)
                and 0 < route_started <= route_changed,
                "lifecycle evidence has no ordered route-change timestamps")
        require(lifecycle.get("previousPrivateIP") == "10.20.2.2"
                and lifecycle.get("currentPrivateIP") == "10.20.2.3",
                "lifecycle addresses do not match the controlled route change")
        client_private_ips.add("10.20.2.3")
        new_trips = [trip for trip in trips if trip.direction == "c"
                     and trip.request.timestamp_ns >= route_started]
        require(bool(new_trips), "the replacement route has no fresh client check")
        old_contexts = {check.context for trip in trips
                        if trip.direction == "c" and trip.request.timestamp_ns < route_started
                        and (check := peer_check(trip.request.payload)) is not None}
        new_trips = [trip for trip in new_trips
                     if (check := peer_check(trip.request.payload)) is not None
                     and check.context not in old_contexts]
        require(bool(old_contexts) and bool(new_trips),
                "the replacement route reused a predecessor check context")
        replacements = [trip for trip in new_trips
                        if any(packet.source == trip.request.source and packet.destination == trip.request.destination
                               and packet.timestamp_ns >= max(route_changed, trip.response.timestamp_ns)
                               for packet in quic)]
        require(bool(replacements),
                "the replacement route has no QUIC after its fresh client check")
        successor_mapping = False
        for trip in replacements:
            try:
                mapping_from_snapshots(state, "client", trip.request.source,
                                       trip.request.destination, {"10.20.2.3"})
                successor_mapping = True
            except VerificationError:
                continue
        require(successor_mapping, "replacement QUIC does not use the successor private address")
        summary["routeChangeVerified"] = True
    verified_pairs = []
    for pair, _ in sorted(winners):
        evidence = {"daemonEndpoint": list(pair[0]), "clientEndpoint": list(pair[1])}
        if case not in {"lan", "ipv6-pdf"}:
            evidence["daemonMapping"] = mapping_from_snapshots(
                state, "daemon", pair[0], pair[1], {"10.20.1.2"},
                require_translation=not case.startswith("daemon-lease-"))
            evidence["clientMapping"] = mapping_from_snapshots(
                state, "client", pair[1], pair[0], client_private_ips,
                require_translation=not case.startswith("client-lease-"))
            dependent_role = None
            if case.startswith("edm-daemon-") or case.startswith("client-lease-"):
                dependent_role = "daemon"
            elif case.startswith("edm-client-") or case.startswith("daemon-lease-"):
                dependent_role = "client"
            if dependent_role is not None:
                mapping = evidence[f"{dependent_role}Mapping"]
                observer_ports = observer_mapping_ports(state, dependent_role, mapping)
                require(bool(observer_ports) and mapping["publicPort"] not in observer_ports,
                        f"{dependent_role}: peer-facing mapping did not differ from observer mapping")
                evidence["peerReflexiveMapping"] = {
                    "role": dependent_role, "observerPorts": sorted(observer_ports),
                    "peerPort": mapping["publicPort"],
                }
            if "-lease-" in case:
                lease_role = "client" if case.startswith("client-") else "daemon"
                mapping = evidence[f"{lease_role}Mapping"]
                evidence["leaseRulePackets"] = lease_from_snapshots(
                    state, lease_role, mapping["publicPort"], mapping)
        verified_pairs.append(evidence)
    summary.update({"outcome": "direct", "verifiedPairs": verified_pairs})
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True)
    parser.add_argument("--capture", "--peer-capture", action="append", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--wait-for-rebind-context", action="store_true")
    parser.add_argument("--wait-for-port-rebind", action="store_true")
    args = parser.parse_args()
    try:
        require(not (args.wait_for_rebind_context and args.wait_for_port_rebind),
                "select one live evidence observer")
        if args.wait_for_rebind_context:
            summary = wait_for_rebind_context(args.case, args.capture, args.state)
        elif args.wait_for_port_rebind:
            summary = wait_for_port_rebind(args.case, args.capture, args.state)
        else:
            summary = verify(args.case, args.capture, args.state)
    except (OSError, ValueError, VerificationError) as error:
        print(f"native NAT evidence rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
