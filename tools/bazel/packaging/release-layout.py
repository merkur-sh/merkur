"""Independent unsigned release layout checks; producer qualification is separate."""
import hashlib
import importlib.util
from pathlib import Path
import re
import stat
import struct
import sys

module = importlib.util.spec_from_file_location('pack', Path(__file__).with_name('pack.py'))
pack = importlib.util.module_from_spec(module)
module.loader.exec_module(pack)

PLATFORMS = ('linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64')
DAEMON_FILES = {
    'merkur': '//apps/daemon:daemon',
    'merkur-dataplane': '//apps/daemon/dataplane:merkur_dataplane',
    'merkur-image-worker': '//packages/merkur-image-worker:bin_merkur_image_worker',
    'merkur-tui': '//apps/tui:bin_merkur_tui',
}
RELEASE_FILES = frozenset(
    ['deployment.tar.gz', 'edge-image.tar.gz', 'stun-image.tar.gz', 'NOTICES.txt']
    + ['merkur-daemon-' + platform + '.tar.gz' for platform in PLATFORMS]
    + ['verify-' + platform for platform in PLATFORMS[:2]]
)


def regular(path, executable=False):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_mode & 0o7000:
        raise ValueError('release input must be a nonempty regular file without special permissions')
    if executable and not info.st_mode & 0o111:
        raise ValueError('release executable lacks executable permissions')
    return info


def native(path, platform):
    regular(path, executable=True)
    if platform not in PLATFORMS:
        raise ValueError('unsupported native release platform')
    with path.open('rb') as source:
        header = source.read(64)
    if platform.startswith('linux-'):
        expected = 62 if platform == 'linux-x64' else 183
        if len(header) < 64 or header[:7] != b'\x7fELF\x02\x01\x01' or struct.unpack_from('<H', header, 18)[0] != expected or struct.unpack_from('<H', header, 16)[0] not in (2, 3) or struct.unpack_from('<I', header, 20)[0] != 1 or struct.unpack_from('<H', header, 52)[0] != 64:
            raise ValueError('release executable is not the exact native ELF64 architecture')
    else:
        expected = 0x01000007 if platform == 'darwin-x64' else 0x0100000c
        if len(header) < 32 or header[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', header, 4)[0] != expected or struct.unpack_from('<I', header, 12)[0] != 2:
            raise ValueError('release executable is not the exact thin native Mach-O architecture')


def tree(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('release tree must be a real directory')
    entries = {}
    for path in sorted(directory.rglob('*')):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        name = path.relative_to(directory).as_posix()
        pack.destination(name)
        regular(path)
        entries[name] = path
    if not entries:
        raise ValueError('empty release tree')
    return entries


def daemon(directory, platform):
    entries = tree(directory)
    if any(not path.is_file() for path in directory.iterdir()):
        raise ValueError('daemon archive cannot contain directory members')
    if set(entries) != set(DAEMON_FILES):
        raise ValueError('daemon consumer requires exactly its four executable producers')
    for path in entries.values():
        if stat.S_IMODE(path.lstat().st_mode) != 0o555:
            raise ValueError('daemon archive executable mode must be normalized to 0555')
        native(path, platform)
    return entries


def service(directory, build_id, migration_names):
    if not isinstance(build_id, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', build_id):
        raise ValueError('frontend identity must be a canonical UUID')
    if not isinstance(migration_names, list) or not migration_names or any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.js', name) for name in migration_names) or len(set(migration_names)) != len(migration_names):
        raise ValueError('exact bundled migration inventory required')
    entries = tree(directory)
    if 'server/server' not in entries:
        raise ValueError('missing declared application server')
    native(entries['server/server'], 'linux-x64')
    migrations = {name for name in entries if name.startswith('migrations/')}
    if migrations != {'migrations/' + name for name in migration_names}:
        raise ValueError('missing or additional bundled migration')
    if 'web/index.html' not in entries or 'web/merkur-build.json' not in entries:
        raise ValueError('missing compiled frontend entrypoint or identity')
    marker = pack.load_json(entries['web/merkur-build.json'].read_bytes())
    if marker != {'buildId': build_id} or entries['web/merkur-build.json'].read_bytes() != pack.canonical(marker):
        raise ValueError('frontend identity differs from release context')
    originals = {name for name in entries if name.startswith('web/') and not name.endswith('.br')}
    compressed = {name for name in entries if name.startswith('web/') and name.endswith('.br')}
    if compressed != {name + '.br' for name in originals}:
        raise ValueError('frontend requires exactly one declared Brotli artifact for every original')
    allowed = {'server/server'} | migrations | originals | compressed
    if set(entries) != allowed:
        raise ValueError('unexpected unsigned service member or signing proof')
    return entries


def inventory(directory, manifest):
    """Bind complete consumer filenames to exact unsigned bytes, never to readiness booleans."""
    entries = tree(directory)
    if any(not path.is_file() for path in directory.iterdir()):
        raise ValueError('unsigned release input namespace must contain only flat regular artifacts')
    if set(entries) != RELEASE_FILES:
        raise ValueError('unsigned release requires its exact ten artifacts and attribution')
    if not isinstance(manifest, dict) or set(manifest) != {'files'} or not isinstance(manifest['files'], list):
        raise ValueError('malformed unsigned release signing inventory')
    seen = set()
    for item in manifest['files']:
        if not isinstance(item, dict) or set(item) != {'name', 'size', 'sha512'}:
            raise ValueError('malformed unsigned artifact descriptor')
        name = item['name']
        if not isinstance(name, str) or name in seen or name not in entries or type(item['size']) is not int or item['size'] <= 0 or not isinstance(item['sha512'], str) or not re.fullmatch(r'[0-9a-f]{128}', item['sha512']):
            raise ValueError('invalid unsigned artifact identity')
        seen.add(name)
        path = entries[name]
        with path.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha512').hexdigest()
        if item['size'] != path.stat().st_size or item['sha512'] != digest:
            raise ValueError('unsigned artifact bytes differ from signing inventory')
    if [item['name'] for item in manifest['files']] != sorted(RELEASE_FILES):
        raise ValueError('missing, duplicate or unordered unsigned signing input')
    for platform in PLATFORMS[:2]:
        native(entries['verify-' + platform], platform)
    # License completeness requires an independently generated complete locked dependency
    # attribution receipt. Nonempty NOTICES is a layout condition, not that proof.
    return entries


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise ValueError('expected declared unsigned artifact directory and signing inventory')
    inventory(Path(sys.argv[1]), pack.load_json(Path(sys.argv[2]).read_bytes()))
