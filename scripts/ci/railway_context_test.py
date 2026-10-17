"""Every source the server image copies is in the context Railway builds it from."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
# What `railway-context.sh` adds beside the commit's tracked files.
ADDED = {'deployment', 'packages/e2e-wasm/pkg'}


def copied_sources(dockerfile):
    sources = []
    for line in dockerfile.splitlines():
        words = line.split()
        if not words or words[0] != 'COPY' or any(word.startswith('--from=') for word in words):
            continue
        sources.extend(word.rstrip('/') for word in words[1:-1] if not word.startswith('--'))
    return sources


def tracked(path):
    listed = subprocess.run(['git', 'ls-files', '--', path], cwd=ROOT, capture_output=True,
                            text=True, check=True)
    return listed.stdout.strip() != ''


class RailwayContextTest(unittest.TestCase):
    def test_every_copied_source_is_tracked_or_added(self):
        sources = copied_sources((ROOT / 'Dockerfile').read_text())
        self.assertIn('packages/e2e-wasm/pkg', sources)
        missing = [source for source in sources if source not in ADDED and not tracked(source)]
        self.assertEqual(missing, [], 'add these to railway-context.sh and ADDED, or track them')

    def test_the_script_adds_exactly_what_the_test_allows(self):
        script = (ROOT / 'scripts/ci/railway-context.sh').read_text()
        added = set(re.findall(r'^cp -R (\S+) ', script, re.MULTILINE))
        self.assertEqual(added, ADDED)


if __name__ == '__main__':
    unittest.main()
