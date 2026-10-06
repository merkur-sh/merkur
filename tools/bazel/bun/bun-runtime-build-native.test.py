"""Real original source/tool custody controls; no native-build qualification claim."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class NativeBoundary(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve(strict=True)

    def specification(self):
        # This exercises File membership only. It does not claim that the Bun
        # executable implements Perl/CMake/etc or pass it to original configure.
        names = native.TOOLS | ({'strip'} if sys.platform == 'linux' else set())
        return {'tools': {name: str(arguments.bun) for name in names},
                'declared_files': [str(arguments.bun)]}

    def test_actual_declared_executable_file_membership(self):
        specification = self.specification()
        tools = native.declared_tools(specification, self.root)
        self.assertEqual(set(tools), set(specification['tools']))
        for value in tools.values():
            self.assertEqual(Path(value).resolve(), arguments.bun.resolve())

    def test_foreign_host_shell_refuses_before_native_engine(self):
        specification = self.specification()
        specification['tools']['bash'] = '/bin/sh'
        with self.assertRaisesRegex(ValueError, 'undeclared executable File: bash'):
            native.declared_tools(specification, self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_relative_shell_escape_refuses_before_native_engine(self):
        specification = self.specification()
        specification['tools']['bash'] = '../bin/sh'
        with self.assertRaisesRegex(ValueError, 'undeclared executable File: bash'):
            native.declared_tools(specification, self.root)

    def test_nonexecutable_declared_file_refuses(self):
        file = self.root / 'plain'
        file.write_bytes(b'not executable')
        specification = self.specification()
        specification['tools']['ninja'] = str(file)
        specification['declared_files'].append(str(file))
        with self.assertRaisesRegex(ValueError, 'not an executable File: ninja'):
            native.declared_tools(specification, self.root)

    def test_actual_output_stream_preserves_binary_mode_and_contained_alias(self):
        source = self.root / 'source'
        source.mkdir()
        shutil.copyfile(arguments.bun, source / 'bun')
        (source / 'bun').chmod(0o755)
        for name, mode in [('private-resource', 0o600), ('shared-resource', 0o640)]:
            (source / name).write_bytes(b'original build resource')
            (source / name).chmod(mode)
        (source / 'runtime').symlink_to('bun')
        destination = self.root / 'output'
        destination.mkdir()  # Actual engine precreated empty TreeArtifact shape.
        native.publish_build(source, destination, output_tree)
        with open(destination / 'bun', 'rb') as result, open(arguments.bun, 'rb') as original:
            self.assertEqual(hashlib.file_digest(result, 'sha256').hexdigest(),
                             hashlib.file_digest(original, 'sha256').hexdigest())
        self.assertEqual(stat.S_IMODE((destination / 'bun').stat().st_mode), 0o755)
        for name, mode in [('private-resource', 0o600), ('shared-resource', 0o640)]:
            self.assertEqual(stat.S_IMODE((destination / name).stat().st_mode), mode)
            self.assertEqual((destination / name).read_bytes(), (source / name).read_bytes())
        self.assertEqual(os.readlink(destination / 'runtime'), 'bun')

    def test_output_escape_refuses_and_retires_own_output(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'alias').symlink_to(arguments.bun)
        destination = self.root / 'output'
        with self.assertRaisesRegex(ValueError, 'alias escaped'):
            native.publish_build(source, destination, output_tree)
        self.assertFalse(destination.exists())

    def test_foreign_output_preserved(self):
        source = self.root / 'source'
        source.mkdir()
        destination = self.root / 'output'
        destination.mkdir()
        (destination / 'another-owner').write_bytes(b'preserve')
        with self.assertRaises(FileExistsError):
            native.publish_build(source, destination, output_tree)
        self.assertEqual((destination / 'another-owner').read_bytes(), b'preserve')

    def test_file_replacement_before_final_admission_refuses_and_preserves_foreign(self):
        source = self.root / 'source'
        source.mkdir()
        shutil.copyfile(arguments.bun, source / 'bun')
        (source / 'bun').chmod(0o755)
        destination = self.root / 'output'
        original = output_tree.OutputTree.verify
        count = 0
        def verify(tree):
            nonlocal count
            original(tree)
            count += 1
            if count == 3:
                (destination / 'bun').unlink()
                (destination / 'bun').symlink_to(arguments.bun)
        output_tree.OutputTree.verify = verify
        try:
            with self.assertRaises(BaseExceptionGroup):
                native.publish_build(source, destination, output_tree)
        finally:
            output_tree.OutputTree.verify = original
        self.assertEqual(os.readlink(destination / 'bun'), str(arguments.bun))

    def test_executable_mode_change_before_final_admission_refuses_and_retires_output(self):
        source = self.root / 'source'
        source.mkdir()
        shutil.copyfile(arguments.bun, source / 'bun')
        (source / 'bun').chmod(0o755)
        destination = self.root / 'output'
        original = output_tree.OutputTree.verify
        count = 0
        def verify(tree):
            nonlocal count
            original(tree)
            count += 1
            if count == 3:
                self.assertEqual(stat.S_IMODE((destination / 'bun').stat().st_mode), 0o755)
                (destination / 'bun').chmod(0o644)
        output_tree.OutputTree.verify = verify
        try:
            with self.assertRaisesRegex(ValueError, 'publication mode changed'):
                native.publish_build(source, destination, output_tree)
        finally:
            output_tree.OutputTree.verify = original
        self.assertFalse(destination.exists())

    def test_original_source_aliases_and_executable_semantics(self):
        source = self.root / 'source'
        pins = json.loads(arguments.pins.read_bytes())
        builder.prepare(arguments.source_archive, pins, source, custody, deployment, output_tree)
        facts = json.loads((source / 'source-inputs.json').read_bytes())['members']
        native.original_aliases(source)
        aliases = 0
        for fact in facts:
            file = source / fact['path']
            if fact['kind'] == 'symlink':
                aliases += 1
                self.assertEqual(os.readlink(file), fact['target'])
                self.assertTrue(file.resolve().is_relative_to(source))
            else:
                self.assertEqual(bool(file.stat().st_mode & 0o111), bool(fact['mode'] & 0o111))
                self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), fact['sha256'])
        self.assertEqual(aliases, 9)
        self.assertTrue((source / 'src/cli').is_dir())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'source_archive', 'pins', 'bun', 'builder', 'custody', 'deployment', 'output_tree'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    arguments, remaining = parser.parse_known_args()
    native = load('original_native_bun', arguments.runner)
    builder = load('original_bun_builder', arguments.builder)
    custody = load('original_bun_custody', arguments.custody)
    deployment = load('original_deployment', arguments.deployment)
    output_tree = load('original_output_tree', arguments.output_tree)
    unittest.main(argv=[sys.argv[0], *remaining])
