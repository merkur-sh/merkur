"""Genuine declared static archive retained-member controls; no Bun LTO completeness claim."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module



class ArchiveSourceControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source_controls.LinkedSourceControls.setUpClass()
        cls.fixture = source_controls.LinkedSourceControls
        fixture = cls.fixture
        spec = json.loads(arguments.cc_spec.read_bytes())
        if str(arguments.archiver.relative_to(arguments.execution_root)) not in spec['inputs']:
            raise ValueError('Genuine archiver is absent from actual declared compiler SDK Files')
        cls.archive = fixture.build / 'retained-library.a'
        subprocess.run([str(arguments.archiver), 'rcs', str(cls.archive), 'retained.o', 'discarded.o'],
            cwd=fixture.build, env=fixture.environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        cls.binary, cls.map = fixture.build / 'archived-control', fixture.build / 'archived-control.map'
        flags = source_controls.cc_helper.absolute_flags(spec['link_flags'], arguments.execution_root)
        subprocess.run([fixture.cc, *flags, '-Wl,-dead_strip', '-Wl,-map,' + str(cls.map),
                        'main.o', cls.archive.name, '-o', str(cls.binary)], cwd=fixture.build,
                       env=fixture.environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run([str(cls.binary)], env={'PATH': ''}, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        cls.retained = linked.macho_retained(cls.map.read_bytes(), 'aarch64-apple-darwin',
            str(cls.binary), source_controls.sections.loaded_image(cls.binary.read_bytes()), source_controls.mapper)
        cls.commands = linked.compiler_commands(json.dumps(fixture.database).encode())
        cls.dependencies = linked.ninja_dependencies(fixture.deps_bytes, fixture.build)
        cls.archives = {str(cls.archive): cls.archive.read_bytes()}
        if arguments.evidence:
            for name, value in [('retained-library.a', cls.archive.read_bytes()),
                                ('archived-control', cls.binary.read_bytes()), ('archived-control.map', cls.map.read_bytes())]:
                (arguments.evidence / name).write_bytes(value)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.tearDownClass()

    def selected(self, retained=None, commands=None, archives=None):
        return linked.selected_archive_inputs(self.retained if retained is None else retained,
            self.commands if commands is None else commands, self.dependencies, self.fixture.build,
            self.archives if archives is None else archives, source_controls.mapper, source_controls.licenses)

    def test_genuine_retained_member_omits_unselected_archive_source(self):
        members = source_controls.mapper.archive_members(self.archive.read_bytes())
        self.assertIn('discarded.o', members)
        self.assertEqual(set(self.retained), {'main.o', 'retained-library.a(retained.o)'})
        self.assertEqual(set(self.selected()), {str(self.fixture.source / name)
            for name in ('main.cpp', 'retained.cpp', 'selected.h')})
        origin = linked.archive_origin('genuine-archive-compiler-control', self.fixture.source,
            self.fixture.source, self.fixture.archive, self.fixture.pins, source_controls.custody, source_controls.licenses)
        facts = linked.bind_original_inputs(self.selected(), [origin], source_controls.licenses)
        self.assertEqual({item['path'] for item in facts}, {'main.cpp', 'retained.cpp', 'selected.h'})
        for name, fact in members.items():
            self.assertEqual(fact['sha256'], hashlib.sha256((self.fixture.build / name).read_bytes()).hexdigest())

    def test_unbuilt_configured_target_is_not_a_selected_source(self):
        commands = {**self.commands, str(self.fixture.build / 'unbuilt.o'):
                    str(self.fixture.source / 'discarded.cpp')}
        self.assertEqual(self.selected(commands=commands), self.selected())

    def test_missing_and_changed_original_archive_authority_refuse(self):
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'same-build File'):
            self.selected(archives={})
        with self.assertRaisesRegex(ValueError, 'differs from its original same-build bytes'):
            self.selected(archives={str(self.archive): b'foreign archive'})
        with self.assertRaisesRegex(ValueError, 'absent from its original archive'):
            self.selected(retained=('retained-library.a(foreign.o)',))

    def test_changed_or_ambiguous_actual_compiler_object_authority_refuses(self):
        object_file = self.fixture.build / 'retained.o'
        original = object_file.read_bytes()
        self.addCleanup(object_file.write_bytes, original)
        object_file.unlink()
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'unique original compiler object authority'):
            self.selected()
        object_file.write_bytes(b'foreign same-name object')
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'unique original compiler object authority'):
            self.selected()
        object_file.write_bytes(original)
        duplicate = self.fixture.build / 'duplicate.o'
        duplicate.write_bytes(original)
        self.addCleanup(duplicate.unlink)
        commands = {**self.commands, str(duplicate): str(self.fixture.source / 'discarded.cpp')}
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'unique original compiler object authority'):
            self.selected(commands=commands)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'source_controls', 'archiver', 'mapper', 'runtime_sections', 'custody', 'licenses',
                 'cc_helper', 'cc_spec', 'execution_root', 'ninja', 'bash', 'sdk_lib', 'python', 'elf_linker', 'nightly_manifest'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments, remaining = parser.parse_known_args()
    linked = load('original_linked_archive_sources', arguments.runner)
    source_controls = load('original_linked_source_controls', arguments.source_controls)
    source_controls.arguments = arguments
    source_controls.linked = linked
    for name, argument in [('mapper', 'mapper'), ('sections', 'runtime_sections'), ('custody', 'custody'),
                           ('licenses', 'licenses'), ('cc_helper', 'cc_helper')]:
        setattr(source_controls, name, load('archive_control_' + name, getattr(arguments, argument)))
    unittest.main(argv=[sys.argv[0], *remaining])
