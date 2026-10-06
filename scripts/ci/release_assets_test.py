import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from release_assets import extract, inventory, validate_unsigned


class ArtifactTests(unittest.TestCase):
    def test_unsigned_inventory_refuses_missing_extra_and_symlink_assets(self):
        names = ['deployment.tar.gz', 'edge-image.tar.gz', 'stun-image.tar.gz', 'NOTICES.txt',
                 'merkur-daemon-linux-x64.tar.gz', 'merkur-daemon-linux-arm64.tar.gz',
                 'merkur-daemon-darwin-x64.tar.gz', 'merkur-daemon-darwin-arm64.tar.gz',
                 'verify-linux-x64', 'verify-linux-arm64']
        with tempfile.TemporaryDirectory() as temp:
            for name in names: Path(temp, name).write_bytes(b'asset')
            validate_unsigned(temp)
            extra = Path(temp, 'unexpected')
            extra.write_bytes(b'extra')
            with self.assertRaises(ValueError): validate_unsigned(temp)
            extra.unlink()
            missing = Path(temp, names[0])
            missing.unlink()
            with self.assertRaises(ValueError): validate_unsigned(temp)
            missing.symlink_to(names[1])
            with self.assertRaises(ValueError): validate_unsigned(temp)

    def test_extract_refuses_links_and_traversal(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE), ('server', tarfile.SYMTYPE)]:
            with tempfile.TemporaryDirectory() as temp:
                archive = Path(temp, 'bad.tar.gz')
                with tarfile.open(archive, 'w:gz') as tar:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    info.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                    tar.addfile(info, io.BytesIO())
                with self.assertRaises(ValueError): extract(archive, Path(temp, 'out'))

    def test_inventory_binds_bytes_not_timestamps(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp, 'binary')
            file.write_bytes(b'original')
            before = inventory(temp)
            file.write_bytes(b'changed!')
            self.assertNotEqual(before, inventory(temp))
