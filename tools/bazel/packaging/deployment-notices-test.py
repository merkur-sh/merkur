"""Synthetic selected-scope/custody controls; no complete production notice claim."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('deployment-pack-test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
notices = fixture.notices


class NoticeControls(unittest.TestCase):
    def setUp(self):
        self.case = fixture.DeploymentControls()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.root = self.case.root
        self.value = copy.deepcopy(self.case.notice_value)

    def produce(self, name='notice'):
        inventory, text = self.root / (name + '.json'), self.root / (name + '.txt')
        notices.produce(self.value, inventory, text)
        return inventory, text

    def refused(self, message):
        with self.assertRaisesRegex(ValueError, message):
            self.produce()
        self.assertFalse((self.root / 'notice.json').exists())
        self.assertFalse((self.root / 'notice.txt').exists())

    def test_every_selected_scope_and_pending_resolution_is_mandatory(self):
        original = copy.deepcopy(self.value)
        for index in range(9):
            with self.subTest(index=index):
                self.value = copy.deepcopy(original)
                self.value['attributions'].pop(index)
                self.refused('complete selected notice scope inventory')
        self.value = copy.deepcopy(original)
        self.value['attributions'].append(copy.deepcopy(self.value['attributions'][0]))
        self.refused('duplicate or extra configured notice scope')
        self.value = copy.deepcopy(original)
        self.value['attributions'][0]['scope'] = 'invented'
        self.refused('extra configured notice scope')

    def test_wrong_configured_producer_and_same_byte_foreign_artifact_refuse(self):
        original = copy.deepcopy(self.value)
        self.value['attributions'][0]['producer'] = '//foreign:server'
        self.refused('another artifact producer')
        self.value = copy.deepcopy(original)
        copy_file = self.root / 'other.bin'
        copy_file.write_bytes(self.case.server.read_bytes())
        copy_file.chmod(0o755)
        self.value['attributions'][0]['artifact']['input'] = str(copy_file)
        self.refused('another artifact producer')
        self.value = copy.deepcopy(original)
        context = Path(self.value['attributions'][0]['configuration']['input'])
        context.write_bytes(notices.pack.canonical({'producer': '//foreign:server', 'frontend_build_id': self.case.build_id}))
        self.refused('server configuration')

    def test_selected_firstparty_inventory_cannot_change_or_omit_artifact_bytes(self):
        item = next(item for item in self.value['attributions'] if item['scope'] == 'first-party' and item['producer'] == self.value['server']['label'])
        path = Path(item['inventory']['input'])
        original = path.read_bytes()
        for change in ['digest', 'omitted']:
            with self.subTest(change=change):
                value = notices.pack.load_json(original)
                if change == 'digest':
                    value['artifacts'][0]['sha256'] = '0' * 64
                else:
                    value.pop('artifacts')
                path.write_bytes(notices.pack.canonical(value))
                Path(item['notices']['input']).write_bytes(notices.closure.render(value))
                self.refused('actual selected artifact bytes')

    def test_migration_npm_scope_uses_same_bundle_bytes_and_exact_pending_inventory(self):
        item = next(item for item in self.value['attributions'] if item['scope'] == 'npm' and item['producer'] == self.value['migrations']['label'])
        path = Path(item['inventory']['input'])
        original = path.read_bytes()
        baseline = notices.pack.load_json(original)
        self.assertEqual(baseline['kind'], 'npm-attribution-intermediate')
        self.assertEqual(baseline['pending_scopes'], ['first-party'])
        for mutation in ['artifact', 'omitted-artifact', 'pending']:
            with self.subTest(mutation=mutation):
                value = notices.pack.load_json(original)
                if mutation == 'artifact':
                    value['artifacts'][0]['sha256'] = '0' * 64
                elif mutation == 'omitted-artifact':
                    value.pop('artifacts')
                else:
                    value['pending_scopes'] = ['first-party', 'wasm', 'embedded-runtime']
                path.write_bytes(notices.pack.canonical(value))
                Path(item['notices']['input']).write_bytes(('PARTIAL NPM ATTRIBUTION; PENDING: ' + ', '.join(value['pending_scopes']) + '\n\n').encode() + notices.closure.render(value))
                self.refused('actual selected artifact bytes|erased its original pending')
        path.write_bytes(original)

    def test_unresolved_runtime_native_rust_and_erased_pending_refuse(self):
        for scope, mutation, message in [('npm', 'pending_scopes', 'erased its original pending'),
                                         ('wasm', 'pending', 'unresolved attribution obligation')]:
            item = next(item for item in self.value['attributions'] if item['producer'] == self.value['server']['label'] and item['scope'] == scope)
            path = Path(item['inventory']['input'])
            before = path.read_bytes()
            value = notices.pack.load_json(before)
            value[mutation] = [] if scope == 'npm' else ['Native release source/SDK/profile verification evidence']
            path.write_bytes(notices.pack.canonical(value))
            if scope == 'npm':
                Path(item['notices']['input']).write_bytes(('PARTIAL NPM ATTRIBUTION; PENDING: ' + ', '.join(value['pending_scopes']) + '\n\n').encode() + notices.closure.render(value))
            self.refused(message)
            path.write_bytes(before)
            if scope == 'npm':
                Path(item['notices']['input']).write_bytes(('PARTIAL NPM ATTRIBUTION; PENDING: ' + ', '.join(notices.pack.load_json(before)['pending_scopes']) + '\n\n').encode() + notices.closure.render(notices.pack.load_json(before)))
        item = next(item for item in self.value['attributions'] if item['scope'] == 'wasm')
        source = Path(item['source_inventory']['input'])
        value = notices.pack.load_json(source.read_bytes())
        value['configuration']['target'] = 'x86_64-unknown-linux-gnu'
        source.write_bytes(notices.pack.canonical(value))
        self.refused('selected WASM compiler closure')

    def test_canonical_notice_bytes_and_signing_metadata_bind_same_service(self):
        first = self.produce()
        second = self.produce('again')
        self.assertEqual(first[0].read_bytes(), second[0].read_bytes())
        self.assertEqual(first[1].read_bytes(), second[1].read_bytes())
        inventory = notices.pack.load_json(first[0].read_bytes())
        self.assertEqual(len(inventory['providers']), 9)
        self.assertEqual(inventory['notices']['sha256'], notices.digest(first[1].read_bytes()))
        archive, metadata = self.case.produce()
        binding = notices.pack.load_json(metadata.read_bytes())['notices']
        self.assertEqual(binding['inventory']['sha256'], notices.digest((self.root / 'complete.notices.json').read_bytes()))
        self.assertEqual(binding['text']['sha256'], notices.digest((self.root / 'NOTICES.txt').read_bytes()))
        self.assertTrue(archive.exists())

    def test_license_only_coherent_scope_omission_or_changed_artifact_cannot_package(self):
        original = copy.deepcopy(self.case.value)
        self.case.value.pop('notices')
        self.case.refused()
        self.case.value = copy.deepcopy(original)
        metadata = self.root / 'complete.notices.json'
        before = metadata.read_bytes()
        value = notices.pack.load_json(before)
        value['providers'].pop()
        text = notices.render(value['providers'])
        (self.root / 'NOTICES.txt').write_bytes(text)
        value['notices'] = {'name': 'NOTICES.txt', 'size': len(text), 'sha256': notices.digest(text)}
        metadata.write_bytes(notices.pack.canonical(value))
        self.case.refused()
        metadata.write_bytes(before)
        (self.root / 'NOTICES.txt').write_bytes(notices.render(notices.pack.load_json(before)['providers']))
        (self.case.web / 'assets/app.js').write_bytes(b'new configured application bytes')
        self.case.refused()

    def test_published_notice_text_digest_and_file_capture_custody(self):
        item = self.value['attributions'][0]
        path = Path(item['notices']['input'])
        path.write_bytes(path.read_bytes() + b'foreign added text')
        self.refused('differs from its original selected inventory')

    def test_external_inventory_cannot_coerce_numeric_or_context_identity(self):
        metadata = self.root / 'complete.notices.json'
        before = metadata.read_bytes()
        for mutation in ('float-size', 'wrong-context', 'extra-provider'):
            with self.subTest(mutation=mutation):
                value = notices.pack.load_json(before)
                if mutation == 'float-size':
                    fact = value['artifacts']['migrations'][0]
                    fact['size'] = float(fact['size'])
                elif mutation == 'wrong-context':
                    value['providers'][0]['inputs']['configuration']['sha256'] = '0' * 64
                else:
                    value['providers'].append(copy.deepcopy(value['providers'][0]))
                metadata.write_bytes(notices.pack.canonical(value))
                self.case.refused()
        metadata.write_bytes(before)

    def test_source_mutation_during_publication_removes_both_owned_outputs(self):
        original = notices.pack.ArchiveOutputs.open
        def mutate(outputs, index):
            stream = original(outputs, index)
            if index == 1:
                Path(self.value['attributions'][0]['source_inventory']['input']).write_bytes(b'{}')
            return stream
        with patch.object(notices.pack.ArchiveOutputs, 'open', mutate):
            self.refused('Declared input')


    def test_private_unversioned_component_survives_selected_join_and_external_binding(self):
        item = next(item for item in self.value['attributions'] if item['scope'] == 'first-party' and item['producer'] == self.value['server']['label'])
        path = Path(item['inventory']['input'])
        selected = notices.pack.load_json(path.read_bytes())
        component = selected['components'][0]
        component.update({'id': 'merkur#//:package.json', 'name': 'merkur', 'version': None,
                          'source': None, 'license': 'AGPL-3.0-only',
                          'source_label': '//:package.json', 'private': True})
        path.write_bytes(notices.pack.canonical(selected))
        Path(item['notices']['input']).write_bytes(notices.closure.render(selected))
        inventory_path, text_path = self.produce()
        inventory = notices.pack.load_json(inventory_path.read_bytes())
        provider = next(value for value in inventory['providers'] if value['scope'] == 'first-party' and value['role'] == 'server')
        self.assertIs(provider['components'][0]['private'], True)
        self.assertIsNone(provider['components'][0]['version'])
        self.assertIn(b'\nmerkur\nPackage identity: merkur#//:package.json\n', text_path.read_bytes())
        notices.components(provider)
        # Same complete external inventory is consumed by the existing unsigned action.
        (self.root / 'complete.notices.json').write_bytes(inventory_path.read_bytes())
        (self.root / 'NOTICES.txt').write_bytes(text_path.read_bytes())
        self.assertTrue(self.case.produce()[0].exists())
        provider['components'][0]['private'] = False
        with self.assertRaisesRegex(ValueError, 'private unversioned'):
            notices.components(provider)


    def tooling_inventory(self):
        # Explicit source-partition parser fixture; never native runtime qualification.
        provider = next(item for item in self.value['attributions']
                        if item['scope'] == 'first-party' and item['producer'] == self.value['web']['label'])
        inventory = notices.pack.load_json(Path(provider['inventory']['input']).read_bytes())
        tool = copy.deepcopy(inventory['components'][0])
        tool.update(id='original-generator@1.2.4#@@original//crates/generator:Cargo.toml',
                    name='original-generator', version='1.2.4', source_label='@@original//crates/generator:npm_package',
                    manifest={'label': '@@original//crates/generator:Cargo.toml', 'sha256': 'a' * 64},
                    native={'label': '//native:rolldown', 'size': 17, 'sha256': 'b' * 64},
                    source_members=[{'path': 'src/lib.rs', 'label': '@@original//crates/generator:src/lib.rs',
                                     'size': 19, 'sha256': 'c' * 64,
                                     'compiler_owner': '@@original//crates/generator:src/lib.rs'}])
        context = notices.pack.load_json(Path(provider['configuration']['input']).read_bytes())
        context['compiler_tooling'] = [{'manifest_label': tool['manifest']['label'],
                                       'native': {'input': 'original.node', 'label': tool['native']['label']}}]
        context = notices.pack.canonical(context)
        Path(provider['configuration']['input']).write_bytes(context)
        inventory.update(configuration=notices.digest(context), compiler_tooling=[tool],
                         pending_scopes=['compiler-tooling'])
        Path(provider['inventory']['input']).write_bytes(notices.pack.canonical(inventory))
        text = notices.closure.render({**inventory, 'components': inventory['components'] + inventory['compiler_tooling']})
        Path(provider['notices']['input']).write_bytes(text)
        return provider, inventory, context, text

    def test_original_tooling_notice_bytes_survive_source_scope_but_unsigned_deployment_stays_blocked(self):
        provider, inventory, context, text = self.tooling_inventory()
        source = Path(provider['source_inventory']['input']).read_bytes()
        pending = notices.validate_scope('first-party', provider['producer'], inventory, context,
                                         source, text, inventory['artifacts'])
        self.assertEqual(pending, ['compiler-tooling'])
        self.assertEqual(notices.compiler_tooling(inventory), inventory['compiler_tooling'])
        self.assertIn(b'original-generator 1.2.4', text)
        retained = {'role': 'web', 'scope': 'first-party', 'producer': provider['producer'],
                    'inputs': {'configuration': {'sha256': notices.digest(context)},
                               'source_inventory': {'sha256': notices.digest(source)}},
                    'components': inventory['components'], 'compiler_tooling': inventory['compiler_tooling']}
        self.assertIn(b'original-generator 1.2.4', notices.render([retained]))
        self.refused('unresolved attribution obligation')

    def test_source_tooling_pending_cannot_be_erased_or_notices_omitted(self):
        provider, inventory, context, text = self.tooling_inventory()
        source = Path(provider['source_inventory']['input']).read_bytes()
        omitted = {**inventory, 'pending_scopes': []}
        with self.assertRaisesRegex(ValueError, 'erased their incomplete native scope'):
            notices.validate_scope('first-party', provider['producer'], omitted, context, source, text, inventory['artifacts'])
        with self.assertRaisesRegex(ValueError, 'original selected inventory'):
            notices.validate_scope('first-party', provider['producer'], inventory, context, source,
                                   notices.closure.render(inventory), inventory['artifacts'])
        missing = {key: value for key, value in inventory.items() if key != 'compiler_tooling'}
        with self.assertRaisesRegex(ValueError, 'original compiler-tooling partition'):
            notices.validate_scope('first-party', provider['producer'], missing, context, source, text, inventory['artifacts'])

    def test_tooling_components_refuse_foreign_native_context_and_mutated_original_notice_text(self):
        provider, inventory, context, text = self.tooling_inventory()
        source = Path(provider['source_inventory']['input']).read_bytes()
        foreign = notices.pack.load_json(context)
        foreign['compiler_tooling'][0]['native']['label'] = '//foreign:native'
        raw = notices.pack.canonical(foreign)
        changed = {**inventory, 'configuration': notices.digest(raw)}
        with self.assertRaisesRegex(ValueError, 'configured native supplier'):
            notices.validate_scope('first-party', provider['producer'], changed, raw, source, text, inventory['artifacts'])
        changed = copy.deepcopy(inventory)
        changed['compiler_tooling'][0]['texts'][0]['text'] += 'foreign text'
        with self.assertRaisesRegex(ValueError, 'selected component bytes'):
            notices.validate_scope('first-party', provider['producer'], changed, context, source, text, inventory['artifacts'])

    def test_tooling_original_member_facts_and_partition_overlap_refuse(self):
        _, inventory, _, _ = self.tooling_inventory()
        for mutation in ['native', 'members', 'duplicate']:
            with self.subTest(mutation=mutation):
                changed = copy.deepcopy(inventory)
                if mutation == 'native':
                    changed['compiler_tooling'][0]['native']['size'] = 17.0
                elif mutation == 'members':
                    changed['compiler_tooling'][0]['source_members'][0]['compiler_owner'] = '//foreign:file'
                else:
                    changed['compiler_tooling'][0]['id'] = changed['components'][0]['id']
                with self.assertRaises(ValueError):
                    notices.compiler_tooling(changed)


    def test_external_notice_inventory_cannot_drop_explicit_tooling_partition(self):
        metadata = self.root / 'complete.notices.json'
        value = notices.pack.load_json(metadata.read_bytes())
        self.assertTrue(all(item['compiler_tooling'] == [] for item in value['providers']))
        value['providers'][0].pop('compiler_tooling')
        metadata.write_bytes(notices.pack.canonical(value))
        self.case.refused()


    def test_unchanged_native_context_cannot_erase_both_selected_tooling_and_pending(self):
        provider, inventory, context, _ = self.tooling_inventory()
        source = Path(provider['source_inventory']['input']).read_bytes()
        erased = {**inventory, 'compiler_tooling': [], 'pending_scopes': []}
        text = notices.closure.render(erased)
        with self.assertRaisesRegex(ValueError, 'Configured compiler tooling erased'):
            notices.validate_scope('first-party', provider['producer'], erased, context, source,
                                   text, inventory['artifacts'])
        Path(provider['inventory']['input']).write_bytes(notices.pack.canonical(erased))
        Path(provider['notices']['input']).write_bytes(text)
        self.refused('Configured compiler tooling erased')
        # Configured generators can have no selected source members, but remain incomplete.
        erased['pending_scopes'] = ['compiler-tooling']
        pending = notices.validate_scope('first-party', provider['producer'], erased, context, source,
                                         text, inventory['artifacts'])
        self.assertEqual(pending, ['compiler-tooling'])
        Path(provider['inventory']['input']).write_bytes(notices.pack.canonical(erased))
        self.refused('unresolved attribution obligation')

if __name__ == '__main__':
    unittest.main()
