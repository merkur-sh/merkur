"""Explicit synthetic compiler fixtures exercise the original aggregation boundary."""
import copy
import hashlib
import importlib.util
import sys
import unittest
from pathlib import Path


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture_path = Path(sys.argv.pop(1))
fixtures = load('compiled_generator_fixtures', fixture_path)
selected = load('selected_wasm_generator', Path(__file__).with_name('selected-attribution.py'))


class GeneratorLicenseControls(fixtures.CompiledRustCustody):
    def setUp(self):
        fixtures.CompiledRustCustody.setUp(self)
        self.tools = [{'input': str(self.artifact), 'label': self.value['producer'],
                       'size': len(self.artifact.read_bytes()),
                       'sha256': hashlib.sha256(self.artifact.read_bytes()).hexdigest()}]

    def aggregate(self, tools=None, producers=None, stdlib=None):
        return selected.generator_licenses(self.tools if tools is None else tools,
            [self.value] if producers is None else producers, fixtures.metadata,
            self.units, self.notices, self.closure, self.standard if stdlib is None else stdlib)

    def test_original_generator_sources_license_and_file_identity_are_retained(self):
        result = self.aggregate()
        self.assertEqual(result['origins'][0]['artifact'], self.tools[0])
        self.assertEqual(result['components'][0]['texts'][0]['text'], 'Original package license text\n')
        self.assertTrue(result['origins'][0]['sources']['packages']['fixture'])
        self.assertNotIn('pending_scopes', result)

    def test_generator_stdlib_missing_action_compiler_cannot_become_complete(self):
        del self.stock_inventory['rustc']
        self.publish_stock_fixture()
        with self.assertRaisesRegex(ValueError, 'action compiler File custody'):
            self.aggregate()

    def test_generator_stdlib_changed_action_compiler_invalidates_admission(self):
        compiler = Path(self.stock_inventory['rustc']['path'])
        compiler.chmod(0o755)
        compiler.write_bytes(b'Explicitly synthetic foreign same-version compiler\n')
        compiler.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'action compiler File changed'):
            self.aggregate()

    def test_same_tool_in_multiple_stages_does_not_duplicate_components(self):
        self.assertEqual(self.aggregate(tools=self.tools * 3), self.aggregate())

    def test_absence_foreign_extra_or_duplicate_producers_are_refused(self):
        foreign = copy.deepcopy(self.value)
        foreign['artifact']['input'] += '-foreign'
        for tools, producers in [([], [self.value]), (self.tools, []),
                                  (self.tools, [foreign]), (self.tools, [self.value, foreign]),
                                  (self.tools, [self.value, self.value])]:
            with self.subTest(producers=producers):
                with self.assertRaises(ValueError): self.aggregate(tools, producers)

    def test_changed_action_file_bytes_or_owner_cannot_retain_old_license_admission(self):
        for field, value in [('sha256', '0' * 64), ('size', self.tools[0]['size'] + 1),
                              ('label', '//foreign:tool')]:
            tools = copy.deepcopy(self.tools)
            tools[0][field] = value
            with self.subTest(field=field):
                with self.assertRaises(ValueError): self.aggregate(tools=tools)

    def test_mit_expression_without_published_original_text_is_not_a_closure(self):
        (self.package / 'LICENSE').unlink()
        with self.assertRaises(FileNotFoundError): self.aggregate()

    def test_actual_configured_compiler_and_package_mutations_are_refused(self):
        for field, value in [('crate_type', 'rlib'), ('features', ['foreign']),
                              ('rustc_flags', ['-Copt-level=0'])]:
            producer = copy.deepcopy(self.value)
            producer['units'][0][field] = value
            with self.subTest(field=field):
                with self.assertRaises(ValueError): self.aggregate(producers=[producer])
        producer = copy.deepcopy(self.value)
        producer['packages']['fixture']['source_label'] = '//foreign:package_data'
        with self.assertRaises(ValueError): self.aggregate(producers=[producer])

    def test_missing_linked_stdlib_provider_cannot_become_complete(self):
        def unresolved(*arguments):
            raise ValueError('Original standard-library attribution is unresolved')
        with self.assertRaisesRegex(ValueError, 'standard-library'):
            self.aggregate(stdlib=unresolved)
        with self.assertRaisesRegex(ValueError, 'standard-library'):
            self.aggregate(stdlib=False)

    def test_equal_text_from_foreign_license_file_is_not_original_package_custody(self):
        foreign = self.root / 'foreign-license'
        foreign.write_bytes((self.package / 'LICENSE').read_bytes())
        producer = copy.deepcopy(self.value)
        for value in producer['packages']['fixture']['files']:
            if value['input'] == str(self.package / 'LICENSE'):
                value['input'] = str(foreign)
                value['label'] = '//foreign:license'
        # The old compiled collector accepts equal content without original member binding.
        fixtures.metadata.collect_compiled(producer, self.units, self.notices, self.closure, self.standard)
        with self.assertRaisesRegex(ValueError, 'original declared package license File'):
            self.aggregate(producers=[producer])

    def test_original_package_license_change_invalidates_compiled_intermediate(self):
        (self.package / 'LICENSE').write_text('Different published text\n')
        with self.assertRaises(ValueError): self.aggregate()


if __name__ == '__main__':
    unittest.main()
