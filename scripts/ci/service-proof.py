import json
import os
from pathlib import Path
import sys
from release_state import read_state, write_state

root = Path('dist/service-proofs')
if sys.argv[1] == 'record':
    identities = {p.stem: p.read_text().strip() for p in root.glob('*.image')}
    identities['railway'] = json.loads((root / 'railway.json').read_text())['deploymentId']
    (root / 'identities.json').write_text(json.dumps(identities))
    parent, state = read_state()
    entry = state['releases'][-1]
    if entry['run'] != os.environ['GITHUB_RUN_ID'] or entry['version'] != os.environ['GITHUB_REF_NAME']:
        raise ValueError('stale release')
    entry['events'].append({'phase': entry['phase'], 'targetIdentities': identities})
    write_state(parent, state, f'{entry["version"]}: deployment identities')
else:
    app = sys.argv[2]
    expected = (root / f'{app}.image').read_text().strip()
    machines = json.loads((root / f'{app}.machines.json').read_text())
    active = [m for m in machines if m['state'] != 'destroyed']
    if not active or not all(m['state'] == 'started' and m['config']['image'] == expected for m in active):
        raise ValueError(f'{app}: machines do not run the retained image digest')
