"""Genuine pinned original module/function/bake generators; causal facts only."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


class GeneratedInputControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name).resolve(strict=True)
        cls.source = cls.root / 'source'
        pins = json.loads(arguments.pins.read_bytes())
        builder.prepare(arguments.archive, pins, cls.source, custody, deployment, outputs)
        cls.build = cls.source / 'build/release'
        cls.codegen = cls.build / 'codegen'
        cls.codegen.mkdir(parents=True)
        cls.environment = {'PATH': '', 'HOME': str(cls.root), 'CLAUDECODE': '1',
            'TARGET_PLATFORM': 'darwin', 'TARGET_ARCH': 'arm64',
            'DYLD_FALLBACK_LIBRARY_PATH': str(arguments.git_sdk / 'lib')}
        cls.cache = cls.root / 'npm-cache'
        npm.prepare(json.loads(arguments.npm_spec.read_bytes()), json.loads(arguments.npm_pins.read_bytes()),
                    pins, cls.cache, custody, deployment, outputs, builder)
        (cls.root / '.bunfig.toml').write_text('[install]\noffline = true\n')
        binary_directory = cls.root / 'bin'
        binary_directory.mkdir()
        (binary_directory / 'bun').symlink_to(arguments.bun)
        cls.environment.update({'PATH': str(binary_directory), 'BUN_INSTALL_CACHE_DIR': str(cls.cache)})
        cls.logs = {}
        def run(name, argv, directory=None):
            result = subprocess.run([str(value) for value in argv], cwd=cls.source if directory is None else directory,
                env=cls.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            cls.logs[name] = {'argv': [str(value) for value in argv], 'exit': result.returncode,
                'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()}
            if result.returncode:
                raise ValueError('Genuine original generator failed: ' + json.dumps(cls.logs[name]))
        locks = {directory + '/bun.lock' if directory else 'bun.lock':
                 (cls.source / directory / 'bun.lock').read_bytes()
                 for directory in ['', 'packages/bun-error', 'src/node-fallbacks']}
        for directory in ['', 'packages/bun-error', 'src/node-fallbacks']:
            run('install_' + (directory or 'root'), [arguments.bun, 'install', '--frozen-lockfile'],
                cls.source / directory)
        for name, body in locks.items():
            if (cls.source / name).read_bytes() != body:
                raise ValueError('Original frozen generator install changed its declared lock')
        module_argv = [arguments.bun, cls.source / 'src/codegen/bundle-modules.ts', '--debug=OFF', cls.build]
        bake_argv = [arguments.bun, cls.source / 'src/codegen/bake-codegen.ts',
                     '--debug=OFF', '--codegen-root=' + str(cls.codegen)]
        fallback_directory = cls.codegen / 'node-fallbacks'
        fallback_directory.mkdir()
        fallback_argv = [arguments.bun, cls.source / 'src/node-fallbacks/build-fallbacks.ts', fallback_directory]
        cls.esbuild = cls.source / 'node_modules/.bin/esbuild'
        if cls.esbuild.read_bytes()[:4] not in [b'\xcf\xfa\xed\xfe', b'\x7fELF']:
            raise ValueError('Original esbuild install did not supply its genuine native executable')
        esbuild_runtime = [cls.esbuild, cls.source / 'src/runtime.bun.js',
            '--outfile=' + str(cls.codegen / 'runtime.out.js'), '--define:process.env.NODE_ENV="production"',
            '--target=esnext', '--bundle', '--format=esm', '--platform=node', '--minify', '--external:/bun:*']
        error_directory = cls.codegen / 'bun-error'
        error_directory.mkdir()
        esbuild_error = [cls.esbuild, 'index.tsx', 'bun-error.css', '--outdir=' + str(error_directory),
            '--define:process.env.NODE_ENV="production"', '--minify', '--bundle', '--platform=browser', '--format=esm']
        react_refresh = [arguments.bun, 'build', cls.source / 'src/node-fallbacks/node_modules/react-refresh/cjs/react-refresh-runtime.development.js',
            '--outfile=' + str(fallback_directory / 'react-refresh.js'), '--target=browser', '--format=cjs',
            '--minify', '--define:process.env.NODE_ENV="development"']
        run('fallback_before', fallback_argv, cls.source / 'src/node-fallbacks')
        run('esbuild_runtime_before', esbuild_runtime)
        run('esbuild_error_before', esbuild_error, cls.source / 'packages/bun-error')
        run('react_refresh_before', react_refresh, cls.source / 'src/node-fallbacks')
        run('modules_before', module_argv)
        run('bake_before', bake_argv)
        cls.before = {file.relative_to(cls.codegen).as_posix(): file.read_bytes()
                      for file in cls.codegen.rglob('*') if file.is_file()}
        run('patch_check', [arguments.git_sdk / 'bin/git', 'apply', '--check', arguments.patch])
        run('patch_apply', [arguments.git_sdk / 'bin/git', 'apply', arguments.patch])
        run('fallback_after', fallback_argv, cls.source / 'src/node-fallbacks')
        run('esbuild_runtime_after', [*esbuild_runtime, '--metafile=' + str(cls.codegen / 'runtime.out.js.compiler-inputs.json')])
        run('esbuild_error_after', [*esbuild_error, '--metafile=' + str(error_directory / 'compiler-inputs.json')], cls.source / 'packages/bun-error')
        run('react_refresh_after', [*react_refresh, '--metafile=' + str(fallback_directory / 'react-refresh.js.compiler-inputs.json')], cls.source / 'src/node-fallbacks')
        run('modules_after', module_argv)
        run('bake_after', bake_argv)
        cls.metadata = cls.codegen / 'compiler-inputs'
        cls.module_raw = (cls.metadata / 'modules.json').read_bytes()
        cls.module_relations = json.loads((cls.metadata / 'modules.sources.json').read_bytes())
        members, facts = custody.source_archive_members(arguments.archive.read_bytes(), pins, licenses.relative)
        cls.origin = {'component': 'bun-original-source', 'namespace': str(cls.source),
                      'directory': cls.source, 'members': members,
                      'aliases': {item['path']: item['target'] for item in facts if item['kind'] == 'symlink'}}
        if arguments.evidence:
            arguments.evidence.mkdir(parents=True, exist_ok=False)
            (arguments.evidence / 'commands.json').write_text(json.dumps(cls.logs, indent=2))
            (arguments.evidence / 'assets.json').write_text(json.dumps({name:
                {'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
                for name, body in cls.before.items()}, indent=2))
            for file in cls.metadata.rglob('*'):
                if file.is_file():
                    destination = arguments.evidence / 'compiler-inputs' / file.relative_to(cls.metadata)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(file.read_bytes())
            for file in cls.codegen.rglob('*.json'):
                if file.is_relative_to(cls.metadata):
                    continue
                destination = arguments.evidence / 'additional-compiler-inputs' / file.relative_to(cls.codegen)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(file.read_bytes())

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def selected(self, raw=None, relations=None):
        return runner.compiler_input_sources(self.module_raw if raw is None else raw,
            self.source, self.source, self.module_relations if relations is None else relations,
            [self.origin], linked, licenses)

    def test_original_assets_remain_byte_identical(self):
        self.assertGreaterEqual(len(self.before), 20)
        for name, body in self.before.items():
            self.assertEqual((self.codegen / name).read_bytes(), body, name)

    def test_actual_module_compiler_relations_bind_only_selected_original_sources(self):
        facts = self.selected()
        inputs = json.loads(self.module_raw)['inputs']
        self.assertEqual(len(facts), len(inputs))
        self.assertEqual({fact['path'] for fact in facts}, {
            Path(original).relative_to(self.source).as_posix()
            for original in self.module_relations.values()})
        self.assertGreater(len(facts), 100)

    def test_original_node_fallback_generator_emits_actual_compiler_inputs(self):
        directory = self.codegen / 'node-fallbacks'
        metadata = sorted(directory.glob('*.compiler-inputs.json'))
        expected = {file.name for file in (self.source / 'src/node-fallbacks').glob('*.js')}
        self.assertEqual({file.name for file in metadata},
            {name + '.compiler-inputs.json' for name in expected | {'react-refresh.js'}})
        for file in metadata:
            value = json.loads(file.read_bytes())
            self.assertTrue(value['inputs'])
            self.assertTrue(value['outputs'])
        # The actual unchanged post-bundle zstd outputs remain in the same
        # asset parity control; no custom replacement compression is used.
        self.assertEqual({file.name for file in directory.glob('*.zst')},
                         {name + '.zst' for name in expected})

    def test_original_esbuild_metadata_is_causal_not_native_retention(self):
        file = self.codegen / 'runtime.out.js.compiler-inputs.json'
        value = json.loads(file.read_bytes())
        self.assertEqual(set(value['inputs']), {'src/runtime.bun.js', 'src/runtime.js'})
        facts = runner.compiler_input_sources(file.read_bytes(), self.source, self.source, {},
                                             [self.origin], linked, licenses)
        self.assertEqual({fact['path'] for fact in facts}, {'src/runtime.bun.js', 'src/runtime.js'})
        error = json.loads((self.codegen / 'bun-error/compiler-inputs.json').read_bytes())
        self.assertTrue(any('preact' in name for name in error['inputs']))
        # Npm sources still need their separately acquired exact archive
        # authority. Do not label them original first-party Bun sources.
        with self.assertRaises(linked.PendingLinkedSource):
            runner.compiler_input_sources(json.dumps(error).encode(), self.source / 'packages/bun-error',
                self.source, {}, [self.origin], linked, licenses)

    def test_genuine_function_metadata_uses_original_generator_relation(self):
        file = self.metadata / 'functions/NodeModuleObject._initPaths.json'
        relation = json.loads(file.with_name('NodeModuleObject._initPaths.sources.json').read_bytes())
        facts = runner.compiler_input_sources(file.read_bytes(), self.source, self.source, relation,
                                             [self.origin], linked, licenses)
        self.assertEqual([fact['path'] for fact in facts], ['src/js/builtins/NodeModuleObject.ts'])

    def test_genuine_eval_metadata_binds_original_entries(self):
        entries = {file.name for file in (self.source / 'src/js/eval').glob('*.ts')}
        self.assertEqual({file.name for file in self.metadata.glob('eval.*.json')},
                         {'eval.' + name + '.json' for name in entries})
        for name in entries:
            file = self.metadata / ('eval.' + name + '.json')
            facts = runner.compiler_input_sources(file.read_bytes(), self.source, self.source, {},
                                                 [self.origin], linked, licenses)
            self.assertEqual({fact['path'] for fact in facts}, {'src/js/eval/' + name})

    def test_missing_function_producing_relation_remains_pending(self):
        file = self.metadata / 'functions/NodeModuleObject._initPaths.json'
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'producing-input authority'):
            runner.compiler_input_sources(file.read_bytes(), self.source, self.source, {},
                                          [self.origin], linked, licenses)

    def test_changed_compiler_byte_count_refuses(self):
        raw = json.loads(self.module_raw)
        name = next(iter(raw['inputs']))
        raw['inputs'][name]['bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'consumed byte count'):
            self.selected(json.dumps(raw).encode())

    def test_foreign_output_input_relation_refuses(self):
        raw = json.loads(self.module_raw)
        next(iter(raw['outputs'].values()))['inputs']['foreign.ts'] = {'bytesInOutput': 1}
        with self.assertRaisesRegex(ValueError, 'foreign input relation'):
            self.selected(json.dumps(raw).encode())

    def test_original_namespace_escape_refuses(self):
        raw = json.loads(self.module_raw)
        facts = next(iter(raw['inputs'].values()))
        raw['inputs']['../foreign.ts'] = facts
        with self.assertRaisesRegex(ValueError, 'escaped'):
            self.selected(json.dumps(raw).encode())
        relations = dict(self.module_relations)
        relations[next(iter(relations))] = str(self.root / 'foreign.ts')
        with self.assertRaisesRegex(ValueError, 'escaped'):
            self.selected(relations=relations)

    def test_changed_original_source_bytes_refuse(self):
        original = Path(next(iter(self.module_relations.values())))
        body = original.read_bytes()
        try:
            original.write_bytes(body + b'\n')
            with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                self.selected()
        finally:
            original.write_bytes(body)

    def test_bake_preserved_second_pass_stays_pending_original_producer_authority(self):
        directory = self.metadata / 'bake'
        for name in ['client', 'server', 'error']:
            raw = (directory / (name + '.second.json')).read_bytes()
            preserved = json.loads((directory / (name + '.sources.json')).read_bytes())
            self.assertEqual(len(preserved), 1)
            original, captured = next(iter(preserved.items()))
            self.assertFalse(Path(original).exists())
            self.assertTrue(Path(captured).is_file())
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'producing-input authority'):
                runner.compiler_input_sources(raw, self.source / 'src/runtime/bake', self.source,
                    {}, [self.origin], linked, licenses, preserved_inputs=preserved)
            foreign = {original: str(self.root / 'foreign.ts')}
            with self.assertRaisesRegex(ValueError, 'escaped'):
                runner.compiler_input_sources(raw, self.source / 'src/runtime/bake', self.source,
                    {}, [self.origin], linked, licenses, preserved_inputs=foreign)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['runner', 'builder', 'custody', 'deployment', 'output-tree', 'linked', 'licenses',
                 'archive', 'pins', 'patch', 'bun', 'git-sdk', 'npm', 'npm-spec', 'npm-pins']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments = parser.parse_args()
    npm = load('generated_input_npm', arguments.npm)
    runner = load('generated_input_runner', arguments.runner)
    builder = load('generated_input_builder', arguments.builder)
    custody = load('generated_input_custody', arguments.custody)
    deployment = load('generated_input_deployment', arguments.deployment)
    outputs = load('generated_input_output_tree', arguments.output_tree)
    linked = load('generated_input_linked', arguments.linked)
    licenses = load('generated_input_licenses', arguments.licenses)
    unittest.main(argv=[sys.argv[0]])
