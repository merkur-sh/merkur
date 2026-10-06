import hashlib
import os
import urllib.request
from release_state import read_state

_, state = read_state()
entry = state['releases'][-1]
assert entry['version'] == os.environ['GITHUB_REF_NAME']
assets = next(e['evidence'] for e in entry['events'] if e['phase'] == 'retained')
for name, expected in assets.items():
    if not name.startswith('merkur-'): continue
    url = f'https://github.com/{os.environ["GITHUB_REPOSITORY"]}/releases/download/{entry["version"]}/{name}'
    digest = hashlib.sha512()
    with urllib.request.urlopen(url, timeout=120) as response:
        while chunk := response.read(1024 * 1024): digest.update(chunk)
    if digest.hexdigest() != expected: raise ValueError(f'public asset differs: {name}')
