"""Bounded recipe/command controls; synthetic fixtures are not SDK qualification."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import types
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("simulator_contexts", Path(__file__).with_name("contexts.py"))
contexts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contexts)


class DeclaredFixtureSdk:
    host = "aarch64-apple-darwin"

    def command(self, tool, version):
        if version != "1.97.1":
            raise ValueError("foreign fixture compiler")
        return ["/declared/sdk/bin/" + tool]

    def environment(self, bootstrap=False):
        return {"PATH": "", "CARGO_ENCODED_RUSTFLAGS": "unrelated fixture flag",
                **({"RUSTC_BOOTSTRAP": "1"} if bootstrap else {})}


class SimulatorContextsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sim-context-controls-")
        self.root = Path(self.temporary.name).resolve()
        self.old_root, self.old_directory = contexts.ROOT, contexts.DIRECTORY
        contexts.ROOT = self.root
        contexts.DIRECTORY = self.root / "contexts"
        self.source = self.root / "tools/sim"
        (self.source / "tests").mkdir(parents=True)
        (self.source / "src").mkdir()
        for name in ["z.rs", "a.rs", "ignored.txt"]:
            (self.source / "tests" / name).write_text("// synthetic test source\n")
        (self.source / "src/lib.rs").write_text("// synthetic library source\n")
        (self.source / "build.rs").write_text("fn main() {}\n")
        self.manifest = {'package': {'name': 'merkur-sim', 'version': '0.1.0', 'edition': '2024', 'build': 'build.rs'},
                         'lib': {'path': 'src/lib.rs'}, 'lints': {'workspace': True},
                         'dependencies': {'client': {'path': '../../packages/client'}, 'tokio': {'version': '1', 'features': ['test-util']}},
                         'target': {'cfg(unix)': {'dependencies': {'native': {'path': '../../packages/native'}}}}}
        (self.source / "manifest.toml").write_text(contexts.toml_text(self.manifest))
        self.production = {'workspace': {'lints': {'rust': {'unsafe_code': 'deny'}}},
                           'patch': {'crates-io': {'terminal': {'path': 'packages/terminal-patch'}}}}
        (self.root / "Cargo.toml").write_text(contexts.toml_text(self.production))
        self.raw_id = "path+file://synthetic/merkur-sim#0.1.0"
        self.raw = {'packages': [{'id': self.raw_id, 'name': 'merkur-sim', 'version': '0.1.0', 'source': None,
                                 'manifest_path': str(self.source / 'manifest.toml')}],
                    'workspace_members': [self.raw_id]}
        self.normalized = {'packages': [{'id': 'workspace:tools/sim', 'name': 'merkur-sim', 'version': '0.1.0', 'source': None}]}
        self.oracle = {'version': 1, 'roots': [0], 'units': [{'pkg_id': self.raw_id, 'mode': 'test', 'platform': None,
                                                          'target': {'kind': ['lib'], 'src_path': str(self.source / 'src/lib.rs')},
                                                          'profile': {'name': 'release'}, 'dependencies': []}]}

    def tearDown(self):
        contexts.ROOT, contexts.DIRECTORY = self.old_root, self.old_directory
        self.temporary.cleanup()

    def test_original_bun_prepare_and_python_recipe_are_identical(self):
        scripts = self.root / 'scripts'
        scripts.mkdir()
        shutil.copyfile(args.workspace_helper, scripts / 'generated-cargo-workspace.ts')
        source = Path(args.recipe).read_text()
        original_entry = 'if (import.meta.main) await run();'
        self.assertEqual(source.count(original_entry), 1)
        (scripts / 'sim-tests.ts').write_text(source.replace(original_entry, 'await prepare();'))
        result = subprocess.run([args.bun, str(scripts / 'sim-tests.ts')], cwd=self.root,
                                env={'PATH': '', 'HOME': str(self.root)}, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        workspace, crate = contexts.simulator_manifests(self.source, self.production)
        generated = self.root / 'test-results/sim/workspace'
        self.assertEqual(workspace, tomllib.loads((generated / 'Cargo.toml').read_text()))
        self.assertEqual(crate, tomllib.loads((generated / 'merkur-sim/Cargo.toml').read_text()))
        self.assertEqual([row['name'] for row in crate['test']], ['a', 'z'])
        self.assertEqual(crate['package']['build'], str(self.source / 'build.rs'))
        self.assertNotIn('profile', workspace)

    def test_missing_original_build_script_declaration_refuses(self):
        del self.manifest['package']['build']
        (self.source / 'manifest.toml').write_text(contexts.toml_text(self.manifest))
        with self.assertRaisesRegex(ValueError, 'declared build script'):
            contexts.simulator_manifests(self.source, self.production)

    def test_original_metadata_is_offline_locked_and_has_fixed_simulator_cfg(self):
        with patch.object(contexts.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout='{}')) as run:
            contexts.resolve(self.source / 'manifest.toml', DeclaredFixtureSdk.host, '1.97.1', False,
                             sdk=DeclaredFixtureSdk(), rust_flags=contexts.SIMULATOR_FLAGS)
        command = run.call_args.args[0]
        self.assertIn('--offline', command)
        self.assertIn('--locked', command)
        environment = run.call_args.kwargs['env']
        self.assertEqual(environment['RUSTFLAGS'], '--cfg merkur_sim --cfg tokio_unstable')
        self.assertNotIn('CARGO_ENCODED_RUSTFLAGS', environment)

    def test_original_test_release_graph_and_cfg_propagate_to_all_native_units(self):
        flags = {'rustflags': contexts.SIMULATOR_FLAGS, 'rustdocflags': []}
        with patch.object(contexts.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps(self.oracle))) as run, \
             patch.object(contexts, 'effective_target_flags', return_value=flags) as effective:
            graph = contexts.unit_graph(self.source / 'manifest.toml', DeclaredFixtureSdk.host, '1.97.1', 'test',
                                        self.raw, self.normalized, self.root, sdk=DeclaredFixtureSdk(),
                                        release=True, rust_flags=contexts.SIMULATOR_FLAGS)
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ['/declared/sdk/bin/cargo', 'test'])
        self.assertIn('--release', command)
        self.assertNotIn('--target', command)
        self.assertIn('--locked', command)
        self.assertIn('--offline', command)
        environment = run.call_args.kwargs['env']
        self.assertEqual(environment['RUSTFLAGS'], '--cfg merkur_sim --cfg tokio_unstable')
        self.assertNotIn('CARGO_ENCODED_RUSTFLAGS', environment)
        self.assertEqual(effective.call_args.args[3], environment)
        self.assertEqual(graph['units'][0]['rust_flags'], contexts.SIMULATOR_FLAGS)
        self.assertEqual(graph['units'][0]['profile']['name'], 'release')
        self.assertEqual(graph['execution_host'], DeclaredFixtureSdk.host)

    def test_capture_preserves_separate_retained_lock_and_original_sources(self):
        for name in ['Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml', 'tools/bazel/rust/metadata.json',
                     'tools/bazel/rust/contexts.py', 'tools/bazel/rust/acquisition_sdk.py',
                     'scripts/sim-tests.ts', 'scripts/generated-cargo-workspace.ts']:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('explicit synthetic source fixture: ' + name)
        production_lock = (self.root / 'Cargo.lock').read_bytes()
        simulator_lock = b'explicitly distinct synthetic retained simulator lock'
        (self.source / 'Cargo.lock').write_bytes(simulator_lock)
        (self.source / 'regressions.json').write_text('[]\n')
        sdk = DeclaredFixtureSdk()
        sdk.require_locks = unittest.mock.Mock()
        normalized = {'root': 'workspace:.', 'members': ['workspace:tools/sim'], 'packages': [
            {'id': 'workspace:tools/sim', 'manifest': 'tools/sim/manifest.toml'}]}
        graph = {'execution_host': sdk.host, 'roots': [0], 'units': []}
        with patch.object(contexts, 'resolve', return_value=self.raw) as resolve, \
             patch.object(contexts, 'normalize', return_value=normalized), \
             patch.object(contexts, 'unit_graph', return_value=graph) as capture:
            document = contexts.capture_simulator(sdk, '1.97.1', self.production)
        sdk.require_locks.assert_called_once_with([self.root / 'Cargo.lock', self.source / 'Cargo.lock'])
        self.assertFalse(resolve.call_args.kwargs['refresh'] if 'refresh' in resolve.call_args.kwargs else resolve.call_args.args[3])
        self.assertTrue(capture.call_args.kwargs['release'])
        self.assertEqual(capture.call_args.args[3], 'test')
        self.assertEqual(document['contexts'][sdk.host]['root'], 'workspace:tools/sim')
        self.assertEqual(list(document['unit_graphs']), [sdk.host])
        self.assertEqual(set(document['generated_inputs']), {'Cargo.toml', 'Cargo.lock', 'merkur-sim/Cargo.toml'})
        self.assertIn('tools/sim/build.rs', document['inputs'])
        self.assertIn('tools/sim/tests/a.rs', document['inputs'])
        self.assertEqual((self.root / 'Cargo.lock').read_bytes(), production_lock)
        self.assertEqual((contexts.DIRECTORY / 'merkur-sim/simulator-test/native/Cargo.lock').read_bytes(), simulator_lock)

    def test_ordinary_test_graph_keeps_its_original_command_boundary(self):
        flags = {'rustflags': [], 'rustdocflags': []}
        with patch.object(contexts.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps(self.oracle))) as run, \
             patch.object(contexts, 'effective_target_flags', return_value=flags):
            contexts.unit_graph(self.source / 'manifest.toml', DeclaredFixtureSdk.host, '1.97.1', 'test',
                                self.raw, self.normalized, self.root, sdk=DeclaredFixtureSdk())
        self.assertNotIn('--release', run.call_args.args[0])
        self.assertNotIn('RUSTFLAGS', run.call_args.kwargs['env'])


class RefreshPlanTests(unittest.TestCase):
    def arguments(self, **changes):
        return types.SimpleNamespace(**{'package': None, 'workspace_tests': False, 'workspace_clippy': False,
                                        'workspace_check': False, 'terminal_training': False, 'simulator': False,
                                        **changes})

    def test_cold_refresh_requires_all_original_contexts(self):
        plan = contexts.refresh_plan(self.arguments())
        self.assertTrue(plan['packages'])
        self.assertTrue(plan['simulator'])
        self.assertTrue(plan['training'])
        self.assertEqual(plan['workspaces'], ['workspace-test', 'workspace-clippy', 'workspace-check'])

    def test_actual_cli_captures_all_requested_workspace_oracles_before_strict_check(self):
        with tempfile.TemporaryDirectory(prefix='workspace-batch-controls-') as directory:
            root = Path(directory).resolve()
            production = {'workspace': {'members': [], 'lints': {}}, 'patch': {}}
            (root / 'Cargo.toml').write_text(contexts.toml_text(production))
            (root / 'Cargo.lock').write_text('version = 4\npackage = []\n')
            (root / 'rust-toolchain.toml').write_text('[toolchain]\nchannel = "1.97.1"\n')
            for name in ['.cargo/config.toml', 'tools/bazel/rust/metadata.json', 'tools/bazel/rust/contexts.py', 'tools/bazel/rust/acquisition_sdk.py']:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('explicitly synthetic source input')
            sdk = DeclaredFixtureSdk()
            sdk.require_locks = unittest.mock.Mock()
            normalized = {'root': 'workspace:.', 'members': [], 'packages': []}
            oracle = {'version': 1, 'roots': [0], 'units': [{}], 'execution_host': sdk.host}
            previous = contexts.ROOT, contexts.DIRECTORY
            argv = ['contexts.py', '--refresh', '--workspace-tests', '--workspace-clippy', '--workspace-check',
                    '--sdk-descriptor', str(root / 'declared-sdk-fixture.json'), '--source-root', str(root)]
            try:
                with patch.object(contexts.sys, 'argv', argv), \
                     patch.object(contexts.NativeCargoSdk, 'load', return_value=sdk), \
                     patch.object(contexts, 'resolve', return_value={}), \
                     patch.object(contexts, 'normalize', return_value=normalized), \
                     patch.object(contexts, 'unit_graph', return_value=oracle) as capture:
                    self.assertEqual(contexts.main(), 0)
                # Final validate_inventory/source/generated-lock checking is real,
                # not skipped. Only the fixture's compiler oracle is synthetic.
                self.assertEqual([call.args[3] for call in capture.call_args_list],
                                 ['workspace-test', 'workspace-clippy', 'workspace-check'])
                for name, mode, profile in [('workspace-test', 'test', 'test'), ('workspace-clippy', 'check', 'clippy'),
                                            ('workspace-check', 'check', 'check')]:
                    document = json.loads((contexts.DIRECTORY / name / mode / 'native/metadata.json').read_text())
                    self.assertEqual(set(document['unit_graphs'][sdk.host]), {profile})
            finally:
                contexts.ROOT, contexts.DIRECTORY = previous


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['bun', 'recipe', 'workspace-helper']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    unittest.main(argv=['contexts_simulator_test.py'])
