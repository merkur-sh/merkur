"""Focused original CMake archive, maintained source and selection controls."""

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class Controls(unittest.TestCase):
    def test_original_archive_and_license(self):
        self.assertEqual(len(original), 30265)
        self.assertIn(b'Kitware', original['LICENSE.rst'])

    def test_exact_maintained_patches(self):
        self.assertEqual(len(changed), 6)
        self.assertIn('Source/kwsys/SystemVersionDarwin.hxx', changed)
        self.assertIn(b'native-system-version', expected['Source/cmcmd.cxx'])
        self.assertEqual(expected['LICENSE.rst'], original['LICENSE.rst'])

    def test_foreign_archive_and_version_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'changed.tar.gz'
            file.write_bytes(args.archive.read_bytes() + b'x')
            with self.assertRaisesRegex(ValueError, 'exact original'):
                join.original_source(file, pins)
        mutated = copy.deepcopy(pins)
        mutated['version'] = '4.4.4'
        with self.assertRaisesRegex(ValueError, 'release differs'):
            join.original_source(args.archive, mutated)

    def test_foreign_patch_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'foreign.patch'
            file.write_bytes(b'--- a/a.cpp\n+++ b/other.cpp\n@@ -1 +1 @@\n-a\n+b\n')
            with self.assertRaisesRegex(ValueError, 'member relation'):
                join.patched_source(original, [file], args.git, environment)

    def test_new_file_patch_member_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'new-file.patch'
            for member, expected_error in [('../foreign.hxx', 'escapes'),
                                           ('LICENSE.rst', 'existing source'),
                                           ('/absolute.hxx', 'escapes')]:
                with self.subTest(member=member):
                    file.write_bytes(('--- /dev/null\n+++ b/' + member +
                                      '\n@@ -0,0 +1 @@\n+new\n').encode())
                    with self.assertRaisesRegex(ValueError, expected_error):
                        join.patched_source(original, [file], args.git, environment)
            file.write_bytes(b'--- /dev/null\n+++ /foreign.hxx\n@@ -0,0 +1 @@\n+new\n')
            with self.assertRaisesRegex(ValueError, 'member relation'):
                join.patched_source(original, [file], args.git, environment)

    def test_original_cpp_link_template(self):
        value = builder.linker_template(original, 'aarch64-apple-darwin')
        self.assertTrue(value.endswith('-Wl,-map,<TARGET>.map'))
        self.assertTrue(builder.linker_template(original, 'x86_64-unknown-linux-gnu').endswith('-Wl,--Map=<TARGET>.map'))
        with self.assertRaisesRegex(ValueError, 'template differs'):
            builder.linker_template(dict(original, **{'Modules/CMakeCXXInformation.cmake': b'foreign'}), 'aarch64-apple-darwin')

    def test_declared_source_custody(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'a.cpp').write_bytes(b'original')
            records = [{'relative': 'a.cpp', 'path': 'a.cpp'}]
            join.source_files(records, {'a.cpp': b'original'}, root)
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                join.source_files(records, {'a.cpp': b'original', 'b.cpp': b'b'}, root)
            with self.assertRaisesRegex(ValueError, 'differs'):
                join.source_files(records, {'a.cpp': b'changed'}, root)
            with self.assertRaisesRegex(ValueError, 'repeated'):
                join.source_files(records * 2, {'a.cpp': b'original'}, root)

    def test_known_selected_source_and_patch_license(self):
        selected = ['Source/cmcmd.cxx', 'Source/kwsys/SystemInformation.cxx', 'Utilities/cmzlib/zlib.h']
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in selected:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(expected[name])
            result = join.partition([str(root / member) for member in selected], root,
                expected, original, changed, args.workspace_license.read_bytes(), linked, licenses)
            self.assertEqual(result['pending'], [])
            self.assertEqual(result['notices']['LICENSE.rst'], original['LICENSE.rst'])
            self.assertEqual(result['notices']['Utilities/cmzlib/Copyright.txt'], original['Utilities/cmzlib/Copyright.txt'])
            self.assertEqual(result['notices']['merkur-maintained-source-LICENSE'], args.workspace_license.read_bytes())
            with self.assertRaisesRegex(ValueError, 'workspace license'):
                join.partition([str(root / selected[0])], root, expected, original, changed, b'', linked, licenses)

    def test_unknown_native_source_stays_pending(self):
        result = join.partition(['/declared-sdk/usr/include/stdio.h'], Path('/original'), expected,
            original, changed, args.workspace_license.read_bytes(), linked, licenses)
        self.assertEqual(result['pending'], ['/declared-sdk/usr/include/stdio.h'])
        self.assertEqual(result['notices'], {})

    def test_tampered_selected_source_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'cmcmd.cxx').write_bytes(b'foreign')
            with self.assertRaisesRegex(ValueError, 'differs'):
                join.partition([str(root / 'cmcmd.cxx')], root,
                    {'cmcmd.cxx': expected['Source/cmcmd.cxx']}, original, changed,
                    args.workspace_license.read_bytes(), linked, licenses)

    def test_compiler_products_publish_to_engine_precreated_empty_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            products = root / 'products'
            products.mkdir()
            (products / 'actual.o.d').write_bytes(b'original compiler dependency bytes')
            output = root / 'output'
            output.mkdir()
            builder.retained_products(products, output, '.o.d')
            self.assertEqual((output / 'actual.o.d').read_bytes(), (products / 'actual.o.d').read_bytes())

    def test_captured_trees_refuse_occupied_and_alias_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            products = root / 'products'
            products.mkdir()
            (products / 'actual.o.d').write_bytes(b'original compiler dependency bytes')
            incumbent = root / 'incumbent'
            incumbent.mkdir()
            (incumbent / 'owned').write_bytes(b'preserved incumbent')
            for name in ['occupied', 'alias', 'dangling', 'file']:
                output = root / name
                if name == 'occupied':
                    output.mkdir()
                    (output / 'owned').write_bytes(b'preserved occupied output')
                elif name == 'alias':
                    output.symlink_to(incumbent)
                elif name == 'dangling':
                    output.symlink_to(root / 'missing')
                else:
                    output.write_bytes(b'preserved original File')
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'ordinary empty TreeArtifact'):
                    builder.retained_products(products, output, '.o.d')
                self.assertEqual((incumbent / 'owned').read_bytes(), b'preserved incumbent')
                if name == 'occupied':
                    self.assertEqual((output / 'owned').read_bytes(), b'preserved occupied output')
                elif name == 'file':
                    self.assertEqual(output.read_bytes(), b'preserved original File')
                else:
                    self.assertTrue(output.is_symlink())


    def test_executed_compiler_and_runtime_authority_stays_pending_without_headers(self):
        spec = {name: 'declared/' + name for name in ['cc', 'cxx', 'ar', 'ranlib', 'sdk', 'make_sdk', 'sysroot']}
        pending = builder.pending_producer_inputs(spec, Path('/original-action'))
        self.assertEqual(pending, sorted('/original-action/declared/' + name for name in spec))
        spec['sysroot'] = ''
        self.assertNotIn('/original-action', builder.pending_producer_inputs(spec, Path('/original-action')))


    def test_grouped_generator_source_notice_and_pending_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            executable = root / 'cmake'
            executable.write_bytes(b'explicit synthetic artifact for unit boundary only')
            member = 'Source/cmVersion.cxx'
            (root / 'source.cpp').write_bytes(original[member])
            notices = root / 'notices'
            notices.mkdir()
            (notices / 'LICENSE.rst').write_bytes(original['LICENSE.rst'])
            configuration = root / 'configuration.json'
            value = {'producer': '//control:source_cmake', 'binary': 'cmake',
                'artifact': {'size': executable.stat().st_size, 'sha256': hashlib.sha256(executable.read_bytes()).hexdigest()},
                'source': [{'relative': member, 'path': 'source.cpp'}],
                'selected_sources': [{'component': 'cmake', 'source_path': member, 'size': len(original[member]),
                                      'sha256': hashlib.sha256(original[member]).hexdigest()}],
                'selected_notices': [{'path': 'LICENSE.rst', 'size': len(original['LICENSE.rst']),
                                      'sha256': hashlib.sha256(original['LICENSE.rst']).hexdigest()}],
                'pending_sources': ['/original-compiler-sdk/stdio.h']}
            configuration.write_text(json.dumps(value))
            descriptor = {'producer': value['producer'], 'executable': 'cmake',
                          'configuration': 'configuration.json', 'notices': 'notices', 'original_sources': ['source.cpp']}
            facts, notice_files, pending = join.generator_sources(descriptor, root, executable, licenses)
            self.assertEqual(pending, value['pending_sources'])
            self.assertEqual(notice_files['LICENSE.rst'], original['LICENSE.rst'])
            self.assertEqual(facts, value['selected_sources'])
            with self.assertRaisesRegex(ValueError, 'another actual'):
                join.generator_sources(dict(descriptor, producer='//control:foreign'), root, executable, licenses)
            with self.assertRaisesRegex(ValueError, 'escape'):
                join.generator_sources(dict(descriptor, original_sources=[]), root, executable, licenses)
            (root / 'source.cpp').write_bytes(b'changed selected source')
            with self.assertRaisesRegex(ValueError, 'source File changed'):
                join.generator_sources(descriptor, root, executable, licenses)
            (root / 'source.cpp').write_bytes(original[member])
            (notices / 'LICENSE.rst').write_bytes(b'foreign license')
            with self.assertRaisesRegex(ValueError, 'notice File changed'):
                join.generator_sources(descriptor, root, executable, licenses)
            (notices / 'LICENSE.rst').write_bytes(original['LICENSE.rst'])
            executable.write_bytes(b'foreign artifact')
            with self.assertRaisesRegex(ValueError, 'compiler artifact'):
                join.generator_sources(descriptor, root, executable, licenses)



if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['archive', 'pins', 'join', 'builder', 'git', 'git-runtime', 'linked', 'licenses', 'workspace-license']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--patch', type=Path, action='append', required=True)
    args = parser.parse_args()
    # Git executes with a private original patch cwd; bind its supplied runfile
    # and loader runtime to the test action cwd before changing directories.
    args.git = args.git.absolute()
    args.git_runtime = args.git_runtime.absolute()
    join, builder, linked, licenses = [load('original_' + name, getattr(args, name)) for name in ['join', 'builder', 'linked', 'licenses']]
    pins = json.loads(args.pins.read_text())
    environment = {'PATH': '', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                   'DYLD_FALLBACK_LIBRARY_PATH': str(args.git_runtime / 'lib')}
    original = join.original_source(args.archive, pins)
    expected, changed = join.patched_source(original, args.patch, args.git, environment)
    unittest.main(argv=['original-cmake-selection-controls'])
