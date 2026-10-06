"""Configured authored source/license/artifact controls; synthetic producer bytes."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('first_party', Path(__file__).with_name('first-party-notices.py'))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class FirstPartyControls(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        original = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, original)
        Path('workspace').mkdir()
        Path('workspace/package.json').write_text('{"name":"merkur","license":"AGPL-3.0-only"}')
        Path('workspace/LICENSE').write_text('Original repository license\n')
        Path('authored/src').mkdir(parents=True)
        Path('authored/package.json').write_text('{"name":"@merkur/server","version":"0.1.0","license":"AGPL-3.0-only"}')
        Path('authored/src/main.ts').write_text('export const value = 7;\n')
        Path('authored/src/unused.ts').write_text('export const unused = 9;\n')
        Path('tree/src').mkdir(parents=True)
        for name in ['package.json', 'src/main.ts', 'src/unused.ts']:
            Path('tree', name).write_bytes(Path('authored', name).read_bytes())
        Path('server.bin').write_bytes(b'synthetic declared standalone artifact')
        Path('server.bin').chmod(0o755)
        self.compiler = {'inputs': {'apps/server/src/main.ts': self.fact('authored/src/main.ts', '//apps/server:source__main')}, 'outputs': {}, 'artifacts': {'server.bin': {'bytes': len(Path('server.bin').read_bytes()), 'sha256': notices.hashlib.sha256(Path('server.bin').read_bytes()).hexdigest()}}}
        self.declarations = {'apps/server/src/main.ts': {'input': 'authored/src/main.ts', 'link': False, 'owner': '//apps/server:source__main', 'canonical': 'apps/server/src/main.ts'}}
        self.value = {'producer': '//apps/server:server', 'artifact': {'input': 'server.bin', 'label': '//apps/server:server'},
                      'configuration': 'context.json', 'compiler_inventory': 'compiler.json', 'declarations': 'declarations.json', 'npm_sources': [], 'npm_source_inventory': 'npm-sources.json', 'wasm_packages': [], 'compiler_tooling': [],
                      'packages': [{'root': 'tree', 'source_label': '//apps/server:verification_inputs', 'manifest_label': '//apps/server:package.json',
                                    'files': [{'path': name, 'input': 'authored/' + name, 'label': '//apps/server:' + name} for name in ['package.json', 'src/main.ts', 'src/unused.ts']]}],
                      'workspace_manifest': {'input': 'workspace/package.json', 'label': '//:package.json'},
                      'workspace_license': {'input': 'workspace/LICENSE', 'label': '//:LICENSE'}}
        self.write('context.json', {'producer': self.value['producer'], 'frontend_build_id': '11111111-1111-4111-8111-111111111111'})
        self.refresh()

    def write(self, name, value):
        Path(name).write_bytes(notices.pack.canonical(value))

    def fact(self, path, owner):
        data = Path(path).read_bytes()
        return {'bytes': len(data), 'sha256': notices.hashlib.sha256(data).hexdigest(), 'owner': owner}

    def refresh(self):
        self.write('compiler.json', self.compiler)
        self.write('declarations.json', self.declarations)
        self.write('npm-sources.json', self.value['npm_sources'])

    def produce(self, name='result'):
        notices.produce(self.value, name + '.json', name + '.txt')
        return json.loads(Path(name + '.json').read_bytes()), Path(name + '.txt').read_bytes()

    def refused(self, message):
        with self.assertRaisesRegex((ValueError, OSError), message):
            self.produce()
        self.assertFalse(Path('result.json').exists())
        self.assertFalse(Path('result.txt').exists())

    def test_actual_selected_authored_member_license_context_and_artifact_binding(self):
        value, text = self.produce()
        self.assertEqual(value['kind'], 'selected-first-party-attribution')
        self.assertEqual(value['pending_scopes'], ['npm', 'wasm', 'embedded-runtime'])
        self.assertEqual(value['components'][0]['source_members'][0]['path'], 'apps/server/src/main.ts')
        self.assertEqual(len(value['components'][0]['source_members']), 1)
        self.assertEqual(value['components'][0]['texts'][0]['label'], '//:LICENSE')
        self.assertEqual(value['artifacts'][0]['sha256'], notices.hashlib.sha256(Path('server.bin').read_bytes()).hexdigest())
        self.assertIn(b'Original repository license', text)
        again, repeated = self.produce('again')
        self.assertEqual(value, again)
        self.assertEqual(text, repeated)

    def tooling_outputs(self):
        Path('upstream/crates/generator/src').mkdir(parents=True)
        Path('upstream/Cargo.toml').write_text('[workspace.package]\nversion="1.2.4"\nlicense="MIT"\nrepository="https://github.com/rolldown/rolldown"\n')
        Path('upstream/LICENSE').write_text('Original upstream full MIT notice\n')
        Path('upstream/crates/generator/Cargo.toml').write_text('[package]\nname="original-generator"\nversion.workspace=true\nlicense.workspace=true\nrepository.workspace=true\n')
        Path('upstream/crates/generator/src/lib.rs').write_text('pub const GENERATOR: &str = "original";\n')
        Path('upstream/crates/generator/src/unused.rs').write_text('pub const UNUSED: bool = true;\n')
        Path('tool-tree/src').mkdir(parents=True)
        members = ['Cargo.toml', 'src/lib.rs', 'src/unused.rs']
        for name in members:
            Path('tool-tree', name).write_bytes(Path('upstream/crates/generator', name).read_bytes())
        Path('tool.node').write_bytes(b'synthetic source-partition control; not native qualification')
        Path('tool.node').chmod(0o755)
        record = {'root': 'tool-tree', 'source_label': '@@original//crates/generator:sources',
                  'manifest_label': '@@original//crates/generator:Cargo.toml',
                  'files': [{'path': name, 'input': 'upstream/crates/generator/' + name,
                             'label': '@@original//crates/generator:' + name} for name in members],
                  'workspace_manifest': {'input': 'upstream/Cargo.toml', 'label': '@@original//:Cargo.toml'},
                  'workspace_license': {'input': 'upstream/LICENSE', 'label': '@@original//:LICENSE'},
                  'native': {'input': 'tool.node', 'label': '//tools/bazel/rust/rolldown_vite:binding'}}
        self.value['compiler_tooling'] = [record]
        context = json.loads(Path('context.json').read_bytes())
        context['compiler_tooling'] = [{'manifest_label': record['manifest_label'], 'native': record['native']}]
        self.write('context.json', context)
        logical = 'upstream/original/crates/generator/src/lib.rs'
        self.compiler['inputs'][logical] = self.fact('upstream/crates/generator/src/lib.rs', '@@original//crates/generator:src/lib.rs')
        self.declarations[logical] = {'input': 'upstream/crates/generator/src/lib.rs', 'link': False,
                                      'owner': '@@original//crates/generator:src/lib.rs', 'canonical': logical}
        self.refresh()
        return record, logical

    def test_compiler_tooling_original_sources_are_separate_and_native_scope_stays_pending(self):
        self.tooling_outputs()
        value, text = self.produce()
        self.assertEqual(len(value['components']), 1)
        self.assertEqual(value['components'][0]['name'], '@merkur/server')
        self.assertEqual(len(value['compiler_tooling']), 1)
        tool = value['compiler_tooling'][0]
        self.assertEqual(tool['name'], 'original-generator')
        self.assertEqual(tool['version'], '1.2.4')
        self.assertEqual(tool['texts'][0]['text'], Path('upstream/LICENSE').read_text())
        self.assertEqual(tool['texts'][0]['label'], '@@original//:LICENSE')
        self.assertEqual([row['path'] for row in tool['source_members']], ['src/lib.rs'])
        self.assertEqual(tool['native']['sha256'], notices.hashlib.sha256(Path('tool.node').read_bytes()).hexdigest())
        self.assertIn('compiler-tooling', value['pending_scopes'])
        self.assertIn(Path('upstream/LICENSE').read_bytes(), text)
        self.assertIn(b'original-generator 1.2.4', text)
        self.assertEqual(text, notices.closure.render({**value, 'components': value['components'] + value['compiler_tooling']}))

    def test_unselected_tooling_with_wider_configured_catalogue_still_keeps_native_scope_pending(self):
        _, logical = self.tooling_outputs()
        context = notices.pack.load_json(Path('context.json').read_bytes())
        relation = context['compiler_tooling'][0]
        for name in ('unselected-one', 'unselected-two'):
            context['compiler_tooling'].append({
                'manifest_label': '@@original//crates/' + name + ':Cargo.toml',
                'native': relation['native'],
            })
        self.write('context.json', context)
        self.compiler['inputs'].pop(logical)
        self.declarations.pop(logical)
        self.refresh()
        value, text = self.produce()
        self.assertEqual(value['compiler_tooling'], [])
        self.assertIn('compiler-tooling', value['pending_scopes'])
        self.assertEqual(len(value['components']), 1)
        self.assertNotIn(b'original-generator 1.2.4', text)

    def test_native_generator_without_typed_tooling_source_still_refuses(self):
        self.tooling_outputs()
        self.value['compiler_tooling'] = []
        self.refused('Selected input lacks authored')

    def test_tooling_source_configuration_rejects_another_native_supplier(self):
        record, _ = self.tooling_outputs()
        record['native'] = {**record['native'], 'label': '//foreign:native'}
        self.refused('actual native supplier configuration')

    def test_tooling_original_member_owner_refuses_foreign_equal_bytes(self):
        record, _ = self.tooling_outputs()
        record['files'][1]['label'] = '@@foreign//crates/generator:src/lib.rs'
        self.refused('original File ownership')

    def test_tooling_original_member_cannot_be_replaced_with_equal_bytes_outside_package(self):
        record, _ = self.tooling_outputs()
        Path('foreign.rs').write_bytes(Path('upstream/crates/generator/src/lib.rs').read_bytes())
        record['files'][1]['input'] = 'foreign.rs'
        self.refused('another original package')

    def test_tooling_copied_member_must_match_original_bytes(self):
        self.tooling_outputs()
        Path('tool-tree/src/lib.rs').write_text('foreign copy')
        self.refused('source tree differs')

    def test_tooling_original_notice_cannot_be_a_foreign_equal_byte_file(self):
        record, _ = self.tooling_outputs()
        Path('foreign-notice').write_bytes(Path('upstream/LICENSE').read_bytes())
        record['workspace_license']['input'] = 'foreign-notice'
        self.refused('notice belongs to another original tree')

    def test_tooling_original_notice_must_have_exact_upstream_owner(self):
        record, _ = self.tooling_outputs()
        record['workspace_license']['label'] = '@@foreign//:LICENSE'
        self.refused('notice has foreign ownership')

    def test_tooling_source_inventory_cannot_omit_a_declared_unused_member(self):
        record, _ = self.tooling_outputs()
        record['files'].pop()
        self.refused('omits original package members')

    def test_tooling_source_inventory_cannot_repeat_native_original_ownership(self):
        self.tooling_outputs()
        self.value['compiler_tooling'].append(self.value['compiler_tooling'][0])
        self.refused('ambiguous original source custody')

    def test_tooling_selected_owner_must_match_exact_original_member(self):
        _, logical = self.tooling_outputs()
        self.compiler['inputs'][logical]['owner'] = '@@original//crates/generator:other'
        self.declarations[logical]['owner'] = self.compiler['inputs'][logical]['owner']
        self.refresh()
        self.refused('original File bytes or owner')

    def native_outputs(self, producer, target='bun-linux-x64'):
        self.value['producer'] = producer
        self.value['artifact']['label'] = producer
        self.write('context.json', {'producer': producer, 'compile_target': target})

    def test_native_original_compiler_basename_is_separate_from_release_destination(self):
        for producer, destination in [('//apps/daemon:daemon', 'merkur'),
                                      ('//scripts:release_verifier', 'verify')]:
            for target in ['bun-darwin-arm64', 'bun-darwin-x64',
                           'bun-linux-arm64', 'bun-linux-x64']:
                with self.subTest(producer=producer, target=target):
                    self.native_outputs(producer, target)
                    value, text = self.produce(destination + '-' + target)
                    self.assertEqual(value['producer'], producer)
                    self.assertEqual(value['artifacts'][0]['path'], 'server.bin')
                    self.assertNotEqual(value['artifacts'][0]['path'], destination)
                    self.assertEqual(value['artifacts'][0]['label'], producer)
                    self.assertEqual(value['artifacts'][0]['mode'], '0555')
                    self.assertEqual(value['pending_scopes'], ['npm', 'wasm', 'embedded-runtime'])
                    self.assertIn(b'Original repository license', text)

    def workspace_outputs(self):
        self.native_outputs('//scripts:release_verifier')
        self.write('context.json', {'producer': '//scripts:release_verifier',
                                   'compile_target': 'bun-linux-x64',
                                   'public_release': {'version': 'v0.36.0'}})
        Path('workspace/scripts').mkdir()
        Path('workspace/scripts/verify-release.ts').write_text('export const verify = 7;\n')
        Path('workspace/package.json').write_text(
            '{"name":"merkur","version":"0.1.0","license":"AGPL-3.0-only"}')
        Path('root-tree/scripts').mkdir(parents=True)
        members = [('package.json', '//:package.json'), ('LICENSE', '//:LICENSE'),
                   ('scripts/verify-release.ts', '//scripts:verify-release.ts')]
        for name, _ in members:
            Path('root-tree', name).write_bytes(Path('workspace', name).read_bytes())
        logical = 'scripts/verify-release.ts'
        self.compiler['inputs'] = {logical: self.fact('workspace/' + logical,
                                                    '//scripts:verify-release.ts')}
        self.declarations = {logical: {'input': 'workspace/' + logical, 'link': False,
                                      'owner': '//scripts:verify-release.ts', 'canonical': logical}}
        self.value['packages'] = [{'root': 'root-tree', 'source_label': '//:root_sources',
                                  'manifest_label': '//:package.json',
                                  'files': [{'path': name, 'input': 'workspace/' + name,
                                             'label': label} for name, label in members]}]
        self.refresh()

    def test_native_root_authored_package_retains_exact_child_bazel_source_owners(self):
        self.workspace_outputs()
        value, text = self.produce()
        self.assertEqual(value['producer'], '//scripts:release_verifier')
        self.assertEqual(value['components'][0]['manifest']['label'], '//:package.json')
        self.assertEqual(value['components'][0]['name'], 'merkur')
        self.assertEqual(value['components'][0]['source_members'][0]['path'],
                         'scripts/verify-release.ts')
        self.assertEqual(value['components'][0]['source_members'][0]['label'],
                         '//scripts:verify-release.ts')
        self.assertEqual(value['artifacts'][0]['path'], 'server.bin')
        self.assertIn(b'Original repository license', text)

    def test_native_root_authored_package_foreign_child_owner_refuses(self):
        self.workspace_outputs()
        self.value['packages'][0]['files'][-1]['label'] = '//foreign:verify-release.ts'
        self.refused('membership')

    def test_native_root_manifest_uses_declared_build_version_without_package_version(self):
        self.workspace_outputs()
        for root in ['workspace', 'root-tree']:
            Path(root, 'package.json').write_text('{"name":"merkur","license":"AGPL-3.0-only"}')
        self.write('context.json', {'producer': '//scripts:release_verifier',
                                   'compile_target': 'bun-linux-x64',
                                   'public_release': {'version': 'v0.36.0'}})
        value, _ = self.produce()
        self.assertEqual(value['components'][0]['version'], 'v0.36.0')
        self.assertEqual(value['components'][0]['manifest']['sha256'],
                         notices.hashlib.sha256(Path('workspace/package.json').read_bytes()).hexdigest())

    def test_native_root_authored_package_missing_declared_build_version_refuses(self):
        self.workspace_outputs()
        self.write('context.json', {'producer': '//scripts:release_verifier',
                                   'compile_target': 'bun-linux-x64'})
        self.refused('original declared build version')

    def test_native_compiler_output_tampering_and_unexecutable_file_refuse(self):
        self.native_outputs('//apps/daemon:daemon')
        Path('server.bin').write_bytes(b'changed after original compiler inventory')
        self.refused('Compiler output bytes differ from actual artifact')
        self.compiler['artifacts']['server.bin'] = {
            'bytes': len(Path('server.bin').read_bytes()),
            'sha256': notices.hashlib.sha256(Path('server.bin').read_bytes()).hexdigest()}
        self.refresh()
        Path('server.bin').chmod(0o644)
        self.refused('Deployment input must be a nonempty safe regular file')

    def test_native_missing_standalone_configuration_refuses(self):
        self.native_outputs('//scripts:release_verifier')
        self.write('context.json', {'producer': self.value['producer']})
        self.refused('standalone compile configuration')

    def test_native_foreign_standalone_target_refuses(self):
        for producer in ['//apps/daemon:daemon', '//scripts:release_verifier']:
            with self.subTest(producer=producer):
                self.native_outputs(producer)
                self.write('context.json', {'producer': producer,
                                           'compile_target': 'foreign-native-target'})
                self.refused('standalone compile configuration')

    def test_native_foreign_compiler_owner_and_configuration_refuse(self):
        self.native_outputs('//scripts:release_verifier')
        self.value['artifact']['label'] = '//apps/daemon:daemon'
        self.refused('exact deployment producer')
        self.value['artifact']['label'] = self.value['producer']
        self.write('context.json', {'producer': '//apps/daemon:daemon',
                                   'compile_target': 'bun-linux-x64'})
        self.refused('original compiler configuration')

    def test_source_bytes_original_declared_owner_and_missing_custody_refuse(self):
        cases = ['bytes', 'owner', 'missing', 'generated']
        for case in cases:
            with self.subTest(case=case):
                saved = copy.deepcopy(self.compiler)
                if case == 'bytes':
                    self.compiler['inputs']['apps/server/src/main.ts']['sha256'] = '0' * 64
                elif case == 'owner':
                    self.compiler['inputs']['apps/server/src/main.ts']['owner'] = '//foreign:main'
                elif case == 'missing':
                    self.value['packages'] = []
                else:
                    Path('generated.js').write_text('export const generated = 1;')
                    self.compiler['inputs']['packages/e2e-wasm/pkg/wrapper.js'] = self.fact('generated.js', '//packages/e2e-wasm:package_tree')
                    self.declarations['packages/e2e-wasm/pkg/wrapper.js'] = {'input': 'generated.js', 'link': False, 'owner': '//packages/e2e-wasm:package_tree', 'canonical': 'packages/e2e-wasm/pkg/wrapper.js'}
                self.refresh()
                self.refused('differs|custody')
                self.compiler = saved
                self.declarations.pop('packages/e2e-wasm/pkg/wrapper.js', None)
                self.value['packages'] = [{'root': 'tree', 'source_label': '//apps/server:verification_inputs', 'manifest_label': '//apps/server:package.json', 'files': [{'path': name, 'input': 'authored/' + name, 'label': '//apps/server:' + name} for name in ['package.json', 'src/main.ts', 'src/unused.ts']]}]

    def test_coherent_foreign_same_byte_file_cannot_impersonate_authored_source(self):
        Path('foreign.ts').write_bytes(Path('authored/src/main.ts').read_bytes())
        logical = 'apps/server/src/main.ts'
        self.compiler['inputs'][logical] = self.fact('foreign.ts', '//foreign:generated')
        self.declarations[logical] = {'input': 'foreign.ts', 'link': False,
                                      'owner': '//foreign:generated', 'canonical': logical}
        self.refresh()
        self.refused('Selected input lacks authored, typed npm or typed WASM custody')

    def test_original_declared_source_presentation_alias_retains_physical_custody(self):
        Path('source-carrier.ts').symlink_to(Path('authored/src/main.ts').resolve())
        self.declarations['apps/server/src/main.ts']['input'] = 'source-carrier.ts'
        self.refresh()
        value, _ = self.produce()
        self.assertEqual(value['components'][0]['source_members'][0]['path'],
                         'apps/server/src/main.ts')

    def test_package_manifest_source_file_omission_and_foreign_labels_refuse(self):
        original = copy.deepcopy(self.value)
        for change in ['member', 'manifest', 'label', 'duplicate']:
            with self.subTest(change=change):
                self.value = copy.deepcopy(original)
                package = self.value['packages'][0]
                if change == 'member':
                    package['files'].pop()
                elif change == 'manifest':
                    package['manifest_label'] = '//foreign:package.json'
                elif change == 'label':
                    package['files'][0]['label'] = '//foreign:package.json'
                else:
                    self.value['packages'].append(copy.deepcopy(package))
                self.refused('omits|membership|manifest|ownership')

    def test_own_package_license_is_required_for_another_license_expression(self):
        for root in ['tree', 'authored']:
            Path(root, 'package.json').write_text('{"name":"@merkur/server","version":"0.1.0","license":"Apache-2.0"}')
        self.refused('own complete published license')
        for root in ['tree', 'authored']:
            Path(root, 'LICENSE').write_text('Original Apache package license\n')
        self.value['packages'][0]['files'].append({'path': 'LICENSE', 'input': 'authored/LICENSE', 'label': '//apps/server:LICENSE'})
        value, _ = self.produce()
        self.assertEqual(value['components'][0]['texts'][0]['text'], 'Original Apache package license\n')
        self.assertNotIn('label', value['components'][0]['texts'][0])

    def test_original_repository_license_alias_and_wrong_identity_refuse(self):
        Path('workspace/other').write_bytes(Path('workspace/LICENSE').read_bytes())
        Path('workspace/LICENSE').unlink()
        Path('workspace/LICENSE').symlink_to('other')
        self.refused('another declared workspace')
        Path('workspace/LICENSE').unlink()
        Path('workspace/LICENSE').write_text('Original repository license\n')
        self.value['workspace_license']['label'] = '//foreign:LICENSE'
        self.refused('exact workspace ownership')

    def test_original_authored_notice_alias_refuses_without_erasing_evidence(self):
        Path('tree/NOTICE').symlink_to('package.json')
        self.value['packages'][0]['files'].append({'path': 'NOTICE', 'input': 'authored/package.json', 'label': '//apps/server:NOTICE'})
        self.refused('link or special member')

    def test_configured_producer_and_artifact_ownership_refuse(self):
        self.value['artifact']['label'] = '//foreign:server'
        self.refused('exact deployment producer')
        self.value['artifact']['label'] = self.value['producer']
        self.write('context.json', {'producer': '//foreign:server'})
        self.refused('original compiler configuration')

    def wasm_outputs(self):
        root = Path('generated-wasm')
        root.mkdir()
        (root / 'e2e_wasm.js').write_text('export const generated = 1;\n')
        (root / 'e2e_wasm_bg.wasm').write_bytes(b'\0asm synthetic declared member')
        (root / 'package.json').write_text('{"name":"merkur-e2e","version":"0.1.0"}')
        producer = '//packages/e2e-wasm:immutable_package'
        tree_owner = '//packages/e2e-wasm:pkg_source'
        self.wasm_inventory = {'producer': producer, 'module': 'e2e_wasm', 'members': [
            {'member': file.name, 'size': len(file.read_bytes()),
             'sha256': notices.hashlib.sha256(file.read_bytes()).hexdigest()}
            for file in sorted(root.iterdir())]}
        self.write('wasm-inventory.json', self.wasm_inventory)
        self.value['wasm_packages'] = [{'producer': producer,
                                       'tree': {'input': str(root), 'label': tree_owner},
                                       'inventory': {'input': 'wasm-inventory.json',
                                                     'label': producer}}]
        logical = 'packages/e2e-wasm/pkg/e2e_wasm.js'
        self.compiler['inputs'][logical] = self.fact(str(root / 'e2e_wasm.js'), tree_owner)
        self.declarations['packages/e2e-wasm/pkg'] = {
            'input': str(root), 'link': False, 'owner': tree_owner,
            'canonical': 'packages/e2e-wasm/pkg'}
        self.refresh()
        return logical

    def test_typed_generated_wasm_partition_preserves_authored_and_pending_scopes(self):
        self.wasm_outputs()
        value, _ = self.produce()
        self.assertEqual([item['name'] for item in value['components']], ['@merkur/server'])
        self.assertEqual(value['components'][0]['source_members'][0]['path'],
                         'apps/server/src/main.ts')
        self.assertEqual(value['pending_scopes'], ['npm', 'wasm', 'embedded-runtime'])
        self.assertNotEqual(self.value['wasm_packages'][0]['producer'],
                            self.value['wasm_packages'][0]['tree']['label'])

    def test_selected_generated_member_without_typed_wasm_custody_refuses(self):
        self.wasm_outputs()
        self.value['wasm_packages'] = []
        self.refused('lacks authored, typed npm or typed WASM custody')

    def test_typed_wasm_coherent_foreign_compiler_owner_refuses(self):
        logical = self.wasm_outputs()
        self.compiler['inputs'][logical]['owner'] = '//foreign:pkg_source'
        self.declarations['packages/e2e-wasm/pkg']['owner'] = '//foreign:pkg_source'
        self.refresh()
        self.refused('original declared producer custody')

    def test_typed_wasm_same_byte_foreign_file_cannot_impersonate_original_member(self):
        logical = self.wasm_outputs()
        Path('foreign.js').write_bytes(Path('generated-wasm/e2e_wasm.js').read_bytes())
        self.compiler['inputs'][logical] = self.fact('foreign.js',
                                                   '//packages/e2e-wasm:pkg_source')
        self.declarations[logical] = {'input': 'foreign.js', 'link': False,
                                     'owner': '//packages/e2e-wasm:pkg_source', 'canonical': logical}
        self.refresh()
        self.refused('lacks authored, typed npm or typed WASM custody')

    def test_typed_wasm_inventory_cannot_omit_or_rewrite_original_members(self):
        self.wasm_outputs()
        saved = copy.deepcopy(self.wasm_inventory)
        for change in ['omitted', 'bytes', 'producer', 'duplicate', 'owner']:
            with self.subTest(change=change):
                self.wasm_inventory = copy.deepcopy(saved)
                if change == 'omitted':
                    self.wasm_inventory['members'].pop()
                elif change == 'bytes':
                    self.wasm_inventory['members'][0]['sha256'] = '0' * 64
                elif change == 'producer':
                    self.wasm_inventory['producer'] = '//foreign:immutable_package'
                elif change == 'duplicate':
                    self.wasm_inventory['members'].append(self.wasm_inventory['members'][0])
                else:
                    self.value['wasm_packages'][0]['inventory']['label'] = '//foreign:inventory'
                self.write('wasm-inventory.json', self.wasm_inventory)
                self.refused('WASM.*inventory|WASM.*fact|another original producer')

    def test_typed_wasm_duplicate_tree_and_original_tree_redirection_refuse(self):
        self.wasm_outputs()
        original = self.value['wasm_packages'][0]
        self.value['wasm_packages'].append(copy.deepcopy(original))
        self.refused('Duplicate original typed WASM package root')
        self.value['wasm_packages'] = [original]
        Path('generated-wasm').rename('redirected-wasm')
        Path('generated-wasm').symlink_to('redirected-wasm', target_is_directory=True)
        self.refused('Original declared TreeArtifact is redirected')

    def test_typed_npm_partition_preserves_only_actual_authored_components(self):
        Path('npm/kysely').mkdir(parents=True)
        Path('npm/kysely/package.json').write_text('{"name":"kysely","version":"0.29.5","license":"MIT"}')
        Path('npm/kysely/LICENSE').write_text('Published registry license\n')
        Path('npm/kysely/index.js').write_text('export const sql = 1;\n')
        logical = 'apps/server/node_modules/kysely/index.js'
        self.compiler['inputs'][logical] = self.fact('npm/kysely/index.js', '//:kysely')
        self.declarations['apps/server/node_modules/kysely'] = {'input': 'npm/kysely', 'link': True, 'owner': '//:kysely', 'canonical': 'apps/server/node_modules/kysely'}
        self.value['npm_sources'] = [{'input': 'npm/kysely', 'package': 'kysely', 'version': '0.29.5', 'source_label': '//:kysely', 'workspace': False}]
        self.refresh()
        value, _ = self.produce('typed')
        self.assertEqual([item['name'] for item in value['components']], ['@merkur/server'])
        self.assertIn('npm', value['pending_scopes'])
        self.value['npm_sources'] = []
        self.refused('original typed npm source inventory')
        self.write('npm-sources.json', [])
        self.refused('typed source owner')

    def web_outputs(self):
        old = 'apps/server/src/main.ts'
        logical = 'apps/web/src/main.ts'
        fact = self.compiler['inputs'].pop(old)
        fact['owner'] = '//apps/web:source__main'
        self.compiler['inputs'][logical] = fact
        self.declarations = {logical: {'input': 'authored/src/main.ts', 'link': False,
                                      'owner': fact['owner'], 'canonical': logical}}
        for root in ['tree', 'authored']:
            Path(root, 'package.json').write_text('{"name":"@merkur/web","version":"0.1.0","license":"AGPL-3.0-only"}')
        package = self.value['packages'][0]
        package['source_label'] = '//apps/web:verification_inputs'
        package['manifest_label'] = '//apps/web:package.json'
        for item in package['files']:
            item['label'] = '//apps/web:' + item['path']
        self.value['producer'] = '//apps/web:frontend_precompressed'
        self.value['artifact'] = {'input': 'web-emitted', 'label': self.value['producer']}
        self.build_id = '11111111-1111-4111-8111-111111111111'
        self.write('context.json', {'producer': self.value['producer'],
                                  'frontend_build_id': self.build_id})
        Path('web-emitted/assets').mkdir(parents=True)
        originals = {'index.html': b'<html>synthetic selected web app</html>\n',
                     'merkur-build.json': notices.pack.canonical({'buildId': self.build_id}),
                     'assets/main.js': b'export const value = 7;\n'}
        for name, data in originals.items():
            Path('web-emitted', name).write_bytes(data)
            # Synthetic compressed bytes exercise member custody, not Brotli execution.
            Path('web-emitted', name + '.br').write_bytes(b'synthetic br ' + data)
        self.web_artifacts()

    def web_artifacts(self):
        self.compiler['artifacts'] = {
            path.relative_to('web-emitted').as_posix(): {
                'bytes': len(path.read_bytes()),
                'sha256': notices.hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in Path('web-emitted').rglob('*') if path.is_file()}
        self.refresh()

    def test_web_selected_original_source_complete_tree_and_identity(self):
        self.web_outputs()
        value, text = self.produce('web')
        self.assertEqual(value['producer'], '//apps/web:frontend_precompressed')
        self.assertEqual(value['pending_scopes'], ['npm', 'wasm'])
        self.assertEqual([item['name'] for item in value['components']], ['@merkur/web'])
        self.assertEqual(value['components'][0]['source_members'][0]['path'],
                         'apps/web/src/main.ts')
        self.assertEqual(len(value['artifacts']), 6)
        again, again_text = self.produce('web-again')
        self.assertEqual(value, again)
        self.assertEqual(text, again_text)

    def test_web_coherent_member_and_build_identity_drift_refuse(self):
        self.web_outputs()
        original = {path.relative_to('web-emitted').as_posix(): path.read_bytes()
                    for path in Path('web-emitted').rglob('*') if path.is_file()}
        for change in ['marker', 'uuid', 'missing-br', 'orphan-br', 'index', 'build-marker']:
            with self.subTest(change=change):
                for output in ['result.json', 'result.txt']:
                    Path(output).unlink(missing_ok=True)
                for path in Path('web-emitted').rglob('*'):
                    if path.is_file():
                        path.unlink()
                for name, data in original.items():
                    Path('web-emitted', name).write_bytes(data)
                context = {'producer': self.value['producer'], 'frontend_build_id': self.build_id}
                if change == 'marker':
                    self.write('web-emitted/merkur-build.json', {'buildId': '22222222-2222-4222-8222-222222222222'})
                elif change == 'uuid':
                    context['frontend_build_id'] = 'invalid'
                elif change == 'missing-br':
                    Path('web-emitted/assets/main.js.br').unlink()
                elif change == 'orphan-br':
                    Path('web-emitted/assets/orphan.js.br').write_bytes(b'orphan compressed member')
                else:
                    name = 'index.html' if change == 'index' else 'merkur-build.json'
                    Path('web-emitted', name).unlink()
                    Path('web-emitted', name + '.br').unlink()
                self.write('context.json', context)
                self.web_artifacts()
                self.refused('frontend|Frontend')

    def test_web_original_same_byte_foreign_source_refuses(self):
        self.web_outputs()
        logical = 'apps/web/src/main.ts'
        Path('foreign.ts').write_bytes(Path('authored/src/main.ts').read_bytes())
        self.compiler['inputs'][logical] = self.fact('foreign.ts', '//foreign:generated')
        self.declarations[logical] = {'input': 'foreign.ts', 'link': False,
                                      'owner': '//foreign:generated', 'canonical': logical}
        self.refresh()
        self.refused('Selected input lacks authored, typed npm or typed WASM custody')

    def migration_outputs(self):
        self.value['producer'] = '//apps/server:migrations'
        self.value['artifact'] = {'input': 'emitted', 'label': self.value['producer']}
        self.write('context.json', {'producer': self.value['producer']})
        Path('emitted').mkdir()
        data = b'export const migration = 7;\n'
        self.compiler['artifacts'] = {}
        names = ['001_initial_schema.js', '002_box_identity.js',
                 '003_account_privilege.js', '004_notification_outbox.js']
        for name in names:
            Path('emitted', name).write_bytes(data)
            self.compiler['outputs'][name] = {
                'bytes': len(data),
                'inputs': {'apps/server/src/main.ts': {'bytesInOutput': len(data)}},
                'entryPoint': 'apps/server/src/main.ts'}
            self.compiler['artifacts'][name] = {
                'bytes': len(data), 'sha256': notices.hashlib.sha256(data).hexdigest()}
        self.refresh()
        return names, data

    def test_bundle_artifact_must_equal_original_compiler_output_facts(self):
        names, data = self.migration_outputs()
        original = copy.deepcopy(self.compiler)
        baseline, text = self.produce('baseline')
        repeated, repeated_text = self.produce('repeated')
        self.assertEqual(baseline, repeated)
        self.assertEqual(text, repeated_text)
        self.assertEqual(len(baseline['artifacts']), 4)
        for change in ['bytes', 'missing', 'extra', 'digest', 'size', 'fact-omission']:
            with self.subTest(change=change):
                self.compiler = copy.deepcopy(original)
                Path('emitted', names[0]).write_bytes(data)
                Path('emitted/foreign.js').unlink(missing_ok=True)
                if change == 'bytes':
                    Path('emitted', names[0]).write_bytes(b'export const foreign = 123;\n')
                elif change == 'missing':
                    Path('emitted', names[0]).unlink()
                elif change == 'extra':
                    Path('emitted/foreign.js').write_bytes(data)
                elif change == 'digest':
                    self.compiler['artifacts'][names[0]]['sha256'] = '0' * 64
                elif change == 'size':
                    self.compiler['artifacts'][names[0]]['bytes'] += 1
                else:
                    self.compiler['artifacts'].pop(names[0])
                self.refresh()
                self.refused('Compiler output (membership|bytes) differ')

    def test_malformed_or_missing_retained_output_facts_refuse(self):
        names, _ = self.migration_outputs()
        original = copy.deepcopy(self.compiler)
        for change in ['empty', 'boolean-size', 'uppercase-digest', 'not-a-fact']:
            with self.subTest(change=change):
                self.compiler = copy.deepcopy(original)
                if change == 'empty':
                    self.compiler['artifacts'] = {}
                elif change == 'boolean-size':
                    self.compiler['artifacts'][names[0]]['bytes'] = True
                elif change == 'uppercase-digest':
                    self.compiler['artifacts'][names[0]]['sha256'] = 'A' * 64
                else:
                    self.compiler['artifacts'][names[0]] = None
                self.refresh()
                self.refused('retained (output|compiler output)')

    def carrier_presentation(self):
        original = self.root
        carrier = original / 'presentation'
        carrier.mkdir()
        # Configuration is a genuine generated File whose exact relative path
        # anchors the original namespace, rather than a discovered tree member.
        for name in ['context.json', 'compiler.json', 'declarations.json',
                     'npm-sources.json', 'server.bin']:
            (carrier / name).symlink_to(original / name)
        for name in ['tree', 'authored', 'workspace']:
            for file in (original / name).rglob('*'):
                relative = file.relative_to(original)
                destination = carrier / relative
                if file.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.symlink_to(file)
        os.chdir(carrier)
        self.addCleanup(os.chdir, original)
        return carrier, original

    def test_exact_tree_member_carriers_use_original_producer_namespace(self):
        carrier, original = self.carrier_presentation()
        value, _ = self.produce()
        self.assertEqual(value['components'][0]['source_members'][0]['path'],
                         'apps/server/src/main.ts')
        self.assertTrue((carrier / 'tree/src/main.ts').is_symlink())
        self.assertFalse((original / 'tree/src/main.ts').is_symlink())

    def test_foreign_missing_extra_and_original_member_aliases_refuse(self):
        carrier, original = self.carrier_presentation()
        member = carrier / 'tree/src/main.ts'
        member.unlink()
        (original / 'foreign.ts').write_bytes((original / 'tree/src/main.ts').read_bytes())
        member.symlink_to(original / 'foreign.ts')
        self.refused('carrier redirects')
        member.unlink()
        self.refused('exact producer membership')
        member.symlink_to(original / 'tree/src/main.ts')
        (carrier / 'tree/extra').symlink_to(original / 'foreign.ts')
        self.refused('carrier redirects')
        (carrier / 'tree/extra').unlink()
        original_member = original / 'tree/src/main.ts'
        data = original_member.read_bytes()
        original_member.unlink()
        original_member.symlink_to(original / 'foreign.ts')
        self.refused('link or special member')
        original_member.unlink()
        original_member.write_bytes(data)

    def test_carrier_retarget_after_capture_and_namespace_suffix_refuse(self):
        carrier, original = self.carrier_presentation()
        (original / 'foreign.ts').write_bytes((original / 'tree/src/main.ts').read_bytes())
        original_component = notices.component
        def retarget(*args):
            result = original_component(*args)
            member = carrier / 'tree/src/main.ts'
            member.unlink()
            member.symlink_to(original / 'foreign.ts')
            return result
        with patch.object(notices, 'component', retarget):
            self.refused('input presentation changed')
        (carrier / 'context.json').unlink()
        (original / 'renamed-context.json').write_bytes((original / 'context.json').read_bytes())
        (carrier / 'context.json').symlink_to(original / 'renamed-context.json')
        self.refused('exact declared namespace suffix')

    def test_source_and_artifact_changes_during_collection_prevent_publication(self):
        original = notices.component
        def changed(*args):
            value = original(*args)
            Path('server.bin').write_bytes(b'changed artifact')
            return value
        with patch.object(notices, 'component', changed):
            self.refused('Compiler output bytes differ from actual artifact')
        Path('server.bin').write_bytes(b'synthetic declared standalone artifact')
        original_artifact = notices.artifact
        def raced(*args):
            value = original_artifact(*args)
            Path('server.bin').write_bytes(b'later artifact')
            return value
        with patch.object(notices, 'artifact', raced):
            with self.assertRaisesRegex(ValueError, 'Declared input file identity changed'):
                self.produce('raced')
        self.assertFalse(Path('raced.json').exists())
        self.assertFalse(Path('raced.txt').exists())


if __name__ == '__main__':
    unittest.main()
