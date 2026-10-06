"""Genuine original SDK loader namespace controls; not a Bun native runtime qualification."""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


def load(path):
    specification = importlib.util.spec_from_file_location('original_native_bun', path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class RuntimeLibraries(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve(strict=True)
        self.files = [file.absolute() for file in arguments.sdk.rglob('*')
                      if file.is_file() or file.is_symlink()]
        self.specification = {'declared_files': [str(file) for file in self.files],
            'runtime_library_roots': [{'namespace': str(arguments.sdk),
                'root': str(arguments.sdk / 'lib'), 'files': [str(file) for file in self.files]}]}

    def test_actual_sdk_namespace_closes_original_bash_loader_failure(self):
        libraries = native.declared_libraries(self.specification, self.root)
        self.assertEqual(libraries, [(arguments.sdk / 'lib').resolve(strict=True)])
        tools = {'bash': str(arguments.bash), 'python': str(arguments.python),
                 'ninja': str(arguments.ninja), 'uname': str(arguments.uname),
                 'env': str(arguments.env)}
        def run(library_roots, name):
            root = self.root / name
            root.mkdir()
            environment, _ = native.environment(root, tools, '/declared-llvm', Path('/declared-nightly'),
                Path('/declared-npm-cache'), Path('/declared-sysroot'), library_roots,
                '744846f844374847c902b5e7fd59b4342a51ef99', 4)
            return subprocess.run([str(root / 'bin/sh'), '-c', 'env -i MERKUR_REAL_SHELL=original env'],
                                  env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        before = run([], 'before')
        self.assertNotEqual(before.returncode, 0)
        self.assertIn(b'libtinfo', before.stderr)
        after = run(libraries, 'after')
        self.assertEqual(after.returncode, 0, after.stderr.decode())
        self.assertEqual(after.stdout, b'MERKUR_REAL_SHELL=original\n')
        self.assertEqual(after.stderr, b'')

    def test_undeclared_library_member_refuses(self):
        specification = {**self.specification, 'declared_files': self.specification['declared_files'][1:]}
        with self.assertRaisesRegex(ValueError, 'absent from its declared File closure'):
            native.declared_libraries(specification, self.root)

    def test_foreign_library_namespace_refuses(self):
        specification = {**self.specification, 'runtime_library_roots': [
            {**self.specification['runtime_library_roots'][0], 'root': '/usr/lib'}]}
        with self.assertRaisesRegex(ValueError, 'exact declared runtime_library namespace'):
            native.declared_libraries(specification, self.root)

    def test_duplicate_library_members_refuse(self):
        library = self.specification['runtime_library_roots'][0]
        specification = {**self.specification, 'runtime_library_roots': [
            {**library, 'files': [*library['files'], library['files'][0]]}]}
        with self.assertRaisesRegex(ValueError, 'exact declared runtime_library namespace'):
            native.declared_libraries(specification, self.root)

    def test_directory_sdk_library_selection_only_uses_declared_tree(self):
        # Explicit directory-shaped unit control, not an original SDK provider.
        sdk = self.root / 'sdk-tree'
        (sdk / 'lib').mkdir(parents=True)
        specification = {'declared_files': [str(sdk)], 'runtime_library_roots': [
            {'namespace': str(sdk), 'root': str(sdk / 'lib'), 'files': [str(sdk)]}]}
        self.assertEqual(native.declared_libraries(specification, self.root), [sdk / 'lib'])
        (sdk / 'lib').rmdir()
        (sdk / 'lib').symlink_to(arguments.sdk / 'lib', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'escaped its original declared namespace'):
            native.declared_libraries(specification, self.root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'sdk', 'bash', 'env', 'ninja', 'uname', 'python'):
        parser.add_argument('--' + name, type=Path, required=True)
    arguments, remaining = parser.parse_known_args()
    arguments.sdk = arguments.sdk.absolute()
    native = load(arguments.runner)
    unittest.main(argv=[sys.argv[0], *remaining])
