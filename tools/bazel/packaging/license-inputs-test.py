"""Actual filesystem controls for declared attribution source inputs."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('license_inputs', Path(__file__).with_name('license-inputs.py'))
licenses = importlib.util.module_from_spec(spec)
spec.loader.exec_module(licenses)


class LicenseInputs(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def test_complete_bytes_and_declared_nested_file(self):
        (self.root / 'LICENSE').write_bytes(b'published license\r\n')
        (self.root / 'NOTICE').write_bytes(b'published attribution\n')
        (self.root / 'legal').mkdir()
        (self.root / 'legal' / 'COPYING.txt').write_bytes(b'explicit license\n')
        texts = licenses.collect(self.root, 'legal/COPYING.txt')
        self.assertEqual([x['path'] for x in texts], ['LICENSE', 'NOTICE', 'legal/COPYING.txt'])
        self.assertEqual(texts[0]['text'], 'published license\r\n')
        self.assertEqual(texts[0]['size'], 19)
        self.assertEqual(licenses.collect(self.root, 'legal/COPYING.txt'), texts)

    def test_missing_empty_malformed_and_alias_fail_closed(self):
        with self.assertRaises(ValueError): licenses.collect(self.root)
        (self.root / 'LICENSE').write_bytes(b'')
        with self.assertRaises(ValueError): licenses.collect(self.root)
        (self.root / 'LICENSE').write_bytes(b'\xff')
        with self.assertRaises(UnicodeDecodeError): licenses.collect(self.root)
        (self.root / 'LICENSE').unlink()
        (self.root / 'real').write_bytes(b'real text')
        (self.root / 'LICENSE').symlink_to('real')
        with self.assertRaises(ValueError): licenses.collect(self.root)
        (self.root / 'LICENSE').unlink()
        (self.root / 'LICENSE').write_bytes(b'real text')
        with self.assertRaises(FileNotFoundError): licenses.collect(self.root, 'missing')
        for name in ['../real', '/real', 'legal/../real', 'legal//real', 'legal\\real', 'a\n']:
            with self.assertRaises(ValueError): licenses.collect(self.root, name)

    def test_nested_and_package_directory_aliases_denied(self):
        (self.root / 'physical').mkdir()
        (self.root / 'physical' / 'text').write_bytes(b'text')
        (self.root / 'alias').symlink_to('physical', target_is_directory=True)
        with self.assertRaises(OSError): licenses.collect(self.root, 'alias/text')
        with self.assertRaises(ValueError): licenses.collect(self.root / 'alias', 'text')
        (self.root / 'LICENSE-directory').mkdir()
        with self.assertRaises(ValueError): licenses.collect(self.root)

    def test_additions_and_changed_bytes_are_observed(self):
        (self.root / 'LICENSE').write_bytes(b'first')
        first = licenses.collect(self.root)
        (self.root / 'LICENSE').write_bytes(b'next')
        second = licenses.collect(self.root)
        self.assertNotEqual(first[0]['sha256'], second[0]['sha256'])
        (self.root / 'NOTICE').write_bytes(b'attribution')
        self.assertEqual(len(licenses.collect(self.root)), 2)

    def test_parent_replaced_between_admission_and_read(self):
        (self.root / 'legal').mkdir()
        (self.root / 'legal' / 'text').write_bytes(b'declared')
        (self.root / 'outside').mkdir()
        (self.root / 'outside' / 'text').write_bytes(b'undeclared')
        original = licenses.os.open
        def redirected(path, flags, **kwargs):
            if path == 'text':
                (self.root / 'legal').rename(self.root / 'previous')
                (self.root / 'legal').symlink_to('outside', target_is_directory=True)
            return original(path, flags, **kwargs)
        with patch.object(licenses.os, 'open', redirected):
            with self.assertRaises(ValueError): licenses.collect(self.root, 'legal/text')

    def test_sibling_addition_and_already_read_text_replacement_reject(self):
        (self.root / 'LICENSE').write_bytes(b'original')
        original = licenses.read_regular
        def add_notice(root, name):
            (root / 'NOTICE').write_bytes(b'new mandatory notice')
            return original(root, name)
        with patch.object(licenses, 'read_regular', add_notice):
            with self.assertRaises(ValueError): licenses.collect(self.root)
        def replace_earlier(root, name):
            if name == 'NOTICE':
                (root / 'LICENSE').write_bytes(b'replaced')
            return original(root, name)
        with patch.object(licenses, 'read_regular', replace_earlier):
            with self.assertRaises(ValueError): licenses.collect(self.root)


if __name__ == '__main__':
    unittest.main()
