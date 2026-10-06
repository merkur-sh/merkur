"""Assemble exact original Rust nightly component payloads for Bun's native build.

This grants original SDK payload custody only. Dynamic-loader qualification and
selected linked-runtime source attribution belong to their actual consumers.
"""
import io
import json
import os
from pathlib import Path
import sys
import stat
import tarfile


TARGETS = {'aarch64-apple-darwin', 'x86_64-apple-darwin',
           'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'}


def collect(specification, pins, custody, deployment, owned):
    if set(specification) != {'target', 'archives'} or specification['target'] not in TARGETS:
        raise ValueError('Exact original Bun nightly native target required')
    target = specification['target']
    archives = specification['archives']
    if set(archives) != {'rustc', 'cargo', 'rust-std', 'rust-src'}:
        raise ValueError('Original Bun nightly SDK requires all four original components')
    relative = deployment.license_inputs.relative
    payload, modes, components = {}, {}, []
    for name, source in sorted(archives.items()):
        candidates = pins['nightly']['components'][name]['targets']
        pin = candidates['*'] if name == 'rust-src' else candidates[target]
        data, fact = custody.captured(source, owned)
        if fact['sha256'] != pin['sha256']:
            raise ValueError('Nightly component differs from original pinned publisher archive')
        prefix = pin['url'].rsplit('/', 1)[1].removesuffix('.tar.xz')
        members, directories = {}, set()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            seen = set()
            for member in archive:
                if member.name.rstrip('/') == prefix and member.isdir():
                    continue
                if not member.name.startswith(prefix + '/'):
                    raise ValueError('Original nightly component has foreign archive prefix')
                logical = relative(member.name[len(prefix) + 1:].rstrip('/'))
                if logical in seen:
                    raise ValueError('Original nightly component repeats a member')
                seen.add(logical)
                if member.isdir():
                    directories.add(logical)
                elif member.isfile() and not member.mode & 0o7000:
                    members[logical] = (archive.extractfile(member).read(), member.mode & 0o777)
                else:
                    raise ValueError('Original nightly component has unsupported payload kind')
        component = 'rust-std-' + target if name == 'rust-std' else name
        if members['components'][0].decode().splitlines() != [component]:
            raise ValueError('Original nightly installer component identity differs')
        manifest, _ = members[component + '/manifest.in']
        selected = set()
        for entry in manifest.decode('utf8').splitlines():
            kind, separator, destination = entry.partition(':')
            if not separator or kind not in {'file', 'dir'}:
                raise ValueError('Original nightly installer manifest member is unsupported')
            destination = relative(destination)
            logical = component + '/' + destination
            if kind == 'file':
                if logical not in members:
                    raise ValueError('Original nightly installer File is absent')
                candidates = [logical]
            else:
                if logical not in directories:
                    raise ValueError('Original nightly installer directory is absent')
                candidates = [path for path in members if path.startswith(logical + '/')]
            for path in candidates:
                if path in selected:
                    raise ValueError('Original nightly installer payload repeats a File')
                selected.add(path)
                output = path[len(component) + 1:]
                if output in payload:
                    raise ValueError('Original nightly components overlap a SDK File')
                payload[output], modes[output] = members[path]
        available = {path for path in members if path.startswith(component + '/')
                     and path != component + '/manifest.in'}
        if selected != available:
            raise ValueError('Original nightly installer manifest omits payload Files')
        originals = {key: value for key, value in members.items()
                     if '/' not in key and key in {'LICENSE-APACHE', 'LICENSE-MIT', 'COPYRIGHT'}}
        for license, (body, _) in originals.items():
            if not body.decode('utf8').strip():
                raise ValueError('Original nightly publisher license is empty')
            output = '.originals/' + component + '/' + license
            payload[output], modes[output] = body, 0o644
        output = '.originals/' + component + '/manifest.in'
        payload[output], modes[output] = manifest, 0o644
        components.append({'component': component, 'archive': fact, 'files': sorted(selected),
                           'manifest_sha256': custody.digest(manifest),
                           'licenses': sorted(originals)})
    for binary in ['bin/rustc', 'bin/cargo', 'lib/rustlib/' + target + '/bin/rust-lld']:
        if binary not in payload or not modes[binary] & 0o111:
            raise ValueError('Original Bun nightly SDK is missing a required executable')
    if 'lib/rustlib/src/rust/library/Cargo.toml' not in payload:
        raise ValueError('Original Bun nightly SDK is missing original standard-library source')
    result = {'kind': 'original-bun-nightly-sdk-payload', 'channel': pins['nightly']['channel'],
              'target': target, 'components': components,
              'files': [{'path': name, 'mode': modes[name], 'size': len(body),
                         'sha256': custody.digest(body)} for name, body in sorted(payload.items())]}
    owned.verify()
    return result, payload


def assemble(specification, pins, output, custody, deployment, output_tree, builder):
    owned = deployment.DeclaredInputs()
    tree = None
    try:
        result, payload = collect(specification, pins, custody, deployment, owned)
        tree = output_tree.OutputTree(output)
        builder.write_sources(tree, payload, output_tree)
        identities = {(parent, name): expected for parent, name, expected in tree.files}
        for item in result['files']:
            parts = Path(item['path']).parts
            parent = tree.directories[parts[:-1]][0]
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                if output_tree.identity(os.fstat(descriptor)) != identities[(parent, parts[-1])]:
                    raise ValueError('Original nightly SDK File ownership changed before mode restoration')
                os.fchmod(descriptor, 0o555 if item['mode'] & 0o111 else 0o444)
            finally:
                os.close(descriptor)
        manifest = deployment.pack.canonical(result)
        tree.write('sdk-payload.json', manifest)
        owned.verify()
        tree.verify()
        builder.verify_files(tree, {**payload, 'sdk-payload.json': manifest}, output_tree)
        for item in result['files']:
            parts = Path(item['path']).parts
            parent = tree.directories[parts[:-1]][0]
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                information = os.fstat(descriptor)
                current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                expected_mode = 0o555 if item['mode'] & 0o111 else 0o444
                if (output_tree.identity(information) != identities[(parent, parts[-1])] or
                    output_tree.identity(current) != identities[(parent, parts[-1])] or
                    stat.S_IMODE(information.st_mode) != expected_mode or
                    stat.S_IMODE(current.st_mode) != expected_mode):
                    raise ValueError('Original nightly SDK File executable mode changed before admission')
            finally:
                os.close(descriptor)
        return [item['path'] for item in result['files']] + ['sdk-payload.json']
    except BaseException as primary:
        if tree is not None:
            try:
                tree.cleanup()
            except BaseException as cleanup:
                raise BaseExceptionGroup('Original nightly SDK assembly and retirement failed',
                                         [primary, cleanup])
        raise
    finally:
        if tree is not None:
            tree.close()
        owned.close()


if __name__ == '__main__':
    import importlib.util

    def load(name, path):
        specification = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module

    spec, pins, output, custody, deployment, output_tree, builder = sys.argv[1:]
    assemble(json.loads(Path(spec).read_bytes()), json.loads(Path(pins).read_bytes()), output,
             load('original_custody', custody), load('declared_deployment', deployment),
             load('declared_output_tree', output_tree), load('original_builder', builder))
