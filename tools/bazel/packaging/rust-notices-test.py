"""Selected compiler graph, effective manifest and exclusive publication controls."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rust_notices', Path(__file__).with_name('rust-notices.py'))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class RustNotices(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / 'Cargo.toml').write_text('[workspace]\n')
        (self.root / 'LICENSE').write_text('Repository license text\n')
        self.packages = {}
        self.materialized = {}
        for name, expression, source in [('application', 'AGPL-3.0-only', None), ('dependency', 'MIT', 'registry+https://example.invalid')]:
            tree = self.root / name
            tree.mkdir()
            (tree / 'Cargo.toml').write_text(f'[package]\nname="{name}"\nversion="1.0.0"\nlicense="{expression}"\n')
            if source is not None:
                (tree / 'LICENSE').write_text('Dependency license text\n')
            self.packages[name] = {'id': name, 'name': name, 'version': '1.0.0', 'source': source,
                                   'license': expression, 'license_file': None, 'repository': None,
                                   'archive_checksum': None}
            self.materialized[name] = {'root': str(tree), 'source_label': f'//{name}:package_data',
                                       'manifest_label': f'//{name}:Cargo.toml'}
        self.graph = {'configuration': {'compiler_root': '//application:binary', 'target': 'aarch64-apple-darwin'},
                      'roots': ['application'],
                      'units': {'application': {'pkg_id': 'application', 'dependencies': [{'unit': 'dependency'}]},
                                'dependency': {'pkg_id': 'dependency', 'dependencies': []}},
                      'packages': self.packages,
                      'package_sources': {key: value['source_label'] for key, value in self.materialized.items()},
                      'package_manifests': {key: value['manifest_label'] for key, value in self.materialized.items()}}
        self.value = {'descriptor': str(self.root / 'descriptor.json'),
                      'compiler_root': '//application:binary', 'target': 'aarch64-apple-darwin',
                      'packages': self.materialized, 'workspace_manifest': str(self.root / 'Cargo.toml'),
                      'workspace_license': str(self.root / 'LICENSE')}

    def collect(self, graph=None, value=None):
        (self.root / 'descriptor.json').write_text(json.dumps(self.graph if graph is None else graph))
        return notices.collect(self.value if value is None else value)

    def test_exact_transitive_packages_and_repository_license_ownership(self):
        result = self.collect()
        self.assertEqual([item['id'] for item in result['components']], ['application', 'dependency'])
        self.assertEqual(result['components'][0]['texts'][0]['label'], '//:LICENSE')
        self.assertEqual(result['components'][1]['texts'][0]['text'], 'Dependency license text\n')
        self.assertTrue(result['pending'])
        self.assertNotIn('shipping_qualified', result)

    def test_missing_unused_cyclic_units_and_packages_reject(self):
        modifications = []
        graph = copy.deepcopy(self.graph)
        graph['units'].pop('dependency')
        modifications.append(graph)
        graph = copy.deepcopy(self.graph)
        graph['units']['unused'] = {'pkg_id': 'dependency', 'dependencies': []}
        modifications.append(graph)
        graph = copy.deepcopy(self.graph)
        graph['units']['dependency']['dependencies'] = [{'unit': 'application'}]
        modifications.append(graph)
        graph = copy.deepcopy(self.graph)
        graph['units']['application']['dependencies'] = []
        modifications.append(graph)
        for graph in modifications:
            with self.assertRaises(ValueError): self.collect(graph)

    def test_foreign_context_source_and_manifest_labels_reject(self):
        for key in ['compiler_root', 'target']:
            with self.assertRaises(ValueError): self.collect(value=self.value | {key: 'foreign'})
        for key in ['source_label', 'manifest_label']:
            value = copy.deepcopy(self.value)
            value['packages']['dependency'][key] = '//foreign:source'
            with self.assertRaises(ValueError): self.collect(value=value)
        for mapping in ['packages', 'package_sources', 'package_manifests']:
            graph = copy.deepcopy(self.graph)
            graph[mapping].pop('dependency')
            with self.assertRaises(ValueError): self.collect(graph)

    def test_effective_manifest_and_required_published_text_reject(self):
        manifest = self.root / 'dependency' / 'Cargo.toml'
        original = manifest.read_bytes()
        manifest.write_bytes(original.replace(b'"MIT"', b'"Apache-2.0"'))
        with self.assertRaises(ValueError): self.collect()
        manifest.write_bytes(original)
        (self.root / 'dependency' / 'LICENSE').unlink()
        with self.assertRaises(ValueError): self.collect()

    def test_local_published_notice_is_preserved(self):
        (self.root / 'application' / 'NOTICE').write_text('Local third party notice\n')
        result = self.collect()
        self.assertEqual([text['path'] for text in result['components'][0]['texts']], ['LICENSE', 'NOTICE'])

    def test_original_repository_license_alias_rejects(self):
        (self.root / 'unrelated.txt').write_text('Unpublished unrelated bytes\n')
        (self.root / 'LICENSE').unlink()
        (self.root / 'LICENSE').symlink_to('unrelated.txt')
        with self.assertRaises(ValueError): self.collect()

    def test_failure_removes_created_output_and_preserves_existing_or_alias(self):
        inventory = self.collect()
        first, second = self.root / 'inventory.json', self.root / 'notices.txt'
        second.write_bytes(b'caller-owned')
        with self.assertRaises(FileExistsError): notices.publish(inventory, first, second)
        self.assertFalse(first.exists())
        self.assertEqual(second.read_bytes(), b'caller-owned')
        second.unlink()
        second.symlink_to(self.root / 'LICENSE')
        with self.assertRaises(FileExistsError): notices.publish(inventory, first, second)
        self.assertFalse(first.exists())
        self.assertTrue(second.is_symlink())
        self.assertEqual((self.root / 'LICENSE').read_text(), 'Repository license text\n')
        second.unlink()
        notices.publish(inventory, first, second)
        self.assertEqual(json.loads(first.read_bytes()), inventory)
        self.assertIn('Dependency license text', second.read_text())
        with self.assertRaises(FileExistsError): notices.publish(inventory, first, second)

    def test_two_output_parent_replacement_cannot_redirect_publication(self):
        inventory = self.collect()
        parent, outside = self.root / 'publication', self.root / 'outside'
        parent.mkdir()
        outside.mkdir()
        (outside / 'sentinel').write_bytes(b'caller-owned')
        original = os.open
        raced = False
        def interpose(name, flags, mode=0o777, *, dir_fd=None):
            nonlocal raced
            descriptor = original(name, flags, mode, dir_fd=dir_fd)
            if name == 'inventory.json' and dir_fd is not None and not raced:
                raced = True
                parent.rename(self.root / 'retained')
                parent.symlink_to(outside, target_is_directory=True)
            return descriptor
        with patch.object(os, 'open', interpose):
            with self.assertRaises(ValueError): notices.publish(inventory, parent / 'inventory.json', parent / 'NOTICES.txt')
        self.assertTrue(raced)
        self.assertEqual(sorted(member.name for member in outside.iterdir()), ['sentinel'])
        self.assertEqual((outside / 'sentinel').read_bytes(), b'caller-owned')
        self.assertEqual(list((self.root / 'retained').iterdir()), [])
        self.assertTrue(parent.is_symlink())


if __name__ == '__main__':
    unittest.main()
