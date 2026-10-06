"""Genuine Bazel test fixture: nonce-selectable success, failure and owned barriers.

Only qualification uses these deliberate barriers and failure prefixes. The
production test code and authoritative ledger are never edited by this fixture.
"""
import os
from pathlib import Path
import sys
import time


def probe(nonce_file, barrier_root):
    nonce = Path(nonce_file).read_text().strip()
    if len(nonce) != 64 or any(character not in '0123456789abcdef' for character in nonce):
        raise ValueError('Exact original 32-byte test epoch required')
    if nonce[0] in 'bc':
        root = Path(barrier_root)
        marker = root / (nonce + '.started')
        with marker.open('x') as output:
            output.write(nonce)
            output.flush()
            os.fsync(output.fileno())
        while not (root / (nonce + '.release')).exists():
            time.sleep(.02)
    print('QUALIFICATION_NONCE=' + nonce, flush=True)
    if nonce[0] == 'f':
        sys.exit(1)


if __name__ == '__main__':
    probe(sys.argv[1], sys.argv[2])
