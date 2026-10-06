"""Strict closure controls; fixtures do not claim production graph completeness."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('license_closure', Path(__file__).with_name('license-closure.py'))
closure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(closure)


class LicenseClosure(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / 'LICENSE').write_bytes(b'published fixture license\n')
        self.component = {'id': 'registry+primary#fixture@1.0.0', 'name': 'fixture', 'version': '1.0.0',
                          'source': 'registry+primary', 'license': 'MIT', 'repository': None,
                          'license_file': 'LICENSE', 'source_label': '@fixture//:source'}
        self.expected = {'producer': '//apps/fixture:binary', 'configuration': 'native-exact-context',
                         'source_digest': 'a' * 64, 'components': [self.component]}
        self.materialized = {self.component['id']: {'root': str(self.root), 'label': '@fixture//:source'}}

    def test_complete_deterministic_bytes_and_producer_identity(self):
        result = closure.collect(self.expected, self.materialized)
        self.assertEqual(result['producer'], '//apps/fixture:binary')
        self.assertEqual(result['components'][0]['texts'][0]['text'], 'published fixture license\n')
        self.assertIn(b'published fixture license\n', closure.render(result))
        self.assertEqual(closure.canonical(result), closure.canonical(closure.collect(self.expected, self.materialized)))

    def test_missing_extra_duplicate_and_foreign_sources(self):
        for sources in [{}, self.materialized | {'extra': self.materialized[self.component['id']]},
                        {self.component['id']: {'root': str(self.root), 'label': '@foreign//:source'}}]:
            with self.assertRaises(ValueError): closure.collect(self.expected, sources)
        expected = copy.deepcopy(self.expected)
        expected['components'].append(expected['components'][0])
        with self.assertRaises(ValueError): closure.collect(expected, self.materialized)

    def test_metadata_shape_and_unresolved_license_fail_closed(self):
        for key, value in [('source_digest', True), ('configuration', ''), ('producer', '../binary'),
                           ('components', []), ('qualified', True)]:
            expected = copy.deepcopy(self.expected)
            expected[key] = value
            with self.assertRaises(ValueError): closure.collect(expected, self.materialized)
        for key, value in [('license', 'UNSTATED'), ('license', ''), ('version', None),
                           ('license_file', '../LICENSE'), ('source', True), ('source_label', '//bad')]:
            expected = copy.deepcopy(self.expected)
            expected['components'][0][key] = value
            with self.assertRaises(ValueError): closure.collect(expected, self.materialized)

    def test_missing_declared_text_never_skipped(self):
        self.component['license_file'] = 'MISSING'
        with self.assertRaises(FileNotFoundError): closure.collect(self.expected, self.materialized)
        self.component['license_file'] = None
        (self.root / 'LICENSE').unlink()
        with self.assertRaises(ValueError): closure.collect(self.expected, self.materialized)

    def test_actual_rules_js_store_labels_preserve_exact_declared_owner(self):
        for label in ['//:.aspect_rules_js/node_modules/deuri@3.0.0',
                      '//:.aspect_rules_js/node_modules/exact-mirror@1.2.6_typebox@1.3.23',
                      '@@npm+source//node_modules/@scope/package:package@1.0.0']:
            self.component['source_label'] = label
            self.materialized[self.component['id']]['label'] = label
            self.assertEqual(closure.collect(self.expected, self.materialized)['components'][0]['source_label'], label)
            self.materialized[self.component['id']]['label'] = label + '_foreign'
            with self.assertRaises(ValueError): closure.collect(self.expected, self.materialized)

    def test_canonical_main_and_named_repository_labels_keep_exact_identity(self):
        for producer in ['//apps/fixture:binary', '@@//apps/fixture:binary',
                         '@fixture//apps/fixture:binary', '@@fixture+source//apps/fixture:binary']:
            with self.subTest(producer=producer):
                self.expected['producer'] = producer
                self.assertEqual(closure.collect(self.expected, self.materialized)['producer'], producer)
        self.component['source_label'] = '@@//fixture:package_data'
        self.materialized[self.component['id']]['label'] = self.component['source_label']
        self.assertEqual(closure.collect(self.expected, self.materialized)['components'][0]['source_label'],
                         '@@//fixture:package_data')

    def test_malformed_empty_repository_labels_remain_refused(self):
        for producer in ['@//apps/fixture:binary', '@@@//apps/fixture:binary',
                         '@@//apps/fixture:', '@@apps/fixture:binary', '@@//apps/fixture:binary\n']:
            with self.subTest(producer=producer):
                self.expected['producer'] = producer
                with self.assertRaisesRegex(ValueError, 'producer context'):
                    closure.collect(self.expected, self.materialized)

    def test_license_file_only_retains_real_declaration(self):
        self.component['license'] = None
        result = closure.collect(self.expected, self.materialized)
        self.assertIsNone(result['components'][0]['license'])
        self.assertIn(b'Declared license file: LICENSE', closure.render(result))
        self.component['license_file'] = None
        with self.assertRaises(ValueError): closure.collect(self.expected, self.materialized)


    def private_workspace(self):
        self.component.update({'id': 'merkur#//:package.json', 'name': 'merkur', 'version': None,
                               'source': None, 'license': 'AGPL-3.0-only',
                               'source_label': '//:package.json', 'private': True})
        self.materialized = {self.component['id']: {'root': str(self.root), 'label': '//:package.json'}}
        metadata = {'name': 'merkur', 'private': True, 'license': 'AGPL-3.0-only'}
        (self.root / 'package.json').write_text(json.dumps(metadata))
        return metadata

    def test_original_private_unversioned_manifest_and_name_rendering(self):
        self.private_workspace()
        result = closure.collect(self.expected, self.materialized)
        self.assertIs(result['components'][0]['private'], True)
        self.assertIsNone(result['components'][0]['version'])
        self.assertIn(b'\nmerkur\nPackage identity: merkur#//:package.json\n', closure.render(result))
        self.assertNotIn(b'merkur None', closure.render(result))
        self.assertEqual(closure.canonical(result), closure.canonical(closure.collect(self.expected, self.materialized)))

    def test_private_component_refuses_registry_external_owner_and_invented_identity(self):
        self.private_workspace()
        original = copy.deepcopy(self.expected)
        for key, value in [('private', False), ('private', 1), ('version', '0.0.0'),
                           ('source', 'registry+primary'), ('source_label', '@foreign//:package.json'),
                           ('source_label', '//packages/other:package.json'), ('source_label', []), ('id', 'merkur@0.0.0'),
                           ('license', None)]:
            with self.subTest(key=key, value=value):
                expected = copy.deepcopy(original)
                expected['components'][0][key] = value
                with self.assertRaisesRegex(ValueError, 'private unversioned'):
                    closure.validate(expected)
        self.component['private'] = True
        self.component['version'] = '1.0.0'
        with self.assertRaisesRegex(ValueError, 'private unversioned'):
            closure.validate(self.expected)
        self.component.pop('private')
        self.assertEqual(set(closure.validate(self.expected)[0]), closure.FIELDS)

    def test_private_manifest_mutation_during_license_collection_refuses(self):
        metadata = self.private_workspace()
        original = closure.inputs.collect
        def mutate(root, license_file):
            texts = original(root, license_file)
            (self.root / 'package.json').write_text(json.dumps(metadata | {'license': 'MIT'}))
            return texts
        with patch.object(closure.inputs, 'collect', mutate):
            with self.assertRaisesRegex(ValueError, 'manifest changed during collection'):
                closure.collect(self.expected, self.materialized)

    def test_private_component_refuses_changed_original_manifest_metadata(self):
        metadata = self.private_workspace()
        for key, value in [('private', False), ('private', 1), ('name', 'foreign'),
                           ('license', 'MIT'), ('version', None), ('version', '0.0.0')]:
            with self.subTest(key=key, value=value):
                changed = metadata | {key: value}
                (self.root / 'package.json').write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, 'original workspace manifest'):
                    closure.collect(self.expected, self.materialized)

if __name__ == '__main__':
    unittest.main()
