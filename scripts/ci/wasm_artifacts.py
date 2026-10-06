"""Pass exact-checkout WASM outputs between CI jobs; never cache test verdicts."""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

ROOTS = (
    'packages/term-wasm/pkg',
    'apps/web/src/term-wasm/pkg',
    'packages/e2e-wasm/pkg',
    'packages/graphics-wasm/pkg',
    'packages/graphics-codec-probe/pkg',
)
FIXTURE = 'target/rust/release/zstd-fixture'
MANIFEST = 'wasm-artifacts.json'


def identity(root):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('CI artifact source tree is dirty')
    return {
        'commit': git('rev-parse', 'HEAD'),
        'tree': git('rev-parse', 'HEAD^{tree}'),
        'platform': sys.platform,
        'arch': os.uname().machine,
    }


def allowed(name):
    parts = name.split('/')
    return (all(part not in ('', '.', '..') for part in parts) and
            (name == FIXTURE or any(name.startswith(root + '/') for root in ROOTS)))


def digest(body):
    return hashlib.sha256(body).hexdigest()


def require_inventory(names):
    for root in ROOTS:
        for suffix in ('.wasm', '.js', '.d.ts', 'package.json'):
            if not any(name.startswith(root + '/') and name.endswith(suffix) for name in names):
                raise ValueError(f'incomplete WASM package: {root} ({suffix})')
    if FIXTURE not in names:
        raise ValueError('missing native zstd fixture')


def pack(root, archive):
    root = root.resolve()
    source = identity(root)
    paths = sorted(path for directory in ROOTS for path in (root / directory).rglob('*'))
    paths.append(root / FIXTURE)
    files = {}
    bodies = {}
    for path in paths:
        if path.is_symlink():
            raise ValueError(f'artifact symlink: {path}')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f'artifact is not a regular file: {path}')
        name = path.relative_to(root).as_posix()
        body = path.read_bytes()
        bodies[name] = body
        files[name] = {'sha256': digest(body), 'size': len(body),
                       'mode': 0o755 if name == FIXTURE else 0o644}
    require_inventory(files)
    if identity(root) != source:
        raise ValueError('source changed while collecting artifacts')
    manifest = json.dumps({'source': source, 'files': files}, sort_keys=True).encode()
    with tarfile.open(archive, 'w') as output:
        for name, body in [(MANIFEST, manifest), *bodies.items()]:
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            entry.mode = files[name]['mode'] if name != MANIFEST else 0o644
            output.addfile(entry, io.BytesIO(body))


def restore(root, archive):
    root = root.resolve()
    # Validate the entire archive before touching an output. Never use extractall:
    # paths, links, duplicates and modes are not supplied by tar metadata.
    source = identity(root)
    with tarfile.open(archive, 'r') as bundle:
        members = bundle.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)) or any(not member.isfile() for member in members):
            raise ValueError('duplicate or non-file artifact entry')
        if MANIFEST not in names or any(name != MANIFEST and not allowed(name) for name in names):
            raise ValueError('unexpected artifact path')
        manifest = json.load(bundle.extractfile(MANIFEST))
        if manifest['source'] != source:
            raise ValueError('WASM artifacts belong to a different checkout or platform')
        files = manifest['files']
        if set(names) != {MANIFEST, *files}:
            raise ValueError('artifact inventory differs from its manifest')
        require_inventory(files)
        bodies = {}
        for name, evidence in files.items():
            body = bundle.extractfile(name).read()
            if len(body) != evidence['size'] or digest(body) != evidence['sha256']:
                raise ValueError(f'artifact digest mismatch: {name}')
            if evidence['mode'] != (0o755 if name == FIXTURE else 0o644):
                raise ValueError(f'artifact mode mismatch: {name}')
            destination = root / name
            if any(path.is_symlink() for path in [destination, *destination.parents]):
                raise ValueError(f'artifact destination is a symlink: {name}')
            if destination.exists():
                raise ValueError(f'artifact destination already exists: {name}')
            bodies[name] = body
    for name, body in bodies.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
        destination.chmod(files[name]['mode'])


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('pack', 'restore'):
        raise SystemExit('usage: wasm_artifacts.py pack|restore ARCHIVE')
    {'pack': pack, 'restore': restore}[sys.argv[1]](Path.cwd(), Path(sys.argv[2]))
