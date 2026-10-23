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
        return VERIFY.verify(case, [self.capture], self.root)

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

    def test_used_router_lease_must_name_winning_external_and_local_ports(self):
        local = {"privateAddress": "10.20.2.2", "privatePort": 39000, "publicPort": 52000}
        rule = {"nftables": [{"rule": {
            "chain": "prerouting_miniupnpd", "expr": [
                {"match": {"op": "==", "left": {"payload": {
                    "protocol": "udp", "field": "dport"}}, "right": 52000}},
                {"counter": {"packets": 2, "bytes": 100}},
                {"dnat": {"addr": "10.20.2.2", "port": 39000}},
            ],
        }}]}
        path = self.root / "initial-client-nft.json"
        path.write_text(json.dumps(rule))
        self.assertEqual(VERIFY.lease_from_snapshots(self.root, "client", 52000, local), 2)
        with self.assertRaisesRegex(VERIFY.VerificationError, "no used miniupnpd"):
            VERIFY.lease_from_snapshots(self.root, "client", 52001, local)
        rule["nftables"][0]["rule"]["expr"][1]["counter"]["packets"] = 0
        path.write_text(json.dumps(rule))
        with self.assertRaisesRegex(VERIFY.VerificationError, "no used miniupnpd"):
            VERIFY.lease_from_snapshots(self.root, "client", 52000, local)

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
        lifecycle, quic_packets = self._gateway_reboot()
        VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root)

    def test_gateway_reboot_cannot_count_a_lease_hit_without_post_reacquire_quic(self):
        lifecycle, quic_packets = self._gateway_reboot()
        with self.assertRaisesRegex(VERIFY.VerificationError, "bidirectional QUIC"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets[:2], "client-lease-pcp", self.root)

    def test_gateway_reboot_cannot_use_predecessor_mapping_rules(self):
        lifecycle, quic_packets = self._gateway_reboot()
        path = self.root / "topology" / "reacquired-client-nft.json"
        path.write_text(path.read_text().replace('"packets": 2', '"packets": 0'))
        with self.assertRaisesRegex(VERIFY.VerificationError, "reacquired exact router lease"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root)

    def test_gateway_reboot_rejects_a_claimed_announcement_epoch_that_is_not_on_wire(self):
        lifecycle, quic_packets = self._gateway_reboot()
        path = self.root / "topology" / "gateway-announcement.json"
        value = json.loads(path.read_text())
        value["epoch"] = 1
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(VERIFY.VerificationError, "epoch-loss announcement"):
            VERIFY.verify_gateway_reboot(lifecycle, quic_packets, "client-lease-pcp", self.root)

    def _gateway_reboot(self):
        self.write_capture(valid_frames() + valid_frames(context=b"1" * 32))
        chain = {"family": "ip", "table": "nat", "name": "prerouting_miniupnpd"}
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
        (topology / "reacquired-client-nft.json").write_text(json.dumps({"nftables": [{"rule": {
            "chain": "prerouting_miniupnpd", "expr": [
                {"match": {"op": "==", "left": {"payload": {
                    "protocol": "udp", "field": "dport"}}, "right": 52000}},
                {"counter": {"packets": 2}}, {"dnat": {"addr": "10.20.2.2", "port": 39000}},
            ],
        }}]}))
        packets = list(VERIFY.read_capture(self.capture).packets)
        return lifecycle, VERIFY.quic_packets(packets, "client-lease-pcp")

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
