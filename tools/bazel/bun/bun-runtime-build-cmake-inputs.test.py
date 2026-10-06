"""Original CMake same-build metadata controls; no native Bun source completeness claim."""

import argparse
import importlib.util
import json
from pathlib import Path
import shlex
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


class CmakeCompilerInputs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name).resolve(strict=True)
        cls.source, cls.build = cls.root / 'source with spaces', cls.root / 'build with spaces'
        cls.source.mkdir()
        (cls.source / 'main.cpp').write_text('#include "selected.h"\nint main() { return RESULT; }\n')
        (cls.source / 'selected.h').write_text('#define RESULT 0\n')
        (cls.source / 'CMakeLists.txt').write_text('cmake_minimum_required(VERSION 4.0)\nproject(source_control LANGUAGES CXX)\nadd_executable(control main.cpp)\n')
        spec = json.loads(arguments.cc_spec.read_bytes())
        execution = arguments.execution_root
        if spec['cxx'] not in spec['inputs']:
            raise ValueError('Actual fixture compiler is not an original declared input')
        compile_flags = cc_helper.absolute_flags(spec['compile_flags'], execution)
        link_flags = cc_helper.absolute_flags(spec['link_flags'], execution)
        cls.map = cls.build / 'control.map'
        tools = json.loads(arguments.tools.read_bytes())
        cls.environment, _ = native.environment(cls.root, tools, '/declared-llvm', arguments.nightly,
            Path('/declared-npm'), execution / spec['environment']['SDKROOT'],
            [arguments.cmake_sdk / 'lib', arguments.bash_sdk / 'lib', arguments.nightly / 'lib'],
            '744846f844374847c902b5e7fd59b4342a51ef99', 4)
        cls.configure = [str(arguments.cmake_sdk / 'bin/cmake'), '-S', str(cls.source), '-B', str(cls.build),
            '-DCMAKE_CXX_COMPILER=' + str(execution / spec['cxx']),
            '-DCMAKE_CXX_FLAGS_INIT=' + shlex.join(compile_flags),
            '-DCMAKE_EXE_LINKER_FLAGS_INIT=' + shlex.join([*link_flags, '-Wl,-dead_strip', '-Wl,-map,' + str(cls.map)])]
        before_environment = {key: value for key, value in cls.environment.items() if key != 'CMAKE_EXPORT_COMPILE_COMMANDS'}
        logs = {}
        def run(name, argv, environment):
            result = subprocess.run(argv, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            logs[name] = {'argv': argv, 'exit': result.returncode,
                          'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()}
            if result.returncode:
                raise ValueError('Actual original CMake fixture failed: ' + json.dumps(logs[name]))
            return result.stdout
        run('configure_before', cls.configure, before_environment)
        run('build_before', [tools['ninja'], '-C', str(cls.build)], before_environment)
        cls.binary = cls.build / 'control'
        before_bytes = cls.binary.read_bytes()
        if (cls.build / 'compile_commands.json').exists():
            raise ValueError('Absent original CMake export unexpectedly produced compiler metadata')
        run('execute_before', [str(cls.binary)], before_environment)
        # CMake reads the environment only when the original cache entry is
        # initialized; immutable native actions always start a fresh build tree.
        # Reset this fixture's own cache while retaining its compiled outputs to
        # prove that metadata initialization leaves the original flags intact.
        (cls.build / 'CMakeCache.txt').unlink()
        run('configure_after', cls.configure, cls.environment)
        # Original CMake compiler detection also uses the exact linker flags
        # and overwrites this fixture's map. Relink the retained original object
        # so the final map and actual native image come from the same link.
        cls.binary.unlink()
        build_output = run('build_after', [tools['ninja'], '-C', str(cls.build)], cls.environment)
        if b'Building CXX object' in build_output or cls.binary.read_bytes() != before_bytes:
            raise ValueError('Metadata-only original CMake export changed actual compiled output')
        run('execute_after', [str(cls.binary)], cls.environment)
        cls.commands = (cls.build / 'compile_commands.json').read_bytes()
        cls.deps = run('deps', [tools['ninja'], '-C', str(cls.build), '-t', 'deps'], cls.environment)
        if arguments.evidence:
            arguments.evidence.mkdir(parents=True, exist_ok=False)
            (arguments.evidence / 'native.map').write_bytes(cls.map.read_bytes())
            (arguments.evidence / 'build.ninja').write_bytes((cls.build / 'build.ninja').read_bytes())
        cls.retained = linked.macho_retained(cls.map.read_bytes(), 'aarch64-apple-darwin',
            cls.binary.name, sections.loaded_image(before_bytes), mapper)
        if arguments.evidence:
            (arguments.evidence / 'result.json').write_text(json.dumps(logs, indent=2))
            for name, value in [('native.bin', before_bytes), ('native.map', cls.map.read_bytes()),
                                ('compile_commands.json', cls.commands), ('ninja-deps', cls.deps)]:
                (arguments.evidence / name).write_bytes(value)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_genuine_cmake_posix_command_and_exact_compiler_inputs(self):
        values = json.loads(self.commands)
        self.assertIn('command', values[0])
        self.assertNotIn('arguments', values[0])
        inputs = linked.selected_direct_inputs(self.retained, linked.compiler_commands(self.commands),
            linked.ninja_dependencies(self.deps, self.build), self.build)
        self.assertEqual(set(inputs), {str(self.source / 'main.cpp'), str(self.source / 'selected.h')})
        self.assertEqual(self.environment['CMAKE_EXPORT_COMPILE_COMMANDS'], 'ON')

    def test_changed_cmake_source_output_relation_refuses(self):
        for key in ('file', 'output'):
            values = json.loads(self.commands)
            values[0][key] = '/foreign/' + key
            with self.assertRaisesRegex(ValueError, 'differs from declared source/output relation'):
                linked.compiler_commands(json.dumps(values).encode())

    def test_ambiguous_command_forms_and_missing_compile_flag_refuse(self):
        values = json.loads(self.commands)
        values[0]['arguments'] = shlex.split(values[0]['command'])
        with self.assertRaisesRegex(ValueError, 'ambiguous argument forms'):
            linked.compiler_commands(json.dumps(values).encode())
        values = json.loads(self.commands)
        values[0]['command'] = values[0]['command'].replace(' -c ', ' -E ')
        with self.assertRaisesRegex(ValueError, 'flag relation is ambiguous'):
            linked.compiler_commands(json.dumps(values).encode())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'native', 'mapper', 'runtime_sections', 'cc_helper', 'cc_spec',
                 'execution_root', 'cmake_sdk', 'bash_sdk', 'nightly', 'tools'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments, remaining = parser.parse_known_args()
    linked = load('original_linked_sources', arguments.runner)
    native = load('original_native_builder', arguments.native)
    mapper = load('original_stock_map_grammar', arguments.mapper)
    sections = load('original_mapped_image', arguments.runtime_sections)
    cc_helper = load('original_declared_cc_flags', arguments.cc_helper)
    unittest.main(argv=[sys.argv[0], *remaining])
