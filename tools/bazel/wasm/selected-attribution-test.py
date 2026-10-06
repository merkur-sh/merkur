"""Synthetic declared producer/selection controls; never platform qualification."""
import argparse
import json
import importlib.util
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class SelectedWasmControls(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        before = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, before)
        Path('package').mkdir()
        Path('package/module.js').write_bytes(b'export const selected = 7;\n')
        Path('package/module_bg.wasm').write_bytes(b'\0asm\x01\0\0\0')
        Path('package/package.json').write_bytes(b'{"name":"test-wasm","version":"1.0.0"}')
        Path('main.ts').write_bytes(b'import { selected } from "./package/module.js";\n')
        Path('binary').write_bytes(b'synthetic standalone compiler output')
        Path('binary').chmod(0o755)
        self.producer = '//apps/daemon:daemon'
        self.package_producer = '//packages/example:wasm_package'
        self.tree_owner = '//packages/example:wasm_projection'
        self.descriptor = {'producer': self.package_producer,
                           'tree': {'input': 'package', 'label': self.tree_owner},
                           'inventory': {'input': 'package-inventory.json', 'label': self.package_producer}}
        self.specification = {'producer': self.producer, 'frontend_checker': None, 'zero_source_inputs': None,
                              'artifact': {'input': 'binary', 'label': self.producer},
                              'configuration': 'context.json', 'compiler_inventory': 'compiler.json',
                              'declarations': 'declarations.json', 'npm_sources': [],
                              'npm_source_inventory': 'npm.json', 'wasm_packages': [self.descriptor]}
        Path('raw.wasm').write_bytes(Path('package/module_bg.wasm').read_bytes())
        Path('source.rs').write_bytes(b'// explicit synthetic compiler unit input\n')
        Path('Cargo.toml').write_bytes(b'[package]\nname="fixture"\nversion="1.0.0"\nlicense="AGPL-3.0-only"\n')
        Path('tool').write_bytes(b'explicit synthetic generator tool')
        Path('tool').chmod(0o755)
        Path('optimizer.ts').write_bytes(b'// explicit synthetic optimizer source\n')
        Path('bunfig.toml').write_bytes(b'[install]\nauto="disable"\n')
        for tree in ('bindings', 'optimized'):
            Path(tree).mkdir()
            Path(tree, 'module.js').write_bytes(Path('package/module.js').read_bytes())
        def descriptor(path, label, tree=False):
            return {'input': path, 'label': label, 'tree': tree}
        raw = descriptor('raw.wasm', '//fixture:u_' + '1' * 64)
        source = descriptor('source.rs', '//fixture:source.rs')
        manifest = descriptor('Cargo.toml', '//fixture:Cargo.toml')
        tool = descriptor('tool', '//fixture:tool')
        optimizer_script = descriptor('optimizer.ts', '//fixture:optimizer.ts')
        bunfig = descriptor('bunfig.toml', '//fixture:bunfig.toml')
        bound = descriptor('bindings', '//fixture:bindings', True)
        optimized = descriptor('optimized', '//fixture:optimized', True)
        configurations = []
        for stage, stage_inputs, output in [
                ('bindings', [raw], bound),
                ('optimizer', [bound], optimized),
                ('package', [optimized, manifest], descriptor('package', self.package_producer, True))]:
            path = stage + '.generation.json'
            arguments = (['raw.wasm', '--target', 'web', '--out-name', 'module', '--out-dir', 'bindings']
                         if stage == 'bindings' else ['--no-install', '--no-env-file', '--config=bunfig.toml',
                         'optimizer.ts', 'bindings', 'optimized', 'module', 'tool']
                         if stage == 'optimizer' else ['explicit-synthetic-generation'])
            self.write(path, {'producer': self.package_producer if stage == 'package' else output['label'],
                              'stage': stage, 'inputs': stage_inputs, 'tools': [tool], 'executable': tool,
                              'arguments': arguments,
                              'output': {name: output[name] for name in ('input', 'label')}})
            configurations.append(descriptor(path, output['label']))
        root = '1' * 64
        self.origin = {'root': root, 'units': [wasm_inputs.pack.canonical({
            'unit': root, 'crate_type': 'cdylib', 'compiler': {'target': 'wasm32-unknown-unknown'},
            'dependencies': [], 'inputs': [source], 'root': 'source.rs'}).decode('utf8')],
            'artifact': raw, 'inputs': [source], 'crate_manifest': manifest,
            'generator_inputs': [raw, tool, bound, optimized, manifest, optimizer_script, bunfig],
            'generator_sources': [optimizer_script, bunfig, manifest],
            'generator_configurations': configurations}
        self.specification['compiler_origins'] = {self.package_producer: self.origin}
        Path('LICENSE').write_bytes(b'Original explicit synthetic source license text\n')
        Path('source-tree').mkdir()
        source_files = []
        for member in ('Cargo.toml', 'LICENSE', 'source.rs'):
            Path('source-tree', member).write_bytes(Path(member).read_bytes())
            source_files.append(descriptor(member, '//fixture:' + member))
        self.specification['rust_packages'] = {'fixture@1.0.0': {
            'root': descriptor('source-tree', '//fixture:source-tree', True),
            'manifest': manifest, 'files': source_files, 'authored': True}}
        self.specification['workspace_manifest'] = descriptor('Cargo.toml', '//:Cargo.toml')
        self.specification['workspace_license'] = descriptor('LICENSE', '//:LICENSE')
        self.write('package.json', {'name': 'fixture-workspace', 'private': True, 'license': 'AGPL-3.0-only'})
        self.specification['workspace_package'] = descriptor('package.json', '//:package.json')
        self.generator_provider = {'scope': 'rust', 'producer': '//fixture:tool',
            'artifacts': [{'input': 'tool', 'label': '//fixture:tool'}]}
        for name in ('configuration', 'source_inventory', 'inventory', 'notices'):
            self.generator_provider[name] = {'input': 'generator-' + name,
                                             'label': '//fixture:generator-attribution'}
        self.specification['generator_attributions'] = [self.generator_provider]
        configuration = {'producer': '//fixture:tool', 'scope': 'explicit synthetic attribution action'}
        sources = {'sources': [self.fact('source.rs', '//fixture:source.rs')],
                   'scope': 'synthetic generator producer, not native qualification'}
        self.write('generator-configuration', configuration)
        self.write('generator-source_inventory', sources)
        raw = Path('tool').read_bytes()
        text = Path('LICENSE').read_text()
        self.generator_inventory = {'kind': 'selected-native-rust-attribution',
            'producer': '//fixture:tool', 'pending_scopes': [],
            'configuration': wasm_inputs.npm.sha256(Path('generator-configuration').read_bytes()),
            'source_digest': wasm_inputs.npm.sha256(Path('generator-source_inventory').read_bytes()),
            'artifacts': [{'path': 'tool', 'label': '//fixture:tool', 'mode': '0555',
                           'size': len(raw), 'sha256': wasm_inputs.npm.sha256(raw)}],
            'components': [{'id': 'generator-fixture', 'name': 'Synthetic generator fixture',
                'version': '1.0.0', 'source': None, 'repository': None, 'license': 'AGPL-3.0-only',
                'license_file': None, 'source_label': '//fixture:source.rs',
                'texts': [{'path': 'LICENSE', 'size': len(text.encode('utf8')),
                           'sha256': wasm_inputs.npm.sha256(text.encode('utf8')), 'text': text}]}]}
        self.refresh_generator()
        raw_wasm = self.origin['artifact']
        self.rust_provider = {'scope': 'rust', 'producer': raw_wasm['label'],
            'artifacts': [{'input': raw_wasm['input'], 'label': raw_wasm['label']}]}
        for name in ('configuration', 'source_inventory', 'inventory', 'notices'):
            self.rust_provider[name] = {'input': 'rust-' + name,
                                       'label': '//fixture:rust-attribution'}
        self.specification['rust_attributions'] = {self.package_producer: self.rust_provider}
        self.rust_configuration = {'kind': 'configured-wasm-rust-release', 'producer': raw_wasm['label'],
            'target': 'wasm32-unknown-unknown', 'profile': 'release', 'root': root,
            'units': [wasm_inputs.pack.load_json(item) for item in self.origin['units']]}
        source_raw = Path('source.rs').read_bytes()
        Path('stdlib.rlib').write_bytes(b'explicit synthetic selected standard-library archive')
        Path('stdlib-notice').write_bytes(b'explicit synthetic original publisher notice')
        original_linkage_files = {'rustc': ('tool', '//fixture:tool'),
            'link_map': ('link-map', '//fixture:link-map'),
            'source_archive': ('rust-source.archive', '//fixture:rust-source'),
            'stdlib_archive': ('rust-std.archive', '//fixture:rust-std'),
            'rustc_archive': ('rustc.archive', '//fixture:rustc-archive'),
            'graph': ('stdlib-graph', '//fixture:stdlib-graph')}
        for name, (filename, label) in original_linkage_files.items():
            if name != 'rustc':
                Path(filename).write_bytes(('explicit synthetic ' + name).encode('utf8'))
        def original_fact(filename, label):
            raw_bytes = Path(filename).read_bytes()
            return {'path': filename, 'label': label, 'size': len(raw_bytes),
                    'sha256': wasm_inputs.npm.sha256(raw_bytes)}
        standard = original_fact('stdlib.rlib', '@fixture_std//:original_std')
        linkage = {'kind': 'linked-stdlib-source-attribution', 'compiler': '1.97.1',
            'target': 'wasm32-unknown-unknown', 'execution_host': 'aarch64-apple-darwin',
            'pending_scopes': [], 'artifact': original_fact(raw_wasm['input'], raw_wasm['label']),
            'selected_stdlib': [{**standard, 'members': {'synthetic.o': {'size': 1, 'sha256': '1' * 64}}}]}
        linkage.update({name: original_fact(filename, label)
                        for name, (filename, label) in original_linkage_files.items()})
        self.rust_sources = {'compiler_inputs': [{'path': 'source.rs', 'label': '//fixture:source.rs',
            'size': len(source_raw), 'sha256': wasm_inputs.npm.sha256(source_raw)}],
            'standard_library': [original_fact('stdlib-notice', '//fixture:stdlib-notice')],
            'module_linkage': linkage, 'host_proc_macros': []}
        unit = wasm_inputs.pack.load_json(self.origin['units'][0])
        unit['stdlib'] = [{'input': 'stdlib.rlib', 'label': standard['label']}]
        self.origin['units'][0] = wasm_inputs.pack.canonical(unit).decode('utf8')
        self.rust_configuration['units'] = [unit]
        publisher_files = [(filename, label) for filename, label in original_linkage_files.values()]
        publisher_files += [('stdlib.rlib', standard['label']), ('stdlib-notice', '//fixture:stdlib-notice'),
                            ('source.rs', '//fixture:source.rs'), (raw_wasm['input'], raw_wasm['label'])]
        self.specification['rust_attribution_inputs'] = {self.package_producer: [descriptor(filename, label)
            for filename, label in publisher_files]}
        raw_bytes = Path(raw_wasm['input']).read_bytes()
        self.rust_inventory = {'kind': 'selected-wasm-rust-attribution', 'producer': raw_wasm['label'],
            'target': 'wasm32-unknown-unknown', 'profile': 'release', 'pending_scopes': [],
            'artifacts': [{'path': raw_wasm['input'], 'label': raw_wasm['label'], 'mode': '0644',
                           'size': len(raw_bytes), 'sha256': wasm_inputs.npm.sha256(raw_bytes)}],
            'components': [{**self.generator_inventory['components'][0], 'id': 'fixture@1.0.0',
                            'name': 'fixture'}]}
        self.refresh_rust()
        self.context = {'producer': self.producer, 'compile_target': 'bun-darwin-arm64'}
        self.compiler = {'inputs': {'main.ts': self.fact('main.ts', '//fixture:main.ts'),
                                    'package/module.js': self.fact('package/module.js', self.tree_owner)},
                         'outputs': {},
                         'artifacts': {'binary': {'bytes': len(Path('binary').read_bytes()),
                                                  'sha256': wasm_inputs.npm.sha256(Path('binary').read_bytes())}}}
        self.declarations = {'main.ts': {'input': 'main.ts', 'link': False,
                                         'owner': '//fixture:main.ts', 'canonical': 'main.ts'},
                             'package': {'input': 'package', 'link': False,
                                         'owner': self.tree_owner, 'canonical': 'package'}}
        self.refresh()

    def fact(self, filename, owner):
        data = Path(filename).read_bytes()
        return {'owner': owner, 'bytes': len(data), 'sha256': wasm_inputs.npm.sha256(data)}

    def write(self, filename, value):
        Path(filename).write_bytes(wasm_inputs.pack.canonical(value))

    def refresh(self):
        self.write('context.json', self.context)
        self.write('compiler.json', self.compiler)
        self.write('declarations.json', self.declarations)
        self.write('npm.json', self.specification['npm_sources'])
        self.write('package-inventory.json', {
            'producer': self.package_producer, 'module': 'module',
            'members': [{'member': file.name, 'size': len(file.read_bytes()),
                         'sha256': wasm_inputs.npm.sha256(file.read_bytes())}
                        for file in sorted(Path('package').iterdir())],
        })

    def refresh_generator(self):
        self.write('generator-inventory', self.generator_inventory)
        Path('generator-notices').write_bytes(wasm_inputs.closure.render(self.generator_inventory))

    def refresh_rust(self):
        self.write('rust-configuration', self.rust_configuration)
        self.write('rust-source_inventory', self.rust_sources)
        self.rust_inventory['configuration'] = wasm_inputs.npm.sha256(Path('rust-configuration').read_bytes())
        self.rust_inventory['source_digest'] = wasm_inputs.npm.sha256(Path('rust-source_inventory').read_bytes())
        self.write('rust-inventory', self.rust_inventory)
        Path('rust-notices').write_bytes(wasm_inputs.closure.render(self.rust_inventory))

    def produce(self):
        helper.produce(self.specification, 'result.json', 'result.txt', wasm_inputs)
        return wasm_inputs.pack.load_json(Path('result.json').read_bytes())

    def refused(self, message):
        with self.assertRaisesRegex((ValueError, OSError), message):
            self.produce()
        self.assertFalse(Path('result.json').exists())
        self.assertFalse(Path('result.txt').exists())

    def zero_wasm(self):
        self.specification['wasm_packages'] = []
        for name in ('compiler_origins', 'rust_packages', 'rust_attributions', 'rust_attribution_inputs'):
            self.specification[name] = {}
        self.specification['generator_attributions'] = []
        self.specification['zero_source_inputs'] = [{'input': 'main.ts', 'label': '//fixture:main.ts',
                                                    'tree': False, 'authored': True}]
        self.specification['frontend_checker'] = {
            'bun': {'input': str(bun), 'label': '@fixture_bun//:bun', 'tree': False},
            'runner': {'input': str(frontend_checker), 'label': '//tools/bazel/wasm:frontend-check.ts', 'tree': False},
            'config': {'input': str(bun_config), 'label': '//tools/bazel/bun:empty-bunfig.toml', 'tree': False},
            'modules': [{'input': str(frontend_checker.parent.parent / 'bun' / name),
                         'label': '//tools/bazel/bun:' + name, 'tree': False}
                        for name in ('npm-attribution.ts', 'compiler-inventory.ts', 'owned-files.ts', 'portable-path.ts')]}
        Path('main.ts').write_bytes(b'export const applicationHasNoWasm = true;\n')
        self.context['file_loaders'] = {'.wasm': 'file'}
        self.compiler['inputs'] = {'main.ts': {**self.fact('main.ts', '//fixture:main.ts'),
                                            'format': 'esm', 'imports': []}}
        self.compiler['outputs'] = {'binary': {'bytes': len(Path('binary').read_bytes()),
                                              'inputs': {'main.ts': {'bytesInOutput': 0}},
                                              'entryPoint': 'main.ts', 'imports': [], 'exports': []}}
        self.declarations = {'main.ts': self.declarations['main.ts']}
        self.refresh()

    def test_zero_application_wasm_preserves_actual_compiler_and_artifact_custody(self):
        self.zero_wasm()
        value = self.produce()
        self.assertEqual(value['pending_scopes'], [])
        self.assertEqual(value['packages'], [])
        self.assertEqual(value['components'], [])
        self.assertEqual(value['configuration'], wasm_inputs.npm.sha256(Path('context.json').read_bytes()))
        self.assertEqual(value['source_digest'], wasm_inputs.npm.sha256(Path('compiler.json').read_bytes()))
        self.assertEqual(value['artifacts'][0]['sha256'], wasm_inputs.npm.sha256(Path('binary').read_bytes()))
        self.assertNotIn('embedded-runtime', value)

    def test_zero_application_wasm_cannot_discard_real_typed_attribution(self):
        self.zero_wasm()
        self.specification['compiler_origins'] = {'original': {}}
        self.refused('exact empty typed producer mappings')

    def test_zero_wasm_accepts_only_byte_bound_original_typed_npm_members(self):
        self.zero_wasm()
        Path('npm/zero').mkdir(parents=True)
        Path('npm/zero/package.json').write_bytes(b'{"name":"zero-npm","version":"1.0.0"}')
        Path('npm/zero/index.js').write_bytes(b'export const originalPublisher = true;\n')
        owner = '@zero_npm//:original_source'
        self.specification['npm_sources'] = [{'package': 'zero-npm', 'version': '1.0.0',
            'input': 'npm/zero', 'source_label': owner, 'workspace': False}]
        name = 'node_modules/zero/index.js'
        self.compiler['inputs'][name] = {**self.fact('npm/zero/index.js', owner), 'format': 'esm', 'imports': []}
        self.compiler['inputs']['main.ts']['imports'] = [{'path': name, 'kind': 'import-statement'}]
        self.declarations['node_modules/zero'] = {'input': 'npm/zero', 'link': True,
                                                'owner': owner, 'canonical': 'node_modules/zero'}
        self.refresh()
        self.assertEqual(self.produce()['packages'], [])

    def test_zero_wasm_refuses_a_derived_javascript_facade_without_generator_custody(self):
        self.zero_wasm()
        Path('main.ts').write_bytes(b'export const init = () => fetch(new URL("hidden.wasm", import.meta.url));\n')
        self.compiler['inputs']['main.ts'] = {**self.fact('main.ts', '//fixture:main.ts'),
                                            'format': 'esm', 'imports': []}
        self.specification['zero_source_inputs'][0]['authored'] = False
        self.refresh()
        self.refused('derived non-npm source without actual generator custody')

    def test_zero_wasm_cannot_drop_or_forge_original_sourcefile_properties(self):
        self.zero_wasm()
        self.specification['zero_source_inputs'] = None
        self.refused('configured compiler SourceFile properties')
        self.specification['zero_source_inputs'] = [{'input': 'main.ts', 'label': '@foreign//:main.ts',
                                                    'tree': False, 'authored': True}]
        self.refused('another workspace')

    def test_zero_wasm_rejects_original_file_loader_even_with_a_non_wasm_filename(self):
        self.zero_wasm()
        Path('main.ts').write_bytes(b'original file-loader WASM source bytes')
        self.compiler['inputs']['main.ts'] = {**self.fact('main.ts', '//fixture:main.ts'),
                                            'loader': 'file', 'compilerBytes': 0, 'imports': []}
        self.refresh()
        self.refused('actual selected WASM input')

    def test_zero_wasm_rejects_original_binary_magic_independently_of_names(self):
        self.zero_wasm()
        Path('main.ts').write_bytes(b'\0asm\x01\0\0\0')
        self.compiler['inputs']['main.ts'] = {**self.fact('main.ts', '//fixture:main.ts'), 'imports': []}
        self.refresh()
        self.refused('actual selected WASM input')

    def test_zero_wasm_rejects_observed_external_wasm_and_unresolved_internal_imports(self):
        self.zero_wasm()
        self.compiler['inputs']['main.ts']['imports'] = [{'path': 'selected.wasm', 'kind': 'import-statement', 'external': True}]
        self.refresh()
        self.refused('original WASM import observation')
        self.compiler['inputs']['main.ts']['imports'] = [{'path': 'missing-original.ts', 'kind': 'import-statement'}]
        self.refresh()
        self.refused('unresolved original compiler import')

    def test_zero_wasm_rejects_original_output_import_observations(self):
        self.zero_wasm()
        self.compiler['outputs']['binary']['imports'] = [{'path': 'selected.wasm', 'kind': 'import-statement', 'external': True}]
        self.refresh()
        self.refused('original WASM import observation')

    def test_zero_wasm_cannot_promote_unknown_generator_diagnostics_or_a_missing_source(self):
        self.zero_wasm()
        self.compiler['unmatched_generated_modules'] = ['unresolved original generator']
        self.refresh()
        self.refused('incomplete or unknown schema')
        self.compiler.pop('unmatched_generated_modules')
        self.declarations = {}
        self.refresh()
        self.refused('Invalid original source declarations')

    def test_zero_wasm_cannot_admit_changed_original_compiler_output(self):
        self.zero_wasm()
        Path('binary').write_bytes(b'changed original executable')
        self.refused('differ|mismatch')

    def test_exact_selected_member_preserves_projected_owner_and_complete_closure(self):
        value = self.produce()
        self.assertEqual(value['kind'], 'selected-wasm-attribution')
        self.assertEqual(value['pending_scopes'], [])
        self.assertEqual(value['packages'][0]['producer'], self.package_producer)
        self.assertEqual(value['packages'][0]['tree_label'], self.tree_owner)
        self.assertEqual([member['member'] for member in value['packages'][0]['members']], ['module.js'])
        self.assertEqual({item['id'] for item in value['components']},
                         {'generator-fixture', 'fixture@1.0.0', 'fixture-workspace#//:package.json'})
        self.assertEqual(value['rust_source_packages'][0]['metadata']['name'], 'fixture')
        self.assertEqual(value['rust_source_packages'][0]['texts'][0]['text'], Path('LICENSE').read_text())
        self.assertEqual(Path('result.txt').read_bytes(), wasm_inputs.closure.render(value))
        self.assertIn('generator-fixture', {item['id'] for item in value['generator_licenses']['components']})
        self.assertEqual(value['generator_licenses']['workspace_license']['text'], Path('LICENSE').read_text())
        self.assertEqual([fact['input'] for fact in value['generator_licenses']['authored_sources']],
                         ['Cargo.toml', 'bunfig.toml', 'optimizer.ts'])

    def frontend(self):
        self.producer = '//apps/web:frontend_precompressed'
        self.specification['producer'] = self.producer
        self.specification['artifact'] = {'input': 'web', 'label': self.producer}
        self.specification['frontend_checker'] = {
            'bun': {'input': str(bun), 'label': '@fixture_bun//:bun', 'tree': False},
            'runner': {'input': str(frontend_checker), 'label': '//tools/bazel/wasm:frontend-check.ts', 'tree': False},
            'config': {'input': str(bun_config), 'label': '//tools/bazel/bun:empty-bunfig.toml', 'tree': False},
            'modules': [{'input': str(frontend_checker.parent.parent / 'bun' / name),
                         'label': '//tools/bazel/bun:' + name, 'tree': False}
                        for name in ('npm-attribution.ts', 'compiler-inventory.ts', 'owned-files.ts', 'portable-path.ts')]}
        self.context = {'producer': self.producer, 'project': 'apps/web', 'precompression': True,
            'compiler_tooling': [],
            'frontend_build_id': '01234567-89ab-cdef-0123-456789abcdef', 'backend_origin': '',
            'opaque_public_key': '', 'build_commit': '', 'release_public_key': '',
            'public_release': {'origin': '', 'opaquePublicKey': '', 'releasePublicKey': '',
                               'version': '', 'sequence': 0}}
        Path('web').mkdir()
        Path('web/index.js').write_bytes(b'explicit synthetic frontend output; not compiler qualification')
        Path('web/module_bg.wasm').write_bytes(Path('package/module_bg.wasm').read_bytes())
        compression = subprocess.run([str(bun), '--no-install', '--no-env-file',
            '--config=' + str(bun_config), '--eval',
            "const{brotliCompressSync}=require('node:zlib');const{readFileSync,writeFileSync}=require('node:fs');"
            "for(const f of ['web/index.js','web/module_bg.wasm'])writeFileSync(f+'.br',brotliCompressSync(readFileSync(f)));"],
            env={'PATH': '', 'HOME': str(self.root), 'TMPDIR': str(self.root)}, capture_output=True)
        self.assertEqual(compression.returncode, 0, compression.stderr.decode())
        self.compiler['inputs']['package/module_bg.wasm'] = self.fact('package/module_bg.wasm', self.tree_owner)
        for name, item in self.compiler['inputs'].items():
            item['imports'] = [{'path': 'package/module.js', 'kind': 'import-statement'}] if name == 'main.ts' else []
        self.compiler['unmatched_generated_modules'] = []
        self.compiler['unmatched_generated_assets'] = []
        self.compiler['outputs'] = {}
        self.compiler['artifacts'] = {}
        for file in sorted(Path('web').iterdir()):
            original = file.name.removesuffix('.br')
            selected = ({'public_input': 'package/module_bg.wasm'} if original == 'module_bg.wasm'
                        else {'observations': [{'environment': 'client', 'type': 'chunk', 'selected':
                              [{'id': 'module.js', 'source': 'package/module.js'}, {'id': 'main.ts', 'source': 'main.ts'}]}]})
            raw = file.read_bytes()
            output = {'bytes': len(raw), **selected}
            if file.name.endswith('.br'):
                output['compressed_from'] = original
            self.compiler['outputs'][file.name] = output
            self.compiler['artifacts'][file.name] = {'bytes': len(raw), 'sha256': wasm_inputs.npm.sha256(raw)}
        self.refresh()

    def test_frontend_original_observation_public_wasm_and_brotli_tree(self):
        self.frontend()
        value = self.produce()
        self.assertEqual(value['producer'], self.producer)
        self.assertEqual(len(value['artifacts']), 4)
        self.assertEqual(value['pending_scopes'], [])
        self.assertEqual({member['member'] for member in value['packages'][0]['members']},
                         {'module.js', 'module_bg.wasm'})

    def test_frontend_unresolved_generated_origins_cannot_complete_scope(self):
        self.frontend()
        self.compiler['unmatched_generated_assets'] = ['original unmapped asset']
        self.refresh()
        self.refused('unresolved generated source custody')

    def test_frontend_context_and_complete_inventory_schema_are_required(self):
        self.frontend()
        self.context['compile_target'] = 'bun-darwin-arm64'
        self.refresh()
        self.refused('supported precompressed frontend context')

    def test_frontend_compressed_bytes_and_public_selection_are_original(self):
        self.frontend()
        self.compiler['outputs']['module_bg.wasm']['public_input'] = 'main.ts'
        self.compiler['outputs']['module_bg.wasm.br']['public_input'] = 'main.ts'
        self.refresh()
        self.refused('public output differs from original source bytes')

    def test_frontend_brotli_pair_refuses_rekeyed_corrupt_compression(self):
        self.frontend()
        Path('web/index.js.br').write_bytes(b'not an original Brotli image')
        raw = Path('web/index.js.br').read_bytes()
        self.compiler['artifacts']['index.js.br'] = {'bytes': len(raw), 'sha256': wasm_inputs.npm.sha256(raw)}
        self.compiler['outputs']['index.js.br']['bytes'] = len(raw)
        self.refresh()
        self.refused('frontend attribution validator refused')

    def test_authored_generator_sources_need_exact_original_action_and_license_origin(self):
        original = self.origin['generator_sources']
        self.origin['generator_sources'] = []
        self.refused('empty declaration')
        self.origin['generator_sources'] = [{'input': 'source.rs', 'label': '//fixture:source.rs', 'tree': False}]
        self.refused('outside its original action input closure')
        self.origin['generator_sources'] = original
        original[0]['label'] = '@external//:optimizer.ts'
        self.refused('External authored generator SourceFile')

    def test_generation_executable_must_be_actual_declared_tool_file(self):
        configuration = wasm_inputs.pack.load_json(Path('bindings.generation.json').read_bytes())
        configuration['executable'] = {'input': 'source.rs', 'label': '//fixture:source.rs', 'tree': False}
        self.write('bindings.generation.json', configuration)
        self.refused('exact original declared tool File')

    def test_generator_license_producer_absence_and_duplicate_refuse(self):
        self.specification['generator_attributions'] = []
        self.refused('complete source/license attribution')
        self.specification['generator_attributions'] = [self.generator_provider] * 2
        self.refused('repeats an original executed artifact')

    def test_pending_or_mutated_generator_artifact_cannot_be_admitted(self):
        self.generator_inventory['pending_scopes'] = ['embedded-runtime']
        self.refresh_generator()
        self.refused('pending or belongs to another original compilation')
        self.generator_inventory['pending_scopes'] = []
        self.generator_inventory['artifacts'][0]['sha256'] = '0' * 64
        self.refresh_generator()
        self.refused('executed artifact bytes')

    def test_generator_configuration_source_notice_bytes_and_owners_refuse_drift(self):
        for name in ('configuration', 'source_inventory', 'inventory', 'notices'):
            with self.subTest(output=name):
                old = self.generator_provider[name]['label']
                self.generator_provider[name]['label'] = '//foreign:attribution'
                self.refused('different original actions')
                self.generator_provider[name]['label'] = old
        Path('generator-source_inventory').write_bytes(b'{"changed":true}\n')
        self.refused('pending or belongs to another original compilation')

    def test_generator_published_license_mutation_and_unowned_provider_refuse(self):
        self.generator_inventory['components'][0]['texts'][0]['text'] = 'Foreign replacement license\n'
        self.refresh_generator()
        self.refused('differs from selected component bytes')

    def test_invoked_optimizer_requires_its_own_original_license_producer(self):
        Path('second-tool').write_bytes(b'explicit synthetic second executable')
        Path('second-tool').chmod(0o755)
        descriptor = {'input': 'second-tool', 'label': '//fixture:second-tool', 'tree': False}
        self.origin['generator_inputs'].append(descriptor)
        configuration = wasm_inputs.pack.load_json(Path('optimizer.generation.json').read_bytes())
        configuration['tools'].append(descriptor)
        configuration['arguments'][7] = 'second-tool'
        self.write('optimizer.generation.json', configuration)
        self.refused('omits an executed tool')

    def test_same_native_boundary_handles_every_declared_platform(self):
        for target in sorted(helper.NATIVE_COMPILE_TARGETS):
            with self.subTest(target=target):
                self.context['compile_target'] = target
                self.refresh()
                self.assertEqual(self.produce()['pending_scopes'], [])
                Path('result.json').unlink()
                Path('result.txt').unlink()

    def test_mutated_unselected_member_refuses_complete_original_inventory(self):
        Path('package/module_bg.wasm').write_bytes(b'changed unselected package member')
        self.refused('bytes differ from original producer inventory')

    def test_foreign_compiler_member_owner_and_bytes_refuse(self):
        self.compiler['inputs']['package/module.js']['owner'] = '//foreign:owner'
        self.write('compiler.json', self.compiler)
        self.refused('owner differs')
        self.compiler['inputs']['package/module.js'] = self.fact('package/module.js', self.tree_owner)
        self.compiler['inputs']['package/module.js']['sha256'] = '0' * 64
        self.write('compiler.json', self.compiler)
        self.refused('differs from declared source bytes')

    def test_foreign_wasm_without_typed_package_refuses(self):
        Path('foreign.wasm').write_bytes(b'\0asm\x01\0\0\0')
        self.compiler['inputs']['foreign.wasm'] = self.fact('foreign.wasm', '//foreign:foreign.wasm')
        self.declarations['foreign.wasm'] = {'input': 'foreign.wasm', 'link': False,
                                            'owner': '//foreign:foreign.wasm', 'canonical': 'foreign.wasm'}
        self.refresh()
        self.refused('no original typed member custody')

    def test_original_inventory_and_artifact_mismatches_refuse(self):
        self.descriptor['inventory']['label'] = '//foreign:inventory'
        self.refused('inventory belongs to another original producer')
        self.descriptor['inventory']['label'] = self.package_producer
        self.specification['artifact']['label'] = '//scripts:release_verifier'
        self.refused('artifact belongs to another configured producer')

    def test_empty_packages_or_empty_selection_cannot_claim_absence(self):
        self.specification['wasm_packages'] = []
        self.refused('exact empty typed producer mappings')
        self.specification['wasm_packages'] = [self.descriptor]
        del self.compiler['inputs']['package/module.js']
        self.refresh()
        self.refused('selected no original WASM package member')

    def test_missing_or_foreign_original_rust_graph_and_generation_chain_refuse(self):
        origins = self.specification['compiler_origins']
        self.specification['compiler_origins'] = {}
        self.refused('original configured compiler chain')
        self.specification['compiler_origins'] = origins
        self.origin['root'] = '2' * 64
        self.refused('actual configured WASM cdylib')
        self.origin['root'] = '1' * 64
        self.origin['generator_configurations'].pop()
        self.refused('action chain is incomplete')

    def test_original_generator_edges_cannot_point_at_a_foreign_compiler(self):
        configuration = wasm_inputs.pack.load_json(Path('bindings.generation.json').read_bytes())
        configuration['inputs'] = [{'input': 'tool', 'label': '//fixture:tool', 'tree': False}]
        self.write('bindings.generation.json', configuration)
        self.refused('disconnected from its compiler')

    def test_original_selected_rust_license_bytes_and_package_closure_refuse_drift(self):
        Path('LICENSE').write_bytes(b'changed declared license File')
        self.refused('differs from original package File bytes')
        Path('LICENSE').write_bytes(Path('source-tree/LICENSE').read_bytes())
        self.specification['rust_packages'] = {}
        self.refused('source/license packages required')

    def test_missing_or_foreign_wasm_rust_producer_cannot_complete_scope(self):
        self.specification['rust_attributions'] = {}
        self.refused('original compiled Rust attribution')
        self.specification['rust_attributions'] = {self.package_producer: self.rust_provider}
        self.rust_provider['artifacts'][0]['label'] = '//foreign:wasm'
        self.refused('exact original compiled File')

    def test_pending_stdlib_or_host_runtime_cannot_complete_wasm_scope(self):
        self.rust_inventory['pending_scopes'] = ['wasm-host-proc-macro']
        self.refresh_rust()
        self.refused('pending or belongs to another original compilation')
        self.rust_inventory['pending_scopes'] = []
        self.rust_sources['standard_library'] = []
        self.refresh_rust()
        self.refused('selected linked standard-library')

    def test_wasm_rust_output_owner_and_actual_bytes_are_bound(self):
        self.rust_provider['source_inventory']['label'] = '//foreign:attribution'
        self.refused('different original actions')
        self.rust_provider['source_inventory']['label'] = '//fixture:rust-attribution'
        self.rust_inventory['artifacts'][0]['sha256'] = '0' * 64
        self.refresh_rust()
        self.refused('exact original compiled output bytes')

    def test_wasm_rust_configuration_graph_and_source_closure_are_bound(self):
        self.rust_configuration['root'] = '2' * 64
        self.refresh_rust()
        self.refused('original configured compiler graph')
        self.rust_configuration['root'] = '1' * 64
        self.rust_sources['compiler_inputs'][0]['label'] = '//foreign:source.rs'
        self.refresh_rust()
        self.refused('foreign or changed compiler source Files')

    def test_wasm_rust_notices_and_source_digest_are_bound(self):
        Path('rust-source_inventory').write_bytes(b'{"changed":true}\n')
        self.refused('pending or belongs to another original compilation')
        self.refresh_rust()
        Path('rust-notices').write_bytes(b'foreign replacement notice')
        self.refused('original complete selected attribution')

    def test_authored_generator_manifest_is_original_private_unversioned_source(self):
        self.specification['workspace_package']['label'] = '//foreign:package.json'
        self.refused('Original authored Rust workspace package manifest required')
        self.specification['workspace_package']['label'] = '//:package.json'
        self.write('package.json', {'name': 'fixture-workspace', 'private': True,
                                  'license': 'AGPL-3.0-only', 'version': '0.0.0'})
        self.refused('Private component differs from original workspace manifest')

    def test_authored_rust_sources_use_exact_original_root_license(self):
        Path('source-tree/LICENSE').unlink()
        package = self.specification['rust_packages']['fixture@1.0.0']
        package['files'] = [item for item in package['files'] if item['input'] != 'LICENSE']
        value = self.produce()
        self.assertEqual(value['rust_source_packages'][0]['texts'][0]['label'], '//:LICENSE')
        Path('result.json').unlink()
        Path('result.txt').unlink()
        package['authored'] = False
        self.refused('outside its original declared source Files')

    def test_foreign_authored_manifest_cannot_inherit_workspace_license(self):
        package = self.specification['rust_packages']['fixture@1.0.0']
        package['manifest'] = {**package['manifest'], 'label': '@foreign//:Cargo.toml'}
        self.refused('exact original workspace SourceFiles')

    def test_authored_rust_license_must_match_actual_root_package_metadata(self):
        Path('source-tree/LICENSE').unlink()
        package = self.specification['rust_packages']['fixture@1.0.0']
        package['files'] = [item for item in package['files'] if item['input'] != 'LICENSE']
        self.write('package.json', {'name': 'fixture-workspace', 'private': True, 'license': 'MIT'})
        self.refused('outside its original declared source Files')

    def test_linkage_is_required_and_bound_to_actual_compiler_module(self):
        original = self.rust_sources['module_linkage']
        self.rust_sources['module_linkage'] = {'pending_scopes': []}
        self.refresh_rust()
        self.refused('actual matching module linkage')
        self.rust_sources['module_linkage'] = original
        original['artifact']['label'] = '//foreign:wasm'
        self.refresh_rust()
        self.refused('actual matching module linkage')

    def test_original_publisher_map_archive_and_selected_stdlib_bytes_are_required(self):
        Path('link-map').write_bytes(b'changed original action map')
        self.refused('original action input File bytes')

    def test_selected_stdlib_must_belong_to_actual_configured_compiler_files(self):
        self.rust_sources['module_linkage']['selected_stdlib'][0]['label'] = '//foreign:stdlib'
        self.refresh_rust()
        self.refused('original action input File bytes')

    def test_host_proc_macro_scope_cannot_be_replaced_by_empty_closure(self):
        unit = wasm_inputs.pack.load_json(self.origin['units'][0])
        child = {**unit, 'unit': '2' * 64, 'crate_type': 'proc-macro',
                 'compiler': {'target': 'aarch64-apple-darwin'}, 'dependencies': []}
        unit['dependencies'] = [child['unit']]
        self.origin['units'] = [wasm_inputs.pack.canonical(value).decode('utf8') for value in (unit, child)]
        self.rust_configuration['units'] = [unit, child]
        self.refresh_rust()
        self.refused('omits an actual executed host proc-macro')

    def host_macro(self):
        unit = wasm_inputs.pack.load_json(self.origin['units'][0])
        child = {**unit, 'unit': '2' * 64, 'crate_type': 'proc-macro',
                 'compiler': {'target': 'aarch64-apple-darwin'}, 'dependencies': []}
        unit['dependencies'] = [child['unit']]
        self.origin['units'] = [wasm_inputs.pack.canonical(value).decode('utf8') for value in (unit, child)]
        self.rust_configuration['units'] = [unit, child]
        raw = b'explicit synthetic host proc-macro module, not native compiler qualification'
        Path('host-macro').write_bytes(raw)
        artifact = {'path': 'host-macro', 'label': '//fixture:u_' + child['unit'],
                    'size': len(raw), 'sha256': wasm_inputs.npm.sha256(raw)}
        configuration = {'kind': 'configured-native-rust-release', 'root': child['unit'],
            'target': child['compiler']['target'], 'profile': 'release', 'producer': artifact['label'],
            'units': [child]}
        linkage = {**self.rust_sources['module_linkage'], 'artifact': artifact,
                   'target': child['compiler']['target']}
        sources = {'module_linkage': linkage, 'standard_library': self.rust_sources['standard_library']}
        inventory = {'kind': 'selected-native-rust-attribution', 'producer': artifact['label'],
            'target': child['compiler']['target'], 'profile': 'release', 'pending_scopes': [],
            'configuration': wasm_inputs.npm.sha256(wasm_inputs.pack.canonical(configuration)),
            'source_digest': wasm_inputs.npm.sha256(wasm_inputs.pack.canonical(sources)),
            'artifacts': [{'path': 'host-macro', 'mode': '0444', **{key: artifact[key] for key in ('label', 'size', 'sha256')}}],
            'components': self.rust_inventory['components']}
        self.write('host-inventory', inventory)
        Path('host-notices').write_bytes(wasm_inputs.closure.render(inventory))
        def fact(filename, label):
            raw = Path(filename).read_bytes()
            return {'path': filename, 'label': label, 'size': len(raw), 'sha256': wasm_inputs.npm.sha256(raw)}
        row = {'artifact': artifact, 'configuration': configuration, 'source_inventory': sources,
               'inventory': fact('host-inventory', '//fixture:host-attribution'),
               'notices': fact('host-notices', '//fixture:host-attribution')}
        self.rust_sources['host_proc_macros'] = [row]
        for value in (artifact, row['inventory'], row['notices']):
            self.specification['rust_attribution_inputs'][self.package_producer].append(
                {'input': value['path'], 'label': value['label'], 'tree': False})
        self.refresh_rust()
        return row

    def test_actual_host_proc_macro_graph_module_runtime_and_notice_join(self):
        self.host_macro()
        self.assertEqual(self.produce()['pending_scopes'], [])

    def host_notices(self, row, inventory):
        self.write('host-inventory', inventory)
        Path('host-notices').write_bytes(wasm_inputs.closure.render(inventory))
        for name in ('inventory', 'notices'):
            raw = Path(row[name]['path']).read_bytes()
            row[name]['size'] = len(raw)
            row[name]['sha256'] = wasm_inputs.npm.sha256(raw)
        self.refresh_rust()

    def test_frontend_validator_cannot_drop_an_original_imported_source(self):
        self.frontend()
        self.specification['frontend_checker']['modules'].pop()
        self.refused('exact original helper/imported SourceFiles')

    def test_frontend_imported_validator_source_change_retires_the_output(self):
        self.frontend()
        checker = self.specification['frontend_checker']
        local = Path('frontend-validator')
        (local / 'wasm').mkdir(parents=True)
        (local / 'bun').mkdir()
        local_runner = local / 'wasm/frontend-check.ts'
        local_runner.write_bytes(Path(checker['runner']['input']).read_bytes())
        checker['runner']['input'] = str(local_runner)
        for descriptor in checker['modules']:
            target = local / 'bun' / Path(descriptor['input']).name
            target.write_bytes(Path(descriptor['input']).read_bytes())
            descriptor['input'] = str(target)
        invoke = helper.subprocess.run
        def edited(*args, **kwargs):
            result = invoke(*args, **kwargs)
            Path(checker['modules'][0]['input']).write_bytes(b'changed actual imported validator')
            return result
        with patch.object(helper.subprocess, 'run', edited):
            self.refused('input file identity changed')

    def test_actual_host_license_components_are_in_the_terminal_wasm_scope(self):
        row = self.host_macro()
        inventory = json.loads(Path('host-inventory').read_text())
        component = json.loads(json.dumps(inventory['components'][0]))
        component.update({'id': 'host-original@1.0.0', 'name': 'host-original'})
        inventory['components'] = [component]
        self.host_notices(row, inventory)
        self.assertIn('host-original@1.0.0', {component['id'] for component in self.produce()['components']})

    def test_conflicting_actual_host_license_component_cannot_replace_a_wasm_component(self):
        row = self.host_macro()
        inventory = json.loads(Path('host-inventory').read_text())
        inventory['components'][0]['repository'] = 'https://original-host.example/foreign-repository'
        self.host_notices(row, inventory)
        self.refused('Conflicting original WASM Rust source/license component')

    def test_host_proc_macro_native_runtime_cannot_stay_pending(self):
        row = self.host_macro()
        row['source_inventory']['module_linkage']['pending_scopes'] = ['native-runtime']
        self.refresh_rust()
        self.refused('pending or differs from original compilation')

    def test_host_proc_macro_notice_bytes_and_original_input_custody_are_required(self):
        self.host_macro()
        Path('host-notices').write_bytes(b'foreign native host notices')
        self.refused('original action input File bytes')

    def test_original_publisher_input_closure_cannot_be_dropped(self):
        self.specification['rust_attribution_inputs'] = {}
        self.refused('original action input Files')

    def test_wasm_rust_notices_need_exact_configured_source_license_package(self):
        component = self.rust_inventory['components'][0]
        component['id'] = 'foreign-package'
        self.refresh_rust()
        self.refused('original configured source package')
        component['id'] = 'fixture@1.0.0'
        component['texts'][0]['text'] = 'Self-consistent but foreign publisher license'
        component['texts'][0]['size'] = len(component['texts'][0]['text'].encode('utf8'))
        component['texts'][0]['sha256'] = wasm_inputs.npm.sha256(component['texts'][0]['text'].encode('utf8'))
        self.refresh_rust()
        self.refused('original selected package license File')

    def test_mutated_rust_license_cannot_be_published(self):
        self.rust_inventory['components'][0]['texts'][0]['text'] = 'Foreign license text'
        self.refresh_rust()
        self.refused('differs from selected component bytes')

    def test_publication_rechecks_original_files_and_preserves_unowned_output(self):
        outputs = wasm_inputs.pack.ArchiveOutputs
        opened = outputs.open
        def changed(instance, index):
            stream = opened(instance, index)
            if index == 0:
                Path('package/module.js').write_bytes(b'retargeted during publication')
            return stream
        with patch.object(outputs, 'open', changed):
            self.refused('input file identity changed')
        self.compiler['inputs']['package/module.js'] = self.fact('package/module.js', self.tree_owner)
        self.refresh()
        Path('result.json').write_bytes(b'unrelated owner')
        with self.assertRaises(FileExistsError):
            self.produce()
        self.assertEqual(Path('result.json').read_bytes(), b'unrelated owner')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', required=True)
    parser.add_argument('--wasm-inputs', required=True)
    parser.add_argument('--bun', required=True)
    parser.add_argument('--frontend-checker', required=True)
    parser.add_argument('--bun-config', required=True)
    arguments = parser.parse_args()
    bun = Path(arguments.bun).resolve(strict=True)
    frontend_checker = Path(arguments.frontend_checker).resolve(strict=True)
    bun_config = Path(arguments.bun_config).resolve(strict=True)
    helper = load('selected_wasm', arguments.helper)
    wasm_inputs = load('wasm_inputs', arguments.wasm_inputs)
    unittest.main(argv=['selected-wasm-controls'])
