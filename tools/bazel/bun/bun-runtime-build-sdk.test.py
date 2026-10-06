"""Original Darwin ARM64 nightly SDK payload and executable controls."""
import argparse
import hashlib
import importlib.util
import json
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class OriginalNightlyPayload(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'sdk'
        self.specification = json.loads(arguments.spec.read_bytes())

    def assemble(self):
        return sdk.assemble(self.specification, pins, self.output, custody,
                            deployment, output_tree, builder)

    def test_original_full_payload_and_actual_compiler_cargo(self):
        self.assertEqual(self.specification['target'], 'aarch64-apple-darwin')
        files = self.assemble()
        manifest = json.loads((self.output / 'sdk-payload.json').read_bytes())
        self.assertEqual(manifest['channel'], 'nightly-2026-07-20')
        self.assertEqual(len(manifest['components']), 4)
        self.assertEqual(set(files), {f['path'] for f in manifest['files']} | {'sdk-payload.json'})
        self.assertNotIn('components_selected', manifest)
        self.assertNotIn('pending_scopes', manifest)
        for file in manifest['files']:
            output = self.output / file['path']
            self.assertFalse(output.is_symlink())
            self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), file['sha256'])
            self.assertEqual(output.stat().st_mode & 0o777, 0o555 if file['mode'] & 0o111 else 0o444)
        env = {'PATH': '', 'HOME': str(self.root), 'TMPDIR': str(self.root)}
        compiler = subprocess.run([str(self.output / 'bin/rustc'), '-vV'],
                                  check=True, env=env, capture_output=True, text=True)
        self.assertIn('release: 1.99.0-nightly', compiler.stdout.splitlines())
        self.assertIn('commit-date: 2026-07-19', compiler.stdout.splitlines())
        self.assertIn('host: aarch64-apple-darwin', compiler.stdout.splitlines())
        self.assertTrue(any(line.startswith('commit-hash: 9f36de775')
                            for line in compiler.stdout.splitlines()))
        cargo = subprocess.run([str(self.output / 'bin/cargo'), '--version'],
                               check=True, env=env, capture_output=True, text=True)
        self.assertIn('cargo 1.99.0-nightly (3efb1f477 2026-07-17)', cargo.stdout)

    def test_wrong_target_refuses_same_original_archives(self):
        self.specification['target'] = 'x86_64-apple-darwin'
        with self.assertRaisesRegex(ValueError, 'pinned publisher'):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_missing_component_refuses_before_output(self):
        del self.specification['archives']['rust-src']
        with self.assertRaisesRegex(ValueError, 'four original components'):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_changed_original_archive_refuses_before_output(self):
        changed = self.root / 'changed.tar.xz'
        changed.write_bytes(b'foreign component')
        self.specification['archives']['cargo'] = str(changed)
        with self.assertRaisesRegex(ValueError, 'pinned publisher'):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_late_original_rustc_executable_mode_change_refuses_and_retires(self):
        original = builder.verify_files
        count = 0
        def verify(tree, members, output):
            nonlocal count
            count += 1
            if count == 2:
                target = self.output / 'bin/rustc'
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o555)
                target.chmod(0o444)
            return original(tree, members, output)
        builder.verify_files = verify
        try:
            with self.assertRaisesRegex(ValueError, 'executable mode changed'):
                self.assemble()
        finally:
            builder.verify_files = original
        self.assertFalse(self.output.exists())

    def test_existing_foreign_output_preserved(self):
        self.output.mkdir()
        sentinel = self.output / 'foreign'
        sentinel.write_bytes(b'preserved')
        with self.assertRaises(FileExistsError):
            self.assemble()
        self.assertEqual(sentinel.read_bytes(), b'preserved')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['spec', 'pins', 'sdk', 'builder', 'custody', 'deployment', 'output-tree']:
        parser.add_argument('--' + name, required=True, type=Path)
    arguments, remaining = parser.parse_known_args()
    pins = json.loads(arguments.pins.read_bytes())
    sdk = load('original_nightly_sdk', arguments.sdk)
    builder = load('original_bun_builder', arguments.builder)
    custody = load('original_bun_custody', arguments.custody)
    deployment = load('declared_deployment', arguments.deployment)
    output_tree = load('declared_output_tree', arguments.output_tree)
    unittest.main(argv=[sys.argv[0], *remaining])
