"""Genuine declared compiler/link fixture controls; no original Bun runtime qualification."""

import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


class LinkedSourceControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name).resolve(strict=True)
        cls.source = cls.root / 'source'
        cls.source.mkdir()
        cls.originals = {'main.cpp': b'int retained(); int main() { return retained() - 7; }\n',
            'retained.cpp': b'#include "selected.h"\nint retained() { return SELECTED; }\n',
            'selected.h': b'#define SELECTED 7\n',
            'discarded.cpp': b'int discarded() { return 123; }\n'}
        for name, content in cls.originals.items():
            (cls.source / name).write_bytes(content)
        (cls.source / 'alias.h').symlink_to('selected.h')
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for name, content in cls.originals.items():
                member = tarfile.TarInfo('linked-source-control/' + name)
                member.size, member.mode = len(content), 0o644
                archive.addfile(member, io.BytesIO(content))
            alias = tarfile.TarInfo('linked-source-control/alias.h')
            alias.type, alias.linkname = tarfile.SYMTYPE, 'selected.h'
            archive.addfile(alias)
        cls.archive = data.getvalue()
        cls.pins = {'source': {'sha256': hashlib.sha256(cls.archive).hexdigest(),
                               'prefix': 'linked-source-control'}}
        spec = json.loads(arguments.cc_spec.read_bytes())
        root = arguments.execution_root
        cls.cc = str(root / spec['cxx'])
        if spec['cxx'] not in spec['inputs']:
            raise ValueError('Genuine fixture compiler is absent from original declared inputs')
        compile_flags = cc_helper.absolute_flags(spec['compile_flags'], root)
        link_flags = cc_helper.absolute_flags(spec['link_flags'], root)
        cls.environment = {'PATH': str(root / spec['environment']['PATH']),
            'SDKROOT': str(root / spec['environment']['SDKROOT']), 'HOME': str(cls.root),
            'ZERO_AR_DATE': '1', 'LC_ALL': 'C',
            'MERKUR_NINJA_SHELL': str(arguments.bash),
            'MERKUR_NINJA_PYTHON': str(arguments.python),
            'DYLD_FALLBACK_LIBRARY_PATH': str(arguments.nightly_manifest.absolute().parent / 'lib') + ':' + str(arguments.sdk_lib)}
        cls.build = cls.root / 'build'
        cls.build.mkdir()
        cls.database = []
        ninja = []
        for name in ('main', 'retained', 'discarded'):
            command = [cls.cc, *compile_flags, '-O0', '-g', '-fno-inline', '-MMD', '-MF',
                       name + '.d', '-c', str(cls.source / (name + '.cpp')), '-o', name + '.o']
            cls.database.append({'directory': str(cls.build), 'file': str(cls.source / (name + '.cpp')),
                                 'output': name + '.o', 'arguments': command})
            ninja += ['rule compile_' + name, '  command = ' + shlex.join(command),
                      '  depfile = ' + name + '.d', '  deps = gcc',
                      'build ' + name + '.o: compile_' + name + ' ' + str(cls.source / (name + '.cpp'))]
        cls.binary = cls.build / 'control'
        cls.map_file = cls.build / 'control.map'
        command = [cls.cc, *link_flags, '-Wl,-dead_strip', '-Wl,-map,' + str(cls.map_file),
                   'main.o', 'retained.o', 'discarded.o', '-o', str(cls.binary)]
        ninja += ['rule link', '  command = ' + shlex.join(command),
                  'build control: link main.o retained.o discarded.o', 'default control']
        (cls.build / 'build.ninja').write_text('\n'.join(ninja) + '\n')
        subprocess.run([str(arguments.ninja), '-C', str(cls.build)], env=cls.environment,
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        result = subprocess.run([str(cls.binary)], env={'PATH': ''}, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        if result.returncode != 0:
            raise ValueError('Genuine native compiler control failed its own execution: ' + result.stderr.decode())
        cls.native_bytes = cls.binary.read_bytes()
        cls.map_bytes = cls.map_file.read_bytes()
        cls.deps_bytes = subprocess.run([str(arguments.ninja), '-C', str(cls.build), '-t', 'deps'],
            env=cls.environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        if arguments.evidence is not None:
            arguments.evidence.mkdir(parents=True, exist_ok=False)
            (arguments.evidence / 'native.map').write_bytes(cls.map_bytes)
            (arguments.evidence / 'native.bin').write_bytes(cls.native_bytes)
        cls.selected = linked.macho_retained(cls.map_bytes, 'aarch64-apple-darwin',
            str(cls.binary), sections.loaded_image(cls.native_bytes), mapper)
        # Genuine cross-target compiler/lld output: parser evidence only, not
        # execution or Linux-native qualification on this Darwin machine.
        cls.elf_root = cls.root / 'elf'
        cls.elf_root.mkdir()
        elf_compile = [cls.cc, '--no-default-config', '--target=aarch64-unknown-linux-gnu',
                       '-nostdinc', '-ffunction-sections', '-g', '-O0']
        for name, content in {'start': 'extern "C" int kept(); extern "C" void start() { kept(); }',
                              'kept': 'extern "C" int kept() { return 7; }',
                              'unused': 'extern "C" int unused() { return 8; }'}.items():
            file = cls.elf_root / (name + '.cpp')
            file.write_text(content)
            subprocess.run([*elf_compile, '-c', str(file), '-o', str(cls.elf_root / (name + '.o'))],
                           env=cls.environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        cls.elf_binary = cls.elf_root / 'control'
        cls.elf_map = cls.elf_root / 'control.map'
        subprocess.run([str(arguments.elf_linker), '--gc-sections', '-e', 'start',
                        '-Map=' + str(cls.elf_map), 'start.o', 'kept.o', 'unused.o',
                        '-o', str(cls.elf_binary)], cwd=cls.elf_root, env=cls.environment,
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if arguments.evidence is not None:
            for name, value in [('native.bin', cls.native_bytes), ('native.map', cls.map_bytes),
                                ('native.ninja-deps', cls.deps_bytes),
                                ('elf.bin', cls.elf_binary.read_bytes()), ('elf.map', cls.elf_map.read_bytes()),
                                ('source.tar.gz', cls.archive),
                                ('compile_commands.json', json.dumps(cls.database).encode())]:
                (arguments.evidence / name).write_bytes(value)
            (arguments.evidence / 'pins.json').write_text(json.dumps(cls.pins))
            (arguments.evidence / 'build.ninja').write_text((cls.build / 'build.ninja').read_text())

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.own = Path(temporary.name).resolve(strict=True)
        self.source_copy = self.own / 'source'
        shutil.copytree(self.source, self.source_copy, symlinks=True)
        self.origin = linked.archive_origin('genuine-compiler-control', self.source, self.source_copy,
            self.archive, self.pins, custody, licenses)

    def selected_inputs(self):
        return linked.selected_direct_inputs(self.selected,
            linked.compiler_commands(json.dumps(self.database).encode()),
            linked.ninja_dependencies(self.deps_bytes, self.build), self.build)

    def test_genuine_make_depfiles_select_the_same_original_inputs_as_ninja(self):
        raw = []
        for entry in self.database:
            output = self.build / entry['output']
            original = output.read_bytes()
            command = [*entry['arguments'], '-MP']
            subprocess.run(command, cwd=self.build, env=self.environment, check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(output.read_bytes(), original)
            depfile = self.build / (Path(entry['output']).stem + '.d')
            raw.append(depfile.read_bytes())
        combined = b''.join(raw)
        commands = linked.compiler_commands(json.dumps(self.database).encode())
        dependencies = linked.make_dependencies(combined, self.build, commands)
        self.assertEqual(linked.selected_direct_inputs(self.selected, commands,
                         dependencies, self.build), self.selected_inputs())
        self.assertEqual(set(dependencies), set(commands))
        if arguments.evidence:
            (arguments.evidence / 'native.make-deps').write_bytes(combined)

    def test_genuine_make_filename_escapes_and_header_phony_rules(self):
        headers = ('space name.h', 'hash#name.h', 'dollar$name.h', 'colon:name.h')
        for name in headers:
            (self.own / name).write_text('#define ORIGINAL 7\n')
        source = self.own / 'original.cpp'
        source.write_text(''.join('#include "' + name + '"\n' for name in headers)
                          + 'int original() { return ORIGINAL; }\n')
        # Genuine original Clang emits a literal backslash in target identity,
        # quoted spaces/#/$ and literal non-separator colons in prerequisites.
        output, depfile = self.own / 'object\\name:#$.o', self.own / 'original.d'
        specification = json.loads(arguments.cc_spec.read_bytes())
        flags = cc_helper.absolute_flags(specification['compile_flags'], arguments.execution_root)
        command = [self.cc, *flags, '-MMD', '-MP', '-MF', str(depfile),
                   '-c', str(source), '-o', str(output)]
        subprocess.run(command, cwd=self.own, env=self.environment, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        raw = depfile.read_bytes()
        commands = linked.compiler_commands(json.dumps([{'directory': str(self.own),
            'file': str(source), 'output': str(output), 'arguments': command}]).encode())
        dependencies = linked.make_dependencies(raw, self.own, commands)
        self.assertEqual(dependencies, {str(output): [str(source),
                         *(str(self.own / name) for name in headers)]})
        self.assertIn(b'\\\n', raw)
        self.assertIn(b'\\#', raw)
        self.assertIn(b'$$', raw)
        if arguments.evidence:
            (arguments.evidence / 'escaped.make-deps').write_bytes(raw)

    def test_make_declared_object_source_and_phony_identity_refusals(self):
        commands = {str(self.own / 'original.o'): str(self.own / 'original.cpp')}
        valid = b'original.o: original.cpp selected.h\nselected.h:\n'
        self.assertEqual(linked.make_dependencies(valid, self.own, commands), {
            str(self.own / 'original.o'): [str(self.own / 'original.cpp'), str(self.own / 'selected.h')]})
        for raw in (valid.replace(b'original.o:', b'foreign.o:'),
                    valid.replace(b'original.cpp', b'foreign.cpp'),
                    valid + b'foreign.h:\n', valid + b'selected.h:\n',
                    valid + b'original.cpp:\n', valid + b'original.o:\n',
                    valid + b'original.o: original.cpp\n',
                    b'original.o alias.o: original.cpp\n',
                    b'original.o: ../original.cpp\n'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                linked.make_dependencies(raw, self.own, commands)

    def test_make_unknown_and_truncated_grammar_refuses(self):
        commands = {str(self.own / 'original.o'): str(self.own / 'original.cpp')}
        for raw in (b'', b'original.o: original.cpp', b'original.o: original.cpp \\\n',
                    b'original.o: original.cpp \\\\\n selected.h\n',
                    b'original.o: original.cpp $(HEADERS)\n',
                    b'original.o: original.cpp # foreign\n',
                    b'original.o: original.cpp ; command\n',
                    b'original.o: original.cpp | order-only.h\n',
                    b'HEADERS=selected.h\n', b'selected.h:\n',
                    b'original.o: original.cpp\x00\n',
                    b'original.o: original.cpp\rselected.h\n'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                linked.make_dependencies(raw, self.own, commands)

    def test_make_literal_escape_and_crlf_parser_boundaries(self):
        # Explicit parser boundaries, not source-build/platform qualification.
        commands = {str(self.own / 'object:name.o'): str(self.own / 'original.cpp')}
        raw = b'object\\:name.o: original.cpp \\\r\n space\\ name.h hash\\#name.h dollar$$name.h back\\\\slash.h\r\n'
        self.assertEqual(linked.make_dependencies(raw, self.own, commands), {
            str(self.own / 'object:name.o'): [str(self.own / 'original.cpp'),
                str(self.own / 'space name.h'), str(self.own / 'hash#name.h'),
                str(self.own / 'dollar$name.h'), str(self.own / 'back\\\\slash.h')]})

    def test_genuine_native_map_excludes_dead_only_object_and_binds_actual_inputs(self):
        self.assertIn('discarded.o', self.map_bytes.decode())
        self.assertEqual(set(self.selected), {'main.o', 'retained.o'})
        inputs = self.selected_inputs()
        self.assertEqual(set(inputs), {str(self.source / name) for name in ('main.cpp', 'retained.cpp', 'selected.h')})
        facts = linked.bind_original_inputs(inputs, [self.origin], licenses)
        self.assertEqual({item['path'] for item in facts}, {'main.cpp', 'retained.cpp', 'selected.h'})
        for fact in facts:
            self.assertEqual(fact['sha256'], hashlib.sha256(self.originals[fact['path']]).hexdigest())

    def test_genuine_cross_elf_map_ignores_debug_rows_and_dead_only_input(self):
        retained = linked.elf_retained(self.elf_map.read_bytes(), 'aarch64-unknown-linux-gnu',
                                      self.elf_binary.read_bytes(), sections)
        self.assertEqual(set(retained), {'start.o', 'kept.o'})

    def test_genuine_pie_elf_sections_do_not_select_debug_inputs_at_loaded_zero(self):
        binary, map_file = self.elf_root / 'pie-control', self.elf_root / 'pie-control.map'
        subprocess.run([str(arguments.elf_linker), '-pie', '--gc-sections', '-e', 'start',
                        '-Map=' + str(map_file), 'start.o', 'kept.o', 'unused.o', '-o', str(binary)],
                       cwd=self.elf_root, env=self.environment, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(set(linked.elf_retained(map_file.read_bytes(), 'aarch64-unknown-linux-gnu',
                                               binary.read_bytes(), sections)), {'start.o', 'kept.o'})
        if arguments.evidence:
            (arguments.evidence / 'pie.bin').write_bytes(binary.read_bytes())
            (arguments.evidence / 'pie.map').write_bytes(map_file.read_bytes())

    def test_changed_elf_allocated_output_section_and_missing_authority_refuse(self):
        native = self.elf_binary.read_bytes()
        raw = self.elf_map.read_bytes()
        output = next(line for line in raw.splitlines() if line[49:] == b'.text')
        size = output[34:42].strip()
        replacement = output[:34] + hex(int(size, 16) + 1)[2:].encode().rjust(8) + output[42:]
        with self.assertRaisesRegex(ValueError, 'differs from its original allocated output section'):
            linked.elf_retained(raw.replace(output, replacement), 'aarch64-unknown-linux-gnu', native, sections)
        changed = bytearray(native)
        changed[60:62] = b'\0\0'
        with self.assertRaisesRegex(ValueError, 'section-header authority'):
            linked.elf_retained(raw, 'aarch64-unknown-linux-gnu', bytes(changed), sections)

    def test_foreign_image_target_and_path_refuse(self):
        image = sections.loaded_image(self.native_bytes)
        with self.assertRaisesRegex(ValueError, 'target differs'):
            linked.macho_retained(self.map_bytes, 'x86_64-apple-darwin', str(self.binary), image, mapper)
        with self.assertRaisesRegex(ValueError, 'another original output'):
            linked.macho_retained(self.map_bytes, 'aarch64-apple-darwin', 'foreign', image, mapper)

    def test_duplicate_numeric_object_identity_refuses(self):
        # Synthetic negative mutation of a genuine map, not a positive artifact.
        raw = self.map_bytes.replace(b'# Sections:', b'[01] foreign.o\n# Sections:')
        with self.assertRaisesRegex(ValueError, 'duplicate retained object identity'):
            linked.macho_retained(raw, 'aarch64-apple-darwin', str(self.binary),
                                  sections.loaded_image(self.native_bytes), mapper)

    def test_missing_symbol_section_and_unknown_object_reference_refuse(self):
        image = sections.loaded_image(self.native_bytes)
        raw = self.map_bytes.replace(b'# Symbols:', b'# Unknown:')
        with self.assertRaises(ValueError):
            linked.macho_retained(raw, 'aarch64-apple-darwin', str(self.binary), image, mapper)
        raw = self.map_bytes.replace(b'# Dead Stripped Symbols:', b'0x100000000 0x1 [9999] foreign\n# Dead Stripped Symbols:')
        with self.assertRaisesRegex(ValueError, 'absent object identity'):
            linked.macho_retained(raw, 'aarch64-apple-darwin', str(self.binary), image, mapper)

    def test_lto_or_archive_member_never_expands_to_all_configured_sources(self):
        commands = linked.compiler_commands(json.dumps(self.database).encode())
        dependencies = linked.ninja_dependencies(self.deps_bytes, self.build)
        for record in ('control.lto.o', 'libbun_runtime.a(bun_runtime.rcgu.o)', 'libJavaScriptCore.a(UnifiedSource.o)'):
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'exact LTO/archive/source authority'):
                linked.selected_direct_inputs((record,), commands, dependencies, self.build)

    def test_missing_and_stale_compiler_dependencies_refuse(self):
        commands = linked.compiler_commands(json.dumps(self.database).encode())
        with self.assertRaisesRegex(ValueError, 'lacks actual compiler dependency facts'):
            linked.selected_direct_inputs(self.selected, commands, {}, self.build)
        with self.assertRaisesRegex(ValueError, 'absent/stale'):
            linked.ninja_dependencies(self.deps_bytes.replace(b'(VALID)', b'(STALE)'), self.build)
        with self.assertRaisesRegex(ValueError, 'count differs'):
            linked.ninja_dependencies(self.deps_bytes.replace(b'#deps 2,', b'#deps 3,'), self.build)

    def test_changed_original_selected_source_and_generated_source_refuse(self):
        (self.source_copy / 'retained.cpp').write_bytes(b'foreign same-name source')
        with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
            linked.bind_original_inputs(self.selected_inputs(), [self.origin], licenses)
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'Generated/SDK source'):
            linked.bind_original_inputs([str(self.source / 'generated.rs')], [self.origin], licenses)

    def test_changed_actual_compiler_source_presentation_refuses(self):
        file = self.source / 'retained.cpp'
        original = file.read_bytes()
        self.addCleanup(file.write_bytes, original)
        file.write_bytes(b'changed compiler-selected source presentation')
        with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
            linked.bind_original_inputs(self.selected_inputs(), [self.origin], licenses)

    def test_archive_pin_and_exact_literal_alias_custody(self):
        pins = {**self.pins, 'source': {**self.pins['source'], 'sha256': '0' * 64}}
        with self.assertRaisesRegex(ValueError, 'pinned original commit archive'):
            linked.archive_origin('control', self.source, self.source_copy, self.archive, pins, custody, licenses)
        actual = self.source / 'alias.h'
        fact = linked.bind_original_inputs([str(actual)], [self.origin], licenses)[0]
        self.assertEqual(fact['source_path'], 'selected.h')
        (self.source_copy / 'alias.h').unlink()
        (self.source_copy / 'alias.h').symlink_to('retained.cpp')
        with self.assertRaisesRegex(ValueError, 'alias differs from its original archive'):
            linked.bind_original_inputs([str(actual)], [self.origin], licenses)

    def test_ambiguous_and_missing_archive_byte_authority_refuse(self):
        with self.assertRaisesRegex(ValueError, 'ambiguous original archive authority'):
            linked.bind_original_inputs(self.selected_inputs(), [self.origin, self.origin], licenses)
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'no original archive byte authority'):
            linked.bind_original_inputs(self.selected_inputs(), [], licenses)
        with self.assertRaisesRegex(ValueError, 'exact original path'):
            linked.bind_original_inputs([str(self.source) + '/../foreign.cpp'], [self.origin], licenses)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'mapper', 'runtime_sections', 'custody', 'licenses', 'cc_helper',
                 'cc_spec', 'execution_root', 'ninja', 'bash', 'sdk_lib', 'python', 'elf_linker', 'nightly_manifest'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments, remaining = parser.parse_known_args()
    linked = load('original_bun_linked_sources', arguments.runner)
    mapper = load('original_stock_map_grammar', arguments.mapper)
    sections = load('original_mapped_image', arguments.runtime_sections)
    custody = load('original_bun_custody', arguments.custody)
    licenses = load('original_license_inputs', arguments.licenses)
    cc_helper = load('original_cc_flags', arguments.cc_helper)
    unittest.main(argv=[sys.argv[0], *remaining])
