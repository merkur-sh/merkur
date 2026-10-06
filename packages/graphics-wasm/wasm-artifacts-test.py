"""Original Cargo/web package boundaries; native action qualification is separate."""
import argparse
import json
from pathlib import Path
import tomllib
import types
import unittest


class GraphicsWasmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cargo = tomllib.loads(arguments.manifest.read_text())
        cls.graph = json.loads(arguments.graph.read_text())

    def setUp(self):
        self.calls = []
        namespace = {
            "load": lambda *args: None,
            "native": types.SimpleNamespace(exports_files=lambda *args, **kwargs: None),
            "declare_conformance_sources": lambda: None,
            "bun_test": lambda **attrs: None,
            "package_controls_test": lambda **attrs: None,
        }
        for name in ["wasm_bindings", "wasm_optimized_bindings", "wasm_package"]:
            namespace[name] = lambda _name=name, **attrs: self.calls.append((_name, attrs))
        exec(compile(arguments.bindings.read_text(), str(arguments.bindings), "exec"), namespace)
        namespace["declare_bun_tests"]()

    def test_original_web_release_cdylib_root_is_selected(self):
        kind, attrs = self.calls[0]
        self.assertEqual(kind, "wasm_bindings")
        self.assertEqual(attrs["wasm"], "//tools/bazel/rust/units:graphics_wasm__release_wasm")
        keys = self.graph["roots"]["graphics-wasm/release/wasm32-unknown-unknown"]
        self.assertEqual(len(keys), 1)
        root = self.graph["nodes"][keys[0]]
        self.assertEqual(root["pkg_id"], "workspace:packages/graphics-wasm")
        self.assertEqual(root["target"]["name"], attrs["module_name"])
        self.assertEqual(root["target"]["src_path"], "packages/graphics-wasm/src/lib.rs")
        self.assertEqual(root["platform"], "wasm32-unknown-unknown")
        self.assertEqual(root["mode"], "build")
        self.assertEqual(root["profile"]["name"], "release")
        self.assertIn("cdylib", root["target"]["crate_types"])
        self.assertIs(root["emit_cdylib"], True)
        self.assertEqual(root["features"], [])

    def test_original_wasm_pack_release_optimizer_choice_is_preserved(self):
        kind, attrs = self.calls[1]
        self.assertEqual(kind, "wasm_optimized_bindings")
        self.assertEqual(attrs["bindings"], ":" + self.calls[0][1]["name"])
        configuration = self.cargo["package"].get("metadata", {}).get("wasm-pack", {}).get("profile", {}).get("release", {})
        # wasm-pack0.15 CargoWasmPackProfile::default_release + wasm_opt_args.
        optimizer = configuration.get("wasm-opt", True)
        original = ["-O"] if optimizer is True else optimizer
        self.assertEqual(attrs["flags"], original)
        self.assertEqual(configuration.get("wasm-bindgen", {}), {})

    def test_package_metadata_and_existing_generator_inventory_are_retained(self):
        kind, attrs = self.calls[2]
        self.assertEqual(kind, "wasm_package")
        self.assertEqual(attrs["bindings"], ":" + self.calls[1][1]["name"])
        self.assertEqual(attrs["crate_manifest"], ":Cargo.toml")
        self.assertEqual(attrs["module_name"], self.cargo["package"]["name"].replace("-", "_"))
        self.assertEqual(attrs["out"], "pkg")
        self.assertFalse(attrs.get("terminal", False))
        self.assertEqual(self.cargo["dependencies"]["wasm-bindgen"], "=0.2.127")
        self.assertEqual(len(self.calls), 3)


    def test_packaging_names_do_not_collide_with_actual_bun_or_compiler_declarations(self):
        declarations = {}
        def record(kind):
            def declare(**attributes):
                name = attributes["name"]
                if name in declarations:
                    raise ValueError("Graphics target name collision: " + name)
                declarations[name] = {"kind": kind, **attributes}
            return declare
        namespace = {
            "load": lambda *args, **kwargs: None,
            "select": lambda choices: choices,
            "native": types.SimpleNamespace(
                alias=record("compiler_alias"),
                test_suite=record("compiler_test_suite"),
                exports_files=lambda *args, **kwargs: None,
            ),
            "configured_public_rust_test": record("compiler_test"),
            "js_library": record("bun_sources"),
            "bun_test": record("bun_test"),
            "package_controls_test": record("package_controls_test"),
            "wasm_bindings": record("wasm_bindings"),
            "wasm_optimized_bindings": record("wasm_optimized_bindings"),
            "wasm_package": record("wasm_package"),
        }
        for factory in [arguments.package_targets, arguments.bun_inputs, arguments.bindings]:
            exec(compile(factory.read_text(), str(factory), "exec"), namespace)
        namespace["declare_rust_package"]("graphics-wasm")
        namespace["declare_bun_tests"]()
        self.assertEqual(declarations["wasm_artifacts"]["kind"], "wasm_package")
        self.assertEqual(declarations["test__conformance.test.ts"]["kind"], "bun_test")
        self.assertIn(":wasm_artifacts", declarations["test__conformance.test.ts"]["data"])
        self.assertEqual(sum(row["kind"] == "wasm_package" for row in declarations.values()), 1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    source = Path(__file__)
    parser.add_argument("--bindings", type=Path, default=source.with_name("bun_tests.bzl"))
    parser.add_argument("--manifest", type=Path, default=source.with_name("Cargo.toml"))
    parser.add_argument("--graph", type=Path, default=source.parents[2] / "tools/bazel/rust/units/graph.json")
    parser.add_argument("--bun-inputs", type=Path, default=source.with_name("bun_inputs.bzl"))
    parser.add_argument("--package-targets", type=Path, default=source.parents[2] / "tools/bazel/rust/package_targets.bzl")
    arguments = parser.parse_args()
    unittest.main(argv=["wasm-artifacts-test.py"])
