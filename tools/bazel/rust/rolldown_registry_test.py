"""Archive acquisition and existing native SDK registry boundary controls."""

import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


registry = load("rolldown_registry", ROOT / "rolldown_registry.py")
producer = load("registry_producer", ROOT / "acquire/sdk_producer.py")
sdk = load("registry_sdk", ROOT / "acquisition_sdk.py")


def crate(extra=None, identity="fixture"):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        contents = {"fixture-1.2.3/Cargo.toml": ('[package]\nname="' + identity + '"\nversion="1.2.3"\n').encode(),
                    "fixture-1.2.3/src/lib.rs": b"pub fn fixture() {}\n"}
        for name, data in contents.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(data))
        if extra is not None:
            entry, data = extra
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


def lock_for(data):
    return ('[[package]]\nname="workspace"\nversion="0.1.0"\n'
            '[[package]]\nname="fixture"\nversion="1.2.3"\nsource="' + registry.REGISTRY +
            '"\nchecksum="' + hashlib.sha256(data).hexdigest() + '"\n').encode()


class RegistryTests(unittest.TestCase):
    def test_original_bytes_complete_registry_and_existing_sdk_boundary(self):
        data = crate()
        lock = lock_for(data)
        packages = registry.locked_packages(lock)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            urls = []

            def fetch(url):
                urls.append(url)
                return data

            result = registry.acquire_packages(packages, output, producer, fetch=fetch)
            self.assertEqual(urls, ["https://static.crates.io/crates/fixture/fixture-1.2.3.crate"])
            self.assertEqual((output / "originals/fixture-1.2.3.crate").read_bytes(), data)
            self.assertEqual(len(result["registry"]["files"]), 3)
            lock_path = output / "Cargo.lock"
            lock_path.write_bytes(lock)
            boundary = object.__new__(sdk.NativeCargoSdk)
            boundary.descriptor = {"registry": result["registry"]}
            boundary.lock_paths = [lock_path]
            boundary._verify_registry()
            # No partial closure or hidden added source is admissible.
            boundary.descriptor["registry"]["packages"] = []
            with self.assertRaisesRegex(ValueError, "complete locked source closure"):
                boundary._verify_registry()
            boundary.descriptor["registry"]["packages"] = packages
            (output / "registry/fixture-1.2.3/hidden.rs").write_text("unlisted")
            with self.assertRaisesRegex(ValueError, "File membership changed"):
                boundary._verify_registry()

    def test_mismatching_download_is_not_preserved_or_published(self):
        packages = registry.locked_packages(lock_for(crate()))
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            with self.assertRaisesRegex(ValueError, "original lock checksum"):
                registry.acquire_packages(packages, output, producer, fetch=lambda _: b"changed")
            self.assertEqual(list((output / "originals").iterdir()), [])
            self.assertFalse((output / "registry").exists())

    def test_preserved_archive_mismatch_and_alias_are_rejected(self):
        data = crate()
        packages = registry.locked_packages(lock_for(data))
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            originals = output / "originals"
            originals.mkdir()
            archive = originals / "fixture-1.2.3.crate"
            archive.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "preserved original differs"):
                registry.acquire_packages(packages, output, producer, fetch=lambda _: data)
            archive.unlink()
            target = output / "target.crate"
            target.write_bytes(data)
            archive.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                registry.acquire_packages(packages, output, producer, fetch=lambda _: data)

    def test_original_unsafe_members_are_rejected_before_materialization(self):
        entries = []
        escaping = tarfile.TarInfo("fixture-1.2.3/../escaped")
        escaping.size = 1
        entries.append((escaping, b"x"))
        link = tarfile.TarInfo("fixture-1.2.3/linked")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../escaped"
        entries.append((link, b""))
        duplicate = tarfile.TarInfo("fixture-1.2.3/Cargo.toml")
        duplicate.size = 1
        entries.append((duplicate, b"x"))
        for entry in entries:
            with self.subTest(member=entry[0].name), tempfile.TemporaryDirectory() as temporary:
                data = crate(entry)
                packages = registry.locked_packages(lock_for(data))
                with self.assertRaises(ValueError):
                    registry.acquire_packages(packages, temporary, producer, fetch=lambda _: data)
                self.assertFalse((Path(temporary) / "registry").exists())

    def test_archive_manifest_must_match_locked_identity(self):
        data = crate(identity="different")
        packages = registry.locked_packages(lock_for(data))
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "locked identity"):
                registry.acquire_packages(packages, temporary, producer, fetch=lambda _: data)
            self.assertFalse((Path(temporary) / "registry").exists())

    def test_foreign_source_duplicate_and_invalid_identity_lock_are_rejected(self):
        lock = lock_for(crate())
        for changed in [lock.replace(registry.REGISTRY.encode(), b"git+https://example.com"),
                        lock + lock, lock.replace(b'name="fixture"', b'name="../fixture"'),
                        lock.replace(b'version="1.2.3"', b'version=".."')]:
            with self.subTest(lock=changed), self.assertRaises(ValueError):
                registry.locked_packages(changed)

    def test_declarations_preserve_original_url_digest_and_producer_map(self):
        package = registry.locked_packages(lock_for(crate()))[0]
        declaration = registry.archive_declarations([package])
        repository = "rolldown_registry_" + package["checksum"]
        self.assertIn('sha256 = "' + package["checksum"] + '"', declaration)
        self.assertIn('"@' + repository + '//file": "fixture@1.2.3"', declaration)
        self.assertIn('https://static.crates.io/crates/fixture/fixture-1.2.3.crate', declaration)
        self.assertEqual(declaration, registry.archive_declarations([package]))

    def test_redirects_cannot_change_origin(self):
        handler = registry.StaticCratesRedirect()
        for url in ["http://static.crates.io/fixture", "https://example.com/fixture",
                    "https://user@static.crates.io/fixture"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                handler.redirect_request(None, None, 302, "", {}, url)


if __name__ == "__main__":
    unittest.main()
