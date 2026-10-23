"""Control and kernel evidence contracts for the real IPv6 gateway proof."""

import importlib.util
import ipaddress
from pathlib import Path
import struct
import unittest


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
    fields = ([match({"base": "transport header", "offset": 2, "len": 2}, hex(port)),
               match({"base": "network header", "offset": 24, "len": 16},
                     hex(int(ipaddress.IPv6Address(address)))),
               match({"base": "network header", "offset": 6, "len": 1}, protocol)]
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
