"""Capture action contract controls; modeled actions do not qualify Cargo or Bazel."""
import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class File:
    def __init__(self, path, source=True, directory=False):
        self.path = path
        self.short_path = path
        self.is_source = source
        self.is_directory = directory
        self.owner = "@@//tools/bazel/rust/acquire:original_sdk"


class Depset:
    def __init__(self, direct=(), transitive=()):
        self.files = list(dict.fromkeys([*direct, *(file for group in transitive for file in group.files)]))


class Runfiles:
    def __init__(self, files):
        self.files = list(dict.fromkeys(files))

    def merge(self, other):
        return Runfiles([*self.files, *other.files])


class Attrs:
    def __getattr__(self, name):
        return lambda **values: dict(kind=name, **values)


class Actions:
    def __init__(self):
        self.calls = []
        self.directories = []
        self.files = []

    def declare_directory(self, name):
        output = File("bazel-out/bin/" + name, source=False, directory=True)
        self.directories.append(output)
        return output

    def declare_file(self, name):
        output = File("bazel-out/bin/" + name, source=False)
        self.files.append(output)
        return output

    def write(self, output, content, **values):
        self.calls.append(dict(output=output, content=content, **values))

    def run(self, **values):
        self.calls.append(values)


def fail(message):
    raise ValueError(message)


def read_rule(path):
    source = "\n".join(line for line in path.read_text().splitlines() if not line.startswith("load("))
    provider = object()
    default = object()
    scope = {"CargoAcquisitionSdkInfo": provider, "DefaultInfo": default, "depset": Depset,
             "attr": Attrs(), "rule": lambda **values: values, "fail": fail,
             "TEST_EPOCH_ATTRIBUTE": object(), "TestRuntimeInfo": lambda **values: SimpleNamespace(**values),
             "test_nonce_file": lambda ctx: ctx.file._nonce}
    # DefaultInfo is both provider lookup identity and result constructor in Starlark.
    class Default:
        def __call__(self, **values):
            return SimpleNamespace(**values)
    default = Default()
    scope["DefaultInfo"] = default
    exec(compile(source, str(path), "exec"), scope)
    return scope


def context(scope, native=True):
    sdk = SimpleNamespace(descriptor=File("original/sdk.json"), provenance=File("original/provenance.json"),
                          sources=File("original/sources", False, True), registry=File("original/registry", False, True),
                          sdk_files=Depset([File("original/cargo"), File("original/rustc"), File("original/libstd.rlib")]))
    class Target(dict):
        label = "@@//tools/bazel/rust/acquire:production_sdk_alias"
    target = Target({scope["CargoAcquisitionSdkInfo"]: sdk})
    python_file = File("original/python3")
    python_runtime = File("original/python-runtime")
    tool = SimpleNamespace(files_to_run=SimpleNamespace(executable=python_file), default_runfiles=Runfiles([python_runtime]))
    python = {scope["DefaultInfo"]: tool}
    files = SimpleNamespace(**{name: File("original/" + name + ".py") for name in
                             ["_generator", "_resolver", "_units", "_contexts", "metadata", "source_inputs", "runtime_inputs", "context", "_context_generator", "_source_helper", "_protocol_generator", "_test", "_nonce"]})
    helpers = [File("original/" + name) for name in ["configured_parity.py", "license_metadata.py", "native_receipts.py", "contexts.py"]]
    return SimpleNamespace(label=SimpleNamespace(name="native_capture" if native else "wasm_capture"),
        attr=SimpleNamespace(sdk=target, _python=python, recipe_set="protocol"), file=files,
        files=SimpleNamespace(_unit_helpers=helpers, _selection_inputs=[File("original/native_oracle.py")] if native else []),
        executable=SimpleNamespace(_python=python_file), actions=Actions(),
        runfiles=lambda files=(), transitive_files=None: Runfiles([*files, *(transitive_files.files if transitive_files else [])]),
        toolchains={"@rules_rust//rust:toolchain_type": SimpleNamespace(version="1.97.1",
           exec_triple=SimpleNamespace(str="aarch64-apple-darwin"), target_triple=SimpleNamespace(str="aarch64-apple-darwin"))})


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.scope = read_rule(arguments.rule)

    def action(self, native=True):
        ctx = context(self.scope, native)
        result = self.scope["_native_capture_impl" if native else "_wasm_capture_impl"](ctx)
        self.assertEqual(len(ctx.actions.calls), 1)
        self.assertIs(result[0].files.files[0], ctx.actions.directories[0])
        return ctx, ctx.actions.calls[0]

    def test_original_sdk_directory_and_every_file_identity_is_an_action_input(self):
        for native in [True, False]:
            ctx, action = self.action(native)
            sdk = ctx.attr.sdk[self.scope["CargoAcquisitionSdkInfo"]]
            for original in [sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry, *sdk.sdk_files.files,
                             ctx.file._generator, ctx.file._resolver, ctx.file._units, ctx.file.metadata,
                             ctx.file.source_inputs, ctx.file.runtime_inputs, *ctx.files._unit_helpers,
                             *ctx.files._selection_inputs]:
                self.assertIn(original, action["inputs"].files)
            self.assertIs(action["outputs"][0], ctx.actions.directories[0])
            self.assertTrue(action["outputs"][0].is_directory)
            self.assertFalse(hasattr(sdk, "host"))

    def test_python_files_to_run_and_empty_environment_are_explicit(self):
        for native in [True, False]:
            ctx, action = self.action(native)
            self.assertIs(action["executable"], ctx.executable._python)
            self.assertEqual(action["tools"], [ctx.attr._python[self.scope["DefaultInfo"]].files_to_run])
            self.assertEqual(action["env"], {})
            self.assertIs(action["use_default_shell_env"], False)
            self.assertEqual(action["arguments"][:3], ["-I", "-B", ctx.file._generator.path])

    def test_exact_sdk_and_original_document_paths_and_producer(self):
        for native in [True, False]:
            ctx, action = self.action(native)
            sdk = ctx.attr.sdk[self.scope["CargoAcquisitionSdkInfo"]]
            argv = action["arguments"]
            for flag, file in [("--sdk-descriptor", sdk.descriptor), ("--sdk-provenance", sdk.provenance),
                               ("--source-root", sdk.sources), ("--metadata", ctx.file.metadata),
                               ("--source-inputs", ctx.file.source_inputs), ("--runtime-inputs", ctx.file.runtime_inputs)]:
                self.assertEqual(argv[argv.index(flag) + 1], file.path)
            self.assertEqual(argv[argv.index("--producer") + 1], str(sdk.provenance.owner))
            self.assertEqual(argv.count("--engine-precreated-tree-roots"), 1)

    def test_native_original_recipe_selection_and_context_helper(self):
        for recipe in ["protocol", "tpm"]:
            ctx = context(self.scope)
            ctx.attr.recipe_set = recipe
            self.scope["_native_capture_impl"](ctx)
            action = ctx.actions.calls[0]
            argv = action["arguments"]
            self.assertIn("--capture", argv)
            self.assertNotIn("--context", argv)
            self.assertEqual(argv[argv.index("--recipe-set") + 1], recipe)
            self.assertEqual(argv[argv.index("--contexts-helper") + 1], ctx.file._contexts.path)
            self.assertIn(ctx.file._contexts, action["inputs"].files)
        declaration = self.scope["native_protocol_capture"]
        self.assertEqual(declaration["attrs"]["recipe_set"]["values"], ["protocol", "tpm"])
        self.assertTrue(declaration["attrs"]["recipe_set"]["mandatory"])

    def test_wasm_context_is_the_actual_declared_file(self):
        ctx, action = self.action(False)
        argv = action["arguments"]
        self.assertEqual(argv[argv.index("--context") + 1], ctx.file.context.path)
        self.assertIn(ctx.file.context, action["inputs"].files)
        self.assertNotIn("--capture", argv)
        self.assertNotIn("--recipe-set", argv)
        self.assertTrue(self.scope["protocol_wasm_capture"]["attrs"]["context"]["mandatory"])

    def test_wrong_compiler_cross_target_and_non_native_execution_refuse_before_outputs(self):
        for native in [True, False]:
            for field, value in [("version", "1.97.0"), ("target", "wasm32-unknown-unknown"), ("both", "unknown-target")]:
                ctx = context(self.scope, native)
                rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
                if field == "version":
                    rust.version = value
                else:
                    rust.target_triple.str = value
                    if field == "both":
                        rust.exec_triple.str = value
                with self.subTest(native=native, field=field), self.assertRaisesRegex(ValueError, "pinned native"):
                    self.scope["_native_capture_impl" if native else "_wasm_capture_impl"](ctx)
                self.assertEqual(ctx.actions.calls, [])
                self.assertEqual(ctx.actions.directories, [])

    def test_generated_original_document_substitution_refuses_before_dispatch(self):
        for native in [True, False]:
            for name in ["metadata", "source_inputs", "runtime_inputs"]:
                ctx = context(self.scope, native)
                getattr(ctx.file, name).is_source = False
                with self.subTest(native=native, name=name), self.assertRaisesRegex(ValueError, "SourceFiles"):
                    self.scope["_native_capture_impl" if native else "_wasm_capture_impl"](ctx)
                self.assertEqual(ctx.actions.calls, [])
                self.assertEqual(ctx.actions.directories, [])

    def test_helper_defaults_are_exact_original_files_and_python_exec_configuration(self):
        for rule in ["native_protocol_capture", "protocol_wasm_capture"]:
            attrs = self.scope[rule]["attrs"]
            self.assertEqual(attrs["_unit_helpers"]["default"], ["//tools/bazel/rust:" + name for name in
                            ["configured_parity.py", "license_metadata.py", "native_receipts.py", "contexts.py"]])
            self.assertEqual(attrs["_python"]["cfg"], "exec")
            self.assertTrue(attrs["_python"]["executable"])
            self.assertTrue(attrs["sdk"]["mandatory"])

    def test_context_file_action_declares_exact_original_sdk_helper_and_python_closure(self):
        ctx = context(self.scope)
        result = self.scope["_wasm_context_capture_impl"](ctx)
        action = ctx.actions.calls[0]
        output = ctx.actions.files[0]
        self.assertIs(result[0].files.files[0], output)
        self.assertFalse(output.is_directory)
        self.assertEqual(output.path, "bazel-out/bin/native_capture.json")
        self.assertEqual(ctx.actions.directories, [])
        sdk = ctx.attr.sdk[self.scope["CargoAcquisitionSdkInfo"]]
        expected = [sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry, *sdk.sdk_files.files,
                    ctx.file._context_generator, ctx.file._resolver, ctx.file._source_helper,
                    ctx.file._protocol_generator, ctx.file._contexts]
        self.assertEqual(set(action["inputs"].files), set(expected))
        self.assertEqual(action["tools"], [ctx.attr._python[self.scope["DefaultInfo"]].files_to_run])
        self.assertIs(action["executable"], ctx.executable._python)
        self.assertEqual(action["env"], {})
        self.assertIs(action["use_default_shell_env"], False)
        argv = action["arguments"]
        self.assertEqual(argv[:3], ["-I", "-B", ctx.file._context_generator.path])
        for flag, file in [("--sdk-descriptor", sdk.descriptor), ("--sdk-provenance", sdk.provenance),
                           ("--sdk-resolver", ctx.file._resolver), ("--source-root", sdk.sources),
                           ("--source-helper", ctx.file._source_helper),
                           ("--protocol-generator", ctx.file._protocol_generator), ("--output", output)]:
            self.assertEqual(argv[argv.index(flag) + 1], file.path)
        self.assertNotIn("--contexts-helper", argv)
        self.assertNotIn("--engine-precreated-tree-roots", argv)
        self.assertEqual(argv[argv.index("--producer") + 1], str(sdk.provenance.owner))
        self.assertNotEqual(str(sdk.provenance.owner), str(ctx.attr.sdk.label))

    def test_context_file_flows_to_wasm_capture_as_same_declared_file(self):
        ctx = context(self.scope)
        result = self.scope["_wasm_context_capture_impl"](ctx)
        file = result[0].files.files[0]
        downstream = context(self.scope, False)
        downstream.file.context = file
        self.scope["_wasm_capture_impl"](downstream)
        action = downstream.actions.calls[0]
        self.assertIn(file, action["inputs"].files)
        self.assertEqual(action["arguments"][action["arguments"].index("--context") + 1], file.path)

    def test_context_capture_wrong_compiler_and_cross_toolchain_refuse_before_file_declaration(self):
        for field, value in [("version", "1.97.0"), ("target", "wasm32-unknown-unknown"), ("both", "unknown")]:
            ctx = context(self.scope)
            rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
            if field == "version":
                rust.version = value
            else:
                rust.target_triple.str = value
                if field == "both":
                    rust.exec_triple.str = value
            with self.assertRaisesRegex(ValueError, "pinned native"):
                self.scope["_wasm_context_capture_impl"](ctx)
            self.assertEqual(ctx.actions.calls, [])
            self.assertEqual(ctx.actions.files, [])

    def test_real_context_entry_uses_current_source_recipe_and_exclusive_file_publication(self):
        spec = importlib.util.spec_from_file_location("actual_context_entry", arguments.context_generator)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        ctx = context(self.scope)
        self.scope["_wasm_context_capture_impl"](ctx)
        action = ctx.actions.calls[0]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "context.json"
            provenance = root / "provenance.json"
            provenance.write_text("{}")
            argv = action["arguments"][2:]
            argv[argv.index("--output") + 1] = str(output)
            argv[argv.index("--sdk-provenance") + 1] = str(provenance)
            observed = []
            sdk = SimpleNamespace(original_tree=lambda path: root, close=lambda: observed.append("closed"))
            source = SimpleNamespace(sources=lambda *values: observed.append(values) or {"current-original-source": "exact fact"})
            generator = SimpleNamespace(capture_original_graph=lambda actual, path: ({"original": "wasm recipe"}, {"actual": "unit graph fixture"}))
            resolver = SimpleNamespace(NativeCargoSdk=SimpleNamespace(load=lambda path: sdk))
            helpers = {ctx.file._resolver.path: resolver, ctx.file._source_helper.path: source,
                       ctx.file._protocol_generator.path: generator}
            with patch.object(sys, "argv", argv), patch.object(module, "load", side_effect=lambda name, path: helpers[str(path)]):
                module.main()
                body = output.read_bytes()
                document = json.loads(body)
                self.assertEqual(document["inputs"], {"current-original-source": "exact fact"})
                self.assertEqual(document["unit_graphs"], {"wasm32-unknown-unknown": {"test-release": {"actual": "unit graph fixture"}}})
                self.assertEqual(observed[-1], "closed")
                self.assertEqual(observed[0][4], ctx.attr.sdk[self.scope["CargoAcquisitionSdkInfo"]].provenance.owner)
                with self.assertRaises(FileExistsError):
                    module.main()
                self.assertEqual(output.read_bytes(), body)
                self.assertEqual(observed[-1], "closed")

    def test_context_controls_launcher_binds_sdk_paths_and_complete_nonce_free_runtime(self):
        ctx = context(self.scope)
        ctx.file.context = File("bazel-out/bin/fresh_context.json", source=False)
        sdk = ctx.attr.sdk[self.scope["CargoAcquisitionSdkInfo"]]
        sdk.sources.path = "bazel-out/native/bin/acquire/source_sdk.sources"
        sdk.sources.short_path = "acquire/source_sdk.sources"
        python = ctx.attr._python[self.scope["DefaultInfo"]].files_to_run.executable
        python.short_path = "../original_python/bin/python3"
        result = self.scope["_wasm_context_controls_impl"](ctx)
        call = ctx.actions.calls[0]
        self.assertIs(result[0].executable, ctx.actions.files[0])
        self.assertIs(call["is_executable"], True)
        command = call["content"]
        self.assertIn('exec "$r/_main/../original_python/bin/python3" -I -B', command)
        for flag, file in [("--producer", ctx.file._context_generator), ("--generator", ctx.file._protocol_generator),
                           ("--source-helper", ctx.file._source_helper), ("--context", ctx.file.context),
                           ("--source-root", sdk.sources), ("--provenance", sdk.provenance), ("--descriptor", sdk.descriptor), ("--sdk-resolver", ctx.file._resolver)]:
            expected = flag + ' "' + (file.path if flag == "--source-root" else "$r/_main/" + file.short_path) + '"'
            self.assertIn(expected, command)
        self.assertNotIn('--source-root "$r/', command)
        self.assertTrue(command.endswith(' "$@"\n'))
        self.assertNotIn("protocol_wasm/context.json", command)
        runtime = result[1].runfiles.files
        for original in [ctx.file._test, ctx.file._context_generator, ctx.file._protocol_generator,
                         ctx.file._source_helper, ctx.file._contexts, ctx.file._resolver, ctx.file.context,
                         sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry, python, *sdk.sdk_files.files,
                         *ctx.attr._python[self.scope["DefaultInfo"]].default_runfiles.files]:
            self.assertIn(original, runtime)
        self.assertNotIn(ctx.file._nonce, runtime)
        self.assertEqual(set(result[0].runfiles.files), {*runtime, ctx.file._nonce})
        declaration = self.scope["protocol_wasm_context_controls_test"]
        self.assertIs(declaration["test"], True)
        self.assertIs(declaration["attrs"]["_revocation_epochs"], self.scope["TEST_EPOCH_ATTRIBUTE"])
        self.assertTrue(declaration["attrs"]["context"]["mandatory"])

    def test_context_controls_wrong_native_toolchain_refuses_before_launcher_write(self):
        ctx = context(self.scope)
        ctx.toolchains["@rules_rust//rust:toolchain_type"].version = "1.97.0"
        with self.assertRaisesRegex(ValueError, "pinned native"):
            self.scope["_wasm_context_controls_impl"](ctx)
        self.assertEqual(ctx.actions.calls, [])
        self.assertEqual(ctx.actions.files, [])

    def run_real_entry(self, native, precreated=True, occupied=False):
        """Run the actual entry/output code; Cargo capture is explicitly mocked, not qualified."""
        generator = arguments.native_generator if native else arguments.wasm_generator
        spec = importlib.util.spec_from_file_location("actual_protocol_entry", generator)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        ctx, action = self.action(native)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "declared_tree"
            output.mkdir()
            before = output.stat().st_ino
            if occupied:
                (output / "foreign").write_bytes(b"retained")
            document = root / "context.json"
            document.write_text("{}")
            provenance = root / "provenance.json"
            provenance.write_text("{}")
            argv = action["arguments"][2:]
            for flag, value in [("--output", output), ("--sdk-provenance", provenance), ("--context", document), ("--unit-emitter", root / "units.py")]:
                if flag in argv:
                    argv[argv.index(flag) + 1] = str(value)
            if not precreated:
                argv.remove("--engine-precreated-tree-roots")
            sdk = SimpleNamespace(original_tree=lambda path: root, close=lambda: None)
            units = SimpleNamespace(collect=lambda paths: ({}, {}, {}))
            resolver = SimpleNamespace(NativeCargoSdk=SimpleNamespace(load=lambda path: sdk))
            def load(name, path):
                if name.endswith("sdk"):
                    return resolver
                if name.endswith("units"):
                    return units
                return SimpleNamespace()
            replacements = {"load": load}
            if native:
                replacements.update(tool_facts=lambda *args: {}, sources=lambda *args: {}, capture=lambda *args: {},
                                    validate_documents=lambda *args: None, collect_documents=lambda *args: ({}, {}, {}),
                                    selected_inputs=lambda *args: None, emit=lambda *args: {"BUILD.bazel": "exact fixture bytes"})
            else:
                replacements.update(validate=lambda *args: None, declarations=lambda *args: ("exact fixture bytes", "archives"))
            old_path = list(sys.path)
            try:
                with patch.object(sys, "argv", argv), patch.multiple(module, **replacements):
                    if not precreated:
                        with self.assertRaises(FileExistsError):
                            module.main()
                    elif occupied:
                        with self.assertRaisesRegex(ValueError, "empty"):
                            module.main()
                    else:
                        module.main()
                        self.assertEqual((output / "BUILD.bazel").read_bytes(), b"exact fixture bytes")
                self.assertEqual(output.stat().st_ino, before)
                if occupied:
                    self.assertEqual((output / "foreign").read_bytes(), b"retained")
                    self.assertEqual([entry.name for entry in output.iterdir()], ["foreign"])
                elif not precreated:
                    self.assertEqual(list(output.iterdir()), [])
            finally:
                sys.path[:] = old_path

    def test_real_native_main_requires_action_output_mode_and_preserves_foreign_members(self):
        for precreated, occupied in [(True, False), (False, False), (True, True)]:
            self.run_real_entry(True, precreated, occupied)

    def test_real_wasm_main_requires_action_output_mode_and_preserves_foreign_members(self):
        for precreated, occupied in [(True, False), (False, False), (True, True)]:
            self.run_real_entry(False, precreated, occupied)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rule", type=Path, default=Path(__file__).with_name("protocol-capture.bzl"))
    parser.add_argument("--native-generator", type=Path, default=Path(__file__).with_name("native_protocol_generate.py"))
    parser.add_argument("--wasm-generator", type=Path, default=Path(__file__).with_name("protocol_wasm_generate.py"))
    parser.add_argument("--context-generator", type=Path, default=Path(__file__).with_name("protocol_wasm_context.py"))
    arguments = parser.parse_args()
    unittest.main(argv=["protocol_capture_test.py"])
