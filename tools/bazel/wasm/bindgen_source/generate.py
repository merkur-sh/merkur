"""Emit all original CLI compiler units through the existing native Rust rules."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import io
import tarfile
import tomllib


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


def emit(documents, archive, original, units, lto, edges):
    files, catalog = original.original(archive)
    locks = {(entry['name'], entry['version']): entry['sha256'] for entry in catalog}
    expected = original.document(archive)
    if not documents:
        raise ValueError('Original wasm-bindgen CLI native compiler context is required')
    for filename in documents:
        value = json.loads(filename.read_text())
        if value.get('package') != original.NAME or value.get('original_source') != {
                'name': original.NAME, 'version': original.VERSION, 'archive_sha256': original.SHA256,
                'cargo_lock_sha256': expected['source_files']['Cargo.lock']['sha256']}:
            raise ValueError('CLI context lacks its exact original archive and Cargo.lock')
        if value['inputs'] != {name: fact['sha256'] for name, fact in expected['source_files'].items()}:
            raise ValueError('CLI context source membership differs from its original archive')
        if (value.get('mode') != 'release' or value.get('platform') != 'native'
                or not value.get('contexts') or set(value['contexts']) != set(value['unit_graphs'])
                or set(value['contexts']) - {'aarch64-apple-darwin', 'x86_64-apple-darwin',
                                            'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'}
                or any(set(profiles) != {'release'} for profiles in value['unit_graphs'].values())):
            raise ValueError('CLI producer requires its actual captured native release graph')
    nodes, roots, packages = units.collect(documents)
    for package in packages.values():
        if package['source'] is not None and (package['source'] != original.REGISTRY
                or (package['name'], package['version']) not in locks):
            raise ValueError('Configured CLI package is absent from its original registry lock')
    binaries, bin_units = {}, set()
    for context, identifiers in roots.items():
        selected = original.native_binaries([nodes[identity] for identity in identifiers])
        binaries[context] = {name: next(identity for identity in identifiers if nodes[identity] is unit)
                             for name, unit in selected.items()}
        bin_units.update(binaries[context].values())
    states = lto.effective_lto(nodes, roots)
    result = ['# Generated from the original locked wasm-bindgen CLI compiler contexts.\n',
              '# Context SHA256: ' + ', '.join(sorted(hashlib.sha256(path.read_bytes()).hexdigest()
                                                     for path in documents)) + '\n',
              'load("//tools/bazel/rust:units.bzl", "compiler_unit", "build_script_unit", "build_script_metadata")\n\n',
              'def declare_bindgen_units():\n']
    for identity, unit in sorted(nodes.items()):
        package = packages[unit['pkg_id']]
        own = package['source'] is None
        prefix = '@' + original.REPOSITORY + '//' + ('source' if own else
                 'registry/' + package['name'] + '-' + package['version'])
        deps, macros, aliases, macro_aliases, script, linked = edges.dependencies(unit, nodes, packages)
        metadata = []
        for index, dependency in enumerate(linked):
            name = 'u_' + identity + '__links_' + str(index)
            result.append('    build_script_metadata(name = ' + units.text(name)
                          + ', build_script = ' + units.text(dependency) + ', tags = ["manual"])\n')
            metadata.append(':' + name)
        attrs = {'name': 'u_' + identity, 'crate_name': unit['target']['name'].replace('-', '_'),
                 'crate_root': prefix + ':' + unit['target']['src_path'], 'sources': prefix + ':rust_sources',
                 'compile_data': prefix + ':package_data', 'manifest': prefix + ':Cargo.toml',
                 'edition': unit['target']['edition'], 'version': package['version'],
                 'crate_features': unit['features'], 'deps': deps, 'proc_macro_deps': macros,
                 'aliases': aliases, 'proc_macro_aliases': macro_aliases,
                 'rustc_flags': lto.compiler_profile_flags(unit, states[identity], units)
                     + ['--check-cfg=cfg(docsrs,test)', '--check-cfg=cfg(feature,values('
                        + ','.join(units.text(feature) for feature in sorted(package['features'])) + '))'],
                 'kind': unit['target']['kind'], 'mode': unit['mode'],
                 'platform': unit['platform'] or unit['execution_host'], 'execution_host': unit['execution_host'],
                 'first_party': own, 'lint_owned': own,
                 'cargo_env': {'CARGO_PKG_NAME': package['name'], 'CARGO_PKG_AUTHORS': ':'.join(package.get('authors', [])),
                     'CARGO_PKG_DESCRIPTION': package.get('description') or '',
                     'CARGO_PKG_HOMEPAGE': package.get('homepage') or '',
                     'CARGO_PKG_REPOSITORY': package.get('repository') or '',
                     'CARGO_PKG_LICENSE': package.get('license') or '',
                     'CARGO_PKG_RUST_VERSION': package.get('rust_version') or ''},
                 'rust_flags': unit['rust_flags'], 'emit_cdylib': unit['emit_cdylib'],
                 'crate_types': unit['target']['crate_types'], 'compiler_env': unit.get('compiler_env', {})}
        if unit['mode'] == 'run-custom-build':
            if script is None:
                raise ValueError('Original CLI build-script compiler unit is absent')
            attrs.update(script=script, pkg_name=package['name'], links=package['links'], profile=unit['profile'])
            if metadata:
                attrs.update(build_script_env_files=metadata, build_data=metadata)
            attrs['compiler_env'] = {**attrs['compiler_env'], **units.custom_cfg_env(unit['rust_flags'])}
            if package['name'] == 'wasm-bindgen-shared':
                if package['version'] != original.VERSION:
                    raise ValueError('Declared wasm-bindgen revision requires its original shared package')
                attrs['compiler_env']['MERKUR_WASM_BINDGEN_REVISION'] = expected['publisher_revision']
        elif unit['mode'] != 'build':
            raise ValueError('Unexpected original CLI native release compiler mode')
        if identity in bin_units:
            attrs['native_link_map'] = True
        result.append('    ' + ('build_script_unit' if unit['mode'] == 'run-custom-build' else 'compiler_unit') + '(\n')
        for name, value in attrs.items():
            if value is not None:
                result.append('        ' + name + ' = ' + units.starlark(value) + ',\n')
        result.append('    )\n')
    constraints = {'aarch64-apple-darwin': ['@platforms//os:macos', '@platforms//cpu:aarch64'],
        'x86_64-apple-darwin': ['@platforms//os:macos', '@platforms//cpu:x86_64'],
        'aarch64-unknown-linux-gnu': ['@platforms//os:linux', '@platforms//cpu:aarch64'],
        'x86_64-unknown-linux-gnu': ['@platforms//os:linux', '@platforms//cpu:x86_64']}
    choices = {name: {} for name in original.BINS}
    for context, selected in sorted(binaries.items()):
        host = context.rsplit('/', 1)[1]
        setting = 'host_' + units.identifier(host)
        result.append('    native.config_setting(name = ' + units.text(setting)
                      + ', constraint_values = ' + units.starlark(constraints[host]) + ')\n')
        for name, identity in selected.items():
            choices[name][':' + setting] = ':u_' + identity
    for name, hosts in choices.items():
        result.append('    native.alias(name = ' + units.text(name.replace('-', '_'))
                      + ', actual = select(' + units.starlark(hosts)
                      + '), visibility = ["//visibility:public"])\n')
    return ''.join(result)


def attribution(documents, archive, registry, original, units, publisher_catalog):
    """Use the same captured root closure and original published package manifests."""
    files, catalog = original.original(archive)
    locked = {(entry['name'], entry['version']): entry['sha256'] for entry in catalog}
    nodes, roots, packages = units.collect(documents)
    publishers = json.loads(publisher_catalog.read_text())
    records = {}
    for identity, package in packages.items():
        if package['source'] is None:
            if identity != 'workspace:.' or (package['name'], package['version']) != (original.NAME, original.VERSION):
                raise ValueError('Original CLI source has an unexpected authored package')
            manifest, checksum = files['Cargo.toml'], original.SHA256
        else:
            key = (package['name'], package['version'])
            checksum = locked[key]
            data = (registry / (key[0] + '-' + key[1] + '.crate')).read_bytes()
            if hashlib.sha256(data).hexdigest() != checksum:
                raise ValueError('CLI notice source differs from its original locked archive')
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as source:
                expected = key[0] + '-' + key[1] + '/Cargo.toml'
                matches = [member for member in source if member.name == expected]
                if len(matches) != 1 or not matches[0].isfile():
                    raise ValueError('Original locked CLI source lacks its normalized manifest File')
                stream = source.extractfile(matches[0])
                if stream is None:
                    raise ValueError('Original locked CLI manifest File is absent')
                manifest = stream.read()
        values = tomllib.loads(manifest.decode())['package']
        for field in ['name', 'version', 'license', 'repository']:
            if values.get(field) != package.get(field):
                raise ValueError('CLI compiler and original notice package identity differ: ' + identity)
        records[identity] = dict(package, license_file=values.get('license-file'), archive_checksum=checksum)
    outputs, declarations, compiled, declared = {}, [], [], set()
    for context, identifiers in sorted(roots.items()):
        selected = original.native_binaries([nodes[identity] for identity in identifiers])
        for name, root in selected.items():
            root_id = next(identity for identity in identifiers if nodes[identity] is root)
            closure = {}
            def include(identity):
                if identity in closure:
                    return
                closure[identity] = nodes[identity]
                for edge in nodes[identity]['dependencies']:
                    include(edge['unit'])
            include(root_id)
            ids = sorted({unit['pkg_id'] for unit in closure.values()})
            selected_packages = {identity: records[identity] for identity in ids}
            def prefix(package):
                suffix = 'source' if package['source'] is None else 'registry/' + package['name'] + '-' + package['version']
                return '@' + original.REPOSITORY + '//' + suffix
            sources = {identity: prefix(package) + ':package_data' for identity, package in selected_packages.items()}
            manifests = {identity: prefix(package) + ':Cargo.toml' for identity, package in selected_packages.items()}
            host = context.rsplit('/', 1)[1]
            basename = name.replace('-', '_') + '__' + units.identifier(host)
            descriptor = {'roots': [root_id], 'units': closure, 'packages': selected_packages,
                'configuration': {'compiler_root': context, 'target': host,
                    'captured_execution_hosts': sorted({unit['execution_host'] for unit in closure.values()})},
                'package_sources': sources, 'package_manifests': manifests,
                'shipping_qualified': False,
                'pending': ['Original source-built CLI output parity', 'Compiled stock Rust and native source attribution',
                            'Four-platform runtime qualification']}
            outputs[basename + '.json'] = json.dumps(descriptor, indent=2, sort_keys=True) + '\n'
            package_labels = {}
            for identity, package in selected_packages.items():
                target = 'package_' + units.key(identity)
                package_labels[':' + target] = identity
                if identity in declared:
                    continue
                declared.add(identity)
                publisher_args = ''
                patch_args = ''
                if identity in publishers['packages']:
                    entry = publishers['packages'][identity]
                    roles = {'catalog': '//tools/bazel/wasm/bindgen_source:publisher-licenses.json',
                             'archive': entry['source_archive'], 'vcs': entry['vcs_file'],
                             'manifest': entry['manifest'], 'workspace_manifest': entry['workspace_manifest']}
                    roles.update({'license:' + member: label for member, label in entry['licenses'].items()})
                    publisher_args = (', publisher_sources = ' + units.starlark({label: role for role, label in roles.items()})
                                      + ', publisher_source_labels = ' + units.starlark(roles))
                if package['name'] == 'wasm-bindgen-shared':
                    if package['version'] != original.VERSION:
                        raise ValueError('Maintained revision patch requires the original shared source package')
                    roles = {'archive': '@' + original.REPOSITORY + '//:archives/wasm-bindgen-shared-' + original.VERSION + '.crate',
                             'patch': '//tools/bazel/wasm/bindgen_source:declared-revision.patch',
                             'source': prefix(package) + ':build.rs',
                             'vcs': prefix(package) + ':.cargo_vcs_info.json'}
                    patch_args = (', source_patches = ' + units.starlark({label: role for role, label in roles.items()})
                                  + ', source_patch_labels = ' + units.starlark(roles))
                declarations.append('    declared_package_tree(name = ' + units.text(target)
                    + ', sources = ' + units.text(sources[identity]) + ', manifest = ' + units.text(manifests[identity])
                    + ', source_label = ' + units.text(sources[identity]) + ', manifest_label = '
                    + units.text(manifests[identity]) + publisher_args + patch_args + ')\n')
            declarations.append('    rust_attribution(name = ' + units.text(basename + '_notices')
                + ', descriptor = ' + units.text(':attribution/' + basename + '.json') + ', compiler_root = '
                + units.text(context) + ', target_triple = ' + units.text(host) + ', packages = '
                + units.starlark(package_labels) + ')\n')
            # Mandatory linked-stdlib producer is supplied by the existing configured
            # native link-map collector. Do not create a complete provider without it.
            compiled.append('    compiled_rust_attribution(name = ' + units.text(basename + '_compiled_attribution')
                + ', producer = ' + units.text(':u_' + root_id) + ', descriptor = '
                + units.text(':attribution/' + basename + '.json') + ', attribution = '
                + units.text(':' + basename + '_notices') + ', packages = ' + units.starlark(package_labels)
                + ', target_triple = ' + units.text(host) + ', stdlib_notices = stdlib_notices['
                + units.text(basename) + '])\n')
    outputs['attribution.bzl'] = ('load("//tools/bazel/packaging:notices.bzl", "declared_package_tree", "rust_attribution")\n'
        + 'load("//tools/bazel/packaging:rust-compiled.bzl", "compiled_rust_attribution")\n'
        + '\ndef declare_bindgen_notice_inputs():\n' + ''.join(declarations)
        + '\ndef declare_bindgen_compiled_attributions(stdlib_notices):\n' + ''.join(compiled))
    return outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', type=Path, action='append', required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    for name in ['original', 'units', 'lto', 'parity', 'licenses', 'native-receipts', 'edges']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--registry-directory', type=Path, required=True)
    parser.add_argument('--attribution-directory', type=Path, required=True)
    parser.add_argument('--publisher-catalog', type=Path, required=True)
    parser.add_argument('--json-formatter', type=Path, required=True)
    args = parser.parse_args()
    load('configured_parity', args.parity)
    load('license_metadata', args.licenses)
    load('native_receipts', args.native_receipts)
    value = emit(args.context, args.archive, load('bindgen_original', args.original),
                 load('bindgen_units', args.units), load('bindgen_lto', args.lto),
                 load('existing_native_edges', args.edges))
    args.output.write_text(value)
    args.attribution_directory.mkdir(parents=True, exist_ok=True)
    outputs = attribution(args.context, args.archive, args.registry_directory,
                          load('bindgen_original', args.original), load('bindgen_units', args.units), args.publisher_catalog)
    for name, contents in outputs.items():
        if name.endswith('.json'):
            contents = subprocess.run([str(args.json_formatter), 'format', '--stdin-file-path', str(args.attribution_directory / name)],
                                      input=contents, text=True, capture_output=True, env={'PATH': ''}, check=True).stdout
        (args.attribution_directory / name).write_text(contents)


if __name__ == '__main__':
    main()
