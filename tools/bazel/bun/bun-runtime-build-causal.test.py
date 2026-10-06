"""Original build-std resolution and Ninja output boundary controls, not native qualification."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest


def load(path):
    specification = importlib.util.spec_from_file_location('original_native_bun', path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class CausalBuildInputs(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve(strict=True)

    def test_actual_nightly_archive_carriers_match_same_sdk_manifest(self):
        native.validate_nightly_archives(arguments.nightly_archive,
            json.loads(arguments.build_pins.read_bytes()),
            json.loads(arguments.nightly_manifest.read_bytes()))

    def test_missing_original_nightly_source_archive_refuses(self):
        archives = [file for file in arguments.nightly_archive if file.name != 'rust-src-nightly.tar.xz']
        self.assertEqual(len(archives), len(arguments.nightly_archive) - 1)
        with self.assertRaisesRegex(ValueError, 'carrier closure differs'):
            native.validate_nightly_archives(archives,
                json.loads(arguments.build_pins.read_bytes()),
                json.loads(arguments.nightly_manifest.read_bytes()))

    def test_changed_original_nightly_source_archive_refuses(self):
        original = next(file for file in arguments.nightly_archive if file.name == 'rust-src-nightly.tar.xz')
        replacement = self.root / original.name
        shutil.copyfile(original, replacement)
        with open(replacement, 'r+b') as stream:
            stream.write(b'foreign')
        archives = [replacement if file == original else file for file in arguments.nightly_archive]
        with self.assertRaisesRegex(ValueError, 'carrier bytes changed'):
            native.validate_nightly_archives(archives,
                json.loads(arguments.build_pins.read_bytes()),
                json.loads(arguments.nightly_manifest.read_bytes()))

    def test_original_build_std_resolution_fails_without_original_vendor_and_succeeds_with_it(self):
        source = self.root / 'workspace'
        source.mkdir()
        (source / 'Cargo.toml').write_text(
            '[package]\nname="original_std_resolution_control"\nversion="0.0.0"\nedition="2024"\n')
        (source / 'src').mkdir()
        (source / 'src/lib.rs').write_text('pub fn selected() -> usize { 1 }\n')
        home = self.root / 'home'
        home.mkdir()
        cargo_home = self.root / 'cargo-home'
        cargo_home.mkdir()
        manifest = json.loads((arguments.nightly / 'sdk-payload.json').read_bytes())
        command = [str(arguments.nightly / 'bin/cargo'), 'build', '--unit-graph',
                   '-Zunstable-options', '--offline', '--target', manifest['target'],
                   '--target-dir', str(self.root / 'target'),
                   '-Zbuild-std=core,alloc,std,proc_macro,panic_abort',
                   '-Zbuild-std-features=panic-unwind,default']
        environment = {'HOME': str(home), 'CARGO_HOME': str(cargo_home), 'PATH': '',
                       'RUSTC': str(arguments.nightly / 'bin/rustc'), 'CARGO_NET_OFFLINE': 'true'}
        def resolve(registry):
            (cargo_home / 'config.toml').write_text(
                '[net]\noffline=true\n[source.crates-io]\nreplace-with="original"\n'
                '[source.original]\ndirectory=' + json.dumps(str(registry)) + '\n')
            return subprocess.run(command, cwd=source, env=environment,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        before = resolve(arguments.registry)
        self.assertEqual(before.returncode, 101)
        self.assertIn(b'hashbrown', before.stderr)
        self.assertIn(b'0.17.1', before.stderr)
        registry = native.compose_registry(arguments.nightly, arguments.registry,
                                           self.root / 'composed')
        after = resolve(registry)
        self.assertEqual(after.returncode, 0, after.stderr.decode())
        graph = json.loads(after.stdout)
        self.assertTrue(any(unit['target']['name'] == 'std' and '/library/std#0.0.0' in unit['pkg_id'] for unit in graph['units']))
        lock = tomllib.loads((arguments.nightly / 'lib/rustlib/src/rust/library/Cargo.lock').read_text())
        packages = [package for package in lock['package'] if package.get('source', '').startswith('registry+')]
        self.assertEqual(len(packages), 30)
        for package in packages:
            checksum = json.loads((registry / (package['name'] + '-' + package['version']) /
                                   '.cargo-checksum.json').read_bytes())
            self.assertEqual(checksum['package'], package['checksum'])
        self.assertEqual(len(list(registry.iterdir())), 206)

    def test_original_std_lock_checksum_mismatch_refuses(self):
        original = arguments.nightly / 'lib/rustlib/src/rust/library'
        library = self.root / 'nightly/lib/rustlib/src/rust/library'
        library.mkdir(parents=True)
        lock = tomllib.loads((original / 'Cargo.lock').read_text())
        package = next(package for package in lock['package'] if package.get('source', '').startswith('registry+'))
        (library / 'Cargo.lock').write_text((original / 'Cargo.lock').read_text())
        name = package['name'] + '-' + package['version']
        target = library / 'vendor' / name
        target.mkdir(parents=True)
        checksum = json.loads((original / 'vendor' / name / '.cargo-checksum.json').read_bytes())
        checksum['package'] = '0' * 64
        (target / '.cargo-checksum.json').write_text(json.dumps(checksum))
        registry = self.root / 'empty'
        registry.mkdir()
        with self.assertRaisesRegex(ValueError, 'differs from its locked package'):
            native.compose_registry(self.root / 'nightly', registry, self.root / 'result')

    def original_engine(self):
        source = self.root / 'source'
        scripts = source / 'scripts/build'
        scripts.mkdir(parents=True)
        pins = json.loads(arguments.pins.read_bytes())
        with open(arguments.source_archive, 'rb') as original:
            self.assertEqual(hashlib.file_digest(original, 'sha256').hexdigest(), pins['source']['sha256'])
        prefix = pins['source']['prefix'].rstrip('/') + '/'
        with tarfile.open(arguments.source_archive, 'r:gz') as original:
            for member in original:
                relative = member.name.removeprefix(prefix)
                if not member.name.startswith(prefix) or not relative.startswith('scripts/build/') or not member.isfile():
                    continue
                target = source / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with original.extractfile(member) as data:
                    target.write_bytes(data.read())
        return source

    def test_original_postlink_requires_declared_cpu_count_and_preserves_command_flags(self):
        source = self.original_engine()
        environment = {'PATH': '/__no_ambient_tools__', 'HOME': str(self.root),
                       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        subprocess.run([str(arguments.git), 'apply', str(arguments.dsym_patch)],
                       cwd=source, env=environment, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        driver = self.root / 'original-postlink.ts'
        driver.write_text("""
import { Ninja } from './source/scripts/build/ninja.ts';
import { emitPostLink } from './source/scripts/build/bun.ts';
const root = process.argv[2];
const ninja = new Ninja({ buildDir: root + '/build/release' });
const cfg = {darwin:true, windows:false, debug:false, asan:false, valgrind:false,
  assertions:false, canRunOnHost:false, host:{os:'darwin'}, buildDir:root+'/build/release',
  cwd:root, exeSuffix:'', strip:'declared-strip', dsymutil:'declared-dsymutil', jsRuntime:'declared-bun'};
emitPostLink(ninja, cfg, root+'/build/release/bun-profile', 'bun-profile', ['original-strip-flag']);
await ninja.write();
""")
        command = [str(arguments.bun), '--no-install', '--no-env-file', 'run', str(driver), str(source)]
        before = subprocess.run(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(before.returncode, 0)
        self.assertIn(b'Declared dsymutil CPU count is mandatory', before.stderr)
        for value in ('0', '-1', 'not-a-count', '1.5'):
            rejected = subprocess.run(command, env={**environment, 'MERKUR_BUN_DSYMUTIL_JOBS': value},
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn(b'Declared dsymutil CPU count is mandatory', rejected.stderr)
        after = subprocess.run(command, env={**environment, 'MERKUR_BUN_DSYMUTIL_JOBS': '4'},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(after.returncode, 0, after.stderr.decode())
        original_command = (source / 'build/release/build.ninja').read_text()
        self.assertIn('--flat --keep-function-for-static --object-prefix-map .=', original_command)
        self.assertIn('-j 4', original_command)
        self.assertIn('original-strip-flag', original_command)
        self.assertNotIn('sysctl', original_command)
        self.assertNotIn('nproc', original_command)

    def test_actual_original_ninja_database_is_preserved_by_diagnostic_capture(self):
        # This original-engine graph exercises diagnostic publication only.
        # It is not a native compiler/linker build or a selected-source claim.
        source = self.original_engine()
        directory = source / 'build/release'
        request = self.root / 'ninja-control.json'
        request.write_text(json.dumps({'source': str(source), 'directory': str(directory)}))
        driver = self.root / 'original-ninja-control.ts'
        driver.write_text("""
import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { Ninja } = await import(request.source + '/scripts/build/ninja.ts');
const ninja = new Ninja({ buildDir: request.directory });
ninja.addCompileCommand({directory: request.source, file: request.source + '/scripts/build/ninja.ts',
  output: request.directory + '/engine-control.o', arguments: ['original-engine-output-control']});
ninja.phony('bun-profile', []);
await ninja.write();
""")
        environment = {'PATH': '/__no_ambient_tools__', 'HOME': str(self.root),
                       'MERKUR_NINJA_SHELL': str(arguments.bash),
                       'MERKUR_NINJA_PYTHON': str(arguments.python)}
        subprocess.run([str(arguments.bun), '--no-install', '--no-env-file', 'run',
                        str(driver), str(request)], env=environment, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        database = (directory / 'compile_commands.json').read_bytes()
        # Exact former post-build operation reproduces the integration failure.
        with self.assertRaises(FileExistsError):
            with open(directory / 'compile_commands.json', 'xb'):
                pass
        shutil.copyfile(arguments.bun, directory / 'bun-profile')
        # Explicit boundary-only map fixture; it is never admitted as linked code.
        (directory / 'bun-profile.linker-map').write_bytes(b'causal capture boundary control\n')
        configuration = {'cfg': {'os': 'linux', 'buildDir': str(directory)},
                         'output': {'exe': str(directory / 'bun-profile')},
                         'runtime': str(directory / 'bun-profile'),
                         'linkerMaps': [str(directory / 'bun-profile.linker-map')]}
        missing_lto = {**configuration, 'cfg': {**configuration['cfg'], 'os': 'darwin', 'lto': True},
                       'output': {**configuration['output'], 'dsym': str(directory / 'bun-profile')},
                       'flags': {'ldflags': ['-Wl,-object_path_lto,' + str(directory / 'missing.lto.o')]}}
        with self.assertRaises(FileNotFoundError):
            native.capture_build_inputs(missing_lto, source, {'ninja': str(arguments.ninja)}, environment)
        self.assertFalse((directory / 'original-link-graph.dot').exists())
        native.capture_build_inputs(configuration, source, {'ninja': str(arguments.ninja)}, environment)
        self.assertEqual((directory / 'compile_commands.json').read_bytes(), database)
        self.assertTrue((directory / 'ninja-compile_commands.json').is_file())
        self.assertIn(b'bun-profile', (directory / 'original-link-graph.dot').read_bytes())
        self.assertIn(b'bun-profile', (directory / 'original-link-query.txt').read_bytes())
        self.assertTrue((directory / 'original-compiler-deps.txt').is_file())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'nightly_manifest', 'build_pins', 'registry', 'source_archive', 'pins', 'bun', 'ninja', 'bash', 'python', 'git', 'dsym_patch'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    parser.add_argument('--nightly-archive', type=Path, action='append', required=True)
    arguments, remaining = parser.parse_known_args()
    # Preserve the logical declared File namespace rather than following its
    # carrier symlink to an external repository/cache outside the runfiles.
    arguments.nightly = arguments.nightly_manifest.absolute().parent
    native = load(arguments.runner)
    unittest.main(argv=[sys.argv[0], *remaining])
