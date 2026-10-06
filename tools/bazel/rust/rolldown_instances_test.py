"""Real original-source controls for configured Rolldown producer instances."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class OriginalInstances(unittest.TestCase):
    def test_each_original_configuration_keeps_its_compiler_and_published_version(self):
        for instance, archive in archives.items():
            original = acquisition.original_configuration(archive, pins[instance])
            self.assertEqual(json.loads(original['packages/rolldown/package.json'])['version'], pins[instance]['package_version'])
            self.assertIn(b'1.97.1', original['rust-toolchain.toml'])
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), pins[instance]['archive_sha256'])

    def test_wrong_instance_cannot_read_or_emit_another_original_archive(self):
        for instance, archive in archives.items():
            other = pins['vite' if instance == 'workspace' else 'workspace']
            with self.assertRaisesRegex(ValueError, 'digest differs'):
                acquisition.original_configuration(archive, other)
            with self.assertRaisesRegex(ValueError, 'original commit'):
                source.source_packages(archive, other)
            with self.assertRaisesRegex(ValueError, 'exact original archive'):
                generator.original_lock(archive, other)
            with self.assertRaisesRegex(ValueError, 'pinned digest'):
                registry.original_lock(archive, producer, other)

    def test_original_configuration_rejects_wrong_package_or_compiler_fact(self):
        for instance, archive in archives.items():
            for field in ['package_version', 'compiler_version']:
                identity = dict(pins[instance], **{field: '0.0.0'})
                with self.assertRaisesRegex(ValueError, 'identity differs'):
                    acquisition.original_configuration(archive, identity)

    def test_complete_original_registry_locks_remain_distinct_and_exact(self):
        for instance, archive in archives.items():
            lock, packages, fact = registry.original_lock(archive, producer, pins[instance])
            self.assertEqual(len(packages), 354 if instance == 'workspace' else 353)
            checksums = generator.original_lock(archive, pins[instance])
            expected = {(p['name'], p['version'], registry.REGISTRY): p['checksum'] for p in packages}
            self.assertEqual(checksums, expected)
            self.assertEqual(fact['sha256'], pins[instance]['archive_sha256'])
            if instance == 'vite':
                self.assertEqual(hashlib.sha256(lock).hexdigest(), '8428992ed77e104c948fe23e1ee37defd51e75bc1b00d0d7c489284992a18a0c')

    def test_each_inventory_retains_hidden_configuration_and_workspace_lints(self):
        for instance, archive in archives.items():
            packages = source.source_packages(archive, pins[instance])
            files = [(package + '/' if package else '') + file for package, value in packages.items() for file in value['files']]
            self.assertEqual(len(files), len(set(files)))
            self.assertIn('.cargo/config.toml', files)
            self.assertIn('Cargo.lock', files)
            self.assertEqual(packages['crates/rolldown_binding']['lints']['clippy']['pedantic'], 'deny')
        self.assertEqual(source.render(source.source_packages(archives['workspace'], pins['workspace'])), args.workspace_inventory.read_text())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source-instances', 'workspace-archive', 'vite-archive', 'workspace-inventory', 'source-helper', 'acquisition-helper', 'generator', 'registry-helper', 'producer']:
        parser.add_argument('--' + name, type=Path, required=True)
    global args, pins, archives, source, acquisition, generator, registry, producer
    args = parser.parse_args()
    pins = json.loads(args.source_instances.read_text())
    archives = {'workspace': args.workspace_archive, 'vite': args.vite_archive}
    source = load('instance_source', args.source_helper)
    acquisition = load('instance_acquisition', args.acquisition_helper)
    generator = load('instance_generator', args.generator)
    registry = load('instance_registry', args.registry_helper)
    producer = load('instance_producer', args.producer)
    unittest.main(argv=[str(Path(__file__))])

if __name__ == '__main__':
    main()
