"""Bind source-CMake's actual compiler selection to original publisher Files."""

import hashlib
import io
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile


def original_source(archive, pins):
    data = archive.read_bytes()
    source = pins['source']
    if hashlib.sha256(data).hexdigest() != source['sha256']:
        raise ValueError('CMake requires its exact original publisher source archive')
    if pins['version'] != '4.4.3' or source['strip_prefix'] != 'cmake-4.4.3':
        raise ValueError('CMake original source release differs')
    prefix, members, seen = source['strip_prefix'] + '/', {}, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as original:
        for member in original:
            name = member.name
            logical = PurePosixPath(name)
            if logical.is_absolute() or '..' in logical.parts or str(logical) != name or name in seen:
                raise ValueError('Invalid or repeated original CMake archive member')
            seen.add(name)
            if member.isdir():
                continue
            if not member.isfile() or not name.startswith(prefix):
                raise ValueError('CMake source archive requires ordinary publisher Files')
            members[name[len(prefix):]] = original.extractfile(member).read()
    if not members.get('LICENSE.rst', b'').strip() or not members.get('Licenses/README.rst', b'').strip():
        raise ValueError('CMake original source/license closure is absent')
    return members


def patched_source(original, patches, git, environment):
    """Apply the declared maintained patches with the original declared Git."""
    members, changed = dict(original), set()
    with tempfile.TemporaryDirectory(prefix='merkur-cmake-patch-') as temporary:
        root = Path(temporary)
        for patch in patches:
            patch = patch.absolute()
            targets = set()
            lines = patch.read_bytes().splitlines()
            for index, line in enumerate(lines):
                if line == b'--- /dev/null':
                    if index + 1 >= len(lines) or not lines[index + 1].startswith(b'+++ b/'):
                        raise ValueError('CMake maintained patch member relation differs')
                    name = lines[index + 1].removeprefix(b'+++ b/').decode('utf8')
                    if name in members:
                        raise ValueError('CMake new-file patch targets an existing source member')
                elif line.startswith(b'--- a/'):
                    name = line.removeprefix(b'--- a/').decode('utf8')
                    if index + 1 >= len(lines) or lines[index + 1] != b'+++ b/' + name.encode():
                        raise ValueError('CMake maintained patch member relation differs')
                else:
                    continue
                logical = PurePosixPath(name)
                if logical.is_absolute() or '..' in logical.parts or str(logical) != name:
                    raise ValueError('CMake maintained patch escapes its original source')
                targets.add(name)
            if not targets:
                raise ValueError('CMake maintained patch has no original target members')
            for name in targets:
                target = root / name
                if name in members:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(members[name])
            for arguments in [[git, 'apply', '--check', patch], [git, 'apply', patch]]:
                subprocess.run([str(value) for value in arguments], cwd=root, env=environment, check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for name in targets:
                file = root / name
                if file.is_symlink() or not file.is_file():
                    raise ValueError('CMake maintained patch did not produce an ordinary File')
                members[name] = file.read_bytes()
            changed.update(targets)
    return members, changed


def source_files(records, expected, execroot):
    seen = set()
    for record in records:
        name = record['relative']
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name or name in seen:
            raise ValueError('Invalid or repeated CMake original source File')
        if name not in expected or (execroot / record['path']).read_bytes() != expected[name]:
            raise ValueError('CMake compiler source differs from its original archive and maintained patches')
        seen.add(name)
    if seen != set(expected):
        raise ValueError('CMake original source File closure is incomplete')


# Explicit publisher subtrees. These are the original notice Files shipped in
# this release; unknown Utility subtrees remain pending rather than inheriting
# the Kitware root license. Selected source byte authority is checked first.
SCOPED_NOTICES = {
    'Source/kwsys': ['Source/kwsys/Copyright.txt'],
    'Utilities/KWIML': ['Utilities/KWIML/Copyright.txt'],
    'Utilities/cmbzip2': ['Utilities/cmbzip2/LICENSE'],
    'Utilities/cmcppdap': ['Utilities/cmcppdap/LICENSE', 'Utilities/cmcppdap/NOTICE'],
    'Utilities/cmcurl': ['Utilities/cmcurl/COPYING'],
    'Utilities/cmexpat': ['Utilities/cmexpat/COPYING'],
    'Utilities/cmjsoncpp': ['Utilities/cmjsoncpp/LICENSE'],
    'Utilities/cmlibarchive': ['Utilities/cmlibarchive/COPYING'],
    'Utilities/cmliblzma': ['Utilities/cmliblzma/COPYING'],
    'Utilities/cmlibrhash': ['Utilities/cmlibrhash/COPYING'],
    'Utilities/cmlibuv': ['Utilities/cmlibuv/LICENSE'],
    'Utilities/cmnghttp2': ['Utilities/cmnghttp2/COPYING'],
    'Utilities/cmzlib': ['Utilities/cmzlib/Copyright.txt'],
    'Utilities/cmzstd': ['Utilities/cmzstd/LICENSE'],
}


def partition(selected, source_root, source, original, changed, workspace_license, linked, licenses):
    origins = [{'component': 'cmake', 'namespace': str(source_root),
                'directory': source_root, 'members': source, 'aliases': {}}]
    inside, pending = [], []
    for path in selected:
        prefix = str(source_root) + '/'
        if path.startswith(prefix) and path[len(prefix):] in source:
            inside.append(path)
        else:
            pending.append(path)
    facts = linked.bind_original_inputs(inside, origins, licenses)
    notices = {}
    for fact in facts:
        member = fact['source_path']
        scopes = [prefix for prefix in SCOPED_NOTICES if member.startswith(prefix + '/')]
        if scopes:
            names = SCOPED_NOTICES[max(scopes, key=len)]
        elif source[member].startswith((b'/* Distributed under the OSI-approved BSD 3-Clause License.',
                                      b'# Distributed under the OSI-approved BSD 3-Clause License.')):
            names = ['LICENSE.rst']
        else:
            pending.append(str(source_root / member))
            continue
        for name in names:
            if not original.get(name, b'').strip() or source.get(name) != original[name]:
                raise ValueError('Selected CMake publisher notice differs from its original archive')
            notices[name] = original[name]
        if member in changed:
            if not workspace_license.strip():
                raise ValueError('Selected CMake maintained source requires its workspace license File')
            notices['merkur-maintained-source-LICENSE'] = workspace_license
    return {'sources': facts, 'pending': sorted(set(pending)), 'notices': notices}


def generator_sources(descriptor, root, executable, licenses):
    """Consume the exact original CMake action's existing grouped File facts."""
    if not isinstance(descriptor, dict) or set(descriptor) != {'producer', 'executable', 'configuration', 'notices', 'original_sources'}:
        raise ValueError('CMake generator requires its actual grouped producer Files')
    configuration = descriptor['configuration']
    value = __import__('json').loads((root / configuration).read_bytes())
    if value['producer'] != descriptor['producer'] or value['binary'] != descriptor['executable'] or executable != root / descriptor['executable']:
        raise ValueError('CMake selected generator belongs to another actual producer/executable')
    artifact = value['artifact']
    raw = executable.read_bytes()
    if len(raw) != artifact['size'] or hashlib.sha256(raw).hexdigest() != artifact['sha256']:
        raise ValueError('CMake selected generator differs from its original compiler artifact')
    originals = descriptor['original_sources']
    if not isinstance(originals, list) or len(originals) != len(set(originals)):
        raise ValueError('CMake original grouped File ownership is ambiguous')
    by_member = {entry['relative']: entry['path'] for entry in value['source']}
    if len(by_member) != len(value['source']) or not set(by_member.values()).issubset(originals):
        raise ValueError('CMake compiler sources escape their actual grouped original Files')
    facts = value['selected_sources']
    if not facts:
        raise ValueError('CMake selected generator lacks actual compiler source facts')
    for fact in facts:
        member = fact['source_path']
        if member not in by_member:
            raise ValueError('CMake retained member has no declared original source File')
        raw = (root / by_member[member]).read_bytes()
        if len(raw) != fact['size'] or hashlib.sha256(raw).hexdigest() != fact['sha256']:
            raise ValueError('CMake selected original source File changed')
    notices = {}
    for fact in value['selected_notices']:
        member = fact['path']
        raw = licenses.read_regular(root / descriptor['notices'], member)
        if member in notices or len(raw) != fact['size'] or hashlib.sha256(raw).hexdigest() != fact['sha256']:
            raise ValueError('CMake original selected notice File changed')
        notices[member] = raw
    if not notices:
        raise ValueError('CMake selected generator lacks original license Files')
    # Known implementation/license joins do not close original SDK/generated
    # compiler inputs. Propagate the producer's existing pending boundary.
    return facts, notices, value['pending_sources']
