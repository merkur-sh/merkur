"""Archive the exact declared unsigned deployment; complete release NOTICES remain external."""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import stat
import struct
import sys

spec = importlib.util.spec_from_file_location('pack', Path(__file__).with_name('pack.py'))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)

spec = importlib.util.spec_from_file_location('license_inputs', Path(__file__).with_name('license-inputs.py'))
license_inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(license_inputs)

MIGRATIONS = ('001_initial_schema.js', '002_box_identity.js',
              '003_account_privilege.js', '004_notification_outbox.js')


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


def descriptor(value):
    if not isinstance(value, dict) or set(value) != {'input', 'label'} or not isinstance(value['input'], str) or not value['input'] or not isinstance(value['label'], str) or not re.fullmatch(r'(?:@@[^/]*|@[^/]+)?//[^\s:]*:[^\s:]+', value['label']):
        raise ValueError('Exact declared deployment input identity required')
    return value


class PinnedFile:
    def __init__(self, handle):
        self.handle = handle

    def open(self, mode):
        if mode != 'rb':
            raise ValueError('Declared input is read-only')
        os.lseek(self.handle, 0, os.SEEK_SET)
        return os.fdopen(os.dup(self.handle), mode)


class DeclaredInputs:
    """Allow only each typed input's top-level engine presentation, never member aliases."""
    def __init__(self):
        self.handles, self.directories, self.files, self.presentations = [], {}, [], []

    def directory(self, physical):
        if physical in self.directories:
            return self.directories[physical][0]
        if physical == Path('/'):
            handle = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        else:
            parent = self.directory(physical.parent)
            handle = os.open(physical.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.handles.append(handle)
        before, opened = physical.lstat(), os.fstat(handle)
        if not stat.S_ISDIR(before.st_mode) or identity(before) != identity(opened):
            raise ValueError('Declared input directory changed while opening')
        self.directories[physical] = (handle, identity(opened), None)
        return handle

    def presentation(self, source):
        logical = Path(source).absolute()
        physical = logical.resolve(strict=True)
        self.presentations.append((logical, physical))
        return physical

    def file(self, physical, executable=False, *, allow_empty=False):
        parent = self.directory(physical.parent)
        before = os.stat(physical.name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or (before.st_size == 0 and not allow_empty) or before.st_mode & 0o7000 or (executable and not before.st_mode & 0o111):
            raise ValueError('Deployment input must be a nonempty safe regular file')
        handle = os.open(physical.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        self.handles.append(handle)
        if identity(before) != identity(os.fstat(handle)):
            raise ValueError('Declared deployment file changed while opening')
        pinned = PinnedFile(handle)
        with pinned.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        self.files.append((physical, pinned, identity(before), digest))
        return pinned, before.st_size, digest

    def tree(self, value, prefix, path_validator=pack.destination, *, allow_empty=False):
        physical = self.presentation(descriptor(value)['input'])
        entries = {}
        def walk(directory, parts):
            handle = self.directory(directory)
            names = sorted(os.listdir(handle))
            self.directories[directory] = (handle, identity(os.fstat(handle)), names)
            for name in names:
                relative = '/'.join([*parts, name])
                destination = path_validator(prefix + '/' + relative)
                info = os.stat(name, dir_fd=handle, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o7000:
                    walk(directory / name, [*parts, name])
                elif stat.S_ISREG(info.st_mode):
                    pinned, size, _ = self.file(directory / name, allow_empty=allow_empty)
                    entries[destination] = ({'mode': '0444', 'label': value['label']}, pinned, size)
                else:
                    raise ValueError('Declared deployment tree contains a link or special member')
        walk(physical, [])
        if not entries:
            raise ValueError('Declared deployment tree is empty')
        return entries

    def read(self, pinned, count=-1):
        with pinned.open('rb') as stream:
            return stream.read(count)

    def verify(self):
        for logical, physical in self.presentations:
            if logical.resolve(strict=True) != physical:
                raise ValueError('Declared engine input presentation changed')
        for directory, (handle, before, names) in self.directories.items():
            current, opened = directory.lstat(), os.fstat(handle)
            # Parent directories outside input trees may gain the declared output Files.
            if (current.st_dev, current.st_ino, current.st_mode) != (before[0], before[1], before[2]) or (opened.st_dev, opened.st_ino) != before[:2]:
                raise ValueError('Declared input directory ownership changed')
            if names is not None and (identity(current) != before or sorted(os.listdir(handle)) != names):
                raise ValueError('Declared input tree membership changed')
        for physical, pinned, before, digest in self.files:
            if identity(physical.lstat()) != before or identity(os.fstat(pinned.handle)) != before:
                raise ValueError('Declared input file identity changed')
            with pinned.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                    raise ValueError('Declared input bytes changed during packaging')

    def close(self):
        for handle in reversed(self.handles):
            os.close(handle)


def original_namespace(configuration, owned):
    relative = license_inputs.relative(configuration)
    physical = owned.presentation(relative)
    suffix = Path(relative).parts
    if physical.parts[-len(suffix):] != suffix:
        raise ValueError('Generated configuration has no exact declared namespace suffix')
    root = physical
    for _ in suffix:
        root = root.parent
    return root


def declared_tree(value, prefix, namespace, owned, *, allow_empty=False):
    relative = license_inputs.relative(value['input'])
    original = namespace / relative
    presentation = owned.presentation(relative)
    if owned.presentation(original) != original:
        raise ValueError('Original declared TreeArtifact is redirected')
    # The strict walker reads only the genuine producer tree; original member
    # aliases remain forbidden. Sandbox carriers are compared to those Files.
    entries = owned.tree({'input': str(original), 'label': value['label']}, prefix, allow_empty=allow_empty)
    expected = {name[len(prefix) + 1:] for name in entries}
    expected_directories = {''}
    for name in expected:
        expected_directories.update(str(parent) for parent in Path(name).parents if str(parent) != '.')
    observed, directories = set(), set()
    def walk(directory, parts):
        handle = owned.directory(directory)
        names = sorted(os.listdir(handle))
        owned.directories[directory] = (handle, identity(os.fstat(handle)), names)
        directories.add('/'.join(parts))
        for name in names:
            member = '/'.join([*parts, name])
            current = directory / name
            info = os.stat(name, dir_fd=handle, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o7000:
                walk(current, [*parts, name])
            elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                if member not in expected or owned.presentation(current) != original / member:
                    raise ValueError('TreeArtifact carrier redirects a declared producer member')
                observed.add(member)
            else:
                raise ValueError('TreeArtifact presentation contains a special member')
    walk(presentation, [])
    if observed != expected or directories != expected_directories:
        raise ValueError('TreeArtifact presentation differs from exact producer membership')
    return entries


def reconcile_outputs(compiler, artifacts, role, standalone_name=None):
    outputs = compiler.get('artifacts')
    if not isinstance(outputs, dict) or not outputs:
        raise ValueError('Compiler inventory lacks retained output facts')
    if standalone_name is not None:
        if len(artifacts) != 1:
            raise ValueError('Standalone compiler requires its exact one output')
        actual = {standalone_name: artifacts[0]}
    else:
        actual = {item['path'][len(role) + 1:]: item for item in artifacts}
    if set(outputs) != set(actual):
        raise ValueError('Compiler output membership differs from actual artifact')
    for name, fact in outputs.items():
        if license_inputs.relative(name) != name or not isinstance(fact, dict) or set(fact) != {'bytes', 'sha256'}:
            raise ValueError('Invalid retained compiler output fact')
        size, sha = fact.get('bytes'), fact.get('sha256')
        if type(size) is not int or size < 0 or not isinstance(sha, str) or len(sha) != 64 or any(character not in '0123456789abcdef' for character in sha):
            raise ValueError('Invalid retained compiler output byte identity')
        if size != actual[name]['size'] or sha != actual[name]['sha256']:
            raise ValueError('Compiler output bytes differ from actual artifact')



def validate_frontend(entries, build_id, inputs):
    if not isinstance(build_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', build_id):
        raise ValueError('Deployment requires its declared canonical frontend UUID')
    originals = {name for name in entries if name.startswith('web/') and not name.endswith('.br')}
    compressed = {name for name in entries if name.startswith('web/') and name.endswith('.br')}
    if not {'web/index.html', 'web/merkur-build.json'} <= originals or compressed != {name + '.br' for name in originals}:
        raise ValueError('Deployment requires its complete original and Brotli frontend inventory')
    marker = inputs.read(entries['web/merkur-build.json'][1])
    if marker != pack.canonical({'buildId': build_id}):
        raise ValueError('Frontend bytes differ from declared deployment identity')


def validate_service(entries, build_id, inputs):
    if not isinstance(build_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', build_id):
        raise ValueError('Deployment requires its declared canonical frontend UUID')
    migrations = {name for name in entries if name.startswith('migrations/')}
    if migrations != {'migrations/' + name for name in MIGRATIONS}:
        raise ValueError('Deployment requires the exact bundled migration inventory')
    validate_frontend(entries, build_id, inputs)
    header = inputs.read(entries['server/server'][1], 64)
    if len(header) < 64 or header[:7] != b'\x7fELF\x02\x01\x01' or struct.unpack_from('<HHI', header, 16) not in ((2, 62, 1), (3, 62, 1)) or struct.unpack_from('<H', header, 52)[0] != 64:
        raise ValueError('Deployment server must be the native Linux x86_64 ELF64 producer')


def produce(value, archive, manifest):
    if not isinstance(value, dict) or set(value) != {'server', 'server_context', 'migrations', 'web', 'build_id', 'license_evidence', 'notices'}:
        raise ValueError('Exact unsigned deployment action inputs required')
    evidence = value['license_evidence']
    if not isinstance(evidence, list) or not evidence:
        raise ValueError('Deployment requires explicit nonempty declared license evidence')
    inputs = DeclaredInputs()
    try:
        server = descriptor(value['server'])
        pinned, size, _ = inputs.file(inputs.presentation(server['input']), executable=True)
        entries = {'server/server': ({'mode': '0555', 'label': server['label']}, pinned, size)}
        entries.update(inputs.tree(value['migrations'], 'migrations'))
        entries.update(inputs.tree(value['web'], 'web'))
        validate_service(entries, value['build_id'], inputs)
        context = descriptor(value['server_context'])
        captured, context_size, context_digest = inputs.file(inputs.presentation(context['input']))
        settings = pack.load_json(inputs.read(captured))
        if context['label'] != server['label'] or not isinstance(settings, dict) or settings.get('producer') != server['label'] or settings.get('frontend_build_id') != value['build_id']:
            raise ValueError('Server compiler context differs from the configured deployment')
        source_evidence = []
        labels = set()
        origins = set()
        for item in evidence:
            item = descriptor(item)
            physical = inputs.presentation(item['input'])
            if item['label'] in labels or physical in origins:
                raise ValueError('Deployment repeats source license evidence')
            labels.add(item['label'])
            origins.add(physical)
            content, length, digest = inputs.file(physical)
            if not inputs.read(content).decode('utf8').strip():
                raise ValueError('Empty deployment license evidence')
            source_evidence.append({'label': item['label'], 'size': length, 'sha256': digest})
        inputs.verify()
        notice_spec = importlib.util.spec_from_file_location('deployment_notices', Path(__file__).with_name('deployment-notices.py'))
        notices = importlib.util.module_from_spec(notice_spec)
        notice_spec.loader.exec_module(notices)
        notice_binding = notices.bind(value['notices'], entries, value['build_id'], context_digest, inputs)
        fields = {
            'build_id': value['build_id'],
            'source_evidence': sorted(source_evidence, key=lambda item: item['label']),
            'server_context': {'label': context['label'], 'size': context_size, 'sha256': context_digest},
            'notices': notice_binding,
        }
        pack.stream_archive(entries, archive, manifest, fields, inputs.verify)
    finally:
        inputs.close()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('Expected declared deployment specification, archive and member inventory')
    produce(pack.load_json(Path(sys.argv[1]).read_bytes()), sys.argv[2], sys.argv[3])
