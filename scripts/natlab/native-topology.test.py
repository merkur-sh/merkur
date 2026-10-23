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
            profiles = list(table.profile_maps(base, True).values())
            self.assertTrue(all(len({profile[local] for profile in profiles}) == 4 for local in profiles[0]))
        self.assertEqual(
            [profile[24400] for profile in table.profile_maps(51000, True).values()],
            [51000, 51110, 51120, 51130],
        )

    def test_all_edm_profiles_have_one_global_inverse_for_concurrent_bindings(self):
        for base in (51000, 52000):
            profiles = table.profile_maps(base, True)
            inverse = {}
            for ports in profiles.values():
                for local, external in ports.items():
                    self.assertNotIn(external, inverse)
                    self.assertNotEqual(local, external)
                    self.assertTrue(0 < external <= 65535)
                    inverse[external] = local
            self.assertEqual(len(inverse), 60004 if base == 51000 else 60000)
            # Any remote gets the same private socket for a port owned by any profile.
            self.assertTrue(all(inverse[external] == local
                                for ports in profiles.values() for local, external in ports.items()))

    def test_route_successor_uses_a_disjoint_mapping_space(self):
        for base in (51000, 52000):
            ports = table.port_map(base, 0, base == 51000)
            old = {ports[local] for local in range(40000, 50000)}
            new = {ports[local] for local in range(30000, 35000)}
            self.assertTrue(old.isdisjoint(new))

    def test_eim_generic_ports_reserve_the_lease_and_rebind_domains(self):
        reserved = {24400} | set(range(30000, 35000)) | set(range(40000, 50000)) | set(range(20000, 25000))
        for base in (51000, 52000):
            public = set(table.profile_maps(base, False)['ordinary'].values())
            self.assertTrue(public.isdisjoint(reserved))

    def test_all_profiles_reserve_coordination_and_uncontrolled_socket_ports(self):
        for base in (51000, 52000):
            for dependent in (False, True):
                for ports in table.profile_maps(base, dependent).values():
                    self.assertTrue(set(ports.values()).isdisjoint(table.UNCONTROLLED_PORTS))
        outer = table.outer_port_map()
        self.assertTrue(set(outer.values()).isdisjoint(table.UNCONTROLLED_PORTS))
        self.assertEqual(set(outer.values()), set(range(20000, 30000)) | set(range(35000, 40000)))

    def test_inverse_restores_every_controlled_binding_before_the_first_peer_packet(self):
        for base in (51000, 52000):
            for offset in (0, 110, 120, 130):
                forward = table.port_map(base, offset, base == 51000)
                reverse = table.inverse(forward)
                self.assertEqual(len(forward), len(reverse))
                self.assertTrue(all(reverse[external] == local for local, external in forward.items()))
        with self.assertRaises(ValueError):
            table.inverse({40000: 52000, 40001: 52000})

    def test_outer_mapping_composes_two_independent_translations_in_both_directions(self):
        inner = table.port_map(52000, 0, False)
        outer = table.outer_port_map()
        inner_reverse, outer_reverse = table.inverse(inner), table.inverse(outer)
        self.assertEqual(set(inner.values()), set(outer))
        self.assertTrue(all(inside != outer[inside] for inside in outer))
        self.assertTrue(all(inner_reverse[outer_reverse[outer[translated]]] == local
                            for local, translated in inner.items()))

    def test_static_inverse_rules_separate_edm_mapping_from_filtering_and_preserve_lease_precedence(self):
        rendered = table.render('198.51.100.1', 51000, True, '198.51.100.2', '10.20.1.2')
        self.assertIn('type nat hook prerouting priority -90;', rendered)
        self.assertIn('elements = { 198.51.100.1 : 10.20.1.2 }', rendered)
        for remote, profile in [('198.51.100.10', 'first'), ('198.51.100.11', 'second'), ('198.51.100.2', 'peer')]:
            self.assertIn(f'ip daddr {remote} meta l4proto udp snat to 198.51.100.1 : udp sport map @{profile}', rendered)
        self.assertNotIn('ip saddr', rendered)
        self.assertIn('ct mark set 1 dnat to ip daddr map @inside : udp dport map @reverse_all', rendered)

    def test_inverse_domain_membership_owns_exactly_every_mapped_port(self):
        for base, dependent, outer in ((51000, False, False), (52000, False, False),
                                        (51000, True, False), (52000, True, False), (52000, False, True)):
            rendered = table.render('198.51.100.1', base, dependent, '198.51.100.2', '10.20.1.2', outer)
            declaration = rendered.split('set reverse_ports {', 1)[1].split('}', 1)[0]
            elements = declaration.split('elements = {', 1)[1]
            ports = {int(port.strip()) for port in elements.split(',')}
            expected = {external for mapping in table.profile_maps(base, dependent, outer).values()
                        for external in mapping.values()}
            self.assertEqual(ports, expected)
            self.assertNotIn('flags', declaration)
            self.assertIn('udp dport @reverse_ports ct mark set 1 dnat', rendered)

    def test_rebind_rejects_stale_or_wrong_inverse_domain_ownership(self):
        fixture = {'nftables': [
            {'map': {'name': 'inside', 'table': 'natlab', 'family': 'ip', 'elem': []}},
            {'map': {'name': 'ordinary', 'table': 'natlab', 'family': 'ip', 'elem': [[40001, 52001], [40002, 52002]]}},
            {'map': {'name': 'reverse_ordinary', 'table': 'natlab', 'family': 'ip', 'elem': [[52001, 40001], [52002, 40002]]}},
            {'set': {'name': 'reverse_ports', 'table': 'natlab', 'family': 'ip', 'type': 'inet_service', 'elem': [52001, 52002]}},
        ]}
        self.assertEqual(fault.eim_mapping_state(fixture), (
            {40001: 52001, 40002: 52002}, {52001: 40001, 52002: 40002}, {52001, 52002}))
        guard = fixture['nftables'][3]['set']
        for bad in ([52001], [52001, 52002, 20000]):
            guard['elem'] = bad
            with self.assertRaises(ValueError):
                fault.eim_mapping_state(fixture)
        guard['elem'] = [52001, 52002]
        guard['flags'] = ['interval']
        with self.assertRaises(ValueError):
            fault.eim_mapping_state(fixture)

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

    def test_previous_lease_use_requires_inbound_dnat_and_the_exact_replied_native_socket(self):
        grant = dict(privateIP='10.20.2.2', localPort=47038, externalPort=47038)
        # Counterless Debian gateway evidence from the real client-PCP reset case.
        connection = (
            'ipv4 2 udp 17 29 src=198.51.100.1 dst=198.51.100.2 sport=51130 dport=47038 '
            'src=10.20.2.2 dst=198.51.100.1 sport=47038 dport=51130 mark=0 use=1'
        )
        self.assertTrue(fault.inbound_lease_replied(grant, connection, '198.51.100.2'))
        self.assertFalse(fault.inbound_lease_replied(grant, connection + ' [UNREPLIED]', '198.51.100.2'))
        self.assertFalse(fault.inbound_lease_replied(dict(grant, localPort=47039), connection, '198.51.100.2'))
        self.assertFalse(fault.inbound_lease_replied(dict(grant, externalPort=47039), connection, '198.51.100.2'))
        self.assertFalse(fault.inbound_lease_replied(grant, connection, '198.51.100.1'))

    def test_reboot_flushes_only_actual_gateway_chains_and_matches_real_counterless_grants(self):
        fixture = {"nftables": [
            {"chain": {"family": "ip", "table": "nat", "name": "prerouting_miniupnpd"}},
            {"chain": {"family": "ip", "table": "natlab", "name": "prerouting"}},
            {"rule": {"chain": "prerouting_miniupnpd", "expr": [
                {"match": {"op": "==", "left": {"meta": {"key": "iif"}}, "right": "wan0"}},
                {"match": {"op": "==", "left": {"payload": {"base": "nh", "offset": 72, "len": 8}}, "right": 17}},
                {"match": {"op": "==", "left": {"payload": {"protocol": "th", "field": "dport"}}, "right": 41000}},
                {"dnat": {"family": "ip", "addr": "10.20.2.2", "port": 41000}}]}},
        ]}
        self.assertEqual(fault.dynamic_chains(fixture), [dict(
            family="ip", table="nat", name="prerouting_miniupnpd")])
        grants = fault.ipv4_udp_grants(fixture)
        self.assertEqual(len(grants), 1)
        self.assertEqual((grants[0]['privateIP'], grants[0]['localPort'], grants[0]['externalPort']),
                         ('10.20.2.2', 41000, 41000))
        self.assertEqual(fault.reacquired_grant(fixture, {'nftables': []}, fixture)['current'], grants[0])
        with self.assertRaises(ValueError):
            fault.reacquired_grant(fixture, fixture, fixture)
        rule = fixture['nftables'][2]['rule']
        rule['expr'][1]['match']['right'] = 6
        self.assertFalse(fault.ipv4_udp_grants(fixture))
        rule['expr'][1]['match']['right'] = 17
        rule['chain'] = 'prerouting'
        self.assertFalse(fault.ipv4_udp_grants(fixture))
        fixture['nftables'].append({"chain": {"family": "inet", "table": "filter", "name": "miniupnpd"}})
        self.assertEqual(len(fault.dynamic_chains(fixture)), 2)


if __name__ == "__main__":
    unittest.main()
