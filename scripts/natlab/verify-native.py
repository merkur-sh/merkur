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
import xml.etree.ElementTree as ET


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
    "ipv6-client-pcp", "ipv6-daemon-pcp", "ipv6-client-igd", "ipv6-daemon-igd",
}
IPV6_PINHOLE_CASES = {"ipv6-client-pcp", "ipv6-daemon-pcp", "ipv6-client-igd", "ipv6-daemon-igd"}
NEGATIVE_CASES = {"blocked", "edm-pdf", "edm-both", "inner-lease"}


@dataclass(frozen=True)
class Packet:
    timestamp_ns: int
    source: Endpoint
    destination: Endpoint
    payload: bytes


@dataclass(frozen=True)
class TcpPacket:
    timestamp_ns: int
    source: Endpoint
    destination: Endpoint
    sequence: int
    flags: int
    payload: bytes


@dataclass(frozen=True)
class Capture:
    packets: tuple[Packet, ...]
    records: int
    tcp: tuple[TcpPacket, ...] = ()


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


def ip_payload(frame: bytes, link_type: int) -> tuple[str, str, int, bytes] | None:
    decoded = decode_link(frame, link_type)
    if decoded is None:
        return None
    protocol, body = decoded
    if protocol == 0x0800:
        require(len(body) >= 20 and body[0] >> 4 == 4, "truncated or invalid IPv4 header")
        header_len = (body[0] & 15) * 4
        total_len = struct.unpack_from("!H", body, 2)[0]
        require(header_len >= 20 and header_len <= total_len <= len(body), "invalid IPv4 length")
        if body[9] not in {6, 17}:
            return None
        require(struct.unpack_from("!H", body, 6)[0] & 0x3FFF == 0,
                "fragmented UDP cannot establish a complete peer exchange")
        source, destination = canonical_ip(body[12:16]), canonical_ip(body[16:20])
        return source, destination, body[9], body[header_len:total_len]
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
        if next_header not in {6, 17}:
            return None
        return source, destination, next_header, body[cursor:total_len]
    else:
        return None


def udp_packet(frame: bytes, link_type: int, timestamp_ns: int) -> Packet | None:
    decoded = ip_payload(frame, link_type)
    return udp_payload(decoded, timestamp_ns) if decoded is not None and decoded[2] == 17 else None


def udp_payload(decoded: tuple[str, str, int, bytes], timestamp_ns: int) -> Packet:
    source, destination, _, datagram = decoded
    require(len(datagram) >= 8, "truncated UDP header")
    source_port, destination_port, length, _ = struct.unpack_from("!HHHH", datagram)
    require(8 <= length <= len(datagram), "invalid UDP length")
    return Packet(timestamp_ns, (source, source_port), (destination, destination_port),
                  datagram[8:length])


def tcp_payload(decoded: tuple[str, str, int, bytes], timestamp_ns: int) -> TcpPacket:
    source, destination, _, segment = decoded
    require(len(segment) >= 20, "truncated TCP header")
    source_port, destination_port, sequence = struct.unpack_from("!HHI", segment)
    header_length = (segment[12] >> 4) * 4
    require(20 <= header_length <= len(segment), "invalid TCP data offset")
    return TcpPacket(timestamp_ns, (source, source_port), (destination, destination_port),
                     sequence, segment[13], segment[header_length:])


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
        tcp: list[TcpPacket] = []
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
            decoded = ip_payload(frame, link_type)
            timestamp = seconds * 1_000_000_000 + fraction * fraction_scale
            if decoded is not None:
                if decoded[2] == 17:
                    packets.append(udp_payload(decoded, timestamp))
                else:
                    tcp.append(tcp_payload(decoded, timestamp))
    return Capture(tuple(packets), records, tuple(tcp))


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


def wait_for_inner_lease_rejection(case: str, captures: list[Path]) -> dict[str, Any]:
    require(case == "inner-lease", "inner-lease observation requires its controlled two-router topology")
    deadline = time.monotonic() + 30
    while True:
        packets = [packet for path in captures for packet in read_capture(path, live=True).packets]
        proof = inner_lease_rejection(packets)
        if proof is not None:
            return {"case": case, "innerLeaseRejected": proof}
        remaining = deadline - time.monotonic()
        require(remaining > 0, "no mismatched inner PCP grant was deleted while its native binding remained live")
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
                 lifecycle: dict[str, Any] | None = None,
                 gateway_pairs: dict[Pair, Pair] | None = None) -> list[Packet]:
    # A CID identifies the endpoint across a NAT source-port change. Keeping the
    # tuple out of this key detects migrated packets; admission below still
    # requires checks or the exact controlled migration's socket evidence.
    connection_ids: dict[str, set[bytes]] = defaultdict(set)
    result: list[Packet] = []
    migration = rebind_pairs(lifecycle) if lifecycle is not None and "portRebind" in lifecycle else None
    migration_client_seen = False
    gateway_seen: set[Pair] = set()
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
            if (gateway_pairs is not None and pair in gateway_pairs and packet.source == pair[1]
                    and lifecycle is not None and packet.timestamp_ns >= lifecycle["gatewayRebootStartedAtNs"]):
                gateway_seen.add(pair)
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
        elif (pair in gateway_seen and packet.source == pair[0] and len(packet.payload) >= 21
              and packet.payload[0] & 0x80 == 0 and packet.payload[4:8] != COOKIE):
            # The reset-scoped pair has exact old/new private-socket witnesses
            # and an old client-to-daemon CID. Its reverse CID can rotate.
            result.append(packet)
    return result


def oriented_pair(packet: Packet, case: str) -> Pair | None:
    daemon, client = (DAEMON_LAN, CLIENT_LAN) if case == "lan" else (
        (DAEMON6, CLIENT6) if case == "ipv6-pdf" or case in IPV6_PINHOLE_CASES else (DAEMON4, CLIENT4))
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


def lease_rule_ports(path: Path, local: dict[str, Any]) -> set[int]:
    contents = json.loads(path.read_text())
    require(isinstance(contents, dict) and isinstance(contents.get("nftables"), list),
            f"{path.name}: invalid nftables JSON")
    ports = set()
    for entry in contents["nftables"]:
        rule = entry.get("rule", {})
        if rule.get("chain") != "prerouting_miniupnpd":
            continue
        port, udp, destination = None, False, False
        for expression in rule.get("expr", []):
            match = expression.get("match", {})
            if match.get("op") == "==":
                payload = match.get("left", {}).get("payload", {})
                field = payload.get("protocol"), payload.get("field")
                raw = payload.get("base"), payload.get("offset"), payload.get("len")
                right = match.get("right")
                if field in {("udp", "dport"), ("th", "dport")} or raw == ("th", 16, 16):
                    port = int(right, 0) if isinstance(right, str) else right
                    udp = udp or field[0] == "udp"
                elif field == ("ip", "protocol") or raw == ("nh", 72, 8):
                    udp = udp or right in {17, "udp", "0x11"}
                elif match.get("left", {}).get("meta", {}).get("key") == "l4proto":
                    udp = udp or right in {17, "udp", "0x11"}
            dnat = expression.get("dnat", {})
            if isinstance(dnat, dict) and dnat:
                destination = (dnat.get("addr") == local["privateAddress"]
                               and dnat.get("port") == local["privatePort"])
        if udp and destination and isinstance(port, int) and 0 < port < 65536:
            ports.add(port)
    return ports


def inbound_dnat_seen(paths: list[Path], own: Endpoint, peer: Endpoint, local: dict[str, Any]) -> bool:
    for path in paths:
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            if re.search(r"\budp\b", line) is None or "[UNREPLIED]" in line:
                continue
            fields: dict[str, list[str]] = defaultdict(list)
            for key, value in re.findall(r"\b(src|dst|sport|dport)=([^\s]+)", line):
                fields[key].append(value)
            if (fields["src"] == [peer[0], local["privateAddress"]]
                    and fields["dst"] == [own[0], peer[0]]
                    and fields["sport"] == [str(peer[1]), str(local["privatePort"])]
                    and fields["dport"] == [str(own[1]), str(peer[1])]):
                return True
    return False


def lease_from_snapshots(state: Path, role: str, winner: Pair, local: dict[str, Any],
                         trips: list[RoundTrip], case: str, *, rule_paths: list[Path] | None = None,
                         conntrack_paths: list[Path] | None = None, after: int = 0,
                         quic: list[Packet] | None = None) -> dict[str, Any]:
    rules = rule_paths if rule_paths is not None else snapshot_paths(state, role, "nft.json")
    ports = set().union(*(lease_rule_ports(path, local) for path in rules if path.is_file()))
    paths = conntrack_paths if conntrack_paths is not None else snapshot_paths(state, role, "conntrack.txt")
    contexts = {check.context for trip in trips if oriented_pair(trip.request, case) == winner
                and (check := peer_check(trip.request.payload)) is not None}
    for trip in trips:
        pair = oriented_pair(trip.request, case)
        if pair is None:
            continue
        own, peer = (pair[1], pair[0]) if role == "client" else pair
        check = peer_check(trip.request.payload)
        if (own[1] not in ports or trip.request.destination != own or check is None
                or check.context not in contexts or not inbound_dnat_seen(paths, own, peer, local)):
            continue
        if trip.response.timestamp_ns < after and not bidirectional_after(quic or [], pair, after):
            continue
        return {"externalPort": own[1], "peerEndpoint": list(peer),
                "checkRoundTripVerified": True, "conntrackDnatVerified": True,
                "sameCheckContextAsQuic": True}
    raise VerificationError(f"{role}: no exact miniupnpd lease rule and DNAT/check admission on the winning binding/context")


def gateway_migrations(packets: list[Packet], trips: list[RoundTrip], case: str,
                        lifecycle: dict[str, Any] | None, state: Path) -> dict[Pair, Pair]:
    if (lifecycle is None or not case.startswith("client-lease-")
            or lifecycle.get("gatewayReboot", {}).get("role") != "client"):
        return {}
    started, _ = event_interval(lifecycle, "gatewayRebootStartedAtNs", "gatewayRebootedAtNs")
    before = state / "topology" / "before-gateway-reboot-client-nft.json"
    before_ct = state / "topology" / "before-gateway-reboot-client-conntrack.txt"
    old_trips = [trip for trip in trips if trip.response.timestamp_ns < started]
    old_quic = [packet for packet in quic_packets(packets, case) if packet.timestamp_ns < started]
    result = {}
    for old in {oriented_pair(trip.request, case) for trip in old_trips if trip.direction == "c"}:
        if old is None or not bidirectional_after(old_quic, old, 0):
            continue
        try:
            client = mapping_from_snapshots(state, "client", old[1], old[0], {"10.20.2.2"}, False)
            daemon = mapping_from_snapshots(state, "daemon", old[0], old[1], {"10.20.1.2"}, False)
            lease_from_snapshots(state, "client", old, client, old_trips, case,
                                 rule_paths=[before], conntrack_paths=[before_ct])
        except VerificationError:
            continue
        server_ids = set()
        for packet in old_quic:
            if oriented_pair(packet, case) != old:
                continue
            header = quic_long_header(packet.payload)
            if header is not None:
                cid = header[0] if packet.source == old[1] else header[1]
                if cid:
                    server_ids.add(cid)
        for packet in packets:
            pair = oriented_pair(packet, case)
            if (pair is None or pair == old or pair[0] != old[0] or packet.source != pair[1]
                    or packet.timestamp_ns < started or len(packet.payload) < 21
                    or packet.payload[0] & 0x80 or packet.payload[4:8] == COOKIE
                    or not any(packet.payload[1:].startswith(cid) for cid in server_ids)):
                continue
            try:
                new_client = mapping_from_snapshots(state, "client", pair[1], pair[0], {"10.20.2.2"}, False)
                new_daemon = mapping_from_snapshots(state, "daemon", pair[0], pair[1], {"10.20.1.2"}, False)
            except VerificationError:
                continue
            if all(previous["privateAddress"] == current["privateAddress"]
                   and previous["privatePort"] == current["privatePort"]
                   for previous, current in ((client, new_client), (daemon, new_daemon))):
                result[pair] = old
    return result


def snapshot_paths(state: Path, role: str, suffix: str) -> list[Path]:
    return [state / f"{role}-{suffix}", *sorted(state.glob(f"*-{role}-{suffix}")),
            *sorted((state / "topology").glob(f"*-{role}-{suffix}"))]


def pcp6_exchange(request: bytes, response: bytes, address: str, port: int) -> dict[str, Any]:
    require(len(request) == 60 and len(response) >= 60 and request[:4] == b"\x02\x01\0\0"
            and response[:4] == b"\x02\x81\0\0", "pinhole PCP MAP exchange is not successful")
    packed = ipaddress.IPv6Address(address).packed
    require(request[8:24] == packed and request[36:40] == b"\x11\0\0\0"
            and response[36:40] == request[36:40]
            and request[40:44] == struct.pack("!HH", port, port)
            and response[40:44] == request[40:44]
            and request[44:60] == packed and response[44:60] == packed,
            "pinhole PCP MAP changed the native IPv6 address or socket port")
    require(response[24:36] == request[24:36], "pinhole PCP response belongs to another nonce")
    requested = struct.unpack_from("!I", request, 4)[0]
    granted = struct.unpack_from("!I", response, 4)[0]
    require((requested == 0 and granted == 0) or (requested > 0 and 0 < granted <= requested),
            "pinhole PCP lifetime does not match acquire/renew/delete")
    return {"identity": request[24:36].hex(), "requestedLifetimeSeconds": requested,
            "grantedLifetimeSeconds": granted, "epoch": struct.unpack_from("!I", response, 8)[0]}


def igd6_exchange(action: str, request: str, response: str, address: str, port: int,
                  source: str) -> dict[str, Any]:
    require(source == address, "pinhole IGD control did not originate at its InternalClient")
    require(action in {"AddPinhole", "UpdatePinhole", "DeletePinhole"}, "unexpected IGD pinhole action")
    service = "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1"
    envelope = "{http://schemas.xmlsoap.org/soap/envelope/}"

    def body(xml: str, name: str) -> dict[str, str]:
        try:
            root = ET.fromstring(xml)
        except ET.ParseError as error:
            raise VerificationError("pinhole IGD control has malformed SOAP") from error
        element = root.find(f"{envelope}Body")
        require(element is not None and len(element) == 1
                and element[0].tag == f"{{{service}}}{name}", "pinhole IGD SOAP action/response mismatch")
        fields: dict[str, str] = {}
        for child in element[0]:
            key = child.tag.rsplit("}", 1)[-1]
            require(key not in fields, "pinhole IGD SOAP contains duplicate arguments")
            fields[key] = child.text or ""
        return fields

    sent, answered = body(request, action), body(response, action + "Response")
    if action == "AddPinhole":
        require(sent.get("RemoteHost") == "" and sent.get("RemotePort") == "0"
                and sent.get("InternalClient") == address and sent.get("InternalPort") == str(port)
                and sent.get("Protocol") == "17", "pinhole IGD request changed its native UDP socket")
        identity, lifetime = answered.get("UniqueID"), sent.get("LeaseTime")
    else:
        identity = sent.get("UniqueID")
        lifetime = sent.get("NewLeaseTime") if action == "UpdatePinhole" else "0"
    require(isinstance(identity, str) and identity.isdigit() and 0 <= int(identity) <= 65535,
            "pinhole IGD action has no valid UniqueID")
    require(isinstance(lifetime, str) and lifetime.isdigit()
            and (int(lifetime) == 0 if action == "DeletePinhole" else 0 < int(lifetime) <= 86400),
            "pinhole IGD action has no valid requested lifetime")
    return {"identity": identity, "requestedLifetimeSeconds": int(lifetime),
            "grantedLifetimeSeconds": int(lifetime)}


def gateway_http(tcp: list[TcpPacket], local: str, gateway: str) -> list[dict[str, Any]]:
    connections: list[dict[Endpoint, dict[str, Any]]] = []
    active: dict[tuple[Endpoint, Endpoint], dict[Endpoint, dict[str, Any]]] = {}
    for packet in sorted(tcp, key=lambda value: value.timestamp_ns):
        if {packet.source[0], packet.destination[0]} != {local, gateway}:
            continue
        key = tuple(sorted((packet.source, packet.destination)))
        connection = active.get(key)
        if packet.flags & 2 and not packet.flags & 16:
            if (connection is None or packet.source not in connection
                    or connection[packet.source]["base"] != (packet.sequence + 1) & 0xFFFFFFFF):
                connection = {}
                connections.append(connection)
                active[key] = connection
        if connection is None:
            require(not packet.payload, "gateway HTTP capture starts after its TCP handshake")
            continue
        if packet.flags & 2:
            connection.setdefault(packet.source, {"base": (packet.sequence + 1) & 0xFFFFFFFF,
                                                   "segments": [], "destination": packet.destination})
        if not packet.payload:
            continue
        require(packet.source in connection, "gateway HTTP response has no captured TCP handshake")
        flow = connection[packet.source]
        sequence = packet.sequence + (1 if packet.flags & 2 else 0)
        offset = (sequence - flow["base"]) & 0xFFFFFFFF
        require(offset < 0x80000000, "gateway TCP sequence precedes its handshake")
        flow["segments"].append((offset, packet.payload, packet.timestamp_ns))

    def stream(flow: dict[str, Any]) -> tuple[bytes, int, int]:
        data = bytearray()
        stamps = []
        for offset, payload, stamp in sorted(flow["segments"]):
            require(offset <= len(data), "gateway HTTP capture has missing TCP bytes")
            overlap = min(len(data) - offset, len(payload))
            require(data[offset:offset + overlap] == payload[:overlap],
                    "gateway HTTP capture has conflicting TCP retransmissions")
            data.extend(payload[overlap:])
            stamps.append(stamp)
        return bytes(data), min(stamps, default=0), max(stamps, default=0)

    def messages(data: bytes) -> list[tuple[str, dict[str, str], str]]:
        result = []
        while data:
            end = data.find(b"\r\n\r\n")
            require(end >= 0, "gateway HTTP capture has incomplete headers")
            lines = data[:end].decode("ascii").split("\r\n")
            headers: dict[str, str] = {}
            for line in lines[1:]:
                require(":" in line, "gateway HTTP contains an invalid header")
                name, value = line.split(":", 1)
                name = name.strip().lower()
                require(name not in headers, "gateway HTTP contains duplicate headers")
                headers[name] = value.strip()
            require("transfer-encoding" not in headers, "gateway uses unsupported HTTP transfer coding")
            length = headers.get("content-length", "0")
            require(length.isdigit(), "gateway HTTP has an invalid Content-Length")
            body_end = end + 4 + int(length)
            require(body_end <= len(data), "gateway HTTP capture has incomplete body")
            result.append((lines[0], headers, data[end + 4:body_end].decode("utf-8")))
            data = data[body_end:]
        return result

    result: list[dict[str, Any]] = []
    for connection in connections:
        clients = [endpoint for endpoint in connection if endpoint[0] == local]
        servers = [endpoint for endpoint in connection if endpoint[0] == gateway]
        if not clients or not servers:
            continue
        client, server = clients[0], servers[0]
        request_bytes, sent, _ = stream(connection[client])
        response_bytes, _, received = stream(connection[server])
        if not request_bytes or not response_bytes:
            continue
        requests, responses = messages(request_bytes), messages(response_bytes)
        require(len(requests) == len(responses), "gateway HTTP request/response counts differ")
        for (line, headers, request), (status, _, response) in zip(requests, responses):
            if not line.startswith("POST ") or "soapaction" not in headers:
                continue
            action = headers["soapaction"].strip('"').rsplit("#", 1)[-1]
            if action not in {"AddPinhole", "UpdatePinhole", "DeletePinhole"}:
                continue
            require(status.split(" ")[1] == "200", "native IGD pinhole action failed")
            result.append({"action": action, "requestBody": request, "responseBody": response,
                           "source": client, "responder": server, "sentAtNs": sent,
                           "receivedAtNs": received})
    return result


def gateway_pcp(packets: list[Packet], local: str, gateway: str,
                 port: int) -> list[dict[str, Any]]:
    requests: dict[tuple[Endpoint, Endpoint, bytes], list[Packet]] = defaultdict(list)
    result = []
    for packet in sorted(packets, key=lambda value: value.timestamp_ns):
        wire = packet.payload
        if len(wire) < 60 or wire[0] != 2 or wire[1] not in {1, 0x81}:
            continue
        if struct.unpack_from("!H", wire, 40)[0] != port:
            continue
        if (packet.source[0] == local and packet.destination == (gateway, 5351)
                and wire[1] == 1):
            requests[(packet.source, packet.destination, wire[24:36])].append(packet)
        elif (packet.source == (gateway, 5351) and packet.destination[0] == local and wire[1] == 0x81):
            key = packet.destination, packet.source, wire[24:36]
            prior = requests.get(key, [])
            if prior:
                request = prior[-1]
                proof = pcp6_exchange(request.payload, wire, local, port)
                result.append({**proof, "source": request.source, "responder": packet.source,
                               "sentAtNs": request.timestamp_ns, "receivedAtNs": packet.timestamp_ns})
    return result


def stun_attributes(payload: bytes, message_type: int) -> dict[int, bytes] | None:
    if (len(payload) < 56 or len(payload) > 1200 or len(payload) % 4
            or payload[:2] != struct.pack("!H", message_type) or payload[4:8] != COOKIE
            or struct.unpack_from("!H", payload, 2)[0] + 20 != len(payload)):
        return None
    attributes: dict[int, bytes] = {}
    cursor = 20
    while cursor < len(payload):
        if cursor + 4 > len(payload) or 0x1C in attributes:
            return None
        kind, length = struct.unpack_from("!HH", payload, cursor)
        start, end = cursor + 4, cursor + 4 + length
        cursor = start + ((length + 3) & ~3)
        if kind in attributes or cursor > len(payload):
            return None
        attributes[kind] = payload[start:end]
    return attributes if len(attributes.get(0x1C, b"")) == 32 else None


def outer_observations(packets: list[Packet], binding: Endpoint) -> list[tuple[Packet, Packet, Endpoint]]:
    requests: dict[tuple[Endpoint, bytes], Packet] = {}
    results = []
    for packet in sorted(packets, key=lambda value: value.timestamp_ns):
        if packet.source == binding and packet.destination[0] in {"198.51.100.10", "198.51.100.11"}:
            attributes = stun_attributes(packet.payload, 1)
            if (attributes is not None and re.fullmatch(rb"[A-Za-z0-9_-]{55}", attributes.get(6, b""))
                    and attributes.get(0xC002) == b""):
                requests[(packet.destination, packet.payload[8:20])] = packet
        elif packet.destination == binding:
            request = requests.get((packet.source, packet.payload[8:20]))
            attributes = stun_attributes(packet.payload, 0x101)
            if request is None or attributes is None or len(packet.payload) > len(request.payload):
                continue
            mapped = xor_address(attributes.get(0x20, b""), packet.payload[8:20])
            receipt = attributes.get(0xC001, b"")
            if (mapped is not None and mapped[0] == CLIENT4 and len(receipt) == 51
                    and receipt[0] == 4 and canonical_ip(receipt[1:17]) in {"198.51.100.10", "198.51.100.11"}
                    and struct.unpack_from("!H", receipt, 17)[0] > 0):
                results.append((request, packet, mapped))
    return results


def inner_lease_rejection(packets: list[Packet]) -> dict[str, Any] | None:
    local, gateway, assigned = "10.20.2.2", ("10.20.2.1", 5351), "172.30.2.2"
    requests: dict[tuple[Endpoint, bytes, int], Packet] = {}
    exchanges: list[tuple[Packet, Packet, int, int]] = []
    for packet in sorted(packets, key=lambda value: value.timestamp_ns):
        wire = packet.payload
        if len(wire) < 60 or wire[0] != 2 or wire[1] not in {1, 0x81} or wire[36:40] != b"\x11\0\0\0":
            continue
        port = struct.unpack_from("!H", wire, 40)[0]
        if port == 0:
            continue
        if (packet.source[0] == local and packet.destination == gateway and wire[:4] == b"\x02\x01\0\0"
                and canonical_ip(wire[8:24]) == local and canonical_ip(wire[44:60]) == CLIENT4):
            requests[(packet.source, wire[24:36], port)] = packet
        elif (packet.source == gateway and packet.destination[0] == local and wire[:4] == b"\x02\x81\0\0"):
            request = requests.get((packet.destination, wire[24:36], port))
            if request is not None:
                requested = struct.unpack_from("!I", request.payload, 4)[0]
                granted = struct.unpack_from("!I", wire, 4)[0]
                exchanges.append((request, packet, requested, granted))
    for acquire, grant, requested, lifetime in exchanges:
        if requested == 0 or lifetime == 0 or canonical_ip(grant.payload[44:60]) != assigned:
            continue
        port = struct.unpack_from("!H", acquire.payload, 40)[0]
        binding = local, port
        observations = [observed for observed in outer_observations(packets, binding)
                        if observed[1].timestamp_ns <= acquire.timestamp_ns]
        if not observations:
            continue
        for delete, acknowledgement, delete_lifetime, returned_lifetime in exchanges:
            if (delete_lifetime != 0 or returned_lifetime != 0
                    or delete.timestamp_ns < grant.timestamp_ns
                    or delete.payload[24:36] != acquire.payload[24:36]
                    or delete.payload[40:42] != acquire.payload[40:42]):
                continue
            still_checking = any(packet.source == binding and packet.timestamp_ns > acknowledgement.timestamp_ns
                                 and packet.destination[0] in {DAEMON4, "10.20.1.2"}
                                 and (check := peer_check(packet.payload)) is not None
                                 and check.request and check.direction == "c" for packet in packets)
            still_observing = any(observed[0].timestamp_ns > acknowledgement.timestamp_ns
                                  for observed in outer_observations(packets, binding))
            if still_checking or still_observing:
                return {"privateAddress": local, "privatePort": port,
                        "observedOuterAddress": observations[0][2][0], "rejectedAssignedAddress": assigned,
                        "cleanupWhileBindingLive": True}
    return None


def gateway_pcp4(packets: list[Packet], local: str, gateway: Endpoint,
                  internal_port: int, public_ip: str) -> list[dict[str, Any]]:
    requests: dict[tuple[Endpoint, bytes], Packet] = {}
    result = []
    for packet in sorted(packets, key=lambda value: value.timestamp_ns):
        wire = packet.payload
        if (len(wire) < 60 or wire[36:40] != b"\x11\0\0\0"
                or struct.unpack_from("!H", wire, 40)[0] != internal_port):
            continue
        if (packet.source[0] == local and packet.destination == gateway and wire[:4] == b"\x02\x01\0\0"
                and canonical_ip(wire[8:24]) == local and canonical_ip(wire[44:60]) == public_ip):
            requests[(packet.source, wire[24:36])] = packet
        elif packet.source == gateway and packet.destination[0] == local and wire[:4] == b"\x02\x81\0\0":
            request = requests.get((packet.destination, wire[24:36]))
            if request is None:
                continue
            requested = struct.unpack_from("!I", request.payload, 4)[0]
            granted = struct.unpack_from("!I", wire, 4)[0]
            port = struct.unpack_from("!H", wire, 42)[0]
            if requested > 0 and granted > 0 and port > 0 and canonical_ip(wire[44:60]) == public_ip:
                result.append({"identity": wire[24:36].hex(), "externalPort": port,
                    "epoch": struct.unpack_from("!I", wire, 8)[0], "sentAtNs": request.timestamp_ns,
                    "receivedAtNs": packet.timestamp_ns})
    return result


def pinhole_tuple(rule: dict[str, Any]) -> tuple[str | None, int | None, bool]:
    address, port, udp = None, None, False
    for expression in rule.get("expr", []):
        match = expression.get("match", {})
        if match.get("op") != "==":
            continue
        payload = match.get("left", {}).get("payload", {})
        right = match.get("right")
        raw = payload.get("base"), payload.get("offset"), payload.get("len")
        field = payload.get("protocol"), payload.get("field")
        if field == ("ip6", "daddr") or raw == ("nh", 192, 128):
            if isinstance(right, int):
                address = str(ipaddress.IPv6Address(right))
            elif isinstance(right, str):
                address = str(ipaddress.IPv6Address(int(right, 16) if right.startswith("0x") else right))
        elif field in {("udp", "dport"), ("th", "dport")} or raw == ("th", 16, 16):
            port = int(right, 0) if isinstance(right, str) else right
            udp = udp or field[0] == "udp"
        elif field == ("ip6", "nexthdr") or raw == ("nh", 48, 8):
            udp = udp or right in {17, "udp", "0x11"}
        elif match.get("left", {}).get("meta", {}).get("key") == "l4proto":
            udp = udp or right in {17, "udp", "0x11"}
    return address, port, udp


def matching_pinholes(ruleset: dict[str, Any], address: str, port: int) -> list[dict[str, Any]]:
    return [rule for entry in ruleset.get("nftables", []) if isinstance(rule := entry.get("rule"), dict)
            and rule.get("chain") == "miniupnpd" and pinhole_tuple(rule) == (address, port, True)
            and any("accept" in expression for expression in rule.get("expr", []))]


def pinhole_counters(ruleset: dict[str, Any]) -> dict[str, int]:
    result = {entry["counter"].get("name"): entry["counter"].get("packets")
              for entry in ruleset.get("nftables", []) if isinstance(entry.get("counter"), dict)}
    names = ("pinhole_attempt", "pinhole_denied")
    require(all(isinstance(result.get(name), int) and not isinstance(result[name], bool)
                and result[name] >= 0 for name in names), "pinhole evidence omits real named counters")
    return {name: result[name] for name in names}


def verify_pinhole_gate(ruleset: dict[str, Any], address: str) -> None:
    rules = [entry["rule"] for entry in ruleset.get("nftables", [])
             if isinstance(entry.get("rule"), dict) and entry["rule"].get("family") == "inet"
             and entry["rule"].get("table") == "filter" and entry["rule"].get("chain") == "forward"]
    if rules and {"accept": None} in rules[0].get("expr", []):
        require(observer_bootstrap_rule(rules[0], address),
                "pinhole gate has a broad or mismatched infrastructure exception")
        rules = rules[1:]
    require(len(rules) >= 2, "pinhole firewall has no forced admission gate")
    for index, name in enumerate(("pinhole_attempt", "pinhole_denied")):
        expressions = rules[index].get("expr", [])
        matches = [expression["match"] for expression in expressions if "match" in expression]
        require(any(match.get("left") == {"meta": {"key": "iifname"}}
                    and match.get("op") == "==" and match.get("right") == "wan0" for match in matches)
                and any(match.get("left") == {"payload": {"protocol": "ip6", "field": "daddr"}}
                        and match.get("op") == "==" and match.get("right") == address for match in matches)
                and any(match.get("left") == {"meta": {"key": "l4proto"}}
                        and match.get("op") == "==" and match.get("right") in {17, "udp"} for match in matches),
                "pinhole gate does not select the exact owner GUA and inbound UDP")
        require(any(expression.get("counter") == name or expression.get("counter") == {"name": name}
                    for expression in expressions), "pinhole gate omits its named attempt/denial counter")
        verdict = {"jump": {"target": "miniupnpd"}} if index == 0 else {"drop": None}
        require(verdict in expressions, "pinhole gate allows conntrack to bypass the actual gateway")


def observer_bootstrap_rule(rule: dict[str, Any], address: str) -> bool:
    expected = {
        json.dumps({"meta": {"key": "iifname"}}, sort_keys=True): {"wan0"},
        json.dumps({"payload": {"protocol": "ip6", "field": "daddr"}}, sort_keys=True): {address},
        json.dumps({"payload": {"protocol": "ip6", "field": "saddr"}}, sort_keys=True): {
            "2001:db8:ffff::10", "2001:db8:ffff::11"},
        json.dumps({"payload": {"protocol": "udp", "field": "sport"}}, sort_keys=True): {3478, 3479, 3480},
        json.dumps({"ct": {"key": "state"}}, sort_keys=True): {"established"},
    }
    observed = {}
    verdicts = []
    for expression in rule.get("expr", []):
        match = expression.get("match")
        if not isinstance(match, dict):
            verdicts.append(expression)
            continue
        if match.get("op") not in {"==", "in"}:
            return False
        key = json.dumps(match.get("left"), sort_keys=True)
        if key in observed:
            return False
        value = match.get("right")
        values = value.get("set") if isinstance(value, dict) else [value]
        if not isinstance(values, list) or not all(isinstance(item, (str, int)) for item in values):
            return False
        observed[key] = set(values)
    # Some nft listings retain the UDP dependency selector generated by `udp sport`.
    protocol = observed.pop(json.dumps({"meta": {"key": "l4proto"}}, sort_keys=True), None)
    if protocol is not None and protocol not in ({17}, {"udp"}):
        return False
    return observed == expected and verdicts == [{"accept": None}]


def verify_gateway_preflight(state: Path, role: str, protocol: str, address: str,
                              gateway: str) -> None:
    facts = json.loads((state / "gateway-preflight.json").read_text())
    require(facts.get("kind") == "independent-real-gateway-preflight" and facts.get("role") == role
            and facts.get("protocol") == protocol and facts.get("local") == address
            and facts.get("gateway") == gateway and facts.get("port") == 24021,
            "gateway preflight belongs to another endpoint/protocol")
    controls = []
    for operation, action in (("acquire", "AddPinhole"), ("renew", "UpdatePinhole"),
                              ("delete", "DeletePinhole")):
        fact = facts[operation]
        require(fact["source"][0] == address and fact["responder"][0] == gateway
                and fact["sentAtNs"] <= fact["receivedAtNs"], "gateway preflight control endpoint/time mismatch")
        if protocol == "pcp":
            require(fact["responder"][1] == 5351, "PCP preflight answered on another service")
            proof = pcp6_exchange(bytes.fromhex(fact["request"]), bytes.fromhex(fact["response"]), address, 24021)
        else:
            proof = igd6_exchange(action, fact["requestBody"], fact["responseBody"], address, 24021, fact["source"][0])
        controls.append(proof)
    require(len({proof["identity"] for proof in controls}) == 1
            and all(proof["grantedLifetimeSeconds"] > 0 for proof in controls[:2])
            and controls[2]["grantedLifetimeSeconds"] == 0,
            "gateway preflight did not acquire/renew/delete the same real pinhole")
    for key in ("acquiredRule", "renewedRule"):
        require(pinhole_tuple(facts[key]) == (address, 24021, True)
                and any("accept" in expression for expression in facts[key].get("expr", [])),
                "gateway preflight kernel rule names another socket")
    require(facts["acquiredRule"].get("handle") != facts["renewedRule"].get("handle"),
            "gateway preflight did not replace its kernel rule on renewal")
    require(not matching_pinholes(facts["beforeGrantState"], address, 24021)
            and not matching_pinholes(facts["deletedState"], address, 24021),
            "gateway preflight pinhole remained before grant or after deletion")
    before, arrived, deleted = facts["beforeGrant"], facts["afterArrival"]["counters"], facts["afterDelete"]
    require(before["pinhole_denied"] > 0 and arrived["pinhole_attempt"] > before["pinhole_attempt"]
            and arrived["pinhole_denied"] == before["pinhole_denied"]
            and deleted["pinhole_denied"] > arrived["pinhole_denied"],
            "gateway preflight did not enforce denial/admission/deletion in the real firewall")
    if protocol == "igd":
        expiring = facts["expiringAcquire"]
        proof = igd6_exchange("AddPinhole", expiring["requestBody"], expiring["responseBody"],
                              address, 24021, expiring["source"][0])
        require(proof["grantedLifetimeSeconds"] == 2
                and matching_pinholes(facts["expiringState"], address, 24021)
                and not matching_pinholes(facts["expiredState"], address, 24021)
                and facts["expiredAtNs"] > expiring["receivedAtNs"],
                "IGD preflight has no actual short-lived kernel pinhole expiry")


def verify_native_pinhole(case: str, packets: list[Packet], tcp: list[TcpPacket], quic: list[Packet],
                          winners: list[tuple[Pair, list[RoundTrip]]], state: Path) -> dict[str, Any]:
    _, role, protocol = case.split("-")
    address = CLIENT6 if role == "client" else DAEMON6
    gateway = "2001:db8:2::1" if role == "client" else "2001:db8:1::1"
    verify_gateway_preflight(state, role, protocol, address, gateway)
    facts = json.loads((state / "native-pinhole.json").read_text())
    require(facts.get("kind") == "native-kernel-pinhole-lifecycle" and facts.get("case") == case
            and facts.get("role") == role and facts.get("local") == address,
            "native pinhole kernel lifecycle belongs to another endpoint")
    selected_address, port, udp = pinhole_tuple(facts["acquiredRule"])
    require(selected_address == address and udp and isinstance(port, int) and port != 24021
            and any("accept" in expression for expression in facts["acquiredRule"].get("expr", []))
            and all(pair[1 if role == "client" else 0] == (address, port) for pair, _ in winners),
            "native pinhole was not the authenticated winning UDP socket")
    current = json.loads((state / f"{role}-nft.json").read_text())
    verify_pinhole_gate(current, address)
    baseline = pinhole_counters(json.loads((state / "topology" / "pinhole-native-start-nft.json").read_text()))
    require(facts.get("nativeStartCounters") == baseline, "native pinhole admission baseline differs")
    counters = pinhole_counters(current)
    require(all(counters[name] >= baseline[name] for name in baseline),
            "native pinhole counters were reset after their phase boundary")
    admitted = (counters["pinhole_attempt"] - baseline["pinhole_attempt"]
                - counters["pinhole_denied"] + baseline["pinhole_denied"])
    require(admitted > 0, "actual native traffic never used the required gateway pinhole")
    require(not matching_pinholes(current, address, port) and isinstance(facts.get("deletedAtNs"), int),
            "native owner did not delete its actual kernel pinhole on shutdown")
    if protocol == "pcp":
        controls = gateway_pcp(packets, address, gateway, port)
    else:
        controls = []
        for fact in gateway_http(tcp, address, gateway):
            try:
                proof = igd6_exchange(fact["action"], fact["requestBody"], fact["responseBody"],
                                      address, port, fact["source"][0])
            except VerificationError:
                continue  # Other preflight/native sockets have their own exact controls.
            controls.append({**proof, **{key: fact[key] for key in ("sentAtNs", "receivedAtNs", "action")}})
    grants = [fact for fact in controls if fact["grantedLifetimeSeconds"] > 0
              and (protocol == "pcp" or fact.get("action") == "AddPinhole")]
    require(bool(grants), "native pinhole has no successful real control grant in its LAN capture")
    grant = min(grants, key=lambda fact: fact["receivedAtNs"])
    first_quic = min(packet.timestamp_ns for packet in quic)
    require(grant["receivedAtNs"] <= min(first_quic, facts["acquiredAtNs"]),
            "native direct QUIC preceded its actual gateway pinhole grant")
    deleted = [fact for fact in controls if fact["grantedLifetimeSeconds"] == 0
               and fact["identity"] == grant["identity"] and fact["sentAtNs"] >= grant["receivedAtNs"]
               and fact["receivedAtNs"] <= facts["deletedAtNs"]]
    require(bool(deleted), "native pinhole deletion has no matching successful real control request")
    if protocol == "pcp":
        renewals = [fact for fact in controls if fact["grantedLifetimeSeconds"] > 0
                    and fact["identity"] == grant["identity"] and fact["sentAtNs"] > grant["receivedAtNs"]
                    and fact["sentAtNs"] <= facts.get("renewedAtNs", 0)]
        require(bool(renewals) and isinstance(facts.get("renewedAtNs"), int)
                and pinhole_tuple(facts["renewedRule"]) == (address, port, True)
                and facts["renewedRule"].get("handle") != facts["acquiredRule"].get("handle"),
                "native PCPv6 pinhole has no same-nonce wire renewal and replaced kernel rule")
        require(any(bidirectional_after(quic, pair, facts["renewedAtNs"]) for pair, _ in winners),
                "native PCPv6 renewal has no subsequent authenticated direct traffic")
    return {"role": role, "protocol": protocol, "address": address, "port": port,
            "admittedNativePackets": admitted, "nativeRenewalVerified": protocol == "pcp",
            "nativeDeletionVerified": True, "independentGatewayLifecycleVerified": True}


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
    new_long = [packet for packet in quic if oriented_pair(packet, case) == new
                and quic_long_header(packet.payload) is not None]
    first_client_long = min((packet.timestamp_ns for packet in new_long if packet.source == new[1]),
                            default=None)
    new_trips = [trip for trip in trips if trip.direction == "c"
                 and oriented_pair(trip.request, case) == new and first_client_long is not None
                 and trip.response.timestamp_ns <= first_client_long]
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


def verify_gateway_reboot(lifecycle: dict[str, Any], quic: list[Packet], case: str, state: Path,
                           trips: list[RoundTrip], packets: list[Packet]) -> None:
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
    require(protocol == "pcp", "gateway reboot proof requires a fresh PCP grant nonce")
    record = json.loads((topology / f"reacquired-{role}-lease.json").read_text())
    public_ip = DAEMON4 if role == "daemon" else CLIENT4
    require(record.get("role") == role and record.get("protocol") == protocol
            and record.get("publicIP") == public_ip and completed <= record.get("observedAtNs", 0) <= reacquired
            and all(record.get(key) == details.get(key)
                    for key in ("previousEpoch", "currentEpoch", "previousPid", "currentPid")),
            "reacquired lease metadata does not match the actual gateway reset")
    prior, successor = record.get("previous"), record.get("current")
    require(isinstance(prior, dict) and isinstance(successor, dict)
            and prior.get("privateIP") == successor.get("privateIP") == f"10.20.{number}.2"
            and isinstance(prior.get("localPort"), int) and prior["localPort"] == successor.get("localPort"),
            "gateway reboot reacquired a different native UDP binding")
    local = {"privateAddress": prior["privateIP"], "privatePort": prior["localPort"]}
    before_path = topology / f"before-gateway-reboot-{role}-nft.json"
    after_path = topology / f"reacquired-{role}-nft.json"
    require(prior.get("externalPort") in lease_rule_ports(before_path, local)
            and successor.get("externalPort") in lease_rule_ports(after_path, local),
            "gateway reboot has no exact previous and reacquired kernel router leases")
    for item, path in ((prior, before_path), (successor, after_path)):
        rules = [entry["rule"] for entry in json.loads(path.read_text()).get("nftables", []) if "rule" in entry]
        require(item.get("rule") in rules, "gateway lease metadata names a rule absent from its kernel snapshot")
    controls = gateway_pcp4(packets, local["privateAddress"], (f"10.20.{number}.1", 5351),
                            local["privatePort"], public_ip)
    old_nonces = {control["identity"] for control in controls if control["receivedAtNs"] < started
                  and control["externalPort"] == prior["externalPort"]}
    require(bool(old_nonces), "gateway reboot has no actual initial PCP grant nonce")
    require(any(control["sentAtNs"] >= started and control["identity"] not in old_nonces
                and control["externalPort"] == successor["externalPort"]
                and control["epoch"] >= current for control in controls),
            "gateway reboot has no fresh same-binding PCP nonce/grant after its wire epoch reset")
    pairs = {oriented_pair(packet, case) for packet in quic}
    initial_used = False
    recovered = False
    for pair in pairs:
        if pair is None:
            continue
        own, peer = (pair[0], pair[1]) if role == "daemon" else (pair[1], pair[0])
        try:
            lease_from_snapshots(state, role, pair, local,
                [trip for trip in trips if trip.response.timestamp_ns < started], case,
                rule_paths=[before_path],
                conntrack_paths=[topology / f"before-gateway-reboot-{role}-conntrack.txt"])
            initial_used = True
        except VerificationError:
            pass
        if bidirectional_after(quic, pair, reacquired):
            try:
                mapping = mapping_from_snapshots(state, role, own, peer, {local["privateAddress"]}, False)
                recovered = recovered or mapping["privatePort"] == local["privatePort"]
            except VerificationError:
                pass
    require(initial_used, "gateway reboot has no exact lease admission on its previously used native binding")
    require(recovered, "gateway reboot has no bidirectional QUIC recovery on the same native binding")


def verify(case: str, captures: list[Path], state: Path) -> dict[str, Any]:
    require(case in POSITIVE_CASES | NEGATIVE_CASES, f"unknown native NAT case {case}")
    require(bool(captures), "at least one capture is required")
    packets: list[Packet] = []
    tcp: list[TcpPacket] = []
    records = 0
    for path in captures:
        capture = read_capture(path)
        verify_capture_summary(state / f"{path.stem}.stderr", capture.records)
        packets.extend(capture.packets)
        tcp.extend(capture.tcp)
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
    gateway_pairs = gateway_migrations(peer_packets, trips, case, lifecycle, state)
    quic = quic_packets(peer_packets, case, lifecycle, gateway_pairs)
    if case == "ipv6-pdf" or case in IPV6_PINHOLE_CASES:
        v4_packets = [packet for packet in packets if oriented_pair(packet, "eim-pdf") is not None
                      and (lifecycle is None or "nativeSessionsStartedAtNs" not in lifecycle
                           or packet.timestamp_ns >= lifecycle["nativeSessionsStartedAtNs"])]
        require(not quic_packets(v4_packets, "eim-pdf"),
                "strict IPv6 topology emitted a direct IPv4 QUIC dial")
    summary: dict[str, Any] = {
        "case": case, "captureRecords": records, "peerCheckRequests": request_count,
        "checkRoundTrips": len(trips), "peerQuicPackets": len(quic),
    }
    if case in NEGATIVE_CASES:
        drops = named_drop_count(state / "daemon-nft.json") + named_drop_count(state / "client-nft.json")
        if case == "inner-lease":
            drops += named_drop_count(state / "outer-nft.json")
        require(request_count > 0, "negative case contains no native peer-check attempt")
        require(drops > 0, "negative topology did not record a peer packet being filtered")
        require(not quic, "an unverified direct QUIC dial escaped the negative topology")
        summary.update({"outcome": "relay", "filteredPeerPackets": drops})
        if case == "inner-lease":
            inner = inner_lease_rejection(packets)
            require(inner is not None,
                    "inner NAT has no mismatched PCP grant/deletion proof while the native binding remains live")
            summary["innerLeaseRejected"] = inner
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
        if pair == migrated or pair in gateway_pairs:
            recovery_headers = [packet for packet in quic if oriented_pair(packet, case) == pair
                                and quic_long_header(packet.payload) is not None]
            first_fresh_dial = min((packet.timestamp_ns for packet in quic
                                   if oriented_pair(packet, case) == pair and packet.source == pair[1]
                                   and quic_long_header(packet.payload) is not None), default=None)
            require(not recovery_headers or first_fresh_dial is not None,
                    "recovery QUIC handshake has no checked client dial")
            if first_fresh_dial is not None:
                require(any(trip.direction == "c" and trip.response.timestamp_ns <= first_fresh_dial
                            for trip in candidate_trips), "recovery QUIC dial preceded its successful client check")
                require(any(packet.source == pair[0] and packet.destination == pair[1]
                            and packet.timestamp_ns <= first_fresh_dial
                            and (check := peer_check(packet.payload)) is not None
                            and check.request and check.direction == "d" for packet in peer_packets),
                        "recovery QUIC dial preceded its daemon filter-opening check")
            if pair not in gateway_pairs or bidirectional_after(quic, pair, lifecycle["gatewayRebootStartedAtNs"]):
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
    if case in IPV6_PINHOLE_CASES:
        summary["pinhole"] = verify_native_pinhole(case, packets, tcp, quic, winners, state)
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
            verify_gateway_reboot(lifecycle, quic, case, state, trips, packets)
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
        if pair in gateway_pairs:
            authority = gateway_pairs[pair]
            evidence["checkAuthorityInheritedFrom"] = {
                "daemonEndpoint": list(authority[0]), "clientEndpoint": list(authority[1]),
                "knownClientCidAndSamePrivateSocketsVerified": True,
            }
        if case not in {"lan", "ipv6-pdf"} | IPV6_PINHOLE_CASES:
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
                evidence["leaseAdmission"] = lease_from_snapshots(
                    state, lease_role, gateway_pairs.get(pair, pair), mapping, trips, case)
                if pair in gateway_pairs:
                    evidence["leaseAdmission"].pop("sameCheckContextAsQuic")
                    evidence["leaseAdmission"]["retainedConnectionVerified"] = True
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
    parser.add_argument("--wait-for-inner-lease-rejection", action="store_true")
    args = parser.parse_args()
    try:
        require(sum((args.wait_for_rebind_context, args.wait_for_port_rebind,
                     args.wait_for_inner_lease_rejection)) <= 1,
                "select one live evidence observer")
        if args.wait_for_rebind_context:
            summary = wait_for_rebind_context(args.case, args.capture, args.state)
        elif args.wait_for_port_rebind:
            summary = wait_for_port_rebind(args.case, args.capture, args.state)
        elif args.wait_for_inner_lease_rejection:
            summary = wait_for_inner_lease_rejection(args.case, args.capture)
        else:
            summary = verify(args.case, args.capture, args.state)
    except (OSError, ValueError, VerificationError) as error:
        print(f"native NAT evidence rejected: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
