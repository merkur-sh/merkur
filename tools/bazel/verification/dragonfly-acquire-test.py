"""Controls using the unchanged publisher Dragonfly and Ubuntu archives."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def load(name, file):
    specification = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class OriginalArchiveControls(unittest.TestCase):
    def test_complete_original_runtime_and_licenses(self):
        for platform, specification in specifications.items():
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                members = producer.acquire(specification, directory, elf.elf_loads)
                root = Path(directory)
                original = producer.tar_members(Path(specification['archives'][0]['path']).read_bytes())
                self.assertEqual((root / 'bin/dragonfly').read_bytes(), original[specification['binary']][0])
                loader = Path(specification['interpreter']).name
                self.assertEqual((root / ('bin/' + loader)).read_bytes(), (root / ('lib/' + loader)).read_bytes())
                self.assertEqual(len([name for name in members if name.startswith('licenses/')]), 4)
                for member in members:
                    self.assertFalse((root / member).is_symlink())
                    if member.startswith('licenses/'):
                        self.assertGreater((root / member).stat().st_size, 100)
                    else:
                        image = elf.elf_loads((root / member).read_bytes(), specification['cpu'])
                        self.assertFalse(image['rpaths'])
                        self.assertTrue(all('lib/' + name in members for name in image['dependencies']))

    def test_changed_archive_never_materializes(self):
        for specification in specifications.values():
            altered = copy.deepcopy(specification)
            altered['archives'][0]['sha256'] = '0' * 64
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                    producer.acquire(altered, directory, elf.elf_loads)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_missing_runtime_archive_is_not_an_ambient_fallback(self):
        for specification in specifications.values():
            for removed in ['libc6', 'zlib1g', 'libgcc-s1', 'gcc-14-base']:
                altered = copy.deepcopy(specification)
                altered['archives'] = [archive for archive in altered['archives'] if archive['name'] != removed]
                with self.subTest(removed=removed), tempfile.TemporaryDirectory() as directory:
                    with self.assertRaisesRegex(ValueError, 'complete declared'):
                        producer.acquire(altered, directory, elf.elf_loads)
                    self.assertEqual(list(Path(directory).iterdir()), [])

    def test_wrong_machine_or_interpreter_is_rejected_before_output(self):
        for specification in specifications.values():
            for field, value in [('cpu', 183 if specification['cpu'] == 62 else 62), ('interpreter', '/ambient/loader')]:
                altered = copy.deepcopy(specification)
                altered[field] = value
                with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                    with self.assertRaises(ValueError):
                        producer.acquire(altered, directory, elf.elf_loads)
                    self.assertEqual(list(Path(directory).iterdir()), [])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--producer', required=True)
    parser.add_argument('--elf-parser', required=True)
    parser.add_argument('--pins', required=True)
    parser.add_argument('--archives', required=True, help='Directory of exact original named archives')
    args = parser.parse_args()
    global producer, elf, specifications
    producer = load('dragonfly_acquisition', args.producer)
    elf = load('declared_original_elf', args.elf_parser)
    pins = json.loads(Path(args.pins).read_text())
    specifications = copy.deepcopy(pins['platforms'])
    for specification in specifications.values():
        for archive in specification['archives']:
            archive['path'] = str(Path(args.archives) / archive['archive'])
            if hashlib.sha256(Path(archive['path']).read_bytes()).hexdigest() != archive['sha256']:
                raise ValueError('test input differs from exact original publisher archive')
    unittest.main(argv=['dragonfly-acquire-test'])


if __name__ == '__main__':
    main()
