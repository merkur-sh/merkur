"""Typed npm producer, compiler membership, origin and publication controls."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location('npm_notices', Path(__file__).with_name('npm-notices.py'))
notices = importlib.util.module_from_spec(loader)
loader.loader.exec_module(notices)


class NpmNotices(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        original = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, original)
        self.source = {'input': 'package', 'package': 'dependency', 'version': '1.0.0(peer@2.0.0)', 'source_label': '@@//:.aspect_rules_js/node_modules/dependency@1.0.0_peer@2.0.0', 'workspace': False}
        Path('package').mkdir()
        Path('package/package.json').write_text('{"name":"dependency","version":"1.0.0","license":"MIT","repository":{"url":"https://example.invalid/dependency"}}')
        Path('package/LICENSE').write_text('Published license text\n')
        Path('package/app.js').write_text('export const value = 7;\n')
        Path('program.bin').write_bytes(b'compiled synthetic program')
        Path('program.bin').chmod(0o755)
        self.compiler = {'inputs': {'node_modules/dependency/app.js': {'bytes': len(Path('package/app.js').read_bytes()), 'sha256': notices.sha256(Path('package/app.js').read_bytes()), 'owner': '@@//:dependency'}}, 'outputs': {}, 'artifacts': {'program.bin': {'bytes': len(Path('program.bin').read_bytes()), 'sha256': notices.sha256(Path('program.bin').read_bytes())}}}
        self.declarations = {'node_modules/dependency': {'input': 'package', 'link': True, 'owner': '@@//:dependency', 'canonical': 'node_modules/dependency'}}
        self.configuration = {'producer': '@@//application:program', 'compile_target': 'bun-darwin-arm64', 'compiler_tooling': []}
        self.registry = {'dependency@1.0.0': {'integrity': 'sha512-' + base64.b64encode(b'x' * 64).decode(), 'tarball': 'https://registry.npmjs.org/dependency/-/dependency-1.0.0.tgz'}}
        self.spec = {'producer': '@@//application:program', 'artifact': {'input': 'program.bin', 'label': '@@//application:program'}, 'manifest': 'manifest.json', 'compiler_inventory': 'compiler.json', 'declarations': 'declarations.json', 'configuration': 'configuration.json', 'npm_source_inventory': 'sources.json', 'registry': 'registry.json', 'sources': [self.source]}
        self.refresh()

    def write(self, name, value):
        Path(name).write_text(json.dumps(value, separators=(',', ':')))

    def refresh(self):
        for name, value in [('compiler.json', self.compiler), ('declarations.json', self.declarations), ('configuration.json', self.configuration), ('sources.json', [self.source]), ('registry.json', self.registry)]:
            self.write(name, value)
        context = {'settings_sha256': notices.sha256(Path('configuration.json').read_bytes()), 'npm_sources_sha256': notices.sha256(Path('sources.json').read_bytes())}
        component_id = 'dependency@1.0.0#' + notices.sha256(self.source['source_label'].encode())
        locked = self.registry['dependency@1.0.0']
        pending = ['first-party'] if self.configuration['producer'].lstrip('@') == '//apps/server:migrations' else ['first-party', 'wasm', 'embedded-runtime']
        if self.configuration['producer'].lstrip('@') == '//apps/web:frontend_precompressed':
            pending = ['first-party', 'wasm'] + (['compiler-tooling'] if self.configuration.get('compiler_tooling') else [])
        self.manifest = {'kind': 'compiler-selected-npm-attribution', 'expected': {'producer': self.configuration['producer'].lstrip('@'), 'configuration': notices.sha256(json.dumps(context, separators=(',', ':')).encode()), 'source_digest': notices.sha256(Path('compiler.json').read_bytes()), 'components': [{'id': component_id, 'name': 'dependency', 'version': '1.0.0', 'source': locked['tarball'] + ' ' + locked['integrity'], 'license': 'MIT', 'repository': 'https://example.invalid/dependency', 'license_file': None, 'source_label': self.source['source_label'][2:]}]}, 'configuration_authority': context, 'compiler_inventory_sha256': notices.sha256(Path('compiler.json').read_bytes()), 'registry_inventory_sha256': notices.sha256(Path('registry.json').read_bytes()), 'authorities': [{'id': component_id, 'resolver_version': self.source['version'], 'package_json_sha256': notices.sha256(Path('package/package.json').read_bytes()), 'registry_integrity': locked['integrity'], 'registry_tarball': locked['tarball']}], 'materializations': {component_id: {'root': self.source['input'], 'label': self.source['source_label'][2:]}}, 'pending_scopes': pending, 'selected_workspace_sources': []}
        self.write('manifest.json', self.manifest)

    def test_real_context_peer_source_and_published_text(self):
        inventory = notices.collect(self.spec)
        self.assertEqual(inventory['kind'], 'npm-attribution-intermediate')
        self.assertEqual(inventory['components'][0]['texts'][0]['text'], 'Published license text\n')
        self.assertEqual(inventory['authorities'][0]['resolver_version'], self.source['version'])
        self.assertEqual(inventory['pending_scopes'], ['first-party', 'wasm', 'embedded-runtime'])

    def test_canonical_direct_row_keeps_original_file_custody_not_alias_origin(self):
        canonical = '.aspect_rules_js/node_modules/dependency@1.0.0'
        fact = self.compiler['inputs'].pop('node_modules/dependency/app.js')
        self.compiler['inputs'][canonical + '/app.js'] = fact
        Path('alias').symlink_to(Path('package').resolve(), target_is_directory=True)
        self.declarations = {
            canonical: {'input': 'package', 'link': True, 'owner': '@@//:dependency',
                        'canonical': canonical},
            'node_modules/dependency': {'input': 'alias', 'link': True,
                                       'owner': '//alias:dependency', 'canonical': canonical},
        }
        self.refresh()
        inventory = notices.collect(self.spec)
        self.assertEqual([item['name'] for item in inventory['components']], ['dependency'])
        self.declarations.pop(canonical)
        self.refresh()
        with self.assertRaisesRegex(ValueError, 'Compiler input has no declared materialization'):
            notices.collect(self.spec)

    def test_required_canonical_shape_refuses_old_and_unsafe_placements(self):
        original = copy.deepcopy(self.declarations)
        for canonical in [None, True, '', '/outside', '../outside', 'a/../outside',
                          'a\\outside', 'a/./outside']:
            with self.subTest(canonical=canonical):
                self.declarations = copy.deepcopy(original)
                row = self.declarations['node_modules/dependency']
                if canonical is None:
                    row.pop('canonical')
                else:
                    row['canonical'] = canonical
                self.refresh()
                with self.assertRaisesRegex(ValueError, 'source declaration|license input path'):
                    notices.collect(self.spec)

    def test_coherent_manifest_cannot_omit_or_add_compiler_packages(self):
        for change in ['missing', 'extra']:
            with self.subTest(change=change):
                value = copy.deepcopy(self.manifest)
                if change == 'missing':
                    value['expected']['components'] = []
                    value['authorities'] = []
                    value['materializations'] = {}
                else:
                    fake = copy.deepcopy(value['expected']['components'][0])
                    fake['id'] += '-unused'
                    value['expected']['components'].append(fake)
                    value['authorities'].append({**value['authorities'][0], 'id': fake['id']})
                    value['materializations'][fake['id']] = value['materializations'][value['expected']['components'][0]['id']]
                self.write('manifest.json', value)
                with self.assertRaises(ValueError):
                    notices.collect(self.spec)

    def test_original_file_context_digest_and_raw_typed_labels_bind(self):
        for change in ['producer', 'source', 'settings', 'resolver', 'registry', 'pending']:
            with self.subTest(change=change):
                self.refresh()
                spec = copy.deepcopy(self.spec)
                if change == 'producer':
                    spec['producer'] = '//application:other'
                elif change == 'source':
                    Path('package/app.js').write_text('export const value = 9;\n')
                elif change == 'settings':
                    self.write('configuration.json', {**self.configuration, 'compile_target': 'bun-linux-x64'})
                elif change == 'resolver':
                    spec['sources'][0]['version'] = '1.0.0(peer@3.0.0)'
                elif change == 'registry':
                    self.write('registry.json', {**self.registry, 'unused@1.0.0': {}})
                else:
                    self.write('manifest.json', {**self.manifest, 'pending_scopes': []})
                with self.assertRaises(ValueError):
                    notices.collect(spec)
                Path('package/app.js').write_text('export const value = 7;\n')

    def test_original_license_alias_and_missing_text_are_rejected(self):
        Path('package/LICENSE').unlink()
        Path('package/unrelated.txt').write_text('Not a published license\n')
        Path('package/LICENSE').symlink_to('unrelated.txt')
        with self.assertRaises(ValueError):
            notices.collect(self.spec)
        Path('package/LICENSE').unlink()
        with self.assertRaises(ValueError):
            notices.collect(self.spec)

    def test_exact_engine_tree_carriers_preserve_original_member_identity(self):
        carrier = Path('carrier')
        carrier.mkdir()
        for file in Path('package').iterdir():
            (carrier / file.name).symlink_to(file.absolute())
        self.assertEqual(notices.package_origin(carrier), Path('package').absolute())
        Path('outside').mkdir()
        Path('outside/LICENSE').write_text('Published license text\n')
        (carrier / 'LICENSE').unlink()
        (carrier / 'LICENSE').symlink_to(Path('outside/LICENSE').absolute())
        with self.assertRaises(ValueError):
            notices.package_origin(carrier)

    def test_standalone_artifact_fact_is_mandatory_and_cannot_follow_foreign_bytes(self):
        Path('program.bin').write_bytes(b'changed foreign compiled artifact')
        with self.assertRaisesRegex(ValueError, 'Compiler output bytes differ'):
            notices.collect(self.spec)
        Path('program.bin').write_bytes(b'compiled synthetic program')
        value = copy.deepcopy(self.spec)
        value['artifact']['label'] = '//foreign:program'
        with self.assertRaisesRegex(ValueError, 'another configured producer'):
            notices.collect(value)
        self.compiler['artifacts']['other-name.bin'] = self.compiler['artifacts'].pop('program.bin')
        self.refresh()
        with self.assertRaisesRegex(ValueError, 'Compiler output membership differs'):
            notices.collect(self.spec)

    def migration(self):
        self.configuration = {'producer': '@@//apps/server:migrations', 'target': 'bun',
                              'entry_points': ['apps/server/migrations/001_initial_schema.ts'],
                              'root': 'apps/server/migrations', 'compiler_tooling': []}
        self.spec['producer'] = self.configuration['producer']
        self.spec['artifact'] = {'input': 'emitted', 'label': self.configuration['producer']}
        Path('emitted').mkdir()
        self.compiler['artifacts'] = {}
        for name in ['001_initial_schema.js', '002_box_identity.js',
                     '003_account_privilege.js', '004_notification_outbox.js']:
            data = b'compiled synthetic migration\n'
            Path('emitted', name).write_bytes(data)
            self.compiler['artifacts'][name] = {'bytes': len(data), 'sha256': notices.sha256(data)}
        self.refresh()

    def test_migration_selected_npm_and_same_actual_bundle_artifact(self):
        self.migration()
        inventory = notices.collect(self.spec)
        self.assertEqual(inventory['producer'], '//apps/server:migrations')
        self.assertEqual(inventory['pending_scopes'], ['first-party'])
        self.assertEqual([item['name'] for item in inventory['components']], ['dependency'])
        self.assertEqual(len(inventory['artifacts']), 4)
        self.assertEqual(inventory, notices.collect(self.spec))
        for fact in inventory['artifacts']:
            filename = Path('emitted') / fact['path'].removeprefix('migrations/')
            self.assertEqual(fact['sha256'], notices.sha256(filename.read_bytes()))

    def test_migration_artifact_byte_member_fact_and_context_drift_refuse(self):
        self.migration()
        original = copy.deepcopy(self.compiler)
        for change in ['bytes', 'member', 'digest', 'size', 'missing-fact', 'artifact-owner', 'pending', 'bundle-context']:
            with self.subTest(change=change):
                self.compiler = copy.deepcopy(original)
                Path('emitted/001_initial_schema.js').write_bytes(b'compiled synthetic migration\n')
                self.refresh()
                spec = copy.deepcopy(self.spec)
                if change == 'bytes':
                    Path('emitted/001_initial_schema.js').write_bytes(b'foreign same producer path')
                elif change == 'member':
                    Path('emitted/001_initial_schema.js').unlink()
                elif change == 'digest':
                    self.compiler['artifacts']['001_initial_schema.js']['sha256'] = '0' * 64
                    self.refresh()
                elif change == 'size':
                    self.compiler['artifacts']['001_initial_schema.js']['bytes'] = True
                    self.refresh()
                elif change == 'missing-fact':
                    self.compiler['artifacts'].pop('001_initial_schema.js')
                    self.refresh()
                elif change == 'artifact-owner':
                    spec['artifact']['label'] = '//foreign:bundle'
                elif change == 'pending':
                    self.manifest['pending_scopes'] = []
                    self.write('manifest.json', self.manifest)
                else:
                    self.configuration.pop('entry_points')
                    self.refresh()
                with self.assertRaises(ValueError):
                    notices.collect(spec)

    def test_coherent_source_omission_and_foreign_same_byte_file_refuse(self):
        self.migration()
        manifest = copy.deepcopy(self.manifest)
        self.spec['sources'] = []
        self.write('sources.json', [])
        context = {'settings_sha256': notices.sha256(Path('configuration.json').read_bytes()),
                   'npm_sources_sha256': notices.sha256(Path('sources.json').read_bytes())}
        manifest['configuration_authority'] = context
        manifest['expected']['configuration'] = notices.sha256(json.dumps(context, separators=(',', ':')).encode())
        manifest['expected']['components'] = []
        manifest['authorities'] = []
        manifest['materializations'] = {}
        self.write('manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'Empty attribution graph'):
            notices.collect(self.spec)
        self.spec['sources'] = [self.source]
        self.refresh()
        Path('foreign.js').write_bytes(Path('package/app.js').read_bytes())
        self.declarations = {'node_modules/dependency/app.js':
                             {'input': 'foreign.js', 'link': True, 'owner': '//foreign:generated', 'canonical': 'node_modules/dependency/app.js'}}
        self.compiler['inputs']['node_modules/dependency/app.js']['owner'] = '//foreign:generated'
        self.refresh()
        with self.assertRaisesRegex(ValueError, 'typed source owner'):
            notices.collect(self.spec)

    def test_original_declared_owner_and_old_compiler_shape_cannot_be_coerced(self):
        self.compiler['inputs']['node_modules/dependency/app.js']['owner'] = '//foreign:generated'
        self.refresh()
        with self.assertRaisesRegex(ValueError, 'original declaration'):
            notices.collect(self.spec)
        self.compiler['inputs']['node_modules/dependency/app.js']['owner'] = '@@//:dependency'
        self.compiler.pop('artifacts')
        self.refresh()
        with self.assertRaisesRegex(ValueError, 'compiler source inventory'):
            notices.collect(self.spec)

    def frontend(self):
        """Actual-shaped compiler observations; fixtures do not qualify native Vite."""
        producer = '//apps/web:frontend_precompressed'
        self.configuration = {'producer': producer, 'project': 'apps/web',
                              'frontend_build_id': '00000000-0000-0000-0000-000000000001',
                              'backend_origin': 'https://example.invalid', 'opaque_public_key': '',
                              'build_commit': 'fixture', 'release_public_key': '',
                              'public_release': {'version': 'fixture', 'sequence': 0,
                                                 'origin': 'https://example.invalid',
                                                 'opaquePublicKey': '', 'releasePublicKey': ''},
                              'precompression': True, 'compiler_tooling': []}
        self.spec['producer'] = producer
        self.spec['artifact'] = {'input': 'emitted', 'label': producer}
        Path('emitted').mkdir()
        self.compiler['inputs']['node_modules/dependency/app.js']['imports'] = []
        marker = json.dumps({'buildId': self.configuration['frontend_build_id']}, separators=(',', ':')).encode() + b'\n'
        Path('marker.json').write_bytes(marker)
        self.compiler['inputs']['public/marker.json'] = {'bytes': len(marker), 'sha256': notices.sha256(marker), 'owner': '//apps/web:marker.json', 'imports': []}
        self.declarations['public/marker.json'] = {'input': 'marker.json', 'link': False,
                                                  'owner': '//apps/web:marker.json', 'canonical': 'public/marker.json'}
        self.compiler.update(outputs={}, artifacts={}, unmatched_generated_modules=[], unmatched_generated_assets=[])
        selection = {'observations': [{'environment': 'client', 'type': 'chunk',
                                       'selected': [{'id': 'actual-resolved-module', 'source': 'node_modules/dependency/app.js'}]}]}
        # These compressed members were produced by declared pinned Bun1.4.2
        # brotliCompressSync. Python independently binds their raw bytes; the TS
        # producer also checks decompression against the original member bytes.
        members = [('index.html', b'<html>selected dependency</html>\n', 'GyAA+MUp55kE0jJJgt8u70MUGcUWmYI1FE29Hdc5RnmRAA==', selection),
                   ('asset.js', b'compiled selected dependency\n', 'GxwA+AXcZJ1Qqie4qZKK/BJPcSNT6jc9Rjc4PhaWAA==', selection),
                   ('merkur-build.json', marker, 'GzIA+B0HuTnyFjRFWvyJWkFnr0/DiLTErCQy2IADCSkQDWzTq4BGqm0Gb7A3', {'public_input': 'public/marker.json'})]
        for name, data, compressed, metadata in members:
            for member, raw, output in [(name, data, metadata), (name + '.br', base64.b64decode(compressed), {**metadata, 'compressed_from': name})]:
                Path('emitted', member).write_bytes(raw)
                self.compiler['outputs'][member] = {**copy.deepcopy(output), 'bytes': len(raw)}
                self.compiler['artifacts'][member] = {'bytes': len(raw), 'sha256': notices.sha256(raw)}
        self.refresh()

    def test_frontend_original_selected_npm_and_actual_precompressed_tree(self):
        self.frontend()
        value = notices.collect(self.spec)
        self.assertEqual(value['pending_scopes'], ['first-party', 'wasm'])
        self.assertEqual([item['name'] for item in value['components']], ['dependency'])
        self.assertEqual(len(value['artifacts']), 6)
        for fact in value['artifacts']:
            self.assertEqual(fact['sha256'], notices.sha256(Path('emitted', fact['path'].removeprefix('web/')).read_bytes()))
        self.configuration['compiler_tooling'] = [
            {'manifest_label': '@original_runtime//crates/runtime:Cargo.toml',
             'native': {'input': 'original/runtime.node', 'label': '//tools/bazel/rust:original_native'}}]
        self.refresh()
        value = notices.collect(self.spec)
        self.assertEqual(value['pending_scopes'], ['first-party', 'wasm', 'compiler-tooling'])
        self.assertEqual(value['configuration_authority']['settings_sha256'], notices.sha256(Path('configuration.json').read_bytes()))
        self.manifest['pending_scopes'].remove('compiler-tooling')
        self.write('manifest.json', self.manifest)
        with self.assertRaisesRegex(ValueError, 'incomplete attribution scopes'):
            notices.collect(self.spec)

    def test_frontend_context_and_original_tooling_schema_cannot_be_coerced(self):
        self.frontend()
        original = copy.deepcopy(self.configuration)
        for name, value in [('compiler_tooling', None), ('compiler_tooling', {}), ('project', 'apps/other'),
                            ('precompression', 1), ('frontend_build_id', 'not-uuid'),
                            ('public_release', {'version': 'fixture'}), ('backend_origin', [])]:
            with self.subTest(name=name, value=value):
                self.configuration = {**original, name: value}
                self.refresh()
                with self.assertRaises(ValueError):
                    notices.collect(self.spec)
        tooling = {'manifest_label': '@original//crate:Cargo.toml', 'native': {'input': 'original.node', 'label': '//native:original'}}
        for invalid in [{}, {'compiler': tooling}, [tooling, tooling],
                        [{**tooling, 'manifest_label': '//local:Cargo.toml'}],
                        [{**tooling, 'native': {'input': '../outside', 'label': '//native:original'}}],
                        [{**tooling, 'native': {'input': 'original.node', 'label': '//native:original', 'extra': True}}]]:
            with self.subTest(tooling=invalid):
                self.configuration = {**original, 'compiler_tooling': invalid}
                self.refresh()
                with self.assertRaises(ValueError):
                    notices.collect(self.spec)
        self.configuration = copy.deepcopy(original)
        self.configuration.pop('compiler_tooling')
        self.refresh()
        with self.assertRaises(ValueError):
            notices.collect(self.spec)

    def test_frontend_selection_schema_and_original_observation_types_refuse(self):
        self.frontend()
        original = copy.deepcopy(self.compiler)
        for change in ['modules', 'assets', 'missing-diagnostics', 'environment', 'type', 'source', 'import', 'output-schema', 'public']:
            with self.subTest(change=change):
                self.compiler = copy.deepcopy(original)
                observation = self.compiler['outputs']['asset.js']['observations'][0]
                if change in ['modules', 'assets']:
                    self.compiler['unmatched_generated_' + change] = [{'id': 'unresolved-original'}]
                elif change == 'missing-diagnostics':
                    self.compiler.pop('unmatched_generated_modules')
                elif change in ['environment', 'type']:
                    observation[change] = [observation[change]]
                elif change == 'source':
                    observation['selected'][0]['source'] = 'undeclared.js'
                elif change == 'import':
                    self.compiler['inputs']['node_modules/dependency/app.js']['imports'] = [{'path': 'public/marker.json', 'kind': ['dynamic-import']}]
                elif change == 'output-schema':
                    self.compiler['outputs']['asset.js']['inputs'] = {}
                else:
                    self.compiler['outputs']['merkur-build.json']['public_input'] = 'undeclared.json'
                self.refresh()
                with self.assertRaises(ValueError):
                    notices.collect(self.spec)

    def test_frontend_pairs_artifact_bytes_and_original_public_bytes_refuse(self):
        self.frontend()
        original = copy.deepcopy(self.compiler)
        for change in ['compressed-selection', 'compressed-origin', 'missing-pair', 'missing-fact', 'extra-member', 'output-size', 'public-byte-fact', 'uuid', 'actual-bytes']:
            with self.subTest(change=change):
                self.compiler = copy.deepcopy(original)
                if change == 'compressed-selection':
                    self.compiler['outputs']['asset.js.br']['observations'][0]['environment'] = 'worker'
                elif change == 'compressed-origin':
                    self.compiler['outputs']['asset.js.br']['compressed_from'] = 'index.html'
                elif change == 'missing-pair':
                    self.compiler['outputs'].pop('asset.js.br')
                elif change == 'missing-fact':
                    self.compiler['artifacts'].pop('asset.js')
                elif change == 'extra-member':
                    Path('emitted/foreign.js').write_bytes(b'not selected')
                elif change == 'output-size':
                    self.compiler['outputs']['asset.js']['bytes'] += 1
                elif change == 'public-byte-fact':
                    self.compiler['artifacts']['merkur-build.json']['sha256'] = '0' * 64
                elif change == 'uuid':
                    self.configuration['frontend_build_id'] = '00000000-0000-0000-0000-000000000002'
                else:
                    Path('emitted/asset.js.br').write_bytes(b'foreign compressed bytes')
                self.refresh()
                with self.assertRaises(ValueError):
                    notices.collect(self.spec)
                self.configuration['frontend_build_id'] = '00000000-0000-0000-0000-000000000001'
                Path('emitted/foreign.js').unlink(missing_ok=True)
                Path('emitted/asset.js.br').write_bytes(base64.b64decode('GxwA+AXcZJ1Qqie4qZKK/BJPcSNT6jc9Rjc4PhaWAA=='))

    def test_explicit_empty_tooling_is_mandatory_for_native_and_migrations(self):
        for migration in [False, True]:
            if migration:
                self.migration()
            for value in [None, [{'manifest_label': '@original//crate:Cargo.toml', 'native': {'input': 'original.node', 'label': '//native:original'}}]]:
                self.configuration['compiler_tooling'] = value
                self.refresh()
                with self.assertRaisesRegex(ValueError, 'explicit empty compiler tooling'):
                    notices.collect(self.spec)
            self.configuration['compiler_tooling'] = []

    def test_late_frontend_configuration_cannot_replace_captured_artifact_identity(self):
        self.frontend()
        original = notices.artifact_facts
        first = Path('configuration.json').read_bytes()
        self.configuration['frontend_build_id'] = '00000000-0000-0000-0000-000000000002'
        self.refresh()
        second = Path('configuration.json').read_bytes()

        def replace_before_artifact(*arguments):
            Path('configuration.json').write_bytes(first)
            return original(*arguments)

        with patch.object(notices, 'artifact_facts', replace_before_artifact), self.assertRaisesRegex(ValueError, 'Frontend bytes differ'):
            notices.collect(self.spec)
        self.configuration['frontend_build_id'] = '00000000-0000-0000-0000-000000000001'
        self.refresh()

        def replace_after_artifact(*arguments):
            facts = original(*arguments)
            Path('configuration.json').write_bytes(second)
            return facts

        with patch.object(notices, 'artifact_facts', replace_after_artifact), self.assertRaisesRegex(ValueError, 'authority changed during collection'):
            notices.collect(self.spec)

    def test_source_mutation_during_license_collection_is_rejected(self):
        original = notices.closure.collect
        def mutate(*args):
            inventory = original(*args)
            Path('package/app.js').write_text('export const value = 9;\n')
            return inventory
        with patch.object(notices.closure, 'collect', mutate), self.assertRaises(ValueError):
            notices.collect(self.spec)


if __name__ == '__main__':
    unittest.main()
