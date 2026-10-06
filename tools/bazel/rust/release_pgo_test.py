#!/usr/bin/env python3
"""Causal release PGO capture, library, workload and matching-tool controls."""

import argparse
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


HERE = Path(__file__).parent
RELEASE_SCRIPT = HERE.parents[2] / "scripts/build-daemon-artifacts.ts"


def load(name):
    specification = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


generate = load("release_pgo_generate")
training = load("release_pgo_train")


class GraphSerialization(unittest.TestCase):
    def test_graph_values_and_unit_identity_are_preserved(self):
        original = {"nodes": {"unit": {"rust_flags": ["-Cprofile-generate=original", "-Ctarget-feature=+ssse3"],
                    "profile": {"name": "release"}, "dependencies": [{"unit": "dependency"}],
                    "feature": [], "optional": None, "enabled": True}}, "roots": {"native": ["unit"]}}
        before = copy.deepcopy(original)
        rendered = generate.graph_json(original)
        self.assertEqual(json.loads(rendered), before)
        self.assertEqual(original, before)
        self.assertEqual(rendered, generate.graph_json(original))
        self.assertIn('"roots": {\n    "native": ["unit"]\n  }', rendered)
        self.assertIn('"dependencies": [\n', rendered)

    def test_scalar_array_fitting_includes_the_property_column(self):
        fitting = {"value": ["x" * 85]}
        overflowing = {"value": ["x" * 86]}
        self.assertIn('"value": ["' + "x" * 85 + '"]', generate.graph_json(fitting))
        self.assertIn('"value": [\n', generate.graph_json(overflowing))
        self.assertEqual(json.loads(generate.graph_json(overflowing)), overflowing)


class TrainingCompilerRole(unittest.TestCase):
    def constructor(self, package="tools/bazel/rust/release_pgo/aarch64-apple-darwin"):
        node = next(item for item in ast.parse((HERE / "units.bzl").read_text()).body
                    if isinstance(item, ast.FunctionDef) and item.name == "compiler_unit")
        calls = []
        scope = {"native": types.SimpleNamespace(package_name=lambda: package),
                 "type": lambda value: type(value).__name__,
                 "fail": lambda message: (_ for _ in ()).throw(ValueError(message)),
                 "Label": lambda value: types.SimpleNamespace(repo_name="", package="apps/daemon/dataplane"),
                 "_directory": lambda value: "apps/daemon/dataplane",
                 "_PLATFORMS": {host: [host] for host in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]},
                 "confinement_test_tags": lambda *args: ["original-tags"]}
        for name in ["rust_test", "rust_binary", "rust_proc_macro", "rust_shared_library", "rust_library", "_configured_package_test"]:
            scope[name] = lambda _name=name, **kwargs: calls.append((_name, kwargs))
        exec(compile(ast.Module(body=[node], type_ignores=[]), "units.bzl", "exec"), scope)
        return scope["compiler_unit"], calls

    def inputs(self):
        class StarlarkDict(dict):
            def values(self):
                return list(super().values())

        return {"binary_helpers": StarlarkDict(), "name": "captured", "crate_name": "merkur_dataplane", "crate_root": "//apps/daemon/dataplane:src/lib.rs",
                "sources": "original-sources", "compile_data": "original-package-data", "manifest": "original-manifest",
                "edition": "2024", "version": "0.1.0", "crate_features": [], "deps": ["original-dependency"],
                "proc_macro_deps": [], "aliases": {}, "proc_macro_aliases": {},
                "rustc_flags": ["-Copt-level=3", "-Cdebuginfo=0", "-Cdebug-assertions=no", "-Coverflow-checks=no"],
                "kind": ["lib"], "crate_types": ["lib"], "mode": "test", "platform": "aarch64-apple-darwin",
                "execution_host": "aarch64-apple-darwin", "first_party": True,
                "cargo_env": {"CARGO_PKG_NAME": "merkur-dataplane"},
                "rust_flags": ["-Cprofile-generate=merkur-release-pgo"], "emit_cdylib": False}

    def test_only_training_build_role_changes_raw_testonly(self):
        constructor, ordinary = self.constructor()
        constructor(**self.inputs())
        constructor, training = self.constructor()
        constructor(**self.inputs(), profile_training=True)
        self.assertEqual([name for name, _ in training], ["rust_test", "_configured_package_test"])
        self.assertEqual(training[0][1], {**ordinary[0][1], "testonly": False})
        self.assertEqual(training[1], ordinary[1])
        self.assertEqual(training[0][1]["crate_root"], "//apps/daemon/dataplane:src/lib.rs")
        self.assertEqual(training[0][1]["data"], ordinary[0][1]["data"])

    def test_each_native_training_role_preserves_original_target_flags(self):
        for host in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]:
            constructor, calls = self.constructor("tools/bazel/rust/release_pgo/" + host)
            inputs = {**self.inputs(), "platform": host, "execution_host": host}
            if host.startswith("x86_64"):
                inputs["rust_flags"] = ["-Ctarget-feature=+ssse3", *inputs["rust_flags"]]
            constructor(**inputs, profile_training=True)
            self.assertEqual(calls[0][1]["rustc_flags"], inputs["rustc_flags"] + inputs["rust_flags"])
            self.assertIs(calls[0][1]["testonly"], False)

    def test_uncaptured_training_identity_is_refused_before_emission(self):
        node = next(item for item in ast.parse((HERE / "units.py").read_text()).body
                    if isinstance(item, ast.FunctionDef) and item.name == "_unit_declarations")
        scope = {}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "units.py", "exec"), scope)
        build = []
        with self.assertRaisesRegex(ValueError, "absent from the captured"):
            scope["_unit_declarations"]({}, {}, build, None, None, None, profile_training="foreign")
        self.assertEqual(build, [])

    def test_other_compiler_roles_cannot_become_production_training(self):
        for key, value in [("mode", "build"), ("crate_root", "//apps/daemon/dataplane:src/main.rs"),
                           ("rust_flags", []), ("execution_host", "x86_64-apple-darwin"),
                           ("rustc_flags", ["-Copt-level=1"]), ("profile_data", ["foreign-profile"]),
                           ("profile_training", "true")]:
            with self.subTest(field=key):
                constructor, calls = self.constructor()
                inputs = {**self.inputs(), "profile_training": True, key: value}
                with self.assertRaises(ValueError):
                    constructor(**inputs)
                self.assertEqual(calls, [])
        constructor, calls = self.constructor("tools/bazel/rust/units")
        with self.assertRaises(ValueError):
            constructor(**self.inputs(), profile_training=True)
        self.assertEqual(calls, [])


class LibrarySelection(unittest.TestCase):
    def graph(self):
        def unit(kind, source, mode="test", platform="aarch64-apple-darwin"):
            return {"pkg_id": "dataplane", "mode": mode, "profile": {"name": "release"},
                    "platform": platform, "dependencies": [],
                    "target": {"kind": [kind], "src_path": source}}
        return {"roots": [0, 1, 2], "units": [unit("bin", generate.BINARY),
                unit("lib", generate.LIBRARY), unit("lib", generate.LIBRARY, "doctest")]}

    def test_original_binary_harness_cannot_train(self):
        graph = self.graph()
        graph["roots"] = [0]
        with self.assertRaisesRegex(ValueError, "one original generate"):
            generate.select_root(graph, {"dataplane": {"name": "merkur-dataplane"}}, "generate", "aarch64-apple-darwin")

    def test_exact_library_and_only_its_real_dependency_closure(self):
        graph = self.graph()
        graph["units"][1]["dependencies"] = [{"index": 3, "extern_crate_name": "original"}]
        graph["units"].append({**copy.deepcopy(graph["units"][1]), "pkg_id": "dependency"})
        selected = generate.select_root(graph, {"dataplane": {"name": "merkur-dataplane"}}, "generate", "aarch64-apple-darwin")
        self.assertEqual(selected["roots"], [0])
        self.assertEqual(len(selected["units"]), 2)
        self.assertEqual(selected["units"][0]["dependencies"], [{"index": 1, "extern_crate_name": "original"}])
        self.assertEqual(graph["roots"], [0, 1, 2])

    def test_original_release_profile_and_native_identity_are_required(self):
        for field, value in [("profile", {"name": "test"}), ("platform", None)]:
            graph = self.graph()
            graph["units"][1][field] = value
            with self.assertRaisesRegex(ValueError, "explicit native release"):
                generate.select_root(graph, {"dataplane": {"name": "merkur-dataplane"}}, "generate", "aarch64-apple-darwin")


class TargetOnlyCapture(unittest.TestCase):
    def function(self, filename="contexts.py"):
        tree = ast.parse((HERE / filename).read_text())
        node = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == "unit_graph")
        self.commands = []
        host = "aarch64-apple-darwin"
        root = Path("/declared/workspace")
        graph = {"version": 1, "roots": [0], "units": [
            {"pkg_id": "raw", "mode": "test", "platform": host,
             "target": {"kind": ["lib"], "src_path": str(root / generate.LIBRARY)}},
            {"pkg_id": "raw", "mode": "build", "platform": None,
             "target": {"kind": ["proc-macro"], "src_path": str(root / generate.LIBRARY)}}]}

        def run(argv, **kwargs):
            self.commands.append((argv, kwargs))
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(graph), stderr="")

        def flags(cwd, triple, version, environment, **kwargs):
            return {"rustflags": ["-Ctarget-feature=+ssse3", environment.get("CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS", "")], "rustdocflags": []}

        scope = {"Path": Path, "ROOT": root, "subprocess": types.SimpleNamespace(run=run),
                 "json": json, "effective_target_flags": flags}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(HERE / filename), "exec"), scope)
        sdk = types.SimpleNamespace(host=host, environment=lambda **kwargs: {"PATH": ""},
                                    command=lambda tool, version: ["/declared/cargo"])
        raw = {"packages": [{"id": "raw", "name": "package", "version": "1", "source": None,
                              "manifest_path": str(root / "Cargo.toml")}]}
        normalized = {"packages": [{"id": "original", "name": "package", "version": "1", "source": None}]}
        return scope["unit_graph"], (root / "Cargo.toml", host, "1.97.1", "test", raw, normalized, root), sdk

    def test_explicit_target_joins_cfg_without_instrumenting_host(self):
        function, args, sdk = self.function()
        graph = function(*args, sdk=sdk, release=True, explicit_target=True,
                         target_rust_flags=["-Cprofile-generate=target/rust/pgo/profiles"], package="merkur-dataplane")
        argv, options = self.commands[0]
        self.assertEqual(argv[argv.index("--target") + 1], sdk.host)
        self.assertIn("--release", argv)
        self.assertIn("--locked", argv)
        self.assertEqual(options["env"]["CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS"], "-Cprofile-generate=target/rust/pgo/profiles")
        self.assertNotIn("RUSTFLAGS", options["env"])
        self.assertEqual(graph["units"][0]["rust_flags"], ["-Ctarget-feature=+ssse3", "-Cprofile-generate=target/rust/pgo/profiles"])
        self.assertEqual(graph["units"][1]["rust_flags"], [])

    def test_default_native_capture_retains_original_semantics(self):
        function, args, sdk = self.function()
        graph = function(*args, sdk=sdk)
        self.assertNotIn("--target", self.commands[0][0])
        self.assertEqual(graph["units"][0]["rust_flags"], graph["units"][1]["rust_flags"])

    def test_target_flags_cannot_silently_replace_global_flags(self):
        function, args, sdk = self.function()
        for options in [{"target_rust_flags": ["-Cprofile-generate=profiles"]},
                        {"target_rust_flags": ["-Cprofile-generate=profiles"], "explicit_target": True, "rust_flags": ["-Copt-level=1"]}]:
            with self.assertRaises(ValueError):
                function(*args, sdk=sdk, **options)
        self.assertEqual(self.commands, [])


class Workloads(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.raw = self.root / "profiles"
        self.raw.mkdir()
        self.output = self.root / "dataplane.profdata"
        self.calls = []
        self.listing = "production: test\n"
        self.status = {}
        self.write = True

    def execute(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if argv[0] == "profdata":
            self.output.write_bytes(b"synthetic merged profile control")
            return types.SimpleNamespace(returncode=0)
        if argv[-1:] == ["--list"]:
            return types.SimpleNamespace(returncode=0, stdout=self.listing)
        name = Path(kwargs["env"]["LLVM_PROFILE_FILE"]).name.split("-%p", 1)[0]
        if self.write:
            (self.raw / (name + "-1-identity.profraw")).write_bytes(b"synthetic runtime profile control")
        return types.SimpleNamespace(returncode=self.status.get(name, 0))

    def invoke(self):
        training.train("library", "profdata", self.root, self.raw, self.output, {"PATH": ""}, self.execute)

    def test_exact_original_workloads_require_nonempty_listing_before_each_run(self):
        self.invoke()
        self.assertEqual([call[0] for call in self.calls[:-2]], [argv for _, args, _ in training.WORKLOADS for argv in [["library", *args, "--list"], ["library", *args]]])
        self.assertTrue(all(options["env"]["LLVM_PROFILE_FILE"] == "/dev/null" for argv, options in self.calls if argv[-1:] == ["--list"]))
        self.assertEqual(len(self.calls[-2][0][4:]), 3)
        self.assertEqual(self.calls[-1][0], ["profdata", "show", str(self.output)])

    def test_empty_binary_harness_success_is_not_training_success(self):
        self.listing = "0 tests, 0 benchmarks\n"
        with self.assertRaisesRegex(ValueError, "selects no test"):
            self.invoke()
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.output.exists())

    def test_each_workload_must_write_its_own_profile(self):
        self.write = False
        (self.raw / "older-1-identity.profraw").write_bytes(b"unrelated old profile")
        with self.assertRaisesRegex(ValueError, "suite wrote no"):
            self.invoke()
        self.assertFalse(self.output.exists())

    def test_original_breadth_policy_is_distinct_from_mandatory_benchmarks(self):
        self.status = {"suite": 1}
        self.invoke()
        self.assertTrue(self.output.is_file())
        self.output.unlink()
        self.status["display-pipeline"] = 1
        with self.assertRaisesRegex(RuntimeError, "display-pipeline failed"):
            self.invoke()
        self.assertFalse(self.output.exists())

    def test_changed_llvm_identity_cannot_merge_profiles(self):
        def run(argv, **kwargs):
            return types.SimpleNamespace(returncode=0, stdout="release: 1.97.1\nLLVM version: 22.1.6\n" if argv[-1] == "-vV" else "LLVM version 21.1.0-rust-1.97.1-stable\n")
        with self.assertRaisesRegex(ValueError, "same Rust compiler"):
            training.matching_tools("rustc", "profdata", {"PATH": ""}, run)

    def test_malformed_merged_profile_is_refused_before_profile_use(self):
        def refuse(argv, **kwargs):
            result = self.execute(argv, **kwargs)
            return types.SimpleNamespace(returncode=1) if argv[:2] == ["profdata", "show"] else result
        with self.assertRaisesRegex(ValueError, "not a valid matching LLVM profile"):
            training.train("library", "profdata", self.root, self.raw, self.output, {"PATH": ""}, refuse)

    def test_runtime_duplicates_and_escaping_placements_are_rejected(self):
        source = self.root / "source"
        source.write_bytes(b"original source")
        workspace = self.root / "workspace"
        workspace.mkdir()
        for logical in ["../foreign", "/foreign", "a/../foreign"]:
            with self.assertRaises(ValueError):
                training.materialize_runtime([{"path": str(source), "logical": logical}], workspace)
        with self.assertRaisesRegex(ValueError, "duplicated"):
            training.materialize_runtime([{"path": str(source), "logical": "original"}] * 2, workspace)


class Emission(unittest.TestCase):
    def test_profile_is_a_real_target_input_and_host_context_is_unchanged(self):
        host = "aarch64-apple-darwin"
        flags = {"generate": "-Cprofile-generate=target/rust/pgo/profiles", "use": "-Cprofile-use=target/rust/pgo/dataplane.profdata"}
        nodes = {
            "library": {"mode": "test", "target": {"kind": ["lib"], "src_path": generate.LIBRARY}, "rust_flags": ["original-cfg", flags["generate"]]},
            "binary": {"mode": "build", "target": {"kind": ["bin"], "src_path": generate.BINARY}, "rust_flags": ["original-cfg", flags["use"]]},
            "proc_macro": {"mode": "build", "target": {"kind": ["proc-macro"], "src_path": "original.rs"}, "rust_flags": []},
        }
        captured = []

        def declarations(emitted, *args, **kwargs):
            captured.append(copy.deepcopy(emitted))
            self.assertEqual(kwargs, {"profile_training": "library"})
            return {}, []

        units = types.SimpleNamespace(_unit_declarations=declarations, text=json.dumps, starlark=json.dumps)
        roots = {"dataplane-pgo-generate/release/" + host: ["library"], "dataplane-pgo-use/release/" + host: ["binary"]}
        original = copy.deepcopy(nodes)
        bodies = generate.emit(units, [], nodes, roots, {}, None, None, None, host, flags)
        self.assertEqual(nodes, original)
        self.assertEqual(captured[0]["proc_macro"], original["proc_macro"])
        self.assertEqual(captured[0]["binary"]["profile_data"], [":dataplane_profile"])
        self.assertEqual(captured[0]["binary"]["rust_flags"], ["original-cfg", "-Cprofile-use=$(location :dataplane_profile)"])
        self.assertNotIn("profile_data", captured[0]["library"])
        self.assertIn(':u_library_binary', bodies["BUILD.bazel"])
        self.assertIn('dataplane_release', bodies["BUILD.bazel"])
        self.assertEqual(json.loads(bodies["graph.json"])["nodes"], original)

    def test_bzl_training_never_imports_the_harness_files_to_run_nonce(self):
        tree = ast.parse((HERE / "release-pgo.bzl").read_text())
        profile = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_profile_impl")
        actions = [node for node in ast.walk(profile) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "run"]
        self.assertEqual(len(actions), 1)
        tools = next(value.value for value in actions[0].keywords if value.arg == "tools")
        self.assertEqual(ast.unparse(tools), "[ctx.attr._python[DefaultInfo].files_to_run]")
        inputs = next(value.value for value in actions[0].keywords if value.arg == "inputs")
        self.assertIn("runtime.files", ast.unparse(inputs))
        self.assertIn("crate.output", ast.unparse(inputs))
        self.assertNotIn("default_runfiles", ast.unparse(profile))

    def test_original_workload_source_contract(self):
        # This source File is a declared control input, not a selected target or
        # runtime capability. A changed command must update its training binding.
        contents = RELEASE_SCRIPT.read_text()
        marker = "const PGO_TRAINING: readonly PgoWorkload[] = ["
        begin = contents.index(marker) + len(marker)
        end = contents.index("\n];", begin)
        literal = "\n".join(line for line in contents[begin:end].splitlines() if not line.lstrip().startswith("//"))
        expected = """
  { name: 'suite', args: [], mustPass: false },
  {
    name: 'display-pipeline',
    args: ['display::send::tests::production_display_pipeline_benchmark', '--exact', '--ignored'],
    mustPass: true,
  },
  {
    name: 'scroll',
    args: ['production_scroll_literal_benchmark', '--test-threads=1', '--ignored'],
    mustPass: true,
  },"""
        self.assertEqual(literal.strip(), expected.strip())
        self.assertEqual(training.WORKLOADS, (
            ("suite", (), False),
            ("display-pipeline", ("display::send::tests::production_display_pipeline_benchmark", "--exact", "--ignored"), True),
            ("scroll", ("production_scroll_literal_benchmark", "--test-threads=1", "--ignored"), True),
        ))
        self.assertIn("{ name: 'suite', args: [], mustPass: false }", contents)
        self.assertIn("args: ['display::send::tests::production_display_pipeline_benchmark', '--exact', '--ignored']", contents)
        self.assertIn("args: ['production_scroll_literal_benchmark', '--test-threads=1', '--ignored']", contents)
        self.assertIn("message.target.kind.includes('lib')", contents)
        self.assertIn("LLVM_PROFILE_FILE: '/dev/null'", contents)



class TrainedProvenance(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source_inputs = Path(self.temporary.name) / "source_inputs.json"
        self.source_inputs.write_text(json.dumps({"macros": {"apps/daemon/dataplane/Cargo.toml": ["apps/daemon/dataplane/build.rs"]}, "sources": {generate.BINARY: "a" * 64}}))
        self.host = "aarch64-apple-darwin"
        self.nodes = {
            "trained": {"pkg_id": "dataplane", "mode": "build", "platform": self.host, "execution_host": self.host,
                        "target": {"kind": ["bin"], "src_path": generate.BINARY}, "profile": {"name": "release"},
                        "rust_flags": ["-Cprofile-use=target/rust/pgo/dataplane.profdata"], "dependencies": [{"unit": "host"}]},
            "host": {"pkg_id": "dependency", "execution_host": self.host, "dependencies": [], "rust_flags": []},
            "unselected": {"pkg_id": "dataplane", "dependencies": []},
        }
        self.roots = {"dataplane-pgo-use/release/" + self.host: ["trained"]}
        self.packages = {
            "dataplane": {"name": "merkur-dataplane", "version": "1.0.0", "source": None, "license": "MIT", "repository": None, "manifest": "apps/daemon/dataplane/Cargo.toml"},
            "dependency": {"name": "dependency", "version": "1.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "license": "MIT", "repository": None},
        }
        self.notices = {identity: dict(package, license_file=None) for identity, package in self.packages.items()}
        self.units = types.SimpleNamespace(ROOT=Path(self.temporary.name),
            license_metadata=types.SimpleNamespace(check=lambda: self.notices), locked_checksums=lambda root: {},
            source=lambda package: "//apps/daemon/dataplane" if package["source"] is None else "@original_dependency//",
            source_file_label=lambda name: "//apps/daemon/dataplane:" + Path(name).name, starlark=json.dumps)

    def invoke(self):
        return generate.project_provenance(self.units, self.nodes, self.roots, self.packages, self.source_inputs, self.host)

    def test_profile_use_original_closure_is_projected_without_shipping_admission(self):
        original = copy.deepcopy(self.nodes)
        result = self.invoke()
        descriptor = json.loads(result["provenance/merkur_dataplane__profile_use.json"])
        self.assertEqual(descriptor["units"], {key: self.nodes[key] for key in ["trained", "host"]})
        self.assertEqual(descriptor["configuration"]["compiler_root"], "merkur-dataplane/profile_use/" + self.host)
        self.assertEqual(descriptor["macro_inputs"]["dataplane"], ["apps/daemon/dataplane/build.rs"])
        self.assertIn(generate.BINARY, descriptor["source_membership"])
        self.assertIn("apps/daemon/dataplane/build.rs", descriptor["source_membership"])
        self.assertIn(generate.NAMESPACE + "/" + self.host + ":graph.json", result["provenance/BUILD.bazel"])
        self.assertFalse(descriptor["shipping_qualified"])
        self.assertTrue(descriptor["pending"])
        self.assertEqual(self.nodes, original)

    def test_plain_foreign_or_library_root_cannot_supply_pgo_attribution(self):
        original = copy.deepcopy(self.nodes["trained"])
        for field, value in [("rust_flags", []), ("platform", "x86_64-apple-darwin"), ("execution_host", "x86_64-apple-darwin"), ("mode", "test"), ("target", {"kind": ["lib"], "src_path": generate.LIBRARY}), ("profile", {"name": "test"})]:
            self.nodes["trained"] = dict(original, **{field: value})
            with self.assertRaises(ValueError):
                self.invoke()
        self.nodes["trained"] = original
        self.roots[next(iter(self.roots))] = ["trained", "host"]
        with self.assertRaisesRegex(ValueError, "one original"):
            self.invoke()

    def test_original_notice_identity_mismatch_refuses_the_projection(self):
        self.notices["dependency"]["version"] = "foreign"
        with self.assertRaisesRegex(ValueError, "notice identities"):
            self.invoke()


class PhasedCapture(unittest.TestCase):
    def test_profile_use_cannot_be_captured_before_actual_training_inputs(self):
        for phase, profile, context in [("use", None, None), ("use", Path("actual"), None), ("use", None, Path("actual")), ("generate", Path("actual"), None), ("generate", None, Path("actual"))]:
            with self.assertRaises(ValueError):
                generate.phase_inputs(phase, profile, context)
        generate.phase_inputs("generate", None, None)
        generate.phase_inputs("use", Path("actual-profile"), Path("original-context"))

    def test_generate_emits_actual_training_target_without_use_or_shipping_facade(self):
        host = "aarch64-apple-darwin"
        node = {"mode": "test", "target": {"kind": ["lib"], "src_path": generate.LIBRARY}, "rust_flags": ["-Cprofile-generate=target/rust/pgo/profiles"]}
        declarations = mock.Mock(return_value=({}, []))
        units = types.SimpleNamespace(_unit_declarations=declarations, text=json.dumps, starlark=json.dumps)
        result = generate.emit(units, [], {"library": node}, {"dataplane-pgo-generate/release/" + host: ["library"]}, {}, None, None, None, host, {"generate": node["rust_flags"][0], "use": "-Cprofile-use=target/rust/pgo/dataplane.profdata"}, phases=("generate",))
        declarations.assert_called_once()
        self.assertEqual(declarations.call_args.kwargs, {"profile_training": "library"})
        self.assertIn("dataplane_release_profile", result["BUILD.bazel"])
        self.assertNotIn('alias(name = "dataplane_release"', result["BUILD.bazel"])
        self.assertEqual(json.loads(result["roots.bzl"].split(" = ", 1)[1]), {"generate": generate.NAMESPACE + "/" + host + ":u_library_binary"})

    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        profile = root / "actual.profdata"
        profile.write_bytes(b"synthetic profile process contract")
        document = {"package": "dataplane-pgo-generate", "inputs": {"Cargo.lock": "original"}}
        context = root / "original.json"
        context.write_text(json.dumps(document))
        sdk = types.SimpleNamespace(host="aarch64-apple-darwin", rustc=Path("original-rustc"), environment=lambda: {"PATH": ""})
        training_contract = types.SimpleNamespace(matching_tools=lambda *args: None)
        return root, profile, document, context, sdk, training_contract

    def test_real_profile_path_reaches_cargo_before_exact_logical_path_projection(self):
        root, profile, document, context, sdk, training_contract = self.fixture()
        observed = []
        def capture(*args):
            phase, flag = args[4:6]
            observed.append((phase, flag))
            if phase == "generate":
                return document
            return {"unit_graphs": {sdk.host: {"release": {"units": [{"rust_flags": [flag, "original-feature"]}]}}}}
        with mock.patch.object(generate, "capture", side_effect=capture), mock.patch.object(generate.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as llvm:
            result = generate.profile_use_capture(None, sdk, root, {}, context, profile, Path("matching-profdata"), training_contract)
        self.assertEqual(observed[-1], ("use", "-Cprofile-use=" + str(profile.resolve())))
        self.assertEqual(result[1]["unit_graphs"][sdk.host]["release"]["units"][0]["rust_flags"], ["-Cprofile-use=target/rust/pgo/dataplane.profdata", "original-feature"])
        self.assertEqual(llvm.call_args.args[0], ["matching-profdata", "show", str(profile)])

    def test_changed_context_or_malformed_profile_refuses_before_profile_use_cargo(self):
        root, profile, document, context, sdk, training_contract = self.fixture()
        with mock.patch.object(generate, "capture", return_value=document) as cargo, mock.patch.object(generate.subprocess, "run", return_value=types.SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(ValueError, "malformed matching LLVM"):
                generate.profile_use_capture(None, sdk, root, {}, context, profile, Path("matching-profdata"), training_contract)
            self.assertEqual(cargo.call_count, 1)
        context.write_text(json.dumps(dict(document, inputs={})))
        with mock.patch.object(generate, "capture", return_value=document), mock.patch.object(generate.subprocess, "run") as llvm:
            with self.assertRaisesRegex(ValueError, "original instrumented compiler context"):
                generate.profile_use_capture(None, sdk, root, {}, context, profile, Path("matching-profdata"), training_contract)
            llvm.assert_not_called()

    def test_changed_training_bytes_are_refused_after_the_original_target_probe(self):
        root, profile, document, context, sdk, training_contract = self.fixture()
        def capture(*args):
            if args[4] == "generate":
                return document
            profile.write_bytes(b"different training profile")
            return {"unit_graphs": {sdk.host: {"release": {"units": [{"rust_flags": [args[5]]}]}}}}
        with mock.patch.object(generate, "capture", side_effect=capture), mock.patch.object(generate.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(ValueError, "Trained profile bytes changed"):
                generate.profile_use_capture(None, sdk, root, {}, context, profile, Path("matching-profdata"), training_contract)

    def test_rule_phase_inputs_are_bound_to_original_native_labels_and_action_files(self):
        tree = ast.parse((HERE / "release-pgo.bzl").read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_capture_impl")
        calls = []
        class Actions:
            def declare_directory(self, name):
                return types.SimpleNamespace(path=name)
            def run(self, **kwargs):
                calls.append(kwargs)
        class Target(dict):
            def __init__(self, package, name, repo="main"):
                self.label = types.SimpleNamespace(package=package,name=name,repo_name=repo)
                super().__init__(default=types.SimpleNamespace(files_to_run=name))
        sdk = types.SimpleNamespace(descriptor=types.SimpleNamespace(path="descriptor"), provenance=types.SimpleNamespace(path="provenance"), sources=types.SimpleNamespace(path="sources"), registry=types.SimpleNamespace(path="registry"), sdk_files=[])
        sdk_target = Target("tools/bazel/rust/acquire", "workspace_sdk_darwin_arm64")
        sdk_target["sdk"] = sdk
        namespace = "tools/bazel/rust/release_pgo/aarch64-apple-darwin"
        attributes = types.SimpleNamespace(sdk=sdk_target, phase="use", trained_profile=Target(namespace,"dataplane_profile"), instrumented_context=Target(namespace,"contexts/dataplane-pgo-generate.json"), _python=Target("tools", "python"), _profdata=Target("tools", "llvm"), tpm_sim=False)
        files = types.SimpleNamespace(**{name: types.SimpleNamespace(path=name) for name in ["_generator","_resolver","_contexts","_units","_native_helper","metadata","source_inputs","runtime_inputs","_training","trained_profile","instrumented_context"]})
        rust = types.SimpleNamespace(version="1.97.1",exec_triple=types.SimpleNamespace(str="aarch64-apple-darwin"),target_triple=types.SimpleNamespace(str="aarch64-apple-darwin"))
        ctx = types.SimpleNamespace(attr=attributes,file=files,files=types.SimpleNamespace(_unit_helpers=[]),executable=types.SimpleNamespace(_python="python",_profdata=types.SimpleNamespace(path="llvm")),label=types.SimpleNamespace(name="capture",repo_name="main"),actions=Actions(),toolchains={"@rules_rust//rust:toolchain_type":rust})
        def fail(message):
            raise ValueError(message)
        scope = {"CargoAcquisitionSdkInfo":"sdk","DefaultInfo":lambda **kwargs: kwargs,"depset":lambda direct=(),transitive=():list(direct),"fail":fail}
        class Default:
            def __call__(self, **kwargs):
                return kwargs
        default = Default()
        for value in [attributes._python, attributes._profdata]: value[default] = value["default"]
        scope["DefaultInfo"] = default
        exec(compile(ast.Module(body=[function],type_ignores=[]),"capture.bzl","exec"),scope)
        scope["_capture_impl"](ctx)
        self.assertEqual(calls[0]["tools"], ["python","llvm"])
        self.assertIn(files.trained_profile,calls[0]["inputs"])
        self.assertIn(files.instrumented_context,calls[0]["inputs"])
        self.assertNotIn(attributes.trained_profile,calls[0]["tools"])
        for field, value in [("repo_name","foreign"),("package","tools/bazel/rust/release_pgo/x86_64-apple-darwin"),("name","foreign")]:
            original = getattr(attributes.trained_profile.label,field)
            setattr(attributes.trained_profile.label,field,value)
            with self.assertRaisesRegex(ValueError,"original native producer identities"):
                scope["_capture_impl"](ctx)
            setattr(attributes.trained_profile.label,field,original)
        self.assertEqual(len(calls),1)


class SourceTreePresentation(unittest.TestCase):
    def setUp(self):
        self.private = tempfile.TemporaryDirectory(prefix="pgo-source-carriers-")
        self.addCleanup(self.private.cleanup)
        self.base = Path(self.private.name).resolve()
        self.original = self.base / "original/execroot/_main"
        self.presented = self.base / "sandbox/execroot/_main"
        self.original.mkdir(parents=True)
        self.presented.mkdir(parents=True)
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        self.prefix = Path("bazel-out/native/bin/sdk")
        self.source = self.prefix / "workspace.sources"
        self.descriptor = self.prefix / "workspace.descriptor.json"
        self.provenance_path = self.prefix / "workspace.provenance.json"
        files = {self.source / "Cargo.lock": b'[[package]]\nname="original"\nversion="0.1.0"\n',
                 self.source / "scripts/build-daemon-artifacts.ts": b"original release source",
                 self.prefix / "cargo": b"original cargo", self.prefix / "rustc": b"original rustc"}
        for path, body in files.items():
            target = self.original / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        os.chdir(self.original)
        descriptor = {"version": "1.97.1", "execution_host": "aarch64-apple-darwin",
                      "cargo": generate.fact(self.prefix / "cargo"), "rustc": generate.fact(self.prefix / "rustc"),
                      "sdk": [generate.fact(self.prefix / name) for name in ["cargo", "rustc"]],
                      "locks": [generate.fact(self.source / "Cargo.lock")],
                      "registry": {"directory": None, "packages": [], "files": []}}
        (self.original / self.descriptor).write_text(json.dumps(descriptor))
        self.producer = "@@//tools/bazel/rust/acquire:workspace_sdk_darwin_arm64"
        self.provenance = {"execution_host": descriptor["execution_host"], "producer": self.producer,
                           "descriptor": generate.fact(self.descriptor),
                           "source_files": [generate.fact(path) for path in files if path.is_relative_to(self.source)]}
        (self.original / self.provenance_path).write_text(json.dumps(self.provenance))
        for path in [*files, self.descriptor, self.provenance_path]:
            target = self.presented / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(self.original / path)
        os.chdir(self.presented)
        self.resolver = load("acquisition_sdk")
        def identity(argv, **kwargs):
            self.assertEqual(kwargs["env"], {"PATH": ""})
            return types.SimpleNamespace(stdout=Path(argv[0]).name + " 1.97.1\nrelease: 1.97.1\nhost: aarch64-apple-darwin\n")
        with mock.patch.object(self.resolver.subprocess, "run", side_effect=identity):
            self.sdk = self.resolver.NativeCargoSdk.load(self.descriptor)
        self.addCleanup(self.sdk.close)

    def source_inputs(self):
        return generate.original_sources(self.sdk, self.sdk.original_tree(self.source), self.provenance,
                                         self.descriptor, self.producer)

    def test_presented_leaf_root_refuses_and_original_descriptor_root_preserves_sources(self):
        with self.assertRaises(ValueError):
            generate.original_sources(self.sdk, self.source.resolve(strict=True), self.provenance,
                                      self.descriptor, self.producer)
        self.assertEqual(set(self.source_inputs()), {"Cargo.lock", "scripts/build-daemon-artifacts.ts"})

    def test_foreign_same_byte_source_carrier_refuses(self):
        relative = self.source / "scripts/build-daemon-artifacts.ts"
        foreign = self.base / "foreign-source.ts"
        foreign.write_bytes((self.original / relative).read_bytes())
        (self.presented / relative).unlink()
        (self.presented / relative).symlink_to(foreign)
        with self.assertRaises(ValueError):
            self.source_inputs()

    def test_changed_source_and_added_original_member_refuse(self):
        source = self.original / self.source / "scripts/build-daemon-artifacts.ts"
        original = source.read_bytes()
        source.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "original source File changed"):
            self.source_inputs()
        source.write_bytes(original)
        (source.parent / "unlisted.ts").write_bytes(b"undeclared")
        with self.assertRaisesRegex(ValueError, "File membership changed"):
            self.source_inputs()

    def main_fixture(self):
        units = types.SimpleNamespace(license_metadata=types.SimpleNamespace())
        modules = {"declared_release_pgo_contexts": object(), "declared_release_pgo_sdk": types.SimpleNamespace(NativeCargoSdk=types.SimpleNamespace(load=lambda path: self.sdk)),
                   "declared_release_pgo_source_helper": object(), "declared_release_pgo_units": units}
        arguments = ["pgo", "--phase", "generate", "--producer", self.producer]
        paths = {"sdk-descriptor": self.descriptor, "sdk-provenance": self.provenance_path,
                 "source-root": self.source}
        for name in ["sdk-descriptor", "sdk-provenance", "sdk-resolver", "source-root", "contexts-helper", "unit-emitter", "native-helper", "metadata", "source-inputs", "runtime-inputs", "output"]:
            arguments += ["--" + name, str(paths.get(name, self.descriptor))]
        return units, modules, arguments

    def test_main_binds_emitter_roots_before_source_capture(self):
        units, modules, arguments = self.main_fixture()
        class ReachedCapture(Exception):
            pass
        def capture(*args):
            root = self.original / self.source
            self.assertEqual(args[2], root)
            self.assertEqual((units.ROOT, units.HERE, units.DEST), (root, root / "tools/bazel/rust", root / "tools/bazel/rust/units"))
            self.assertEqual(units.license_metadata.ROOT, root)
            self.assertEqual(units.license_metadata.DEST, root / "tools/bazel/rust/license_metadata.json")
            raise ReachedCapture()
        original_path = list(sys.path)
        self.addCleanup(setattr, sys, "path", original_path)
        with mock.patch.object(sys, "argv", arguments), mock.patch.object(generate, "load", side_effect=lambda name, path: modules[name]), mock.patch.object(generate, "capture", side_effect=capture):
            with self.assertRaises(ReachedCapture):
                generate.main()

    def test_main_rejected_source_tree_closes_sdk(self):
        _, modules, arguments = self.main_fixture()
        source = self.original / self.source
        foreign = self.base / "foreign-original-source"
        source.rename(foreign)
        source.symlink_to(foreign, target_is_directory=True)
        original_path = list(sys.path)
        self.addCleanup(setattr, sys, "path", original_path)
        with mock.patch.object(sys, "argv", arguments), mock.patch.object(generate, "load", side_effect=lambda name, path: modules[name]), mock.patch.object(self.sdk, "close", wraps=self.sdk.close) as close:
            with self.assertRaisesRegex(ValueError, "original declared Tree is an alias"):
                generate.main()
            close.assert_called_once_with()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-script", type=Path, default=RELEASE_SCRIPT)
    options, remaining = parser.parse_known_args()
    RELEASE_SCRIPT = options.release_script
    unittest.main(argv=[sys.argv[0], *remaining])
