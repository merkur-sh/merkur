"""Execute the authored compiler macro with captured rule calls, not a Rust build."""
import argparse
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


UNITS = Path(__file__).with_name("units.bzl")
BASELINE = None
NATIVE_PACKAGES = ["merkur-dataplane", "merkur-tui", "merkur-image-worker", "merkur-edge", "merkur-stun"]
NATIVE_PLATFORMS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]
WASM = "wasm32-unknown-unknown"


class StarlarkDict(dict):
    def values(self):
        return list(super().values())


def capture(source):
    tree = ast.parse(source.read_text())
    tree.body = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "compiler_unit"]
    if len(tree.body) != 1:
        raise AssertionError("Exact compiler_unit source function is required")
    calls = []
    def fail(message):
        raise ValueError(message)
    def rule(role):
        return lambda **kwargs: calls.append({"rule": role, "kwargs": kwargs})
    symbols = {name: rule(name) for name in ["rust_binary", "rust_library", "rust_proc_macro", "rust_shared_library", "rust_test", "rust_check", "_configured_package_test"]}
    symbols.update({
        "fail": fail, "dict": StarlarkDict,
        "Label": lambda value: SimpleNamespace(repo_name="", package=value.split("//", 1)[1].split(":", 1)[0]),
        "_directory": lambda value: value.split("//", 1)[1].split(":", 1)[0],
        "_PLATFORMS": {platform: ["captured:" + platform] for platform in NATIVE_PLATFORMS + [WASM]},
        "confinement_test_tags": lambda *_args: ["manual"],
    })
    exec(compile(tree, str(source), "exec"), symbols)
    return symbols["compiler_unit"], calls


def inputs(package="merkur-edge", platform="aarch64-apple-darwin", **changes):
    result = {
        "name": "captured_unit", "crate_name": package.replace("-", "_"),
        "crate_root": "//apps/edge:src/main.rs", "sources": "//apps/edge:sources",
        "compile_data": "//apps/edge:inputs", "manifest": "//apps/edge:Cargo.toml",
        "edition": "2024", "version": "0.0.0", "crate_features": ["captured_feature"],
        "deps": ["//captured:dependency"], "proc_macro_deps": ["//captured:macro"],
        "aliases": {"//captured:dependency": "original_name"}, "proc_macro_aliases": {},
        "rustc_flags": ["-Copt-level=3"], "kind": ["bin"], "mode": "build",
        "platform": platform, "execution_host": "aarch64-apple-darwin", "first_party": True,
        "cargo_env": {"CARGO_PKG_NAME": package, "CARGO_PKG_VERSION": "0.0.0"},
        "rust_flags": ["--cfg", "original_cfg"], "emit_cdylib": False, "crate_types": ["bin"],
        "compiler_env": {"CAPTURED_COMPILER_ENV": "unchanged"},
        "profile_data": ["//captured:profile"], "macro_data": ["//captured:macro_data"],
        "runtime_data": ["//captured:runtime"], "binary_helpers": StarlarkDict(),
        "semantic_metadata": "captured_original_metadata",
    }
    result.update(changes)
    return result


def expected_native(arguments):
    package = "apps/edge"
    return [{"rule": "rust_binary", "kwargs": {
        "name": arguments["name"], "crate_name": arguments["crate_name"],
        "crate_root": arguments["crate_root"], "srcs": [arguments["sources"]],
        "compile_data": [arguments["compile_data"], "//captured:profile", "//captured:macro_data"],
        "data": [], "edition": "2024", "version": "0.0.0", "crate_features": ["captured_feature"],
        "deps": ["//captured:dependency"], "proc_macro_deps": ["//captured:macro"],
        "aliases": {"//captured:dependency": "original_name"}, "proc_macro_aliases": {},
        "rustc_flags": ["-Copt-level=3", "--cfg", "original_cfg"],
        "semantic_metadata": "captured_original_metadata",
        "rustc_env": {**arguments["cargo_env"], "CAPTURED_COMPILER_ENV": "unchanged", "CARGO_MANIFEST_DIR": "$${pwd}/" + package},
        "target_compatible_with": ["captured:" + arguments["platform"]],
        "exec_compatible_with": ["captured:aarch64-apple-darwin"], "tags": ["manual"],
        "lint_config": "@@//apps/edge:manifest_lints", "apply_lints_in_exec": True,
        "rustc_env_files": ["//tools/bazel/bun:public_release_context"], "native_link_map": True,
    }}]


class CompilerUnitLinkMapTests(unittest.TestCase):
    def setUp(self):
        self.compiler_unit, self.calls = capture(UNITS)

    def test_all_five_native_binaries_preserve_complete_original_rule_calls(self):
        for platform in NATIVE_PLATFORMS:
            for package in NATIVE_PACKAGES:
                with self.subTest(package=package, platform=platform):
                    self.calls.clear()
                    arguments = inputs(package, platform)
                    self.compiler_unit(**arguments)
                    actual = json.dumps(self.calls, sort_keys=True, separators=(",", ":"))
                    expected = json.dumps(expected_native(arguments), sort_keys=True, separators=(",", ":"))
                    self.assertEqual(actual, expected)
                    if BASELINE is not None:
                        original, old_calls = capture(BASELINE)
                        original(**arguments)
                        self.assertEqual(actual, json.dumps(old_calls, sort_keys=True, separators=(",", ":")))

    def test_original_wasm_cdylib_root_maps_same_shared_library_action(self):
        self.compiler_unit(**inputs("e2e-wasm", WASM, kind=["lib"], crate_types=["cdylib", "rlib"], emit_cdylib=True))
        self.assertEqual(len(self.calls), 1)
        call = self.calls[0]
        self.assertEqual(call["rule"], "rust_shared_library")
        self.assertIs(call["kwargs"]["wasm_link_map"], True)
        self.assertNotIn("native_link_map", call["kwargs"])
        self.assertNotIn("rustc_env_files", call["kwargs"])
        self.assertEqual(call["kwargs"]["rustc_flags"], ["-Copt-level=3", "--cfg", "original_cfg"])

    def test_host_proc_macro_maps_same_action_even_when_third_party(self):
        self.compiler_unit(**inputs("syn-derive", kind=["proc-macro"], crate_types=["proc-macro"], first_party=False))
        self.assertEqual(self.calls[0]["rule"], "rust_proc_macro")
        self.assertIs(self.calls[0]["kwargs"]["native_link_map"], True)
        self.assertNotIn("wasm_link_map", self.calls[0]["kwargs"])
        self.assertEqual(self.calls[0]["kwargs"]["exec_compatible_with"], ["captured:aarch64-apple-darwin"])

    def test_explicit_maps_are_supported_only_on_actual_linked_actions(self):
        for changes, role, flag in [
            ({"first_party": False, "native_link_map": True}, "rust_binary", "native_link_map"),
            ({"first_party": False, "kind": ["proc-macro"], "crate_types": ["proc-macro"], "native_link_map": True}, "rust_proc_macro", "native_link_map"),
            ({"first_party": False, "platform": WASM, "kind": ["lib"], "crate_types": ["cdylib"], "emit_cdylib": True, "wasm_link_map": True}, "rust_shared_library", "wasm_link_map"),
        ]:
            with self.subTest(changes=changes):
                self.calls.clear()
                self.compiler_unit(**inputs(**changes))
                self.assertEqual(self.calls[0]["rule"], role)
                self.assertIs(self.calls[0]["kwargs"][flag], True)

    def test_test_and_check_actions_never_receive_automatic_map_flags(self):
        for mode in ["test", "check"]:
            with self.subTest(mode=mode):
                self.calls.clear()
                self.compiler_unit(**inputs(mode=mode))
                self.assertEqual(self.calls[0]["rule"], "rust_test" if mode == "test" else "rust_check")
                for call in self.calls:
                    self.assertNotIn("native_link_map", call["kwargs"])
                    self.assertNotIn("wasm_link_map", call["kwargs"])
                self.assertEqual(len(self.calls), 2 if mode == "test" else 1)

    def test_unlinked_libraries_do_not_get_automatic_flags(self):
        for platform, first_party in [(NATIVE_PLATFORMS[0], True), (WASM, True), (WASM, False)]:
            with self.subTest(platform=platform, first_party=first_party):
                self.calls.clear()
                self.compiler_unit(**inputs(platform=platform, first_party=first_party, kind=["lib"], crate_types=["rlib"]))
                self.assertEqual(self.calls[0]["rule"], "rust_library")
                self.assertNotIn("native_link_map", self.calls[0]["kwargs"])
                self.assertNotIn("wasm_link_map", self.calls[0]["kwargs"])

    def test_invalid_explicit_native_flag_refuses_before_rule_dispatch(self):
        for changes in [{"mode": "test"}, {"mode": "check"}, {"kind": ["lib"], "crate_types": ["rlib"]}, {"platform": WASM}, {"platform": WASM, "kind": ["lib"], "emit_cdylib": True, "crate_types": ["cdylib"]}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "actual native"):
                self.compiler_unit(**inputs(native_link_map=True, **changes))
            self.assertEqual(self.calls, [])

    def test_invalid_explicit_wasm_flag_refuses_before_rule_dispatch(self):
        for changes in [{}, {"platform": WASM}, {"platform": WASM, "mode": "test", "emit_cdylib": True}, {"platform": WASM, "mode": "check", "emit_cdylib": True}, {"platform": WASM, "kind": ["lib"], "crate_types": ["rlib"]}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "actual WASM"):
                self.compiler_unit(**inputs(wasm_link_map=True, **changes))
            self.assertEqual(self.calls, [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--units", type=Path, default=UNITS)
    parser.add_argument("--baseline", type=Path)
    args, remaining = parser.parse_known_args()
    UNITS, BASELINE = args.units, args.baseline
    unittest.main(argv=[__file__, *remaining])
