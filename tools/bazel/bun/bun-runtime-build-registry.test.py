"""Controls for the entire original Bun Cargo registry archive closure."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class OriginalRegistrySources(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'sources'
        self.specification = json.loads(arguments.spec.read_bytes())
        self.pins = copy.deepcopy(pins)

    def prepare(self):
        registry.prepare(self.specification, self.pins, source_pins, self.output,
                         custody, deployment, output_tree, builder)

    def test_actual_full_original_lock_closure_and_cargo_checksum_files(self):
        self.prepare()
        self.assertEqual(len(self.pins['packages']), 181)
        self.assertEqual({p.name for p in self.output.iterdir()},
                         {p['name'] + '-' + p['version'] for p in self.pins['packages']})
        for package in self.pins['packages']:
            directory = self.output / (package['name'] + '-' + package['version'])
            checksums = json.loads((directory / '.cargo-checksum.json').read_bytes())
            self.assertEqual(checksums['package'], package['sha256'])
            files = {p.relative_to(directory).as_posix(): p for p in directory.rglob('*') if p.is_file()}
            self.assertEqual(set(files), set(checksums['files']) | {'.cargo-checksum.json'})
            self.assertTrue(checksums['files'])
            self.assertIn('Cargo.toml', checksums['files'])
            for name, checksum in checksums['files'].items():
                self.assertFalse(files[name].is_symlink())
                self.assertEqual(hashlib.sha256(files[name].read_bytes()).hexdigest(), checksum)

    def test_missing_original_archive_refuses_before_output(self):
        self.specification['archives'].pop(next(iter(self.specification['archives'])))
        with self.assertRaisesRegex(ValueError, 'closure is incomplete'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_foreign_registry_pin_cannot_replace_original_lock_fact(self):
        self.pins['packages'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Cargo.lock membership'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_changed_original_crate_archive_refuses_before_output(self):
        first = self.pins['packages'][0]
        changed = self.root / 'changed.crate'
        changed.write_bytes(b'foreign package')
        self.specification['archives'][first['name'] + '@' + first['version']] = str(changed)
        with self.assertRaisesRegex(ValueError, 'archive checksum differs'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_existing_foreign_output_preserved(self):
        self.output.mkdir()
        sentinel = self.output / 'foreign'
        sentinel.write_bytes(b'preserve')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(sentinel.read_bytes(), b'preserve')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['spec', 'pins', 'source-pins', 'registry', 'builder', 'custody',
                 'deployment', 'output-tree']:
        parser.add_argument('--' + name, required=True, type=Path)
    arguments, remaining = parser.parse_known_args()
    pins = json.loads(arguments.pins.read_bytes())
    source_pins = json.loads(arguments.source_pins.read_bytes())
    registry = load('original_registry', arguments.registry)
    builder = load('original_bun_builder', arguments.builder)
    custody = load('original_custody', arguments.custody)
    deployment = load('declared_deployment', arguments.deployment)
    output_tree = load('declared_output_tree', arguments.output_tree)
    unittest.main(argv=[sys.argv[0], *remaining])
