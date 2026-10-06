"""Declared package materialization controls on actual empty/binary/aliased inputs."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('package_tree', Path(__file__).with_name('package-tree.py'))
tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tree)


class PackageTree(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'Cargo.toml').write_bytes(b'[package]\nname="fixture"\n')
        self.value = {'manifest': str(self.source / 'Cargo.toml'),
                      'files': [{'path': 'Cargo.toml', 'input': str(self.source / 'Cargo.toml')}]}

    def test_complete_empty_and_binary_sources_copy_to_regular_files(self):
        for name, content in [('empty', b''), ('binary', b'\xff\x00')]:
            (self.source / name).write_bytes(content)
            self.value['files'].append({'path': name, 'input': str(self.source / name)})
        output = self.root / 'output'
        tree.produce(self.value, output)
        self.assertEqual((output / 'empty').read_bytes(), b'')
        self.assertEqual((output / 'binary').read_bytes(), b'\xff\x00')
        with self.assertRaises(FileExistsError): tree.produce(self.value, output)

    def test_missing_manifest_duplicate_and_redirected_files_reject(self):
        for value in [{'manifest': self.value['manifest'], 'files': []},
                      self.value | {'files': self.value['files'] * 2},
                      self.value | {'files': [{'path': '../Cargo.toml', 'input': self.value['manifest']}]},
                      self.value | {'files': [{'path': 'other', 'input': self.value['manifest']}]}]:
            with self.assertRaises(ValueError): tree.produce(value, self.root / 'invalid')
        (self.root / 'outside').write_bytes(b'outside')
        (self.source / 'alias').symlink_to(self.root / 'outside')
        self.value['files'].append({'path': 'alias', 'input': str(self.source / 'alias')})
        with self.assertRaises(ValueError): tree.produce(self.value, self.root / 'invalid')
        self.assertFalse((self.root / 'invalid').exists())

    def test_engine_file_aliases_and_precreated_tree_root(self):
        sandbox = self.root / 'sandbox'
        sandbox.mkdir()
        (sandbox / 'Cargo.toml').symlink_to(self.source / 'Cargo.toml')
        value = {'manifest': str(sandbox / 'Cargo.toml'),
                 'files': [{'path': 'Cargo.toml', 'input': str(sandbox / 'Cargo.toml')}]}
        output = self.root / 'output'
        output.mkdir()
        tree.produce(value, output)
        self.assertEqual((output / 'Cargo.toml').read_bytes(), (self.source / 'Cargo.toml').read_bytes())
        self.assertFalse((output / 'Cargo.toml').is_symlink())

    def test_original_internal_file_and_directory_aliases_reject(self):
        (self.source / 'unrelated.txt').write_text('Unrelated package bytes\n')
        (self.source / 'LICENSE').symlink_to('unrelated.txt')
        value = self.value | {'files': self.value['files'] + [{'path': 'LICENSE', 'input': str(self.source / 'LICENSE')}]}
        with self.assertRaises(ValueError): tree.produce(value, self.root / 'output')
        self.assertFalse((self.root / 'output').exists())

        (self.source / 'actual').mkdir()
        (self.source / 'actual' / 'NOTICE').write_text('Notice bytes\n')
        (self.source / 'legal').symlink_to('actual', target_is_directory=True)
        value = self.value | {'files': self.value['files'] + [{'path': 'legal/NOTICE', 'input': str(self.source / 'legal' / 'NOTICE')}]}
        with self.assertRaises(OSError): tree.produce(value, self.root / 'output')
        self.assertFalse((self.root / 'output').exists())

    def test_exact_declared_javascript_manifest_and_engine_alias_copy(self):
        manifest = self.source / 'package.json'
        manifest.write_bytes(b'{"name":"@fixture/app","license":"AGPL-3.0-only"}\n')
        sandbox = self.root / 'sandbox'
        sandbox.mkdir()
        (sandbox / 'package.json').symlink_to(manifest)
        value = {'manifest': str(sandbox / 'package.json'),
                 'files': [{'path': 'package.json', 'input': str(sandbox / 'package.json')}]}
        output = self.root / 'output'
        tree.produce(value, output)
        self.assertEqual((output / 'package.json').read_bytes(), manifest.read_bytes())
        self.assertFalse((output / 'package.json').is_symlink())

    def test_javascript_manifest_omission_wrong_name_and_original_alias_refuse(self):
        manifest = self.source / 'package.json'
        manifest.write_bytes(b'{"name":"@fixture/app"}\n')
        for value in [
            {'manifest': str(manifest), 'files': self.value['files']},
            {'manifest': str(self.source / 'Cargo.toml'),
             'files': [{'path': 'package.json', 'input': str(manifest)}]},
        ]:
            with self.assertRaisesRegex(ValueError, 'Exact declared package manifest'):
                tree.produce(value, self.root / 'output')
            self.assertFalse((self.root / 'output').exists())
        unsupported = self.source / 'other.json'
        unsupported.write_bytes(manifest.read_bytes())
        with self.assertRaisesRegex(ValueError, 'Exact declared package manifest'):
            tree.produce({'manifest': str(unsupported),
                          'files': [{'path': 'other.json', 'input': str(unsupported)}]}, self.root / 'output')
        manifest.unlink()
        manifest.symlink_to('other.json')
        with self.assertRaisesRegex(ValueError, 'Exact declared package manifest'):
            tree.produce({'manifest': str(manifest),
                          'files': [{'path': 'package.json', 'input': str(manifest)}]}, self.root / 'output')
        self.assertFalse((self.root / 'output').exists())

    def test_output_parent_replacement_cannot_write_or_clean_outside(self):
        (self.source / 'nested').mkdir()
        (self.source / 'nested' / 'NOTICE').write_text('Declared notice\n')
        value = self.value | {'files': self.value['files'] + [{'path': 'nested/NOTICE', 'input': str(self.source / 'nested' / 'NOTICE')}]}
        output, outside = self.root / 'output', self.root / 'outside'
        outside.mkdir()
        (outside / 'sentinel').write_bytes(b'caller-owned')
        original_open = os.open
        raced = False
        def interpose(name, flags, mode=0o777, *, dir_fd=None):
            nonlocal raced
            descriptor = original_open(name, flags, mode, dir_fd=dir_fd)
            if name == 'nested' and dir_fd is not None and output.exists() and not raced:
                if os.fstat(dir_fd).st_ino == output.stat().st_ino:
                    raced = True
                    (output / 'nested').rename(output / 'retained')
                    (output / 'nested').symlink_to(outside, target_is_directory=True)
            return descriptor
        with patch.object(os, 'open', interpose):
            with self.assertRaises(BaseExceptionGroup): tree.produce(value, output)
        self.assertTrue(raced)
        self.assertEqual(sorted(path.name for path in outside.iterdir()), ['sentinel'])
        self.assertEqual((outside / 'sentinel').read_bytes(), b'caller-owned')
        self.assertTrue((output / 'nested').is_symlink())



if __name__ == '__main__':
    unittest.main()
