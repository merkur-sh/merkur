"""Controls over the genuine captured stock metadata/configured Cargo graph."""
import copy
import importlib.util
import hashlib
import io
import os
import tarfile
from unittest import mock
import json
from pathlib import Path
import sys
import tempfile
import unittest

base = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location("graph", base / "stdlib-native-graph.py")
graph = importlib.util.module_from_spec(spec)
spec.loader.exec_module(graph)
fixture = Path(sys.argv.pop(1))
raw = json.loads((fixture / "units.json").read_text())
records = [graph.metadata_root(p.read_text()) for p in sorted(fixture.glob("metadata-*.txt"))]
target = "aarch64-apple-darwin"

class StockGraphTests(unittest.TestCase):
    def rejects(self, units=None, metadata=None, native=target):
        with self.assertRaises(ValueError):
            graph.relation(units if units is not None else raw,
                           metadata if metadata is not None else records, native)

    def test_real_complete_graph(self):
        associations = graph.relation(raw, records, target)
        self.assertEqual(len(associations), 27)
        self.assertEqual(len({a["pkg_id"] for a in associations}), 27)
        self.assertTrue(any(a["identity"].startswith("std-") for a in associations))

    def test_missing_stock_metadata(self):
        self.rejects(metadata=records[:-1])

    def test_duplicate_stock_identity(self):
        self.rejects(metadata=records + records[:1])

    def test_foreign_stock_target(self):
        changed = copy.deepcopy(records)
        changed[0]["target"] = "x86_64-apple-darwin"
        self.rejects(metadata=changed)

    def test_changed_stock_dependency_hash(self):
        changed = copy.deepcopy(records)
        member = next(v for v in changed if v["dependencies"])
        member["dependencies"][0]["hash"] = "f" * 32
        self.rejects(metadata=changed)

    def test_dependency_outside_configured_closure(self):
        changed = copy.deepcopy(raw)
        core = next(i for i,v in enumerate(changed["units"]) if v["target"]["name"] == "core")
        for unit in changed["units"]:
            unit["dependencies"] = [d for d in unit["dependencies"] if d["index"] != core]
        self.rejects(units=changed)

    def test_changed_configured_edition(self):
        changed = copy.deepcopy(raw)
        next(v for v in changed["units"] if v["target"]["name"] == "std")["target"]["edition"] = "2015"
        self.rejects(units=changed)

    def test_invalid_configured_edge(self):
        changed = copy.deepcopy(raw)
        next(v for v in changed["units"] if v["dependencies"])["dependencies"][0]["index"] = -1
        self.rejects(units=changed)

    def test_duplicate_configured_library(self):
        changed = copy.deepcopy(raw)
        changed["units"].append(copy.deepcopy(next(v for v in changed["units"] if v["target"]["name"] == "std")))
        self.rejects(units=changed)

    def test_missing_source_identity(self):
        changed = copy.deepcopy(raw)
        next(v for v in changed["units"] if v["target"]["name"] == "std")["pkg_id"] = ""
        self.rejects(units=changed)

    def test_wrong_distribution_features(self):
        changed = copy.deepcopy(raw)
        changed["units"][changed["roots"][0]]["features"].remove("profiler")
        self.rejects(units=changed)

    def test_wrong_distribution_profile(self):
        changed = copy.deepcopy(raw)
        changed["units"][changed["roots"][0]]["profile"]["name"] = "release"
        self.rejects(units=changed)

    def test_wrong_sysroot(self):
        changed = copy.deepcopy(raw)
        changed["roots"] = [0]
        self.rejects(units=changed)

    def test_unsupported_platform(self):
        self.rejects(native="wasm32-wasip1")

    def test_changed_or_aliased_metadata_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "original.rmeta"
            path.write_bytes(b"original")
            original = graph.fact(path)
            path.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                graph.checked_fact(original)
            alias = Path(temporary) / "alias.rmeta"
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                graph.fact(alias)

    def test_repeated_embedded_metadata_field(self):
        body = next(fixture.glob("metadata-*.txt")).read_text()
        with self.assertRaises(ValueError):
            graph.metadata_root(body.replace("Crate info:", "Crate info:\ntriple aarch64-apple-darwin"))


class WasmRecipeTests(unittest.TestCase):
    # Selector/parser controls are synthetic; the native fixture above remains
    # the genuine retained capture. No native graph is retagged as WASM evidence.
    def test_original_target_specific_distribution_features(self):
        features, inputs = graph.features(graph.WASM), graph.recipe_inputs(graph.WASM)
        self.assertEqual(features, ["backtrace", "compiler-builtins-c", "panic-unwind"])
        self.assertNotIn("profiler", features)
        self.assertIn("src/ci/docker/host-x86_64/dist-various-2/Dockerfile", inputs)
        self.assertFalse(any("dist-aarch64-linux" in name or "dist-x86_64-linux" in name for name in inputs))
        for target in graph.HOSTS:
            self.assertEqual((graph.features(target), graph.recipe_inputs(target)), (graph.FEATURES, graph.RECIPE_INPUTS))

    def test_unknown_target_recipe_refused(self):
        with self.assertRaises(ValueError):
            graph.features("wasm32-wasip1")

    def test_compiler_host_is_explicit_and_separate(self):
        class Sdk:
            host = target
        self.assertEqual(graph.compiler_host(Sdk(), graph.WASM, target), target)
        for host in [None, graph.WASM, "x86_64-unknown-linux-gnu", "foreign"]:
            with self.assertRaises(ValueError):
                graph.compiler_host(Sdk(), graph.WASM, host)
        self.assertEqual(graph.compiler_host(Sdk(), target, None), target)

    def test_capture_refuses_missing_or_foreign_host_before_source_io(self):
        class Sdk:
            host = target
        for host in [None, graph.WASM, "x86_64-unknown-linux-gnu"]:
            with self.assertRaisesRegex(ValueError, "compiler host"):
                graph.capture("absent", "absent", Sdk(), [], graph.WASM, "absent", host)

    def test_original_commands_target_wasm_and_do_not_change_native_features(self):
        class Sdk:
            def command(self, tool, version):
                self.version = version
                return ["/declared/" + tool]
        sdk = Sdk()
        commands = graph.capture_commands(sdk, Path("/declared/source"), graph.WASM)
        self.assertEqual(sdk.version, graph.VERSION)
        self.assertIn("--target=wasm32-unknown-unknown", commands["units"])
        self.assertNotIn("--target=" + target, commands["units"])
        for argv in commands.values():
            self.assertIn("--offline", argv)
            self.assertIn("--locked", argv)
            self.assertEqual(argv[argv.index("--features") + 1], ",".join(graph.WASM_FEATURES))
        native = graph.capture_commands(sdk, Path("/declared/source"), target)
        self.assertEqual(native["units"], ["/declared/cargo", "build", "--unit-graph", "-Zunstable-options", "--profile=dist", "--target=" + target, "--offline", "--locked", "--manifest-path", "/declared/source/library/sysroot/Cargo.toml", "--features", ",".join(graph.FEATURES)])

    def test_native_graph_cannot_substitute_wasm_capture(self):
        with self.assertRaises(ValueError):
            graph.relation(raw, records, graph.WASM)

    def test_wasm_metadata_parser_preserves_original_grammar(self):
        body = next(fixture.glob("metadata-*.txt")).read_text()
        self.assertEqual(graph.metadata_root(body.replace("triple " + target, "triple " + graph.WASM))["target"], graph.WASM)
        with self.assertRaises(ValueError):
            graph.metadata_root(body.replace("triple " + target, "triple wasm32-wasip1"))

    def test_original_source_file_membership_refuses_escape(self):
        original = json.loads((fixture / "graph.json").read_text())
        root = Path(original["source_root"])
        with self.assertRaises(ValueError):
            graph.original_sources(root, original["source_archive"]["path"], [root.parent / "absent-original-source"])

    def test_missing_original_source_file_refused(self):
        # The pinned archive and original sysroot path come from the genuine
        # captured fixture. A missing selected original File never gets a fact.
        original = json.loads((fixture / "graph.json").read_text())
        with self.assertRaises(FileNotFoundError):
            graph.fact(Path(original["source_root"]) / "absent-original-stdlib-source.rs")

    def test_foreign_feature_cannot_enter_configured_recipe(self):
        changed = copy.deepcopy(raw)
        root = changed["units"][changed["roots"][0]]
        root["platform"] = graph.WASM
        root["features"] = sorted(graph.WASM_FEATURES + ["default", "profiler"])
        with self.assertRaisesRegex(ValueError, "recipe"):
            graph.relation(changed, [], graph.WASM)


class SourcePresentationTests(unittest.TestCase):
    def source_fixture(self, temporary):
        base = Path(temporary)
        namespace = Path("bazel-out/native/bin/prepared/source")
        original = base / "producer" / namespace
        presentation = base / "sandbox" / namespace
        names = ["library/Cargo.toml", "src/bootstrap/src/lib.rs"]
        archive = base / "original.tar.xz"
        with tarfile.open(archive, "w:xz") as output:
            for name in names:
                path = original / name
                path.parent.mkdir(parents=True, exist_ok=True)
                body = (name + " original").encode()
                path.write_bytes(body)
                member = tarfile.TarInfo(graph.SOURCE_PREFIX + name)
                member.size = len(body)
                output.addfile(member, io.BytesIO(body))
                carrier = presentation / name
                carrier.parent.mkdir(parents=True, exist_ok=True)
                carrier.symlink_to(path)
        return original, presentation, names, archive

    def normalize(self, original, presentation, names, archive):
        # A small pinned archive isolates presentation policy; genuine original
        # distribution replay remains a separate retained qualification.
        with mock.patch.object(graph, "SOURCE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest()):
            return graph.original_source_root(presentation, archive, names, original.resolve())

    def test_original_tree_remains_ordinary(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            self.assertEqual(self.normalize(original, original, names, archive), original.resolve())

    def test_engine_leaf_carriers_normalize_same_original_namespace(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            self.assertEqual(self.normalize(original, presented, names, archive), original.resolve())
            with self.assertRaisesRegex(ValueError, "ordinary File"):
                graph.fact(presented / names[0])

    def test_changed_archive_refused_before_source_presentation(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            with mock.patch.object(graph, "SOURCE_SHA256", "0" * 64):
                with self.assertRaisesRegex(ValueError, "source archive"):
                    graph.original_source_root("absent", archive, names)

    def test_changed_original_member_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            (original / names[0]).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "differs from original"):
                self.normalize(original, presented, names, archive)

    def test_same_byte_internal_member_alias_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            path = original / names[0]
            other = path.with_name("other.toml")
            other.write_bytes(path.read_bytes())
            path.unlink()
            path.symlink_to(other)
            with self.assertRaises(ValueError):
                self.normalize(original, presented, names, archive)

    def test_same_byte_outside_leaf_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            outside = Path(temporary) / "outside.toml"
            outside.write_bytes((original / names[0]).read_bytes())
            path = presented / names[0]
            path.unlink()
            path.symlink_to(outside)
            with self.assertRaises(ValueError):
                self.normalize(original, presented, names, archive)

    def test_all_carriers_to_same_byte_foreign_tree_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            namespace = original.relative_to(Path(temporary) / "producer")
            for name in names:
                foreign = Path(temporary) / "undeclared-outside" / namespace / name
                foreign.parent.mkdir(parents=True, exist_ok=True)
                foreign.write_bytes((original / name).read_bytes())
                carrier = presented / name
                carrier.unlink()
                carrier.symlink_to(foreign)
            with self.assertRaisesRegex(ValueError, "exact declared Tree authority"):
                self.normalize(original, presented, names, archive)

    def test_carrier_tree_requires_explicit_original_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            with mock.patch.object(graph, "SOURCE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest()):
                with self.assertRaisesRegex(ValueError, "exact declared Tree authority"):
                    graph.original_source_root(presented, archive, names)

    def test_source_namespace_uses_exact_declared_sdk_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            relative = Path("bazel-out/native/bin/sdk/descriptor.json")
            original = root / "producer" / relative
            original.parent.mkdir(parents=True)
            original.write_bytes(b"validated descriptor")
            sandbox = root / "sandbox"
            carrier = sandbox / relative
            carrier.parent.mkdir(parents=True)
            carrier.symlink_to(original)
            previous = Path.cwd()
            try:
                os.chdir(sandbox)
                self.assertEqual(graph.original_source_namespace("bazel-out/native/bin/prepared/source", relative),
                                 root / "producer/bazel-out/native/bin/prepared/source")
                with self.assertRaises(ValueError):
                    graph.original_source_namespace("../outside", relative)
                with self.assertRaises(ValueError):
                    graph.original_source_namespace("bazel-out/native/bin/prepared/source", original)
                other = root / "other.json"
                other.write_bytes(original.read_bytes())
                carrier.unlink()
                carrier.symlink_to(other)
                with self.assertRaises(ValueError):
                    graph.original_source_namespace("bazel-out/native/bin/prepared/source", relative)
            finally:
                os.chdir(previous)

    def test_mixed_original_tree_roots_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            original, presented, names, archive = self.source_fixture(temporary)
            relative = original.relative_to(Path(temporary) / "producer")
            other = Path(temporary) / "other-producer" / relative / names[0]
            other.parent.mkdir(parents=True)
            other.write_bytes((original / names[0]).read_bytes())
            path = presented / names[0]
            path.unlink()
            path.symlink_to(other)
            with self.assertRaisesRegex(ValueError, "exact declared Tree authority"):
                self.normalize(original, presented, names, archive)

if __name__ == "__main__":
    unittest.main()
