"""Exact protocol Cargo selectors; synthetic oracle controls do not qualify WASM execution."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(path):
    specification = importlib.util.spec_from_file_location("protocol_contexts", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class DeclaredSdk:
    host = "aarch64-apple-darwin"

    def command(self, tool, version):
        if version != "1.97.1":
            raise ValueError("foreign compiler fixture")
        return ["/declared/sdk/bin/" + tool]

    def environment(self, bootstrap=False):
        return {"PATH": "", **({"RUSTC_BOOTSTRAP": "1"} if bootstrap else {})}


class ProtocolContextsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="protocol-context-controls-")
        self.root = Path(self.directory.name).resolve()
        self.previous = contexts.ROOT
        contexts.ROOT = self.root
        self.source = self.root / "packages/merkur-e2e/src/lib.rs"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("// explicit synthetic source fixture\n")
        self.cwd = self.root / "packages/e2e-wasm"
        self.cwd.mkdir()
        self.raw = {"packages": [{"id": "original-cargo-id", "name": "merkur-e2e", "version": "0.1.0", "source": None,
                                  "manifest_path": str(self.source.parent.parent / "Cargo.toml")}]}
        self.normalized = {"packages": [{"id": "workspace:packages/merkur-e2e", "name": "merkur-e2e", "version": "0.1.0", "source": None}]}
        self.oracle = {"version": 1, "roots": [0], "units": [{"pkg_id": "original-cargo-id", "mode": "test",
                        "features": ["wasm"], "platform": "wasm32-unknown-unknown",
                        "profile": {"name": "release"}, "target": {"src_path": str(self.source)}}]}
        self.flags = {"rustflags": ["--cfg", 'getrandom_backend="wasm_js"', "-C", "target-feature=+simd128"], "rustdocflags": []}

    def tearDown(self):
        contexts.ROOT = self.previous
        self.directory.cleanup()

    def capture(self, **options):
        with patch.object(contexts.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(self.oracle))) as run, \
             patch.object(contexts, "effective_target_flags", return_value=self.flags) as flags:
            result = contexts.unit_graph(self.root / "Cargo.toml", "wasm32-unknown-unknown", "1.97.1", "test",
                                         self.raw, self.normalized, self.cwd, sdk=DeclaredSdk(), **options)
        return result, run.call_args, flags.call_args

    def test_original_wasm_release_library_selector(self):
        graph, call, flags = self.capture(release=True, package="merkur-e2e", no_default_features=True,
                                          features=["wasm"], library=True)
        self.assertEqual(call.args[0], ["/declared/sdk/bin/cargo", "test", "--unit-graph", "-Z", "unstable-options",
                         "--offline", "--locked", "--manifest-path", str(self.root / "Cargo.toml"), "--target",
                         "wasm32-unknown-unknown", "--release", "-p", "merkur-e2e", "--no-default-features", "--features", "wasm", "--lib"])
        self.assertEqual(call.kwargs["cwd"], self.cwd)
        self.assertEqual(call.kwargs["env"], {"PATH": "", "RUSTC_BOOTSTRAP": "1"})
        self.assertEqual(flags.args[0], self.cwd)
        self.assertEqual(graph["units"][0]["mode"], "test")
        self.assertEqual(graph["units"][0]["features"], ["wasm"])
        self.assertEqual(graph["units"][0]["rust_flags"], self.flags["rustflags"])
        self.assertEqual(graph["execution_host"], DeclaredSdk.host)

    def test_protocol_union_preserves_original_order_and_native_default_profile(self):
        packages = ["merkur-client", "merkur-client-native", "merkur-e2e", "merkur-edge", "merkur-wire"]
        oracle = copy.deepcopy(self.oracle)
        oracle["units"][0]["platform"] = None
        with patch.object(contexts.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(oracle))) as run, \
             patch.object(contexts, "effective_target_flags", return_value=self.flags):
            graph = contexts.unit_graph(self.root / "Cargo.toml", DeclaredSdk.host, "1.97.1", "test", self.raw, self.normalized, self.root, sdk=DeclaredSdk(), package=packages)
        self.assertEqual(run.call_args.args[0], ["/declared/sdk/bin/cargo", "test", "--unit-graph", "-Z", "unstable-options", "--offline", "--locked", "--manifest-path", str(self.root / "Cargo.toml")] + [value for package in packages for value in ["-p", package]])
        self.assertEqual(graph["execution_host"], DeclaredSdk.host)
        self.assertEqual(graph["units"][0]["rust_flags"], self.flags["rustflags"])

    def test_invalid_package_union_refuses_before_cargo(self):
        for selection in [[], ["merkur-client", "merkur-client"], [""], [None], ["merkur-client", 1], ("merkur-client",), 1, ""]:
            with self.subTest(selection=selection), patch.object(contexts.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, "Cargo package selection"):
                    contexts.unit_graph(self.root / "Cargo.toml", DeclaredSdk.host, "1.97.1", "test", self.raw, self.normalized, self.root, sdk=DeclaredSdk(), package=selection)
                run.assert_not_called()

    def test_default_call_retains_original_selection(self):
        _, call, _ = self.capture()
        self.assertEqual(call.args[0], ["/declared/sdk/bin/cargo", "test", "--unit-graph", "-Z", "unstable-options",
                         "--offline", "--locked", "--manifest-path", str(self.root / "Cargo.toml"), "--target", "wasm32-unknown-unknown"])
        self.assertNotIn("RUSTFLAGS", call.kwargs["env"])

    def test_no_default_metadata_uses_original_namespaced_feature(self):
        with patch.object(contexts.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="{}")) as run:
            contexts.resolve(self.root / "Cargo.toml", "wasm32-unknown-unknown", "1.97.1", False,
                             features=["merkur-e2e/wasm"], no_default_features=True, sdk=DeclaredSdk())
        self.assertEqual(run.call_args.args[0], ["/declared/sdk/bin/cargo", "metadata", "--offline", "--format-version=1",
                         "--manifest-path", str(self.root / "Cargo.toml"), "--locked", "--no-default-features", "--features", "merkur-e2e/wasm"])
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": ""})

    def test_default_metadata_retains_original_selection(self):
        with patch.object(contexts.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="{}")) as run:
            contexts.resolve(self.root / "Cargo.toml", "wasm32-unknown-unknown", "1.97.1", False, sdk=DeclaredSdk())
        self.assertEqual(run.call_args.args[0], ["/declared/sdk/bin/cargo", "metadata", "--offline", "--format-version=1",
                         "--manifest-path", str(self.root / "Cargo.toml"), "--locked"])

    def test_original_cargo_failure_is_retained(self):
        with patch.object(contexts.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="original engine rejection")):
            with self.assertRaisesRegex(RuntimeError, "original engine rejection"):
                contexts.unit_graph(self.root / "Cargo.toml", "wasm32-unknown-unknown", "1.97.1", "test",
                                    self.raw, self.normalized, self.cwd, sdk=DeclaredSdk(), release=True,
                                    package="merkur-e2e", no_default_features=True, features=["wasm"], library=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--contexts", type=Path, required=True)
    arguments = parser.parse_args()
    contexts = load(arguments.contexts)
    unittest.main(argv=["contexts_protocol_test.py"])
