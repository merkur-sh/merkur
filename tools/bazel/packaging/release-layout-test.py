import hashlib
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

module = importlib.util.spec_from_file_location('layout', Path(__file__).with_name('release-layout.py'))
layout = importlib.util.module_from_spec(module)
module.loader.exec_module(layout)


def binary(path, platform):
    header = bytearray(64)
    if platform.startswith('linux-'):
        header[:7] = b'\x7fELF\x02\x01\x01'
        struct.pack_into('<HHI', header, 16, 3, 62 if platform == 'linux-x64' else 183, 1)
        struct.pack_into('<H', header, 52, 64)
    else:
        header[:4] = b'\xcf\xfa\xed\xfe'
        struct.pack_into('<I', header, 4, 0x01000007 if platform == 'darwin-x64' else 0x0100000c)
        struct.pack_into('<I', header, 12, 2)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header)
    path.chmod(0o555)


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_native_headers_and_cross_platform_rejection(self):
        for platform in layout.PLATFORMS:
            path = self.root / platform
            binary(path, platform)
            layout.native(path, platform)
            for wrong in set(layout.PLATFORMS) - {platform}:
                with self.assertRaises(ValueError):
                    layout.native(path, wrong)
        path.chmod(0o444)
        with self.assertRaises(ValueError):
            layout.native(path, platform)

    def test_daemon_exact_four_members_permissions_and_alias(self):
        for name in layout.DAEMON_FILES:
            binary(self.root / name, 'darwin-arm64')
        layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').mkdir()
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').rmdir()
        (self.root / 'merkur').chmod(0o755)
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').mkdir()
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').rmdir()
        (self.root / 'merkur').chmod(0o555)
        (self.root / 'extra').write_bytes(b'extra')
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').mkdir()
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').rmdir()
        (self.root / 'merkur').chmod(0o755)
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').mkdir()
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'empty').rmdir()
        (self.root / 'merkur').chmod(0o555)
        (self.root / 'extra').unlink()
        (self.root / 'merkur').unlink()
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')
        (self.root / 'merkur').symlink_to('merkur-tui')
        with self.assertRaises(ValueError):
            layout.daemon(self.root, 'darwin-arm64')

    def service_fixture(self):
        binary(self.root / 'server/server', 'linux-x64')
        (self.root / 'migrations').mkdir()
        for name in ('one.js', 'two.js'):
            (self.root / 'migrations' / name).write_text('export default {};')
        (self.root / 'web').mkdir()
        marker = layout.pack.canonical({'buildId': '11111111-1111-4111-8111-111111111111'})
        for name, content in [('index.html', b'<html></html>'), ('merkur-build.json', marker)]:
            (self.root / 'web' / name).write_bytes(content)
            (self.root / 'web' / (name + '.br')).write_bytes(b'compressed fixture; roundtrip requires producer qualification')

    def test_service_identity_exact_migrations_and_brotli_inventory(self):
        self.service_fixture()
        args = (self.root, '11111111-1111-4111-8111-111111111111', ['one.js', 'two.js'])
        layout.service(*args)
        with self.assertRaises(ValueError):
            layout.service(self.root, args[1], ['one.js'])
        with self.assertRaises(ValueError):
            layout.service(self.root, '22222222-2222-4222-8222-222222222222', args[2])
        marker = self.root / 'web/merkur-build.json'
        marker.write_text('{ "buildId": "11111111-1111-4111-8111-111111111111" }')
        with self.assertRaises(ValueError):
            layout.service(*args)

    def test_service_missing_additional_and_unsigned_proof_rejection(self):
        self.service_fixture()
        args = (self.root, '11111111-1111-4111-8111-111111111111', ['one.js', 'two.js'])
        compressed = self.root / 'web/index.html.br'
        compressed.unlink()
        with self.assertRaises(ValueError):
            layout.service(*args)
        compressed.write_bytes(b'fixture')
        extra = self.root / 'merkur-deployment-manifest.json'
        extra.write_bytes(b'pretend signed proof')
        with self.assertRaises(ValueError):
            layout.service(*args)

    def inventory_fixture(self):
        for name in layout.RELEASE_FILES:
            (self.root / name).unlink(missing_ok=True)
            (self.root / name).write_bytes(b'fixture bytes; archive/image qualification separate')
        for platform in layout.PLATFORMS[:2]:
            binary(self.root / ('verify-' + platform), platform)
        return {'files': [{'name': name, 'size': (self.root / name).stat().st_size,
                           'sha512': hashlib.sha512((self.root / name).read_bytes()).hexdigest()}
                          for name in sorted(layout.RELEASE_FILES)]}

    def test_ten_unsigned_artifacts_exact_bytes_and_types(self):
        manifest = self.inventory_fixture()
        self.assertEqual(len(layout.inventory(self.root, manifest)), 10)
        (self.root / 'empty').mkdir()
        with self.assertRaises(ValueError):
            layout.inventory(self.root, manifest)
        (self.root / 'empty').rmdir()
        manifest['files'][0]['size'] = True
        with self.assertRaises(ValueError):
            layout.inventory(self.root, manifest)
        manifest = self.inventory_fixture()
        (self.root / 'NOTICES.txt').write_bytes(b'changed attribution')
        with self.assertRaises(ValueError):
            layout.inventory(self.root, manifest)

    def test_unsigned_missing_extra_symlink_and_duplicate_inventory(self):
        manifest = self.inventory_fixture()
        manifest['files'].append(manifest['files'][0])
        with self.assertRaises(ValueError):
            layout.inventory(self.root, manifest)
        manifest = self.inventory_fixture()
        (self.root / 'extra').write_bytes(b'extra')
        with self.assertRaises(ValueError):
            layout.inventory(self.root, manifest)
        (self.root / 'extra').unlink()
        (self.root / 'NOTICES.txt').unlink()
        with self.assertRaises(ValueError):
            layout.inventory(self.root, manifest)
        (self.root / 'NOTICES.txt').symlink_to('deployment.tar.gz')
        with self.assertRaises(ValueError):
            layout.inventory(self.root, manifest)

    def test_layout_contract_matches_active_unsigned_consumer(self):
        contract = layout.pack.load_json(Path(__file__).with_name('release-contract.json').read_bytes())
        self.assertEqual([item['name'] for item in contract['artifacts']], sorted(layout.RELEASE_FILES))
        self.assertTrue(contract['pendingProducers'])
        self.assertTrue(contract['requiredReceipts'])
        for item in contract['artifacts']:
            if item['name'].startswith('merkur-daemon-'):
                self.assertEqual(item['inputs'], layout.DAEMON_FILES)


if __name__ == '__main__':
    unittest.main()
