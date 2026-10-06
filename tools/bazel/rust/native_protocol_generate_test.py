"""Native recipe/source mutation controls; fixtures do not qualify product execution."""
import ast
import copy
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("native_protocol_generate", Path(__file__).with_name("native_protocol_generate.py"))
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class NativeProtocolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="native-protocol-control-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "source"
        self.root.mkdir()
        self.descriptor = Path(self.directory.name) / "descriptor.json"
        self.descriptor.write_text("declared SDK descriptor fixture")
        self.original = self.root / "src/lib.rs"
        self.original.parent.mkdir()
        self.original.write_text("// original source fixture\n")
        self.sdk = SimpleNamespace(host="aarch64-apple-darwin", descriptor={"version": "1.97.1"}, require_locks=lambda paths: self.assertEqual(paths, [self.root / path for path in GENERATOR.LOCKS]))
        self.provenance = {"producer": "//fixture:original_sdk", "execution_host": self.sdk.host,
                           "descriptor": GENERATOR.fact(self.descriptor), "source_files": [GENERATOR.fact(self.original)]}
        self.inputs = {"src/lib.rs": GENERATOR.fact(self.original)["sha256"]}
        self.tools = {"contexts": {"sha256": "explicit helper fixture"}, "oracle": {"sha256": "original example helper fixture"}}
        self.documents = [{"package": scope, "inputs": self.inputs, "capture_tools": self.tools,
                           "unit_graphs": {self.sdk.host: {recipe[1]: {"roots": [0], "units": [{"features": ["default"], "rust_flags": ["--cfg", "original"], "dependencies": []}]}}},
                           "contexts": {self.sdk.host: {"packages": [{"id": "original-package"}]}}}
                          for scope, recipe in GENERATOR.RECIPES.items()]

    def validate(self, documents):
        originals = {document["package"]: document for document in self.documents}
        with patch.object(GENERATOR, "capture", side_effect=lambda scope, *args: copy.deepcopy(originals[scope])):
            GENERATOR.validate_documents(documents, None, None, self.sdk, self.root, self.inputs, self.tools)

    def test_complete_original_recipe_inventory(self):
        self.validate(copy.deepcopy(self.documents))

    def test_missing_duplicate_and_foreign_recipe_refuse(self):
        for documents in [self.documents[:-1], self.documents + [self.documents[0]], self.documents[:-1] + [dict(self.documents[-1], package="linux-retag")]]:
            with self.subTest(packages=[document["package"] for document in documents]), self.assertRaisesRegex(ValueError, "recipe inventory"):
                self.validate(documents)

    def test_feature_flags_dependency_and_root_mutations_refuse(self):
        for field, value in [("features", []), ("rust_flags", []), ("dependencies", [{"index": 0}])]:
            documents = copy.deepcopy(self.documents)
            graph = documents[0]["unit_graphs"][self.sdk.host]["test"]
            graph["units"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "default Cargo recipe"):
                self.validate(documents)
        documents = copy.deepcopy(self.documents)
        documents[0]["unit_graphs"][self.sdk.host]["test"]["roots"] = []
        with self.assertRaisesRegex(ValueError, "default Cargo recipe"):
            self.validate(documents)

    def test_normalized_metadata_and_profile_mutations_refuse(self):
        documents = copy.deepcopy(self.documents)
        documents[0]["contexts"][self.sdk.host]["packages"] = []
        with self.assertRaisesRegex(ValueError, "default Cargo recipe"):
            self.validate(documents)
        documents = copy.deepcopy(self.documents)
        documents[0]["unit_graphs"][self.sdk.host]["release"] = documents[0]["unit_graphs"][self.sdk.host].pop("test")
        with self.assertRaisesRegex(ValueError, "default Cargo recipe"):
            self.validate(documents)

    def test_source_and_helper_inventory_mutations_refuse(self):
        for field in ["inputs", "capture_tools"]:
            documents = copy.deepcopy(self.documents)
            documents[0][field] = {}
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "source/tool File inventory"):
                self.validate(documents)

    def test_original_source_membership_bytes_and_producer_binding(self):
        self.assertEqual(GENERATOR.sources(self.sdk, self.root, self.provenance, self.descriptor, "//fixture:original_sdk"), self.inputs)
        with self.assertRaisesRegex(ValueError, "SDK producer"):
            GENERATOR.sources(self.sdk, self.root, self.provenance, self.descriptor, "//foreign:forged_sdk")
        added = self.root / "added.rs"
        added.write_text("undeclared source")
        with self.assertRaisesRegex(ValueError, "membership"):
            GENERATOR.sources(self.sdk, self.root, self.provenance, self.descriptor, "//fixture:original_sdk")
        added.unlink()
        self.original.write_text("changed original")
        with self.assertRaisesRegex(ValueError, "Changed or duplicated"):
            GENERATOR.sources(self.sdk, self.root, self.provenance, self.descriptor, "//fixture:original_sdk")

    def test_relative_published_source_paths_preserve_original_fact_identity(self):
        previous = Path.cwd()
        os.chdir(self.directory.name)
        self.addCleanup(os.chdir, previous)
        relative = Path("source/src/lib.rs")
        provenance = dict(self.provenance, source_files=[GENERATOR.fact(relative)])
        self.assertEqual(GENERATOR.sources(self.sdk, self.root, provenance, self.descriptor, "//fixture:original_sdk"), self.inputs)
        self.assertEqual(provenance["source_files"][0]["path"], "source/src/lib.rs")
        self.original.write_text("changed published source")
        with self.assertRaisesRegex(ValueError, "Changed or duplicated"):
            GENERATOR.sources(self.sdk, self.root, provenance, self.descriptor, "//fixture:original_sdk")

    def test_original_source_link_cannot_resolve_outside_published_root(self):
        foreign = Path(self.directory.name) / "foreign.rs"
        foreign.write_text("outside original source Tree")
        link = self.root / "link.rs"
        link.symlink_to(foreign)
        provenance = dict(self.provenance, source_files=self.provenance["source_files"] + [GENERATOR.fact(link)])
        with self.assertRaises(ValueError):
            GENERATOR.sources(self.sdk, self.root, provenance, self.descriptor, "//fixture:original_sdk")

    def test_all_four_matched_native_hosts_preserve_original_source_authority(self):
        for host in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]:
            with self.subTest(host=host):
                self.sdk.host = host
                provenance = dict(self.provenance, execution_host=host)
                self.assertEqual(GENERATOR.sources(self.sdk, self.root, provenance, self.descriptor, "//fixture:original_sdk"), self.inputs)
                for other in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]:
                    if other != host:
                        with self.assertRaisesRegex(ValueError, "SDK producer"):
                            GENERATOR.sources(self.sdk, self.root, dict(provenance, execution_host=other), self.descriptor, "//fixture:original_sdk")
                with self.assertRaisesRegex(ValueError, "SDK producer"):
                    GENERATOR.sources(self.sdk, self.root, provenance, self.descriptor, "//foreign:forged_sdk")
                with self.assertRaisesRegex(ValueError, "descriptor File"):
                    GENERATOR.sources(self.sdk, self.root, dict(provenance, descriptor={}), self.descriptor, "//fixture:original_sdk")

    def test_unsupported_matching_hosts_refuse_before_source_or_lock_reads(self):
        for host in ["wasm32-unknown-unknown", "x86_64-pc-windows-msvc", "aarch64-apple-ios", ""]:
            with self.subTest(host=host):
                self.sdk.host = host
                self.sdk.require_locks = lambda paths: self.fail("unsupported host reached declared lock validation")
                with self.assertRaisesRegex(ValueError, "SDK producer"):
                    GENERATOR.sources(self.sdk, self.root, dict(self.provenance, execution_host=host), self.descriptor, "//fixture:original_sdk")

    def test_sdk_host_and_descriptor_drift_refuse(self):
        self.sdk.host = "x86_64-unknown-linux-gnu"
        with self.assertRaisesRegex(ValueError, "matched native SDK"):
            GENERATOR.sources(self.sdk, self.root, self.provenance, self.descriptor, "//fixture:original_sdk")
        self.sdk.host = "aarch64-apple-darwin"
        self.descriptor.write_text("another descriptor")
        with self.assertRaisesRegex(ValueError, "SDK producer"):
            GENERATOR.sources(self.sdk, self.root, self.provenance, self.descriptor, "//fixture:original_sdk")

    def test_original_native_union_uses_one_default_test_recipe(self):
        calls = []
        contexts = SimpleNamespace(resolve=lambda *args, **kwargs: {"original": "metadata"},
                                   normalize=lambda *args: {"normalized": "metadata"},
                                   unit_graph=lambda *args, **kwargs: calls.append((args, kwargs)) or {"original": "graph"})
        document = GENERATOR.capture("protocol-native", contexts, None, self.sdk, self.root, self.inputs, self.tools)
        self.assertEqual(len(calls), 1)
        args, options = calls[0]
        self.assertEqual(args[3], "test")
        self.assertEqual(args[6], self.root)
        self.assertEqual(options, {"sdk": self.sdk, "package": ["merkur-client", "merkur-client-native", "merkur-e2e", "merkur-edge", "merkur-wire"]})
        self.assertEqual(document["unit_graphs"], {self.sdk.host: {"test": {"original": "graph"}}})

    def test_selected_original_source_discovery_rejects_stale_hash(self):
        metadata = Path(self.directory.name) / "metadata.json"
        metadata.write_text(json.dumps({"members": ["workspace:fixture"], "packages": [{"id": "workspace:fixture", "source": None, "manifest": "Cargo.toml", "name": "fixture"}]}))
        source = Path(self.directory.name) / "source-inputs.json"
        discovery = {"metadata_sha256": GENERATOR.fact(metadata)["sha256"], "sources": self.inputs, "included_sources": {}, "macros": {}}
        source.write_text(json.dumps(discovery))
        runtime = Path(self.directory.name) / "runtime-inputs.json"
        runtime.write_text("{}")
        nodes = {"unit": {"pkg_id": "workspace:fixture", "target": {"src_path": "src/lib.rs"}, "mode": "test"}}
        packages = {"workspace:fixture": {"id": "workspace:fixture", "source": None, "manifest": "Cargo.toml", "name": "fixture"}}
        GENERATOR.selected_inputs(self.root, nodes, packages, metadata, source, runtime, self.inputs)
        runtime.write_text(json.dumps({"fixture": ["src/lib.rs"]}))
        with self.assertRaisesRegex(ValueError, "original source SDK File"):
            GENERATOR.selected_inputs(self.root, nodes, packages, metadata, source, runtime, {})
        runtime.write_text("{}")
        self.original.write_text("changed selected original")
        with self.assertRaisesRegex(ValueError, "stale or missing"):
            GENERATOR.selected_inputs(self.root, nodes, packages, metadata, source, runtime, self.inputs)


class NativeBindingEmissionTests(unittest.TestCase):
    def setUp(self):
        # These are source-function fixtures, not captured compiler identities.
        self.packages = {
            "client": {"name": "merkur-client", "source": None, "manifest": "packages/merkur-client/Cargo.toml"},
            "dataplane": {"name": "merkur-dataplane", "source": None, "manifest": "apps/daemon/dataplane/Cargo.toml"},
            "image": {"name": "merkur-image-worker", "source": None, "manifest": "packages/merkur-image-worker/Cargo.toml"},
        }
        def node(package, mode, name, kind, profile):
            return {"dependencies": [], "pkg_id": package, "mode": mode, "target": {"name": name, "kind": [kind]},
                    "features": ["original"], "profile": {"name": profile}, "emit_cdylib": False}
        self.nodes = {
            "protocol-test": node("client", "test", "merkur_client", "lib", "test"),
            "protocol-doc": node("client", "doctest", "merkur_client", "lib", "test"),
            "protocol-example": node("client", "build", "browser_session_oracle", "example", "test"),
            "dataplane-lib": node("dataplane", "test", "merkur_dataplane", "lib", "test"),
            "dataplane-bin": node("dataplane", "test", "merkur-dataplane", "bin", "test"),
            "image-lib": node("image", "build", "merkur_image_worker", "lib", "dev"),
            "image-bin": node("image", "build", "merkur-image-worker", "bin", "dev"),
            "oracle-dev": node("client", "build", "browser_session_oracle", "example", "dev"),
        }
        self.roots = {"protocol-native/test/aarch64-apple-darwin": ["protocol-test", "protocol-doc", "protocol-example"],
                      "dataplane-native/test/aarch64-apple-darwin": ["dataplane-lib", "dataplane-bin"],
                      "image-worker-native/dev/aarch64-apple-darwin": ["image-lib", "image-bin"],
                      "browser-session-oracle/dev/aarch64-apple-darwin": ["oracle-dev"]}
        prefix = "//tools/bazel/rust/native_protocol:u_"
        self.expected = {"native_roots": {"merkur-client/test:merkur_client": prefix + "protocol-test",
                                          "merkur-client/doctest:merkur_client": prefix + "protocol-doc",
                                          "merkur-client/build:browser_session_oracle": prefix + "protocol-example"},
                         "dataplane_lib": prefix + "dataplane-lib_binary",
                         "dataplane_bin": prefix + "dataplane-bin_binary",
                         "image_worker": prefix + "image-bin", "client_oracle": prefix + "oracle-dev"}

    def oracle_fixture(self):
        directory = tempfile.TemporaryDirectory(prefix="oracle-source-control-")
        self.addCleanup(directory.cleanup)
        source = Path(directory.name) / "source_inputs.json"
        source.write_text(json.dumps({"sources": {"packages/merkur-client/src/lib.rs": "original", "packages/merkur-client/examples/browser_session_oracle.rs": "original", "unrelated/src/lib.rs": "foreign"},
                                      "macros": {"packages/merkur-client/Cargo.toml": ["packages/merkur-client/data/original.bin"]}}))
        units = SimpleNamespace(source=lambda package: "//" + str(Path(package["manifest"]).parent),
                                source_file_label=lambda path: "//" + str(Path(path).parent) + ":" + Path(path).name,
                                starlark=lambda value: repr(value))
        return units, source

    def test_oracle_descriptor_uses_only_dev_closure_and_original_package_membership(self):
        units, source = self.oracle_fixture()
        self.nodes["oracle-dev"]["dependencies"] = [{"unit": "image-lib"}]
        bodies = GENERATOR.oracle_sources(units, self.nodes, self.roots, self.packages, source)
        descriptor = json.loads(bodies["provenance/browser_session_oracle_native.json"])
        self.assertEqual(descriptor["roots"], ["oracle-dev"])
        self.assertEqual(descriptor["compiler_label"], "//tools/bazel/rust/native_protocol:u_oracle-dev")
        self.assertEqual(set(descriptor["units"]), {"oracle-dev", "image-lib"})
        self.assertEqual(set(descriptor["packages"]), {"client", "image"})
        self.assertIn("packages/merkur-client/src/lib.rs", descriptor["source_membership"])
        self.assertIn("packages/merkur-client/data/original.bin", descriptor["source_membership"])
        self.assertNotIn("unrelated/src/lib.rs", descriptor["source_membership"])
        self.assertNotIn("tools/bazel/rust/diagnostics/oracles/browser-session-oracle.json", descriptor["source_membership"])
        self.assertIn("tools/bazel/rust/native_protocol/contexts/browser-session-oracle.json", descriptor["source_membership"])
        self.assertIn("//packages/merkur-client:rust_sources", bodies["provenance/BUILD.bazel"])
        self.assertNotIn("protocol-example", descriptor["units"])

    def test_oracle_descriptor_refuses_test_profile_and_missing_original_root(self):
        units, source = self.oracle_fixture()
        for selected in [[], ["oracle-dev", "oracle-dev"], ["protocol-example"]]:
            roots = copy.deepcopy(self.roots)
            roots["browser-session-oracle/dev/aarch64-apple-darwin"] = selected
            with self.subTest(selected=selected), self.assertRaisesRegex(ValueError, "dev"):
                GENERATOR.oracle_sources(units, self.nodes, roots, self.packages, source)

    def test_actual_root_fields_keep_test_example_and_dev_oracle_distinct(self):
        self.assertEqual(GENERATOR.native_bindings(self.nodes, self.roots, self.packages), self.expected)
        self.assertNotEqual(self.expected["native_roots"]["merkur-client/build:browser_session_oracle"], self.expected["client_oracle"])

    def test_binding_emission_preserves_every_original_raw_root_fact(self):
        units, source = self.oracle_fixture()
        units.ROOT = Path(".")
        units._unit_declarations = lambda *args: ({}, [])
        units.locked_checksums = lambda root: {}
        bodies = GENERATOR.emit(units, [], self.nodes, self.roots, self.packages, "metadata", source, "runtime")
        emitted = {node.targets[0].id: ast.literal_eval(node.value) for node in ast.parse(bodies["roots.bzl"]).body if isinstance(node, ast.Assign)}
        self.assertEqual(emitted["NATIVE_PROTOCOL_BINDINGS"], self.expected)
        expected_rows = []
        for context, keys in sorted(self.roots.items()):
            for key in keys:
                node = self.nodes[key]
                label = "//tools/bazel/rust/native_protocol:u_" + key
                expected_rows.append({"context": context, "label": label, "binary": label + "_binary" if node["mode"] == "test" else label,
                                      "owner_manifest": self.packages[node["pkg_id"]]["manifest"], "mode": node["mode"],
                                      "target": node["target"], "features": node["features"], "profile": node["profile"]})
        self.assertEqual(emitted["NATIVE_PROTOCOL_ROOTS"], expected_rows)
        self.assertEqual(json.loads(bodies["graph.json"]), {"nodes": self.nodes, "roots": self.roots})

    def test_missing_duplicate_foreign_and_wrong_mode_bindings_refuse(self):
        variants = []
        for context in self.roots:
            roots = copy.deepcopy(self.roots)
            del roots[context]
            variants.append(("missing " + context, self.nodes, roots, self.packages))
        for context in ["protocol-native/test/aarch64-apple-darwin", "dataplane-native/test/aarch64-apple-darwin", "browser-session-oracle/dev/aarch64-apple-darwin"]:
            roots = copy.deepcopy(self.roots)
            roots[context].append(roots[context][0])
            variants.append(("duplicate " + context, self.nodes, roots, self.packages))
        roots = copy.deepcopy(self.roots)
        roots["dataplane-native/test/aarch64-apple-darwin"] = ["dataplane-lib"]
        variants.append(("missing dataplane binary", self.nodes, roots, self.packages))
        roots = copy.deepcopy(self.roots)
        roots["image-worker-native/dev/aarch64-apple-darwin"] = ["image-lib"]
        variants.append(("missing image executable", self.nodes, roots, self.packages))
        roots = copy.deepcopy(self.roots)
        roots["foreign-native"] = ["oracle-dev"]
        variants.append(("foreign recipe", self.nodes, roots, self.packages))
        for key in ["protocol-test", "dataplane-lib", "image-bin", "oracle-dev"]:
            nodes = copy.deepcopy(self.nodes)
            nodes[key]["mode"] = "check"
            variants.append(("foreign compiler mode " + key, nodes, self.roots, self.packages))
        packages = copy.deepcopy(self.packages)
        packages["client"]["name"] = "foreign"
        variants.append(("foreign original package", self.nodes, self.roots, packages))
        for name, nodes, roots, packages in variants:
            with self.subTest(name=name), self.assertRaises(ValueError):
                GENERATOR.native_bindings(nodes, roots, packages)


class NativeTpmTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="native-tpm-control-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        script = self.root / "scripts/test-tpm-sim.ts"
        script.parent.mkdir()
        script.write_text("const test = Bun.spawn(" + repr(GENERATOR.TPM_CARGO_TEST) + ", {});\n")
        manifest = self.root / "packages/merkur-identity-seal/Cargo.toml"
        manifest.parent.mkdir(parents=True)
        manifest.write_text('[package]\nname = "merkur-identity-seal"\n[features]\ntpm-sim = ["dep:tpm2-protocol"]\n')
        self.sdk = SimpleNamespace(host="aarch64-apple-darwin", descriptor={"version": "1.97.1"})
        unit = {"pkg_id": GENERATOR.TPM_IDENTITY, "target": {"kind": ["lib"], "src_path": GENERATOR.TPM_SOURCE},
                "mode": "test", "features": ["tpm-sim"], "platform": None, "profile": {"name": "test"}}
        self.graph = {"execution_host": self.sdk.host, "roots": [0, 1], "units": [unit, dict(copy.deepcopy(unit), mode="doctest")]}

    def test_tpm_uses_original_feature_recipe_with_complete_native_roots(self):
        calls = []
        contexts = SimpleNamespace(resolve=lambda *args, **kwargs: calls.append(("resolve", args, kwargs)) or {"original": "metadata"},
                                   normalize=lambda *args: {"normalized": "metadata"},
                                   unit_graph=lambda *args, **kwargs: calls.append(("graph", args, kwargs)) or copy.deepcopy(self.graph))
        document = GENERATOR.capture("tpm-native", contexts, None, self.sdk, self.root, {}, {})
        self.assertEqual(calls[0][2], {"sdk": self.sdk, "features": ["merkur-identity-seal/tpm-sim"]})
        self.assertEqual(calls[1][1][3], "test")
        self.assertEqual(calls[1][1][6], self.root)
        self.assertEqual(calls[1][2], {"sdk": self.sdk, "package": ["merkur-identity-seal"], "features": ["tpm-sim"]})
        self.assertEqual(document["unit_graphs"], {self.sdk.host: {"test": self.graph}})
        self.assertEqual(GENERATOR.tpm_harnesses(self.graph, self.sdk.host), 0)

    def test_original_tpm_script_and_optional_dependency_cannot_change(self):
        script = self.root / "scripts/test-tpm-sim.ts"
        original = script.read_text()
        for before, after in [("'merkur-identity-seal'", "'other'"), ("'tpm-sim'", "'default'"), ("'--locked'", "'--release'"), ("'tpm_sim'", "'reduced'")]:
            script.write_text(original.replace(before, after))
            with self.subTest(before=before), self.assertRaisesRegex(ValueError, "Original TPM Cargo"):
                GENERATOR.tpm_recipe(self.root)
        script.write_text(original)
        manifest = self.root / "packages/merkur-identity-seal/Cargo.toml"
        manifest.write_text(manifest.read_text().replace('["dep:tpm2-protocol"]', '[]'))
        with self.assertRaisesRegex(ValueError, "feature declaration"):
            GENERATOR.tpm_recipe(self.root)

    def test_no_feature_missing_doc_foreign_source_and_profile_refuse(self):
        for field, value in [("features", []), ("mode", "build"), ("profile", {"name": "release"}),
                             ("target", {"kind": ["lib"], "src_path": "foreign/lib.rs"}), ("platform", "wasm32-unknown-unknown")]:
            graph = copy.deepcopy(self.graph)
            graph["units"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                GENERATOR.tpm_harnesses(graph, self.sdk.host)
        for roots in [[0], [1], [0, 0], [True], [-1], [100], []]:
            graph = copy.deepcopy(self.graph)
            graph["roots"] = roots
            with self.subTest(roots=roots), self.assertRaises(ValueError):
                GENERATOR.tpm_harnesses(graph, self.sdk.host)

    def test_tpm_inventory_is_independent_and_full_replay_remains_mandatory(self):
        original = {"package": "tpm-native", "inputs": {}, "capture_tools": {}, "unit_graphs": {self.sdk.host: {"test": self.graph}}}
        with patch.object(GENERATOR, "capture", return_value=copy.deepcopy(original)):
            GENERATOR.validate_documents([original], None, None, self.sdk, self.root, {}, {}, "tpm")
            for documents in [[], [original, original], [dict(original, package="protocol-native")]]:
                with self.assertRaisesRegex(ValueError, "recipe inventory"):
                    GENERATOR.validate_documents(documents, None, None, self.sdk, self.root, {}, {}, "tpm")
            changed = copy.deepcopy(original)
            changed["unit_graphs"][self.sdk.host]["test"]["roots"] = [0]
            with self.assertRaisesRegex(ValueError, "default Cargo recipe"):
                GENERATOR.validate_documents([changed], None, None, self.sdk, self.root, {}, {}, "tpm")
            with self.assertRaisesRegex(ValueError, "recipe inventory"):
                GENERATOR.validate_documents([original], None, None, self.sdk, self.root, {}, {})
            with self.assertRaisesRegex(ValueError, "recipe set"):
                GENERATOR.validate_documents([original], None, None, self.sdk, self.root, {}, {}, "foreign")

    def test_tpm_selected_source_freshness_uses_existing_boundary(self):
        selected = self.root / GENERATOR.TPM_SOURCE
        selected.parent.mkdir(parents=True, exist_ok=True)
        selected.write_text("// original selected TPM library\n")
        package = {"id": GENERATOR.TPM_IDENTITY, "source": None, "manifest": "packages/merkur-identity-seal/Cargo.toml", "name": GENERATOR.TPM_PACKAGE}
        metadata = self.root / "metadata.json"
        metadata.write_text(json.dumps({"packages": [package]}))
        source = self.root / "source-inputs.json"
        discovery = {"metadata_sha256": GENERATOR.fact(metadata)["sha256"], "sources": {GENERATOR.TPM_SOURCE: GENERATOR.fact(selected)["sha256"]}, "included_sources": {}, "macros": {}}
        source.write_text(json.dumps(discovery))
        runtime = self.root / "runtime-inputs.json"
        runtime.write_text("{}")
        node = self.graph["units"][0]
        GENERATOR.selected_inputs(self.root, {"tpm": node}, {GENERATOR.TPM_IDENTITY: package}, metadata, source, runtime, {})
        discovery["sources"] = {}
        source.write_text(json.dumps(discovery))
        with self.assertRaisesRegex(ValueError, "stale or missing"):
            GENERATOR.selected_inputs(self.root, {"tpm": node}, {GENERATOR.TPM_IDENTITY: package}, metadata, source, runtime, {})

    def test_tpm_emits_existing_declarations_under_its_separate_namespace(self):
        node = dict(self.graph["units"][0], emit_cdylib=False)
        key = "original-tpm-key"
        calls = []
        units = SimpleNamespace(ROOT=self.root, _unit_declarations=lambda *args: calls.append(args) or ([], []),
                                locked_checksums=lambda root: {}, starlark=lambda value: repr(value))
        bodies = GENERATOR.emit(units, [], {key: node}, {"tpm-native": [key]}, {GENERATOR.TPM_IDENTITY: {"source": None, "manifest": "packages/merkur-identity-seal/Cargo.toml"}}, "metadata", "sources", "runtime", "tpm")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][3:], ("metadata", "sources", "runtime"))
        self.assertIn("NATIVE_TPM_ROOTS", bodies["roots.bzl"])
        self.assertIn("//tools/bazel/rust/native_tpm:u_original-tpm-key_binary", bodies["roots.bzl"])
        self.assertNotIn("//tools/bazel/rust/native_protocol:", bodies["roots.bzl"])



class NativeSourceTreeEntryTests(unittest.TestCase):
    """Entry source/cleanup/output controls; Cargo capture/emission is not qualified by fixtures."""
    def setUp(self):
        self.private = tempfile.TemporaryDirectory(prefix="native-entry-carriers-")
        self.addCleanup(self.private.cleanup)
        self.base = Path(self.private.name).resolve()
        self.original = self.base / "original/execroot/_main"
        self.presented = self.base / "sandbox/execroot/_main"
        self.original.mkdir(parents=True)
        self.presented.mkdir(parents=True)
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        original_sys_path = list(sys.path)
        self.addCleanup(setattr, sys, "path", original_sys_path)
        self.prefix = Path("bazel-out/native/bin/sdk")
        self.source = self.prefix / "workspace.sources"
        self.descriptor = self.prefix / "workspace.descriptor.json"
        self.provenance_path = self.prefix / "workspace.provenance.json"
        self.output = self.base / "declared-output"
        files = {self.source / path: b'[[package]]\nname="original"\nversion="0.1.0"\n' for path in GENERATOR.LOCKS}
        files.update({self.source / "tools/bazel/rust/native_oracle.py": b"original oracle source",
                      self.source / "tools/bazel/rust/contexts.py": b"original context source",
                      self.prefix / "cargo": b"original cargo", self.prefix / "rustc": b"original rustc"})
        for path, body in files.items():
            target = self.original / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        os.chdir(self.original)
        descriptor = {"version": "1.97.1", "execution_host": "aarch64-apple-darwin",
                      "cargo": GENERATOR.fact(self.prefix / "cargo"), "rustc": GENERATOR.fact(self.prefix / "rustc"),
                      "sdk": [GENERATOR.fact(self.prefix / name) for name in ["cargo", "rustc"]],
                      "locks": [GENERATOR.fact(self.source / path) for path in GENERATOR.LOCKS],
                      "registry": {"directory": None, "packages": [], "files": []}}
        (self.original / self.descriptor).write_text(json.dumps(descriptor))
        self.producer = "@@//tools/bazel/rust/acquire:workspace_sdk_darwin_arm64"
        self.provenance = {"execution_host": descriptor["execution_host"], "producer": self.producer,
                           "descriptor": GENERATOR.fact(self.descriptor),
                           "source_files": [GENERATOR.fact(path) for path in files if path.is_relative_to(self.source)]}
        (self.original / self.provenance_path).write_text(json.dumps(self.provenance))
        for path in [*files, self.descriptor, self.provenance_path]:
            target = self.presented / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(self.original / path)
        os.chdir(self.presented)
        spec = importlib.util.spec_from_file_location("native_entry_sdk", Path(__file__).with_name("acquisition_sdk.py"))
        self.resolver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.resolver)
        def identity(argv, **kwargs):
            self.assertEqual(kwargs["env"], {"PATH": ""})
            return SimpleNamespace(stdout=Path(argv[0]).name + " 1.97.1\nrelease: 1.97.1\nhost: aarch64-apple-darwin\n")
        with patch.object(self.resolver.subprocess, "run", side_effect=identity):
            self.sdk = self.resolver.NativeCargoSdk.load(self.descriptor)
        self.addCleanup(self.sdk.close)
        self.root = self.original / self.source
        self.units = SimpleNamespace()
        self.loaded = []

    def arguments(self, precreated=False):
        arguments = ["native", "--capture", "--producer", self.producer]
        paths = {"sdk-descriptor": self.descriptor, "sdk-provenance": self.provenance_path,
                 "source-root": self.source, "contexts-helper": self.source / "tools/bazel/rust/contexts.py",
                 "output": self.output}
        for name in ["sdk-descriptor", "sdk-provenance", "sdk-resolver", "source-root", "contexts-helper", "unit-emitter", "metadata", "source-inputs", "runtime-inputs", "output"]:
            arguments += ["--" + name, str(paths.get(name, self.descriptor))]
        if precreated:
            arguments.append("--engine-precreated-tree-roots")
        return arguments

    def run_entry(self, *, precreated=False, oracle_failure=False):
        def load(name, path):
            self.loaded.append((name, path))
            if name == "declared_native_sdk":
                return SimpleNamespace(NativeCargoSdk=SimpleNamespace(load=lambda path: self.sdk))
            if name == "original_native_session_oracle":
                self.assertEqual(path, self.root / "tools/bazel/rust/native_oracle.py")
                if oracle_failure:
                    raise ValueError("declared oracle refused")
            if name == "declared_native_units":
                return self.units
            return SimpleNamespace()
        def capture(scope, contexts, oracle, sdk, root, inputs, tools):
            self.assertEqual(root, self.root)
            self.assertEqual(set(inputs), {str(Path(row["path"]).relative_to(self.source)) for row in self.provenance["source_files"]})
            return {"package": scope}
        with patch.object(sys, "argv", self.arguments(precreated)), patch.object(GENERATOR, "load", side_effect=load), patch.object(GENERATOR, "capture", side_effect=capture), patch.object(GENERATOR, "validate_documents"), patch.object(GENERATOR, "collect_documents", return_value=({}, {}, {})), patch.object(GENERATOR, "selected_inputs"), patch.object(GENERATOR, "emit", return_value={"BUILD.bazel": "fixture declaration"}):
            GENERATOR.main()

    def test_source_carriers_are_normalized_before_oracle_and_emitter(self):
        with patch.object(self.sdk, "close", wraps=self.sdk.close) as close:
            self.run_entry()
            close.assert_called_once_with()
        self.assertEqual(self.units.ROOT, self.root)
        self.assertEqual(self.units.HERE, self.root / "tools/bazel/rust")
        self.assertEqual((self.output / "BUILD.bazel").read_text(), "fixture declaration")

    def test_rejected_source_tree_closes_sdk_before_oracle(self):
        foreign = self.base / "foreign-source"
        self.root.rename(foreign)
        self.root.symlink_to(foreign, target_is_directory=True)
        with patch.object(self.sdk, "close", wraps=self.sdk.close) as close:
            with self.assertRaisesRegex(ValueError, "original declared Tree is an alias"):
                self.run_entry()
            close.assert_called_once_with()
        self.assertEqual([name for name, _ in self.loaded], ["declared_native_sdk"])

    def test_oracle_load_failure_closes_sdk_without_output(self):
        with patch.object(self.sdk, "close", wraps=self.sdk.close) as close:
            with self.assertRaisesRegex(ValueError, "declared oracle refused"):
                self.run_entry(oracle_failure=True)
            close.assert_called_once_with()
        self.assertFalse(self.output.exists())

    def test_precreated_empty_declared_output_publishes(self):
        self.output.mkdir()
        self.run_entry(precreated=True)
        self.assertEqual((self.output / "BUILD.bazel").read_text(), "fixture declaration")

    def test_precreated_output_requires_explicit_flag_and_empty_ordinary_root(self):
        self.output.mkdir()
        with self.assertRaises(FileExistsError):
            self.run_entry()
        (self.output / "foreign.txt").write_text("retained foreign output")
        with self.assertRaisesRegex(ValueError, "empty declared TreeArtifact"):
            self.run_entry(precreated=True)
        self.assertEqual((self.output / "foreign.txt").read_text(), "retained foreign output")
        (self.output / "foreign.txt").unlink()
        self.output.rmdir()
        foreign = self.base / "foreign-output"
        foreign.mkdir()
        self.output.symlink_to(foreign, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "ordinary declared TreeArtifact"):
            self.run_entry(precreated=True)
        self.assertEqual(list(foreign.iterdir()), [])

if __name__ == "__main__":
    unittest.main()
