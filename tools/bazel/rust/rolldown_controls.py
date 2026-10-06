#!/usr/bin/env python3
"""Affected original-source and native-publication controls.

Compiler qualification is separate: synthetic metadata here only tests refusal
and byte preservation at the publisher boundary.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class RolldownControls(unittest.TestCase):
    def test_cmake_tools_belong_to_the_exact_original_allocator_run_unit(self):
        package = {"name": "libmimalloc-sys2", "version": "0.1.60", "source": generator.REGISTRY}
        self.assertEqual(generator.native_build(package, {"mode": "run-custom-build"}), "cmake")
        self.assertIsNone(generator.native_build(package, {"mode": "build"}))
        self.assertIsNone(generator.native_build(dict(package, name="other"), {"mode": "run-custom-build"}))
        with self.assertRaisesRegex(ValueError, "unmodeled"):
            generator.native_build(dict(package, version="0.1.61"), {"mode": "run-custom-build"})
        with self.assertRaisesRegex(ValueError, "unmodeled"):
            generator.native_build(dict(package, source=None), {"mode": "run-custom-build"})

    def lto_unit(self, types, dependencies=(), host=False, lto="fat"):
        return {"target": {"crate_types": types, "kind": ["custom-build"] if host else ["lib"]},
                "mode": "build", "profile": {"lto": lto},
                "dependencies": [{"unit": key} for key in dependencies]}

    def test_mixed_original_root_preserves_bitcode_and_excludes_host_tools(self):
        nodes = {"root": self.lto_unit(["lib", "cdylib"], ["ordinary", "script"]),
                 "ordinary": self.lto_unit(["lib"]),
                 "script": self.lto_unit(["bin"], ["host-dependency"], host=True),
                 "host-dependency": self.lto_unit(["lib"])}
        self.assertEqual(generator.effective_lto(nodes, {"context": ["root"]}),
                         {"root": "object+bitcode", "ordinary": "object+bitcode",
                          "script": "object", "host-dependency": "object"})

    def test_actual_link_lto_uses_bitcode_only_dependencies(self):
        nodes = {"root": self.lto_unit(["cdylib"], ["ordinary", "dynamic"]),
                 "ordinary": self.lto_unit(["lib"]),
                 "dynamic": self.lto_unit(["dylib"])}
        self.assertEqual(generator.effective_lto(nodes, {"context": ["root"]}),
                         {"root": "run:fat", "ordinary": "bitcode", "dynamic": "object"})

    def test_shared_bitcode_object_requirements_propagate_after_merge(self):
        nodes = {"mixed": self.lto_unit(["lib", "cdylib"], ["shared"]),
                 "linked": self.lto_unit(["bin"], ["shared"]),
                 "shared": self.lto_unit(["lib"], ["leaf"]),
                 "leaf": self.lto_unit(["lib"])}
        actual = generator.effective_lto(nodes, {"context": ["mixed", "linked"]})
        self.assertEqual(actual["shared"], "object+bitcode")
        self.assertEqual(actual["leaf"], "object+bitcode")
        self.assertEqual(actual["linked"], "run:fat")

    def test_explicit_lto_off_reaches_dependencies(self):
        nodes = {"root": self.lto_unit(["bin"], ["ordinary"], lto="off"),
                 "ordinary": self.lto_unit(["lib"])}
        self.assertEqual(generator.effective_lto(nodes, {"context": ["root"]}),
                         {"root": "off", "ordinary": "off"})

    def test_original_files_keep_hidden_configuration_and_package_boundaries(self):
        packages = source.source_packages(archive, original)
        inventory = [(package + "/" if package else "") + file
                     for package, configuration in packages.items() for file in configuration["files"]]
        self.assertEqual(len(inventory), len(set(inventory)))
        self.assertIn(".cargo/config.toml", inventory)
        self.assertIn("Cargo.lock", inventory)
        self.assertIn("src/module-preload-polyfill.js", packages["crates/rolldown_plugin_vite_module_preload_polyfill"]["files"])
        self.assertNotIn("crates/rolldown_binding/Cargo.toml", packages[""]["files"])
        self.assertEqual(source.render(packages), inventory_file.read_text())

    def test_source_digest_mutation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            altered = Path(temporary) / "altered.tar.gz"
            contents = bytearray(archive.read_bytes())
            contents[-1] ^= 1
            altered.write_bytes(contents)
            with self.assertRaisesRegex(ValueError, "original commit"):
                source.source_packages(altered, original)

    def test_original_lint_priority_precedes_specific_overrides(self):
        packages = source.source_packages(archive, original)
        clippy = packages["crates/rolldown_binding"]["lints"]["clippy"]
        order = list(clippy)
        self.assertLess(order.index("pedantic"), order.index("missing_errors_doc"))
        self.assertLess(order.index("nursery"), order.index("missing_const_for_fn"))
        self.assertEqual(clippy["pedantic"], "deny")
        self.assertEqual(clippy["missing_errors_doc"], "allow")

    def test_actual_original_native_bytes_and_architecture(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "binding.node"
            acquisition.publish_binding(library, output, "aarch64-apple-darwin")
            self.assertEqual(hashlib.sha256(output.read_bytes()).digest(), hashlib.sha256(library.read_bytes()).digest())
            self.assertEqual(output.stat().st_mode & 0o777, 0o555)
            with self.assertRaisesRegex(ValueError, "selected native"):
                acquisition.publish_binding(library, Path(temporary) / "wrong.node", "x86_64-apple-darwin")

    def test_definition_publisher_refuses_missing_and_extra_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tree = root / "types"
            tree.mkdir()
            with self.assertRaisesRegex(ValueError, "exact NAPI"):
                acquisition.publish_metadata(tree, root / "missing.jsonl")
            (tree / "rolldown_binding").write_text('{"kind":"struct","name":"ActualCompilerRecord"}\n')
            (tree / "extra").write_text('{}\n')
            with self.assertRaisesRegex(ValueError, "exact NAPI"):
                acquisition.publish_metadata(tree, root / "extra.jsonl")

    def test_definition_publisher_preserves_records_and_refuses_nonobjects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tree = root / "types"
            tree.mkdir()
            records = b'{"kind":"struct","name":"BoundaryFixture"}\n'
            member = tree / "rolldown_binding"
            member.write_bytes(records)
            acquisition.publish_metadata(tree, root / "records.jsonl")
            self.assertEqual((root / "records.jsonl").read_bytes(), records)
            member.write_bytes(b'[]\n')
            with self.assertRaisesRegex(ValueError, "invalid"):
                acquisition.publish_metadata(tree, root / "nonobject.jsonl")

    def test_definition_publisher_rejects_authored_leaf_alias_and_accepts_tree_carrier(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tree = root / "types"
            tree.mkdir()
            records = b'{"kind":"struct","name":"BoundaryFixture"}\n'
            outside = root / "outside"
            outside.write_bytes(records)
            member = tree / "rolldown_binding"
            member.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "exact NAPI"):
                acquisition.publish_metadata(tree, root / "alias.jsonl")
            member.unlink()
            member.write_bytes(records)
            carrier = root / "engine-tree-carrier"
            carrier.symlink_to(tree, target_is_directory=True)
            acquisition.publish_metadata(carrier, root / "carrier.jsonl")
            self.assertEqual((root / "carrier.jsonl").read_bytes(), records)

    def test_all_original_registry_packages_have_locked_checksums(self):
        checksums = generator.original_lock(archive, original)
        self.assertEqual(len(checksums), 354)
        self.assertTrue(all(len(checksum) == 64 for checksum in checksums.values()))
        self.assertEqual(len({key[2] for key in checksums}), 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--source-helper", type=Path, required=True)
    parser.add_argument("--acquisition-helper", type=Path, required=True)
    parser.add_argument("--generator", type=Path, required=True)
    parser.add_argument("--source-instances", type=Path, required=True)
    parser.add_argument("--source-instance", required=True)
    args = parser.parse_args()
    global archive, library, inventory_file, source, acquisition, generator, original
    original = json.loads(args.source_instances.read_text())[args.source_instance]
    archive, library, inventory_file = args.archive, args.library, args.inventory
    source = load("declared_rolldown_source", args.source_helper)
    acquisition = load("declared_rolldown_acquisition", args.acquisition_helper)
    generator = load("declared_rolldown_generator", args.generator)
    unittest.main(argv=[str(Path(__file__))])


if __name__ == "__main__":
    main()
