"""Descriptor-anchored publication of one fresh declared directory artifact."""
import os
from pathlib import Path
import stat


def identity(value):
    return value.st_dev, value.st_ino


class OutputTree:
    def __init__(self, path):
        self.path = Path(path).absolute()
        self.handles = []
        self.directories = {}
        self.files = []
        self.parent = None
        self.root = None
        try:
            # Resolve only the engine/caller's parent presentation, then walk the
            # physical path with no-follow directory descriptors before writes.
            parent_path = self.path.parent.resolve(strict=True)
            parent = self.open_directory('/')
            for part in parent_path.parts[1:]:
                parent = self.open_directory(part, parent)
            self.parent = parent
            try:
                os.mkdir(self.path.name, 0o755, dir_fd=parent)
            except FileExistsError:
                pass
            self.root = self.open_directory(self.path.name, parent)
            if os.listdir(self.root):
                raise FileExistsError('Declared package output is not a fresh empty directory')
            self.directories[()] = (self.root, parent, self.path.name, identity(os.fstat(self.root)))
            self.verify()
        except BaseException:
            self.close()
            raise

    def open_directory(self, name, parent=None):
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.handles.append(descriptor)
        return descriptor

    def verify(self):
        for descriptor, parent, name, expected in self.directories.values():
            actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(actual.st_mode) or identity(actual) != expected or identity(os.fstat(descriptor)) != expected:
                raise ValueError('Declared package output directory ownership changed')
        physical_parent = self.path.parent.resolve(strict=True)
        if identity(physical_parent.stat()) != identity(os.fstat(self.parent)):
            raise ValueError('Declared package output parent ownership changed')

    def write(self, name, data):
        parts = name.split('/')
        parent = self.root
        for index, part in enumerate(parts[:-1], 1):
            key = tuple(parts[:index])
            if key not in self.directories:
                os.mkdir(part, 0o755, dir_fd=parent)
                descriptor = self.open_directory(part, parent)
                self.directories[key] = (descriptor, parent, part, identity(os.fstat(descriptor)))
            parent = self.directories[key][0]
        self.verify()
        descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        self.files.append((parent, parts[-1], identity(os.fstat(descriptor))))
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
        self.verify()

    def cleanup(self):
        errors = []
        for parent, name, expected in reversed(self.files):
            try:
                if identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected:
                    raise ValueError('Package output file ownership changed during cleanup')
                os.unlink(name, dir_fd=parent)
            except BaseException as error:
                errors.append(error)
        for _, parent, name, expected in reversed(list(self.directories.values())):
            try:
                value = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISDIR(value.st_mode) or identity(value) != expected:
                    raise ValueError('Package output directory ownership changed during cleanup')
                os.rmdir(name, dir_fd=parent)
            except BaseException as error:
                errors.append(error)
        if errors:
            raise BaseExceptionGroup('Package output cleanup failed', errors)

    def close(self):
        for descriptor in reversed(self.handles):
            os.close(descriptor)
        self.handles = []
