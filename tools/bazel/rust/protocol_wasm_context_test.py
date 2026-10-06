"""Original source/recipe and output custody controls; no WASM execution claim."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class WasmContextTests(unittest.TestCase):
    def setUp(self):
        self.document = json.loads(arguments.context.read_bytes())
        self.provenance = json.loads(arguments.provenance.read_bytes())
        self.normalized = self.document["contexts"]["wasm32-unknown-unknown"]
        self.graph = self.document["unit_graphs"]["wasm32-unknown-unknown"]["test-release"]
        self.sdk = SimpleNamespace(host=self.provenance["execution_host"],
                                   descriptor={"version": "1.97.1"}, require_locks=Mock(),
                                   original_tree=Mock(return_value=arguments.source_root), close=Mock())
        self.oracle = SimpleNamespace(resolve=Mock(return_value={}),
                                      normalize=Mock(return_value=copy.deepcopy(self.normalized)),
                                      unit_graph=Mock(return_value=copy.deepcopy(self.graph)))
        self.loader = patch.object(generator, "load", return_value=self.oracle)
        self.loader.start()
        self.addCleanup(self.loader.stop)
        self.directory = tempfile.TemporaryDirectory(prefix="declared-wasm-context-")
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "captured.context.json"

    def capture(self, **changes):
        return producer.capture(self.sdk, arguments.source_root,
                                changes.get("provenance", self.provenance), arguments.descriptor,
                                changes.get("owner", self.provenance["producer"]), sources, generator)

    def invoke(self):
        resolver = SimpleNamespace(NativeCargoSdk=SimpleNamespace(load=Mock(return_value=self.sdk)))
        modules = {"declared_wasm_context_sdk": resolver,
                   "declared_wasm_context_sources": sources,
                   "declared_wasm_context_recipe": generator}
        argv = ["context", "--sdk-descriptor", str(arguments.descriptor),
                "--sdk-provenance", str(arguments.provenance), "--sdk-resolver", "declared-resolver",
                "--source-root", str(arguments.source_root), "--source-helper", "declared-source-helper",
                "--protocol-generator", "declared-generator", "--producer", self.provenance["producer"],
                "--output", str(self.output)]
        with patch.object(sys, "argv", argv), patch.object(producer, "load", side_effect=lambda name, path: modules[name]):
            producer.main()
        self.sdk.original_tree.assert_called_once_with(arguments.source_root)
        self.sdk.close.assert_called_once_with()

    def test_captured_original_shape_and_every_original_source(self):
        result = self.capture()
        self.assertEqual(result, self.document)
        self.assertEqual(len(self.graph["units"]), 141)
        self.assertEqual(set(result["inputs"]), {str(Path(f["path"]).resolve(strict=True).relative_to(arguments.source_root)) for f in self.provenance["source_files"]})
        self.assertEqual(result["generated_inputs"], {})
        self.assertNotIn(str(self.output), result["inputs"])

    def test_original_resolve_and_unit_graph_arguments_are_shared(self):
        self.capture()
        manifest = arguments.source_root / "Cargo.toml"
        self.oracle.resolve.assert_called_once_with(manifest, "wasm32-unknown-unknown", "1.97.1", False,
                                                   features=["merkur-e2e/wasm"], no_default_features=True, sdk=self.sdk)
        self.oracle.normalize.assert_called_once_with({}, manifest, manifest)
        self.oracle.unit_graph.assert_called_once_with(manifest, "wasm32-unknown-unknown", "1.97.1", "test",
                                                      {}, self.normalized, arguments.source_root / "packages/e2e-wasm",
                                                      features=["wasm"], library=True, sdk=self.sdk, release=True,
                                                      package="merkur-e2e", no_default_features=True)
        self.assertEqual(self.oracle.ROOT, arguments.source_root)

    def test_changed_original_source_fact_refuses_before_cargo(self):
        changed = copy.deepcopy(self.provenance)
        changed["source_files"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Changed or duplicated original native source File"):
            self.capture(provenance=changed)
        self.oracle.resolve.assert_not_called()

    def test_foreign_original_sdk_owner_refuses_before_cargo(self):
        with self.assertRaisesRegex(ValueError, "matched native SDK producer"):
            self.capture(owner="@@//foreign:source_sdk")
        self.oracle.resolve.assert_not_called()

    def test_omitted_original_source_member_refuses_before_cargo(self):
        changed = copy.deepcopy(self.provenance)
        changed["source_files"].pop()
        with self.assertRaisesRegex(ValueError, "membership changed"):
            self.capture(provenance=changed)
        self.oracle.resolve.assert_not_called()

    def test_fresh_output_keeps_golden_unchanged_and_closes_sdk(self):
        original = arguments.context.read_bytes()
        self.invoke()
        self.assertEqual(json.loads(self.output.read_bytes()), self.document)
        self.assertEqual(arguments.context.read_bytes(), original)
        self.assertEqual(self.output.read_text(), json.dumps(self.document, indent=2, sort_keys=True) + "\n")

    def test_existing_output_refuses_without_overwrite_and_closes_sdk(self):
        self.output.write_bytes(b"original source bytes")
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertEqual(self.output.read_bytes(), b"original source bytes")
        self.sdk.close.assert_called_once_with()

    def test_source_alias_output_refuses_and_keeps_original_bytes(self):
        original = arguments.context.read_bytes()
        self.output.symlink_to(arguments.context)
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(arguments.context.read_bytes(), original)
        self.sdk.close.assert_called_once_with()

    def test_existing_directory_output_refuses_and_closes_sdk(self):
        self.output.mkdir()
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertEqual(list(self.output.iterdir()), [])
        self.sdk.close.assert_called_once_with()

    def test_source_carrier_normalization_failure_closes_sdk(self):
        self.sdk.original_tree.side_effect = ValueError("changed original tree")
        with self.assertRaisesRegex(ValueError, "changed original tree"):
            self.invoke()
        self.sdk.close.assert_called_once_with()
        self.oracle.resolve.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_original_cargo_recipe_failure_closes_sdk_without_output(self):
        self.oracle.unit_graph.side_effect = RuntimeError("original declared Cargo failed")
        with self.assertRaisesRegex(RuntimeError, "original declared Cargo failed"):
            self.invoke()
        self.sdk.close.assert_called_once_with()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ["producer", "generator", "source-helper", "context", "source-root", "provenance", "descriptor", "sdk-resolver"]:
        parser.add_argument("--" + name, type=Path, required=True)
    arguments, remaining = parser.parse_known_args()
    # Presented Files may be runfile aliases; the descriptor's existing original
    # File fact determines its exact namespace, not the test's working directory.
    for name in ["producer", "generator", "source_helper", "context", "provenance", "descriptor", "sdk_resolver"]:
        setattr(arguments, name, getattr(arguments, name).resolve(strict=True))
    resolver = load("wasm_context_sdk_resolver", arguments.sdk_resolver)
    provenance = json.loads(arguments.provenance.read_bytes())
    descriptor = Path(provenance["descriptor"]["path"])
    previous = Path.cwd()
    namespace = previous
    if descriptor.is_absolute():
        if descriptor.resolve(strict=True) != arguments.descriptor:
            raise ValueError("Context controls descriptor differs from its original File")
    else:
        descriptor = resolver.NativeCargoSdk._relative_path(descriptor)
        namespace = arguments.descriptor.parents[len(descriptor.parts) - 1]
        if namespace / descriptor != arguments.descriptor:
            raise ValueError("Context controls descriptor differs from its original namespace")
    sdk = None
    try:
        os.chdir(namespace)
        sdk = resolver.NativeCargoSdk.load(descriptor)
        arguments.descriptor = descriptor
        arguments.source_root = sdk.original_tree(arguments.source_root)
        producer = load("wasm_context_producer", arguments.producer)
        generator = load("wasm_protocol_generator", arguments.generator)
        sources = load("wasm_original_source_helper", arguments.source_helper)
        unittest.main(argv=["declared-wasm-context-controls", *remaining])
    finally:
        try:
            if sdk is not None:
                sdk.close()
        finally:
            os.chdir(previous)
