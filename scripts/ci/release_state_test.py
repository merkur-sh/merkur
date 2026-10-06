import unittest
from release_state import reserve, advance


class ReleaseStateTests(unittest.TestCase):
    def setUp(self):
        self.state = dict(sequenceFloor=60, baselineVersion='v0.60.2', releases=[])
        self.sha = 'a' * 40

    def test_canonical_versions_only(self):
        for version in ['v01.2.3', '1.2.3', 'v1.2.3-rc.1', 'v1.2.3\n', 'v0.60.1']:
            with self.assertRaises(ValueError):
                reserve(self.state, version, self.sha, '1', 1)

    def test_reserves_above_every_consumed_sequence(self):
        first = reserve(self.state, 'v0.61.0', self.sha, '1', 1)
        first['phase'] = 'abandoned'
        self.assertEqual(reserve(self.state, 'v0.62.0', self.sha, '2', 1)['sequence'], 62)
        with self.assertRaises(ValueError):
            reserve(self.state, 'v0.61.0', self.sha, '1', 2)

    def test_unsigned_retry_cannot_reuse_sequence(self):
        reserve(self.state, 'v0.61.0', self.sha, '1', 1)
        with self.assertRaises(ValueError):
            reserve(self.state, 'v0.61.0', self.sha, '1', 2)

    def test_retained_retry_preserves_exact_evidence(self):
        entry = reserve(self.state, 'v0.61.0', self.sha, '1', 1)
        advance(entry, 'signing', {})
        advance(entry, 'retained', {'sha512': 'immutable'})
        self.assertIs(reserve(self.state, 'v0.61.0', self.sha, '1', 2), entry)
        self.assertEqual(entry['events'][-1]['evidence'], {'sha512': 'immutable'})
        with self.assertRaises(ValueError):
            reserve(self.state, 'v0.61.0', self.sha, '2', 2)
        with self.assertRaises(ValueError):
            advance(entry, 'published', {})


if __name__ == '__main__':
    unittest.main()
