"""Regression controls for the declared original-archive acquisition producer."""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared control implementation File")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProducerControls(unittest.TestCase):
    def setUp(self):
        self.private = tempfile.TemporaryDirectory(prefix="merkur-sdk-producer-control-")
        self.root = Path(self.private.name)
        self.addCleanup(self.private.cleanup)

    def produce(self, request, name):
        root = self.root / name
        root.mkdir()
        producer.produce(request, root / "descriptor", root / "registry", root / "snapshot",
                         root / "provenance", sdk)
        return root

    def registry(self, name):
        root = self.root / name
        root.mkdir()
        generic = {**request, "sources": [], "locks": []}
        producer.produce(generic, root / "descriptor", root / "registry", None,
                         root / "provenance", sdk, registry_only=True)
        return root

    def source_capture(self, current, parent, name):
        root = self.root / name
        root.mkdir()
        producer.produce_sources(current, parent / "descriptor", parent / "provenance",
                                 root / "descriptor", root / "snapshot", root / "provenance", sdk,
                                 materializer=materializer)
        return root

    def engine_registry(self, name):
        parent = self.registry(name)
        original = parent / "registry"
        backing = self.root / (name + "-original-registry")
        original.rename(backing)
        original.mkdir()
        for path in backing.rglob("*"):
            carrier = original / path.relative_to(backing)
            if path.is_dir():
                carrier.mkdir()
            else:
                carrier.symlink_to(path)
        return parent, backing

    def rebind_control_descriptor(self, parent, changed):
        # This is a deliberately malformed descriptor fixture, with its own
        # matching descriptor-byte fact so the changed boundary is exercised.
        (parent / "descriptor").write_text(json.dumps(changed))
        value = json.loads((parent / "provenance").read_bytes())
        value["descriptor"] = producer.bytes_fact(parent / "descriptor")
        (parent / "provenance").write_text(json.dumps(value))

    def test_engine_registry_carriers_use_existing_materializer_and_keep_original_authority(self):
        parent, backing = self.engine_registry("engine-registry")
        before = {str(path): (path.stat().st_ino, producer.bytes_fact(path))
                  for path in backing.rglob("*") if path.is_file()}
        descriptor = json.loads((parent / "descriptor").read_bytes())
        current = self.current_source()
        source_paths = {entry["logical"]: entry["path"] for entry in current["sources"]}
        with self.assertRaisesRegex(ValueError, "outside its original declared source"):
            sdk.NativeCargoSdk({**descriptor,
                "locks": [producer.bytes_fact(source_paths[name]) for name in current["locks"]]})
        with patch.object(producer, "load_members", side_effect=AssertionError("registry unpack repeated")):
            output = self.source_capture(current, parent, "engine-current")
        self.assertEqual(json.loads((output / "descriptor").read_bytes())["registry"], descriptor["registry"])
        self.assertEqual(before, {str(path): (path.stat().st_ino, producer.bytes_fact(path))
                                  for path in backing.rglob("*") if path.is_file()})
        self.assertEqual((output / "snapshot/src/lib.rs").read_bytes(), b'// fresh first-party File\n')
        self.assertEqual(json.loads((output / "provenance").read_bytes())["original_sources"],
                         sorted([{"logical": entry["logical"], "file": producer.bytes_fact(entry["path"])}
                                 for entry in current["sources"]], key=lambda entry: entry["logical"]))

    def test_source_view_uses_the_validated_output_filesystem_and_cleans_up(self):
        parent, _ = self.engine_registry("engine-output-filesystem")
        current = self.current_source()
        original = producer.tempfile.TemporaryDirectory
        views = []
        def directory(*args, **kwargs):
            value = original(*args, **kwargs)
            if kwargs.get("prefix") == "merkur-source-registry-presentation-":
                views.append((kwargs.get("dir"), Path(value.name)))
            return value
        with patch.object(producer.tempfile, "TemporaryDirectory", side_effect=directory):
            self.source_capture(current, parent, "same-filesystem-current")
        self.assertEqual(len(views), 1)
        self.assertEqual(views[0][0], (self.root / "same-filesystem-current").absolute())
        self.assertFalse(views[0][1].exists())

    def test_occupied_source_output_refuses_before_any_registry_materialization(self):
        parent, _ = self.engine_registry("engine-occupied-output")
        current = self.current_source()
        output = self.root / "occupied-current"
        output.mkdir()
        (output / "descriptor").write_bytes(b'original occupied File')
        with patch.object(materializer, "materialize", side_effect=AssertionError("view before output preflight")):
            with self.assertRaises(FileExistsError):
                producer.produce_sources(current, parent / "descriptor", parent / "provenance",
                                         output / "descriptor", output / "snapshot", output / "provenance", sdk,
                                         materializer=materializer)
        self.assertEqual((output / "descriptor").read_bytes(), b'original occupied File')
        self.assertEqual([path.name for path in output.iterdir()], ["descriptor"])

    def test_missing_engine_registry_member_refuses_before_publication(self):
        parent, _ = self.engine_registry("engine-missing")
        fact = json.loads((parent / "descriptor").read_bytes())["registry"]["files"][0]
        Path(fact["path"]).unlink()
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            self.source_capture(self.current_source(), parent, "engine-missing-current")
        self.assertEqual(list((self.root / "engine-missing-current").iterdir()), [])

    def test_changed_engine_registry_bytes_refuse_before_publication(self):
        parent, _ = self.engine_registry("engine-changed")
        fact = json.loads((parent / "descriptor").read_bytes())["registry"]["files"][0]
        replacement = self.root / "changed-registry-file"
        replacement.write_bytes(Path(fact["path"]).read_bytes() + b'changed')
        carrier = Path(fact["path"])
        carrier.unlink()
        carrier.symlink_to(replacement)
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            self.source_capture(self.current_source(), parent, "engine-changed-current")
        self.assertEqual(list((self.root / "engine-changed-current").iterdir()), [])

    def test_registry_fact_escape_and_duplicate_refuse_before_publication(self):
        current = self.current_source()
        for variant in ["escape", "duplicate"]:
            with self.subTest(variant=variant):
                parent, _ = self.engine_registry("engine-" + variant)
                descriptor = json.loads((parent / "descriptor").read_bytes())
                fact = descriptor["registry"]["files"][0]
                if variant == "escape":
                    escaped = self.root / "outside-declared-tree"
                    escaped.write_bytes(Path(fact["path"]).read_bytes())
                    fact["path"] = str(escaped)
                else:
                    descriptor["registry"]["files"].append(dict(fact))
                self.rebind_control_descriptor(parent, descriptor)
                with self.assertRaises(ValueError):
                    self.source_capture(current, parent, "engine-" + variant + "-current")
                self.assertEqual(list((self.root / ("engine-" + variant + "-current")).iterdir()), [])

    def test_registry_directory_alias_refuses_before_publication(self):
        parent, _ = self.engine_registry("engine-directory-alias")
        directory = next(path for path in (parent / "registry").iterdir() if path.is_dir())
        backing = self.root / "aliased-package-directory"
        directory.rename(backing)
        directory.symlink_to(backing, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "aliased directory"):
            self.source_capture(self.current_source(), parent, "engine-alias-current")
        self.assertEqual(list((self.root / "engine-alias-current").iterdir()), [])

    def current_source(self):
        current = copy.deepcopy(request)
        original = self.root / "current-source"
        original.mkdir()
        for entry in current["sources"]:
            target = original / entry["logical"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(Path(entry["path"]).read_bytes())
            entry["path"] = str(target)
        with (original / "Cargo.lock").open("a") as stream:
            stream.write('\n[[package]]\nname = "new-first-party-source"\nversion = "0.1.0"\n')
        (original / "src/lib.rs").write_text('// fresh first-party File\n')
        return current

    def test_fresh_source_reuses_every_original_registry_file_without_unpacking(self):
        parent = self.registry("generic")
        before = {str(file): (file.stat().st_ino, producer.bytes_fact(file))
                  for file in parent.rglob("*") if file.is_file()}
        current = self.current_source()
        with patch.object(producer, "load_members", side_effect=AssertionError("registry unpack repeated")):
            root = self.source_capture(current, parent, "current")
        native = sdk.NativeCargoSdk.load(root / "descriptor")
        self.addCleanup(native.close)
        native.require_locks([root / "snapshot/Cargo.lock"])
        self.assertEqual(native.descriptor["registry"], json.loads((parent / "descriptor").read_bytes())["registry"])
        self.assertEqual((root / "snapshot/src/lib.rs").read_text(), '// fresh first-party File\n')
        self.assertNotEqual(native.descriptor["locks"], json.loads((parent / "descriptor").read_bytes())["locks"])
        self.assertEqual(before, {str(file): (file.stat().st_ino, producer.bytes_fact(file))
                                 for file in parent.rglob("*") if file.is_file()})
        receipt = json.loads((root / "provenance").read_bytes())
        self.assertEqual(receipt["original_archives"], json.loads((parent / "provenance").read_bytes())["original_archives"])
        self.assertEqual({entry["logical"]: entry["file"] for entry in receipt["original_sources"]},
                         {entry["logical"]: producer.bytes_fact(entry["path"]) for entry in current["sources"]})

    def test_stock_lock_only_source_view_preserves_bytes_and_real_native_sdk_loading(self):
        parent = self.registry("stock-registry")
        current = self.current_source()
        stock = {**current, "sources": [entry for entry in current["sources"] if entry["logical"] in current["locks"]]}
        output = self.source_capture(stock, parent, "stock-current")
        before = {name: (output / name).read_bytes() for name in ["descriptor", "provenance", "snapshot/Cargo.lock"]}
        native = sdk.NativeCargoSdk.load(output / "descriptor")
        try:
            native.require_locks([output / "snapshot/Cargo.lock"])
            self.assertEqual(native.host, request["execution_host"])
            self.assertEqual(native.descriptor["registry"], json.loads((parent / "descriptor").read_bytes())["registry"])
        finally:
            native.close()
        with materializer.materialized_sdk(output / "descriptor", output / "provenance", output / "snapshot",
                parent / "registry", request["producer"], producer, sdk, private_parent=self.root) as (native, sources):
            native.require_locks([sources / "Cargo.lock"])
            self.assertEqual(sorted(path.name for path in sources.iterdir()), ["Cargo.lock"])
        unrelated = next(entry for entry in current["sources"] if entry["logical"] == "src/lib.rs")
        Path(unrelated["path"]).write_bytes(b"// changed unrelated authored source\n")
        # Reuse exactly the same declared output paths, as the real action does.
        shutil.rmtree(output)
        second = self.source_capture(stock, parent, "stock-current")
        self.assertEqual({name: (second / name).read_bytes() for name in before}, before)
        self.assertEqual([entry["logical"] for entry in json.loads(before["provenance"])["original_sources"]], current["locks"])

    def test_stock_source_view_changed_original_lock_or_compiler_refuses(self):
        parent = self.registry("stock-refusal-registry")
        current = self.current_source()
        stock = {**current, "sources": [entry for entry in current["sources"] if entry["logical"] in current["locks"]]}
        lock = Path(stock["sources"][0]["path"])
        original = lock.read_bytes()
        checksum = json.loads((parent / "descriptor").read_bytes())["registry"]["packages"][0]["checksum"]
        self.assertIn(checksum.encode(), original)
        lock.write_bytes(original.replace(checksum.encode(), b"0" * 64))
        with self.assertRaises(ValueError):
            self.source_capture(stock, parent, "stock-changed-lock")
        self.assertEqual(list((self.root / "stock-changed-lock").iterdir()), [])
        lock.write_bytes(original)
        replacement = self.root / "foreign-rustc"
        replacement.write_bytes(b"substituted compiler File")
        changed = {**stock, "rustc": str(replacement),
                   "sdk": [str(replacement) if path == stock["rustc"] else path for path in stock["sdk"]]}
        with self.assertRaisesRegex(ValueError, "compiler Files differ"):
            self.source_capture(changed, parent, "stock-changed-compiler")
        self.assertEqual(list((self.root / "stock-changed-compiler").iterdir()), [])

    def test_runtime_inventory_missing_file_refuses_and_complete_source_capture_retains_bytes(self):
        parent = self.registry("runtime-generic")
        current = self.current_source()
        source_root = Path(current["sources"][0]["path"]).parent
        inventory = source_root / "runtime-inventory.json"
        member = source_root / "content-transfer.json"
        inventory.write_text(json.dumps({"fixture": ["packages/shared/test-vectors/content-transfer.json"]}))
        member.write_bytes(b"original declared runtime vector")
        current["sources"].append({"logical": "tools/bazel/rust/runtime_inputs.json", "path": str(inventory)})
        with self.assertRaisesRegex(ValueError, "Original runtime source File is absent"):
            self.source_capture(current, parent, "runtime-missing")
        self.assertEqual(list((self.root / "runtime-missing").iterdir()), [])
        current["sources"].append({"logical": "packages/shared/test-vectors/content-transfer.json", "path": str(member)})
        captured = self.source_capture(current, parent, "runtime-complete")
        self.assertEqual((captured / "snapshot/packages/shared/test-vectors/content-transfer.json").read_bytes(), member.read_bytes())
        self.assertEqual(json.loads((captured / "descriptor").read_text())["registry"], json.loads((parent / "descriptor").read_text())["registry"])

    def test_existing_complete_snapshot_is_immutable_registry_authority_only(self):
        parent = self.produce(request, "historical")
        before = {str(file): producer.bytes_fact(file) for file in parent.rglob("*") if file.is_file()}
        root = self.source_capture(self.current_source(), parent, "fresh")
        self.assertNotEqual((root / "snapshot/Cargo.lock").read_bytes(), (parent / "snapshot/Cargo.lock").read_bytes())
        self.assertEqual(before, {str(file): producer.bytes_fact(file) for file in parent.rglob("*") if file.is_file()})

    def test_current_lock_checksum_and_foreign_compiler_refuse_without_publication(self):
        parent = self.registry("generic")
        current = self.current_source()
        lock = Path(next(entry["path"] for entry in current["sources"] if entry["logical"] == "Cargo.lock"))
        original = lock.read_text()
        checksum = json.loads((parent / "descriptor").read_bytes())["registry"]["packages"][0]["checksum"]
        lock.write_text(original.replace(checksum, "0" * 64))
        with self.assertRaisesRegex(ValueError, "locked checksum"):
            self.source_capture(current, parent, "wrong-lock")
        self.assertEqual(list((self.root / "wrong-lock").iterdir()), [])
        lock.write_text(original)
        foreign = self.root / "foreign-rustc"
        foreign.write_bytes(Path(current["rustc"]).read_bytes() + b'foreign')
        current["rustc"] = str(foreign)
        with self.assertRaisesRegex(ValueError, "compiler Files differ"):
            self.source_capture(current, parent, "foreign-compiler")
        self.assertEqual(list((self.root / "foreign-compiler").iterdir()), [])

    def test_source_publication_failure_removes_only_new_outputs(self):
        parent = self.registry("generic")
        before = {str(file): producer.bytes_fact(file) for file in parent.rglob("*") if file.is_file()}
        original_write = producer.OwnedOutputs.write
        def failed(outputs, path, data, mode=0o644, root=None):
            original_write(outputs, path, data, mode, root)
            if root is None:
                raise ValueError("source publication control failure")
        with patch.object(producer.OwnedOutputs, "write", failed), self.assertRaisesRegex(ValueError, "source publication control failure"):
            self.source_capture(self.current_source(), parent, "failed-source")
        self.assertEqual(list((self.root / "failed-source").iterdir()), [])
        self.assertEqual(before, {str(file): producer.bytes_fact(file) for file in parent.rglob("*") if file.is_file()})

    def owned_tree(self):
        tree = self.root / "tree"
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"unchanged")
        outputs = producer.OwnedOutputs([tree])
        self.addCleanup(outputs.close)
        outputs.tree(tree)
        return tree, outside, outputs

    def test_actual_archive_and_native_sdk_fixture(self):
        root = self.produce(request, "fixture")
        provenance = json.loads((root / "provenance").read_bytes())
        self.assertEqual(len(provenance["original_archives"]), 1)
        original = request["archives"][0]
        self.assertEqual(provenance["original_archives"][0]["archive"],
                         producer.bytes_fact(original["path"]))
        expected = {entry["logical"]: Path(entry["path"]).read_bytes() for entry in request["sources"]}
        actual = {str(file.relative_to(root / "snapshot")): file.read_bytes()
                  for file in (root / "snapshot").rglob("*") if file.is_file()}
        self.assertEqual(actual, expected)
        native = sdk.NativeCargoSdk.load(root / "descriptor")
        self.addCleanup(native.close)
        native.require_locks([root / "snapshot" / name for name in request["locks"]])

    def archive(self, members):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            for name, data in members:
                entry = tarfile.TarInfo("fold-1.0.0/" + name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        return stream.getvalue()

    def test_names_a_volume_folds_together_keep_what_cargo_unpacks_there(self):
        members = producer.load_members(self.archive([
            ("Cargo.toml", b"manifest"), ("README.md", b"first"), ("Docs/a", b"a"), ("Readme.md", b"second"),
            ("docs/b", b"b"), ("straße", b"sharp"), ("STRASSE", b"plain"), ("café", b"composed"),
            ("café", b"decomposed"),
        ]), "fold-1.0.0")
        self.assertEqual({name: data for name, (data, _) in members.items()}, {
            "Cargo.toml": b"manifest", "Readme.md": b"second", "Docs/a": b"a", "Docs/b": b"b",
            "STRASSE": b"plain", "café": b"decomposed",
        })
        # A volume that folds names holds every one of them as its own entry.
        tree = self.root / "folded"
        outputs = producer.OwnedOutputs([tree])
        self.addCleanup(outputs.close)
        outputs.tree(tree)
        for name, (data, mode) in members.items():
            outputs.write(name, data, mode, root=tree)
        outputs.verify()
        self.assertEqual(sum(path.is_file() for path in tree.rglob("*")), len(members))

    def test_folded_file_directory_overlap_and_generated_checksum_refuse(self):
        for members, message in [
            ([("Cargo.toml", b""), ("Docs", b""), ("docs/a", b"")], "file/directory paths overlap"),
            ([("Cargo.toml", b""), ("docs/a", b""), ("Docs", b"")], "file/directory paths overlap"),
            ([("Cargo.toml", b""), (".Cargo-Checksum.json", b"")], "generated directory checksum"),
            ([("Cargo.toml", b""), ("cargo.toml", b"")], "no package manifest"),
        ]:
            with self.assertRaisesRegex(ValueError, message):
                producer.load_members(self.archive(members), "fold-1.0.0")

    def test_missing_and_substituted_original_archive_refuse(self):
        missing = copy.deepcopy(request)
        missing["archives"] = []
        with self.assertRaisesRegex(ValueError, "omit the complete locked source closure"):
            producer.prepare(missing)
        wrong = self.root / "substituted.crate"
        wrong.write_bytes(Path(request["archives"][0]["path"]).read_bytes() + b"substituted")
        substituted = copy.deepcopy(request)
        substituted["archives"][0]["path"] = str(wrong)
        with self.assertRaisesRegex(ValueError, "differ from the locked checksum"):
            producer.prepare(substituted)

    def test_actual_producer_stat_work_scales_linearly(self):
        original = self.root / "original"
        original.mkdir()
        members = []
        for index in range(512):
            logical = f"src/regression/{index // 64:04d}/{index:04d}.txt"
            path = original / logical
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"declared-original-{index}\n".encode())
            members.append({"logical": logical, "path": str(path)})
        counts = []
        original_stat = os.stat
        for size in [256, 512]:
            count = 0

            def counted_stat(*args, **kwargs):
                nonlocal count
                if kwargs.get("dir_fd") is not None:
                    count += 1
                return original_stat(*args, **kwargs)

            value = {**request, "sources": request["sources"] + members[:size]}
            with patch.object(os, "stat", counted_stat):
                root = self.produce(value, f"linear-{size}")
            counts.append(count)
            expected = {entry["logical"]: hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest()
                        for entry in value["sources"]}
            actual = {str(file.relative_to(root / "snapshot")): hashlib.sha256(file.read_bytes()).hexdigest()
                      for file in (root / "snapshot").rglob("*") if file.is_file()}
            self.assertEqual(actual, expected)
            provenance = json.loads((root / "provenance").read_bytes())
            self.assertEqual({entry["logical"]: entry["file"]["sha256"]
                              for entry in provenance["original_sources"]}, expected)
        # Fixed-depth doubled Files must stay linear in real anchored filesystem
        # calls. No wall-clock threshold, implementation hook or mocked stat result.
        self.assertLess(counts[1], counts[0] * 2.1)
        self.assertLess(counts[1], 15 * (512 + len(request["sources"])))

    def test_failure_after_final_file_removes_all_owned_outputs(self):
        root = self.root / "failure"
        root.mkdir()
        original_write = producer.OwnedOutputs.write

        def failed(outputs, path, data, mode=0o644, root=None):
            original_write(outputs, path, data, mode, root)
            if root is None:
                raise ValueError("post-file control failure")

        with patch.object(producer.OwnedOutputs, "write", failed):
            with self.assertRaisesRegex(ValueError, "post-file control failure"):
                producer.produce(request, root / "descriptor", root / "registry", root / "snapshot",
                                 root / "provenance", sdk)
        self.assertEqual(list(root.iterdir()), [])

    def test_cached_ancestor_replacement_refuses_and_cleans_only_owned_files(self):
        tree, outside, outputs = self.owned_tree()
        outputs.write("nested/one", b"one", root=tree)
        (tree / "nested").rename(self.root / "held-nested")
        (tree / "nested").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "owned output entry changed"):
            outputs.write("nested/two", b"two", root=tree)
        with self.assertRaises(BaseExceptionGroup):
            outputs.cleanup()
        self.assertEqual((outside / "sentinel").read_bytes(), b"unchanged")
        self.assertEqual([file.name for file in outside.iterdir()], ["sentinel"])
        self.assertTrue((tree / "nested").is_symlink())
        self.assertFalse((self.root / "held-nested/one").exists())

    def test_leaf_replacement_after_open_refuses_without_writing_replacement(self):
        tree, outside, outputs = self.owned_tree()
        original_open = os.open

        def replaced(name, flags, mode=0o777, *, dir_fd=None):
            descriptor = original_open(name, flags, mode, dir_fd=dir_fd)
            if name == "member" and flags & os.O_CREAT:
                (tree / "member").rename(self.root / "held-member")
                (tree / "member").symlink_to(outside / "sentinel")
            return descriptor

        with patch.object(os, "open", replaced):
            with self.assertRaisesRegex(ValueError, "owned output entry changed"):
                outputs.write("member", b"foreign", root=tree)
        with self.assertRaises(BaseExceptionGroup):
            outputs.cleanup()
        self.assertEqual((outside / "sentinel").read_bytes(), b"unchanged")
        self.assertEqual((self.root / "held-member").read_bytes(), b"")
        self.assertTrue((tree / "member").is_symlink())

    def test_prior_sibling_replacement_refuses_final_publication(self):
        tree, _, outputs = self.owned_tree()
        outputs.write("one", b"one", root=tree)
        (tree / "one").rename(self.root / "held-one")
        (tree / "one").write_bytes(b"caller-owned")
        outputs.write("two", b"two", root=tree)
        with self.assertRaisesRegex(ValueError, "owned output entry changed"):
            outputs.verify()
        with self.assertRaises(BaseExceptionGroup):
            outputs.cleanup()
        self.assertEqual((tree / "one").read_bytes(), b"caller-owned")
        self.assertFalse((tree / "two").exists())
        self.assertEqual((self.root / "held-one").read_bytes(), b"one")

    def test_new_directory_replacement_after_open_refuses(self):
        tree, outside, outputs = self.owned_tree()
        original_open = os.open

        def replaced(name, flags, mode=0o777, *, dir_fd=None):
            descriptor = original_open(name, flags, mode, dir_fd=dir_fd)
            if name == "nested" and flags & os.O_DIRECTORY:
                (tree / "nested").rename(self.root / "held-nested")
                (tree / "nested").symlink_to(outside, target_is_directory=True)
            return descriptor

        with patch.object(os, "open", replaced):
            with self.assertRaisesRegex(ValueError, "owned output entry changed"):
                outputs.write("nested/member", b"foreign", root=tree)
        with self.assertRaises(BaseExceptionGroup):
            outputs.cleanup()
        self.assertEqual([file.name for file in outside.iterdir()], ["sentinel"])
        self.assertEqual(list((self.root / "held-nested").iterdir()), [])
        self.assertTrue((tree / "nested").is_symlink())

    def test_declared_file_parent_replacement_refuses(self):
        parent = self.root / "parent"
        parent.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"unchanged")
        outputs = producer.OwnedOutputs([parent / "descriptor"])
        self.addCleanup(outputs.close)
        parent.rename(self.root / "held-parent")
        parent.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "declared output parent changed"):
            outputs.write(parent / "descriptor", b"foreign")
        outputs.cleanup()
        self.assertEqual([file.name for file in outside.iterdir()], ["sentinel"])
        self.assertEqual(list((self.root / "held-parent").iterdir()), [])
        self.assertTrue(parent.is_symlink())

    def test_nested_readonly_files_keep_modes_and_clean_complete_journal(self):
        tree, _, outputs = self.owned_tree()
        outputs.write("nested/member", b"original", 0o444, root=tree)
        outputs.verify()
        self.assertEqual((tree / "nested/member").read_bytes(), b"original")
        self.assertEqual(stat.S_IMODE((tree / "nested/member").stat().st_mode), 0o444)
        outputs.cleanup()
        self.assertFalse(tree.exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ["request", "producer", "sdk-resolver", "sdk-materializer"]:
        parser.add_argument("--" + argument, type=Path, required=True)
    args = parser.parse_args()
    producer = load("declared_producer", args.producer)
    sdk = load("declared_sdk", args.sdk_resolver)
    materializer = load("declared_materializer", args.sdk_materializer)
    request = json.loads(args.request.read_bytes())
    unittest.main(argv=[str(Path(__file__))])
