"""Hash complete declared package license inputs; no resolver or compiler invocation."""
import hashlib
import os
from pathlib import Path
import re
import stat


def relative(value):
    if not isinstance(value, str) or not value or '\\' in value:
        raise ValueError('Invalid license input path')
    if any(part in ('', '.', '..') for part in value.split('/')) or value.startswith('/'):
        raise ValueError('Unsafe license input path')
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError('Unrepresentable license input path')
    return value


def read_regular(root, name, require_text=True):
    """Read one file without following any package-relative alias."""
    relative(name)
    path = root
    parts = name.split('/')
    directories = []
    fd = None
    try:
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
        parent = os.open(root, flags)
        directories.append((root, parent))
        for part in parts[:-1]:
            path /= part
            parent = os.open(part, flags, dir_fd=parent)
            directories.append((path, parent))
        path /= parts[-1]
        before = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o7000:
            raise ValueError('License is not a safe regular file')
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('License identity changed before reading')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            content = stream.read()
        after = os.fstat(fd)
        current = path.lstat()
        def identity(value):
            return (value.st_dev, value.st_ino, value.st_size, value.st_mode,
                    value.st_mtime_ns, value.st_ctime_ns)
        if identity(opened) != identity(after) or identity(after) != identity(current):
            raise ValueError('License identity changed during reading')
        for directory, handle in directories:
            actual = directory.lstat()
            pinned = os.fstat(handle)
            if not stat.S_ISDIR(actual.st_mode) or (actual.st_dev, actual.st_ino) != (pinned.st_dev, pinned.st_ino):
                raise ValueError('License parent identity changed during reading')
        if require_text and (not content or not content.decode('utf8').strip()):
            raise ValueError('Empty license input')
        return content
    finally:
        if fd is not None:
            os.close(fd)
        for _, handle in reversed(directories):
            os.close(handle)


def collect(root, license_file=None):
    """Record every root-level published notice and the exact declared license_file."""
    root = Path(root)
    logical_root = root
    original = root.lstat()
    if not stat.S_ISDIR(original.st_mode):
        raise ValueError('Package source is not a regular directory')
    root = root.resolve(strict=True)
    resolved = root.lstat()
    if (original.st_dev, original.st_ino) != (resolved.st_dev, resolved.st_ino):
        raise ValueError('Package source identity changed during admission')
    def identity(path):
        value = path.lstat()
        return (value.st_dev, value.st_ino, value.st_size, value.st_mode,
                value.st_mtime_ns, value.st_ctime_ns)
    def membership():
        names = set()
        for entry in root.iterdir():
            if re.match(r'^(licen[cs]e|copying|notice|unlicense)', entry.name, re.I):
                # A matching alias, directory or unreadable file is a failure, not an omission.
                names.add(relative(entry.name))
        if license_file is not None:
            names.add(relative(license_file))
        return sorted(names)
    names = membership()
    if not names:
        raise ValueError('Declared package has no published license text')
    before = {name: identity(root / name) for name in names}
    texts = []
    for name in sorted(names):
        content = read_regular(root, name)
        texts.append({'path': name, 'size': len(content),
                      'sha256': hashlib.sha256(content).hexdigest(),
                      'text': content.decode('utf8')})
    if membership() != names:
        raise ValueError('Published license inventory changed during collection')
    for item in texts:
        name = item['path']
        # One complete validation pass, never a retry or an assumed unchanged retained copy.
        content = read_regular(root, name)
        if before[name] != identity(root / name) or content.decode('utf8') != item['text']:
            raise ValueError('Published license bytes changed during collection')
    if membership() != names or any(before[name] != identity(root / name) for name in names):
        raise ValueError('Published license inventory changed during final validation')
    current = logical_root.lstat()
    if not stat.S_ISDIR(current.st_mode) or (original.st_dev, original.st_ino) != (current.st_dev, current.st_ino):
        raise ValueError('Package source identity changed during collection')
    return texts
