#!/usr/bin/env python3
"""Exercise topology state/config functions with private filesystem and command fixtures."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


TOPOLOGY = Path(__file__).with_name('native-topology.sh')

BOUNDARIES = r'''
STATE="$NATLAB_TEST_STATE"
ip() {
  if [[ "$1" == -n ]]; then
    printf '%s\n' "$NATLAB_TEST_WAN"
    return
  fi
  [[ "$1" == netns && "$2" == exec ]] || return 92
  shift 3
  case "$1" in
    sh) return 0 ;;
    nft)
      if [[ "${2:-}" == -f ]]; then cat >> "$STATE/emitted-nft"; fi
      return 0
      ;;
    ss) printf 'UNCONN 0 0 0.0.0.0:1900 0.0.0.0:*\n' ;;
    miniupnpd) return 0 ;;
    *) return 93 ;;
  esac
}
'''


class NativeTopologyStateTests(unittest.TestCase):
    def execute(self, body, lifecycle=None, addresses=None, active=True):
        source = TOPOLOGY.read_text()
        declarations = source[:source.index('[[ ${1:-} == cases ]] || require_container')]
        with tempfile.TemporaryDirectory(prefix='merkur topology state ') as directory:
            state = Path(directory)
            if active:
                (state / 'case').write_text('eim-pdf\n')
            if lifecycle is not None:
                (state / 'lifecycle.json').write_text(json.dumps(lifecycle) + '\n')
            fixture = state / 'fixture.sh'
            fixture.write_text(declarations + BOUNDARIES + body)
            env = dict(os.environ, NATLAB_TEST_STATE=directory,
                       NATLAB_TEST_WAN=json.dumps(addresses or []))
            result = subprocess.run(['bash', str(fixture)], env=env, capture_output=True,
                                    text=True, timeout=5)
            files = {path.name: path.read_text() for path in state.iterdir() if path.is_file()}
        return result, files

    def test_native_phase_creates_once_and_preserves_other_lifecycle_state(self):
        result, files = self.execute('native_phase\ncp "$STATE/lifecycle.json" "$STATE/first.json"\nnative_phase\n',
                                     lifecycle={'routeChangedAtNs': 7, 'currentPrivateIP': '10.20.2.3'})
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(files['lifecycle.json'])
        self.assertIs(type(state['nativeSessionsStartedAtNs']), int)
        self.assertGreater(state['nativeSessionsStartedAtNs'], 0)
        self.assertEqual(state['routeChangedAtNs'], 7)
        self.assertEqual(state['currentPrivateIP'], '10.20.2.3')
        self.assertEqual(files['lifecycle.json'], files['first.json'])

    def test_native_phase_reuses_only_an_existing_positive_integer_marker(self):
        initial = {'nativeSessionsStartedAtNs': 123456789, 'routeChangedAtNs': 7}
        result, files = self.execute('native_phase\n', lifecycle=initial)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(files['lifecycle.json']), initial)
        for invalid in (0, -1, True, 1.5, '123456789'):
            with self.subTest(timestamp=invalid):
                initial = {'nativeSessionsStartedAtNs': invalid}
                result, files = self.execute('native_phase\n', lifecycle=initial)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('invalid timestamp', result.stderr)
                self.assertEqual(json.loads(files['lifecycle.json']), initial)

    def test_native_phase_requires_an_active_topology(self):
        result, files = self.execute('native_phase\n', active=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('lifecycle.json', files)

    def test_gateway_external_address_is_the_exact_owned_wan_address_including_inner_nat(self):
        for address in ('198.51.100.2', '172.30.2.2'):
            with self.subTest(address=address):
                addresses = [{'addr_info': [{'family': 'inet', 'local': address}]}]
                result, files = self.execute('miniupnpd client merkur-natlab-client-cpe 2 upnp\n',
                                             addresses=addresses)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = dict(line.split('=', 1) for line in files['client-miniupnpd.conf'].splitlines()
                              if '=' in line)
                self.assertEqual(config['ext_ip'], address)

    def test_gateway_refuses_ambiguous_wan_ownership(self):
        for addresses in ([], [{'addr_info': [
                {'family': 'inet', 'local': '198.51.100.2'},
                {'family': 'inet', 'local': '198.51.100.3'}]}]):
            with self.subTest(addresses=addresses):
                result, files = self.execute('miniupnpd client merkur-natlab-client-cpe 2 upnp\n',
                                             addresses=addresses)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('client-miniupnpd.conf', files)


if __name__ == '__main__':
    unittest.main()
