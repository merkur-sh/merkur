"""Control and kernel evidence contracts for the real IPv6 gateway proof."""

import importlib.util
import ipaddress
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "native_v6_gateway", Path(__file__).with_name("native-v6-gateway.py"))
GATEWAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATEWAY)
LOCAL = "2001:db8:2::2"
NONCE = bytes(range(12))


def response(lifetime=120, port=GATEWAY.PORT, address=LOCAL, nonce=NONCE):
    return (struct.pack("!BBHII12x", 2, 129, 0, lifetime, 3) + nonce
            + struct.pack("!B3xHH", 17, GATEWAY.PORT, port)
            + ipaddress.IPv6Address(address).packed)


def match(left, right):
    return {"match": {"op": "==", "left": {"payload": left}, "right": right}}


def rule(port=GATEWAY.PORT, address=LOCAL, raw=False, protocol=17):
    fields = ([match({"base": "th", "offset": 16, "len": 16}, hex(port)),
               match({"base": "nh", "offset": 192, "len": 128},
                     hex(int(ipaddress.IPv6Address(address)))),
               match({"base": "nh", "offset": 48, "len": 8}, protocol)]
              if raw else
              [match({"protocol": "udp", "field": "dport"}, port),
               match({"protocol": "ip6", "field": "daddr"}, address)])
    return {"family": "inet", "table": "filter", "chain": "miniupnpd", "handle": 7,
            "expr": fields + [{"accept": None}]}


class GatewayEvidence(unittest.TestCase):
    def test_pcp_request_names_exact_source_port_nonce_and_lifetime(self):
        request = GATEWAY.pcp_request(LOCAL, NONCE, 120)
        self.assertEqual(len(request), 60)
        self.assertEqual(request[:8], bytes([2, 1, 0, 0, 0, 0, 0, 120]))
        self.assertEqual(request[8:24], ipaddress.IPv6Address(LOCAL).packed)
        self.assertEqual(request[24:36], NONCE)
        self.assertEqual(request[40:44], struct.pack("!HH", GATEWAY.PORT, GATEWAY.PORT))
        self.assertEqual(request[44:60], ipaddress.IPv6Address(LOCAL).packed)

    def test_pcp_response_requires_the_owned_nonce_and_unchanged_ipv6_tuple(self):
        self.assertEqual(GATEWAY.pcp_response(response(), NONCE, LOCAL)["lifetime"], 120)
        for packet in (response(nonce=bytes(12)), response(port=GATEWAY.PORT + 1),
                       response(address="2001:db8:2::3"), response() + bytes(4)):
            with self.subTest(packet=packet), self.assertRaises(AssertionError):
                GATEWAY.pcp_response(packet, NONCE, LOCAL)
        self.assertEqual(GATEWAY.pcp_response(response(0), NONCE, LOCAL)["lifetime"], 0)

    def test_kernel_rule_requires_exact_tuple_and_real_accept(self):
        for raw in (False, True):
            expected = rule(raw=raw)
            other = rule(address="2001:db8:1::2", raw=raw)
            state = {"nftables": [{"rule": expected}, {"rule": other}]}
            self.assertEqual(GATEWAY.pinholes(state, LOCAL), [expected])
        rejected = rule(raw=True, protocol=6)
        self.assertEqual(GATEWAY.pinholes({"nftables": [{"rule": rejected}]}, LOCAL), [])
        rejected = rule()
        rejected["expr"].pop()
        with self.assertRaises(AssertionError):
            GATEWAY.pinholes({"nftables": [{"rule": rejected}]}, LOCAL)

    def test_raw_bit_fields_require_ipv6_destination_and_separate_udp_constraint(self):
        expected = rule(raw=True)
        expected["expr"][1]["match"]["right"] = int(ipaddress.IPv6Address(LOCAL))
        state = {"nftables": [{"rule": expected}]}
        self.assertEqual(GATEWAY.pinholes(state, LOCAL), [expected])
        expected["expr"].pop(2)
        self.assertEqual(GATEWAY.pinholes(state, LOCAL), [])
        expected["expr"].insert(2, {"match": {"op": "==", "left": {
            "meta": {"key": "l4proto"}}, "right": "udp"}})
        self.assertEqual(GATEWAY.pinholes(state, LOCAL), [expected])
        expected["expr"][1]["match"]["left"]["payload"]["offset"] = 64
        self.assertEqual(GATEWAY.pinholes(state, LOCAL), [])

    def test_failed_preflight_preserves_grant_and_kernel_state_before_cleanup(self):
        state = {"nftables": [{"counter": {"name": name, "packets": 0}}
                              for name in ("pinhole_attempt", "pinhole_denied")]}
        failure_state = {"nftables": state["nftables"] + [{"rule": rule(raw=True)}]}
        owner = Mock()
        grant = {"requestedLifetime": 120, "lifetime": 120}
        owner.command.side_effect = [grant, RuntimeError("cleanup failed")]
        failure = AssertionError("gateway kernel state did not reach its expected state")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "gateway-preflight.json"
            with patch.object(GATEWAY, "Endpoint", return_value=owner), \
                    patch.object(GATEWAY.socket, "socket"), \
                    patch.object(GATEWAY, "kernel", side_effect=[state, failure_state]), \
                    patch.object(GATEWAY, "await_kernel", side_effect=[state, failure]):
                with self.assertRaises(AssertionError) as caught:
                    GATEWAY.prove("client", "pcp", output)
            self.assertIs(caught.exception, failure)
            evidence = json.loads(output.read_text())
            self.assertEqual(evidence["acquire"], grant)
            self.assertEqual(evidence["failureState"], failure_state)
            self.assertEqual(evidence["failure"]["message"], str(failure))
            self.assertEqual(evidence["cleanupFailure"], "cleanup failed")
            owner.close.assert_called_once_with()

    def test_native_rule_monitor_excludes_the_independent_preflight_port(self):
        probe, native = rule(), rule(port=24400)
        state = {"nftables": [{"rule": probe}, {"rule": native}]}
        self.assertEqual(GATEWAY.pinholes(state, LOCAL), [probe])
        self.assertEqual(GATEWAY.pinholes(state, LOCAL, False), [native])

    def test_counters_require_both_actual_kernel_counter_objects(self):
        entries = [{"counter": {"name": name, "packets": count}}
                   for name, count in (("pinhole_attempt", 3), ("pinhole_denied", 2))]
        self.assertEqual(GATEWAY.counters({"nftables": entries}),
                         {"pinhole_attempt": 3, "pinhole_denied": 2})
        with self.assertRaises(KeyError):
            GATEWAY.counters({"nftables": entries[:1]})


if __name__ == "__main__":
    unittest.main()
