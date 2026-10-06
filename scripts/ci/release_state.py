"""Durable release reservations. Git fast-forward updates provide compare-and-swap."""
import json
import os
import re
import subprocess
import sys
from release_inventory import configuration, assert_configuration

REF = 'heads/release-state'
VERSION = re.compile(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
PHASES = ['reserved', 'signing', 'retained', 'services', 'published']


def version_tuple(value):
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError('release tag must be canonical vMAJOR.MINOR.PATCH')
    return tuple(map(int, match.groups()))


def reserve(state, version, commit, run_id, attempt):
    version_tuple(version)
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('invalid source commit')
    records = state['releases']
    existing = next((r for r in records if r['version'] == version), None)
    if existing:
        if (existing['commit'], existing['run']) != (commit, run_id):
            raise ValueError('reservation belongs to another commit or workflow run')
        if existing != records[-1]:
            raise ValueError('a newer reservation prevents this release from deploying')
        if existing['phase'] == 'abandoned':
            raise ValueError('abandoned reservation; create a new version tag')
        if attempt != existing['attempt'] and existing['phase'] in ('reserved', 'signing'):
            raise ValueError('no durable signed outputs; sequence consumed, create a new tag')
        return existing
    previous_version = records[-1]['version'] if records else state['baselineVersion']
    if version_tuple(version) <= version_tuple(previous_version):
        raise ValueError('version must advance beyond every reserved version')
    sequence = max([state['sequenceFloor']] + [r['sequence'] for r in records]) + 1
    if sequence > 9007199254740991:
        raise ValueError('sequence exceeds the manifest integer range')
    entry = dict(version=version, commit=commit, run=run_id, attempt=attempt,
                 sequence=sequence, phase='reserved', events=[])
    records.append(entry)
    return entry


def advance(entry, phase, evidence):
    if phase == 'signing' and entry['phase'] not in ('reserved', 'signing'):
        raise ValueError('retained releases must never be signed again')
    if phase in PHASES and PHASES.index(phase) <= PHASES.index(entry['phase']):
        return
    if phase not in PHASES or PHASES.index(phase) != PHASES.index(entry['phase']) + 1:
        raise ValueError('invalid release stage transition')
    entry['events'].append(dict(phase=phase, evidence=evidence))
    entry['phase'] = phase


def gh(path, body=None):
    args = ['gh', 'api', f'repos/{os.environ["GITHUB_REPOSITORY"]}/{path}']
    if body is not None:
        args += ['--method', 'POST', '--input', '-']
    result = subprocess.run(args, input=None if body is None else json.dumps(body),
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def read_state():
    ref = gh(f'git/ref/{REF}')['object']['sha']
    commit = gh(f'git/commits/{ref}')
    tree = gh(f'git/trees/{commit["tree"]["sha"]}')
    blob = next(x for x in tree['tree'] if x['path'] == 'state.json')
    import base64
    state = json.loads(base64.b64decode(gh(f'git/blobs/{blob["sha"]}')["content"]))
    return ref, state


def write_state(parent, state, message):
    tree = gh('git/trees', {'tree': [{'path': 'state.json', 'mode': '100644', 'type': 'blob',
                                    'content': json.dumps(state, indent=2) + '\n'}]})
    commit = gh('git/commits', {'message': message, 'tree': tree['sha'], 'parents': [parent]})
    # A competing writer has a sibling commit: force:false rejects its replacement.
    subprocess.run(['gh', 'api', '--method', 'PATCH',
                    f'repos/{os.environ["GITHUB_REPOSITORY"]}/git/refs/{REF}',
                    '--input', '-'], input=json.dumps({'sha': commit['sha'], 'force': False}),
                   text=True, check=True, stdout=subprocess.DEVNULL)


def main():
    command = sys.argv[1]
    parent, state = read_state()
    version = os.environ['GITHUB_REF_NAME']
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    run_id = os.environ['GITHUB_RUN_ID']
    if command == 'reserve':
        subprocess.run(['git', 'fetch', 'origin', 'main', '--no-tags'], check=True)
        subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'FETCH_HEAD'], check=True)
        previous_commit = state['releases'][-1]['commit'] if state['releases'] else state['baselineCommit']
        subprocess.run(['git', 'merge-base', '--is-ancestor', previous_commit, commit], check=True)
        # Require the actual CI workflow's successful main-push run on these bytes.
        runs = gh(f'actions/workflows/ci.yml/runs?head_sha={commit}&event=push&status=success&per_page=100')['workflow_runs']
        if not any(r['head_sha'] == commit and r['head_branch'] == 'main'
                   and r['path'] == '.github/workflows/ci.yml' for r in runs):
            raise ValueError('tag commit has no successful main-push CI run')
        entry = reserve(state, version, commit, run_id, int(os.environ['GITHUB_RUN_ATTEMPT']))
        if 'configuration' in entry: assert_configuration(entry)
        else: entry['configuration'] = configuration()
        write_state(parent, state, f'Reserve {version} sequence {entry["sequence"]}')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'sequence={entry["sequence"]}\ncommit={commit}\n')
            output.write(f'resume={str(entry["phase"] not in ("reserved", "signing")).lower()}\n')
    else:
        entry = next(r for r in state['releases'] if r['version'] == version)
        if entry != state['releases'][-1] or (entry['commit'], entry['run']) != (commit, run_id):
            raise ValueError('stale or foreign release')
        assert_configuration(entry)
        if int(os.environ['GITHUB_RUN_ATTEMPT']) != entry['attempt'] and entry['phase'] in ('reserved', 'signing'):
            raise ValueError('unsigned reservation consumed; create a new tag')
        if command == 'inspect':
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write(f'resume={str(entry["phase"] not in ("reserved", "signing")).lower()}\n')
            return
        if command == 'assert':
            return
        evidence = json.load(open(sys.argv[3])) if len(sys.argv) == 4 else {}
        advance(entry, sys.argv[2], evidence)
        write_state(parent, state, f'{version}: {sys.argv[2]}')


if __name__ == '__main__':
    main()
