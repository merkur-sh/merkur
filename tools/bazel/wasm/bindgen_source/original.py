"""The original published CLI package and complete Cargo.lock archive selection."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import tomllib

NAME = 'wasm-bindgen-cli'
VERSION = '0.2.127'
SHA256 = '6123f525ba36df42e57b67027637a78591e712a9f6a025ffd3d74298fa1c3f4c'
REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'
REPOSITORY = 'merkur_wasm_bindgen_original'
REVISION = 'a579ee62b631fd1fa96c7740b52a2952b07c0219'
BINS = {name: 'src/bin/' + name + '.rs' for name in (
    'wasm-bindgen', 'wasm-bindgen-test-runner', 'wasm2es6js')}


def native_binaries(roots):
    expected = {('wasm_bindgen_cli', ('lib',), ('lib',), 'src/lib.rs')}
    expected.update((name, ('bin',), ('bin',), path) for name, path in BINS.items())
    actual, binaries = set(), {}
    for unit in roots:
        target = unit['target']
        identity = (target['name'], tuple(target['kind']), tuple(target['crate_types']), target['src_path'])
        if unit['pkg_id'] != 'workspace:.' or unit['mode'] != 'build' or identity not in expected or identity in actual:
            raise ValueError('wasm-bindgen CLI original library/binary compiler roots differ')
        if unit['features'] != ['default', 'rustls-tls']:
            raise ValueError('wasm-bindgen CLI original default TLS feature selection differs')
        actual.add(identity)
        if target['kind'] == ['bin']:
            binaries[target['name']] = unit
    if actual != expected:
        raise ValueError('wasm-bindgen CLI original compiler roots are incomplete')
    return binaries


def native_binary(roots):
    # The existing acquisition runner validates one entry point after capturing
    # Cargo's complete root selection. Retain all three original binaries.
    return native_binaries(roots)['wasm-bindgen']


def original(archive):
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError('wasm-bindgen CLI requires the exact original published archive')
    prefix, files = NAME + '-' + VERSION + '/', {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source:
        for member in source.getmembers():
            if not member.isfile() or not member.name.startswith(prefix):
                raise ValueError('Unexpected original wasm-bindgen CLI archive member')
            logical = member.name[len(prefix):]
            path = PurePosixPath(logical)
            if not logical or path.is_absolute() or '..' in path.parts or str(path) != logical or logical in files:
                raise ValueError('Invalid or repeated original wasm-bindgen CLI archive member')
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError('Missing original wasm-bindgen CLI archive File')
            files[logical] = stream.read()
    manifest = tomllib.loads(files['Cargo.toml'].decode())
    if (manifest['package']['name'], manifest['package']['version']) != (NAME, VERSION):
        raise ValueError('Original wasm-bindgen CLI package identity differs')
    if manifest.get('bin') != [{'name': name, 'path': path} for name, path in BINS.items()]:
        raise ValueError('Original wasm-bindgen CLI binary selection differs')
    if manifest['features']['default'] != ['rustls-tls']:
        raise ValueError('Original wasm-bindgen CLI default feature selection differs')
    if any(not files.get(name, b'').strip() for name in ['LICENSE-MIT', 'LICENSE-APACHE']):
        raise ValueError('Original wasm-bindgen CLI publisher license texts are absent')
    if json.loads(files['.cargo_vcs_info.json']) != {'git': {'sha1': REVISION}, 'path_in_vcs': 'crates/cli'}:
        raise ValueError('Original wasm-bindgen CLI publisher revision differs')
    lock, identities, catalog = tomllib.loads(files['Cargo.lock'].decode()), set(), []
    for package in lock['package']:
        if 'source' not in package:
            if (package['name'], package['version']) != (NAME, VERSION):
                raise ValueError('Unexpected wasm-bindgen CLI path dependency')
            continue
        identity, checksum = (package['name'], package['version']), package['checksum']
        if (package['source'] != REGISTRY or identity in identities or len(checksum) != 64
                or any(character not in '0123456789abcdef' for character in checksum)):
            raise ValueError('Invalid original wasm-bindgen CLI locked registry selection')
        identities.add(identity)
        catalog.append({'name': identity[0], 'version': identity[1], 'sha256': checksum})
    return files, sorted(catalog, key=lambda item: (item['name'], item['version']))


def document(archive):
    files, registry = original(archive)
    return {'name': NAME, 'version': VERSION, 'archive_sha256': SHA256, 'publisher_revision': REVISION,
            'archive_url': 'https://static.crates.io/crates/' + NAME + '/' + NAME + '-' + VERSION + '.crate',
            'source_files': {name: {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                             for name, data in sorted(files.items())}, 'registry': registry,
            'lints': tomllib.loads(files['Cargo.toml'].decode())['lints']}


def declarations(value):
    sources = {'@' + REPOSITORY + '//source:' + name: name for name in value['source_files']}
    archives = {'@' + REPOSITORY + '//:archives/' + package['name'] + '-' + package['version'] + '.crate':
                package['name'] + '@' + package['version'] for package in value['registry']}
    return ('# Generated from the original wasm-bindgen CLI archive and Cargo.lock.\n'
            + 'BINDGEN_SOURCE_FILES = ' + json.dumps(sources, indent=4) + '\n'
            + 'BINDGEN_REGISTRY_ARCHIVES = ' + json.dumps(archives, indent=4) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    value = document(args.archive)
    for name, contents in {'original.json': json.dumps(value, indent=2) + '\n',
                           'data.bzl': declarations(value)}.items():
        file = args.directory / name
        if args.check:
            if file.read_text() != contents:
                raise ValueError('Stale wasm-bindgen CLI original declaration: ' + name)
        else:
            file.write_text(contents)


if __name__ == '__main__':
    main()
