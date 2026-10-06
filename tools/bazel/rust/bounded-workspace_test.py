"""Bounded workspace manifests preserve production inputs and isolate engines."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import tomllib
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


HERE = Path(__file__).parent
BUILDER = load("bounded_workspace", HERE / "bounded-workspace.py")
CONTEXTS = load("bounded_contexts", HERE / "contexts.py")


def fixture(root):
    source = root / "original"
    source.mkdir()
    production = {"workspace": {"members": ["packages/example", "packages/dependency"],
                                "lints": {"rust": {"unexpected_cfgs": {"level": "warn", "check-cfg": ["cfg(kani)", "cfg(merkur_fuzz)"]}}}},
                  "patch": {"crates-io": {"patched": {"path": "packages/dependency"}}},
                  "profile": {"test": {"opt-level": 1}}}
    (source / "Cargo.toml").write_text(CONTEXTS.toml_text(production))
    (source / "Cargo.lock").write_bytes(b"production lock bytes")
    package = {"package": {"name": "example", "version": "0.1.0", "edition": "2024"},
               "dependencies": {"dependency": {"path": "../dependency", "features": ["production"], "default-features": False}},
               "dev-dependencies": {"criterion": "0.8"},
               "lints": {"workspace": True}, "features": {"default": ["production"], "production": []},
               "lib": {"crate-type": ["lib"]}, "bench": [{"name": "measure", "path": "benches/measure.rs"}]}
    for name in ["example", "dependency"]:
        directory = source / "packages" / name
        (directory / "src").mkdir(parents=True)
        (directory / "src/lib.rs").write_bytes(b"production source")
        (directory / "Cargo.toml").write_text(CONTEXTS.toml_text(package if name == "example" else {"package": {"name": name, "version": "0.1.0"}}))
    (source / "packages/example/benches").mkdir()
    (source / "packages/example/benches/measure.rs").write_bytes(b"original bench")
    (source / "packages/example/assets").mkdir()
    (source / "packages/example/assets/input.bin").write_bytes(b"original asset")
    (source / "tools/bolero").mkdir(parents=True)
    (source / "tools/bolero/Cargo.lock").write_bytes(b"exact retained bounded lock")
    (source / "tools/bolero/adapter.rs").write_bytes(b"original adapter")
    (source / "tools/bolero/targets.json").write_text(json.dumps([{"crate": "example", "source": "adapter.rs", "tests": [], "maxLength": 4096}]))
    return source, package


class Controls(unittest.TestCase):
    def test_original_profiles_dependencies_and_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, package = fixture(root)
            workspace = root / "generated"
            lock = BUILDER.prepare(source, workspace, CONTEXTS.toml_text)
            generated = tomllib.loads((workspace / "example/Cargo.toml").read_text())
            production = tomllib.loads((source / "Cargo.toml").read_text())
            manifest = tomllib.loads((workspace / "Cargo.toml").read_text())
            self.assertEqual(generated["package"]["name"], "example-fuzz")
            self.assertFalse(generated["package"]["autotests"])
            self.assertEqual(generated["features"], package["features"])
            self.assertEqual(generated["dependencies"]["dependency"]["features"], ["production"])
            self.assertFalse(generated["dependencies"]["dependency"]["default-features"])
            self.assertEqual(generated["dev-dependencies"], {"criterion": "0.8", "bolero": "=0.13.6"})
            self.assertEqual(generated["lints"], package["lints"])
            self.assertEqual(manifest["workspace"]["lints"], production["workspace"]["lints"])
            self.assertEqual(manifest["profile"], {"fuzz": {"inherits": "dev", "opt-level": 3, "codegen-units": 1, "debug-assertions": True, "overflow-checks": True}})
            self.assertEqual(lock, b"exact retained bounded lock")
            self.assertEqual((workspace / "Cargo.lock").read_bytes(), lock)
            self.assertEqual((source / "Cargo.lock").read_bytes(), b"production lock bytes")
            self.assertEqual((workspace / "example/assets/input.bin").read_bytes(), b"original asset")
            directory = workspace / "example"
            for path, expected in [(generated["lib"]["path"], source / "packages/example/src/lib.rs"),
                                   (generated["dependencies"]["dependency"]["path"], source / "packages/dependency"),
                                   (generated["bench"][0]["path"], source / "packages/example/benches/measure.rs"),
                                   (generated["test"][0]["path"], source / "tools/bolero/adapter.rs")]:
                self.assertEqual((directory / path).resolve(), expected.resolve())

    def test_missing_original_manifest_or_adapter_refuses_before_output(self):
        for missing in ["packages/dependency/Cargo.toml", "tools/bolero/adapter.rs", "packages/example/src/lib.rs"]:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, _ = fixture(root)
                (source / missing).unlink()
                workspace = root / "generated"
                with self.assertRaises(ValueError):
                    BUILDER.prepare(source, workspace, CONTEXTS.toml_text)
                self.assertFalse(workspace.exists())

    def test_cargo_path_escape_refuses_before_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, package = fixture(root)
            (root / "host").mkdir()
            package["dependencies"]["dependency"]["path"] = str(root / "host")
            (source / "packages/example/Cargo.toml").write_text(CONTEXTS.toml_text(package))
            with self.assertRaisesRegex(ValueError, "escaped"):
                BUILDER.prepare(source, root / "generated", CONTEXTS.toml_text)
            self.assertFalse((root / "generated").exists())

    def test_duplicate_and_traversal_targets_refuse(self):
        for targets in [[{"crate": "example"}, {"crate": "example"}], [{"crate": "../host"}]]:
            with self.subTest(targets=targets), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, _ = fixture(root)
                (source / "tools/bolero/targets.json").write_text(json.dumps(targets))
                with self.assertRaises(ValueError):
                    BUILDER.prepare(source, root / "generated", CONTEXTS.toml_text)
                self.assertFalse((root / "generated").exists())


if __name__ == "__main__":
    unittest.main()
