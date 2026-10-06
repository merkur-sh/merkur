#!/usr/bin/env python3
"""Typecheck real Linux worker sources with original matching target std Files."""

import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import tempfile


COMMIT = '8bab26f4f68e0e26f0bb7960be334d5b520ea452'
TARGETS = ('aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu')


def load_pins(path):
    spec = importlib.util.spec_from_file_location('original_std_pins', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    # These paths are individually declared Files, including engine carriers.
    # No Tree member discovery or topology ownership is inferred here.
    with Path(path).open('rb') as stream:
        before = os.fstat(stream.fileno())
        data = stream.read()
        after = os.fstat(stream.fileno())
    identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    if not stat.S_ISREG(before.st_mode) or identity(before) != identity(after):
        raise ValueError('Declared typecheck File changed or is not regular')
    return data


def std_members(data, target, expected_digest, version):
    if target not in TARGETS or digest(data) != expected_digest:
        raise ValueError('Original Linux target std archive identity differs')
    prefix = 'rust-std-' + version + '-' + target + '/rust-std-' + target + '/lib/rustlib/' + target + '/lib/'
    files, seen = {}, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        for member in archive:
            name = member.name
            logical = PurePosixPath(name)
            if str(logical) != name or logical.is_absolute() or '..' in logical.parts or name in seen:
                raise ValueError('Original target std has noncanonical or duplicate members')
            seen.add(name)
            if not member.isdir() and not member.isfile():
                raise ValueError('Original target std contains an alias or special member')
            if not member.isfile() or not name.startswith(prefix):
                continue
            relative = name[len(prefix):]
            if '/' in relative or not relative:
                raise ValueError('Target std library member is not an ordinary library File')
            files[relative] = archive.extractfile(member).read()
    if not any(name.startswith('libstd-') and name.endswith('.rlib') for name in files):
        raise ValueError('Original archive omits matching target standard library')
    return files


def original_compiler(data, host, pins):
    if host != 'aarch64-apple-darwin' or digest(data) != pins.DISTRIBUTIONS[host][1]:
        raise ValueError('Original native compiler archive identity differs')
    name = 'rustc-' + pins.VERSION + '-' + host + '/rustc/bin/rustc'
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        matches = [member for member in archive if member.name == name]
        if len(matches) != 1 or not matches[0].isfile():
            raise ValueError('Original native compiler executable member differs')
        return archive.extractfile(matches[0]).read()


def validate(request):
    keys = {'target', 'execution_host', 'rustc', 'compiler_archive', 'std_archive', 'pins',
            'compiler_files', 'configured_std', 'sources', 'root', 'crate_name', 'crate_type',
            'edition', 'rustc_flags', 'dependencies', 'dependency_files'}
    if not isinstance(request, dict) or set(request) != keys:
        raise ValueError('Exact configured typecheck inputs are mandatory')
    if request['target'] not in TARGETS or request['execution_host'] != 'aarch64-apple-darwin':
        raise ValueError('Typecheck requires the declared native Darwin compiler and Linux target')
    for key in ('compiler_files', 'configured_std', 'sources', 'dependency_files'):
        values = request[key]
        if not isinstance(values, list) or not all(isinstance(v, str) and v for v in values) or len(set(values)) != len(values):
            raise ValueError('Typecheck repeats or omits declared File membership')
    if request['rustc'] not in request['compiler_files'] or request['root'] not in request['sources']:
        raise ValueError('Compiler and crate root must be declared Files')
    if not request['configured_std'] or not request['sources']:
        raise ValueError('Matching configured standard library and sources are mandatory')
    source_root = Path(os.path.abspath(request['root'])).parent
    for path in request['sources']:
        logical = Path(os.path.abspath(path))
        if not logical.is_relative_to(source_root):
            raise ValueError('Worker source File escapes its declared crate namespace')
    if request['crate_type'] not in ('bin', 'lib') or request['edition'] not in ('2018', '2021', '2024'):
        raise ValueError('Unsupported worker typecheck crate declaration')
    if not isinstance(request['crate_name'], str) or not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', request['crate_name']):
        raise ValueError('Invalid declared typecheck crate name')
    if not isinstance(request['dependencies'], dict):
        raise ValueError('Configured CrateInfo dependency map required')
    for name, path in request['dependencies'].items():
        if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name) or path not in request['dependency_files'] or Path(path).suffix not in ('.rmeta', '.rlib'):
            raise ValueError('Dependency lacks genuine declared Rust metadata')
    flags = request['rustc_flags']
    if not isinstance(flags, list) or not all(isinstance(flag, str) and flag for flag in flags):
        raise ValueError('Exact configured root rustc flag tokens required')
    protected = ('--emit', '--target', '--sysroot', '--out-dir', '--extern',
                 '--crate-name', '--crate-type', '--edition', '--remap-path-prefix')
    for index, flag in enumerate(flags):
        if any(character in flag for character in ('$', '@', '\x00', '\n', '\r')) or '/' in flag or '\\' in flag:
            raise ValueError('Root rustc flags require unsupported expansion or File inputs')
        if any(flag == option or flag.startswith(option + '=') for option in protected) or flag.startswith(('-o', '-L')):
            raise ValueError('Root rustc flag conflicts with metadata-only input/output authority')
        cfg = flag[len('--cfg='):] if flag.startswith('--cfg=') else flags[index + 1] if flag == '--cfg' and index + 1 < len(flags) else None
        if cfg is not None and (cfg.startswith('target_') or cfg in ('unix', 'windows', 'test')):
            raise ValueError('Root cfg flag cannot replace genuine target or test configuration')


def typecheck(request, output):
    validate(request)
    pins = load_pins(request['pins'])
    if pins.VERSION != '1.97.1':
        raise ValueError('Original pinned Rust release differs')
    captured = {path: regular(path) for path in set(request['sources'] + request['dependency_files'] + request['configured_std'])}
    rustc_data = regular(request['rustc'])
    compiler_data = regular(request['compiler_archive'])
    std_data = regular(request['std_archive'])
    if rustc_data != original_compiler(compiler_data, request['execution_host'], pins):
        raise ValueError('Declared rustc differs from original pinned compiler bytes')
    libraries = std_members(std_data, request['target'], pins.DISTRIBUTIONS[request['target']][0], pins.VERSION)
    configured = {}
    for path in request['configured_std']:
        name = Path(path).name
        if name in configured or name not in libraries or captured[path] != libraries[name]:
            raise ValueError('Configured target std differs from its original archive')
        configured[name] = captured[path]
    if set(configured) != set(libraries):
        raise ValueError('Configured target std library inventory is incomplete')
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ValueError('Typecheck output must be fresh')
    with tempfile.TemporaryDirectory(prefix='worker-linux-typecheck-') as temporary:
        private = Path(temporary)
        env = {'PATH': '/__no_ambient_path__', 'HOME': str(private), 'TMPDIR': str(private), 'LANG': 'C', 'LC_ALL': 'C'}
        identity = subprocess.run([request['rustc'], '-vV'], env=env, check=True, capture_output=True, text=True).stdout
        facts = dict(line.split(': ', 1) for line in identity.splitlines() if ': ' in line)
        if facts.get('release') != pins.VERSION or facts.get('commit-hash') != COMMIT or facts.get('host') != request['execution_host']:
            raise ValueError('Native compiler release, commit or host differs')
        lib = private / 'sysroot/lib/rustlib' / request['target'] / 'lib'
        lib.mkdir(parents=True)
        for name, data in libraries.items():
            (lib / name).write_bytes(data)
        # Rustc sees only declared source Files, not ambient siblings beside the
        # original crate root. Module-relative paths retain their exact spelling.
        source_root = Path(os.path.abspath(request['root'])).parent
        for path in request['sources']:
            selected = private / 'source' / Path(os.path.abspath(path)).relative_to(source_root)
            selected.parent.mkdir(parents=True, exist_ok=True)
            selected.write_bytes(captured[path])
        root = private / 'source' / Path(request['root']).name
        args = [request['rustc'], str(root)] + request['rustc_flags'] + ['--crate-name', request['crate_name'],
                '--crate-type', request['crate_type'], '--edition', request['edition'],
                '--target', request['target'], '--sysroot', str(private / 'sysroot'),
                '--remap-path-prefix', str(private / 'source') + '=' + str(source_root),
                '--emit=metadata', '-o', str(output)]
        for name, path in sorted(request['dependencies'].items()):
            args += ['--extern', name + '=' + path]
        for directory in sorted({str(Path(path).parent) for path in request['dependency_files']}):
            args += ['-L', 'dependency=' + directory]
        try:
            subprocess.run(args, env=env, check=True)
            if not regular(output):
                raise ValueError('Rustc omitted genuine Linux metadata output')
            if any(regular(path) != data for path, data in captured.items()) or regular(request['rustc']) != rustc_data or regular(request['std_archive']) != std_data or regular(request['compiler_archive']) != compiler_data:
                raise ValueError('Declared typecheck inputs changed during compilation')
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    return {'target': request['target'], 'compiler_sha256': digest(rustc_data),
            'std_archive_sha256': digest(std_data), 'metadata_sha256': digest(regular(output)),
            'source_facts': {path: digest(data) for path, data in sorted(captured.items()) if path in request['sources']},
            'linux_executed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(typecheck(json.loads(args.request.read_bytes()), args.output), sort_keys=True))


if __name__ == '__main__':
    main()
