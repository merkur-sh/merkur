"""Mutation tests for the packet evidence; no network or privileges required."""

import importlib.util
import ipaddress
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("verify_native", Path(__file__).with_name("verify-native.py"))
assert SPEC is not None and SPEC.loader is not None
VERIFY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VERIFY
SPEC.loader.exec_module(VERIFY)


def attribute(kind, value):
    return struct.pack("!HH", kind, len(value)) + value + bytes((-len(value)) % 4)


def request(transaction, direction, context=b"0" * 32):
    attributes = attribute(6, context + b":" + direction.encode())
    attributes += attribute(0x1C, bytes(32))
    return struct.pack("!HH", 1, len(attributes)) + VERIFY.COOKIE + transaction + attributes


def response(transaction, mapped):
    raw_ip = ipaddress.ip_address(mapped[0]).packed
    mask = VERIFY.COOKIE + transaction
    value = bytes([0, 1 if len(raw_ip) == 4 else 2]) + struct.pack("!H", mapped[1] ^ 0x2112)
    value += bytes(a ^ b for a, b in zip(raw_ip, mask))
    attributes = attribute(0x20, value) + attribute(0x1C, bytes(32))
    return struct.pack("!HH", 0x101, len(attributes)) + VERIFY.COOKIE + transaction + attributes


def quic():
    return b"\xc0" + struct.pack("!I", 1) + b"\x08" + b"d" * 8 + b"\x08" + b"s" * 8 + bytes(20)


def pcp6_map(address, port, requested=3600, granted=8, nonce=b"n" * 12):
    request_bytes = bytearray(60)
    request_bytes[:2] = b"\x02\x01"
    struct.pack_into("!I", request_bytes, 4, requested)
    request_bytes[8:24] = ipaddress.IPv6Address(address).packed
    request_bytes[24:36] = nonce
    request_bytes[36] = 17
    struct.pack_into("!HH", request_bytes, 40, port, port)
    request_bytes[44:60] = ipaddress.IPv6Address(address).packed
    response_bytes = bytearray(request_bytes)
    response_bytes[1] = 0x81
    response_bytes[8:24] = bytes(16)
    struct.pack_into("!I", response_bytes, 4, granted)
    return bytes(request_bytes), bytes(response_bytes)


def soap6(action, fields, response=False):
    name = action + ("Response" if response else "")
    arguments = "".join(f"<{key}>{value}</{key}>" for key, value in fields.items())
    return ('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
            f'<u:{name} xmlns:u="urn:schemas-upnp-org:service:WANIPv6FirewallControl:1">'
            f'{arguments}</u:{name}></s:Body></s:Envelope>')


def observation_request(transaction):
    attributes = (attribute(6, b"t" * 55) + attribute(0xC002, b"")
                  + attribute(0x26, bytes(80)) + attribute(0x1C, bytes(32)))
    return struct.pack("!HH", 1, len(attributes)) + VERIFY.COOKIE + transaction + attributes


def observation_response(transaction, mapped, receipt=True):
    packet = response(transaction, mapped)
    identity = (b"\x04" + ipaddress.IPv6Address("::ffff:198.51.100.10").packed
                + struct.pack("!H", 3478) + bytes(32))
    attributes = packet[20:-36] + (attribute(0xC001, identity) if receipt else b"") + packet[-36:]
    return struct.pack("!HH", 0x101, len(attributes)) + VERIFY.COOKIE + transaction + attributes


def pcp4_map(port, lifetime, granted, assigned="172.30.2.2", nonce=b"n" * 12):
    sent, answered = pcp6_map("::ffff:10.20.2.2", port, lifetime, granted, nonce)
    sent, answered = bytearray(sent), bytearray(answered)
    sent[44:60] = ipaddress.IPv6Address("::ffff:198.51.100.2").packed
    answered[44:60] = ipaddress.IPv6Address(f"::ffff:{assigned}").packed
    return bytes(sent), bytes(answered)


def ipv4_udp(source, destination, payload):
    udp = struct.pack("!HHHH", source[1], destination[1], len(payload) + 8, 0) + payload
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, len(udp) + 20, 1, 0, 64, 17, 0,
                     ipaddress.ip_address(source[0]).packed, ipaddress.ip_address(destination[0]).packed)
    return bytes(12) + b"\x08\x00" + ip + udp


def ipv6_udp(source, destination, payload):
    udp = struct.pack("!HHHH", source[1], destination[1], len(payload) + 8, 0) + payload
    ip = struct.pack("!IHBB16s16s", 6 << 28, len(udp), 17, 64,
                     ipaddress.ip_address(source[0]).packed, ipaddress.ip_address(destination[0]).packed)
    return bytes(12) + b"\x86\xdd" + ip + udp


def ipv6_tcp(source, destination, sequence, flags, payload=b""):
    tcp = struct.pack("!HHIIBBHHH", source[1], destination[1], sequence, 0, 0x50,
                      flags, 65535, 0, 0) + payload
    ip = struct.pack("!IHBB16s16s", 6 << 28, len(tcp), 6, 64,
                     ipaddress.IPv6Address(source[0]).packed, ipaddress.IPv6Address(destination[0]).packed)
    return bytes(12) + b"\x86\xdd" + ip + tcp


def timed_pcap(records):
    out = struct.pack("<IHHIIII", 0xA1B23C4D, 2, 4, 0, 0, 262144, 1)
    for timestamp, frame in records:
        seconds, fraction = divmod(timestamp, 1_000_000_000)
        out += struct.pack("<IIII", seconds, fraction, len(frame), len(frame)) + frame
    return out


def pinhole_rule(address, port, handle):
    return {"family": "inet", "table": "filter", "chain": "miniupnpd", "handle": handle,
            "expr": [{"match": {"op": "==", "left": {"payload": {
                "protocol": "ip6", "field": "daddr"}}, "right": address}},
                {"match": {"op": "==", "left": {"payload": {"protocol": "udp", "field": "dport"}},
                           "right": port}}, {"accept": None}]}


def pinhole_state(address, attempted, denied, rules=()):
    predicate = [{"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "wan0"}},
                 {"match": {"op": "==", "left": {"payload": {"protocol": "ip6", "field": "daddr"}},
                            "right": address}},
                 {"match": {"op": "==", "left": {"meta": {"key": "l4proto"}}, "right": "udp"}}]
    forward = [{"family": "inet", "table": "filter", "chain": "forward",
                "expr": predicate + [{"counter": name}, verdict]}
               for name, verdict in (("pinhole_attempt", {"jump": {"target": "miniupnpd"}}),
                                      ("pinhole_denied", {"drop": None}))]
    counters = [{"counter": {"name": name, "packets": value}}
                for name, value in (("pinhole_attempt", attempted), ("pinhole_denied", denied))]
    return {"nftables": counters + [{"rule": rule} for rule in forward + list(rules)]}


def observer_bootstrap(address):
    return {"family": "inet", "table": "filter", "chain": "forward", "expr": [
        {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": "wan0"}},
        {"match": {"op": "==", "left": {"payload": {"protocol": "ip6", "field": "daddr"}},
                   "right": address}},
        {"match": {"op": "==", "left": {"payload": {"protocol": "ip6", "field": "saddr"}},
                   "right": {"set": ["2001:db8:ffff::10", "2001:db8:ffff::11"]}}},
        {"match": {"op": "==", "left": {"payload": {"protocol": "udp", "field": "sport"}},
                   "right": {"set": [3478, 3479, 3480]}}},
        {"match": {"op": "in", "left": {"ct": {"key": "state"}}, "right": "established"}},
        {"accept": None}]}


def pcap(frames, link_type=1):
    out = struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 262144, link_type)
    for index, frame in enumerate(frames):
        out += struct.pack("<IIII", 100, index * 1000, len(frame), len(frame)) + frame
    return out


DAEMON = (VERIFY.DAEMON4, 51000)
CLIENT = (VERIFY.CLIENT4, 52000)


def valid_frames(daemon=DAEMON, client=CLIENT, context=b"0" * 32):
    first, second = b"c" * 12, b"d" * 12
    if context != b"0" * 32:
        first, second = context[:1] + first[1:], context[:1] + second[1:]
    return [
        ipv4_udp(client, daemon, request(first, "c", context)),
        ipv4_udp(daemon, client, response(first, client)),
        ipv4_udp(daemon, client, request(second, "d", context)),
        ipv4_udp(client, daemon, response(second, daemon)),
        ipv4_udp(client, daemon, quic()),
        ipv4_udp(daemon, client, quic()),
    ]


class NativeEvidence(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.capture = self.root / "capture.pcap"
        (self.root / "daemon-conntrack.txt").write_text(
            "udp 17 179 src=10.20.1.2 dst=198.51.100.2 sport=24400 dport=52000 "
            "src=198.51.100.2 dst=198.51.100.1 sport=52000 dport=51000 [ASSURED]\n")
        (self.root / "client-conntrack.txt").write_text(
            "udp 17 179 src=10.20.2.2 dst=198.51.100.1 sport=39000 dport=51000 "
            "src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=52000 [ASSURED]\n")
        for role in ("daemon", "client"):
            (self.root / f"{role}-nft.json").write_text(json.dumps({
                "nftables": [{"counter": {"name": "peer_drop", "packets": 1}}],
            }))

    def tearDown(self):
        self.temporary.cleanup()

    def write_capture(self, frames):
        self.capture.write_bytes(pcap(frames))
        (self.root / "capture.stderr").write_text(
            f"{len(frames)} packets captured\n{len(frames)} packets received by filter\n"
            "0 packets dropped by kernel\n")

    def prove(self, case="eim-pdf"):
        captures = [self.capture]
        if case in VERIFY.IPV6_PINHOLE_CASES:
            captures.append(self.gateway_capture)
        return VERIFY.verify(case, captures, self.root)

    def test_bilateral_checks_and_quic_share_both_translated_endpoints(self):
        self.write_capture(valid_frames())
        proof = self.prove()
        self.assertEqual(proof["outcome"], "direct")
        pair = proof["verifiedPairs"][0]
        self.assertEqual(pair["daemonMapping"], {
            "privateAddress": "10.20.1.2", "privatePort": 24400, "publicPort": 51000})
        self.assertEqual(pair["clientMapping"], {
            "privateAddress": "10.20.2.2", "privatePort": 39000, "publicPort": 52000})

    def test_unrelated_udp_does_not_count_as_checks(self):
        self.write_capture([ipv4_udp(CLIENT, DAEMON, b"not a check"),
                            ipv4_udp(CLIENT, DAEMON, quic()), ipv4_udp(DAEMON, CLIENT, quic())])
        with self.assertRaisesRegex(VERIFY.VerificationError, "matching two-sided check"):
            self.prove()

    def test_missing_reverse_check_cannot_prove_two_sided_traversal(self):
        frames = valid_frames()
        self.write_capture(frames[:2] + frames[4:])
        with self.assertRaisesRegex(VERIFY.VerificationError, "matching two-sided check"):
            self.prove()

    def test_daemon_send_opens_filter_without_requiring_an_extra_round_trip(self):
        frames = valid_frames()
        self.write_capture(frames[:3] + frames[4:])
        self.assertEqual(self.prove()["outcome"], "direct")

    def test_delayed_daemon_check_cannot_retroactively_authorize_an_earlier_dial(self):
        frames = valid_frames()
        self.write_capture(frames[:2] + frames[4:] + frames[2:4])
        with self.assertRaisesRegex(VERIFY.VerificationError, "daemon filter-opening"):
            self.prove()

    def test_reordered_checks_and_duplicate_datagrams_preserve_exact_tuple_proof(self):
        frames = valid_frames()
        self.write_capture([frames[0], frames[2], frames[0], frames[3], frames[1],
                            frames[1], frames[4], frames[4], frames[5], frames[5]])
        proof = self.prove()
        self.assertEqual(len(proof["verifiedPairs"]), 1)
        self.assertEqual(proof["peerQuicPackets"], 4)

    def test_delayed_response_does_not_retroactively_authorize_an_earlier_dial(self):
        frames = valid_frames()
        self.write_capture([frames[0], frames[2], frames[3], frames[4], frames[1], frames[5]])
        with self.assertRaisesRegex(VERIFY.VerificationError, "successful client check"):
            self.prove()

    def test_fresh_quic_source_port_cannot_reuse_the_check_result(self):
        frames = valid_frames()
        frames[4] = ipv4_udp((CLIENT[0], CLIENT[1] + 1), DAEMON, quic())
        self.write_capture(frames)
        with self.assertRaisesRegex(VERIFY.VerificationError, "matching two-sided check"):
            self.prove()

    def test_quic_before_a_check_response_is_rejected(self):
        frames = valid_frames()
        frames.insert(0, frames.pop(4))
        self.write_capture(frames)
        with self.assertRaisesRegex(VERIFY.VerificationError, "preceded"):
            self.prove()

    def test_matching_transaction_cannot_substitute_an_observed_address(self):
        frames = valid_frames()
        frames[1] = ipv4_udp(DAEMON, CLIENT, response(b"c" * 12, (CLIENT[0], CLIENT[1] + 1)))
        self.write_capture(frames)
        with self.assertRaisesRegex(VERIFY.VerificationError, "matching two-sided check"):
            self.prove()

    def test_truncated_pcap_is_rejected(self):
        self.write_capture(valid_frames())
        self.capture.write_bytes(self.capture.read_bytes()[:-1])
        with self.assertRaisesRegex(VERIFY.VerificationError, "truncated PCAP packet"):
            self.prove()

    def test_reported_capture_loss_is_rejected(self):
        self.write_capture(valid_frames())
        (self.root / "capture.stderr").write_text("6 packets captured\n1 packet dropped by kernel\n")
        with self.assertRaisesRegex(VERIFY.VerificationError, "dropped packets"):
            self.prove()

    def test_absent_capture_completion_is_rejected(self):
        self.write_capture(valid_frames())
        (self.root / "capture.stderr").write_text("tcpdump: listening\n")
        with self.assertRaisesRegex(VERIFY.VerificationError, "summary"):
            self.prove()

    def test_untranslated_control_is_not_a_translated_port_success(self):
        self.write_capture(valid_frames())
        original = (self.root / "client-conntrack.txt").read_text()
        (self.root / "client-conntrack.txt").write_text(original.replace("sport=39000", "sport=52000"))
        with self.assertRaisesRegex(VERIFY.VerificationError, "no translated bidirectional mapping"):
            self.prove()

    def test_controlled_negative_requires_filtered_checks_and_no_direct_dial(self):
        self.write_capture(valid_frames()[:1])
        self.assertEqual(self.prove("blocked")["outcome"], "relay")
        self.write_capture(valid_frames()[:1] + valid_frames()[4:])
        with self.assertRaisesRegex(VERIFY.VerificationError, "unverified direct QUIC"):
            self.prove("blocked")

    def test_inner_nat_requires_actual_mismatched_grant_deleted_while_binding_stays_live(self):
        frames = self._inner_lease()
        self.write_capture(frames)
        proof = self.prove("inner-lease")["innerLeaseRejected"]
        self.assertEqual(proof["rejectedAssignedAddress"], "172.30.2.2")
        self.assertEqual(proof["observedOuterAddress"], VERIFY.CLIENT4)
        self.assertEqual(proof["privatePort"], 39000)
        self.assertTrue(proof["cleanupWhileBindingLive"])
        self.assertIn("innerLeaseRejected", VERIFY.wait_for_inner_lease_rejection("inner-lease", [self.capture]))

    def test_inner_nat_cannot_pass_with_only_filtered_peer_checks(self):
        self.write_capture([self._inner_lease()[0]])
        with self.assertRaisesRegex(VERIFY.VerificationError, "mismatched PCP grant/deletion"):
            self.prove("inner-lease")

    def test_inner_nat_counts_its_actual_outer_router_filter(self):
        self.write_capture(self._inner_lease())
        for role in ("client", "daemon"):
            (self.root / f"{role}-nft.json").write_text(json.dumps({"nftables": [
                {"counter": {"name": "peer_drop", "packets": 0}}]}))
        self.assertEqual(self.prove("inner-lease")["filteredPeerPackets"], 8)
        (self.root / "outer-nft.json").write_text(json.dumps({"nftables": [
            {"counter": {"name": "peer_drop", "packets": 0}}]}))
        with self.assertRaisesRegex(VERIFY.VerificationError, "did not record a peer packet"):
            self.prove("inner-lease")

    def test_inner_nat_delete_must_match_nonce_and_internal_binding_port(self):
        for nonce, port in ((b"x" * 12, 39000), (b"n" * 12, 39001)):
            with self.subTest(port=port, changed_nonce=nonce != b"n" * 12):
                frames = self._inner_lease(delete_nonce=nonce, delete_port=port)
                self.write_capture(frames)
                with self.assertRaisesRegex(VERIFY.VerificationError, "mismatched PCP grant/deletion"):
                    self.prove("inner-lease")

    def test_inner_nat_cannot_count_normal_close_cleanup_after_the_binding_stopped(self):
        frames = self._inner_lease()
        self.write_capture(frames[:-1])
        with self.assertRaisesRegex(VERIFY.VerificationError, "native binding remains live"):
            self.prove("inner-lease")

    def test_inner_nat_cannot_substitute_a_different_live_udp_binding(self):
        frames = self._inner_lease()
        frames[-1] = ipv4_udp(("10.20.2.2", 39001), (VERIFY.DAEMON4, 51110), request(b"p" * 12, "c"))
        self.write_capture(frames)
        with self.assertRaisesRegex(VERIFY.VerificationError, "native binding remains live"):
            self.prove("inner-lease")

    def test_inner_nat_observation_requires_its_responder_receipt(self):
        frames = self._inner_lease(receipt=False)
        self.write_capture(frames)
        with self.assertRaisesRegex(VERIFY.VerificationError, "mismatched PCP grant/deletion"):
            self.prove("inner-lease")

    def test_a_real_edge_grant_does_not_prove_an_inner_nat_rejection(self):
        frames = self._inner_lease(assigned=VERIFY.CLIENT4)
        self.write_capture(frames)
        with self.assertRaisesRegex(VERIFY.VerificationError, "mismatched PCP grant/deletion"):
            self.prove("inner-lease")

    def test_inner_nat_does_not_use_an_observation_from_another_udp_binding(self):
        frames = self._inner_lease(observed_port=39001)
        self.write_capture(frames)
        with self.assertRaisesRegex(VERIFY.VerificationError, "mismatched PCP grant/deletion"):
            self.prove("inner-lease")

    def _inner_lease(self, delete_nonce=b"n" * 12, delete_port=39000, receipt=True,
                     assigned="172.30.2.2", observed_port=39000):
        (self.root / "outer-nft.json").write_text(json.dumps({"nftables": [{"counter": {"name": "peer_drop", "packets": 8}}]}))
        binding, observer = ("10.20.2.2", observed_port), ("198.51.100.10", 3478)
        control, cleanup, gateway = ("10.20.2.2", 44000), ("10.20.2.2", 44001), ("10.20.2.1", 5351)
        acquire, grant = pcp4_map(39000, 3600, 120, assigned=assigned)
        delete, acknowledgement = pcp4_map(delete_port, 0, 0, assigned=assigned, nonce=delete_nonce)
        transaction = b"o" * 12
        return [ipv4_udp(CLIENT, (VERIFY.DAEMON4, 51110), request(b"p" * 12, "c")),
                ipv4_udp(binding, observer, observation_request(transaction)),
                ipv4_udp(observer, binding, observation_response(transaction, CLIENT, receipt)),
                ipv4_udp(control, gateway, acquire), ipv4_udp(gateway, control, grant),
                ipv4_udp(cleanup, gateway, delete), ipv4_udp(gateway, cleanup, acknowledgement),
                ipv4_udp(("10.20.2.2", 39000), (VERIFY.DAEMON4, 51110), request(b"q" * 12, "c"))]

    def test_ipv6_checks_preserve_full_addresses_and_need_no_nat_translation(self):
        daemon, client = (VERIFY.DAEMON6, 24400), (VERIFY.CLIENT6, 39000)
        first, second = b"c" * 12, b"d" * 12
        self.write_capture([
            ipv6_udp(client, daemon, request(first, "c")),
            ipv6_udp(daemon, client, response(first, client)),
            ipv6_udp(daemon, client, request(second, "d")),
            ipv6_udp(client, daemon, quic()),
            ipv6_udp(daemon, client, quic()),
        ])
        proof = self.prove("ipv6-pdf")
        self.assertEqual(proof["verifiedPairs"][0]["clientEndpoint"], list(client))

    def test_strict_ipv6_cannot_hide_an_ipv4_constructor_in_the_same_session(self):
        daemon, client = (VERIFY.DAEMON6, 24400), (VERIFY.CLIENT6, 39000)
        self.write_capture([
            ipv6_udp(client, daemon, request(b"c" * 12, "c")),
            ipv6_udp(daemon, client, response(b"c" * 12, client)),
            ipv6_udp(daemon, client, request(b"d" * 12, "d")),
            ipv6_udp(client, daemon, quic()), ipv6_udp(daemon, client, quic()),
            ipv4_udp(CLIENT, DAEMON, quic()),
        ])
        with self.assertRaisesRegex(VERIFY.VerificationError, "direct IPv4 QUIC"):
            self.prove("ipv6-pdf")

    def test_pcpv6_proof_binds_nonce_native_address_and_unchanged_udp_port(self):
        request_bytes, response_bytes = pcp6_map(VERIFY.CLIENT6, 39000)
        grant = VERIFY.pcp6_exchange(request_bytes, response_bytes, VERIFY.CLIENT6, 39000)
        self.assertEqual(grant["grantedLifetimeSeconds"], 8)
        for mutation in (24, 43, 59):
            with self.subTest(mutation=mutation):
                corrupted = bytearray(response_bytes)
                corrupted[mutation] ^= 1
                with self.assertRaises(VERIFY.VerificationError):
                    VERIFY.pcp6_exchange(request_bytes, bytes(corrupted), VERIFY.CLIENT6, 39000)

    def test_pcpv6_delete_requires_a_real_zero_lifetime_reply(self):
        request_bytes, response_bytes = pcp6_map(VERIFY.DAEMON6, 24400, requested=0, granted=0)
        self.assertEqual(VERIFY.pcp6_exchange(request_bytes, response_bytes, VERIFY.DAEMON6, 24400)[
            "grantedLifetimeSeconds"], 0)
        corrupted = bytearray(response_bytes)
        struct.pack_into("!I", corrupted, 4, 8)
        with self.assertRaisesRegex(VERIFY.VerificationError, "lifetime"):
            VERIFY.pcp6_exchange(request_bytes, bytes(corrupted), VERIFY.DAEMON6, 24400)

    def test_igdv2_pinhole_proof_binds_source_socket_and_renew_delete_unique_id(self):
        address, port = VERIFY.CLIENT6, 39000
        arguments = {"RemoteHost": "", "RemotePort": 0, "InternalClient": address,
                     "InternalPort": port, "Protocol": 17, "LeaseTime": 3600}
        opened = VERIFY.igd6_exchange("AddPinhole", soap6("AddPinhole", arguments),
            soap6("AddPinhole", {"UniqueID": 23}, response=True), address, port, address)
        self.assertEqual(opened["identity"], "23")
        self.assertEqual(opened["grantedLifetimeSeconds"], 3600)
        for action, fields in (("UpdatePinhole", {"UniqueID": 23, "NewLeaseTime": 3600}),
                               ("DeletePinhole", {"UniqueID": 23})):
            proof = VERIFY.igd6_exchange(action, soap6(action, fields),
                soap6(action, {}, response=True), address, port, address)
            self.assertEqual(proof["identity"], opened["identity"])
        with self.assertRaisesRegex(VERIFY.VerificationError, "InternalClient"):
            VERIFY.igd6_exchange("AddPinhole", soap6("AddPinhole", arguments),
                soap6("AddPinhole", {"UniqueID": 23}, response=True), address, port, VERIFY.DAEMON6)

    def test_all_four_native_ipv6_pinhole_cases_require_real_control_and_used_kernel_gate(self):
        for role in ("client", "daemon"):
            for protocol in ("pcp", "igd"):
                with self.subTest(role=role, protocol=protocol):
                    case = self._native_pinhole(role, protocol)
                    proof = self.prove(case)
                    self.assertEqual(proof["pinhole"]["role"], role)
                    self.assertTrue(proof["pinhole"]["nativeDeletionVerified"])
                    self.assertEqual(proof["pinhole"]["nativeRenewalVerified"], protocol == "pcp")

    def test_native_ipv6_cannot_substitute_independent_probe_for_native_wire_controls(self):
        case = self._native_pinhole("client", "pcp")
        self.gateway_capture.write_bytes(timed_pcap([]))
        (self.root / "v6-gateway.stderr").write_text("0 packets captured\n0 packets dropped by kernel\n")
        with self.assertRaisesRegex(VERIFY.VerificationError, "real control grant"):
            self.prove(case)

    def test_native_ipv6_requires_pinhole_before_conntrack_acceptance(self):
        case = self._native_pinhole("client", "igd")
        path = self.root / "client-nft.json"
        state = json.loads(path.read_text())
        state["nftables"].insert(2, {"rule": {"family": "inet", "table": "filter", "chain": "forward",
            "expr": [{"match": {"op": "==", "left": {"ct": {"key": "state"}},
                                   "right": "established"}}, {"accept": None}]}})
        path.write_text(json.dumps(state))
        with self.assertRaisesRegex(VERIFY.VerificationError, "pinhole gate"):
            self.prove(case)

    def test_pinhole_gate_allows_only_established_replies_from_exact_stun_infrastructure(self):
        state = pinhole_state(VERIFY.CLIENT6, 12, 3)
        state["nftables"].insert(2, {"rule": observer_bootstrap(VERIFY.CLIENT6)})
        VERIFY.verify_pinhole_gate(state, VERIFY.CLIENT6)

    def test_pinhole_bootstrap_cannot_allow_peer_addresses_or_other_ports(self):
        for field, value in (("saddr", {"set": ["2001:db8:ffff::10", VERIFY.DAEMON6]}),
                             ("sport", {"set": [3478, 3479, 4433]})):
            with self.subTest(field=field):
                state = pinhole_state(VERIFY.CLIENT6, 12, 3)
                rule = observer_bootstrap(VERIFY.CLIENT6)
                match = next(expression["match"] for expression in rule["expr"]
                             if expression.get("match", {}).get("left", {}).get("payload", {}).get("field") == field)
                match["right"] = value
                state["nftables"].insert(2, {"rule": rule})
                with self.assertRaisesRegex(VERIFY.VerificationError, "infrastructure exception"):
                    VERIFY.verify_pinhole_gate(state, VERIFY.CLIENT6)

    def test_pinhole_bootstrap_requires_exact_destination_and_established_only(self):
        for removed in ("destination", "state"):
            with self.subTest(removed=removed):
                state = pinhole_state(VERIFY.CLIENT6, 12, 3)
                rule = observer_bootstrap(VERIFY.CLIENT6)
                rule["expr"] = [expression for expression in rule["expr"]
                                if not (expression.get("match", {}).get("left", {}) == (
                                    {"payload": {"protocol": "ip6", "field": "daddr"}}
                                    if removed == "destination" else {"ct": {"key": "state"}}))]
                state["nftables"].insert(2, {"rule": rule})
                with self.assertRaisesRegex(VERIFY.VerificationError, "infrastructure exception"):
                    VERIFY.verify_pinhole_gate(state, VERIFY.CLIENT6)

    def test_pinhole_bootstrap_cannot_put_a_second_established_accept_before_the_gate(self):
        state = pinhole_state(VERIFY.CLIENT6, 12, 3)
        bypass = {"family": "inet", "table": "filter", "chain": "forward", "expr": [
            {"match": {"op": "in", "left": {"ct": {"key": "state"}}, "right": "established"}},
            {"accept": None}]}
        state["nftables"][2:2] = [{"rule": observer_bootstrap(VERIFY.CLIENT6)}, {"rule": bypass}]
        with self.assertRaisesRegex(VERIFY.VerificationError, "pinhole gate"):
            VERIFY.verify_pinhole_gate(state, VERIFY.CLIENT6)

    def test_pinhole_bootstrap_does_not_accept_new_related_or_untracked_packets(self):
        for verdict in ("new", "untracked", {"set": ["established", "related"]}):
            with self.subTest(state=verdict):
                state = pinhole_state(VERIFY.CLIENT6, 12, 3)
                rule = observer_bootstrap(VERIFY.CLIENT6)
                rule["expr"][-2]["match"]["right"] = verdict
                state["nftables"].insert(2, {"rule": rule})
                with self.assertRaisesRegex(VERIFY.VerificationError, "infrastructure exception"):
                    VERIFY.verify_pinhole_gate(state, VERIFY.CLIENT6)

    def test_native_pcpv6_renewal_cannot_replace_its_nonce_with_another_grant(self):
        case = self._native_pinhole("daemon", "pcp", renewal_nonce=b"x" * 12)
        with self.assertRaisesRegex(VERIFY.VerificationError, "same-nonce wire renewal"):
            self.prove(case)

    def test_native_ipv6_deletion_requires_actual_kernel_rule_removal(self):
        case = self._native_pinhole("daemon", "igd")
        path = self.root / "daemon-nft.json"
        state = json.loads(path.read_text())
        state["nftables"].append({"rule": pinhole_rule(VERIFY.DAEMON6, 24400, 10)})
        path.write_text(json.dumps(state))
        with self.assertRaisesRegex(VERIFY.VerificationError, "delete its actual kernel pinhole"):
            self.prove(case)

    def test_raw_pinhole_transport_port_requires_an_independent_udp_protocol_match(self):
        rule = {"chain": "miniupnpd", "expr": [
            {"match": {"op": "==", "left": {"payload": {
                "base": "nh", "offset": 192, "len": 128}},
                "right": hex(int(ipaddress.IPv6Address(VERIFY.CLIENT6)))}},
            {"match": {"op": "==", "left": {"payload": {
                "base": "th", "offset": 16, "len": 16}}, "right": "0x9858"}},
            {"accept": None}]}
        self.assertEqual(VERIFY.pinhole_tuple(rule), (VERIFY.CLIENT6, 39000, False))
        rule["expr"].insert(0, {"match": {"op": "==", "left": {"payload": {
            "base": "nh", "offset": 48, "len": 8}}, "right": "0x11"}})
        self.assertEqual(VERIFY.pinhole_tuple(rule), (VERIFY.CLIENT6, 39000, True))

    def test_native_igd_http_reassembly_handles_segmentation_reordering_and_retransmission(self):
        self._native_pinhole("client", "igd")
        captured = list(VERIFY.read_capture(self.gateway_capture).tcp)
        index = next(index for index, packet in enumerate(captured)
                     if packet.source[0] == VERIFY.CLIENT6 and packet.payload)
        original = captured.pop(index)
        first = VERIFY.TcpPacket(original.timestamp_ns + 2, original.source, original.destination,
                                  original.sequence, original.flags, original.payload[:37])
        second = VERIFY.TcpPacket(original.timestamp_ns + 1, original.source, original.destination,
                                   original.sequence + 37, original.flags, original.payload[37:])
        captured += [second, first, first]
        facts = VERIFY.gateway_http(captured, VERIFY.CLIENT6, "2001:db8:2::1")
        self.assertEqual([fact["action"] for fact in facts], ["AddPinhole", "DeletePinhole"])

    def test_native_igd_http_rejects_conflicting_retransmission_bytes(self):
        self._native_pinhole("client", "igd")
        captured = list(VERIFY.read_capture(self.gateway_capture).tcp)
        original = next(packet for packet in captured if packet.source[0] == VERIFY.CLIENT6 and packet.payload)
        captured.append(VERIFY.TcpPacket(original.timestamp_ns + 1, original.source, original.destination,
            original.sequence, original.flags, bytes([original.payload[0] ^ 1]) + original.payload[1:]))
        with self.assertRaisesRegex(VERIFY.VerificationError, "conflicting TCP retransmissions"):
            VERIFY.gateway_http(captured, VERIFY.CLIENT6, "2001:db8:2::1")

    def test_native_igd_http_rejects_missing_bytes_in_a_successful_control_stream(self):
        self._native_pinhole("client", "igd")
        captured = list(VERIFY.read_capture(self.gateway_capture).tcp)
        index = next(index for index, packet in enumerate(captured)
                     if packet.source[0] == VERIFY.CLIENT6 and packet.payload)
        original = captured[index]
        captured[index] = VERIFY.TcpPacket(original.timestamp_ns, original.source, original.destination,
            original.sequence + 1, original.flags, original.payload[1:])
        with self.assertRaisesRegex(VERIFY.VerificationError, "missing TCP bytes"):
            VERIFY.gateway_http(captured, VERIFY.CLIENT6, "2001:db8:2::1")

    def _native_pinhole(self, role, protocol, renewal_nonce=b"n" * 12):
        case = f"ipv6-{role}-{protocol}"
        local = VERIFY.CLIENT6 if role == "client" else VERIFY.DAEMON6
        gateway = "2001:db8:2::1" if role == "client" else "2001:db8:1::1"
        port = 39000 if role == "client" else 24400
        daemon, client = (VERIFY.DAEMON6, 24400), (VERIFY.CLIENT6, 39000)
        self.write_capture([ipv6_udp(client, daemon, request(b"c" * 12, "c")),
                            ipv6_udp(daemon, client, response(b"c" * 12, client)),
                            ipv6_udp(daemon, client, request(b"d" * 12, "d")),
                            ipv6_udp(client, daemon, quic()), ipv6_udp(daemon, client, quic())])
        peer_records = [(100_000_000_000 + index * 1_000_000, frame)
                        for index, frame in enumerate([
                            ipv6_udp(client, daemon, request(b"c" * 12, "c")),
                            ipv6_udp(daemon, client, response(b"c" * 12, client)),
                            ipv6_udp(daemon, client, request(b"d" * 12, "d")),
                            ipv6_udp(client, daemon, quic()), ipv6_udp(daemon, client, quic())])]
        peer_records += [(220_000_000_000, ipv6_udp(client, daemon, b"\x40" + b"d" * 8 + bytes(24))),
                         (220_001_000_000, ipv6_udp(daemon, client, b"\x40" + b"s" * 8 + bytes(24)))]
        self.capture.write_bytes(timed_pcap(peer_records))
        (self.root / "capture.stderr").write_text("7 packets captured\n0 packets dropped by kernel\n")
        self._write_lifecycle({})
        baseline = pinhole_state(local, 3, 2)
        (self.root / "topology" / "pinhole-native-start-nft.json").write_text(json.dumps(baseline))
        (self.root / f"{role}-nft.json").write_text(json.dumps(pinhole_state(local, 12, 3)))
        native = {"kind": "native-kernel-pinhole-lifecycle", "role": role, "case": case, "local": local,
                  "acquiredAtNs": 100_005_000_000, "acquiredRule": pinhole_rule(local, port, 10),
                  "nativeStartCounters": {"pinhole_attempt": 3, "pinhole_denied": 2},
                  "deletedAtNs": 222_000_000_000}
        if protocol == "pcp":
            native.update(renewedAtNs=219_005_000_000, renewedRule=pinhole_rule(local, port, 11))
        (self.root / "native-pinhole.json").write_text(json.dumps(native))

        def fact(operation, selected_port, sent, lifetime=0, nonce=b"p" * 12):
            result = {"source": [local, 44000], "responder": [gateway, 5351 if protocol == "pcp" else 5000],
                      "sentAtNs": sent, "receivedAtNs": sent + 1_000_000}
            if protocol == "pcp":
                request_bytes, response_bytes = pcp6_map(local, selected_port, lifetime, lifetime, nonce)
                result.update(request=request_bytes.hex(), response=response_bytes.hex())
            else:
                action = {"acquire": "AddPinhole", "renew": "UpdatePinhole", "delete": "DeletePinhole"}[operation]
                arguments = ({"RemoteHost": "", "RemotePort": 0, "InternalClient": local,
                              "InternalPort": selected_port, "Protocol": 17, "LeaseTime": lifetime}
                             if operation == "acquire" else {"UniqueID": 23, **(
                                 {"NewLeaseTime": lifetime} if operation == "renew" else {})})
                result.update(action=action, requestBody=soap6(action, arguments),
                              responseBody=soap6(action, {"UniqueID": 23} if operation == "acquire" else {}, True))
            return result

        preflight = {"kind": "independent-real-gateway-preflight", "role": role, "protocol": protocol,
                     "local": local, "gateway": gateway, "port": 24021,
                     "beforeGrantState": pinhole_state(local, 1, 1),
                     "deletedState": pinhole_state(local, 3, 2),
                     "beforeGrant": {"pinhole_attempt": 1, "pinhole_denied": 1},
                     "afterArrival": {"counters": {"pinhole_attempt": 2, "pinhole_denied": 1}},
                     "afterDelete": {"pinhole_attempt": 3, "pinhole_denied": 2},
                     "acquiredRule": pinhole_rule(local, 24021, 1), "renewedRule": pinhole_rule(local, 24021, 2),
                     "acquire": fact("acquire", 24021, 80_000_000_000, 120),
                     "renew": fact("renew", 24021, 81_000_000_000, 240),
                     "delete": fact("delete", 24021, 82_000_000_000)}
        if protocol == "igd":
            preflight.update(expiringAcquire=fact("acquire", 24021, 83_000_000_000, 2),
                expiringState=pinhole_state(local, 3, 2, [pinhole_rule(local, 24021, 3)]),
                expiredState=pinhole_state(local, 3, 2), expiredAtNs=85_100_000_000)
        (self.root / "gateway-preflight.json").write_text(json.dumps(preflight))
        controls = [fact("acquire", port, 99_000_000_000, 240 if protocol == "pcp" else 3600, b"n" * 12)]
        if protocol == "pcp":
            controls.append(fact("renew", port, 219_000_000_000, 240, renewal_nonce))
        controls.append(fact("delete", port, 221_000_000_000, nonce=b"n" * 12))
        records = []
        for index, control in enumerate(controls):
            source, server = (local, 45000 + index), (gateway, 5351 if protocol == "pcp" else 5000)
            sent = control["sentAtNs"]
            if protocol == "pcp":
                records += [(sent, ipv6_udp(source, server, bytes.fromhex(control["request"]))),
                            (control["receivedAtNs"], ipv6_udp(server, source, bytes.fromhex(control["response"])))]
            else:
                body, answer = control["requestBody"].encode(), control["responseBody"].encode()
                service = "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1"
                post = (f'POST /ctl HTTP/1.1\r\nSOAPAction: "{service}#{control["action"]}"\r\n'
                        f'Content-Length: {len(body)}\r\n\r\n').encode() + body
                reply = f"HTTP/1.1 200 OK\r\nContent-Length: {len(answer)}\r\n\r\n".encode() + answer
                records += [(sent, ipv6_tcp(source, server, 100, 2)),
                            (sent + 1000, ipv6_tcp(server, source, 200, 18)),
                            (sent + 2000, ipv6_tcp(source, server, 101, 16, post)),
                            (control["receivedAtNs"], ipv6_tcp(server, source, 201, 16, reply))]
        self.gateway_capture = self.root / "v6-gateway.pcap"
        self.gateway_capture.write_bytes(timed_pcap(records))
        (self.root / "v6-gateway.stderr").write_text(f"{len(records)} packets captured\n0 packets dropped by kernel\n")
        return case

    def test_lan_needs_no_unsolicited_daemon_check(self):
        daemon, client = (VERIFY.DAEMON_LAN, 24400), (VERIFY.CLIENT_LAN, 39000)
        self.write_capture([
            ipv4_udp(client, daemon, request(b"c" * 12, "c")),
            ipv4_udp(daemon, client, response(b"c" * 12, client)),
            ipv4_udp(client, daemon, quic()),
            ipv4_udp(daemon, client, quic()),
        ])
        self.assertEqual(self.prove("lan")["outcome"], "direct")

    def test_linux_any_capture_decodes_cooked_v2_headers(self):
        frame = ipv4_udp(CLIENT, DAEMON, request(b"c" * 12, "c"))
        cooked = b"\x08\x00" + bytes(18) + frame[14:]
        self.capture.write_bytes(pcap([cooked], 276))
        capture = VERIFY.read_capture(self.capture)
        self.assertEqual(capture.packets[0].source, CLIENT)
        self.assertEqual(capture.packets[0].destination, DAEMON)

    def test_counterfree_lease_requires_exact_rule_dnat_and_authenticated_check_witness(self):
        local, trips = self._lease_admission()
        proof = VERIFY.lease_from_snapshots(self.root, "client", (DAEMON, CLIENT), local, trips, "eim-pdf")
        self.assertEqual(proof["externalPort"], 52000)
        self.assertTrue(proof["conntrackDnatVerified"])
        self.assertTrue(proof["sameCheckContextAsQuic"])
        path = self.root / "initial-client-nft.json"
        path.write_text(path.read_text().replace('"right": 52000', '"right": 52001'))
        with self.assertRaisesRegex(VERIFY.VerificationError, "DNAT/check admission"):
            VERIFY.lease_from_snapshots(self.root, "client", (DAEMON, CLIENT), local, trips, "eim-pdf")

    def test_a_lease_rule_plus_outbound_snat_does_not_prove_lease_admission(self):
        local, trips = self._lease_admission()
        (self.root / "client-conntrack.txt").write_text(
            "udp 17 179 src=10.20.2.2 dst=198.51.100.1 sport=39000 dport=51000 "
            "src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=52000 [ASSURED]\n")
        with self.assertRaisesRegex(VERIFY.VerificationError, "DNAT/check admission"):
            VERIFY.lease_from_snapshots(self.root, "client", (DAEMON, CLIENT), local, trips, "eim-pdf")

    def test_raw_th_lease_rule_needs_its_explicit_ipv4_udp_protocol_selector(self):
        local, trips = self._lease_admission()
        path = self.root / "initial-client-nft.json"
        ruleset = json.loads(path.read_text())
        ruleset["nftables"][0]["rule"]["expr"].pop(0)
        path.write_text(json.dumps(ruleset))
        with self.assertRaisesRegex(VERIFY.VerificationError, "DNAT/check admission"):
            VERIFY.lease_from_snapshots(self.root, "client", (DAEMON, CLIENT), local, trips, "eim-pdf")

    def test_lease_assisted_check_can_authorize_generic_winner_only_on_same_binding_and_context(self):
        for context in (b"0" * 32, b"1" * 32):
            with self.subTest(same_context=context == b"0" * 32):
                local, _ = self._lease_admission()
                generic = (VERIFY.CLIENT4, 53000)
                self.write_capture(valid_frames() + valid_frames(DAEMON, generic, context))
                packets = list(VERIFY.read_capture(self.capture).packets)
                trips, _ = VERIFY.round_trips(packets, "eim-pdf")
                if context == b"0" * 32:
                    proof = VERIFY.lease_from_snapshots(self.root, "client", (DAEMON, generic), local, trips, "eim-pdf")
                    self.assertEqual(proof["externalPort"], 52000)
                else:
                    with self.assertRaisesRegex(VERIFY.VerificationError, "DNAT/check admission"):
                        VERIFY.lease_from_snapshots(self.root, "client", (DAEMON, generic), local, trips, "eim-pdf")

    def _lease_admission(self):
        self.write_capture(valid_frames())
        local = {"privateAddress": "10.20.2.2", "privatePort": 39000, "publicPort": 52000}
        rule = {"nftables": [{"rule": {"family": "inet", "table": "filter",
            "chain": "prerouting_miniupnpd", "expr": [
                {"match": {"op": "==", "left": {"payload": {"base": "nh", "offset": 72, "len": 8}}, "right": 17}},
                {"match": {"op": "==", "left": {"payload": {"protocol": "th", "field": "dport"}}, "right": 52000}},
                {"dnat": {"family": "ip", "addr": "10.20.2.2", "port": 39000}}]}}]}
        (self.root / "initial-client-nft.json").write_text(json.dumps(rule))
        (self.root / "client-conntrack.txt").write_text(
            "udp 17 179 src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=52000 "
            "src=10.20.2.2 dst=198.51.100.1 sport=39000 dport=51000 [ASSURED]\n")
        packets = list(VERIFY.read_capture(self.capture).packets)
        return local, VERIFY.round_trips(packets, "eim-pdf")[0]

    def test_an_explicit_router_lease_may_preserve_the_internal_port(self):
        path = self.root / "client-conntrack.txt"
        path.write_text(path.read_text().replace("sport=39000", "sport=52000"))
        mapping = VERIFY.mapping_from_snapshots(
            self.root, "client", CLIENT, DAEMON, {"10.20.2.2"}, require_translation=False)
        self.assertEqual(mapping["privatePort"], mapping["publicPort"])
        with self.assertRaisesRegex(VERIFY.VerificationError, "no translated bidirectional mapping"):
            VERIFY.mapping_from_snapshots(self.root, "client", CLIENT, DAEMON, {"10.20.2.2"})

    def test_fast_bidirectional_udp_does_not_wait_for_the_assured_timeout(self):
        self.write_capture(valid_frames())
        for role in ("daemon", "client"):
            path = self.root / f"{role}-conntrack.txt"
            path.write_text(path.read_text().replace("[ASSURED]", ""))
        self.assertEqual(self.prove()["outcome"], "direct")

    def test_unreplied_mapping_cannot_correlate_a_checked_carrier(self):
        self.write_capture(valid_frames())
        path = self.root / "client-conntrack.txt"
        path.write_text(path.read_text().replace("[ASSURED]", "[UNREPLIED]"))
        with self.assertRaisesRegex(VERIFY.VerificationError, "no translated bidirectional mapping"):
            self.prove()

    def test_port_search_cannot_be_reported_as_candidate_pair_checks(self):
        self.write_capture([ipv4_udp(CLIENT, (DAEMON[0], 10000 + index), request(bytes(12), "c"))
                            for index in range(VERIFY.MAX_CHECK_PAIRS + 1)])
        with self.assertRaisesRegex(VERIFY.VerificationError, "candidate-pair"):
            self.prove()

    def test_peer_reflexive_success_uses_a_different_mapping_from_the_same_socket(self):
        for role in ("daemon", "client"):
            with self.subTest(role=role):
                selected = 51130 if role == "daemon" else 52130
                observed = 51110 if role == "daemon" else 52110
                endpoint = (VERIFY.DAEMON4 if role == "daemon" else VERIFY.CLIENT4, selected)
                daemon, client = (endpoint, CLIENT) if role == "daemon" else (DAEMON, endpoint)
                self.write_capture(valid_frames(daemon, client))
                daemon_line = (
                    f"udp 17 179 src=10.20.1.2 dst={client[0]} sport=24400 dport={client[1]} "
                    f"src={client[0]} dst={daemon[0]} sport={client[1]} dport={daemon[1]} [ASSURED]\n")
                client_line = (
                    f"udp 17 179 src=10.20.2.2 dst={daemon[0]} sport=39000 dport={daemon[1]} "
                    f"src={daemon[0]} dst={client[0]} sport={daemon[1]} dport={client[1]} [ASSURED]\n")
                (self.root / "daemon-conntrack.txt").write_text(daemon_line)
                (self.root / "client-conntrack.txt").write_text(client_line)
                path = self.root / f"{role}-conntrack.txt"
                private, local = ("10.20.1.2", 24400) if role == "daemon" else ("10.20.2.2", 39000)
                observer = (
                    f"udp 17 179 src={private} dst=198.51.100.10 sport={local} dport=3478 "
                    f"src=198.51.100.10 dst={endpoint[0]} sport=3478 dport={observed} [ASSURED]\n")
                path.write_text(path.read_text() + observer)
                proof = self.prove(f"edm-{role}-eif")
                self.assertEqual(proof["verifiedPairs"][0]["peerReflexiveMapping"]["peerPort"], selected)
                path.write_text(path.read_text().replace(f"dport={observed}", f"dport={selected}"))
                with self.assertRaisesRegex(VERIFY.VerificationError, "did not differ"):
                    self.prove(f"edm-{role}-eif")

    def test_quic_fixed_bit_greasing_does_not_hide_the_selected_connection(self):
        frames = valid_frames()
        greased = bytes([quic()[0] ^ 0x40]) + quic()[1:]
        frames[4] = ipv4_udp(CLIENT, DAEMON, greased)
        frames[5] = ipv4_udp(DAEMON, CLIENT, greased)
        frames += [ipv4_udp(CLIENT, DAEMON, b"\x00" + b"d" * 8 + bytes(24)),
                   ipv4_udp(DAEMON, CLIENT, b"\x00" + b"s" * 8 + bytes(24))]
        self.write_capture(frames)
        proof = self.prove()
        self.assertEqual(proof["peerQuicPackets"], 4)

    def test_route_replacement_uses_fresh_checks_and_preserves_both_mapping_proofs(self):
        self._route_replacement(b"1" * 32)
        proof = self.prove()
        self.assertTrue(proof["routeChangeVerified"])
        self.assertEqual(len(proof["verifiedPairs"]), 2)
        addresses = {pair["clientMapping"]["privateAddress"] for pair in proof["verifiedPairs"]}
        self.assertEqual(addresses, {"10.20.2.2", "10.20.2.3"})

    def test_route_replacement_cannot_replay_a_predecessor_check_context(self):
        self._route_replacement(b"0" * 32)
        with self.assertRaisesRegex(VERIFY.VerificationError, "predecessor check context"):
            self.prove()

    def test_live_context_observer_ignores_only_the_last_incomplete_record(self):
        frames = valid_frames() + valid_frames(DAEMON, CLIENT, b"1" * 32)
        self.write_capture(frames)
        self.capture.write_bytes(self.capture.read_bytes()[:-5])
        packets = list(VERIFY.read_capture(self.capture, live=True).packets)
        self.assertEqual(len(packets), len(frames) - 1)
        with self.assertRaisesRegex(VERIFY.VerificationError, "truncated PCAP"):
            VERIFY.read_capture(self.capture)

    def test_live_capture_still_rejects_malformed_complete_records(self):
        self.write_capture(valid_frames())
        contents = bytearray(self.capture.read_bytes())
        struct.pack_into("<I", contents, 24 + 8, 262145)
        self.capture.write_bytes(contents)
        with self.assertRaisesRegex(VERIFY.VerificationError, "capture snap length"):
            VERIFY.read_capture(self.capture, live=True)

    def test_port_only_rebind_retains_connection_ids_and_both_private_sockets(self):
        self._port_rebind()
        proof = self.prove()
        self.assertTrue(proof["portRebindVerified"])
        self.assertEqual(len(proof["verifiedPairs"]), 2)
        observed = VERIFY.wait_for_port_rebind("eim-pdf", [self.capture], self.root)
        self.assertTrue(observed["portRebindObserved"])

    def test_port_rebind_cannot_authorize_a_new_unchecked_handshake(self):
        self._port_rebind()
        rebound = (VERIFY.CLIENT4, 20000)
        self.write_capture(valid_frames() + [ipv4_udp(rebound, DAEMON, quic()),
                                             ipv4_udp(DAEMON, rebound, quic())])
        with self.assertRaisesRegex(VERIFY.VerificationError, "previous-CID continuity"):
            self.prove()

    def test_port_rebind_cannot_silently_replace_the_private_socket(self):
        self._port_rebind()
        path = self.root / "client-conntrack.txt"
        path.write_text(path.read_text().replace("sport=39000 dport=51000 src=198.51.100.1 "
                                                "dst=198.51.100.2 sport=51000 dport=20000",
                                                "sport=39001 dport=51000 src=198.51.100.1 "
                                                "dst=198.51.100.2 sport=51000 dport=20000"))
        with self.assertRaisesRegex(VERIFY.VerificationError, "private source socket"):
            self.prove()

    def test_port_rebind_cannot_claim_continuity_from_unseen_connection_ids(self):
        self._port_rebind()
        rebound = (VERIFY.CLIENT4, 20000)
        self.write_capture(valid_frames() + [ipv4_udp(rebound, DAEMON, b"\x00" + b"x" * 8 + bytes(24)),
                                             ipv4_udp(DAEMON, rebound, b"\x00" + b"y" * 8 + bytes(24))])
        with self.assertRaisesRegex(VERIFY.VerificationError, "previous-CID continuity"):
            self.prove()

    def _port_rebind(self):
        rebound = (VERIFY.CLIENT4, 20000)
        self.write_capture(valid_frames() + [ipv4_udp(rebound, DAEMON, b"\x00" + b"d" * 8 + bytes(24)),
                                             ipv4_udp(DAEMON, rebound, b"\x00" + b"s" * 8 + bytes(24))])
        daemon_path = self.root / "daemon-conntrack.txt"
        daemon_path.write_text(daemon_path.read_text() +
            "udp 17 179 src=10.20.1.2 dst=198.51.100.2 sport=24400 dport=20000 "
            "src=198.51.100.2 dst=198.51.100.1 sport=20000 dport=51000 [ASSURED]\n")
        client_path = self.root / "client-conntrack.txt"
        client_path.write_text(client_path.read_text() +
            "udp 17 179 src=10.20.2.2 dst=198.51.100.1 sport=39000 dport=51000 "
            "src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=20000 [ASSURED]\n")
        self._write_lifecycle({
            "portRebindStartedAtNs": 100_005_500_000, "portReboundAtNs": 100_005_900_000,
            "portRebind": {"privateIP": "10.20.2.2", "localPort": 39000,
                           "previousExternalPort": 52000, "currentExternalPort": 20000,
                           "peerIP": VERIFY.DAEMON4, "peerPort": 51000},
        })

    def test_same_ip_route_requires_new_context_and_unchanged_endpoint_addresses(self):
        self._same_ip_route()
        self.assertTrue(self.prove()["sameIPRouteVerified"])
        path = self.root / "topology" / "after-same-ip-route-address.json"
        path.write_text(path.read_text().replace("10.20.2.2", "10.20.2.3"))
        with self.assertRaisesRegex(VERIFY.VerificationError, "changed the endpoint addresses"):
            self.prove()

    def test_same_ip_route_preserves_a_healthy_direct_without_cold_discovery(self):
        self._same_ip_route(context=b"0" * 32)
        self.assertTrue(self.prove()["sameIPRouteVerified"])

    def test_port_rebind_allows_quinn_to_rotate_the_servers_encrypted_remote_cid(self):
        self._port_rebind()
        rebound = (VERIFY.CLIENT4, 20000)
        self.write_capture(valid_frames() + [ipv4_udp(rebound, DAEMON, b"\x00" + b"d" * 8 + bytes(24)),
                                             ipv4_udp(DAEMON, rebound, b"\x00" + b"n" * 8 + bytes(24))])
        self.assertTrue(self.prove()["portRebindVerified"])

    def test_port_rebind_can_migrate_then_check_and_recover_on_the_same_public_tuple(self):
        self._port_rebind()
        rebound = (VERIFY.CLIENT4, 20000)
        self.write_capture(valid_frames() + [ipv4_udp(rebound, DAEMON, b"\x00" + b"d" * 8 + bytes(24)),
                                             ipv4_udp(DAEMON, rebound, b"\x00" + b"n" * 8 + bytes(24))]
                           + valid_frames(DAEMON, rebound, b"1" * 32))
        self.assertTrue(self.prove()["portRebindVerified"])

    def test_committed_rebind_proves_fresh_context_roundtrip_before_successor_quic(self):
        self._committed_rebind()
        self.assertTrue(self.prove()["committedRebindVerified"])
        self.assertTrue(VERIFY.wait_for_rebind_context("eim-pdf", [self.capture], self.root)[
            "rebindFreshContextObserved"])

    def test_committed_rebind_rejects_a_predecessor_context_even_when_checks_answer(self):
        self._committed_rebind(context=b"0" * 32)
        with self.assertRaisesRegex(VERIFY.VerificationError, "fresh successor client-check"):
            self.prove()

    def test_committed_rebind_rejects_a_late_precommit_context(self):
        self._committed_rebind()
        path = self.root / "topology" / "lifecycle.json"
        lifecycle = json.loads(path.read_text())
        lifecycle["rebindCommittedAtNs"] = 100_007_500_000
        path.write_text(json.dumps(lifecycle))
        with self.assertRaisesRegex(VERIFY.VerificationError, "fresh successor client-check"):
            self.prove()

    def _committed_rebind(self, context=b"1" * 32):
        self.write_capture(valid_frames() + valid_frames(context=context))
        self._write_lifecycle({"carriersPartitionedAtNs": 100_005_500_000,
                               "rebindCommittedAtNs": 100_005_900_000})

    def _same_ip_route(self, context=b"1" * 32):
        self.write_capture(valid_frames() + valid_frames(context=context))
        self._write_lifecycle({
            "sameIPRouteStartedAtNs": 100_005_500_000, "sameIPRouteChangedAtNs": 100_005_900_000,
            "sameIPRoute": {"privateIP": "10.20.2.2", "previousGateway": "10.20.2.1",
                            "currentGateway": "10.20.2.254"},
        })
        address = [{"ifname": "eth0", "addr_info": [{"family": "inet", "local": "10.20.2.2",
                    "prefixlen": 24, "scope": "global"}]}]
        for name in ("before-same-ip-route-address.json", "after-same-ip-route-address.json"):
            (self.root / "topology" / name).write_text(json.dumps(address))
        (self.root / "topology" / "after-same-ip-route.json").write_text(json.dumps([
            {"dst": "default", "gateway": "10.20.2.254", "dev": "eth0"}]))

    def test_impairment_requires_used_kernel_rules_and_duplicate_wire_packets(self):
        lifecycle = self._impairment()
        packets = list(VERIFY.read_capture(self.capture).packets)
        VERIFY.verify_impairment(lifecycle, packets, self.root)
        self.write_capture(valid_frames())
        with self.assertRaisesRegex(VERIFY.VerificationError, "no duplicated peer datagram"):
            VERIFY.verify_impairment(lifecycle, list(VERIFY.read_capture(self.capture).packets), self.root)

    def test_impairment_cannot_claim_loss_without_a_filter_hit(self):
        lifecycle = self._impairment()
        path = self.root / "topology" / "impairment-nft.json"
        path.write_text(path.read_text().replace('"packets": 1', '"packets": 0'))
        with self.assertRaisesRegex(VERIFY.VerificationError, "loss filtered no packet"):
            VERIFY.verify_impairment(lifecycle, list(VERIFY.read_capture(self.capture).packets), self.root)

    def _impairment(self):
        frames = valid_frames()
        self.write_capture([frame for frame in frames for _ in range(2)])
        lifecycle = self._write_lifecycle({
            "impairedAtNs": 100_000_000_000, "impairmentClearedAtNs": 100_020_000_000,
            "impairment": {"delayMs": 40, "duplicatePercent": 100, "lossEvery": 7},
        })
        qdisc = {"kind": "netem", "handle": "30:", "parent": "1:3", "packets": 12,
                 "options": {"delay": {"delay": 0.04}, "duplicate": {"duplicate": 1}}}
        losses = {"nftables": [{"counter": {"name": "peer_loss", "packets": 1}}]}
        (self.root / "topology" / "impairment-qdisc.json").write_text(json.dumps({
            role: {"qdisc": [qdisc]} for role in ("daemon", "client")}))
        (self.root / "topology" / "impairment-nft.json").write_text(json.dumps({
            role: losses for role in ("daemon", "client")}))
        return lifecycle

    def _write_lifecycle(self, value):
        (self.root / "topology").mkdir(exist_ok=True)
        value = {"nativeSessionsStartedAtNs": 100_000_000_000, **value}
        (self.root / "topology" / "lifecycle.json").write_text(json.dumps(value))
        return value

    def test_browser_constructor_before_native_phase_does_not_need_native_check_authority(self):
        self.write_capture([ipv4_udp((CLIENT[0], 58000), DAEMON, quic())] + valid_frames())
        self._write_lifecycle({"nativeSessionsStartedAtNs": 100_000_500_000})
        proof = self.prove()
        self.assertEqual(proof["peerQuicPackets"], 2)
        self.assertEqual(len(proof["verifiedPairs"]), 1)

    def test_a_constructor_after_native_phase_still_requires_native_check_authority(self):
        self.write_capture(valid_frames() + [ipv4_udp((CLIENT[0], 58000), DAEMON, quic())])
        self._write_lifecycle({})
        with self.assertRaisesRegex(VERIFY.VerificationError, "matching two-sided check"):
            self.prove()

    def test_native_fault_proof_cannot_omit_the_browser_native_phase_boundary(self):
        self._port_rebind()
        path = self.root / "topology" / "lifecycle.json"
        value = json.loads(path.read_text())
        del value["nativeSessionsStartedAtNs"]
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(VERIFY.VerificationError, "phase boundary"):
            self.prove()

    def test_gateway_reboot_proves_epoch_loss_and_quic_on_the_reacquired_lease(self):
        lifecycle, quic_packets, packets, trips = self._gateway_reboot()
        VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root, trips, packets)

    def test_gateway_reboot_cannot_count_a_lease_hit_without_post_reacquire_quic(self):
        lifecycle, quic_packets, packets, trips = self._gateway_reboot()
        with self.assertRaisesRegex(VERIFY.VerificationError, "bidirectional QUIC"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets[:2], "client-lease-pcp", self.root, trips, packets)

    def test_gateway_reboot_cannot_use_predecessor_mapping_rules(self):
        lifecycle, quic_packets, packets, trips = self._gateway_reboot()
        path = self.root / "topology" / "reacquired-client-nft.json"
        path.write_text(path.read_text().replace('"port": 39000', '"port": 39001'))
        with self.assertRaisesRegex(VERIFY.VerificationError, "reacquired kernel router leases"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root, trips, packets)

    def test_gateway_reboot_rejects_a_claimed_announcement_epoch_that_is_not_on_wire(self):
        lifecycle, quic_packets, packets, trips = self._gateway_reboot()
        path = self.root / "topology" / "gateway-announcement.json"
        value = json.loads(path.read_text())
        value["epoch"] = 1
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(VERIFY.VerificationError, "epoch-loss announcement"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root, trips, packets)

    def test_gateway_reboot_requires_a_fresh_actual_pcp_nonce(self):
        lifecycle, quic_packets, packets, trips = self._gateway_reboot(new_nonce=b"o" * 12)
        with self.assertRaisesRegex(VERIFY.VerificationError, "fresh same-binding PCP nonce"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root, trips, packets)

    def test_rebooted_gateway_epoch_may_advance_past_the_previous_process_before_grant(self):
        lifecycle, quic_packets, packets, trips = self._gateway_reboot()
        lifecycle["leaseReacquiredAtNs"] += 12_000_000_000
        path = self.root / "topology" / "reacquired-client-lease.json"
        record = json.loads(path.read_text())
        record["observedAtNs"] += 12_000_000_000
        path.write_text(json.dumps(record))
        delayed = []
        for packet in packets:
            if packet.payload[:2] in {b"\x02\x01", b"\x02\x81"} and packet.timestamp_ns > 100_005_500_000:
                wire = bytearray(packet.payload)
                if wire[1] == 0x81:
                    struct.pack_into("!I", wire, 8, 12)
                delayed.append(VERIFY.Packet(packet.timestamp_ns + 12_000_000_000,
                    packet.source, packet.destination, bytes(wire)))
            else:
                delayed.append(packet)
        quic_packets = [VERIFY.Packet(packet.timestamp_ns + 12_000_000_000, packet.source,
                        packet.destination, packet.payload) if packet.timestamp_ns > 100_005_500_000 else packet
                        for packet in quic_packets]
        VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root, trips, delayed)

    def test_gateway_reboot_cannot_reacquire_a_different_private_socket(self):
        lifecycle, quic_packets, packets, trips = self._gateway_reboot()
        path = self.root / "topology" / "reacquired-client-lease.json"
        facts = json.loads(path.read_text())
        facts["current"]["localPort"] += 1
        path.write_text(json.dumps(facts))
        with self.assertRaisesRegex(VERIFY.VerificationError, "different native UDP binding"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root, trips, packets)

    def test_gateway_reboot_allows_verified_generic_provider_after_fresh_unused_lease(self):
        lifecycle, _, packets, _ = self._gateway_reboot()
        generic = (VERIFY.CLIENT4, 53000)
        self.write_capture(valid_frames() + valid_frames(DAEMON, generic))
        peers = list(VERIFY.read_capture(self.capture).packets)
        quic_packets = VERIFY.quic_packets(peers, "client-lease-pcp")
        trips = VERIFY.round_trips(peers, "client-lease-pcp")[0]
        path = self.root / "client-conntrack.txt"
        path.write_text(path.read_text() +
            "udp 17 179 src=10.20.2.2 dst=198.51.100.1 sport=39000 dport=51000 "
            "src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=53000 [ASSURED]\n")
        VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root, trips, packets)

    def test_whole_verifier_inherits_checked_lease_authority_for_controlled_gateway_migration(self):
        self._gateway_continuity()
        proof = self.prove("client-lease-pcp")
        self.assertTrue(proof["gatewayRebootVerified"])
        migrated = next(pair for pair in proof["verifiedPairs"] if pair["clientEndpoint"][1] == 53000)
        self.assertEqual(migrated["checkAuthorityInheritedFrom"]["clientEndpoint"], list(CLIENT))
        self.assertTrue(migrated["leaseAdmission"]["retainedConnectionVerified"])
        self.assertNotIn("sameCheckContextAsQuic", migrated["leaseAdmission"])

    def test_gateway_migration_cannot_change_either_private_udp_socket(self):
        for role, previous, current in (("client", "sport=39000", "sport=39001"),
                                         ("daemon", "sport=24400", "sport=24401")):
            with self.subTest(role=role):
                self._gateway_continuity()
                path = self.root / f"{role}-conntrack.txt"
                lines = [line.replace(previous, current) if "53000" in line else line
                         for line in path.read_text().splitlines()]
                path.write_text("\n".join(lines) + "\n")
                with self.assertRaisesRegex(VERIFY.VerificationError, "matching two-sided check authority"):
                    self.prove("client-lease-pcp")

    def test_gateway_migration_requires_the_original_client_to_daemon_connection_id(self):
        self._gateway_continuity(client_cid=b"x" * 8)
        with self.assertRaisesRegex(VERIFY.VerificationError, "bidirectional QUIC recovery"):
            self.prove("client-lease-pcp")

    def test_gateway_migration_is_not_a_verified_winner_without_reverse_quic_continuity(self):
        self._gateway_continuity()
        records = self.gateway_records[:-1]
        self.capture.write_bytes(timed_pcap(sorted(records)))
        (self.root / "capture.stderr").write_text(f"{len(records)} packets captured\n0 packets dropped by kernel\n")
        with self.assertRaisesRegex(VERIFY.VerificationError, "bidirectional QUIC recovery"):
            self.prove("client-lease-pcp")

    def test_gateway_continuity_never_authorizes_an_unchecked_new_long_header(self):
        for source, destination in (((VERIFY.CLIENT4, 53000), DAEMON),
                                     (DAEMON, (VERIFY.CLIENT4, 53000))):
            with self.subTest(client_dial=source[0] == VERIFY.CLIENT4):
                self._gateway_continuity()
                records = self.gateway_records + [(100_012_000_000, ipv4_udp(source, destination, quic()))]
                self.capture.write_bytes(timed_pcap(sorted(records)))
                (self.root / "capture.stderr").write_text(
                    f"{len(records)} packets captured\n0 packets dropped by kernel\n")
                with self.assertRaisesRegex(VERIFY.VerificationError, "recovery QUIC"):
                    self.prove("client-lease-pcp")

    def _gateway_continuity(self, client_cid=b"d" * 8):
        _, _, packets, _ = self._gateway_reboot()
        generic = (VERIFY.CLIENT4, 53000)
        records = [(packet.timestamp_ns, ipv4_udp(packet.source, packet.destination, packet.payload))
                   for packet in packets if packet.payload[:2] in {b"\x02\x01", b"\x02\x81"}]
        records += [(100_000_000_000 + index * 1_000_000, frame) for index, frame in enumerate(valid_frames())]
        records += [(100_010_000_000, ipv4_udp(generic, DAEMON, b"\x00" + client_cid + bytes(24))),
                    (100_011_000_000, ipv4_udp(DAEMON, generic, b"\x00" + b"z" * 8 + bytes(24)))]
        self.gateway_records = records
        self.capture.write_bytes(timed_pcap(sorted(records)))
        (self.root / "capture.stderr").write_text(f"{len(records)} packets captured\n0 packets dropped by kernel\n")
        path = self.root / "client-conntrack.txt"
        path.write_text(path.read_text() +
            "udp 17 179 src=10.20.2.2 dst=198.51.100.1 sport=39000 dport=51000 "
            "src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=53000 [ASSURED]\n")
        path = self.root / "daemon-conntrack.txt"
        path.write_text(path.read_text() +
            "udp 17 179 src=10.20.1.2 dst=198.51.100.2 sport=24400 dport=53000 "
            "src=198.51.100.2 dst=198.51.100.1 sport=53000 dport=51000 [ASSURED]\n" +
            "udp 17 179 src=10.20.1.2 dst=198.51.100.10 sport=24400 dport=3478 "
            "src=198.51.100.10 dst=198.51.100.1 sport=3478 dport=51110 [ASSURED]\n")

    def _gateway_reboot(self, new_nonce=b"n" * 12):
        chain = {"family": "inet", "table": "filter", "name": "prerouting_miniupnpd"}
        lifecycle = self._write_lifecycle({
            "gatewayRebootStartedAtNs": 100_005_500_000, "gatewayRebootedAtNs": 100_005_900_000,
            "leaseReacquiredAtNs": 100_006_500_000,
            "gatewayReboot": {"role": "client", "protocol": "pcp", "previousEpoch": 9,
                              "currentEpoch": 0, "previousPid": 123, "currentPid": 124,
                              "flushedChains": [chain]},
        })
        topology = self.root / "topology"
        notice = {"protocol": "natpmp", "epoch": 0, "sender": ["10.20.2.1", 5351],
                  "receivedAtNs": 100_005_700_000, "packet": (b"\0\x80\0\0" + bytes(8)).hex()}
        (topology / "gateway-announcement.json").write_text(json.dumps(notice))
        (topology / "flushed-gateway-reboot-client-nft.json").write_text(json.dumps({
            "nftables": [{"chain": chain}]}))
        previous_rule = {"family": "inet", "table": "filter", "chain": "prerouting_miniupnpd", "handle": 14,
            "expr": [{"match": {"op": "==", "left": {"payload": {
                "protocol": "udp", "field": "dport"}}, "right": 52000}},
                {"dnat": {"addr": "10.20.2.2", "port": 39000}}]}
        current_rule = {**previous_rule, "handle": 15}
        (topology / "before-gateway-reboot-client-nft.json").write_text(json.dumps({
            "nftables": [{"rule": previous_rule}]}))
        (topology / "reacquired-client-nft.json").write_text(json.dumps({
            "nftables": [{"rule": current_rule}]}))
        (topology / "reacquired-client-lease.json").write_text(json.dumps({
            "role": "client", "protocol": "pcp", "publicIP": VERIFY.CLIENT4, "observedAtNs": 100_006_400_000,
            "previousEpoch": 9, "currentEpoch": 0, "previousPid": 123, "currentPid": 124,
            "previous": {"privateIP": "10.20.2.2", "localPort": 39000, "externalPort": 52000,
                         "rule": previous_rule},
            "current": {"privateIP": "10.20.2.2", "localPort": 39000, "externalPort": 52000,
                        "rule": current_rule}}))
        conntrack = ("udp 17 179 src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=52000 "
                     "src=10.20.2.2 dst=198.51.100.1 sport=39000 dport=51000 [ASSURED]\n")
        (self.root / "client-conntrack.txt").write_text(conntrack)
        (topology / "before-gateway-reboot-client-conntrack.txt").write_text(conntrack)
        records = [(100_000_000_000 + index * 1_000_000, frame)
                   for index, frame in enumerate(valid_frames() + valid_frames(context=b"1" * 32))]
        for sent, nonce in ((99_990_000_000, b"o" * 12), (100_006_100_000, new_nonce)):
            request_bytes, response_bytes = pcp4_map(39000, 3600, 240, assigned=VERIFY.CLIENT4, nonce=nonce)
            response_bytes = bytearray(response_bytes)
            struct.pack_into("!H", response_bytes, 42, 52000)
            source, gateway = ("10.20.2.2", 44000), ("10.20.2.1", 5351)
            records += [(sent, ipv4_udp(source, gateway, request_bytes)),
                        (sent + 100_000, ipv4_udp(gateway, source, bytes(response_bytes)))]
        self.capture.write_bytes(timed_pcap(sorted(records)))
        (self.root / "capture.stderr").write_text(f"{len(records)} packets captured\n0 packets dropped by kernel\n")
        packets = list(VERIFY.read_capture(self.capture).packets)
        return lifecycle, VERIFY.quic_packets(packets, "client-lease-pcp"), packets, VERIFY.round_trips(packets, "client-lease-pcp")[0]

    def _route_replacement(self, context):
        client = (VERIFY.CLIENT4, 14200)
        self.write_capture(valid_frames() + valid_frames(DAEMON, client, context))
        for role in ("daemon", "client"):
            (self.root / f"initial-{role}-conntrack.txt").write_text(
                (self.root / f"{role}-conntrack.txt").read_text())
        (self.root / "daemon-conntrack.txt").write_text(
            "udp 17 179 src=10.20.1.2 dst=198.51.100.2 sport=24400 dport=14200 "
            "src=198.51.100.2 dst=198.51.100.1 sport=14200 dport=51000 [ASSURED]\n")
        (self.root / "client-conntrack.txt").write_text(
            "udp 17 179 src=10.20.2.3 dst=198.51.100.1 sport=30400 dport=51000 "
            "src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=14200 [ASSURED]\n")
        (self.root / "topology").mkdir()
        (self.root / "topology" / "lifecycle.json").write_text(json.dumps({
            "routeChangeStartedAtNs": 100_005_500_000,
            "routeChangedAtNs": 100_008_500_000,
            "previousPrivateIP": "10.20.2.2", "currentPrivateIP": "10.20.2.3",
        }))


if __name__ == "__main__":
    unittest.main()
