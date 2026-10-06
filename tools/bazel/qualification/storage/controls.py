"""Actual local storage controls; Darwin mounts only self-created APFS images."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("storage", Path(__file__).with_name("storage.py"))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageControls(unittest.TestCase):
    def test_original_case_distinct_names_and_exact_archive_bytes(self):
        runner = Path(tempfile.mkdtemp(prefix="merkur-storage-controls-"))
        runner = runner.resolve()
        result = storage.setup(runner, size_bytes=64 * 1024 * 1024)
        root = Path(result["outputUserRoot"])
        self.assertEqual(root.stat().st_dev, Path(result["tmpdir"]).stat().st_dev)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as stream:
            for name, payload in (("README.md", b"original uppercase contents"), ("Readme.md", b"original mixed contents")):
                item = tarfile.TarInfo(name)
                item.size = len(payload)
                stream.addfile(item, io.BytesIO(payload))
        archive.seek(0)
        with tarfile.open(fileobj=archive) as stream:
            stream.extractall(root, filter="data")
        self.assertEqual((root / "README.md").read_bytes(), b"original uppercase contents")
        self.assertEqual((root / "Readme.md").read_bytes(), b"original mixed contents")
        self.assertNotEqual((root / "README.md").stat().st_ino, (root / "Readme.md").stat().st_ino)
        storage.case_sensitive(root)
        owned = Path(result["state"]).parent
        sibling = runner / "other-session"
        sibling.mkdir()
        (sibling / "sentinel").write_bytes(b"untouched")
        storage.cleanup(result["state"])
        self.assertFalse(owned.exists())
        self.assertEqual((sibling / "sentinel").read_bytes(), b"untouched")
        shutil.rmtree(runner)

    def test_cleanup_refuses_foreign_state_without_removing_files(self):
        runner = Path(tempfile.mkdtemp(prefix="merkur-storage-controls-")).resolve()
        foreign = runner / "other-session"
        foreign.mkdir()
        state = storage.save_state(foreign, runner, sys.platform)
        with self.assertRaisesRegex(RuntimeError, "not owned"):
            storage.cleanup(state)
        self.assertTrue(state.is_file())
        shutil.rmtree(runner)

    def test_cleanup_refuses_replaced_directory_identity(self):
        runner = Path(tempfile.mkdtemp(prefix="merkur-storage-controls-")).resolve()
        owned = Path(tempfile.mkdtemp(prefix=storage.PREFIX, dir=runner))
        state = storage.save_state(owned, runner, sys.platform)
        value = json.loads(state.read_text())
        value["inode"] += 1
        state.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, "identify"):
            storage.cleanup(state)
        self.assertTrue(state.is_file())
        shutil.rmtree(runner)

    def test_setup_rejects_relative_and_missing_runner(self):
        with self.assertRaisesRegex(RuntimeError, "absolute"):
            storage.setup("relative")
        with self.assertRaisesRegex(RuntimeError, "absolute"):
            storage.setup("/merkur-storage-control-does-not-exist")

    def test_setup_rejects_unsupported_platform(self):
        with self.assertRaisesRegex(RuntimeError, "Darwin and Linux"):
            storage.setup(tempfile.gettempdir(), platform="win32")

    def test_cleanup_refuses_symlink_state(self):
        runner = Path(tempfile.mkdtemp(prefix="merkur-storage-controls-")).resolve()
        owned = Path(tempfile.mkdtemp(prefix=storage.PREFIX, dir=runner))
        state = storage.save_state(owned, runner, sys.platform)
        state.rename(owned / "foreign.json")
        state.symlink_to("foreign.json")
        with self.assertRaisesRegex(RuntimeError, "state File"):
            storage.cleanup(state)
        self.assertTrue(state.is_symlink())
        shutil.rmtree(runner)


if __name__ == "__main__":
    unittest.main()
