"""Scoped declaration controls; fixture Cargo graphs are not native qualification."""
import argparse
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location("simulator_generate", Path(__file__).with_name("simulator_generate.py"))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
HOST = "aarch64-apple-darwin"
FLAGS = ["--cfg", "merkur_sim", "--cfg", "tokio_unstable"]


class SimulatorGeneratorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="simulator-scoped-controls-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        for path, text in {
            "BUILD.bazel": "package(default_visibility = [\"//visibility:public\"])\n",
            "tools/sim/BUILD.bazel": "# original source package boundary\n",
            "tools/sim/manifest.toml": '[package]\nname="merkur-sim"\nversion="0.1.0"\n[lib]\npath="src/lib.rs"\n',
            "tools/sim/src/lib.rs": "// synthetic original library\n",
            "tools/sim/tests/retained.rs": "// synthetic retained harness\n",
            "tools/sim/tests/rotation.rs": "// synthetic added harness\n",
        }.items():
            file = self.root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text)
        package = {"id": generator.PACKAGE, "name": "merkur-sim", "version": "0.1.0", "source": None,
                   "manifest": "tools/sim/manifest.toml", "features": {}, "links": None}
        self.packages = {generator.PACKAGE: package}
        self.nodes = {}
        profile = {"name": "release", "opt_level": "3", "debuginfo": 0, "debug_assertions": False,
                   "overflow_checks": False, "panic": "unwind", "codegen_units": None,
                   "lto": "false", "rpath": False}
        def node(mode, name, kind, source, dependencies=()):
            return {"pkg_id": generator.PACKAGE, "mode": mode, "execution_host": HOST, "platform": None,
                    "target": {"name": name, "kind": [kind], "src_path": source, "crate_types": ["lib"] if kind == "lib" else ["bin"], "edition": "2024"},
                    "profile": profile.copy(), "rust_flags": [] if mode == "doctest" else FLAGS[:],
                    "dependencies": list(dependencies), "features": [], "emit_cdylib": False}
        self.nodes["library"] = node("build", "merkur_sim", "lib", "tools/sim/src/lib.rs")
        self.nodes["lib-test"] = node("test", "merkur_sim", "lib", "tools/sim/src/lib.rs")
        for name in ["retained", "rotation"]:
            self.nodes[name] = node("test", name, "test", "tools/sim/tests/" + name + ".rs")
        self.nodes["doc"] = node("doctest", "merkur_sim", "lib", "tools/sim/src/lib.rs", [{"unit": "library", "extern_crate_name": "merkur_sim"}])
        self.roots = {"merkur-sim/test/" + HOST: ["lib-test", "retained", "rotation", "doc"]}

    def bind(self):
        return generator.bindings(self.root, self.nodes, self.roots, self.packages, HOST)

    def test_original_library_all_authored_harnesses_and_rustdoc_relation(self):
        result = self.bind()
        self.assertEqual(set(result), {"build", "tests", "doctest"})
        self.assertEqual(set(result["tests"]), {"lib", "retained", "rotation"})
        self.assertTrue(result["build"].endswith(":u_library"))
        self.assertTrue(result["tests"]["rotation"].endswith(":u_rotation"))
        self.assertTrue(result["doctest"].endswith(":u_doc"))

    def test_missing_rotation_or_rustdoc_refuses(self):
        for omitted in ["rotation", "doc"]:
            with self.subTest(omitted=omitted):
                saved = self.roots.copy()
                self.roots = {next(iter(saved)): [key for key in next(iter(saved.values())) if key != omitted]}
                with self.assertRaises(ValueError):
                    self.bind()
                self.roots = saved

    def test_library_is_derived_from_actual_doctest_edge(self):
        self.nodes["doc"]["dependencies"] = []
        with self.assertRaisesRegex(ValueError, "compiled library dependency"):
            self.bind()

    def test_native_profile_flag_and_original_source_mutations_refuse(self):
        original = copy.deepcopy(self.nodes)
        for mutate in [lambda node: node.update(execution_host="x86_64-apple-darwin"),
                       lambda node: node["profile"].update(name="test"),
                       lambda node: node.update(rust_flags=[]),
                       lambda node: node["target"].update(src_path="tools/sim/tests/retained.rs"),
                       lambda node: node.update(pkg_id="workspace:foreign")]:
            self.nodes = copy.deepcopy(original)
            mutate(self.nodes["rotation"])
            with self.assertRaises(ValueError):
                self.bind()

    def test_named_lib_binary_cannot_substitute_library_harness(self):
        self.nodes["lib-test"]["target"].update(kind=["bin"], name="lib", src_path="tools/sim/src/main.rs")
        with self.assertRaisesRegex(ValueError, "authored harness"):
            self.bind()

    def test_foreign_context_and_duplicate_root_refuse(self):
        old = self.roots
        self.roots = {"foreign/test/" + HOST: next(iter(old.values()))}
        with self.assertRaises(ValueError): self.bind()
        self.roots = old
        next(iter(self.roots.values())).append("rotation")
        with self.assertRaises(ValueError): self.bind()

    def test_capture_is_scoped_and_original_source_is_unchanged(self):
        (self.root / "Cargo.toml").write_text("[workspace]\nmembers=[]\n")
        before = {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        original_directory = self.root / "unrelated-global-contexts"
        contexts = SimpleNamespace(ROOT=self.root / "foreign", DIRECTORY=original_directory)
        def capture(sdk, version, production):
            self.assertEqual(version, "1.97.1")
            self.assertEqual(contexts.ROOT, self.root)
            self.assertNotEqual(contexts.DIRECTORY, original_directory)
            directory = contexts.DIRECTORY / "merkur-sim/simulator-test/native"
            originals = {"Cargo.toml": b"original generated workspace", "Cargo.lock": b"retained simulator lock",
                         "merkur-sim/Cargo.toml": b"original generated member", "BUILD.bazel": b"original exports"}
            for name, data in originals.items():
                file = directory / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
            return {"generated_inputs": {name: hashlib.sha256(data).hexdigest() for name, data in originals.items() if name != "BUILD.bazel"}}
        contexts.capture_simulator = capture
        document, generated = generator.capture(contexts, SimpleNamespace(), self.root)
        self.assertEqual(set(generated), {"Cargo.toml", "Cargo.lock", "merkur-sim/Cargo.toml", "BUILD.bazel"})
        self.assertEqual(contexts.ROOT, self.root / "foreign")
        self.assertEqual(contexts.DIRECTORY, original_directory)
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.root.rglob("*") if path.is_file()})
        self.assertFalse(original_directory.exists())

    def test_existing_emitter_uses_original_simulator_manifest_without_global_render(self):
        sys.path.insert(0, str(Path(args.unit_helpers).resolve()))
        units = generator.load("simulator_control_emitter", Path(args.unit_emitter))
        units.ROOT = self.root
        metadata = self.root / "metadata.json"
        metadata.write_text(json.dumps({"members": [], "packages": list(self.packages.values())}))
        discovery = self.root / "discovery.json"
        discovery.write_text(json.dumps({"macros": {}}))
        runtime = self.root / "runtime.json"
        runtime.write_text("{}")
        units.locked_checksums = lambda root: {}
        result = generator.emit(units, self.root, {"package": "merkur-sim"}, {"Cargo.lock": b"original simulator lock"},
                                self.nodes, self.roots, self.packages, metadata, discovery, runtime, HOST)
        self.assertEqual(set(result), {"BUILD.bazel", "roots.bzl", "operations.bzl", "graph.json", "archives.MODULE.bazel", "context/metadata.json", "context/Cargo.lock"})
        self.assertIn(b'manifest = "//tools/sim:manifest.toml"', result["BUILD.bazel"])
        self.assertNotIn(b'//tools/sim:Cargo.toml', result["BUILD.bazel"])
        self.assertNotIn(b'workspace_test', result["BUILD.bazel"])
        self.assertIn(b'u_rotation"', result["roots.bzl"])
        self.assertNotIn(b'_binary', result["roots.bzl"])
        self.assertIn(b'"operations.bzl"', result["BUILD.bazel"])
        self.assertFalse((self.root / "tools/bazel/rust/units").exists())

    def test_output_is_owned_and_nonempty_precreated_tree_refuses(self):
        output = self.root / "output"
        generator.publish(output, {"context/metadata.json": b"original"})
        with self.assertRaises(ValueError):
            generator.publish(output, {"context/metadata.json": b"replaced"}, True)
        self.assertEqual((output / "context/metadata.json").read_bytes(), b"original")

    def test_declared_native_formatter_preserves_original_graph_and_is_deterministic(self):
        original = (json.dumps({"nodes": self.nodes, "roots": self.roots}, sort_keys=True, indent=2) + "\n").encode()
        result = generator.format_graph(original, HOST, Path(args.biome), Path(args.biome_config))
        self.assertEqual(json.loads(result), json.loads(original))
        self.assertNotEqual(result, original)
        self.assertEqual(generator.format_graph(result, HOST, Path(args.biome), Path(args.biome_config)), result)
        with patch.object(generator.subprocess, "run", return_value=SimpleNamespace(stdout=b'{"changed":true}')):
            with self.assertRaisesRegex(ValueError, "changed the original Cargo graph"):
                generator.format_graph(original, HOST, Path(args.biome), Path(args.biome_config))
        with self.assertRaises(FileNotFoundError):
            generator.format_graph(original, HOST, self.root / "missing-biome", Path(args.biome_config))

    def test_selected_simulator_operation_rows_use_all_captured_roots_only(self):
        binding = generator.bindings(self.root, self.nodes, self.roots, self.packages, HOST)
        rows, targets, canonical = generator.operations(binding, HOST)
        self.assertEqual(set(rows), {HOST})
        expected = ["//tools/sim:simulator_test__aarch64_apple_darwin__" + role for role in ["lib", "retained", "rotation", "doctest"]]
        self.assertEqual(targets, {HOST: expected})
        self.assertEqual(canonical, {HOST: {label: label for label in expected}})
        self.assertEqual(rows[HOST]["operations"], [{"name": "test:sim", "checks": [{"label": label, "kind": "test", "fresh": True} for label in expected], "pending": ["Complete native simulator compiler/SDK/runtime qualification"]}])

    def test_source_driven_runnable_factory_uses_existing_package_wrappers(self):
        source = Path(__file__).parents[2] / "sim/sim_targets.bzl"
        tree = ast.parse(source.read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "declare_simulator_targets")
        hosts = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_HOSTS" for target in node.targets))
        # Add one original authored harness to this fixture rather than a fixed target list.
        (self.root / "tools/sim/tests/sweep.rs").write_text("// original sweep fixture")
        sweep_node = copy.deepcopy(self.nodes["rotation"])
        sweep_node["target"]["name"] = "sweep"
        sweep_node["target"]["src_path"] = "tools/sim/tests/sweep.rs"
        self.nodes["sweep"] = sweep_node
        self.roots["merkur-sim/test/" + HOST].append("sweep")
        binding = generator.bindings(self.root, self.nodes, self.roots, self.packages, HOST)
        calls = {name: [] for name in ["bun", "doc", "alias", "suite"]}
        def fail(message): raise ValueError(message)
        symbols = {
            "_HOSTS": hosts, "fail": fail,
            "bun_command_test": lambda **attributes: calls["bun"].append(attributes),
            "configured_public_rust_test": lambda **attributes: calls["doc"].append(attributes),
            "native": SimpleNamespace(glob=lambda patterns: ["tests/" + path.name for path in sorted((self.root / "tools/sim/tests").glob("*.rs"))], alias=lambda **attributes: calls["alias"].append(attributes), test_suite=lambda **attributes: calls["suite"].append(attributes)),
            "select": lambda choices, no_match_error: {"choices": choices, "error": no_match_error},
        }
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), symbols)
        symbols["declare_simulator_targets"]({HOST: binding})
        self.assertEqual(len(calls["bun"]), 5)
        for role in sorted(binding["tests"]):
            target = next(value for value in calls["bun"] if value["name"].endswith("__" + role) and value["fixed_args"] == ["test"])
            self.assertEqual(target["tools"], {binding["tests"][role]: "merkur-sim"})
            self.assertEqual(target["tool_environment"], {"merkur-sim": "MERKUR_SIM_BINARY"})
            self.assertEqual(target["entry_point"], "//tools/bazel/rust:sim_runner.ts")
            self.assertEqual(target["data"], [":sources"])
            self.assertEqual(target["bun_config"], "//tools/bazel/bun:empty-bunfig.toml")
            self.assertEqual(target["target_compatible_with"], hosts[HOST])
            self.assertEqual(target["exec_compatible_with"], hosts[HOST])
        self.assertEqual(calls["doc"][0]["binary"], binding["doctest"])
        sweep = next(value for value in calls["bun"] if value["fixed_args"] == ["sweep"])
        self.assertEqual(sweep["tools"], {binding["tests"]["sweep"]: "merkur-sim"})
        self.assertEqual(sweep["tool_environment"], {"merkur-sim": "MERKUR_SIM_BINARY"})
        self.assertIn("no-cache", sweep["tags"])
        self.assert_launcher_tool_environment(calls["bun"])
        for target in calls["alias"]:
            self.assertNotIn("//conditions:default", target["actual"]["choices"])
        self.assertEqual(len(calls["suite"][0]["tests"]["choices"]["//tools/bazel/rust/acquire:workspace_sdk_host_darwin_arm64"]), 5)
        for bad in [{}, {"wasm32-unknown-unknown": binding}, {HOST: dict(binding, tests={role: value for role, value in binding["tests"].items() if role != "rotation"})}, {HOST: dict(binding, tests=dict(binding["tests"], rotation=binding["tests"]["rotation"] + "_binary"))}, {HOST: dict(binding, doctest=binding["build"])}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                symbols["declare_simulator_targets"](bad)

    def assert_launcher_tool_environment(self, calls):
        source = Path(args.bun_rules)
        tree = ast.parse(source.read_text())
        launcher = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_launcher_impl")
        directory = next(node for node in launcher.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "tool_directory" for target in node.targets))
        start = next(index for index, node in enumerate(launcher.body) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "tool_environment" for target in node.targets))
        end = next(index for index, node in enumerate(launcher.body) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "environment_files" for target in node.targets))
        emission = compile(ast.Module(body=[directory, *launcher.body[start:end]], type_ignores=[]), str(source), "exec")
        class StarlarkString(str):
            def elems(self): return self
        def fail(message): raise ValueError(message)
        def quote(value): return "'" + value.replace("'", "'\"'\"'") + "'"
        for call in calls:
            with self.subTest(launcher=call["name"]):
                ctx = SimpleNamespace(label=SimpleNamespace(package="tools/sim", name=call["name"]),
                                      attr=SimpleNamespace(tool_environment={key: StarlarkString(value) for key, value in call["tool_environment"].items()}))
                symbols = {"ctx": ctx, "tool_names": list(call["tools"].values()), "_quote": quote, "fail": fail}
                exec(emission, symbols)
                expected = 'export MERKUR_SIM_BINARY="${runfiles}/_main/"' + quote("tools/sim/" + call["name"] + ".tools") + "/" + quote("merkur-sim")
                self.assertEqual(symbols["tool_environment"], [expected])
                ctx.attr.tool_environment = {}
                exec(emission, symbols)
                self.assertEqual(symbols["tool_environment"], [])
                ctx.attr.tool_environment = {"undeclared": StarlarkString("MERKUR_SIM_BINARY")}
                with self.assertRaisesRegex(ValueError, "declared executable"):
                    exec(emission, symbols)

    def test_capture_declares_the_exact_formatter_package_at_its_action_path(self):
        source = Path(__file__).with_name("simulator-capture.bzl")
        function = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == "_capture_impl")
        class Provider:
            def __call__(self, **fields): return fields
        default, native_tool = Provider(), Provider()
        original = SimpleNamespace(is_source=True, short_path="tools/sim/tests/rotation.rs", path="tools/sim/tests/rotation.rs")
        package = SimpleNamespace(path="bazel-out/native-exec/bin/original-biome-package", is_directory=True)
        sdk = SimpleNamespace(original_sources={original.short_path: original}, sdk_files=object())
        for name in ["descriptor", "provenance", "sources", "registry"]:
            setattr(sdk, name, SimpleNamespace(path="sdk/" + name, owner="//actual:sdk"))
        files = {name: SimpleNamespace(path="declared/" + name) for name in ["_generator", "_resolver", "_contexts", "_units", "_native_helper", "metadata", "source_inputs", "runtime_inputs", "_biome_config"]}
        python_runfiles, biome_runfiles = object(), object()
        attrs = SimpleNamespace(sdk={"sdk": sdk}, _biome={native_tool: SimpleNamespace(package=package, member="biome"), default: SimpleNamespace(files_to_run=biome_runfiles)},
                                _python={default: SimpleNamespace(files_to_run=python_runfiles)},
                                simulator_sources=SimpleNamespace(label=SimpleNamespace(repo_name="", package="tools/sim", name="sources")))
        actions = []
        output = SimpleNamespace(path="captured-original")
        ctx = SimpleNamespace(attr=attrs, file=SimpleNamespace(**files), files=SimpleNamespace(_unit_helpers=[], simulator_sources=[original]),
                              executable=SimpleNamespace(_python=SimpleNamespace(path="declared/python")), label=SimpleNamespace(repo_name="", name="capture"),
                              actions=SimpleNamespace(declare_directory=lambda name: output, run=lambda **fields: actions.append(fields)),
                              toolchains={"@rules_rust//rust:toolchain_type": SimpleNamespace(version="1.97.1", exec_triple=SimpleNamespace(str=HOST), target_triple=SimpleNamespace(str=HOST))})
        def fail(message): raise ValueError(message)
        symbols = {"CargoAcquisitionSdkInfo": "sdk", "NativeVerificationToolInfo": native_tool, "DefaultInfo": default,
                   "fail": fail, "depset": lambda direct, transitive=(): SimpleNamespace(direct=direct, transitive=transitive)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), symbols)
        symbols["_capture_impl"](ctx)
        self.assertEqual(len(actions), 1)
        action = actions[0]
        self.assertTrue(any(file is package for file in action["inputs"].direct))
        self.assertEqual(action["arguments"][action["arguments"].index("--biome") + 1], package.path + "/biome")
        self.assertEqual(action["tools"], [python_runfiles, biome_runfiles])
        self.assertEqual(action["inputs"].transitive, [sdk.sdk_files])

    def test_capture_factory_has_fixed_exec_constraints_and_one_selected_alias(self):
        source = Path(__file__).with_name("simulator-capture.bzl")
        tree = ast.parse(source.read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "declare_simulator_captures")
        captures = []
        aliases = []
        symbols = {
            "simulator_capture": lambda **attributes: captures.append(attributes),
            "native": SimpleNamespace(alias=lambda **attributes: aliases.append(attributes)),
            "select": lambda choices: choices,
        }
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), symbols)
        original = {
            "name": "capture_simulator",
            "sdk": "//tools/bazel/rust/acquire:production_sdk",
            "simulator_sources": "//tools/sim:sources",
            "metadata": ":metadata.json",
            "source_inputs": ":source_inputs.json",
            "runtime_inputs": ":runtime_inputs.json",
            "tags": ["manual"],
        }
        symbols["declare_simulator_captures"](**original)
        constraints = {
            "darwin_arm64": ["@platforms//os:osx", "@platforms//cpu:aarch64"],
            "darwin_x64": ["@platforms//os:osx", "@platforms//cpu:x86_64"],
            "linux_arm64": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
            "linux_x64": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
        }
        self.assertEqual(len(captures), 4)
        for captured, (host, fixed) in zip(captures, constraints.items()):
            self.assertEqual(captured, dict(original, name="capture_simulator_" + host, target_compatible_with=fixed, exec_compatible_with=fixed))
            self.assertIsInstance(captured["exec_compatible_with"], list)
        self.assertEqual(len(aliases), 1)
        self.assertEqual(aliases[0], {
            "name": "capture_simulator",
            "actual": {**{"//tools/bazel/rust/acquire:workspace_sdk_host_" + host: ":capture_simulator_" + host for host in constraints}, "//conditions:default": ":capture_simulator_darwin_arm64"},
            "target_compatible_with": {**{"//tools/bazel/rust/acquire:workspace_sdk_host_" + host: [] for host in constraints}, "//conditions:default": ["@platforms//:incompatible"]},
            "tags": ["manual"],
        })

    def test_declared_current_simulator_files_must_belong_to_same_sdk(self):
        # Execute the rule's source-custody checks before its action emission.
        source = Path(__file__).with_name("simulator-capture.bzl")
        tree = ast.parse(source.read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_capture_impl")
        action = next(index for index, node in enumerate(function.body) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "output" for target in node.targets))
        function.body = function.body[:action]
        def fail(message): raise ValueError(message)
        symbols = {"CargoAcquisitionSdkInfo": "sdk", "NativeVerificationToolInfo": "biome", "fail": fail}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), symbols)
        class SourceFile:
            is_source = True
            short_path = "tools/sim/tests/rotation.rs"
        original = SourceFile()
        sdk = SimpleNamespace(original_sources={original.short_path: original})
        target = SimpleNamespace(label=SimpleNamespace(repo_name="", package="tools/sim", name="sources"))
        ctx = SimpleNamespace(attr=SimpleNamespace(sdk={"sdk": sdk}, simulator_sources=target, _biome={"biome": SimpleNamespace(member="biome")}),
                              files=SimpleNamespace(simulator_sources=[original]), label=SimpleNamespace(repo_name=""),
                              toolchains={"@rules_rust//rust:toolchain_type": SimpleNamespace(version="1.97.1", exec_triple=SimpleNamespace(str=HOST), target_triple=SimpleNamespace(str=HOST))})
        rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
        hosts = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]
        for host in hosts:
            with self.subTest(host=host):
                rust.exec_triple.str = host
                rust.target_triple.str = host
                symbols["_capture_impl"](ctx)
                for other in hosts:
                    if other != host:
                        rust.target_triple.str = other
                        with self.assertRaisesRegex(ValueError, "Rust1.97.1"):
                            symbols["_capture_impl"](ctx)
                rust.target_triple.str = host
        for host in ["wasm32-unknown-unknown", "x86_64-pc-windows-msvc"]:
            rust.exec_triple.str = host
            rust.target_triple.str = host
            with self.assertRaisesRegex(ValueError, "Rust1.97.1"):
                symbols["_capture_impl"](ctx)
        rust.exec_triple.str = HOST
        rust.target_triple.str = HOST
        rust.version = "1.96.0"
        with self.assertRaisesRegex(ValueError, "Rust1.97.1"):
            symbols["_capture_impl"](ctx)
        rust.version = "1.97.1"
        ctx.attr._biome["biome"].member = "foreign"
        with self.assertRaisesRegex(ValueError, "declared native Biome"):
            symbols["_capture_impl"](ctx)
        ctx.attr._biome["biome"].member = "biome"
        declaration = next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "simulator_capture" for target in node.targets))
        attributes = next(keyword.value for keyword in declaration.keywords if keyword.arg == "attrs")
        sdk_attribute = next(value for key, value in zip(attributes.keys, attributes.values) if ast.literal_eval(key) == "sdk")
        self.assertEqual(next(ast.literal_eval(keyword.value) for keyword in sdk_attribute.keywords if keyword.arg == "cfg"), "exec")
        sdk.original_sources = {}
        with self.assertRaisesRegex(ValueError, "missing from the typed SDK"):
            symbols["_capture_impl"](ctx)
        sdk.original_sources = {original.short_path: SourceFile()}
        with self.assertRaises(ValueError): symbols["_capture_impl"](ctx)
        sdk.original_sources = {original.short_path: original}
        target.label.name = "subset"
        with self.assertRaisesRegex(ValueError, "complete original"):
            symbols["_capture_impl"](ctx)

    def test_original_capture_retains_registry_target_facts_and_refuses_escape(self):
        source = Path(args.contexts_helper)
        function = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == "capture_simulator")
        start = next(index for index, node in enumerate(function.body) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "registry_targets" for target in node.targets))
        end = next(index for index, node in enumerate(function.body) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "original_id" for target in node.targets))
        statements = ast.Module(body=function.body[start:end], type_ignores=[])
        crate = self.root / "publisher"
        crate.mkdir()
        (crate / "Cargo.toml").write_text("original manifest")
        (crate / "lib.rs").write_text("original source")
        identity = generator.REGISTRY + "#scoped-tls@1.0.1"
        raw = {"packages": [{"id": identity, "source": generator.REGISTRY, "manifest_path": str(crate / "Cargo.toml"),
                             "targets": [{"name": "scoped_tls", "kind": ["lib"], "edition": "2015", "src_path": str(crate / "lib.rs") }]}]}
        normalized = {"packages": [{"id": identity, "source": generator.REGISTRY}]}
        globals = {"Path": Path, "raw": raw, "normalized": normalized}
        exec(compile(statements, str(source), "exec"), globals)
        self.assertEqual(normalized["packages"][0]["targets"], [{"name": "scoped_tls", "kind": ["lib"], "edition": "2015", "source": "lib.rs"}])
        raw["packages"][0]["targets"].append({"name": "unpublished_example", "kind": ["example"], "edition": "2015", "src_path": str(crate / "examples/missing.rs")})
        exec(compile(statements, str(source), "exec"), globals)
        self.assertEqual(normalized["packages"][0]["targets"][1]["source"], "examples/missing.rs")
        self.assertFalse((crate / "examples/missing.rs").exists())
        raw["packages"][0]["targets"][0]["src_path"] = str(self.root / "tools/sim/src/lib.rs")
        with self.assertRaises(ValueError):
            exec(compile(statements, str(source), "exec"), globals)

    def registry_fixture(self):
        helper = generator.load("simulator_registry_source_helper", Path(args.unit_helpers) / "native_protocol_generate.py")
        resolver = generator.load("simulator_registry_sdk", Path(args.unit_helpers) / "acquisition_sdk.py")
        registry = self.root / "registry"
        crate = registry / "scoped-tls-1.0.1"
        checksum = "a" * 64
        for name, body in {"Cargo.toml": '[package]\nname="scoped-tls"\nversion="1.0.1"\n',
                           "src/lib.rs": "// publisher source", "src/other.rs": "// other original member"}.items():
            path = crate / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body)
        hashes = {str(path.relative_to(crate)): generator.fact(path)["sha256"] for path in crate.rglob("*") if path.is_file()}
        (crate / ".cargo-checksum.json").write_text(json.dumps({"package": checksum, "files": hashes}))
        lock = '[[package]]\nname="scoped-tls"\nversion="1.0.1"\nsource=' + json.dumps(generator.REGISTRY) + '\nchecksum=' + json.dumps(checksum) + '\n'
        (self.root / "Cargo.lock").write_text("package=[]\n")
        (self.root / "tools/sim/Cargo.lock").write_text(lock)
        sdk = resolver.NativeCargoSdk.__new__(resolver.NativeCargoSdk)
        sdk.descriptor = {"registry": {"directory": str(registry), "packages": [{"name": "scoped-tls", "version": "1.0.1", "checksum": checksum}],
                                      "files": [generator.fact(path) for path in sorted(registry.rglob("*")) if path.is_file()]}}
        sdk.lock_paths = [self.root / "Cargo.lock", self.root / "tools/sim/Cargo.lock"]
        identity = generator.REGISTRY + "#scoped-tls@1.0.1"
        package = {"id": identity, "name": "scoped-tls", "version": "1.0.1", "source": generator.REGISTRY,
                   "edition": "2015", "features": {}, "targets": [{"name": "scoped_tls", "kind": ["lib"], "edition": "2015", "source": "src/lib.rs"}]}
        self.packages[identity] = package
        self.nodes["registry"] = {"pkg_id": identity, "mode": "build", "target": {"name": "scoped_tls", "kind": ["lib"], "edition": "2015", "src_path": "src/lib.rs"}}
        metadata = self.root / "metadata.json"
        metadata.write_text('{"packages":[]}')
        discovery = self.root / "discovery.json"
        discovery.write_text(json.dumps({"metadata_sha256": generator.fact(metadata)["sha256"], "macros": {}, "sources": {}, "included_sources": {}}))
        runtime = self.root / "runtime.json"
        runtime.write_text("{}")
        inputs = {str(path.relative_to(self.root)): generator.fact(path)["sha256"] for path in (self.root / "tools/sim").rglob("*.rs")}
        return helper, sdk, metadata, discovery, runtime, inputs, package, crate

    def test_simulator_only_registry_dependency_uses_original_sdk_and_retained_lock(self):
        helper, sdk, metadata, discovery, runtime, inputs, _, _ = self.registry_fixture()
        generator.selected_inputs(helper, sdk, self.root, self.nodes, self.packages, metadata, discovery, runtime, inputs)

    def test_simulator_registry_identity_target_pin_and_member_mutations_refuse(self):
        helper, sdk, metadata, discovery, runtime, inputs, package, crate = self.registry_fixture()
        original_package, original_node, original_descriptor = copy.deepcopy(package), copy.deepcopy(self.nodes["registry"]), copy.deepcopy(sdk.descriptor)
        for mutate in [lambda: package.update(version="1.0.2"),
                       lambda: package.update(id="foreign"),
                       lambda: self.nodes["registry"]["target"].update(src_path="src/other.rs"),
                       lambda: self.nodes["registry"]["target"].update(edition="2024"),
                       lambda: sdk.descriptor["registry"]["packages"][0].update(checksum="b" * 64),
                       lambda: sdk.descriptor["registry"].update(packages=[]),
                       lambda: sdk.descriptor["registry"].update(files=[]),
                       lambda: package["targets"][0].update(source="../outside.rs")]:
            with self.subTest(mutation=mutate):
                package.clear(); package.update(copy.deepcopy(original_package))
                self.nodes["registry"] = copy.deepcopy(original_node)
                sdk.descriptor = copy.deepcopy(original_descriptor)
                mutate()
                with self.assertRaises(ValueError):
                    generator.selected_inputs(helper, sdk, self.root, self.nodes, self.packages, metadata, discovery, runtime, inputs)
        package.clear(); package.update(original_package)
        self.nodes["registry"] = original_node
        sdk.descriptor = original_descriptor
        (crate / "src/lib.rs").write_text("changed original publisher member")
        with self.assertRaisesRegex(ValueError, "changed declared SDK File"):
            generator.selected_inputs(helper, sdk, self.root, self.nodes, self.packages, metadata, discovery, runtime, inputs)

    def test_missing_selected_registry_target_still_refuses(self):
        helper, sdk, metadata, discovery, runtime, inputs, package, _ = self.registry_fixture()
        package["targets"][0]["source"] = "examples/missing.rs"
        self.nodes["registry"]["target"]["src_path"] = "examples/missing.rs"
        with self.assertRaises(FileNotFoundError):
            generator.selected_inputs(helper, sdk, self.root, self.nodes, self.packages, metadata, discovery, runtime, inputs)

    def test_common_registry_package_keeps_original_production_metadata_checks(self):
        helper, sdk, metadata, discovery, runtime, inputs, package, _ = self.registry_fixture()
        original = {key: value for key, value in package.items() if key != "targets"}
        metadata.write_text(json.dumps({"packages": [original]}))
        value = json.loads(discovery.read_text())
        value["metadata_sha256"] = generator.fact(metadata)["sha256"]
        discovery.write_text(json.dumps(value))
        generator.selected_inputs(helper, sdk, self.root, self.nodes, self.packages, metadata, discovery, runtime, inputs)
        package["features"] = {"forged": []}
        with self.assertRaisesRegex(ValueError, "original selected package facts"):
            generator.selected_inputs(helper, sdk, self.root, self.nodes, self.packages, metadata, discovery, runtime, inputs)
        package["features"] = {}
        self.nodes["unknown-authored"] = {"pkg_id": "workspace:foreign", "mode": "build"}
        self.packages["workspace:foreign"] = {"source": None}
        with self.assertRaisesRegex(ValueError, "original selected package facts"):
            generator.selected_inputs(helper, sdk, self.root, self.nodes, self.packages, metadata, discovery, runtime, inputs)

    def test_original_sdk_provenance_source_membership_and_lock_custody(self):
        helper = generator.load("simulator_original_source_helper", Path(args.unit_helpers) / "native_protocol_generate.py")
        for name in [*helper.LOCKS, "tools/sim/build.rs", "tools/sim/regressions.json", "scripts/sim-tests.ts", "scripts/generated-cargo-workspace.ts"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("declared original fixture File: " + name)
        descriptor = self.root / "descriptor.json"
        descriptor.write_text("{}")
        sdk = SimpleNamespace(host=HOST, require_locks=lambda files: None)
        provenance = {"execution_host": HOST, "producer": "//actual:sdk", "descriptor": generator.fact(descriptor),
                      "source_files": [generator.fact(path) for path in sorted(self.root.rglob("*")) if path.is_file()]}
        inputs = generator.original_sources(helper, sdk, self.root, provenance, descriptor, "//actual:sdk")
        self.assertIn("tools/sim/tests/rotation.rs", inputs)
        self.assertIn("tools/sim/Cargo.lock", inputs)
        with self.assertRaises(ValueError):
            generator.original_sources(helper, sdk, self.root, provenance, descriptor, "//foreign:sdk")
        foreign = copy.deepcopy(provenance)
        foreign["source_files"] = [row for row in foreign["source_files"] if not row["path"].endswith("tests/rotation.rs")]
        with self.assertRaisesRegex(ValueError, "membership"):
            generator.original_sources(helper, sdk, self.root, foreign, descriptor, "//actual:sdk")
        (self.root / "tools/sim/Cargo.lock").write_text("changed original retained lock")
        with self.assertRaisesRegex(ValueError, "source File"):
            generator.original_sources(helper, sdk, self.root, provenance, descriptor, "//actual:sdk")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--unit-emitter", required=True)
    parser.add_argument("--unit-helpers", required=True)
    parser.add_argument("--contexts-helper", required=True)
    parser.add_argument("--biome", required=True)
    parser.add_argument("--biome-config", required=True)
    parser.add_argument("--bun-rules", required=True)
    args = parser.parse_args()
    unittest.main(argv=["simulator_generate_test.py"])
