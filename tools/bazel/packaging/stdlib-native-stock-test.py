"""Original member custody and real compiler mismatched-pair controls."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock

base = Path(__file__).absolute().parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

graph = load("graph", base / "stdlib-native-graph.py")
stock = load("stock", base / "stdlib-native-stock.py")
pair = load("pair", base / "stdlib-native-pair.py")
sdk_module = load("sdk", Path(sys.argv.pop(1)))
sdk = sdk_module.NativeCargoSdk.load(sys.argv.pop(1))
fixture = json.loads(Path(sys.argv.pop(1)).read_text())
request = json.loads(Path(sys.argv.pop(1)).read_text())

class StockBoundaryTests(unittest.TestCase):
    def test_execution_root_relative_pair_output(self):
        metadata = next(v for v in fixture["metadata"] if v["crate"] == "std")
        p = Path(metadata["file"]["path"])
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            try:
                os.chdir(temporary)
                observed = pair.pair(sdk, p.with_suffix(".rlib"), p, fixture["target"], Path("relative-output"), "std")
                self.assertEqual(observed["exit"], 0)
                self.assertTrue(Path(observed["object"]["path"]).is_absolute())
            finally:
                os.chdir(previous)

    def test_actual_stock_pair(self):
        metadata = next(v for v in fixture["metadata"] if v["crate"] == "std")
        with tempfile.TemporaryDirectory() as temporary:
            p = Path(metadata["file"]["path"])
            observed = pair.pair(sdk, p.with_suffix(".rlib"), p, fixture["target"], Path(temporary) / "same", "std")
            self.assertEqual(observed["exit"], 0)
            self.assertIn("--emit=obj", observed["command"])
            self.assertNotIn("--emit=metadata", observed["command"])

    def test_actual_wrong_stock_pair(self):
        metadata = next(v for v in fixture["metadata"] if v["crate"] == "std")
        wrong = next(v for v in fixture["metadata"] if v["crate"] == "core")
        with tempfile.TemporaryDirectory() as temporary:
            p = Path(metadata["file"]["path"])
            with self.assertRaisesRegex(ValueError, "E0464"):
                pair.pair(sdk, p.with_suffix(".rlib"), wrong["file"]["path"], fixture["target"], Path(temporary) / "wrong", "std")

    def archive_fixture(self, temporary):
        root = Path(temporary)
        archive = root / "original.tar.xz"
        path = root / "declared.rmeta"
        path.write_bytes(b"original metadata")
        with tarfile.open(archive, "w:xz") as original:
            item = tarfile.TarInfo("original/member.rmeta")
            item.size = path.stat().st_size
            original.addfile(item, io.BytesIO(path.read_bytes()))
        return archive, path

    def test_exact_original_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, path = self.archive_fixture(temporary)
            archive_fact, members = stock.archive_members(graph, archive, graph.fact(archive)["sha256"], {"original/member.rmeta": path})
            self.assertEqual(members["original/member.rmeta"], graph.fact(path.resolve()))
            self.assertEqual(archive_fact, graph.fact(archive.resolve()))

    def test_changed_original_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, path = self.archive_fixture(temporary)
            with self.assertRaisesRegex(ValueError, "pinned stock distribution"):
                stock.archive_members(graph, archive, "0" * 64, {"original/member.rmeta": path})

    def test_changed_installed_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, path = self.archive_fixture(temporary)
            path.write_bytes(b"replacement")
            with self.assertRaisesRegex(ValueError, "differs from original"):
                stock.archive_members(graph, archive, graph.fact(archive)["sha256"], {"original/member.rmeta": path})

    def test_missing_archive_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, path = self.archive_fixture(temporary)
            with self.assertRaisesRegex(ValueError, "no original archive"):
                stock.archive_members(graph, archive, graph.fact(archive)["sha256"], {"invented/member.rmeta": path})

    def bad_request(self, change, message):
        value = {**request, "stdlib": [dict(v) for v in request["stdlib"]]}
        change(value)
        with self.assertRaisesRegex(ValueError, message):
            stock.capture(value, graph, pair, sdk)

    def test_cached_association_retains_declared_inputs(self):
        target = request["target"]
        prefix = "rust-std-1.97.1-" + target + "/rust-std-" + target + "/lib/rustlib/" + target + "/lib/"
        paths = {"rmeta": "external/stock/lib/rustlib/" + target + "/lib/libstd.rmeta",
                 "rlib": "external/stock/lib/rustlib/" + target + "/lib/libstd.rlib"}
        declared = [{"path": value, "label": "@stock//:" + suffix} for suffix, value in paths.items()]
        results = []
        for sandbox in ["old-action", "fresh-action"]:
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "configured"
                output.mkdir()
                originals = {prefix + "libstd." + suffix: {
                    "path": "/" + sandbox + "/libstd." + suffix, "size": 7, "sha256": "a" * 64,
                } for suffix in paths}
                record = {"identity": "std-original-hash", "crate": "std", "file": originals[prefix + "libstd.rmeta"]}
                fake_graph = types.SimpleNamespace(capture=lambda *args: {"metadata": [record]})
                value = {**request, "source_archive_label": "@source//file:archive", "stdlib": declared, "output": str(output), "graph_output": str(Path(temporary) / "graph.json")}
                with mock.patch.object(stock, "archive_members", side_effect=[({}, originals), ({}, {})]):
                    result = stock.capture(value, fake_graph, types.SimpleNamespace(pair=lambda *args: {"exit": 0}), sdk)
                results.append(result["stock_association"]["members"][0])
        self.assertNotEqual(results[0]["metadata"]["path"], results[1]["metadata"]["path"])
        for row in results:
            self.assertEqual(row["metadata_input"], paths["rmeta"])
            self.assertEqual(row["archive_input"], paths["rlib"])
            self.assertEqual(row["metadata_label"], "@stock//:rmeta")
            self.assertEqual(row["archive_label"], "@stock//:rlib")

    def test_declared_source_archive_carrier(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "source.tar.xz"
            original.write_bytes(b"original source archive")
            carrier = root / "declared-source.tar.xz"
            carrier.symlink_to(original)
            output = root / "configured"
            output.mkdir()
            value = {**request, "source_archive": str(carrier),
                     "source_archive_label": "@source//file:archive",
                     "output": str(output), "graph_output": str(root / "graph.json")}
            observed = []
            fake_graph = types.SimpleNamespace(capture=lambda *args: observed.append(args[1]) or {"metadata": []})
            with mock.patch.object(stock, "archive_members", side_effect=[({}, {}), ({}, {})]):
                result = stock.capture(value, fake_graph, pair, sdk)
            self.assertEqual(observed, [original.resolve()])
            self.assertEqual(result["source_archive_input"], str(carrier))
            self.assertEqual(result["source_archive_label"], "@source//file:archive")
            with self.assertRaisesRegex(ValueError, "ordinary File"):
                graph.fact(carrier)

    def test_declared_source_archive_changed_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "source.tar.xz"
            original.write_bytes(b"replacement archive bytes")
            carrier = root / "declared-source.tar.xz"
            carrier.symlink_to(original)
            def source_capture(source_root, archive, *unused):
                graph.original_sources(Path(source_root), archive, [])
            fake_graph = types.SimpleNamespace(capture=source_capture)
            value = {**request, "source_archive": str(carrier),
                     "source_archive_label": "@source//file:archive"}
            with mock.patch.object(stock, "archive_members", side_effect=[({}, {}), ({}, {})]):
                with self.assertRaisesRegex(ValueError, "Original Rust1.97.1 source archive required"):
                    stock.capture(value, fake_graph, pair, sdk)

    def test_wrong_compiler_version(self):
        self.bad_request(lambda v: v.update(compiler="1.96.0"), "Rust1.97.1")

    def test_unsupported_target(self):
        self.bad_request(lambda v: v.update(target="wasm32-wasip1"), "Rust1.97.1")

    def test_wasm_missing_or_foreign_compiler_host_refused(self):
        for host in [None, "wasm32-unknown-unknown", "x86_64-unknown-linux-gnu"]:
            self.bad_request(lambda v: v.update(target=stock.WASM, execution_host=host), "execution_host")

    def test_original_wasm_distribution_pin(self):
        self.assertEqual(stock.STD[stock.WASM], "fa0edb6e9f34faae5735554d62d50875eded839dc707d0f1c01467a918d8453b")
        self.assertNotIn(stock.WASM, stock.RUSTC)

    def test_native_foreign_explicit_host_refused(self):
        self.bad_request(lambda v: v.update(execution_host=stock.WASM), "execution_host")

    def test_wasm_capture_passes_separate_host_to_original_graph(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "source.tar.xz"
            archive.write_bytes(b"original source")
            output = root / "configured"
            output.mkdir()
            seen = []
            fake_graph = types.SimpleNamespace(capture=lambda *args: seen.append(args) or {"metadata": []})
            value = {**request, "target": stock.WASM, "execution_host": sdk.host, "stdlib": [{"path": "external/stock/lib/rustlib/" + stock.WASM + "/lib/libstd.rmeta", "label": "@stock//:metadata"}], "source_archive": str(archive), "source_archive_label": "@source//file:archive", "output": str(output), "graph_output": str(root / "graph.json")}
            originals = {"original/member.rmeta": {"path": str(root / "lib/rustlib/wasm32-unknown-unknown/lib/libstd.rmeta")}}
            with mock.patch.object(stock, "archive_members", side_effect=[({}, originals), ({}, {})]):
                stock.capture(value, fake_graph, pair, sdk)
            self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0][-3:], (stock.WASM, str(output), sdk.host))

    def test_complete_original_namespace_rejects_missing_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive, path = self.archive_fixture(temporary)
            with self.assertRaisesRegex(ValueError, "complete original target namespace"):
                stock.archive_members(graph, archive, graph.fact(archive)["sha256"], {}, complete_prefix="original/")
            _, members = stock.archive_members(graph, archive, graph.fact(archive)["sha256"], {"original/member.rmeta": path}, complete_prefix="original/")
            self.assertEqual(set(members), {"original/member.rmeta"})

    def test_wasm_pair_missing_or_foreign_namespace_refused_before_compiler(self):
        metadata = next(v for v in fixture["metadata"] if v["crate"] == "std")
        file = Path(metadata["file"]["path"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for sysroot in [None, root]:
                with self.assertRaisesRegex(ValueError, "sysroot"):
                    pair.pair(sdk, file.with_suffix(".rlib"), file, stock.WASM, root / "refused", "std", sysroot)
                self.assertFalse((root / "refused").exists())
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "sysroot"):
                pair.pair(sdk, file.with_suffix(".rlib"), file, stock.WASM, root / "refused", "std", alias)
            self.assertFalse((root / "refused").exists())

    def test_wasm_stock_files_cannot_select_different_sysroot_namespaces(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = "/lib/rustlib/wasm32-unknown-unknown/lib/"
            originals = {name: {"path": str(root / role) + marker + name} for role, name in [("one", "libstd.rmeta"), ("two", "libcore.rmeta")]}
            value = {**request, "target": stock.WASM, "execution_host": sdk.host, "stdlib": [{"path": "external/stock" + marker + "libstd.rmeta", "label": "@stock//:metadata"}]}
            with mock.patch.object(stock, "archive_members", return_value=({}, originals)):
                with self.assertRaisesRegex(ValueError, "one exact installed target namespace"):
                    stock.capture(value, graph, pair, sdk)

    def test_untyped_stock_manifest(self):
        self.bad_request(lambda v: v["stdlib"][0].pop("label"), "typed stdlib")

    def test_foreign_target_namespace(self):
        self.bad_request(lambda v: v["stdlib"][0].update(path="/lib/rustlib/x86_64-apple-darwin/lib/foreign.rmeta"), "outside original")

    def test_duplicate_stock_file(self):
        self.bad_request(lambda v: v["stdlib"].append(v["stdlib"][0]), "Repeated original")

    def test_stock_member_traversal(self):
        self.bad_request(lambda v: v["stdlib"][0].update(path="/lib/rustlib/aarch64-apple-darwin/../other.rmeta"), "Invalid original")

if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        sdk.close()
