"""Original Binaryen and source SDK boundaries; no native compilation claim."""
import argparse
import copy
import importlib.util
import json
import subprocess
import shutil
from pathlib import Path
import tempfile
import unittest


class OriginalControls(unittest.TestCase):
    def test_real_original_source_and_submodule(self):
        value = builder.original_source(archive, googletest, pins)
        self.assertEqual(len(value), 2628)
        self.assertIn(b'project(binaryen LANGUAGES C CXX VERSION 117)', value['CMakeLists.txt'])
        self.assertIn('third_party/googletest/LICENSE', value)
        self.assertIn('third_party/llvm-project/DWARFContext.cpp', value)
        # The root LLVM license is absent, but the authentic nested license and
        # pinned original readme revision exist. Selected scoped joins remain required.
        self.assertNotIn('third_party/llvm-project/LICENSE.TXT', value)

    def test_original_llvm_nested_license_revision(self):
        source = builder.original_source(archive, googletest, pins)
        facts = builder.original_llvm_licenses(source, pins)
        self.assertEqual(facts['revision'], '6c86d6efaf129c42d37121f1e7e9a7adffb54c1a')
        self.assertEqual(facts['license'], 'third_party/llvm-project/include/llvm/LICENSE.TXT')
        for member, raw in [(pins['llvm']['license']['member'], b'changed text'),
                            (pins['llvm']['readme'], b'foreign revision'),
                            (pins['llvm']['support_notice'], b'')]:
            changed = dict(source, **{member: raw})
            with self.subTest(member=member), self.assertRaises(ValueError):
                builder.original_llvm_licenses(changed, pins)

    def test_selected_llvm_scopes_embedded_terms(self):
        source = builder.original_source(archive, googletest, pins)
        md5 = 'third_party/llvm-project/include/llvm/Support/MD5.h'
        selected = builder.selected_llvm_licenses([md5], source, pins, unicode_files, unicode)
        self.assertEqual(set(selected), {pins['llvm']['license']['member'],
                         pins['llvm']['support_notice'], md5})
        self.assertIn(b'No copyright is', selected[md5])
        self.assertNotIn(b'#include', selected[md5])
        ordinary = builder.selected_llvm_licenses(['third_party/llvm-project/DWARFContext.cpp'], source, pins, unicode_files, unicode)
        self.assertEqual(set(ordinary), {pins['llvm']['license']['member']})
        self.assertEqual(builder.selected_llvm_licenses([], source, pins, unicode_files, unicode), {})
        for members in [['foreign.cpp'], ['third_party/llvm-project/foreign.cpp']]:
            with self.subTest(members=members), self.assertRaises(ValueError):
                builder.selected_llvm_licenses(members, source, pins, unicode_files, unicode)
        changed = dict(source, **{md5: b'changed embedded original terms'})
        with self.assertRaisesRegex(ValueError, 'embedded LLVM notice'):
            builder.selected_llvm_licenses([md5], changed, pins, unicode_files, unicode)

    def test_original_unicode_generator_source_and_license_join(self):
        source = builder.original_source(archive, googletest, pins)
        selected = builder.selected_llvm_licenses([pins['unicode']['source_member']],
            source, pins, unicode_files, unicode)
        self.assertEqual(set(selected), {pins['llvm']['license']['member'],
            'unicode-data-copyright', 'unicode-readme', 'unicode-terms', 'unicode-license'})
        self.assertIn(b'2016 Unicode', selected['unicode-data-copyright'])
        self.assertEqual(selected['unicode-license'], unicode_files['license'].read_bytes())
        raw = unicode.capture(unicode_files, pins)
        generated = unicode.generated_source(raw['generator'], raw['data'], pins['unicode']['source_uri'])
        self.assertEqual(generated, raw['original_cpp'])
        self.assertEqual(len(generated) - len(source[pins['unicode']['source_member']]), 4)
        with self.assertRaisesRegex(ValueError, 'all original'):
            unicode.join(source, pins, dict(list(unicode_files.items())[:-1]))
        for role in unicode.ROLES:
            with tempfile.TemporaryDirectory() as temporary:
                file = Path(temporary) / 'changed-original'
                file.write_bytes(unicode_files[role].read_bytes() + b'x')
                with self.subTest(role=role), self.assertRaisesRegex(ValueError, 'differs'):
                    unicode.join(source, pins, dict(unicode_files, **{role: file}))

    def test_unicode_publisher_source_edits_and_terms_relation_refuse_mutation(self):
        source = builder.original_source(archive, googletest, pins)
        for field, value in [('publisher_source_edits', []),
                ('source_uri', 'http://www.unicode.org/Public/10.0.0/ucd/CaseFolding.txt'),
                ('published_cpp_sha256', '0' * 64)]:
            changed = copy.deepcopy(pins)
            changed['unicode'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                unicode.join(source, changed, unicode_files)
        member = pins['unicode']['source_member']
        with self.assertRaisesRegex(ValueError, 'publisher generator relation'):
            unicode.join(dict(source, **{member: unicode_files['original_cpp'].read_bytes()}), pins, unicode_files)
        for role in ['terms', 'data', 'readme', 'license']:
            with tempfile.TemporaryDirectory() as temporary:
                file = Path(temporary) / 'wrong-origin'
                file.write_bytes(b'foreign source license relation')
                changed = copy.deepcopy(pins)
                import hashlib
                changed['unicode'][role]['size'] = file.stat().st_size
                changed['unicode'][role]['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
                with self.subTest(role=role), self.assertRaises(ValueError):
                    unicode.join(source, changed, dict(unicode_files, **{role: file}))

    def test_changed_original_archive_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            changed = Path(temporary) / 'changed.tar.gz'
            for source in [archive, googletest]:
                changed.write_bytes(source.read_bytes() + b'x')
                with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'exact original'):
                    if source == archive:
                        builder.original_source(changed, googletest, pins)
                    else:
                        builder.original_source(archive, changed, pins)

    def test_wrong_release_refused(self):
        for key, value in [('version', '118'), ('commit', '0' * 40), ('name', 'foreign')]:
            changed = copy.deepcopy(pins)
            changed[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'version_117'):
                builder.original_source(archive, googletest, changed)

    def test_exact_declared_member_and_byte_custody(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'a.cpp').write_bytes(b'actual original source')
            expected = {'a.cpp': b'actual original source'}
            entry = {'path': 'a.cpp', 'member': 'a.cpp', 'label': '@original//:a.cpp'}
            self.assertEqual(builder.source_files([entry], expected, root), {'a.cpp': root / 'a.cpp'})
            for records in [[], [entry, entry], [dict(entry, member='foreign.cpp')],
                            [dict(entry, path='../a.cpp')], [dict(entry, path='/a.cpp')]]:
                with self.subTest(records=records), self.assertRaises(ValueError):
                    builder.source_files(records, expected, root)
            (root / 'a.cpp').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'differs'):
                builder.source_files([entry], expected, root)

    def test_native_tool_requires_declared_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tool = root / 'tool'
            tool.write_bytes(b'explicit fixture executable')
            tool.chmod(0o755)
            names = ['cc', 'cxx', 'ar', 'ranlib', 'shell', 'make', 'make_driver', 'cmake']
            specification = {'tools': {name: 'tool' for name in names}, 'declared_files': ['tool', 'sdk'], 'sdk_roots': {name: 'sdk' for name in ['shell', 'make', 'cmake']}}
            (root / 'sdk').mkdir()
            self.assertEqual(len(builder.declared_tools(specification, root)), 8)
            changed = copy.deepcopy(specification)
            changed['declared_files'] = ['sdk']
            with self.assertRaisesRegex(ValueError, 'undeclared executable'):
                builder.declared_tools(changed, root)
            changed = copy.deepcopy(specification)
            del changed['sdk_roots']['cmake']
            with self.assertRaisesRegex(ValueError, 'all three'):
                builder.declared_tools(changed, root)
            changed = copy.deepcopy(specification)
            changed['tools']['ambient'] = '/usr/bin/make'
            with self.assertRaisesRegex(ValueError, 'mandatory'):
                builder.declared_tools(changed, root)
            tool.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'undeclared executable'):
                builder.declared_tools(specification, root)

    def test_configuration_uses_original_public_helper_api(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = {name: str(root / 'declared tools' / name)
                     for name in ['cc', 'cxx', 'ar', 'ranlib', 'make_driver', 'cmake']}
            flags = {name: helper.absolute_flags(['--ld-path=external/apple/ld',
                '-isysroot', 'external/apple/sdk', '-DORIGINAL="$literal"'], root)
                for name in ['compile_flags', 'cxx_flags']}
            link = helper.absolute_flags(['--ld-path=external/apple/ld', '-Wl,-map,' + str(root / 'output.map')], root)
            specification = {'platform': 'darwin_arm64', 'sysroot': 'external/apple/sdk'}
            toolchain, contents, command = builder.configuration(specification, root, tools,
                flags, root, root / 'original source', root / 'build', link, link)
            self.assertEqual(command[:8], [tools['cmake'], '-S', str(root / 'original source'),
                '-B', str(root / 'build'), '-G', 'Unix Makefiles', '-DCMAKE_TOOLCHAIN_FILE=' + str(toolchain)])
            for option in ['-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-DBUILD_TESTS=ON',
                           '-DBYN_ENABLE_ASSERTIONS=ON', '-DBUILD_LLVM_DWARF=ON', '-DBUILD_STATIC_LIB=OFF']:
                self.assertIn(option, command)
            self.assertIn('--ld-path=' + str(root / 'external/apple/ld'), contents)
            self.assertIn(str(root / 'external/apple/sdk'), contents)
            self.assertIn('$literal', contents)
            self.assertIn(tools['make_driver'], contents)
            toolchain.write_text(contents)
            with self.assertRaisesRegex(ValueError, 'declared CcToolchain sysroot'):
                builder.configuration(dict(specification, sysroot=''), root, tools,
                    flags, root, root / 'source', root / 'build', link, link)
            if cmake is not None:
                # Parse the actual generated file with an explicit declared CMake
                # executable. This proves configuration syntax, not compilation.
                values = ['compiler path with space', '$literal\\suffix"quote', 'nested ]] ]=] close']
                for value in values:
                    probe = root / 'literal.cmake'
                    result = root / 'parsed-value'
                    probe.write_text(contents + '\nset(ROUNDTRIP ' + builder.cmake_literal(value) + ')\n'
                        + 'file(WRITE ' + builder.cmake_literal(result) + ' "${ROUNDTRIP}")\n')
                    subprocess.run([str(cmake), '-P', str(probe)], env={'PATH': '', 'LC_ALL': 'C'}, check=True)
                    self.assertEqual(result.read_text(), value)

    def test_original_compiler_products_survive_private_cleanup(self):
        if compiler_products is None:
            self.skipTest('Explicit original native object/archive fixture not supplied')
        products = sorted(compiler_products.glob('*.o'))
        archives = sorted(compiler_products.glob('*.a'))
        self.assertTrue(products)
        self.assertTrue(archives)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            objects, retained_archives = root / 'objects', root / 'archives'
            objects.mkdir()
            retained_archives.mkdir()
            with tempfile.TemporaryDirectory(dir=root) as private:
                original = Path(private)
                for product in [products[0], archives[0]]:
                    target = original / 'compiled' / product.name
                    target.parent.mkdir(exist_ok=True)
                    shutil.copyfile(product, target)
                builder.preserve_compiler_products(original, objects, retained_archives)
            self.assertFalse(original.exists())
            self.assertEqual((objects / 'compiled' / products[0].name).read_bytes(), products[0].read_bytes())
            self.assertEqual((retained_archives / 'compiled' / archives[0].name).read_bytes(), archives[0].read_bytes())
            original = root / 'escaped'
            original.mkdir()
            (original / 'foreign.o').symlink_to(products[0])
            with self.assertRaisesRegex(ValueError, 'ordinary File'):
                builder.preserve_compiler_products(original, objects, retained_archives)
            (original / 'foreign.o').unlink()
            with self.assertRaisesRegex(ValueError, 'no same-build object'):
                builder.preserve_compiler_products(original, objects, retained_archives)

    def test_actual_make_objects_archive_members_select_only_retained_sources(self):
        self.assertIsNotNone(compiler_products)
        commands = (compiler_products.parent / 'compile_commands.json').read_bytes()
        dependencies = [compiler_products / (name + '.d') for name in ['main', 'retained', 'discarded']]
        images = [(compiler_products / 'fixture', compiler_products / 'fixture.map', 'executable')]
        actual = builder.compiler_selection(compiler_products, images, 'aarch64-apple-darwin',
            commands, dependencies, linked, sections, mapper, licenses)
        source = compiler_products.parent / 'source'
        self.assertEqual(actual, tuple(sorted([str(source / 'main.cpp'), str(source / 'retained.cpp')])))
        self.assertNotIn(str(source / 'discarded.cpp'), actual)
        with self.assertRaisesRegex(ValueError, 'repeats an original compiler object'):
            builder.compiler_selection(compiler_products, images, 'aarch64-apple-darwin',
                commands, dependencies + dependencies[:1], linked, sections, mapper, licenses)
        with self.assertRaisesRegex(ValueError, 'dependency File closure is absent'):
            builder.compiler_selection(compiler_products, images, 'aarch64-apple-darwin',
                commands, [], linked, sections, mapper, licenses)
        with self.assertRaisesRegex(ValueError, 'lacks actual compiler dependency'):
            builder.compiler_selection(compiler_products, images, 'aarch64-apple-darwin',
                commands, dependencies[1:], linked, sections, mapper, licenses)

    def test_actual_dylib_uses_its_original_image_and_relative_output_map(self):
        commands = (compiler_products.parent / 'compile_commands.json').read_bytes()
        dependencies = [compiler_products / (name + '.d') for name in ['main', 'retained', 'discarded']]
        image = (compiler_products / 'fixture-library.dylib', compiler_products / 'fixture-library.map', 'dylib')
        actual = builder.compiler_selection(compiler_products, [image], 'aarch64-apple-darwin',
            commands, dependencies, linked, sections, mapper, licenses)
        self.assertEqual(actual, (str(compiler_products.parent / 'source/retained.cpp'),))
        with self.assertRaisesRegex(ValueError, 'Mach-O header'):
            builder.compiler_selection(compiler_products, [(*image[:2], 'executable')], 'aarch64-apple-darwin',
                commands, dependencies, linked, sections, mapper, licenses)
        with tempfile.TemporaryDirectory() as temporary:
            changed = Path(temporary) / 'foreign.map'
            raw = image[1].read_bytes()
            self.assertTrue(raw.startswith(b'# Path: fixture-library.dylib\n'))
            changed.write_bytes(raw.replace(b'# Path: fixture-library.dylib\n', b'# Path: other-library.dylib\n', 1))
            with self.assertRaisesRegex(ValueError, 'another output File'):
                builder.compiler_selection(compiler_products, [(image[0], changed, 'dylib')], 'aarch64-apple-darwin',
                    commands, dependencies, linked, sections, mapper, licenses)
            # This dylib links a direct original object, so exercise archive
            # substitution on the genuine executable map separately.
            executable = compiler_products / 'fixture'
            raw = (compiler_products / 'fixture.map').read_bytes()
            self.assertIn(b'libfixture.a(retained.o)', raw)
            changed.write_bytes(raw.replace(b'libfixture.a(retained.o)', b'libfixture.a(foreign.o)'))
            with self.assertRaisesRegex(ValueError, 'absent from its original archive'):
                builder.compiler_selection(compiler_products, [(executable, changed, 'executable')], 'aarch64-apple-darwin',
                    commands, dependencies, linked, sections, mapper, licenses)

    def test_original_selected_component_notice_boundaries_and_pending_refusal(self):
        source = builder.original_source(archive, googletest, pins)
        members = ['src/support/istring.cpp', 'third_party/googletest/googletest/src/gtest.cc',
                   'third_party/llvm-project/include/llvm/Support/MD5.h',
                   'third_party/llvm-project/UnicodeCaseFold.cpp']
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for member in members:
                file = root / member
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(source[member])
            selected = [str(root / member) for member in members]
            facts, notices, pending = builder.partition_original_sources(selected, root, source, pins,
                unicode_files, unicode, linked, licenses)
            self.assertEqual({fact['component'] for fact in facts}, {'binaryen', 'googletest', 'llvm'})
            self.assertFalse(pending)
            self.assertEqual(notices['binaryen/LICENSE'], source['LICENSE'])
            self.assertEqual(notices['googletest/LICENSE'], source['third_party/googletest/LICENSE'])
            self.assertEqual(notices['llvm/unicode-license'], unicode_files['license'].read_bytes())
            self.assertIs(builder.complete_notices({'sources': facts, 'notices': notices, 'pending': pending}), notices)
            unknown = str(root.parent / 'original-sdk-source-not-yet-joined.h')
            facts, notices, pending = builder.partition_original_sources(selected + [unknown], root,
                source, pins, unicode_files, unicode, linked, licenses)
            self.assertEqual(pending, [unknown])
            with self.assertRaisesRegex(ValueError, 'lack original source/license authority'):
                builder.complete_notices({'sources': facts, 'notices': notices, 'pending': pending})
            with self.assertRaisesRegex(ValueError, 'empty'):
                builder.complete_notices({'sources': [], 'notices': {}, 'pending': []})
            (root / members[0]).write_bytes(b'foreign compiler source bytes')
            with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                builder.partition_original_sources(selected, root, source, pins, unicode_files,
                    unicode, linked, licenses)
            generated = root / 'generated.h'
            generated.write_bytes(b'not an original archive member')
            with self.assertRaises(linked.PendingLinkedSource):
                builder.partition_original_sources([str(generated)], root, source, pins, unicode_files,
                    unicode, linked, licenses)

    def test_original_cmake_generated_compiler_inputs_and_source_license_relation(self):
        source = builder.original_source(archive, googletest, pins)
        members = ['CMakeLists.txt', 'config.h.in', 'src/passes/CMakeLists.txt',
                   'src/passes/WasmIntrinsics.cpp.in', 'src/passes/wasm-intrinsics.wat']
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original, directory = root / 'source', root / 'build'
            directory.mkdir()
            for member in members:
                file = original / member
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(source[member])
            (directory / 'src/passes').mkdir(parents=True)
            original_prefix = source['src/passes/CMakeLists.txt'].decode().split('FILE(GLOB passes_HEADERS *.h)', 1)[0]
            # Execute the original commands with their real -P directory
            # context and original template/data File bytes.
            (directory / 'config.h.in').write_bytes(source['config.h.in'])
            passes = directory / 'src/passes'
            for member in ['WasmIntrinsics.cpp.in', 'wasm-intrinsics.wat']:
                (passes / member).write_bytes(source['src/passes/' + member])
            script = root / 'original-reference.cmake'
            script.write_text('set(PROJECT_VERSION 117)\nconfigure_file(config.h.in config.h)\n')
            subprocess.run([str(cmake), '-P', str(script)], cwd=directory, env={'PATH': '', 'LC_ALL': 'C'}, check=True)
            script.write_text(original_prefix)
            subprocess.run([str(cmake), '-P', str(script)], cwd=passes, env={'PATH': '', 'LC_ALL': 'C'}, check=True)
            outputs = [str(directory / name) for name in ['config.h', 'src/passes/WasmIntrinsics.cpp']]
            self.assertEqual((directory / 'config.h').read_bytes(), b'#define PROJECT_VERSION "117"\n')
            selected, generated, pending_generators = builder.generated_original_sources(outputs, original, directory, source,
                pins, cmake, {'PATH': '', 'LC_ALL': 'C'}, licenses)
            self.assertEqual(set(selected), {str(original / member) for member in members})
            self.assertEqual({fact['path'] for fact in generated}, set(outputs))
            facts, notices, pending = builder.partition_original_sources(selected, original, source, pins,
                unicode_files, unicode, linked, licenses)
            self.assertFalse(pending)
            self.assertEqual({fact['component'] for fact in facts}, {'binaryen'})
            self.assertEqual(notices, {'binaryen/LICENSE': source['LICENSE']})
            self.assertEqual(pending_generators, [str(cmake)])
            with self.assertRaisesRegex(ValueError, 'lack original source/license authority'):
                builder.complete_notices({'sources': facts, 'notices': notices, 'pending': pending + pending_generators})
            unchanged = directory / 'unselected-generated.h'
            selected, generated, pending_generators = builder.generated_original_sources([str(unchanged)], original, directory,
                source, pins, cmake, {'PATH': '', 'LC_ALL': 'C'}, licenses)
            self.assertEqual(selected, (str(unchanged),))
            self.assertFalse(generated)
            self.assertFalse(pending_generators)
            for output in outputs:
                file = Path(output)
                before = file.read_bytes()
                file.write_bytes(before + b'foreign generated bytes')
                with self.subTest(output=output), self.assertRaisesRegex(ValueError, 'original producer replay'):
                    builder.generated_original_sources(outputs, original, directory, source, pins, cmake,
                        {'PATH': '', 'LC_ALL': 'C'}, licenses)
                file.write_bytes(before)
            (original / 'config.h.in').write_bytes(b'foreign template')
            with self.assertRaisesRegex(ValueError, 'generator input differs'):
                builder.generated_original_sources(outputs, original, directory, source, pins, cmake,
                    {'PATH': '', 'LC_ALL': 'C'}, licenses)

    def test_wrong_native_executor_refused_before_tools(self):
        with self.assertRaisesRegex(ValueError, 'executor differs'):
            builder.build({'platform': 'foreign'}, Path('/unused'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--googletest', type=Path, required=True)
    parser.add_argument('--builder', type=Path, required=True)
    parser.add_argument('--pins', type=Path, required=True)
    parser.add_argument('--helper', type=Path, required=True)
    parser.add_argument('--linked', type=Path, required=True)
    parser.add_argument('--sections', type=Path, required=True)
    parser.add_argument('--mapper', type=Path, required=True)
    parser.add_argument('--licenses', type=Path, required=True)
    parser.add_argument('--unicode-helper', type=Path, required=True)
    parser.add_argument('--unicode-inputs', type=Path, required=True, help='Acquired original Unicode File directory')
    parser.add_argument('--cmake', type=Path, help='Explicit declared CMake File; parse-only control')
    parser.add_argument('--compiler-products', type=Path, help='Explicit genuine native .o/.a fixture directory; retention control only')
    args = parser.parse_args()
    archive, googletest, cmake = args.archive, args.googletest, args.cmake
    compiler_products = args.compiler_products
    helper_spec = importlib.util.spec_from_file_location('declared_cmake_source_helper', args.helper)
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    def load(name, path):
        specification = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        return module
    linked, sections, mapper, licenses = [load('original_' + name, getattr(args, name)) for name in ['linked', 'sections', 'mapper', 'licenses']]
    unicode_spec = importlib.util.spec_from_file_location('original_unicode_join', args.unicode_helper)
    unicode = importlib.util.module_from_spec(unicode_spec)
    unicode_spec.loader.exec_module(unicode)
    names = {'generator': 'generator.py', 'data': 'CaseFolding.txt', 'readme': 'ReadMe.txt',
             'original_cpp': 'upstream-UnicodeCaseFold.cpp', 'terms': 'terms_of_use.html', 'license': 'unicode-license.txt'}
    unicode_files = {role: args.unicode_inputs / name for role, name in names.items()}
    pins = json.loads(args.pins.read_text())
    specification = importlib.util.spec_from_file_location('original_binaryen', args.builder)
    builder = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(builder)
    unittest.main(argv=['original-binaryen-controls'])
