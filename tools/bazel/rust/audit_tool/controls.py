"""Test original cargo-audit acquisition and refuse malformed compiler captures."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class OriginalControls(unittest.TestCase):
    def test_linked_build_script_metadata_edge(self):
        script = {"pkg_id": "aws-lc-rs", "mode": "build", "target": {"kind": ["custom-build"]}}
        linked = {"pkg_id": "aws-lc-sys", "mode": "run-custom-build", "target": {"kind": ["custom-build"]}}
        unit = {"pkg_id": "aws-lc-rs", "mode": "run-custom-build", "dependencies": [
            {"unit": "script", "extern_crate_name": "build_script_build"},
            {"unit": "linked", "extern_crate_name": "build_script_main"},
        ]}
        nodes = {"script": script, "linked": linked}
        packages = {"aws-lc-sys": {"links": "aws_lc_0_40_0"}}
        self.assertEqual(GENERATOR.dependencies(unit, nodes, packages),
                         ([], [], {}, {}, ":u_script", [":u_linked"]))
        packages["aws-lc-sys"]["links"] = None
        with self.assertRaisesRegex(ValueError, "linked dependency"):
            GENERATOR.dependencies(unit, nodes, packages)
        packages["aws-lc-sys"]["links"] = "aws_lc_0_40_0"
        nodes["script"]["pkg_id"] = "other"
        with self.assertRaisesRegex(ValueError, "build-script compiler"):
            GENERATOR.dependencies(unit, nodes, packages)

    def test_original_library_and_binary_roots(self):
        roots = [
            {"pkg_id": "workspace:.", "mode": "build", "features": ["binary-scanning", "default"],
             "target": {"name": name, "kind": [kind], "crate_types": [kind], "src_path": path}}
            for name, kind, path in [("cargo_audit", "lib", "src/lib.rs"),
                                     ("cargo-audit", "bin", "src/bin/cargo-audit/main.rs")]
        ]
        self.assertIs(ORIGINAL.native_binary(roots), roots[1])
        self.assertIs(ORIGINAL.native_binary(list(reversed(roots))), roots[1])
        mutations = [roots[:1], roots[1:], roots + [roots[1]]]
        for field, replacement in [("name", "other-bin"), ("src_path", "src/other.rs"),
                                   ("crate_types", ["lib"]), ("kind", ["example"])]:
            value = copy.deepcopy(roots)
            value[1]["target"][field] = replacement
            mutations.append(value)
        for field, replacement in [("pkg_id", "workspace:other"), ("mode", "test"),
                                   ("features", ["default"])]:
            value = copy.deepcopy(roots)
            value[1][field] = replacement
            mutations.append(value)
        for value in mutations:
            with self.subTest(roots=value), self.assertRaises(ValueError):
                ORIGINAL.native_binary(value)

    def test_original_published_selection(self):
        files, catalog = ORIGINAL.original(ARGS.archive)
        manifest = tomllib.loads(files["Cargo.toml"].decode())
        self.assertEqual(len(files), 24)
        self.assertEqual(len(catalog), 398)
        self.assertEqual(manifest["bin"], [{"name": "cargo-audit", "path": "src/bin/cargo-audit/main.rs"}])
        self.assertEqual(manifest["features"]["default"], ["binary-scanning"])
        self.assertNotIn("profile", manifest)
        self.assertNotIn("lints", manifest)

    def test_catalog_and_labels_are_fresh(self):
        value = ORIGINAL.document(ARGS.archive)
        self.assertEqual(ARGS.catalog.read_text(), json.dumps(value, indent=2) + "\n")
        self.assertEqual(ARGS.declarations.read_text(), ORIGINAL.declarations(value))

    def test_all_original_locked_archives(self):
        catalog = ORIGINAL.document(ARGS.archive)["registry"]
        actual = json.loads(ARGS.registry_manifest.read_text())
        expected = {entry["name"] + "@" + entry["version"]: entry["sha256"] for entry in catalog}
        self.assertEqual(set(actual), set(expected))
        for identity, checksum in expected.items():
            self.assertEqual(hashlib.sha256(Path(actual[identity]).read_bytes()).hexdigest(), checksum, identity)

    def test_corrupt_original_refused_before_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "corrupt.crate"
            archive.write_bytes(ARGS.archive.read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "original published"):
                ORIGINAL.document(archive)
            self.assertEqual(sorted(path.name for path in Path(temporary).iterdir()), ["corrupt.crate"])

    def test_original_parse_uses_same_captured_bytes(self):
        data = ARGS.archive.read_bytes()

        class Once:
            calls = 0

            def read_bytes(self):
                self.calls += 1
                if self.calls != 1:
                    raise AssertionError("archive was reread after checksum validation")
                return data

        archive = Once()
        self.assertEqual(len(ORIGINAL.original(archive)[0]), 24)
        self.assertEqual(archive.calls, 1)

    def test_capture_refusals_precede_emission(self):
        expected = ORIGINAL.document(ARGS.archive)
        document = {
            "package": "cargo-audit",
            "mode": "release",
            "platform": "native",
            "original_source": {
                "name": ORIGINAL.NAME, "version": ORIGINAL.VERSION,
                "archive_sha256": ORIGINAL.SHA256,
                "cargo_lock_sha256": expected["source_files"]["Cargo.lock"]["sha256"],
            },
            "inputs": {name: fact["sha256"] for name, fact in expected["source_files"].items()},
            "contexts": {"aarch64-apple-darwin": {}},
            "unit_graphs": {"aarch64-apple-darwin": {"release": {}}},
        }

        class NoEmission:
            def collect(self, _documents):
                raise AssertionError("invalid source authority reached compiler emission")

        mutations = []
        value = copy.deepcopy(document)
        del value["inputs"]["src/bin/cargo-audit/main.rs"]
        mutations.append((value, "source membership"))
        value = copy.deepcopy(document)
        value["original_source"]["version"] = "0.22.1"
        mutations.append((value, "original archive"))
        value = copy.deepcopy(document)
        value["contexts"] = {"x86_64-pc-windows-msvc": {}}
        value["unit_graphs"] = {"x86_64-pc-windows-msvc": {"release": {}}}
        mutations.append((value, "native host"))
        value = copy.deepcopy(document)
        value["unit_graphs"]["aarch64-apple-darwin"] = {"test": {}}
        mutations.append((value, "release graph"))
        value = copy.deepcopy(document)
        value["contexts"] = {}
        value["unit_graphs"] = {}
        mutations.append((value, "native release graph"))
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "context.json"
            for value, failure in mutations:
                with self.subTest(failure=failure):
                    source.write_text(json.dumps(value))
                    with self.assertRaisesRegex(ValueError, failure):
                        GENERATOR.emit([source], ARGS.archive, ORIGINAL, NoEmission(), None)
                    self.assertEqual(sorted(path.name for path in Path(temporary).iterdir()), ["context.json"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ["archive", "original", "generator", "catalog", "declarations", "registry-manifest"]:
        parser.add_argument("--" + flag, type=Path, required=True)
    ARGS = parser.parse_args()
    ORIGINAL = load("audit_original", ARGS.original)
    GENERATOR = load("audit_generator", ARGS.generator)
    unittest.main(argv=[sys.argv[0]])
