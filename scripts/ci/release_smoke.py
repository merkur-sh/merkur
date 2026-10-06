"""Run all four release executables without access to signing credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def smoke(directory, version, sequence, signed):
    root = Path(directory).resolve()
    assert subprocess.check_output([root / 'merkur', 'version'], text=True).strip() == version
    assert subprocess.check_output([root / 'merkur-tui', 'version'], text=True).strip() == version
    subprocess.run([root / 'merkur-tui', '--help'], check=True, capture_output=True)
    result = subprocess.run([root / 'merkur-dataplane', '--merkur-release-smoke-invalid'],
                            capture_output=True, text=True)
    assert result.returncode != 0 and 'unknown argument' in result.stderr, result.stderr
    # READY is emitted only after platform sandbox initialization succeeds.
    worker = subprocess.run([root / 'merkur-image-worker'], input=b'', capture_output=True,
                            env={'MallocNanoZone': '0', 'MallocMaxMagazines': '1',
                                 'MallocMaxMediumMagazines': '1'}, timeout=30)
    assert worker.stdout == b'IMG!', repr(worker.stdout[:80])
    if signed:
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home, SHELL='/bin/sh')
            platform = sys.argv[5]
            subprocess.run([root / 'merkur', 'setup', f'{signed}/merkur-daemon-{platform}.tar.gz',
                            f'{signed}/merkur-release.json', f'{signed}/merkur-release.sig'],
                           env=env, check=True)
            trust = json.loads(Path(home, '.merkur/release-trust.json').read_text())
            assert trust['sequence'] == int(sequence)
            assert Path(home, '.merkur/current').resolve().name == version


if __name__ == '__main__':
    smoke(sys.argv[1], sys.argv[2], sys.argv[3], None if sys.argv[4] == '-' else str(Path(sys.argv[4]).resolve()))
