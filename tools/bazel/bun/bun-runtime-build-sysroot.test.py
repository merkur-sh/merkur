"""Actual original Darwin SDK File namespace controls, not platform qualification."""
import argparse
import importlib.util
import json
from pathlib import Path
import unittest


class OriginalSysrootFiles(unittest.TestCase):
    def specification(self):
        return {'declared_files': list(files), 'sysroot_files': list(files),
                'sysroot_namespace': str(arguments.sdk_root),
                'sysroot': str(arguments.sdk_root / original['sysroot'])}

    def test_actual_original_all_members_and_directory_aliases(self):
        specification = self.specification()
        result = native.declared_directory(specification, Path.cwd(), 'sysroot')
        self.assertEqual(result, (arguments.sdk_root / original['sysroot']).resolve(strict=True))
        aliases = [arguments.sdk_root / fact['path'] for fact in inventory if fact['kind'] == 'symlink']
        self.assertTrue(aliases)
        self.assertTrue(any(file.is_dir() for file in aliases))
        self.assertTrue(any(file.is_symlink() for file in aliases))
        self.assertTrue((result / 'SDKSettings.json').is_file())

    def test_original_member_cannot_be_omitted_from_action_inputs(self):
        specification = self.specification()
        specification['declared_files'].remove(files[0])
        with self.assertRaisesRegex(ValueError, 'absent from its declared File closure'):
            native.declared_directory(specification, Path.cwd(), 'sysroot')

    def test_foreign_sysroot_cannot_use_original_namespace_authority(self):
        specification = self.specification()
        specification['sysroot'] = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'
        with self.assertRaisesRegex(ValueError, 'exact declared sysroot namespace'):
            native.declared_directory(specification, Path.cwd(), 'sysroot')

    def test_directory_cannot_be_invented_as_an_original_member_file(self):
        specification = self.specification()
        specification['sysroot_files'].append(specification['sysroot'])
        specification['declared_files'].append(specification['sysroot'])
        with self.assertRaisesRegex(ValueError, 'fabricated member File'):
            native.declared_directory(specification, Path.cwd(), 'sysroot')

    def test_duplicate_original_member_refuses(self):
        specification = self.specification()
        specification['sysroot_files'].append(files[0])
        with self.assertRaisesRegex(ValueError, 'exact declared sysroot namespace'):
            native.declared_directory(specification, Path.cwd(), 'sysroot')


class OriginalNightlyFiles(unittest.TestCase):
    def specification(self):
        return {'declared_files': list(nightly_files), 'nightly_files': list(nightly_files),
                'nightly_namespace': str(arguments.nightly_root),
                'nightly': str(arguments.nightly_root)}

    def test_actual_original_complete_sdk_directory(self):
        result = native.declared_directory(self.specification(), Path.cwd(), 'nightly')
        self.assertEqual(result, arguments.nightly_root.resolve(strict=True))
        self.assertTrue((result / 'bin/rustc').is_file())
        self.assertTrue((result / 'bin/cargo').is_file())
        self.assertTrue((result / 'bin/rustc').stat().st_mode & 0o111)
        self.assertEqual(json.loads((result / 'sdk-payload.json').read_bytes()), nightly)

    def test_missing_original_nightly_file_refuses(self):
        specification = self.specification()
        specification['declared_files'].remove(nightly_files[0])
        with self.assertRaisesRegex(ValueError, 'absent from its declared File closure'):
            native.declared_directory(specification, Path.cwd(), 'nightly')

    def test_foreign_file_cannot_join_original_nightly_namespace(self):
        specification = self.specification()
        specification['nightly_files'].append(files[0])
        specification['declared_files'].append(files[0])
        with self.assertRaisesRegex(ValueError, 'absent from its declared File closure'):
            native.declared_directory(specification, Path.cwd(), 'nightly')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'sdk_root', 'sdk_specification', 'sdk_members', 'nightly_root'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    arguments, remaining = parser.parse_known_args()
    module = importlib.util.spec_from_file_location('original_native_bun', arguments.runner)
    native = importlib.util.module_from_spec(module)
    module.loader.exec_module(native)
    original = json.loads(arguments.sdk_specification.read_bytes())
    inventory = json.loads(arguments.sdk_members.read_bytes())
    files = [str(arguments.sdk_root / fact['path']) for fact in inventory]
    nightly = json.loads((arguments.nightly_root / 'sdk-payload.json').read_bytes())
    nightly_files = [str(arguments.nightly_root / fact['path']) for fact in nightly['files']]
    nightly_files.append(str(arguments.nightly_root / 'sdk-payload.json'))
    unittest.main(argv=['original-sysroot-test', *remaining])
