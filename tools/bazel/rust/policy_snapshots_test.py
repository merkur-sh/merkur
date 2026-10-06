"""Focused policy acquisition contracts; mocked calls do not qualify a native SDK."""

import argparse
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(path):
    spec = importlib.util.spec_from_file_location("policy_control", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PolicyContracts(unittest.TestCase):
    def setUp(self):
        self.policy = load(POLICY)
        self.private = tempfile.TemporaryDirectory(prefix="policy-sdk-controls-")
        self.addCleanup(self.private.cleanup)
        self.root = Path(self.private.name)
        self.policy.ROOT = self.root
        self.policy.DEST = self.root / "tools/bazel/rust/policy_snapshots"

    def write(self, path, text):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)
        return destination

    def locks(self):
        paths = self.policy.original_locks()
        for file in paths.values():
            self.write(file.relative_to(self.root), '[[package]]\nname="fixture"\nversion="0.1.0"\n')
        self.write("tools/bazel/rust/diagnostics/bolero/Cargo.lock", paths["bolero"].read_text())
        return paths

    def test_refresh_requires_all_explicit_acquisition_arguments_before_any_tools(self):
        for arguments in [[], ["--sdk-descriptor", "absent"], ["--sdk-resolver", "absent", "--source-root", str(self.root)]]:
            result = subprocess.run([sys.executable, "-B", "-I", str(POLICY), "--refresh", *arguments],
                capture_output=True, text=True, env={"PATH": "/missing-ambient-tools"})
            self.assertEqual(result.returncode, 2)
            self.assertIn("--refresh requires --sdk-descriptor, --sdk-resolver and --source-root", result.stderr)

    def test_generated_lock_pruning_preserves_original_package_checksum_authority(self):
        paths = self.locks()
        requested = []
        sdk = SimpleNamespace(require_locks=lambda files: requested.extend(files))
        original = {"source": "registry+https://github.com/rust-lang/crates.io-index", "name": "fixture", "version": "0.1.0", "checksum": "a" * 64}
        def lock(packages):
            return "".join("[[package]]\n" + "".join(key + "=" + json.dumps(value) + "\n" for key, value in package.items()) for package in packages)
        self.write(paths["bolero"].relative_to(self.root), lock([original, {**original, "name": "unused"}]))
        self.write("tools/bazel/rust/diagnostics/bolero/Cargo.lock", lock([original]))
        self.policy.require_graph_locks(sdk)
        self.assertEqual(requested, list(paths.values()))
        self.assertEqual(paths["bolero"], self.root / "tools/bolero/Cargo.lock")
        for field, value in [("checksum", "b" * 64), ("name", "other"), ("version", "0.2.0"), ("source", "git+https://foreign.invalid/source")]:
            with self.subTest(field=field):
                self.write("tools/bazel/rust/diagnostics/bolero/Cargo.lock", lock([{**original, field: value}]))
                with self.assertRaisesRegex(ValueError, "original Bolero lock authority"):
                    self.policy.require_graph_locks(sdk)

    def test_missing_declared_lock_stops_refresh_before_metadata_or_publication(self):
        self.write("rust-toolchain.toml", '[toolchain]\nchannel="1.97.1"\n')
        def refuse(paths):
            raise ValueError("refresh requires the exact declared lock and complete registry source")
        sdk = SimpleNamespace(require_locks=refuse)
        with patch.object(self.policy, "metadata", side_effect=AssertionError("metadata called")):
            with self.assertRaisesRegex(ValueError, "exact declared lock"):
                self.policy.refresh(sdk)
        self.assertFalse(self.policy.DEST.exists())

    def test_metadata_uses_only_declared_cargo_environment_and_original_policy_flags(self):
        requested = []
        env = {"PATH": "", "RUSTC": "/declared/rustc", "CARGO_NET_OFFLINE": "true"}
        sdk = SimpleNamespace(command=lambda tool, version: requested.append((tool, version)) or ["/declared/cargo"],
            environment=lambda: dict(env))
        raw = {"packages": [], "resolve": {"nodes": []}}
        with patch.object(self.policy.subprocess, "run", return_value=SimpleNamespace(stdout=json.dumps(raw))) as run:
            self.assertEqual(self.policy.metadata(sdk, "1.97.1", "Cargo.toml"), raw)
        self.assertEqual(requested, [("cargo", "1.97.1")])
        self.assertEqual(run.call_args.args[0], ["/declared/cargo", "metadata", "--all-features", "--offline", "--locked", "--format-version=1", "--manifest-path", str(self.root / "Cargo.toml")])
        self.assertEqual(run.call_args.kwargs["env"], env)
        self.assertEqual(run.call_args.kwargs["cwd"], self.root)

    def test_policy_version_refusal_precedes_output_creation(self):
        self.locks()
        self.write("rust-toolchain.toml", '[toolchain]\nchannel="foreign"\n')
        def refuse(tool, version):
            raise ValueError("acquisition attempted an undeclared tool or compiler version")
        sdk = SimpleNamespace(require_locks=lambda files: None, command=refuse)
        with self.assertRaisesRegex(ValueError, "undeclared tool or compiler version"):
            self.policy.refresh(sdk)
        self.assertFalse(self.policy.DEST.exists())

    def test_actual_generator_mismatch_stops_before_metadata_and_publication(self):
        self.locks()
        self.write("rust-toolchain.toml", '[toolchain]\nchannel="1.97.1"\n')
        self.write("tools/bazel/rust/policy_snapshots.py", "old generator bytes\n")
        sdk = SimpleNamespace(require_locks=lambda files: None, command=lambda tool, version: ["/declared/cargo"])
        with patch.object(self.policy, "metadata", side_effect=AssertionError("metadata called")):
            with self.assertRaisesRegex(ValueError, "actual declared generator File"):
                self.policy.refresh(sdk)
        self.assertFalse(self.policy.DEST.exists())

    def test_original_index_archive_checksum_assertion_is_preserved(self):
        raw = {"packages": [{"name": "fixture", "version": "0.1.0", "source": "registry+https://github.com/rust-lang/crates.io-index"}]}
        lock = {"package": [{"name": "fixture", "version": "0.1.0", "source": raw["packages"][0]["source"], "checksum": "a" * 64}]}
        record = {"name": "fixture", "vers": "0.1.0", "cksum": "b" * 64, "features": {}}
        self.policy.INDEX_RECORDS["fixture"] = [record]
        with self.assertRaisesRegex(ValueError, "index/archive lock disagreement"):
            self.policy.index_features(raw, lock)
        record["cksum"] = "a" * 64
        record["features2"] = {"selected": ["dep:member"]}
        result = self.policy.index_features(raw, lock)
        self.assertEqual(result[0]["features"], {"selected": ["dep:member"]})
        self.policy.INDEX_RECORDS["fixture"].append(dict(record))
        with self.assertRaisesRegex(ValueError, "index/archive lock disagreement"):
            self.policy.index_features(raw, lock)


class NativeSdkControls(unittest.TestCase):
    """Actual SDK/tool/lock checks and Cargo metadata; no index or policy publication."""

    @classmethod
    def setUpClass(cls):
        cls.policy = load(POLICY)
        cls.policy.ROOT = SOURCE_ROOT.resolve(strict=True)
        cls.resolver = load(SDK_RESOLVER)
        cls.descriptor = json.loads(SDK_DESCRIPTOR.read_text())
        cls.sdk = cls.resolver.NativeCargoSdk.load(SDK_DESCRIPTOR)
        cls.addClassCleanup(cls.sdk.close)

    def test_actual_sdk_is_the_pinned_native_compiler_and_closed_environment(self):
        self.assertEqual(self.sdk.descriptor["version"], "1.97.1")
        self.assertEqual(self.sdk.command("cargo", "1.97.1"), [str(self.sdk.cargo)])
        self.assertEqual(self.sdk.environment()["PATH"], "")
        self.assertEqual(self.sdk.environment()["RUSTC"], str(self.sdk.rustc))

    def test_actual_current_four_graphs_resolve_without_ambient_rustup_or_cargo(self):
        self.policy.require_graph_locks(self.sdk)
        self.assertTrue(all(path.resolve(strict=True) in self.sdk.lock_paths for path in self.policy.original_locks().values()))
        for name, manifest in self.policy.GRAPHS.items():
            with self.subTest(graph=name):
                raw = self.policy.metadata(self.sdk, "1.97.1", manifest)
                self.assertTrue(raw["packages"])
                self.assertTrue(raw["resolve"]["nodes"])
                self.assertTrue(raw["workspace_members"])

    def test_malformed_descriptor_refuses(self):
        with self.assertRaisesRegex(ValueError, "invalid declared native acquisition descriptor"):
            self.resolver.NativeCargoSdk({"version": "1.97.1"})

    def test_foreign_compiler_version_refuses(self):
        value = {**self.descriptor, "version": "foreign"}
        with self.assertRaisesRegex(ValueError, "native Rust1.97.1 SDK"):
            self.resolver.NativeCargoSdk(value)

    def test_foreign_compiler_file_facts_refuse(self):
        value = copy.deepcopy(self.descriptor)
        value["rustc"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed declared SDK File"):
            self.resolver.NativeCargoSdk(value)

    def test_stale_current_lock_facts_refuse(self):
        value = copy.deepcopy(self.descriptor)
        self.assertTrue(value["locks"])
        value["locks"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed declared SDK File"):
            self.resolver.NativeCargoSdk(value)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--sdk-descriptor", type=Path, required=True)
    parser.add_argument("--sdk-resolver", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    args, unittest_arguments = parser.parse_known_args()
    POLICY = args.policy.resolve(strict=True)
    SDK_DESCRIPTOR = args.sdk_descriptor.resolve(strict=True)
    SDK_RESOLVER = args.sdk_resolver.resolve(strict=True)
    SOURCE_ROOT = args.source_root.resolve(strict=True)
    unittest.main(argv=[sys.argv[0], *unittest_arguments])
