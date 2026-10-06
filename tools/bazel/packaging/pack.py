"""Canonical unsigned ustar/gzip producer; no discovery, compilation or signing."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def load_json(content):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON field')
            result[key] = value
        return result
    return json.loads(content, object_pairs_hook=unique)


def destination(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', value):
        raise ValueError('package path must be a portable relative file path')
    if any(part in ('.', '..') for part in value.split('/')) or len(value.encode()) > 100:
        raise ValueError('package path cannot traverse or require extended tar metadata')
    return value


class HashedReader:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.sha512()

    def read(self, count):
        content = self.source.read(count)
        self.digest.update(content)
        return content


def validate(spec):
    if not isinstance(spec, dict) or set(spec) != {'files', 'expected', 'licenses'}:
        raise ValueError('unsigned package requires an exact file and license contract')
    if not isinstance(spec['files'], list) or not spec['files']:
        raise ValueError('empty unsigned package')
    expected = spec['expected']
    licenses = spec['licenses']
    if not isinstance(expected, list) or not isinstance(licenses, list) or not licenses:
        raise ValueError('expected file inventory and nonempty license inventory required')
    if any(not isinstance(item, str) for item in expected + licenses):
        raise ValueError('inventory paths must be strings')
    if len(set(expected)) != len(expected) or len(set(licenses)) != len(licenses):
        raise ValueError('duplicate inventory entry')
    entries = {}
    for item in spec['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'input', 'label', 'mode'}:
            raise ValueError('malformed declared file')
        name = destination(item['path'])
        if name in entries:
            raise ValueError('duplicate archive file')
        if item['mode'] not in ('0444', '0555') or not isinstance(item['input'], str) or not isinstance(item['label'], str) or not re.fullmatch(r'(?:@@[^/]*|@[^/]+)?//[^\s:]*:[^\s:]+', item['label']):
            raise ValueError('invalid input identity or normalized permission')
        source = Path(item['input'])
        info = source.stat()  # Bazel may represent a declared input with an execroot symlink.
        if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
            raise ValueError('declared package input must be a nonempty regular file')
        if info.st_mode & 0o7000 or (item['mode'] == '0555' and not info.st_mode & 0o111):
            raise ValueError('unsafe or missing input executable permissions')
        entries[name] = (item, source, info.st_size)
    if set(entries) != set(expected) or not set(licenses) <= set(entries):
        raise ValueError('missing or extra artifact or license')
    for name in entries:
        if any(other.startswith(name + '/') for other in entries):
            raise ValueError('file conflicts with package directory')
    if any(entries[name][0]['mode'] != '0444' for name in licenses):
        raise ValueError('licenses must be regular nonexecutables')
    return entries


class ArchiveOutputs:
    """Pin both output parents before streaming; cleanup only our recorded inodes."""
    def __init__(self, archive, manifest):
        self.handles, self.parents, self.owned = [], [], []
        self.paths = [Path(archive).absolute(), Path(manifest).absolute()]
        if self.paths[0] == self.paths[1]:
            raise ValueError('Archive and inventory require distinct outputs')

    def __enter__(self):
        try:
            for path in self.paths:
                physical = path.parent.resolve(strict=True)
                handle = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                self.handles.append(handle)
                chain = []
                parent = Path('/')
                chain.append((parent, handle))
                for part in physical.parts[1:]:
                    handle = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=handle)
                    self.handles.append(handle)
                    parent /= part
                    chain.append((parent, handle))
                self.parents.append((path, physical, handle, chain))
            self.verify()
            return self
        except BaseException:
            self.close()
            raise

    def verify(self):
        for path, physical, _, chain in self.parents:
            if path.parent.resolve(strict=True) != physical:
                raise ValueError('Archive output parent ownership changed')
            for directory, handle in chain:
                current, pinned = directory.lstat(), os.fstat(handle)
                if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (pinned.st_dev, pinned.st_ino):
                    raise ValueError('Archive output ancestor ownership changed')
        for parent, name, device, inode, descriptor in self.owned:
            current, pinned = os.stat(name, dir_fd=parent, follow_symlinks=False), os.fstat(descriptor)
            if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (device, inode) or (pinned.st_dev, pinned.st_ino) != (device, inode):
                raise ValueError('Archive output file ownership changed')

    def open(self, index):
        self.verify()
        path, _, parent, _ = self.parents[index]
        descriptor = os.open(path.name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        value = os.fstat(descriptor)
        self.handles.append(descriptor)
        self.owned.append((parent, path.name, value.st_dev, value.st_ino, descriptor))
        return os.fdopen(descriptor, 'w+b', closefd=False)

    def close(self):
        for handle in reversed(self.handles):
            os.close(handle)
        self.handles = []

    def __exit__(self, kind, primary, trace):
        failures = []
        if primary is not None:
            for parent, name, device, inode, _ in reversed(self.owned):
                try:
                    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) != (device, inode):
                        raise ValueError('Archive output ownership changed during cleanup')
                    os.unlink(name, dir_fd=parent)
                except BaseException as error:
                    failures.append(error)
        self.close()
        if failures:
            raise BaseExceptionGroup('Archive publication and cleanup failed', [primary, *failures])


def stream_archive(entries, archive, manifest, fields, verify_inputs):
    """One canonical stream for embedded-license and exact deployment layouts."""
    inventory = []
    with ArchiveOutputs(archive, manifest) as outputs:
        with outputs.open(0) as output:
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, compresslevel=9, mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.USTAR_FORMAT) as package:
                    for name, (item, source, size) in sorted(entries.items()):
                        header = tarfile.TarInfo(name)
                        header.size = size
                        header.mode = int(item['mode'], 8)
                        header.uid = header.gid = header.mtime = 0
                        header.uname = header.gname = ''
                        with source.open('rb') as content:
                            hashed = HashedReader(content)
                            package.addfile(header, hashed)
                            digest = hashed.digest.hexdigest()
                        inventory.append({'path': name, 'mode': item['mode'], 'size': size,
                                          'sha512': digest, 'label': item['label']})
            output.flush()
            output.seek(0)
            archive_hash = hashlib.file_digest(output, 'sha512').hexdigest()
            archive_size = os.fstat(output.fileno()).st_size
        verify_inputs()
        outputs.verify()
        with outputs.open(1) as output:
            output.write(canonical({'archive': {'sha512': archive_hash, 'size': archive_size},
                                    'files': inventory, **fields}))
        verify_inputs()
        outputs.verify()


def produce(spec, archive, manifest):
    entries = validate(spec)
    stream_archive(entries, archive, manifest, {'licenses': sorted(spec['licenses'])}, lambda: validate(spec))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('expected declared specification, archive and signing-input manifest')
    produce(load_json(Path(sys.argv[1]).read_bytes()), sys.argv[2], sys.argv[3])
