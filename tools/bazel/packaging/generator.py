"""Derive exact declared provider labels from maintained compiler descriptors."""
import hashlib
import json
from pathlib import Path
import sys


SHIPPING_PACKAGES = ('merkur-dataplane', 'merkur-image-worker', 'merkur-tui', 'merkur-edge', 'merkur-stun')
SHIPPING_TARGETS = ('aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu')
PRODUCERS = {'merkur-dataplane': '//apps/daemon/dataplane:merkur_dataplane',
             'merkur-image-worker': '//packages/merkur-image-worker:bin_merkur_image_worker',
             'merkur-tui': '//apps/tui:bin_merkur_tui',
             'merkur-edge': '//apps/edge:merkur_edge', 'merkur-stun': '//apps/stun:merkur_stun'}


WASM_CONTEXTS = {
    'e2e_wasm_selected_release_wasm.json': ('e2e-wasm/release/wasm32-unknown-unknown', '//tools/bazel/rust/units:e2e_wasm__release_wasm', '//packages/e2e-wasm:wasm_artifacts'),
    'graphics_wasm_selected_release_wasm.json': ('graphics-wasm/release/wasm32-unknown-unknown', '//tools/bazel/rust/units:graphics_wasm__release_wasm', '//packages/graphics-wasm:wasm_artifacts'),
    'term_wasm_selected_profile_use_wasm.json': ('term-wasm/profile_use/wasm32-unknown-unknown', '//tools/bazel/rust/units:term_wasm__profile_use_wasm', '//packages/term-wasm:wasm_artifacts'),
}


def selected_wasm_contexts(root):
    directory = root / 'tools/bazel/rust/units/provenance'
    contexts, macros = [], {}
    captured = json.loads((directory.parent / 'graph.json').read_text())
    for name, (context, producer, package_producer) in WASM_CONTEXTS.items():
        path = directory / name
        data = json.loads(path.read_text())
        roots, nodes = data['roots'], data['units']
        if len(roots) != 1 or roots[0] not in nodes:
            raise ValueError('WASM descriptor lacks its exact actual cdylib root')
        unit = nodes[roots[0]]
        if (data['configuration']['compiler_root'] != context or data['configuration']['target'] != 'wasm32-unknown-unknown'
                or not unit['emit_cdylib'] or unit['platform'] != 'wasm32-unknown-unknown'
                or unit['mode'] != 'build' or unit['profile']['name'] != 'release'
                or data['packages'][unit['pkg_id']]['name'] != context.split('/')[0]):
            raise ValueError('WASM descriptor differs from its original shipped compiler selection')
        seen, pending = set(), list(roots)
        while pending:
            identity = pending.pop()
            if identity in seen:
                continue
            seen.add(identity)
            pending.extend(edge['unit'] for edge in nodes[identity]['dependencies'])
        if seen != set(nodes):
            raise ValueError('WASM descriptor contains units outside the actual root closure')
        original_roots = [identity for identity in captured['roots'][context] if captured['nodes'][identity]['emit_cdylib']]
        original_seen, pending = set(), list(original_roots)
        while pending:
            identity = pending.pop()
            if identity in original_seen:
                continue
            original_seen.add(identity)
            pending.extend(edge['unit'] for edge in captured['nodes'][identity]['dependencies'])
        if roots != original_roots or nodes != {identity: captured['nodes'][identity] for identity in original_seen}:
            raise ValueError('WASM descriptor differs from the original captured compiler graph')
        selected_macros = sorted(identity for identity in nodes if nodes[identity]['target']['kind'] == ['proc-macro'])
        for identity in selected_macros:
            macro = nodes[identity]
            if identity in macros and macros[identity] != macro:
                raise ValueError('Loaded host macro configuration differs between shipped roots')
            macros[identity] = macro
        contexts.append({'name': Path(name).stem, 'data': data, 'producer': producer,
                         'package_producer': package_producer, 'macros': selected_macros})
    expected = {'host_proc_macro_' + identity + '.json' for identity in macros}
    if {path.name for path in directory.glob('host_proc_macro_*.json')} != expected:
        raise ValueError('Exact loaded host proc-macro descriptor inventory required')
    hosts = []
    for identity, selected in sorted(macros.items()):
        name = 'host_proc_macro_' + identity
        data = json.loads((directory / (name + '.json')).read_text())
        if (data['roots'] != [identity] or data['units'].get(identity) != selected
                or selected['platform'] is not None or selected['execution_host'] not in SHIPPING_TARGETS
                or selected['mode'] != 'build' or selected['profile']['name'] != 'release'
                or data['configuration']['target'] != selected['execution_host']):
            raise ValueError('Host macro descriptor differs from its actual loaded compiler output')
        seen, pending = set(), [identity]
        while pending:
            node = pending.pop()
            if node in seen:
                continue
            seen.add(node)
            pending.extend(edge['unit'] for edge in data['units'][node]['dependencies'])
        if seen != set(data['units']):
            raise ValueError('Host macro descriptor contains foreign compiler units')
        for wasm in contexts:
            if identity in wasm['macros'] and any(data['units'][node] != wasm['data']['units'][node] for node in seen):
                raise ValueError('Host macro subgraph differs from the original WASM dependency graph')
        hosts.append({'name': name, 'data': data, 'producer': '//tools/bazel/rust/units:u_' + identity, 'identity': identity})
    return contexts, hosts


def package_bindings(data, packages):
    if set(data['packages']) != set(data['package_sources']) or set(data['package_sources']) != set(data['package_manifests']):
        raise ValueError('Incomplete selected package manifests')
    mapping = {}
    for identity, label in sorted(data['package_sources'].items()):
        name = 'source_' + hashlib.sha256(identity.encode()).hexdigest()
        spec = {'name': name, 'sources': label, 'manifest': data['package_manifests'][identity],
                'source_label': label, 'manifest_label': data['package_manifests'][identity]}
        if name in packages and packages[name] != spec:
            raise ValueError('Conflicting exact package provider')
        packages[name] = spec
        mapping[':' + name] = identity
    return mapping


def expected_contexts():
    return {package.replace('-', '_') + '__release__' + target.replace('-', '_') + '.json':
            (package + '/release/' + target, target)
            for package in SHIPPING_PACKAGES for target in SHIPPING_TARGETS}


def rendered(root):
    contexts, packages = [], {}
    paths = sorted((root / 'tools/bazel/rust/units/provenance').glob('*__release__*.json'))
    expected = expected_contexts()
    if {path.name for path in paths} != set(expected):
        raise ValueError('Exact five-binary/four-platform attribution descriptor inventory required')
    for path in paths:
        data = json.loads(path.read_text())
        configuration = data['configuration']
        if (configuration['compiler_root'], configuration['target']) != expected[path.name]:
            raise ValueError('Descriptor filename differs from its selected compiler context')
        package_name = expected[path.name][0].split('/')[0]
        roots = data['roots']
        if len(roots) != 1 or roots[0] not in data['units']:
            raise ValueError('Descriptor lacks its exact selected shipping binary')
        selected = data['units'][roots[0]]
        if (data['packages'][selected['pkg_id']]['name'] != package_name or
                selected['target']['name'] != package_name or
                selected['target']['kind'] != ['bin'] or
                selected['target']['crate_types'] != ['bin'] or
                selected['mode'] != 'build' or selected['profile']['name'] != 'release'):
            raise ValueError('Selected compiler root differs from the required shipping binary')
        mapping = package_bindings(data, packages)
        contexts.append({'name': 'rust_attribution_' + path.stem,
                         'descriptor': '//tools/bazel/rust/units/provenance:' + path.name,
                         'compiler_root': data['configuration']['compiler_root'],
                         'target_triple': data['configuration']['target'], 'packages': mapping})
    wasm_contexts, host_contexts = selected_wasm_contexts(root)
    for spec in wasm_contexts + host_contexts:
        spec['packages'] = package_bindings(spec['data'], packages)
    lines = ['"""Exact descriptor-derived attribution providers; regenerated with generator.py."""',
             'load(":notices.bzl", "declared_package_tree", "rust_attribution")',
             'load(":rust-compiled.bzl", "compiled_rust_attribution")', '',
             'load(":stdlib-native-graph.bzl", "stock_stdlib_native_graph")',
             'load("//tools/bazel/rust:stdlib-test.bzl", "stdlib_attribution_tests")', '',
             'def declared_rust_attribution():']
    for spec in packages.values():
        lines.append('    declared_package_tree(' + ', '.join(key + ' = ' + repr(value) for key, value in spec.items()) + ', tags = ["manual"])')
    for spec in contexts:
        lines.append('    rust_attribution(' + ', '.join(key + ' = ' + repr(value) for key, value in spec.items()) + ', tags = ["manual", "unqualified-release-attribution"])')
    shipping_context_names = sorted(spec['name'].removeprefix('rust_attribution_') for spec in contexts)
    lines += ['', 'def declared_shipping_stdlib_attribution(sdk, source, source_archive, stdlib_archives, rustc_archives):',
              '    """Bind original stock inputs to each same-action shipping compiler graph."""',
              '    for archives in [stdlib_archives, rustc_archives]:',
              '        if type(archives) != "dict" or sorted(archives.keys()) != ' + repr(sorted(SHIPPING_TARGETS)) + ':',
              '            fail("Shipping stdlib attribution requires exact native stock archive bindings")']
    for target in SHIPPING_TARGETS:
        constraints = ['@platforms//cpu:' + ('aarch64' if target.startswith('aarch64') else 'x86_64'),
                       '@platforms//os:' + ('macos' if 'apple-darwin' in target else 'linux')]
        graph = {'name': 'shipping_stdlib_graph_' + target.replace('-', '_'),
                 'producer': PRODUCERS['merkur-dataplane'], 'target_compatible_with': constraints,
                 'exec_compatible_with': constraints}
        lines.append('    stock_stdlib_native_graph(' + ', '.join(key + ' = ' + repr(value) for key, value in graph.items())
                     + ', sdk = sdk, source = source, stdlib_archive = stdlib_archives[' + repr(target)
                     + '], compiler_archive = rustc_archives[' + repr(target) + '], tags = ["manual"])')
    standard = {}
    for spec in contexts:
        stem = spec['name'].removeprefix('rust_attribution_')
        package = spec['compiler_root'].split('/')[0]
        target = spec['target_triple']
        bound = {'name': 'shipping_stdlib_attribution_' + stem, 'compiler': PRODUCERS[package],
                 'graph': ':shipping_stdlib_graph_' + target.replace('-', '_'),
                 'execution_host': target,
                 'target_compatible_with': ['@platforms//cpu:' + ('aarch64' if target.startswith('aarch64') else 'x86_64'),
                                            '@platforms//os:' + ('macos' if 'apple-darwin' in target else 'linux')]}
        lines.append('    stdlib_attribution_tests(' + ', '.join(key + ' = ' + repr(value) for key, value in bound.items())
                     + ', source_archive = source_archive, stdlib_archive = stdlib_archives[' + repr(target)
                     + '], rustc_archive = rustc_archives[' + repr(target) + '])')
        standard[stem] = ':' + bound['name']
    lines.append('    return ' + repr(standard))
    lines += ['', 'def declared_compiled_rust_attribution(stdlib_notices):',
              '    if type(stdlib_notices) != "dict" or sorted(stdlib_notices.keys()) != ' + repr(shipping_context_names) + ':',
              '        fail("Compiled attribution requires one exact linked stdlib producer for every shipping context")']
    for spec in contexts:
        stem = spec['name'].removeprefix('rust_attribution_')
        package = spec['compiler_root'].split('/')[0]
        bound = {'name': 'compiled_rust_attribution_' + stem, 'producer': PRODUCERS[package],
                 'descriptor': spec['descriptor'], 'attribution': ':' + spec['name'],
                 'target_triple': spec['target_triple'], 'packages': spec['packages'],
                 'target_compatible_with': ['@platforms//cpu:' + ('aarch64' if spec['target_triple'].startswith('aarch64') else 'x86_64'),
                                            '@platforms//os:' + ('macos' if 'apple-darwin' in spec['target_triple'] else 'linux')]}
        lines.append('    compiled_rust_attribution(' + ', '.join(key + ' = ' + repr(value) for key, value in bound.items())
                     + ', stdlib_notices = stdlib_notices[' + repr(stem) + '], tags = ["manual", "unqualified-release-attribution"])')
    lines += ['', 'def declared_wasm_rust_attribution(sdk, source, source_archive, wasm_stdlib_archive, host_stdlib_archives, rustc_archives):',
              '    """Join actual shipped module maps and every loaded host macro map."""']
    hosts = sorted({spec['data']['units'][spec['data']['roots'][0]]['execution_host'] for spec in wasm_contexts})
    lines += ['    for archives in [host_stdlib_archives, rustc_archives]:',
              '        if type(archives) != "dict" or sorted(archives) != ' + repr(hosts) + ':',
              '            fail("WASM attribution requires every actual compiler-host original archive")']
    for host in hosts:
        constraints = ['@platforms//cpu:' + ('aarch64' if host.startswith('aarch64') else 'x86_64'),
                       '@platforms//os:' + ('macos' if 'apple-darwin' in host else 'linux')]
        host_context = next(spec for spec in host_contexts if spec['data']['configuration']['target'] == host)
        wasm_context = next(spec for spec in wasm_contexts if spec['data']['units'][spec['data']['roots'][0]]['execution_host'] == host)
        for kind, spec, archive in [('host', host_context, 'host_stdlib_archives[' + repr(host) + ']'), ('module', wasm_context, 'wasm_stdlib_archive')]:
            bound = {'name': 'wasm_' + kind + '_stdlib_graph_' + host.replace('-', '_'), 'producer': spec['producer'],
                     'exec_compatible_with': constraints, 'target_compatible_with': constraints}
            lines.append('    stock_stdlib_native_graph(' + ', '.join(key + ' = ' + repr(value) for key, value in bound.items())
                         + ', sdk = sdk, source = source, stdlib_archive = ' + archive + ', compiler_archive = rustc_archives[' + repr(host) + '], tags = ["manual"])')
    for spec in host_contexts + wasm_contexts:
        data, name = spec['data'], spec['name']
        unit = data['units'][data['roots'][0]]
        host = unit['execution_host']
        module = 'identity' not in spec
        target = 'wasm32-unknown-unknown' if module else host
        constraints = ['@platforms//cpu:' + ('aarch64' if host.startswith('aarch64') else 'x86_64'),
                       '@platforms//os:' + ('macos' if 'apple-darwin' in host else 'linux')]
        descriptor = '//tools/bazel/rust/units/provenance:' + name + '.json'
        bound = {'name': 'rust_attribution_' + name, 'descriptor': descriptor,
                 'compiler_root': data['configuration']['compiler_root'], 'target_triple': target, 'packages': spec['packages'],
                 'target_compatible_with': constraints}
        lines.append('    rust_attribution(' + ', '.join(key + ' = ' + repr(value) for key, value in bound.items()) + ', tags = ["manual"])')
        bound = {'name': 'linked_stdlib_' + name, 'compiler': spec['producer'],
                 'graph': ':wasm_' + ('module' if module else 'host') + '_stdlib_graph_' + host.replace('-', '_'),
                 'execution_host': host, 'target_compatible_with': constraints}
        archive = 'wasm_stdlib_archive' if module else 'host_stdlib_archives[' + repr(host) + ']'
        lines.append('    stdlib_attribution_tests(' + ', '.join(key + ' = ' + repr(value) for key, value in bound.items())
                     + ', source_archive = source_archive, stdlib_archive = ' + archive + ', rustc_archive = rustc_archives[' + repr(host) + '])')
        bound = {'name': 'compiled_rust_attribution_' + name, 'producer': spec['producer'], 'descriptor': descriptor,
                 'attribution': ':rust_attribution_' + name, 'target_triple': target, 'packages': spec['packages'],
                 'stdlib_notices': ':linked_stdlib_' + name, 'target_compatible_with': constraints}
        if module:
            bound['proc_macro_notices'] = [':compiled_rust_attribution_host_proc_macro_' + identity for identity in spec['macros']]
        lines.append('    compiled_rust_attribution(' + ', '.join(key + ' = ' + repr(value) for key, value in bound.items()) + ', tags = ["manual", "unqualified-release-attribution"])')
    mappings = {':compiled_rust_attribution_' + spec['name']: spec['package_producer'] for spec in wasm_contexts}
    package_map = {}
    for spec in wasm_contexts:
        package_map.update(spec['packages'])
    lines.append('    return ' + repr({'rust_attributions': mappings, 'rust_packages': package_map}))
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[3]
    output = Path(__file__).with_name('rust-providers.bzl')
    content = rendered(root)
    if '--check' in sys.argv:
        if output.read_text() != content:
            raise SystemExit('Rust attribution providers differ from exact compiler descriptors')
    else:
        output.write_text(content)
