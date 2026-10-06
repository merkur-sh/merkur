"""Declared SDK Tree presentation controls; compiler identities are mocked here only."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sdk_carriers", Path(__file__).with_name("acquisition_sdk.py"))
sdk_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk_module)


class CarrierControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sdk-carrier-control-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.original = self.base / "original/execroot/_main"
        self.sandbox = self.base / "sandbox/execroot/_main"
        self.original.mkdir(parents=True)
        self.sandbox.mkdir(parents=True)
        self.old_cwd = Path.cwd()
        self.addCleanup(os.chdir, self.old_cwd)
        self.prefix = Path("bazel-out/native/bin/acquire")
        self.registry = self.prefix / "workspace.registry"
        self.sources = self.prefix / "workspace.sources"
        self.descriptor = self.prefix / "workspace.descriptor.json"
        self.package = self.registry / "fixture-1.2.3"
        files = {self.package / "Cargo.toml": b"[package]\nname='fixture'\nversion='1.2.3'\n",
                 self.package / "src/lib.rs": b"pub fn original() {}\n"}
        checksums = {str(path.relative_to(self.package)): hashlib.sha256(data).hexdigest() for path, data in files.items()}
        self.checksum = "a" * 64
        files[self.package / ".cargo-checksum.json"] = json.dumps({"package": self.checksum, "files": checksums}).encode()
        files[self.prefix / "Cargo.lock"] = ('[[package]]\nname="fixture"\nversion="1.2.3"\nsource="' + sdk_module.REGISTRY + '"\nchecksum="' + self.checksum + '"\n').encode()
        files[self.prefix / "cargo"] = b"original cargo"
        files[self.prefix / "rustc"] = b"original rustc"
        files[self.sources / "Cargo.toml"] = b"original source manifest"
        for path, data in files.items():
            self.write_original(path, data)
        os.chdir(self.original)
        self.raw = {"version": sdk_module.VERSION, "execution_host": "aarch64-apple-darwin",
                    "cargo": sdk_module.file_fact(self.prefix / "cargo"),
                    "rustc": sdk_module.file_fact(self.prefix / "rustc"),
                    "sdk": [sdk_module.file_fact(self.prefix / name) for name in ["cargo", "rustc"]],
                    "locks": [sdk_module.file_fact(self.prefix / "Cargo.lock")],
                    "registry": {"directory": str(self.registry),
                        "packages": [{"name": "fixture", "version": "1.2.3", "checksum": self.checksum}],
                        "files": [sdk_module.file_fact(path) for path in files if path.is_relative_to(self.registry)]}}
        self.write_original(self.descriptor, json.dumps(self.raw).encode())
        for path in [*files, self.descriptor]:
            presentation = self.sandbox / path
            presentation.parent.mkdir(parents=True, exist_ok=True)
            presentation.symlink_to(self.original / path)
        os.chdir(self.sandbox)
        def version(argv, **kwargs):
            self.assertEqual(kwargs["env"], {"PATH": ""})
            name = Path(argv[0]).name
            return SimpleNamespace(stdout=name + " 1.97.1\nrelease: 1.97.1\nhost: aarch64-apple-darwin\n")
        self.version = patch.object(sdk_module.subprocess, "run", side_effect=version)
        self.version.start()
        self.addCleanup(self.version.stop)

    def write_original(self, path, data):
        target = self.original / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def load(self):
        sdk = sdk_module.NativeCargoSdk.load(self.descriptor)
        self.addCleanup(sdk._private.cleanup)
        return sdk

    def test_original_ordinary_relative_tree(self):
        os.chdir(self.original)
        self.assertEqual(self.load().original_tree(self.registry), self.original / self.registry)

    def test_engine_leaf_carriers_share_exact_descriptor_namespace(self):
        sdk = self.load()
        self.assertEqual(sdk.original_tree(self.sources), self.original / self.sources)
        self.assertIn(str(self.original / self.registry), (sdk.cargo_home / "config.toml").read_text())

    def test_engine_top_tree_carrier(self):
        shutil.rmtree(self.sandbox / self.registry)
        (self.sandbox / self.registry).symlink_to(self.original / self.registry, target_is_directory=True)
        self.load()

    def test_constructor_does_not_authorize_leaf_carriers(self):
        with self.assertRaisesRegex(ValueError, "original declared source"):
            sdk_module.NativeCargoSdk(copy.deepcopy(self.raw))

    def test_all_same_byte_foreign_carriers_refuse(self):
        foreign = self.base / "undeclared-outside/execroot/_main" / self.registry
        shutil.copytree(self.original / self.registry, foreign)
        for path in (self.sandbox / self.registry).rglob("*"):
            if path.is_symlink():
                relative = path.relative_to(self.sandbox / self.registry)
                path.unlink()
                path.symlink_to(foreign / relative)
        with self.assertRaisesRegex(ValueError, "original declared source"):
            self.load()

    def test_original_authored_leaf_alias_refuses(self):
        path = self.original / self.package / "src/lib.rs"
        foreign = self.base / "same-bytes.rs"
        foreign.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(foreign)
        with self.assertRaisesRegex(ValueError, "original declared source"):
            self.load()

    def test_changed_original_member_refuses(self):
        self.write_original(self.package / "src/lib.rs", b"changed")
        with self.assertRaisesRegex(ValueError, "changed declared SDK File"):
            self.load()

    def test_missing_original_member_refuses(self):
        (self.original / self.package / "src/lib.rs").unlink()
        with self.assertRaises(FileNotFoundError):
            self.load()

    def test_extra_original_member_refuses(self):
        self.write_original(self.package / "extra.rs", b"unlisted")
        with self.assertRaisesRegex(ValueError, "File membership changed"):
            self.load()

    def test_extra_presentation_member_refuses(self):
        (self.sandbox / self.package / "extra.rs").write_bytes(b"unlisted")
        with self.assertRaisesRegex(ValueError, "carrier differs"):
            self.load()

    def test_changed_original_lock_pin_refuses(self):
        raw = copy.deepcopy(self.raw)
        raw["registry"]["packages"][0]["checksum"] = "b" * 64
        self.write_original(self.descriptor, json.dumps(raw).encode())
        with self.assertRaisesRegex(ValueError, "complete locked source closure"):
            self.load()

    def test_original_source_tree_alias_refuses(self):
        sdk = self.load()
        foreign = self.base / "foreign-sources"
        shutil.copytree(self.original / self.sources, foreign)
        shutil.rmtree(self.original / self.sources)
        (self.original / self.sources).symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "original declared Tree is an alias"):
            sdk.original_tree(self.sources)

    def test_noncanonical_descriptor_and_tree_refuse(self):
        for raw in ["../" + str(self.descriptor), "bazel-out/native/../bin/acquire/workspace.descriptor.json"]:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "canonical"):
                sdk_module.NativeCargoSdk(self.raw, _descriptor_path=raw)
        sdk = self.load()
        for path in [self.original / self.sources, "../" + str(self.sources)]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "canonical"):
                sdk.original_tree(path)


if __name__ == "__main__":
    unittest.main()
