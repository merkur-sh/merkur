"""Independent lock-source controls for configured Rust compiler declarations."""
import ast
from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import units

LOCKS = ["Cargo.lock", "tools/bolero/Cargo.lock", "tools/ownership-proofs/Cargo.lock",
         "tools/edge-kernel-profile/Cargo.lock", "tools/sim/Cargo.lock"]
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


class LockedChecksumTest(unittest.TestCase):
    def fixture(self, root, packages):
        for name, entries in zip(LOCKS, packages):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("version = 4\n" + "".join(
                "\n[[package]]\nname = " + repr(package) + "\nversion = '1.0.0'\nsource = '" + REGISTRY
                + "'\nchecksum = '" + checksum + "'\n" for package, checksum in entries))

    def test_each_independent_workspace_supplies_its_original_archive_checksum(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root, [[("crate_" + str(index), str(index) * 64)] for index in range(5)])
            checksums = units.locked_checksums(root)
            self.assertEqual(len(checksums), 5)
            self.assertEqual(checksums[("crate_4", "1.0.0", REGISTRY)], "4" * 64)

    def test_same_original_archive_can_be_shared_between_all_five_locks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root, [[("shared", "a" * 64)] for _ in LOCKS])
            self.assertEqual(units.locked_checksums(root), {("shared", "1.0.0", REGISTRY): "a" * 64})

    def test_each_nonproduction_lock_rejects_a_conflicting_publisher_checksum(self):
        for index in range(1, len(LOCKS)):
            with self.subTest(lock=LOCKS[index]), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                packages = [[("shared", "a" * 64)] for _ in LOCKS]
                packages[index] = [("shared", "b" * 64)]
                self.fixture(root, packages)
                with self.assertRaisesRegex(ValueError, "independent locked source checksum disagreement"):
                    units.locked_checksums(root)


class SwiftSdkEmissionTest(unittest.TestCase):
    def emit(self, platform, host, package_name="merkur-identity-seal"):
        profile = {"name": "dev", "opt_level": "0", "debuginfo": 2,
                   "debug_assertions": True, "overflow_checks": True, "panic": "unwind",
                   "codegen_units": None, "lto": "false", "rpath": False}
        package = {"id": "workspace:packages/emitter-control", "name": package_name,
                   "version": "0.0.0", "source": None, "manifest": "packages/emitter-control/Cargo.toml",
                   "features": {}, "links": None}
        script = {"pkg_id": package["id"], "target": {"name": "build-script-build",
                  "kind": ["custom-build"], "crate_types": ["bin"], "edition": "2024",
                  "src_path": "packages/emitter-control/build.rs"}, "profile": profile,
                  "mode": "build", "platform": None, "execution_host": host, "features": [],
                  "dependencies": [], "rust_flags": [], "emit_cdylib": False}
        run = dict(script, mode="run-custom-build", platform=platform,
                   dependencies=[{"unit": "a" * 64, "extern_crate_name": "build_script_build"}])
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            metadata, sources, runtime = [directory / name for name in ["metadata.json", "sources.json", "runtime.json"]]
            metadata.write_text(json.dumps({"members": [package["id"]], "packages": [package]}))
            sources.write_text(json.dumps({"macros": {package["manifest"]: []}}))
            runtime.write_text("{}")
            declarations = []
            units._unit_declarations({"a" * 64: script, "b" * 64: run}, {package["id"]: package},
                                     declarations, metadata, sources, runtime)
        calls = [statement.value for statement in ast.parse("".join(declarations)).body]
        return {call.func.id: {item.arg: ast.literal_eval(item.value) for item in call.keywords} for call in calls}

    def test_implicit_native_darwin_uses_the_same_effective_target_as_emitted_platform(self):
        for host in ["aarch64-apple-darwin", "x86_64-apple-darwin"]:
            with self.subTest(host=host):
                declarations = self.emit(None, host)
                run = declarations["build_script_unit"]
                self.assertEqual(run["platform"], host)
                self.assertIn("swift_sdk", run)
                self.assertEqual(run["swift_sdk"], "//tools/bazel/tools/native:identity_swift_build_sdk")
                self.assertNotIn("swift_sdk", declarations["compiler_unit"])

    def test_explicit_darwin_target_retains_swift_with_a_distinct_execution_host(self):
        run = self.emit("x86_64-apple-darwin", "aarch64-apple-darwin")["build_script_unit"]
        self.assertEqual(run["platform"], "x86_64-apple-darwin")
        self.assertEqual(run["swift_sdk"], "//tools/bazel/tools/native:identity_swift_build_sdk")

    def test_darwin_executor_does_not_supply_swift_to_foreign_targets(self):
        for target in ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "wasm32-unknown-unknown"]:
            with self.subTest(target=target):
                self.assertNotIn("swift_sdk", self.emit(target, "aarch64-apple-darwin")["build_script_unit"])

    def test_implicit_linux_target_and_unrelated_package_do_not_acquire_swift(self):
        for host in ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]:
            with self.subTest(host=host):
                self.assertNotIn("swift_sdk", self.emit(None, host)["build_script_unit"])
        self.assertNotIn("swift_sdk", self.emit(None, "aarch64-apple-darwin", "another-package")["build_script_unit"])


if __name__ == "__main__":
    unittest.main()
