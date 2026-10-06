"""Original nightly LLD loader controls; no native Bun runtime qualification."""

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class NightlyLoaderControls(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve(strict=True)
        self.files = [str(file.absolute()) for file in arguments.nightly.rglob('*')
                      if file.is_file() or file.is_symlink()]
        self.library = {'namespace': str(arguments.nightly),
            'root': str(arguments.nightly / 'lib'), 'files': self.files}
        self.specification = {'declared_files': self.files,
                              'runtime_library_roots': [self.library]}

    def test_actual_original_nightly_lld_missing_and_bound_library(self):
        def execute(libraries, name):
            root = self.root / name
            root.mkdir()
            environment, _ = native.environment(root, tools, '/declared-llvm', arguments.nightly,
                Path('/declared-npm-cache'), Path('/declared-sysroot'), libraries,
                '744846f844374847c902b5e7fd59b4342a51ef99', 4)
            return subprocess.run([str(arguments.linker), '--version'], env=environment,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        before = execute([arguments.sdk_lib], 'before')
        self.assertNotEqual(before.returncode, 0)
        self.assertIn(b'libLLVM.dylib', before.stderr)
        libraries = native.declared_libraries(self.specification, self.root)
        self.assertEqual(libraries, [(arguments.nightly / 'lib').resolve(strict=True)])
        after = execute([*libraries, arguments.sdk_lib], 'after')
        self.assertEqual(after.returncode, 0, after.stderr.decode())
        self.assertTrue(after.stdout.startswith(b'LLD 22.1.8 '), after.stdout.decode())
        self.assertEqual(after.stderr, b'')
        if arguments.evidence:
            for name, result in [('before', before), ('after', after)]:
                (arguments.evidence / (name + '.stdout')).write_bytes(result.stdout)
                (arguments.evidence / (name + '.stderr')).write_bytes(result.stderr)
            (arguments.evidence / 'result.json').write_text(json.dumps({
                'before': before.returncode, 'after': after.returncode,
                'linker': str(arguments.linker), 'libraries': [str(item) for item in libraries]}))

    def test_original_nightly_library_cannot_use_undeclared_payload(self):
        missing = str(arguments.nightly / 'lib/libLLVM.dylib')
        specification = {**self.specification,
            'declared_files': [file for file in self.files if file != missing]}
        with self.assertRaisesRegex(ValueError, 'absent from its declared File closure'):
            native.declared_libraries(specification, self.root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'nightly', 'linker', 'sdk_lib', 'tools'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments, remaining = parser.parse_known_args()
    arguments.nightly = arguments.nightly.absolute()
    if arguments.evidence:
        arguments.evidence.mkdir(parents=True, exist_ok=False)
    specification = importlib.util.spec_from_file_location('original_native_bun', arguments.runner)
    native = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(native)
    tools = json.loads(arguments.tools.read_bytes())
    unittest.main(argv=[sys.argv[0], *remaining])
