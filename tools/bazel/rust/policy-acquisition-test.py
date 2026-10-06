"""Transport/dispatch controls; fixtures do not qualify a production policy SDK."""

import argparse
import hashlib
import importlib.util
import json
import os
from contextlib import contextmanager
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


def load(path):
    spec = importlib.util.spec_from_file_location("declared_policy_control", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PolicyPresentation(unittest.TestCase):
    def setUp(self):
        self.runner = load(RUNNER)
        self.capture = load(CAPTURE)
        self.presentation = load(PRESENTATION)
        self.private = tempfile.TemporaryDirectory(prefix="policy-presentation-controls-")
        self.addCleanup(self.private.cleanup)
        self.root = Path(self.private.name)
        self.runfiles = self.root / "runfiles"
        self.runfiles.mkdir()
        self.roles = {role: "bazel-out/bin/acquire/" + role for role in ["descriptor", "registry", "sources", "provenance"]}
        self.specification = {**self.roles, "producer": "//tools/bazel/rust/acquire:production_sdk", "declarations": {
            value: "_main/acquire/" + role for role, value in self.roles.items()
        }}
        self.specification["declarations"]["external/rust/bin/rustc"] = "rust/bin/rustc"
        self.specification["declarations"]["external/rust/bin/cargo"] = "rust/bin/cargo"
        for role in ["registry", "sources"]:
            (self.runfiles / self.specification["declarations"][self.roles[role]]).mkdir(parents=True)
        for name in ["rustc", "cargo"]:
            p = self.runfiles / "rust/bin" / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("fixture original " + name)
        self.descriptor = {"cargo": {"path": "external/rust/bin/cargo"}, "rustc": {"path": "external/rust/bin/rustc"},
                           "sdk": [{"path": "external/rust/bin/rustc"}, {"path": "external/rust/bin/cargo"}]}
        self.descriptor_file = self.runfiles / self.specification["declarations"][self.roles["descriptor"]]
        self.descriptor_file.write_text(json.dumps(self.descriptor))
        self.provenance_file = self.runfiles / self.specification["declarations"][self.roles["provenance"]]
        self.provenance_file.write_text("unchanged original provenance")

    def test_nonce_runner_preserves_original_execpaths_and_descriptor_bytes(self):
        before = self.descriptor_file.read_bytes()
        previous = Path.cwd()
        with self.runner.execution_paths(self.runner.request(self.specification), self.runfiles):
            self.assertEqual(Path(self.roles["descriptor"]).read_bytes(), before)
            self.assertEqual(Path(self.roles["provenance"]).read_bytes(), self.provenance_file.read_bytes())
            self.assertEqual(Path("external/rust/bin/rustc").resolve(), (self.runfiles / "rust/bin/rustc").resolve())
            observed = self.capture.bytes_fact(self.roles["descriptor"])
            self.assertEqual(observed, {"path": self.roles["descriptor"], "size": len(before), "sha256": hashlib.sha256(before).hexdigest()})
            temporary = Path.cwd()
        self.assertEqual(Path.cwd(), previous)
        self.assertFalse(temporary.exists())
        self.assertEqual(self.descriptor_file.read_bytes(), before)

    def test_existing_materializer_checks_exact_source_bytes_through_declared_tree_carrier(self):
        tree = self.runfiles / self.specification["declarations"][self.roles["sources"]]
        (tree / "Cargo.lock").write_text("exact original lock")
        old = self.roles["sources"] + "/Cargo.lock"
        fact = {"path": old, "size": 19, "sha256": hashlib.sha256(b"exact original lock").hexdigest()}
        with self.runner.execution_paths(self.runner.request(self.specification), self.runfiles):
            output = self.root / "copied"
            output.mkdir()
            result = self.presentation.materialize(Path(self.roles["sources"]), [fact], output, self.capture)
            self.assertEqual((output / "Cargo.lock").read_bytes(), b"exact original lock")
            self.assertEqual(result[0], {**fact, "path": str(output / "Cargo.lock")})

    def test_changed_source_bytes_refuse_in_unchanged_existing_materializer(self):
        tree = self.runfiles / self.specification["declarations"][self.roles["sources"]]
        (tree / "Cargo.lock").write_text("changed lock")
        fact = {"path": self.roles["sources"] + "/Cargo.lock", "size": 19, "sha256": hashlib.sha256(b"exact original lock").hexdigest()}
        with self.runner.execution_paths(self.runner.request(self.specification), self.runfiles):
            output = self.root / "copied"
            output.mkdir()
            with self.assertRaisesRegex(ValueError, "changed in engine presentation"):
                self.presentation.materialize(Path(self.roles["sources"]), [fact], output, self.capture)
            self.assertFalse((output / "Cargo.lock").exists())

    def test_undeclared_runtime_and_role_refuse(self):
        del self.specification["declarations"]["external/rust/bin/cargo"]
        with self.assertRaisesRegex(ValueError, "runtime File is absent"):
            with self.runner.execution_paths(self.runner.request(self.specification), self.runfiles):
                self.fail("entered incomplete runtime")
        del self.specification["declarations"][self.roles["registry"]]
        with self.assertRaisesRegex(ValueError, "role is absent"):
            self.runner.request(self.specification)

    def test_noncanonical_and_absolute_declarations_refuse(self):
        for path in ["/outside", "../outside", "a/../outside", "a//b", "a\\b", "./a", ""]:
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "declared relative File path"):
                    self.runner.relative(path)

    def test_exception_restores_cwd_and_retires_only_private_presentation(self):
        previous = Path.cwd()
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            with self.runner.execution_paths(self.runner.request(self.specification), self.runfiles):
                temporary = Path.cwd()
                raise RuntimeError("cancelled")
        self.assertEqual(Path.cwd(), previous)
        self.assertFalse(temporary.exists())
        self.assertTrue(self.descriptor_file.is_file())

    def test_policy_dispatch_binds_parent_before_entering_execpath_namespace(self):
        parent = self.root / "declared-policy-parent"
        parent.mkdir()
        request_file = self.root / "request.json"
        request_file.write_text(json.dumps(self.specification))
        paths = {}
        for name in ["policy", "controls", "sdk_resolver", "presentation", "capture"]:
            paths[name] = self.root / (name + ".py")
            paths[name].write_text("# explicit dispatcher fixture\n")
        observed = []
        @contextmanager
        def materialized(*arguments, private_parent):
            observed.append((private_parent, Path.cwd()))
            yield SimpleNamespace(descriptor={}), Path.cwd()
        presentation = SimpleNamespace(materialized_sdk=materialized)
        def module(path):
            return presentation if path == paths["presentation"].resolve() else SimpleNamespace()
        args = SimpleNamespace(request=request_file, **paths, mode="controls", output=None,
            private_parent=Path(parent.name), runfiles_root=self.runfiles)
        previous = Path.cwd()
        os.chdir(self.root)
        try:
            with patch.object(self.runner, "load", side_effect=module), patch.object(self.runner.subprocess, "run") as command:
                self.runner.execute(args)
            self.assertEqual(observed[0][0], parent.resolve())
            self.assertNotEqual(observed[0][1], self.root)
            self.assertFalse(observed[0][1].exists())
            self.assertEqual(command.call_count, 1)
        finally:
            os.chdir(previous)

    def test_same_cli_contract_is_used_by_refresh_and_control_dispatch(self):
        for mode, script, prefix in [("refresh", "policy.py", ["--refresh"]), ("controls", "controls.py", ["--policy", "policy.py"])]:
            with self.subTest(mode=mode):
                actual = self.runner.command(mode, "policy.py", "controls.py", "descriptor.json", "resolver.py", "source")
                self.assertEqual(actual, [sys.executable, "-I", "-B", script, *prefix,
                    "--sdk-descriptor", "descriptor.json", "--sdk-resolver", "resolver.py", "--source-root", "source"])
                self.assertFalse(any(value in {"rustup", "cargo"} for value in actual))
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.runner.command("fallback", "policy", "controls", "descriptor", "resolver", "source")


class MaterializedSdkPlacement(unittest.TestCase):
    """Explicit descriptor fixtures cover placement/custody, not SDK qualification."""
    def setUp(self):
        self.presentation = load(PRESENTATION)
        self.capture = load(CAPTURE)
        self.private = tempfile.TemporaryDirectory(prefix="sdk-parent-controls-")
        self.addCleanup(self.private.cleanup)
        self.root = Path(self.private.name)
        self.parent = self.root / "declared-output-parent"
        self.parent.mkdir()
        self.sources = self.root / "original-sources"
        self.sources.mkdir()
        self.lock = self.sources / "Cargo.lock"
        self.lock.write_bytes(b"explicit original lock fixture\n")
        self.registry = self.root / "original-registry"
        self.registry.mkdir()
        self.member = self.registry / "fixture/Cargo.toml"
        self.member.parent.mkdir()
        self.member.write_bytes(b"explicit original registry fixture\n")
        self.descriptor = self.root / "descriptor.json"
        self.provenance = self.root / "provenance.json"
        self.descriptor.write_text(json.dumps({"execution_host": "aarch64-apple-darwin",
            "locks": [self.capture.bytes_fact(self.lock)],
            "registry": {"directory": str(self.registry), "files": [self.capture.bytes_fact(self.member)]}}))
        self.provenance.write_text(json.dumps({"producer": "//fixture:sdk",
            "execution_host": "aarch64-apple-darwin", "descriptor": self.capture.bytes_fact(self.descriptor),
            "source_files": [self.capture.bytes_fact(self.lock)]}))
        self.instances = []
        instances = self.instances
        class ExplicitFixtureSdk:
            def __init__(self, descriptor):
                self.descriptor, self.closed = descriptor, False
                instances.append(self)
            def close(self):
                self.closed = True
        self.resolver = SimpleNamespace(NativeCargoSdk=ExplicitFixtureSdk)
        self.original_arguments = [self.descriptor, self.provenance, self.sources,
                                   self.registry, "//fixture:sdk", self.capture, self.resolver]

    def context(self, parent=None):
        return self.presentation.materialized_sdk(*self.original_arguments,
            private_parent=self.parent if parent is None else parent)

    def test_explicit_output_parent_contains_both_copies_and_cleanup_preserves_originals(self):
        before = {p: p.read_bytes() for p in [self.lock, self.member, self.descriptor, self.provenance]}
        with self.context() as (sdk, source):
            private = source.parent
            self.assertEqual(private.parent, self.parent.resolve())
            self.assertEqual((source / "Cargo.lock").read_bytes(), before[self.lock])
            registry = Path(sdk.descriptor["registry"]["directory"])
            self.assertEqual(registry.parent, private)
            self.assertEqual((registry / "fixture/Cargo.toml").read_bytes(), before[self.member])
            self.assertEqual(sdk.descriptor["locks"][0], self.capture.bytes_fact(source / "Cargo.lock"))
        self.assertFalse(private.exists())
        self.assertTrue(sdk.closed)
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_parent_is_mandatory_and_missing_or_non_directory_never_falls_back(self):
        with self.assertRaises(TypeError):
            self.presentation.materialized_sdk(*self.original_arguments)
        with self.assertRaises(FileNotFoundError):
            with self.context(self.root / "missing"):
                self.fail("used a missing declared parent")
        with self.assertRaisesRegex(ValueError, "output/work directory"):
            with self.context(self.member):
                self.fail("used a File as the declared parent")
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assertEqual(self.instances, [])

    def test_original_temp_api_receives_exact_parent_without_ambient_lookup(self):
        original = tempfile.TemporaryDirectory
        parents = []
        def directory(*args, **kwargs):
            parents.append(kwargs.get("dir"))
            return original(*args, **kwargs)
        with patch.object(self.presentation.tempfile, "TemporaryDirectory", side_effect=directory):
            with self.context():
                pass
        self.assertEqual(parents, [self.parent.resolve()])

    def test_exception_and_constructor_failure_retire_only_private_copy(self):
        caller = self.parent / "caller"
        caller.write_bytes(b"original caller bytes")
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            with self.context() as (sdk, source):
                private = source.parent
                raise RuntimeError("cancelled")
        self.assertFalse(private.exists())
        self.assertTrue(sdk.closed)
        def refuse(_):
            raise ValueError("explicit resolver refusal")
        self.resolver.NativeCargoSdk = refuse
        with self.assertRaisesRegex(ValueError, "resolver refusal"):
            with self.context():
                self.fail("accepted refused SDK")
        self.assertEqual(list(self.parent.iterdir()), [caller])
        self.assertEqual(caller.read_bytes(), b"original caller bytes")

    def test_changed_original_registry_member_is_refused_before_resolver(self):
        self.member.write_bytes(b"changed original registry fixture")
        with self.assertRaisesRegex(ValueError, "changed in engine presentation"):
            with self.context():
                self.fail("accepted changed original bytes")
        self.assertEqual(self.instances, [])
        self.assertEqual(list(self.parent.iterdir()), [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ["runner", "capture", "presentation"]:
        parser.add_argument("--" + name, type=Path, required=True)
    args, rest = parser.parse_known_args()
    RUNNER, CAPTURE, PRESENTATION = args.runner, args.capture, args.presentation
    unittest.main(argv=[sys.argv[0], *rest])
