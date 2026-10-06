"""Original Cargo directory sources, bound to Bun's original Cargo.lock bytes."""
import io
import json
from pathlib import Path
import sys
import tarfile
import tomllib


def collect(specification, pins, source_pins, custody, deployment, owned):
    if set(specification) != {'source_archive', 'archives'}:
        raise ValueError('Exact original Bun registry acquisition inputs required')
    source, _ = custody.captured(specification['source_archive'], owned)
    members, _ = custody.source_members(source, source_pins, deployment.license_inputs.relative)
    lock = members['Cargo.lock']
    if custody.digest(lock) != pins['cargo_lock_sha256'] or source_pins['commit'] != pins['bun_commit']:
        raise ValueError('Registry directory sources differ from original Bun Cargo.lock')
    expected = []
    for package in tomllib.loads(lock.decode())['package']:
        if 'source' not in package:
            continue
        if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index':
            raise ValueError('Original Bun Cargo.lock requires unsupported source acquisition')
        name, version = package['name'], package['version']
        expected.append({'name': name, 'version': version, 'sha256': package['checksum'],
                         'url': 'https://static.crates.io/crates/' + name + '/' + name + '-' + version + '.crate'})
    if sorted(expected, key=lambda p: (p['name'], p['version'])) != pins['packages']:
        raise ValueError('Registry archive pins differ from original Cargo.lock membership')
    expected_keys = {p['name'] + '@' + p['version'] for p in pins['packages']}
    if set(specification['archives']) != expected_keys:
        raise ValueError('Original Bun registry archive closure is incomplete or foreign')
    output = {}
    relative = deployment.license_inputs.relative
    for package in pins['packages']:
        identity = package['name'] + '@' + package['version']
        data, fact = custody.captured(specification['archives'][identity], owned)
        if fact['sha256'] != package['sha256']:
            raise ValueError('Original Cargo registry archive checksum differs')
        prefix = package['name'] + '-' + package['version']
        files, seen = {}, set()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive:
                if member.name.rstrip('/') == prefix and member.isdir():
                    continue
                if not member.name.startswith(prefix + '/'):
                    raise ValueError('Original registry archive has foreign package prefix')
                name = relative(member.name[len(prefix) + 1:].rstrip('/'))
                if name in seen:
                    raise ValueError('Original registry archive repeats a package member')
                seen.add(name)
                if member.isdir():
                    continue
                if not member.isfile() or member.mode & 0o7000:
                    raise ValueError('Original registry archive has unsupported member kind')
                files[name] = archive.extractfile(member).read()
        manifest = tomllib.loads(files['Cargo.toml'].decode())['package']
        if manifest['name'] != package['name'] or manifest['version'] != package['version']:
            raise ValueError('Original registry manifest differs from locked package identity')
        if '.cargo-checksum.json' in files:
            raise ValueError('Original registry archive overlaps Cargo directory-source checksums')
        checksums = {'files': {name: custody.digest(body) for name, body in sorted(files.items())},
                     'package': package['sha256']}
        # This is Cargo's required directory-source format, not another receipt.
        files['.cargo-checksum.json'] = deployment.pack.canonical(checksums)
        for name, body in files.items():
            output[prefix + '/' + name] = body
    owned.verify()
    return output


def prepare(specification, pins, source_pins, destination, custody, deployment, output_tree, builder):
    owned = deployment.DeclaredInputs()
    tree = None
    try:
        members = collect(specification, pins, source_pins, custody, deployment, owned)
        tree = output_tree.OutputTree(destination)
        builder.write_sources(tree, members, output_tree)
        owned.verify()
        tree.verify()
        builder.verify_files(tree, members, output_tree)
    except BaseException as primary:
        if tree is not None:
            try:
                tree.cleanup()
            except BaseException as cleanup:
                raise BaseExceptionGroup('Original registry source publication and retirement failed',
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

    spec, pins, source_pins, destination, custody, deployment, output_tree, builder = sys.argv[1:]
    prepare(json.loads(Path(spec).read_bytes()), json.loads(Path(pins).read_bytes()),
            json.loads(Path(source_pins).read_bytes()), destination,
            load('original_custody', custody), load('declared_deployment', deployment),
            load('declared_output_tree', output_tree), load('original_builder', builder))
