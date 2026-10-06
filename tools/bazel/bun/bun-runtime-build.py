"""Materialize the original Bun build input tree; never claim linked-source selection."""
import json
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


def verify_files(tree, members, output_tree):
    """Revalidate the held ordinary Files against original bytes before admission."""
    identities = {(parent, name): expected for parent, name, expected in tree.files}
    for name, body in sorted(members.items()):
        parts = Path(name).parts
        parent = tree.directories[parts[:-1]][0]
        expected = identities[(parent, parts[-1])]
        current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISREG(current.st_mode) or current.st_mode & 0o7000
                or output_tree.identity(current) != expected or current.st_size != len(body)):
            raise ValueError('Original Bun source File identity or bytes changed')
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        with os.fdopen(descriptor, 'rb') as stream:
            before = os.fstat(stream.fileno())
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            after = os.fstat(stream.fileno())
        identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size,
                                  value.st_mtime_ns, value.st_ctime_ns)
        if (identity(before) != identity(current) or identity(before) != identity(after)
                or actual != hashlib.sha256(body).hexdigest()):
            raise ValueError('Original Bun source File identity or bytes changed')


def write_sources(tree, members, output_tree):
    """Publish the complete original source batch with linear anchored checks.

    Each directory is opened once without following links. Each ordinary File
    checks its immediate descriptor-owned parent before creation. Full namespace
    verification surrounds the batch, so renamed ancestors cannot be admitted.
    The existing OutputTree still owns all descriptors and rollback identities.
    """
    directories = {tuple(Path(name).parts[:-1]) for name in members}
    for parts in sorted(directories):
        parent = tree.root
        for length, part in enumerate(parts, 1):
            key = parts[:length]
            if key not in tree.directories:
                os.mkdir(part, 0o755, dir_fd=parent)
                descriptor = tree.open_directory(part, parent)
                tree.directories[key] = (descriptor, parent, part,
                                         output_tree.identity(os.fstat(descriptor)))
            parent = tree.directories[key][0]
    tree.verify()
    for name, body in sorted(members.items()):
        parts = Path(name).parts
        parent, ancestor, entry, expected = tree.directories[parts[:-1]]
        current = os.stat(entry, dir_fd=ancestor, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or output_tree.identity(current) != expected:
            raise ValueError('Original Bun source parent ownership changed')
        descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o644, dir_fd=parent)
        tree.files.append((parent, parts[-1], output_tree.identity(os.fstat(descriptor))))
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(body)
    tree.verify()
    verify_files(tree, members, output_tree)


def prepare(source, pins, destination, custody, deployment, output_tree):
    """One exact original archive, ordinary TreeArtifact Files, literal alias facts.

    Bazel's source tree contains regular Files. A native build restores the
    original aliases and modes in its private writable copy from these facts.
    Available source is deliberately not compiler-selected source.
    """
    owned = deployment.DeclaredInputs()
    tree = None
    try:
        content, archive = custody.captured(source, owned)
        members, facts = custody.source_members(content, pins, deployment.license_inputs.relative)
        if 'source-inputs.json' in members:
            raise ValueError('Original Bun source overlaps its build-input manifest')
        manifest = {'kind': 'original-bun-build-inputs', 'version': pins['version'],
                    'commit': pins['commit'], 'source_archive': archive, 'members': facts}
        tree = output_tree.OutputTree(destination)
        write_sources(tree, members, output_tree)
        owned.verify()
        manifest_bytes = deployment.pack.canonical(manifest)
        tree.write('source-inputs.json', manifest_bytes)
        tree.verify()
        owned.verify()
        verify_files(tree, {**members, 'source-inputs.json': manifest_bytes}, output_tree)
    except BaseException as primary:
        if tree is not None:
            try:
                tree.cleanup()
            except BaseException as cleanup:
                raise BaseExceptionGroup('Original Bun build input preparation and cleanup failed',
                                         [primary, cleanup])
        raise
    finally:
        if tree is not None:
            tree.close()
        owned.close()


def requirements(source, pins, destination, runner, bun, custody, deployment, output_tree):
    """Run only original source-definition functions under the declared Bun.

    Compiler/SDK discovery, package installs and Ninja are intentionally not
    executed by this acquisition action. Native compilation is a distinct action
    whose complete declared tool and offline input namespaces remain mandatory.
    """
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        original = root / 'source'
        prepare(source, pins, original, custody, deployment, output_tree)
        config = root / 'bunfig.toml'
        config.write_bytes(b'')
        output = root / 'requirements.json'
        subprocess.run([str(Path(bun).absolute()), '--no-install', '--no-env-file',
                        '--config=' + str(config), 'run', str(Path(runner).absolute()),
                        str(original), str(output)], check=True, cwd=root,
                       env={'PATH': '', 'HOME': str(root), 'TMPDIR': str(root)})
        result = json.loads(output.read_bytes())
        if result.get('kind') != 'original-bun-source-acquisition-requirements':
            raise ValueError('Original Bun source acquisition engine returned foreign facts')
        result.update({'commit': pins['commit'], 'version': pins['version']})
        with open(destination, 'xb') as stream:
            stream.write(deployment.pack.canonical(result))


if __name__ == '__main__':
    arguments = sys.argv[1:]
    mode = arguments.pop(0) if arguments and arguments[0] == '--requirements' else None
    source, pins, destination, custody, deployment, output_tree = arguments[:6]
    import importlib.util

    def load(name, path):
        specification = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module

    parsed_pins = json.loads(Path(pins).read_bytes())
    modules = [load('original_bun_source_custody', custody),
               load('declared_deployment', deployment), load('declared_output_tree', output_tree)]
    if mode is None:
        if len(arguments) != 6:
            raise ValueError('Exact original source preparation arguments required')
        prepare(source, parsed_pins, destination, *modules)
    else:
        if len(arguments) != 8:
            raise ValueError('Exact declared original source acquisition arguments required')
        requirements(source, parsed_pins, destination, *arguments[6:], *modules)
