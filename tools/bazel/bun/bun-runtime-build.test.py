"""Controls use the actual pinned original Bun source archive, never a toy runtime."""
import argparse
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


class OriginalBuildInputs(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / 'original.tar.gz'
        self.archive.symlink_to(arguments.source_archive.resolve(strict=True))
        self.output = self.root / 'sources'

    def prepare(self):
        builder.prepare(self.archive, pins, self.output, custody, deployment, output_tree)

    def test_actual_original_engine_all_regular_sources_and_literal_aliases(self):
        self.prepare()
        manifest = json.loads((self.output / 'source-inputs.json').read_bytes())
        original, facts = custody.source_members(arguments.source_archive.read_bytes(), pins,
                                                 deployment.license_inputs.relative)
        self.assertEqual(manifest['members'], facts)
        self.assertEqual(manifest['commit'], pins['commit'])
        self.assertNotIn('components', manifest)
        self.assertNotIn('pending_scopes', manifest)
        self.assertNotIn('selected_source_members', manifest)
        files = {p.relative_to(self.output).as_posix() for p in self.output.rglob('*') if p.is_file()}
        self.assertEqual(files, set(original) | {'source-inputs.json'})
        for fact in facts:
            path = self.output / fact['path']
            if fact['kind'] == 'file':
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), fact['sha256'])
            else:
                self.assertFalse(path.exists(), 'TreeArtifact must not follow original source aliases')
        self.assertIn('scripts/build.ts', files)
        self.assertIn('rust-toolchain.toml', files)
        self.assertIn(b'nightly-2026-07-20', (self.output / 'rust-toolchain.toml').read_bytes())

    def test_changed_original_refuses_before_output_creation(self):
        self.archive.unlink()
        self.archive.write_bytes(b'foreign source archive')
        with self.assertRaisesRegex(ValueError, 'pinned original'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_existing_foreign_output_is_preserved(self):
        self.output.mkdir()
        sentinel = self.output / 'another-owner'
        sentinel.write_bytes(b'preserve')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(sentinel.read_bytes(), b'preserve')

    def test_input_retarget_during_publication_retires_all_owned_files(self):
        foreign = self.root / 'foreign.tar.gz'
        foreign.write_bytes(b'foreign')
        original = output_tree.OutputTree.write
        count = 0

        def write(tree, name, body):
            nonlocal count
            original(tree, name, body)
            count += 1
            if count == 1:
                self.archive.unlink()
                self.archive.symlink_to(foreign)

        output_tree.OutputTree.write = write
        try:
            with self.assertRaises(ValueError):
                self.prepare()
        finally:
            output_tree.OutputTree.write = original
        self.assertFalse(self.output.exists())
        self.assertEqual(foreign.read_bytes(), b'foreign')

    def test_actual_original_definitions_cover_exact_four_native_acquisition_closures(self):
        output = self.root / 'requirements.json'
        builder.requirements(self.archive, pins, output, arguments.engine, arguments.bun,
                             custody, deployment, output_tree)
        actual = json.loads(output.read_bytes())
        build_pins = json.loads(arguments.build_pins.read_bytes())
        self.assertEqual(actual['commit'], build_pins['bun_commit'])
        self.assertEqual({(c['os'], c['arch']) for c in actual['configured']},
                         {('darwin', 'aarch64'), ('darwin', 'x64'),
                          ('linux', 'aarch64'), ('linux', 'x64')})
        for configuration in actual['configured']:
            selected = {s['name']: s for s in configuration['sources']}
            self.assertEqual(len(selected), 23)
            self.assertEqual(set(selected), set(build_pins['dependencies']) | {'sqlite', 'WebKit'})
            self.assertEqual(selected['sqlite'], {'name': 'sqlite', 'kind': 'in-tree',
                                                 'path': 'src/jsc/bindings/sqlite'})
            for name, pin in build_pins['dependencies'].items():
                self.assertEqual(selected[name]['url'], pin['original_url'])
                self.assertEqual(selected[name]['kind'], pin['kind'])
                if pin['kind'] == 'github-archive':
                    self.assertEqual(selected[name]['revision'], pin['revision'])
                    self.assertEqual(selected[name]['repository'], pin['repository'])
            webkit = selected['WebKit']
            platform = ('macos' if configuration['os'] == 'darwin' else 'linux')
            platform += '-arm64' if configuration['arch'] == 'aarch64' else '-amd64'
            self.assertEqual(webkit['identity'], '2e2aa2290fac856d6f451ceacb58f7f5b44dd057-lto')
            self.assertEqual(webkit['url'], 'https://github.com/oven-sh/WebKit/releases/download/'
                             'autobuild-2e2aa2290fac856d6f451ceacb58f7f5b44dd057/'
                             'bun-webkit-' + platform + '-lto.tar.gz')
        self.assertNotIn('components', actual)
        self.assertNotIn('selected_source_members', actual)

    def test_published_original_file_substitution_and_in_place_bytes_refuse(self):
        original, _ = custody.source_members(arguments.source_archive.read_bytes(), pins,
                                              deployment.license_inputs.relative)
        name = 'scripts/build.ts'
        body = original[name]
        for substitution in ['symlink', 'bytes']:
            directory = self.root / substitution
            foreign = self.root / (substitution + '-foreign')
            foreign.write_bytes(body)
            tree = output_tree.OutputTree(directory)
            verify = tree.verify
            replaced = False

            def mutate():
                nonlocal replaced
                verify()
                target = directory / name
                if target.exists() and not replaced:
                    replaced = True
                    if substitution == 'symlink':
                        target.unlink()
                        target.symlink_to(foreign)
                    else:
                        target.write_bytes(b'x' * len(body))

            tree.verify = mutate
            try:
                with self.assertRaisesRegex(ValueError, 'File identity or bytes changed'):
                    builder.write_sources(tree, {name: body}, output_tree)
                self.assertTrue(replaced)
                self.assertEqual(foreign.read_bytes(), body)
            finally:
                tree.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-archive', required=True, type=Path)
    parser.add_argument('--builder', required=True, type=Path)
    parser.add_argument('--custody', required=True, type=Path)
    parser.add_argument('--deployment', required=True, type=Path)
    parser.add_argument('--output-tree', required=True, type=Path)
    parser.add_argument('--pins', required=True, type=Path)
    parser.add_argument('--build-pins', required=True, type=Path)
    parser.add_argument('--engine', required=True, type=Path)
    parser.add_argument('--bun', required=True, type=Path)
    arguments, remaining = parser.parse_known_args()
    builder = load('original_bun_builder', arguments.builder)
    custody = load('original_bun_custody', arguments.custody)
    deployment = load('declared_deployment', arguments.deployment)
    output_tree = load('declared_output_tree', arguments.output_tree)
    pins = json.loads(arguments.pins.read_bytes())
    unittest.main(argv=[sys.argv[0], *remaining])
