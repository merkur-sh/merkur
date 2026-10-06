"""Focused protocol graph/source bindings; no fixture claims WASM execution."""
import argparse
import copy
import importlib.util
import json
import os
import stat
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load(path):
    specification = importlib.util.spec_from_file_location("protocol_generator", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class ProtocolGraphTests(unittest.TestCase):
    def setUp(self):
        self.document = json.loads(arguments.context.read_text())
        self.provenance = json.loads(arguments.provenance.read_text())
        self.sdk = SimpleNamespace(host="aarch64-apple-darwin", require_locks=Mock(), descriptor={"version": "1.97.1"})
        self.graph = self.document["unit_graphs"]["wasm32-unknown-unknown"]["test-release"]
        self.root = self.graph["units"][self.graph["roots"][0]]
        self.oracle = SimpleNamespace(resolve=Mock(return_value={}),
                                      normalize=Mock(return_value=copy.deepcopy(self.document["contexts"]["wasm32-unknown-unknown"])),
                                      unit_graph=Mock(return_value=copy.deepcopy(self.graph)))
        self.loader = patch.object(generator, "load", return_value=self.oracle)
        self.loader.start()
        self.addCleanup(self.loader.stop)

    def validate(self, **overrides):
        generator.validate(self.document, self.sdk, arguments.source_root, self.provenance,
                           overrides.get("descriptor", arguments.descriptor),
                           overrides.get("producer", self.provenance["producer"]))

    def test_actual_original_library_test_context_and_all_locks(self):
        self.validate()
        self.sdk.require_locks.assert_called_once_with([arguments.source_root / path for path in generator.LOCKS])
        self.assertEqual(len(self.graph["units"]), 141)
        self.assertEqual(self.root["features"], ["wasm"])
        self.assertEqual(self.root["mode"], "test")
        self.oracle.unit_graph.assert_called_once_with(
            arguments.source_root / "Cargo.toml", "wasm32-unknown-unknown", "1.97.1", "test",
            {}, self.document["contexts"]["wasm32-unknown-unknown"],
            arguments.source_root / "packages/e2e-wasm", features=["wasm"], library=True,
            sdk=self.sdk, release=True, package="merkur-e2e", no_default_features=True)

    def test_generated_package_declares_all_original_static_inputs(self):
        class Units:
            ROOT = arguments.source_root
            _unit_declarations = staticmethod(lambda *args: ({}, []))
            locked_checksums = staticmethod(lambda *args: {})
        root = {"emit_cdylib": False, "pkg_id": "workspace:packages/merkur-e2e"}
        build, _ = generator.declarations(Units, {"genuine": root}, {"root": ["genuine"]},
                                          {root["pkg_id"]: {"source": None}},
                                          Path("metadata"), Path("source"), Path("runtime"))
        self.assertIn('exports_files(["BUILD.bazel", "context.json", "graph.json", "archives.MODULE.bazel"])', build)
        self.assertIn('filegroup(name = "verification_inputs", srcs = ["BUILD.bazel", "context.json", "graph.json", "archives.MODULE.bazel"])', build)

    def test_build_library_cannot_stand_in_for_test_harness(self):
        self.root["mode"] = "build"
        with self.assertRaisesRegex(ValueError, "library test harness"):
            self.validate()

    def test_default_features_cannot_stand_in_for_original_wasm(self):
        self.root["features"] = ["default", "std", "wasm"]
        with self.assertRaisesRegex(ValueError, "original features"):
            self.validate()

    def test_dev_profile_cannot_stand_in_for_release(self):
        self.root["profile"]["name"] = "test"
        with self.assertRaisesRegex(ValueError, "release profile"):
            self.validate()

    def test_omitted_original_simd_context_is_rejected(self):
        self.root["rust_flags"] = ["--cfg", 'getrandom_backend="wasm_js"']
        with self.assertRaisesRegex(ValueError, "source-bound Cargo recipe"):
            self.validate()

    def test_later_simd_override_cannot_change_original_recipe(self):
        self.root["rust_flags"] += ["-C", "target-feature=-simd128"]
        with self.assertRaisesRegex(ValueError, "source-bound Cargo recipe"):
            self.validate()

    def test_dependency_profile_cannot_change_original_recipe(self):
        dependency = next(unit for unit in self.graph["units"] if unit is not self.root)
        dependency["profile"]["opt_level"] = "0"
        with self.assertRaisesRegex(ValueError, "source-bound Cargo recipe"):
            self.validate()

    def test_host_flags_cannot_inherit_target_flags(self):
        host = next(unit for unit in self.graph["units"] if unit["platform"] is None)
        host["rust_flags"] = list(self.root["rust_flags"])
        with self.assertRaisesRegex(ValueError, "source-bound Cargo recipe"):
            self.validate()

    def test_foreign_native_acquisition_host_is_rejected(self):
        self.graph["execution_host"] = "x86_64-unknown-linux-gnu"
        with self.assertRaisesRegex(ValueError, "execution host"):
            self.validate()

    def test_changed_original_source_fact_is_rejected(self):
        self.document["inputs"]["Cargo.toml"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Changed original"):
            self.validate()

    def test_missing_original_source_inventory_is_rejected(self):
        self.document["inputs"].pop("Cargo.toml")
        with self.assertRaisesRegex(ValueError, "source SDK inventory"):
            self.validate()

    def test_foreign_producer_and_descriptor_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "producer/descriptor"):
            self.validate(producer="//foreign:authority")
        self.provenance["descriptor"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "producer/descriptor"):
            self.validate()

    def test_multiple_roots_cannot_mask_extra_test_coverage(self):
        self.graph["roots"] += self.graph["roots"]
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.validate()


    def test_relative_declared_source_facts_match_the_original_inventory(self):
        parent = arguments.source_root.parent
        self.provenance["source_files"] = [
            {**fact, "path": str(Path(fact["path"]).relative_to(parent))}
            for fact in self.provenance["source_files"]
        ]
        before = Path.cwd()
        try:
            os.chdir(parent)
            self.validate()
        finally:
            os.chdir(before)

    def run_main_boundary(self, fail_normalization=False):
        with tempfile.TemporaryDirectory(prefix="protocol-source-carrier-") as temporary:
            source_carrier = Path(temporary) / "carrier"
            source_carrier.mkdir()
            sdk = SimpleNamespace(
                original_tree=Mock(return_value=arguments.source_root), close=Mock())
            if fail_normalization:
                sdk.original_tree.side_effect = ValueError("foreign declared source Tree")
            values = {name.replace("-", "_"): Path("unused") for name in
                      ["sdk-resolver", "unit-emitter", "metadata", "source-inputs", "runtime-inputs", "output"]}
            values.update(context=arguments.context, sdk_descriptor=arguments.descriptor,
                          sdk_provenance=arguments.provenance, source_root=source_carrier,
                          producer=self.provenance["producer"], engine_precreated_tree_roots=False)
            opts = SimpleNamespace(**values)
            validator = Mock(side_effect=ValueError("stop before Cargo"))
            resolver = SimpleNamespace(NativeCargoSdk=SimpleNamespace(load=Mock(return_value=sdk)))
            with patch.object(generator.argparse.ArgumentParser, "parse_args", return_value=opts), \
                 patch.object(generator, "load", return_value=resolver), \
                 patch.object(generator, "validate", validator):
                with self.assertRaisesRegex(ValueError, "foreign declared source Tree" if fail_normalization else "stop before Cargo"):
                    generator.main()
            sdk.original_tree.assert_called_once_with(source_carrier)
            sdk.close.assert_called_once_with()
            if fail_normalization:
                validator.assert_not_called()
            else:
                self.assertEqual(validator.call_args.args[2], arguments.source_root)

    def test_main_normalizes_the_declared_carrier_before_original_validation_and_closes(self):
        self.run_main_boundary()

    def test_failed_source_normalization_still_closes_the_declared_sdk(self):
        self.run_main_boundary(fail_normalization=True)



class ProtocolOutputTests(unittest.TestCase):
    def test_fresh_scratch_output_preserves_original_file_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            bodies = {"BUILD.bazel": b"build", "context.json": arguments.context.read_bytes()}
            generator.publish(output, bodies)
            self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, bodies)
            with self.assertRaises(FileExistsError):
                generator.publish(output, bodies)

    def test_explicit_engine_created_empty_ordinary_output_retains_its_inode(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            output.mkdir()
            before = output.stat()
            generator.publish(output, {"context.json": arguments.context.read_bytes()}, True)
            self.assertEqual(output.stat().st_ino, before.st_ino)
            self.assertEqual(output.stat().st_mode, before.st_mode)
            self.assertEqual((output / "context.json").read_bytes(), arguments.context.read_bytes())

    def test_engine_created_output_refuses_missing_occupied_and_special_mode_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "output"
            with self.assertRaises(FileNotFoundError):
                generator.publish(output, {"context.json": b"body"}, True)
            output.mkdir()
            original = output / "original"
            original.write_bytes(b"keep")
            with self.assertRaisesRegex(ValueError, "empty ordinary"):
                generator.publish(output, {"context.json": b"body"}, True)
            self.assertEqual(original.read_bytes(), b"keep")
            original.unlink()
            output.chmod(stat.S_ISVTX | 0o755)
            with self.assertRaisesRegex(ValueError, "empty ordinary"):
                generator.publish(output, {"context.json": b"body"}, True)
            self.assertEqual(list(output.iterdir()), [])

    def test_engine_created_output_alias_cannot_write_to_its_referent(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "target"
            target.mkdir()
            output = Path(temporary) / "output"
            output.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "empty ordinary"):
                generator.publish(output, {"context.json": b"body"}, True)
            self.assertEqual(list(target.iterdir()), [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ["generator", "context", "source-root", "provenance", "descriptor"]:
        parser.add_argument("--" + name, type=Path, required=True)
    arguments = parser.parse_args()
    generator = load(arguments.generator)
    unittest.main(argv=["protocol_wasm_generate_test.py"])
