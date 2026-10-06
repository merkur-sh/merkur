"""Original builtin generators and native loaded bytes; not full Bun qualification."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
import tempfile
import shlex


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['runner', 'builder', 'custody', 'deployment', 'output-tree', 'linked', 'licenses',
                 'archive', 'pins', 'patch', 'bun', 'git-sdk', 'npm', 'npm-spec', 'npm-pins',
                 'generator-controls', 'selected-reader', 'sections', 'mapper', 'cc-helper',
                 'cc-spec', 'execution-root', 'workspace-manifest', 'workspace-license', 'closure']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--ninja', type=Path)
    arguments, remaining = parser.parse_known_args()
    controls = load('original_builtin_generators', arguments.generator_controls)
    controls.arguments = arguments
    for name, argument in [('runner', 'runner'), ('builder', 'builder'), ('custody', 'custody'),
                           ('deployment', 'deployment'), ('outputs', 'output_tree'), ('linked', 'linked'),
                           ('licenses', 'licenses'), ('npm', 'npm')]:
        setattr(controls, name, load('builtin_retention_' + name, getattr(arguments, argument)))
    reader = load('builtin_selected_reader', arguments.selected_reader)
    sections = load('builtin_native_sections', arguments.sections)
    mapper = load('builtin_ld64_map', arguments.mapper)
    cc_helper = load('builtin_declared_cc', arguments.cc_helper)
    linked, licenses = controls.linked, controls.licenses
    closure = load('builtin_private_package', arguments.closure)
    private_sources = {
        'patch': {'input': str(arguments.patch), 'label': '//tools/bazel/bun:bun-runtime-build-embedded-inputs.patch', 'tree': False, 'authored': True},
        'manifest': {'input': str(arguments.workspace_manifest), 'label': '//:package.json', 'tree': False, 'authored': True},
        'license': {'input': str(arguments.workspace_license), 'label': '//:LICENSE', 'tree': False, 'authored': True},
    }

    class PatchLicenseControls(unittest.TestCase):
        def join(self, sources=None, patch=None):
            return controls.runner.private_builtin_patch(
                arguments.patch.read_bytes() if patch is None else patch,
                private_sources if sources is None else sources, closure, controls.deployment)

        def test_actual_authored_patch_uses_private_unversioned_root_notice(self):
            result = self.join()
            self.assertEqual(result['id'], 'merkur#//:package.json')
            self.assertIsNone(result['version'])
            self.assertEqual(result['license'], 'AGPL-3.0-only')
            self.assertEqual(result['texts'][0]['text'], arguments.workspace_license.read_text())
            self.assertEqual(result['source_members'][0]['sha256'], hashlib.sha256(arguments.patch.read_bytes()).hexdigest())
            self.assertEqual(result['manifest']['sha256'], hashlib.sha256(arguments.workspace_manifest.read_bytes()).hexdigest())

        def test_missing_forged_generated_and_external_source_identity_refuse(self):
            for sources in [None, {}, {'patch': private_sources['patch']}]:
                with self.assertRaisesRegex(ValueError, 'original private workspace SourceFiles'):
                    controls.runner.private_builtin_patch(arguments.patch.read_bytes(), sources, closure, controls.deployment)
            for role in private_sources:
                for change in [{'label': '@foreign//:package.json'}, {'authored': False}, {'tree': True}]:
                    sources = {**private_sources, role: {**private_sources[role], **change}}
                    with self.assertRaisesRegex(ValueError, 'original main-workspace SourceFile'):
                        self.join(sources)

        def workspace(self, directory):
            root = Path(directory)
            patch = root / 'tools/bazel/bun/bun-runtime-build-embedded-inputs.patch'
            patch.parent.mkdir(parents=True)
            patch.write_bytes(arguments.patch.read_bytes())
            (root / 'package.json').write_bytes(arguments.workspace_manifest.read_bytes())
            (root / 'LICENSE').write_bytes(arguments.workspace_license.read_bytes())
            return {role: {**private_sources[role], 'input': str(file)} for role, file in
                    [('patch', patch), ('manifest', root / 'package.json'), ('license', root / 'LICENSE')]}

        def test_other_workspace_or_changed_patch_cannot_borrow_root_notice(self):
            with tempfile.TemporaryDirectory(prefix='builtin-patch-custody-') as directory:
                sources = self.workspace(directory)
                with self.assertRaisesRegex(ValueError, 'another original workspace'):
                    self.join({**sources, 'patch': private_sources['patch']})
                with self.assertRaisesRegex(ValueError, 'actual consumed bytes'):
                    self.join(sources, arguments.patch.read_bytes() + b'changed')

        def test_invalid_private_manifest_refuses(self):
            with tempfile.TemporaryDirectory(prefix='builtin-private-manifest-') as directory:
                sources = self.workspace(directory)
                manifest = Path(sources['manifest']['input'])
                original = json.loads(manifest.read_bytes())
                for change in [{'version': 'invented'}, {'private': False}, {'name': 'bun'}, {'license': 'MIT'}]:
                    manifest.write_text(json.dumps({**original, **change}))
                    with self.assertRaisesRegex(ValueError, 'differs from original workspace manifest'):
                        self.join(sources)

        def test_changed_license_during_collection_refuses(self):
            with tempfile.TemporaryDirectory(prefix='builtin-license-race-') as directory:
                sources = self.workspace(directory)
                license_file = Path(sources['license']['input'])
                original_validate = closure.validate_private_manifest
                def mutate(component, data):
                    original_validate(component, data)
                    license_file.write_bytes(license_file.read_bytes() + b'changed license')
                closure.validate_private_manifest = mutate
                try:
                    with self.assertRaisesRegex(ValueError, 'input file identity changed|input bytes changed'):
                        self.join(sources)
                finally:
                    closure.validate_private_manifest = original_validate


    class JsonByteClassControls(unittest.TestCase):
        def setUp(self):
            temporary = tempfile.TemporaryDirectory(prefix='builtin-json-byte-class-')
            self.addCleanup(temporary.cleanup)
            self.source = Path(temporary.name).resolve(strict=True)
            pins = json.loads(arguments.pins.read_bytes())
            members, facts = controls.custody.source_archive_members(arguments.archive.read_bytes(), pins, licenses.relative)
            self.origin = {'component': 'bun@' + pins['version'], 'namespace': str(self.source),
                           'directory': self.source, 'members': members, 'aliases': {}}
            for name in ['scripts/build/jsonByteClass.ts', 'scripts/build/fs.ts', 'package.json']:
                file = self.source / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(members[name])
            self.codegen = self.source / 'codegen'
            config = self.source / 'empty-bunfig.toml'
            config.write_bytes(b'')
            script = ('import {generateJsonByteClass} from ' + json.dumps(str(self.source / 'scripts/build/jsonByteClass.ts'))
                      + ';generateJsonByteClass({codegenDir:' + json.dumps(str(self.codegen)) + '});')
            result = subprocess.run([str(arguments.bun), '--no-install', '--no-env-file', '--config=' + str(config), '--eval', script],
                cwd=self.source, env={'PATH': '', 'HOME': str(self.source), 'LC_ALL': 'C'}, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.header = self.codegen / 'json_byte_class.h'

        def join(self, runtime=None):
            return controls.runner.json_byte_class_inputs(self.source, self.header,
                arguments.bun if runtime is None else runtime, [self.origin], linked, licenses)

        def test_whole_original_header_joins_only_actual_generator_source_files(self):
            facts = self.join()
            self.assertEqual({fact['path'] for fact in facts},
                             {'scripts/build/jsonByteClass.ts', 'scripts/build/fs.ts', 'package.json'})
            self.assertTrue(all(fact['component'] == 'bun@1.4.2' for fact in facts))
            for fact in facts:
                self.assertEqual(fact['sha256'], hashlib.sha256(self.origin['members'][fact['path']]).hexdigest())

        def test_mutated_header_and_original_generator_sources_refuse(self):
            for file in [self.header, self.source / 'scripts/build/jsonByteClass.ts',
                         self.source / 'scripts/build/fs.ts', self.source / 'package.json']:
                body = file.read_bytes()
                try:
                    file.write_bytes(body + b'changed')
                    with self.assertRaisesRegex(ValueError, 'differs from the actual original|differs from original archive'):
                        self.join()
                finally:
                    file.write_bytes(body)

        def test_missing_or_nonexecutable_runtime_refuses(self):
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'actual declared Bun runtime File'):
                controls.runner.json_byte_class_inputs(self.source, self.header, None, [self.origin], linked, licenses)
            with self.assertRaisesRegex(ValueError, 'runtime is not executable'):
                self.join(self.source / 'scripts/build/jsonByteClass.ts')

        def test_foreign_header_and_source_namespace_refuse(self):
            with self.assertRaisesRegex(ValueError, 'namespace must be exact'):
                controls.runner.json_byte_class_inputs(self.source, self.source.parent / 'foreign.h',
                    arguments.bun, [self.origin], linked, licenses)
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'no original archive byte authority'):
                controls.runner.json_byte_class_inputs(self.source, self.header,
                    arguments.bun, [], linked, licenses)

        def test_real_clang_ninja_linked_dependency_selects_original_generated_header(self):
            if arguments.ninja is None:
                raise ValueError('Actual declared Ninja executable File is required for native JSON consumer control')
            spec = json.loads(arguments.cc_spec.read_bytes())
            root = arguments.execution_root
            if spec['cxx'] not in spec['inputs']:
                raise ValueError('Native JSON fixture compiler lacks actual declared File custody')
            compiler = root / spec['cxx']
            compile_flags = cc_helper.absolute_flags(spec['compile_flags'], root)
            link_flags = cc_helper.absolute_flags(spec['link_flags'], root)
            fixture_source = self.source / 'control'
            fixture_source.mkdir()
            main = fixture_source / 'main.cpp'
            body = b'#include "json_byte_class.h"\nextern "C" __attribute__((noinline)) unsigned classify(unsigned b) { return kBunJsonLutLo[b&15] & kBunJsonLutHi[b>>4]; }\nint main() { return (classify(123)&BUN_JSON_CLASS_STRUCTURAL) ? 0 : 1; }\n'
            main.write_bytes(body)
            build = self.source / 'build'
            build.mkdir()
            binary = build / 'native'
            native_map = build / 'native.map'
            compile_argv = [str(compiler), *compile_flags, '-MMD', '-MF', 'main.o.d',
                            '-I', str(self.codegen), '-c', str(main), '-o', 'main.o']
            link_argv = [str(compiler), *link_flags, '-Wl,-dead_strip', '-Wl,-map,' + str(native_map),
                         'main.o', '-o', str(binary)]
            command = lambda argv: shlex.join(argv).replace('$', '$$')
            (build / 'build.ninja').write_text('rule cxx\n  command = ' + command(compile_argv)
                + '\n  depfile = main.o.d\n  deps = gcc\nrule link\n  command = ' + command(link_argv)
                + '\nbuild main.o: cxx ' + str(main) + '\nbuild native: link main.o\n')
            environment = {'PATH': '', 'HOME': str(self.source), 'LC_ALL': 'C',
                           'MERKUR_NINJA_SHELL': str(arguments.git_sdk / 'bin/bash'),
                           'MERKUR_NINJA_PYTHON': sys.executable,
                           'DYLD_FALLBACK_LIBRARY_PATH': str(arguments.git_sdk / 'lib')}
            def run(argv):
                result = subprocess.run([str(value) for value in argv], cwd=build, env=environment, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                return result.stdout
            run([arguments.ninja])
            run([binary])
            (build / 'compile_commands.json').write_bytes(run([arguments.ninja, '-t', 'compdb', 'cxx']))
            (build / 'original-compiler-deps.txt').write_bytes(run([arguments.ninja, '-t', 'deps']))
            configuration = {'cfg': {'cwd': str(self.source), 'buildDir': str(build), 'codegenDir': str(self.codegen)},
                'runtime': str(binary), 'output': {'exe': str(binary)}, 'linkerMaps': [str(native_map)]}
            fixture_origin = {'component': 'actual-native-control', 'namespace': str(fixture_source),
                              'directory': fixture_source, 'members': {'main.cpp': body}, 'aliases': {}}
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'original generator source reproduction'):
                reader.retained_native_inputs(configuration, self.source, binary, 'aarch64-apple-darwin',
                    [self.origin, fixture_origin], linked, licenses, sections, mapper)
            facts = reader.retained_native_inputs(configuration, self.source, binary, 'aarch64-apple-darwin',
                [self.origin, fixture_origin], linked, licenses, sections, mapper, controls.runner, arguments.bun)
            self.assertEqual({fact['path'] for fact in facts if fact['component'] == 'bun@1.4.2'},
                             {'scripts/build/jsonByteClass.ts', 'scripts/build/fs.ts', 'package.json'})
            self.assertIn('main.cpp', {fact['path'] for fact in facts})
            if arguments.evidence:
                evidence = arguments.evidence / 'json-native'
                evidence.mkdir(parents=True)
                for file in [binary, native_map, build / 'compile_commands.json', build / 'original-compiler-deps.txt', self.header]:
                    (evidence / file.name).write_bytes(file.read_bytes())
                (evidence / 'result.json').write_text(json.dumps({'facts': facts, 'configuration': configuration,
                    'compile_argv': compile_argv, 'link_argv': link_argv, 'ninja': str(arguments.ninja)}, indent=2))

    class BuiltinRetentionControls(controls.GeneratedInputControls):
        @classmethod
        def setUpClass(cls):
            original_prepare = controls.npm.prepare
            def prepare(*args):
                original_prepare(*args)
                controls.runner.preserve_builtin_generators(cls.source, cls.source / 'build/release/codegen',
                    arguments.archive, json.loads(arguments.pins.read_bytes()), controls.custody, licenses)
            controls.npm.prepare = prepare
            try:
                super().setUpClass()
            finally:
                controls.npm.prepare = original_prepare
            spec = json.loads(arguments.cc_spec.read_bytes())
            root = arguments.execution_root
            if spec['cxx'] not in spec['inputs']:
                raise ValueError('Native fixture compiler lacks original declared File custody')
            cc = root / spec['cxx']
            flags = cc_helper.absolute_flags(spec['compile_flags'], root)
            link_flags = cc_helper.absolute_flags(spec['link_flags'], root)
            environment = {'PATH': '', 'HOME': str(cls.root), 'LC_ALL': 'C',
                           'SDKROOT': str(root / spec['environment']['SDKROOT'])}
            cls.binary, cls.native_map = cls.build / 'builtin-control', cls.build / 'builtin-control.map'
            main = cls.build / 'builtin-control.cpp'
            main.write_text('extern "C" const char bun_internal_modules_header[];\n'
                            'int main() { return bun_internal_modules_header[0] != \'B\'; }\n')
            assembly = cls.codegen / 'InternalModuleRegistryConstants.S'
            # This is the actual unchanged assembly emitted by the original
            # generator; no synthetic blob, replacement section or header edit.
            commands = [[str(cc), *flags, '-c', str(assembly), '-o', str(cls.build / 'builtins.o')],
                        [str(cc), *flags, '-c', str(main), '-o', str(cls.build / 'main.o')],
                        [str(cc), *link_flags, '-Wl,-dead_strip', '-Wl,-map,' + str(cls.native_map),
                         str(cls.build / 'main.o'), str(cls.build / 'builtins.o'), '-o', str(cls.binary)]]
            cls.native_commands = []
            for command in commands:
                result = subprocess.run(command, cwd=cls.codegen, env=environment, capture_output=True)
                cls.native_commands.append({'argv': command, 'exit': result.returncode,
                    'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()})
                if result.returncode:
                    raise ValueError('Original builtin native fixture failed: ' + json.dumps(cls.native_commands[-1]))
            # Exact executed producer arguments, captured after each successful compile.
            cls.compiler_database = cls.build / 'compile_commands.json'
            cls.compiler_database.write_text(json.dumps([
                {'directory': str(cls.codegen), 'file': command[command.index('-c') + 1],
                 'output': command[command.index('-o') + 1], 'arguments': command}
                for command in commands[:2]], indent=2))
            result = subprocess.run([str(cls.binary)], env={'PATH': ''}, capture_output=True)
            if result.returncode:
                raise ValueError('Native builtin consumer failed its original-byte check')
            cls.declared_runtime = cls.root / 'declared-runtime'
            cls.declared_runtime.write_bytes(cls.binary.read_bytes())
            if arguments.evidence:
                (arguments.evidence / 'native-commands.json').write_text(json.dumps(cls.native_commands, indent=2))
                for name, file in [('native.bin', cls.binary), ('native.map', cls.native_map),
                                   ('original-builtins.bin', cls.codegen / 'InternalModuleRegistryConstants.bin'),
                                   ('original-builtins.S', assembly)]:
                    (arguments.evidence / name).write_bytes(file.read_bytes())

        def configuration(self):
            pins = json.loads(arguments.pins.read_bytes())
            captured = controls.runner.capture_embedded_inputs({'cfg': {'codegenDir': str(self.codegen)}},
                self.source, arguments.archive, pins, controls.custody, linked, licenses)
            return {'cfg': {'cwd': str(self.source), 'buildDir': str(self.build),
                            'codegenDir': str(self.codegen)}, 'runtime': str(self.binary),
                    'output': {'exe': str(self.binary)}, 'linkerMaps': [str(self.native_map)],
                    'embeddedCompilerInputs': captured}

        def retain(self, configuration=None, published=None):
            origin = {**self.origin, 'component': 'bun@' + json.loads(arguments.pins.read_bytes())['version']}
            return reader.retained_builtin_inputs(configuration or self.configuration(),
                published or self.source, self.declared_runtime, 'aarch64-apple-darwin', [origin],
                linked, controls.runner, licenses, sections, mapper, arguments.patch, arguments.bun,
                private_sources, closure, controls.deployment)

        def test_original_generated_blob_and_invocation_sources_join_actual_loaded_bytes(self):
            configuration = self.configuration()
            result = self.retain(configuration)
            blob = (self.codegen / 'InternalModuleRegistryConstants.bin').read_bytes()
            self.assertEqual(result['blob'], {'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
            expected = {}
            for record in configuration['embeddedCompilerInputs']['compilerInputs']:
                if record['metadata'].endswith('/modules.json') or '/compiler-inputs/functions/' in record['metadata']:
                    for fact in record['sources']:
                        expected[(fact['component'], fact['path'], fact['source_path'])] = fact
            self.assertEqual(result['sources'], [expected[key] for key in sorted(expected)])
            self.assertTrue(result['sources'])
            self.assertEqual([fact['path'] for fact in result['licenses']], ['LICENSE.md'])
            self.assertEqual(result['licenses'][0]['text'], self.origin['members']['LICENSE.md'].decode())
            self.assertEqual([fact['path'] for fact in result['generated_sources']],
                             ['src/codegen/bundle-modules.ts', 'src/codegen/helpers.ts', 'src/codegen/bundle-functions.ts',
                              'src/codegen/builtin-parser.ts', 'src/codegen/client-js.ts',
                              'src/codegen/generate-js2native.ts', 'src/codegen/replacements.ts',
                              'src/jsc/bindings/ErrorCode.ts', 'src/jsc/bindings/js_classes.ts',
                              'src/codegen/internal-module-registry-scanner.ts',
                              'src/jsc/modules/NativeModuleList.h'] + sorted(name for name in self.origin['members']
                                  if any(name.startswith('src/js/' + directory + '/') for directory in
                                         ['bun', 'node', 'thirdparty', 'internal']) and
                                  (name.endswith('.js') or name.endswith('.ts') and not name.endswith('.d.ts'))) +
                             ['src/js/internal-for-testing.ts'])
            for fact in result['generated_sources']:
                self.assertEqual(fact['component'], 'bun@1.4.2')
                self.assertEqual(fact['sha256'], hashlib.sha256(self.origin['members'][fact['path']]).hexdigest())

        def test_changed_blob_runtime_and_invocation_partition_refuse(self):
            for file, message in [(self.codegen / 'InternalModuleRegistryConstants.bin', 'Loaded builtin bytes differ'),
                                  (self.declared_runtime, 'same source-built runtime File')]:
                body = file.read_bytes()
                try:
                    file.write_bytes(body[:-1] + bytes([body[-1] ^ 1]))
                    with self.assertRaisesRegex(ValueError, message):
                        self.retain()
                finally:
                    file.write_bytes(body)
            configuration = self.configuration()
            record = next(row for row in configuration['embeddedCompilerInputs']['compilerInputs']
                          if row['metadata'].endswith('/modules.json'))
            record['sources'] = []
            with self.assertRaisesRegex(ValueError, 'partition differs'):
                self.retain(configuration)

        def test_selected_original_license_mutation_refuses(self):
            configuration = self.configuration()
            file = self.source / 'LICENSE.md'
            body = file.read_bytes()
            try:
                file.write_bytes(body + b'\n')
                with self.assertRaisesRegex(ValueError, 'builtin license differs'):
                    self.retain(configuration)
            finally:
                file.write_bytes(body)

        def test_missing_live_symbol_and_own_pending_sources_refuse(self):
            body = self.native_map.read_bytes()
            try:
                self.native_map.write_bytes(body.replace(b'_bun_internal_modules_header', b'_foreign_internal_modules_header'))
                with self.assertRaisesRegex(linked.PendingLinkedSource, 'live symbol is absent'):
                    self.retain()
            finally:
                self.native_map.write_bytes(body)
            configuration = self.configuration()
            module = next(row['metadata'] for row in configuration['embeddedCompilerInputs']['compilerInputs']
                          if row['metadata'].endswith('/modules.json'))
            configuration['embeddedCompilerInputs']['pending'].append({'metadata': module, 'reason': 'missing original source'})
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'builtin source authority remains pending'):
                self.retain(configuration)

        def test_published_namespace_relocation_needs_no_original_temporary_source(self):
            configuration = self.configuration()
            expected = self.retain(configuration)
            published = self.root / 'published-source'
            self.source.rename(published)
            try:
                self.assertEqual(self.retain(configuration, published), expected)
            finally:
                published.rename(self.source)

        def test_other_generator_scopes_stay_pending_after_genuine_builtin_join(self):
            configuration = self.configuration()
            self.assertTrue(self.retain(configuration)['sources'])
            self.assertTrue(configuration['embeddedCompilerInputs']['pending'])
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'authority remains pending'):
                reader.read_selected_runtime(configuration, self.source, self.declared_runtime,
                    'aarch64-apple-darwin', [self.origin], linked, controls.runner, licenses, sections, mapper)

        def test_distinguishable_runtime_cannot_borrow_another_output_image(self):
            configuration = self.configuration()
            foreign = self.build / 'foreign-runtime'
            foreign.write_bytes(b'distinguishable owned runtime without any builtin blob')
            configuration['runtime'] = str(foreign)
            original_declared = self.declared_runtime.read_bytes()
            try:
                self.declared_runtime.write_bytes(foreign.read_bytes())
                with self.assertRaisesRegex(ValueError, 'Builtin native image differs'):
                    self.retain(configuration)
            finally:
                self.declared_runtime.write_bytes(original_declared)

        def test_original_generated_assembly_interpolation_and_literal_refusal(self):
            assembly = self.codegen / 'InternalModuleRegistryConstants.S'
            original = assembly.read_bytes()
            offset = int.from_bytes((self.codegen / 'InternalModuleRegistryConstants.bin').read_bytes()[32:36], 'little')
            self.assertIn(str(offset).encode(), original)
            self.assertNotIn(b'${blobDataOffset}', original)
            for changed in [original + b'// changed template output\n',
                            original.replace(str(offset).encode(), b'${blobDataOffset}')]:
                try:
                    assembly.write_bytes(changed)
                    with self.assertRaisesRegex(ValueError, 'assembly differs'):
                        self.retain()
                finally:
                    assembly.write_bytes(original)

        def test_original_generator_mutation_and_unselected_assembly_refuse(self):
            generator = self.source / 'src/codegen/bundle-modules.ts'
            original = generator.read_bytes()
            try:
                generator.write_bytes(original.replace(b'__bun_builtins', b'__foreign_builtins'))
                with self.assertRaisesRegex(ValueError, 'template differs from its original generator File'):
                    self.retain()
            finally:
                generator.write_bytes(original)
            body = self.compiler_database.read_bytes()
            try:
                database = json.loads(body)
                database[0]['file'] = str(self.build / 'builtin-control.cpp')
                index = database[0]['arguments'].index('-c') + 1
                database[0]['arguments'][index] = database[0]['file']
                self.compiler_database.write_text(json.dumps(database))
                with self.assertRaisesRegex(linked.PendingLinkedSource, 'exact assembly compiler relation'):
                    self.retain()
            finally:
                self.compiler_database.write_bytes(body)

        def test_preserved_original_generator_file_custody_refuses_late_capture(self):
            root = self.codegen / 'compiler-inputs/original-generators'
            for name in ['src/codegen/bundle-modules.ts', 'src/codegen/helpers.ts']:
                file = root / name
                original = file.read_bytes()
                try:
                    file.write_bytes(original + b'// mutated preserved original\n')
                    with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                        self.retain()
                finally:
                    file.write_bytes(original)
            # Capture is strictly before instrumentation, never a later claim
            # that an already modified generator was an original archive File.
            with self.assertRaisesRegex(ValueError, 'preservation differs from its original archive File'):
                controls.runner.preserve_builtin_generators(self.source, self.build / 'late-codegen',
                    arguments.archive, json.loads(arguments.pins.read_bytes()), controls.custody, licenses)
            self.assertEqual(self.retain()['pending_sources'],
                             [str(arguments.bun.resolve())])

        def test_original_patch_reproduces_complete_consumed_generator(self):
            original = self.codegen / 'compiler-inputs/original-generators/src/codegen/bundle-modules.ts'
            consumed = self.source / 'src/codegen/bundle-modules.ts'
            self.assertNotEqual(original.read_bytes(), consumed.read_bytes())
            self.assertEqual(controls.runner.instrumented_builtin_source(original.read_bytes(), arguments.patch.read_bytes()),
                             consumed.read_bytes())
            result = self.retain()
            self.assertEqual(result['generated_inputs'][0],
                             {'path': str(consumed), 'size': consumed.stat().st_size,
                              'sha256': hashlib.sha256(consumed.read_bytes()).hexdigest()})
            self.assertEqual(result['generated_inputs'][2]['sha256'], hashlib.sha256(arguments.bun.read_bytes()).hexdigest())
            component = result['generated_components'][0]
            self.assertEqual(component['id'], 'merkur#//:package.json')
            self.assertIsNone(component['version'])
            self.assertEqual(component['texts'][0]['text'], arguments.workspace_license.read_text())
            self.assertEqual(result['pending_sources'], [str(arguments.bun.resolve())])
            self.assertTrue(all(fact['component'] == 'bun@1.4.2' for fact in result['generated_sources']))

        def test_non_template_generator_mutation_and_substituted_patch_refuse(self):
            consumed = self.source / 'src/codegen/bundle-modules.ts'
            body = consumed.read_bytes()
            try:
                consumed.write_bytes(body + b'// original template unchanged but generator substituted\n')
                with self.assertRaisesRegex(ValueError, 'differs from the exact original and maintained patch'):
                    self.retain()
            finally:
                consumed.write_bytes(body)
            original = self.codegen / 'compiler-inputs/original-generators/src/codegen/bundle-modules.ts'
            for patch in [arguments.patch.read_bytes() + b'\n', b'', b'foreign patch']:
                with self.assertRaisesRegex(ValueError, 'exact maintained File'):
                    controls.runner.instrumented_builtin_source(original.read_bytes(), patch)
            with self.assertRaisesRegex(ValueError, 'requires exact unique original bytes'):
                controls.runner.instrumented_builtin_source(original.read_bytes().replace(b'const JS_DIR', b'const FOREIGN_JS_DIR'), arguments.patch.read_bytes())

        def test_original_function_generator_patch_joins_loaded_builtin_component(self):
            name = 'src/codegen/bundle-functions.ts'
            original = self.codegen / 'compiler-inputs/original-generators' / name
            consumed = self.source / name
            self.assertEqual(original.read_bytes(), self.origin['members'][name])
            self.assertNotEqual(original.read_bytes(), consumed.read_bytes())
            self.assertEqual(controls.runner.instrumented_builtin_source(original.read_bytes(), arguments.patch.read_bytes(), name), consumed.read_bytes())
            result = self.retain()
            facts = [fact for fact in result['generated_sources'] if fact['path'] == name]
            self.assertEqual(len(facts), 1)
            self.assertEqual(facts[0]['sha256'], hashlib.sha256(original.read_bytes()).hexdigest())
            self.assertEqual(facts[0]['component'], 'bun@1.4.2')
            self.assertEqual(result['generated_inputs'][3]['sha256'], hashlib.sha256(consumed.read_bytes()).hexdigest())
            self.assertEqual(result['pending_sources'], [str(arguments.bun.resolve())])
            self.assertEqual(result['generated_components'][0]['license'], 'AGPL-3.0-only')

        def test_exact_original_function_imports_join_with_transitive_tool_scopes_pending(self):
            result = self.retain()
            names = ['src/codegen/' + name for name in
                     ['builtin-parser.ts', 'client-js.ts', 'generate-js2native.ts', 'replacements.ts']]
            for name in names:
                facts = [fact for fact in result['generated_sources'] if fact['path'] == name]
                self.assertEqual(len(facts), 1)
                body = (self.source / name).read_bytes()
                self.assertEqual(body, self.origin['members'][name])
                self.assertEqual(facts[0]['component'], 'bun@1.4.2')
                self.assertEqual(facts[0]['sha256'], hashlib.sha256(body).hexdigest())
                consumed = [fact for fact in result['generated_inputs'] if fact['path'] == str(self.source / name)]
                self.assertEqual(consumed, [{'path': str(self.source / name), 'size': len(body),
                                            'sha256': hashlib.sha256(body).hexdigest()}])
                self.assertNotIn(str(self.source / name), result['pending_sources'])
            self.assertEqual(result['pending_sources'], [str(arguments.bun.resolve())])
            with self.assertRaises(linked.PendingLinkedSource):
                reader.read_selected_runtime(self.configuration(), self.source, self.declared_runtime,
                    'aarch64-apple-darwin', [self.origin], linked, controls.runner, licenses, sections, mapper)

        def test_missing_or_changed_direct_function_imports_refuse(self):
            for name in ['builtin-parser.ts', 'client-js.ts', 'generate-js2native.ts', 'replacements.ts']:
                file = self.source / 'src/codegen' / name
                body = file.read_bytes()
                try:
                    file.write_bytes(body + b'// substituted executed import\n')
                    with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                        self.retain()
                    file.unlink()
                    with self.assertRaises(FileNotFoundError):
                        self.retain()
                finally:
                    file.write_bytes(body)

        def test_exact_original_transitive_data_imports_join_without_execution_imports(self):
            names = ['src/jsc/bindings/ErrorCode.ts', 'src/jsc/bindings/js_classes.ts']
            result = self.retain()
            for name in names:
                body = (self.source / name).read_bytes()
                self.assertEqual(body, self.origin['members'][name])
                facts = [fact for fact in result['generated_sources'] if fact['path'] == name]
                self.assertEqual(len(facts), 1)
                self.assertEqual(facts[0]['component'], 'bun@1.4.2')
                self.assertEqual(facts[0]['sha256'], hashlib.sha256(body).hexdigest())
                consumed = [fact for fact in result['generated_inputs'] if fact['path'] == str(self.source / name)]
                self.assertEqual(consumed, [{'path': str(self.source / name), 'size': len(body),
                                            'sha256': hashlib.sha256(body).hexdigest()}])
            # Scan the actual original TypeScript, rather than assuming that a
            # selected data File's size/name proves the execution import closure.
            with tempfile.TemporaryDirectory(prefix='builtin-import-scan-') as directory:
                root = Path(directory)
                (root / 'empty-bunfig.toml').write_text('')
                (root / 'home').mkdir()
                (root / 'tmp').mkdir()
                env = {'PATH': '', 'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'),
                       'LC_ALL': 'C', 'CLAUDECODE': '1',
                       'ORIGINAL_ERROR_CODE': str(self.source / names[0]),
                       'ORIGINAL_JS_CLASSES': str(self.source / names[1])}
                script = 'const scan = new Bun.Transpiler({loader:"ts"}); process.stdout.write(JSON.stringify(await Promise.all([process.env.ORIGINAL_ERROR_CODE,process.env.ORIGINAL_JS_CLASSES].map(async file => scan.scanImports(await Bun.file(file).text())))));'
                scanned = subprocess.run([str(arguments.bun), '--no-install', '--no-env-file',
                    '--config=' + str(root / 'empty-bunfig.toml'), '--eval', script],
                    env=env, capture_output=True)
                self.assertEqual(scanned.returncode, 0, scanned.stderr.decode())
                self.assertEqual(json.loads(scanned.stdout), [[], []])
            self.assertEqual(result['pending_sources'], [str(arguments.bun.resolve())])
            with self.assertRaises(linked.PendingLinkedSource):
                reader.read_selected_runtime(self.configuration(), self.source, self.declared_runtime,
                    'aarch64-apple-darwin', [self.origin], linked, controls.runner, licenses, sections, mapper)

        def test_missing_changed_or_substituted_transitive_data_imports_refuse(self):
            for name in ['src/jsc/bindings/ErrorCode.ts', 'src/jsc/bindings/js_classes.ts']:
                file = self.source / name
                body = file.read_bytes()
                try:
                    file.write_bytes(body + b'// substituted transitive source\n')
                    with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                        self.retain()
                    file.unlink()
                    with self.assertRaises(FileNotFoundError):
                        self.retain()
                    file.write_bytes(body)
                    self.origin['members'][name] = body + b'// substituted original archive member\n'
                    with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                        self.retain()
                finally:
                    file.write_bytes(body)
                    self.origin['members'][name] = body

        def test_original_registry_scanner_and_members_join_actual_loaded_count(self):
            result = self.retain()
            names = ['src/codegen/internal-module-registry-scanner.ts', 'src/jsc/modules/NativeModuleList.h',
                     'src/js/internal-for-testing.ts']
            for name in names:
                facts = [fact for fact in result['generated_sources'] if fact['path'] == name]
                self.assertEqual(len(facts), 1)
                self.assertEqual(facts[0]['sha256'], hashlib.sha256(self.origin['members'][name]).hexdigest())
                consumed = [fact for fact in result['generated_inputs'] if fact['path'] == str(self.source / name)]
                body = (self.source / name).read_bytes()
                self.assertEqual(body, self.origin['members'][name])
                self.assertEqual(consumed, [{'path': str(self.source / name), 'size': len(body),
                                            'sha256': hashlib.sha256(body).hexdigest()}])
            self.assertEqual(result['pending_sources'], [str(arguments.bun.resolve())])
            with self.assertRaises(linked.PendingLinkedSource):
                reader.read_selected_runtime(self.configuration(), self.source, self.declared_runtime,
                    'aarch64-apple-darwin', [self.origin], linked, controls.runner, licenses, sections, mapper)

        def test_changed_registry_scanner_native_data_members_and_header_refuse(self):
            for name in ['src/codegen/internal-module-registry-scanner.ts', 'src/jsc/modules/NativeModuleList.h',
                         'src/js/internal-for-testing.ts']:
                file = self.source / name
                body = file.read_bytes()
                try:
                    file.write_bytes(body + b'// substituted registry input\n')
                    with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                        self.retain()
                    file.unlink()
                    with self.assertRaises(FileNotFoundError):
                        self.retain()
                finally:
                    file.write_bytes(body)
            header = self.codegen / 'InternalModuleRegistry+numberOfModules.h'
            body = header.read_bytes()
            try:
                header.write_bytes(body + b'// substituted generated header\n')
                with self.assertRaisesRegex(ValueError, 'count header differs'):
                    self.retain()
            finally:
                header.write_bytes(body)
            foreign = self.source / 'src/js/internal/unbound-foreign.ts'
            try:
                foreign.write_bytes(b'export default 1;\n')
                with self.assertRaisesRegex(ValueError, 'member inventory differs'):
                    self.retain()
            finally:
                foreign.unlink()

        def test_direct_function_import_cannot_borrow_changed_original_member(self):
            name = 'src/codegen/replacements.ts'
            body = self.origin['members'][name]
            try:
                self.origin['members'][name] = body + b'// foreign original archive member\n'
                with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                    self.retain()
            finally:
                self.origin['members'][name] = body

        def test_mutated_preserved_or_consumed_function_generator_refuses(self):
            name = 'src/codegen/bundle-functions.ts'
            for file, message in [(self.codegen / 'compiler-inputs/original-generators' / name,
                                   'differs from the exact original|requires exact unique original bytes|differs from original archive bytes'),
                                  (self.source / name, 'function generator differs from the exact original')]:
                body = file.read_bytes()
                try:
                    file.write_bytes(body + b'// substituted function generator\n')
                    with self.assertRaisesRegex(ValueError, message):
                        self.retain()
                finally:
                    file.write_bytes(body)
            with self.assertRaisesRegex(ValueError, 'generator identity differs'):
                controls.runner.instrumented_builtin_source(self.origin['members'][name], arguments.patch.read_bytes(), 'foreign-generator.ts')

        def test_missing_patch_or_nonexecutable_generator_refuse(self):
            configuration = self.configuration()
            origin = {**self.origin, 'component': 'bun@1.4.2'}
            for patch, runtime in [(None, arguments.bun), (arguments.patch, None)]:
                with self.assertRaisesRegex(linked.PendingLinkedSource, 'patch/generator Files are required'):
                    reader.retained_builtin_inputs(configuration, self.source, self.declared_runtime,
                        'aarch64-apple-darwin', [origin], linked, controls.runner, licenses, sections, mapper,
                        patch, runtime)
            with self.assertRaisesRegex(ValueError, 'actual executable File'):
                reader.retained_builtin_inputs(configuration, self.source, self.declared_runtime,
                    'aarch64-apple-darwin', [origin], linked, controls.runner, licenses, sections, mapper,
                    arguments.patch, self.source / 'LICENSE.md')

    unittest.main(argv=[sys.argv[0], *remaining])
