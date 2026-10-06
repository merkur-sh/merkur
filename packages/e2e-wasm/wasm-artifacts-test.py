"""Declared E2E package/type joins; actual Rust/bindgen qualification is separate."""
import argparse
import json
from pathlib import Path
import re
import tomllib
import types
import unittest


class E2eWasmArtifactsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph = json.loads(arguments.graph.read_text())
        cls.cargo = tomllib.loads(arguments.manifest.read_text())

    def setUp(self):
        self.declarations = {}
        def declare(kind):
            def record(**attributes):
                name = attributes["name"]
                if name in self.declarations:
                    raise ValueError("E2E declaration collision: " + name)
                self.declarations[name] = {"kind": kind, **attributes}
            return record
        namespace = {
            "load": lambda *args: None,
            "native": types.SimpleNamespace(exports_files=lambda *args: None),
            "declare_conformance_sources": lambda: None,
        }
        for kind in ["wasm_bindings", "wasm_optimized_bindings", "wasm_package", "wasm_static_projection", "bun_test", "package_controls_test"]:
            namespace[kind] = declare(kind)
        exec(compile(arguments.bindings.read_text(), str(arguments.bindings), "exec"), namespace)
        namespace["declare_bun_tests"]()

    def test_original_release_cdylib_and_optimizer_are_preserved(self):
        binding = self.declarations["wasm_bindings"]
        self.assertEqual(binding["wasm"], "//tools/bazel/rust/units:e2e_wasm__release_wasm")
        keys = self.graph["roots"]["e2e-wasm/release/wasm32-unknown-unknown"]
        self.assertEqual(len(keys), 1)
        original = self.graph["nodes"][keys[0]]
        self.assertEqual(original["pkg_id"], "workspace:packages/e2e-wasm")
        self.assertEqual(original["target"]["src_path"], "packages/e2e-wasm/src/lib.rs")
        self.assertEqual(original["target"]["name"], binding["module_name"])
        self.assertEqual(original["platform"], "wasm32-unknown-unknown")
        self.assertEqual(original["profile"]["name"], "release")
        self.assertIs(original["emit_cdylib"], True)
        self.assertIn("cdylib", original["target"]["crate_types"])
        self.assertEqual(original["features"], [])
        optimizer = self.declarations["wasm_optimized_bindings"]
        configuration = self.cargo["package"].get("metadata", {}).get("wasm-pack", {}).get("profile", {}).get("release", {})
        self.assertEqual(optimizer["bindings"], ":wasm_bindings")
        self.assertEqual(optimizer["flags"], configuration.get("wasm-opt", ["-O"]))
        self.assertEqual(self.cargo["dependencies"]["wasm-bindgen"], "=0.2.127")

    def test_static_projection_uses_the_same_original_package_as_conformance(self):
        package = self.declarations["wasm_artifacts"]
        projection = self.declarations["wasm_static_sources"]
        self.assertEqual(package["kind"], "wasm_package")
        self.assertEqual(package["bindings"], ":wasm_optimized_bindings")
        self.assertEqual(package["crate_manifest"], ":Cargo.toml")
        self.assertEqual(package["out"], "pkg")
        self.assertEqual(projection["kind"], "wasm_static_projection")
        self.assertEqual(projection["package_tree"], ":wasm_artifacts")
        self.assertEqual(projection["module"], package["module_name"])
        self.assertEqual(projection["logical_directory"], "packages/e2e-wasm/pkg")
        self.assertIn(":wasm_artifacts", self.declarations["test__conformance.test.ts"]["data"])
        self.assertEqual(sum(row["kind"] == "wasm_package" for row in self.declarations.values()), 1)
        control = self.declarations["wasm_artifacts_test"]
        self.assertEqual(control["kind"], "package_controls_test")
        self.assertEqual(control["src"], "wasm-artifacts-test.py")
        self.assertEqual(set(control["data"]), {
            "bun_tests.bzl", "Cargo.toml", "conformance.test.ts",
            "//tools/bazel/rust/units:graph.json",
            "//apps/web:src/lib/e2e-wasm-module.ts",
            "//packages/shared:src/e2e-wasm-runtime.ts",
        })

    def test_current_browser_shared_and_conformance_imports_use_projection_destinations(self):
        projection = self.declarations["wasm_static_sources"]
        destination = Path(projection["logical_directory"]) / (projection["module"] + ".js")
        for source, logical in [
            (arguments.browser, "apps/web/src/lib/e2e-wasm-module.ts"),
            (arguments.shared, "packages/shared/src/e2e-wasm-runtime.ts"),
            (arguments.conformance, "packages/e2e-wasm/conformance.test.ts"),
        ]:
            imports = re.findall(r"from ['\"]([^'\"]+e2e_wasm\.js)['\"]", source.read_text())
            self.assertEqual(len(imports), 1, logical)
            self.assertEqual((Path("/") / logical).parent.joinpath(imports[0]).resolve().relative_to("/"), destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    source = Path(__file__).absolute()
    root = source.parents[2]
    defaults = {
        "bindings": source.with_name("bun_tests.bzl"),
        "manifest": source.with_name("Cargo.toml"),
        "graph": root / "tools/bazel/rust/units/graph.json",
        "browser": root / "apps/web/src/lib/e2e-wasm-module.ts",
        "shared": root / "packages/shared/src/e2e-wasm-runtime.ts",
        "conformance": source.with_name("conformance.test.ts"),
    }
    for name, default in defaults.items():
        parser.add_argument("--" + name, type=Path, default=default)
    arguments = parser.parse_args()
    unittest.main(argv=["wasm-artifacts-test.py"])
