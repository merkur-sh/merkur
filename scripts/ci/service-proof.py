"""Binds a release's deployment targets to what each target reports running."""
import hashlib
import json
import os
from pathlib import Path
import sys
from release_state import read_state, write_state

root = Path('dist/service-proofs')
SERVICES = ('merkur-edge', 'merkur-stun')


def digest(name):
    return hashlib.sha512(Path('dist/ci-release', name).read_bytes()).hexdigest()


if sys.argv[1] == 'record':
    identities = {name: digest(name) for name in SERVICES}
    identities['railway'] = json.loads((root / 'railway.json').read_text())['deploymentId']
    (root / 'identities.json').write_text(json.dumps(identities))
    parent, state = read_state()
    entry = state['releases'][-1]
    if entry['run'] != os.environ['GITHUB_RUN_ID'] or entry['version'] != os.environ['GITHUB_REF_NAME']:
        raise ValueError('stale release')
    entry['events'].append({'phase': entry['phase'], 'targetIdentities': identities})
    write_state(parent, state, f'{entry["version"]}: deployment identities')
else:
    host = sys.argv[2]
    report = json.loads((root / f'{host}.json').read_text())
    if report['version'] != os.environ['VERSION']:
        raise ValueError(f'{host}: installed {report["version"]}, not {os.environ["VERSION"]}')
    for name in SERVICES:
        if report[name] != digest(name) or report['active'][name] != 'active':
            raise ValueError(f'{host}: {name} does not run the retained binary')
