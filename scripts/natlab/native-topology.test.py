#!/usr/bin/env python3
"""Pure checks for the controlled CPE's translation and kernel-state reader."""

import importlib.util
from pathlib import Path
import unittest


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


table = module("native-nat-table")
watch = module("native-map-watch")
fault = module("native-fault")


class NativeTopologyTests(unittest.TestCase):
    def test_each_controlled_socket_has_one_changed_noncolliding_mapping(self):
        for base in (51000, 52000):
            for offset in (0, 110, 120, 130):
                ports = table.port_map(base, offset, base == 51000)
                self.assertEqual(len(ports), len(set(ports.values())))
                self.assertTrue(all(local != external and 0 < external <= 65535 for local, external in ports.items()))

    def test_edm_observers_and_peer_have_distinct_mappings_for_every_socket(self):
        for base in (51000, 52000):
            profiles = [table.port_map(base, offset, base == 51000) for offset in (110, 120, 130)]
            self.assertTrue(all(len({profile[local] for profile in profiles}) == 3 for local in profiles[0]))
        self.assertEqual(
            [table.port_map(51000, offset, True)[24400] for offset in (110, 120, 130)],
            [51110, 51120, 51130],
        )

    def test_route_successor_uses_a_disjoint_mapping_space(self):
        for base in (51000, 52000):
            ports = table.port_map(base, 0, base == 51000)
            old = {ports[local] for local in range(40000, 50000)}
            new = {ports[local] for local in range(30000, 35000)}
            self.assertTrue(old.isdisjoint(new))

    def test_reverse_mapping_uses_the_original_stun_and_reply_destination_tuple(self):
        row = (
            "udp 17 179 src=10.20.2.2 dst=198.51.100.10 sport=42000 dport=3478 "
            "src=198.51.100.10 dst=198.51.100.2 sport=3478 dport=54000 [ASSURED] mark=0 use=1"
        )
        self.assertEqual(watch.mappings(row, "10.20.2.2", "198.51.100.10"), {(42000, "198.51.100.2", 54000)})
        self.assertFalse(watch.mappings(row, "10.20.1.2", "198.51.100.10"))
        self.assertFalse(watch.mappings(row.replace("sport=42000", "sport=invalid"), "10.20.2.2", "198.51.100.10"))

    def test_port_rebind_uses_exact_socket_after_address_move_and_avoids_owned_ports(self):
        row = (
            "udp 17 179 src=10.20.2.3 dst=198.51.100.1 sport=31000 dport=51000 "
            "src=198.51.100.1 dst=198.51.100.2 sport=51000 dport=11000 [ASSURED]\n"
            "udp 17 179 src=10.20.2.3 dst=198.51.100.10 sport=31001 dport=3478 "
            "src=198.51.100.10 dst=198.51.100.2 sport=3478 dport=20000 [ASSURED]"
        )
        self.assertEqual(fault.select_rebind(row, "10.20.2.3"), dict(
            privateIP="10.20.2.3", localPort=31000, previousExternalPort=11000,
            currentExternalPort=20001, peerIP="198.51.100.1", peerPort=51000))
        with self.assertRaises(ValueError):
            fault.select_rebind(row, "10.20.2.2")
        with self.assertRaises(ValueError):
            fault.select_rebind(row + "\n" + row.replace("sport=31000", "sport=31002"), "10.20.2.3")

    def test_gateway_epoch_requires_successful_exact_protocol_reply(self):
        self.assertEqual(fault.epoch_packet(bytes.fromhex('0080000000000007c6336402'), 'natpmp'), 7)
        self.assertEqual(fault.epoch_packet(bytes.fromhex('028000000000000000000003') + bytes(12), 'pcp'), 3)
        self.assertIsNone(fault.epoch_packet(bytes.fromhex('0080000100000007c6336402'), 'natpmp'))
        self.assertIsNone(fault.epoch_packet(bytes(24), 'pcp'))

    def test_reboot_flushes_only_actual_gateway_chains_and_requires_used_dnat(self):
        fixture = {"nftables": [
            {"chain": {"family": "ip", "table": "nat", "name": "prerouting_miniupnpd"}},
            {"chain": {"family": "ip", "table": "natlab", "name": "prerouting"}},
            {"rule": {"chain": "prerouting_miniupnpd", "expr": [
                {"counter": {"packets": 0, "bytes": 0}}, {"dnat": {"addr": "10.20.2.2", "port": 41000}}]}},
        ]}
        self.assertEqual(fault.dynamic_chains(fixture), [dict(
            family="ip", table="nat", name="prerouting_miniupnpd")])
        self.assertFalse(fault.used_dnat(fixture))
        fixture['nftables'][2]['rule']['expr'][0]['counter']['packets'] = 1
        self.assertEqual(len(fault.used_dnat(fixture)), 1)
        fixture['nftables'].append({"chain": {"family": "inet", "table": "filter", "name": "miniupnpd"}})
        self.assertEqual(len(fault.dynamic_chains(fixture)), 2)


if __name__ == "__main__":
    unittest.main()
