import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import wasm_artifacts as artifacts


class WasmArtifactsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.producer = self.root / 'producer'
        self.consumer = self.root / 'consumer'
        self.producer.mkdir()
        self.consumer.mkdir()
        self.archive = self.root / 'wasm.tar'
        for directory in artifacts.ROOTS:
            output = self.producer / directory
            output.mkdir(parents=True)
            for name in ['module.wasm', 'module.js', 'module.d.ts', 'package.json', '.merkur-build.json']:
                (output / name).write_bytes(b'fixture bytes')
        fixture = self.producer / artifacts.FIXTURE
        fixture.parent.mkdir(parents=True)
        fixture.write_bytes(b'executable')
        self.identity = patch.object(artifacts, 'identity', return_value={'commit': 'same'})
        self.identity.start()
        self.addCleanup(self.identity.stop)
        artifacts.pack(self.producer, self.archive)

    def rewrite(self, change):
        with tarfile.open(self.archive) as source:
            entries = [(member, source.extractfile(member).read()) for member in source.getmembers()]
        with tarfile.open(self.archive, 'w') as output:
            for entry, body in change(entries):
                entry.size = len(body)
                output.addfile(entry, io.BytesIO(body))

    def test_roundtrip_preserves_hidden_provenance_and_executable(self):
        artifacts.restore(self.consumer, self.archive)
        for source in self.producer.rglob('*'):
            if source.is_file():
                self.assertEqual(source.read_bytes(), (self.consumer / source.relative_to(self.producer)).read_bytes())
        self.assertEqual((self.consumer / artifacts.FIXTURE).stat().st_mode & 0o777, 0o755)

    def test_corruption_rejected_before_any_install(self):
        self.rewrite(lambda entries: [(entry, b'corrupt' if entry.name == artifacts.FIXTURE else body)
                                      for entry, body in entries])
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            artifacts.restore(self.consumer, self.archive)
        self.assertEqual(list(self.consumer.iterdir()), [])

    def test_wrong_checkout_rejected(self):
        with patch.object(artifacts, 'identity', return_value={'commit': 'other'}):
            with self.assertRaisesRegex(ValueError, 'different checkout'):
                artifacts.restore(self.consumer, self.archive)

    def test_traversal_duplicate_and_symlink_rejected(self):
        for name, link in [('../escape', False), (artifacts.MANIFEST, False), ('packages/term-wasm/pkg/link', True)]:
            artifacts.pack(self.producer, self.archive)
            entry = tarfile.TarInfo(name)
            if link:
                entry.type = tarfile.SYMTYPE
                entry.linkname = '/tmp/outside'
            self.rewrite(lambda entries: [*entries, (entry, b'')])
            with self.assertRaises(ValueError):
                artifacts.restore(self.consumer, self.archive)

    def test_incomplete_manifest_cannot_silently_drop_a_package(self):
        def remove_package(entries):
            result = []
            for entry, body in entries:
                if entry.name.startswith(artifacts.ROOTS[0] + '/'):
                    continue
                if entry.name == artifacts.MANIFEST:
                    manifest = json.loads(body)
                    manifest['files'] = {name: value for name, value in manifest['files'].items()
                                         if not name.startswith(artifacts.ROOTS[0] + '/')}
                    body = json.dumps(manifest).encode()
                result.append((entry, body))
            return result
        self.rewrite(remove_package)
        with self.assertRaisesRegex(ValueError, 'incomplete WASM'):
            artifacts.restore(self.consumer, self.archive)

    def test_destination_symlink_rejected(self):
        (self.consumer / 'packages').symlink_to(self.producer / 'packages', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            artifacts.restore(self.consumer, self.archive)


class SourceIdentityTest(unittest.TestCase):
    def test_dirty_source_is_not_attested_as_the_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', directory], check=True)
            (root / 'source').write_text('first')
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            subprocess.run(['git', '-c', 'user.name=CI', '-c', 'user.email=ci@example.test',
                            'commit', '-qm', 'fixture'], cwd=root, check=True)
            self.assertIn('commit', artifacts.identity(root))
            (root / 'source').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'dirty'):
                artifacts.identity(root)


if __name__ == '__main__':
    unittest.main()
