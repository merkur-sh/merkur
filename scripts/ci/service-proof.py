"""Binds a release's deployment targets to what each target reports running."""
import hashlib
import json
import os
from pathlib import Path
import sys
from release_state import read_state, write_state

root = Path('dist/service-proofs')
SERVICES = ('merkur-edge', 'merkur-stun')


# The verified deployment's server, which deploy-services.sh extracts beside the release.
SERVER = Path('deployment/server/server')


def digest(path):
    return hashlib.sha512(path.read_bytes()).hexdigest()


def service_digest(name):
    return digest(Path('dist/ci-release', name))


if sys.argv[1] == 'record':
    identities = {name: service_digest(name) for name in SERVICES}
    identities['server'] = digest(SERVER)
    (root / 'identities.json').write_text(json.dumps(identities))
    parent, state = read_state()
    entry = state['releases'][-1]
    if entry['run'] != os.environ['GITHUB_RUN_ID'] or entry['version'] != os.environ['GITHUB_REF_NAME']:
        raise ValueError('stale release')
    entry['events'].append({'phase': entry['phase'], 'targetIdentities': identities})
    write_state(parent, state, f'{entry["version"]}: deployment identities')
elif sys.argv[1] == 'verify-app':
    report = json.loads((root / 'app.json').read_text())
    if report['version'] != os.environ['VERSION']:
        raise ValueError(f'app: installed {report["version"]}, not {os.environ["VERSION"]}')
    if report['server'] != digest(SERVER) or report['active'] != 'active':
        raise ValueError('app: the server is not the verified deployment')
else:
    host = sys.argv[2]
    report = json.loads((root / f'{host}.json').read_text())
    if report['version'] != os.environ['VERSION']:
        raise ValueError(f'{host}: installed {report["version"]}, not {os.environ["VERSION"]}')
    for name in SERVICES:
        if report[name] != service_digest(name) or report['active'][name] != 'active':
            raise ValueError(f'{host}: {name} does not run the retained binary')
