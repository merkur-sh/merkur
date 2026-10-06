"""Actual original Bun frozen installations using the entire declared npm archive cache."""
import argparse
import copy
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


class OriginalNpmCache(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'cache'
        self.specification = json.loads(arguments.spec.read_bytes())
        self.pins = copy.deepcopy(pins)

    def prepare(self):
        npm.prepare(self.specification, self.pins, source_pins, self.output,
                    custody, deployment, output_tree, builder)

    def fixture(self):
        source = self.root / 'source'
        home = self.root / 'home'
        source.mkdir()
        home.mkdir()
        # The original Ninja command has no --offline argument. Original global
        # install.offline config closes that command without modifying upstream.
        (home / '.bunfig.toml').write_text('[install]\noffline = true\n')
        owned = deployment.DeclaredInputs()
        try:
            body, _ = custody.captured(self.specification['source_archive'], owned)
            members, _ = custody.source_members(body, source_pins, deployment.license_inputs.relative)
            for name in ['package.json', 'bun.lock', 'packages/bun-types/package.json',
                         'packages/bun-error/package.json', 'packages/bun-error/bun.lock',
                         'src/node-fallbacks/package.json', 'src/node-fallbacks/bun.lock']:
                destination = source / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(members[name])
            owned.verify()
        finally:
            owned.close()
        env = {'HOME': str(home), 'TMPDIR': str(self.root), 'PATH': '/__no_ambient_path__',
               'BUN_INSTALL_CACHE_DIR': str(self.output)}
        return source, env

    def test_original_all_three_frozen_installs_and_native_esbuild(self):
        self.prepare()
        self.assertEqual(len(self.pins['packages']), 163)
        packages = {p['name'] + '@' + p['version']: p for p in self.pins['packages']}
        names = npm.cache_names(packages)
        self.assertEqual(len(names), 163)
        self.assertEqual(names['querystring-es3@1.0.0-0'], 'querystring-es3@1.0.0-b8f8325b21a8a1e5@@@1')
        for identity, name in names.items():
            manifest = self.output / name / 'package.json'
            self.assertFalse(manifest.is_symlink())
            fields = json.loads(manifest.read_bytes())
            self.assertEqual(fields['name'] + '@' + fields['version'], identity)
        source, env = self.fixture()
        locks = {name: (source / name).read_bytes() for name in self.pins['locks']}
        for directory in ['', 'packages/bun-error', 'src/node-fallbacks']:
            actual = subprocess.run([str(arguments.bun), 'install', '--frozen-lockfile'],
                                    cwd=source / directory, env=env, capture_output=True)
            self.assertEqual(actual.returncode, 0, actual.stderr.decode())
            expected = {'': '19 packages installed', 'packages/bun-error': '1 package installed',
                        'src/node-fallbacks': '103 packages installed'}
            self.assertIn(expected[directory], actual.stdout.decode())
        for name, original in locks.items():
            self.assertEqual((source / name).read_bytes(), original)
        script = """const esbuild = require('./node_modules/esbuild/lib/main.js');
process.stdout.write(esbuild.transformSync('const answer = 42;', {minify:true}).code);"""
        actual = subprocess.run([str(arguments.bun), '--no-install', '--no-env-file', '--eval', script],
                                cwd=source, env=env, capture_output=True)
        self.assertEqual(actual.returncode, 0, actual.stderr.decode())
        self.assertEqual(actual.stdout, b'const answer=42;\n')

    def test_original_frozen_command_rejects_empty_cache_without_network(self):
        self.output.mkdir()
        source, env = self.fixture()
        original = (source / 'packages/bun-error/bun.lock').read_bytes()
        actual = subprocess.run([str(arguments.bun), 'install', '--frozen-lockfile'],
                                cwd=source / 'packages/bun-error', env=env, capture_output=True)
        self.assertNotEqual(actual.returncode, 0)
        self.assertIn(b'--offline', actual.stderr)
        self.assertIn(b'preact', actual.stderr)
        self.assertEqual((source / 'packages/bun-error/bun.lock').read_bytes(), original)

    def test_lock_parser_preserves_comma_delimiters_inside_strings(self):
        self.assertEqual(npm.read_lock(b'{"value": ", }", "other": [1,],}'),
                         {'value': ', }', 'other': [1]})
        with self.assertRaises(json.JSONDecodeError):
            npm.read_lock(b'{"value": [1,,]}')

    def test_missing_original_archive_refuses_before_output(self):
        self.specification['archives'].pop(next(iter(self.specification['archives'])))
        with self.assertRaisesRegex(ValueError, 'closure is incomplete'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_foreign_integrity_pin_refuses_original_lock_membership(self):
        self.pins['packages'][0]['integrity'] = 'sha512-foreign'
        with self.assertRaisesRegex(ValueError, 'lock membership'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_changed_original_archive_refuses_before_output(self):
        first = self.pins['packages'][0]
        changed = self.root / 'foreign.tgz'
        changed.write_bytes(b'foreign package')
        self.specification['archives'][first['name'] + '@' + first['version']] = str(changed)
        with self.assertRaisesRegex(ValueError, 'integrity differs'):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_late_original_esbuild_executable_mode_change_refuses_and_retires(self):
        original = builder.verify_files
        count = 0
        def verify(tree, members, output):
            nonlocal count
            count += 1
            if count == 2:
                target = self.output / '@esbuild/darwin-arm64@0.21.5@@@1/bin/esbuild'
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o555)
                target.chmod(0o444)
            return original(tree, members, output)
        builder.verify_files = verify
        try:
            with self.assertRaisesRegex(ValueError, 'executable mode changed'):
                self.prepare()
        finally:
            builder.verify_files = original
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
    for name in ['spec', 'pins', 'source-pins', 'npm', 'builder', 'custody',
                 'deployment', 'output-tree', 'bun']:
        parser.add_argument('--' + name, required=True, type=Path)
    arguments, remaining = parser.parse_known_args()
    pins = json.loads(arguments.pins.read_bytes())
    source_pins = json.loads(arguments.source_pins.read_bytes())
    npm = load('original_npm', arguments.npm)
    builder = load('original_bun_builder', arguments.builder)
    custody = load('original_custody', arguments.custody)
    deployment = load('declared_deployment', arguments.deployment)
    output_tree = load('declared_output_tree', arguments.output_tree)
    unittest.main(argv=[sys.argv[0], *remaining])
