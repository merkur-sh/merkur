"""The edge's egress cap is restart-safe: every start rebuilds what the last one left."""
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[2] / 'apps/edge/egress-cap.sh'


def privileged():
    return (sys.platform.startswith('linux') and shutil.which('tc') is not None and
            subprocess.run(['sudo', '-n', 'true'], capture_output=True).returncode == 0)


@unittest.skipUnless(privileged(), 'needs Linux, tc and passwordless sudo, as CI runners have')
class EgressCapTest(unittest.TestCase):
    def setUp(self):
        self.namespace = f'merkur-cap-{uuid.uuid4().hex[:8]}'
        self.sudo('ip', 'netns', 'add', self.namespace)
        self.addCleanup(self.sudo, 'ip', 'netns', 'delete', self.namespace)
        self.inside('ip', 'link', 'add', 'cap0', 'type', 'dummy')
        self.inside('ip', 'link', 'set', 'cap0', 'up')

    def sudo(self, *args):
        return subprocess.run(['sudo', '-n', *args], check=True, capture_output=True, text=True)

    def inside(self, *args):
        return self.sudo('ip', 'netns', 'exec', self.namespace, *args)

    def cap(self, rate):
        return self.inside('env', f'MERKUR_EDGE_EGRESS_RATE_MBIT={rate}',
                           'MERKUR_EDGE_EGRESS_INTERFACE=cap0', 'sh', str(SCRIPT))

    def test_every_start_builds_the_tree_whatever_the_last_one_left(self):
        # A foreign root first, then the restarts a host sees: the same rate twice,
        # which `tc ... replace` over an existing HTB root refused, then a new rate.
        self.inside('tc', 'qdisc', 'replace', 'dev', 'cap0', 'root', 'fq')
        self.cap(200)
        self.cap(200)
        self.cap(1000)
        qdiscs = self.inside('tc', 'qdisc', 'show', 'dev', 'cap0').stdout
        classes = self.inside('tc', 'class', 'show', 'dev', 'cap0').stdout
        self.assertIn('qdisc htb 1: root', qdiscs)
        self.assertIn('qdisc fq_codel 10: parent 1:1', qdiscs)
        self.assertIn('rate 1Gbit', classes)
        self.assertEqual(classes.count('class htb'), 1)

    def test_a_missing_rate_refuses_to_start(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.cap('')


if __name__ == '__main__':
    unittest.main()
