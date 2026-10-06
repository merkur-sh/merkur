"""Retained bytes are verified against the CAS release record on every resume."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tarfile
from release_state import read_state


def digest(path):
    with open(path, 'rb') as stream:
        hash_value = hashlib.sha512()
        while chunk := stream.read(1024 * 1024): hash_value.update(chunk)
        return hash_value.hexdigest()


def inventory(directory):
    return {p.name: digest(p) for p in sorted(Path(directory).iterdir()) if p.is_file()}


def validate_unsigned(directory):
    expected = {'deployment.tar.gz', 'edge-image.tar.gz', 'stun-image.tar.gz', 'NOTICES.txt'}
    expected.update(f'merkur-daemon-{platform}.tar.gz' for platform in
                    ('linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'))
    expected.update(f'verify-{platform}' for platform in ('linux-x64', 'linux-arm64'))
    files = list(Path(directory).iterdir())
    if {p.name for p in files} != expected or any(p.is_symlink() or not p.is_file() or p.stat().st_size == 0 for p in files):
        raise ValueError('unsigned artifact inventory is incomplete or unexpected')


def extract(archive, directory):
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:gz') as package:
        for member in package.getmembers():
            if not (member.isfile() or member.isdir()) or member.name.startswith('/') or '..' in Path(member.name).parts:
                raise ValueError('unsafe deployment archive member')
        for member in package.getmembers():
            target = root / member.name
            if target.resolve() != root and root not in target.resolve().parents:
                raise ValueError('deployment archive escapes destination')
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(member) as source, open(target, 'xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o777)


def restore(directory):
    _, state = read_state()
    entry = state['releases'][-1]
    if (entry['version'], entry['run']) != (os.environ['GITHUB_REF_NAME'], os.environ['GITHUB_RUN_ID']):
        raise ValueError('foreign release record')
    assets = next(e['evidence'] for e in entry['events'] if e['phase'] == 'retained')
    Path(directory).mkdir(parents=True, exist_ok=True)
    subprocess.run(['gh', 'release', 'download', entry['version'], '--repo', os.environ['GITHUB_REPOSITORY'],
                    '--dir', directory], check=True)
    actual = inventory(directory)
    if any(actual.get(name) != expected for name, expected in assets.items()):
        raise ValueError('retained release bytes differ from the release record')
    # Extra uploaded assets are never selected as executable input.
    extract(Path(directory, 'deployment.tar.gz'), 'deployment')


if __name__ == '__main__':
    if sys.argv[1] == 'inventory':
        print(json.dumps(inventory(sys.argv[2]), sort_keys=True))
    elif sys.argv[1] == 'extract':
        extract(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == 'restore':
        restore(sys.argv[2])
    elif sys.argv[1] == 'validate-unsigned':
        validate_unsigned(sys.argv[2])
    else:
        raise ValueError('unknown artifact operation')
