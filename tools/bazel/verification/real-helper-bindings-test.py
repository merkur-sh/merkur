"""Check declared raw original helper binaries and configured operation ownership."""
import argparse
import ast
import json
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest


def declaration(path, function, name):
    return next(node.value for node in ast.parse(path.read_text()).body
                if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name) and node.value.func.id == function
                and any(item.arg == "name" and ast.literal_eval(item.value) == name for item in node.value.keywords))


def attributes(call):
    return {item.arg: item.value for item in call.keywords}


class BindingControls(unittest.TestCase):
    def test_exact_original_raw_harness_and_worker_from_actual_native_capture(self):
        rule = attributes(declaration(ARGS.build, "real_helper_test", "real_helper"))
        harness = ROOTS["merkur-dataplane/test/aarch64-apple-darwin"]
        worker = [name for name in ROOTS["merkur-image-worker/release/aarch64-apple-darwin"]
                  if NODES[name]["target"]["src_path"] == "packages/merkur-image-worker/src/main.rs"]
        self.assertEqual(len(harness), 1)
        self.assertEqual(len(worker), 1)
        self.assertEqual(ast.literal_eval(rule["dataplane_test"]), "//tools/bazel/rust/units:u_" + harness[0] + "_binary")
        self.assertEqual(ast.literal_eval(rule["image_worker"]), "//tools/bazel/rust/units:u_" + worker[0])

    def test_available_producers_are_actual_original_unit_modes_and_native_hosts(self):
        rule = attributes(declaration(ARGS.build, "real_helper_test", "real_helper"))
        for kind, attribute, crate, source, mode in [
            ("harness", "dataplane_test", "merkur-dataplane", "apps/daemon/dataplane/src/main.rs", "test"),
            ("worker", "image_worker", "merkur-image-worker", "packages/merkur-image-worker/src/main.rs", "build")]:
            name = ast.literal_eval(rule[attribute]).split(":")[1]
            if kind == "harness":
                self.assertTrue(name.endswith("_binary"))
                name = name.removesuffix("_binary")
            row = NODES[name.removeprefix("u_")]
            self.assertEqual((row["target"]["name"], row["target"]["src_path"], row["mode"]), (crate, source, mode))
            # Cargo's null platform is its host context, exactly as the production
            # renderer normalizes platform = unit["platform"] or execution_host.
            self.assertEqual((row["platform"] or row["execution_host"], row["execution_host"]), ("aarch64-apple-darwin", "aarch64-apple-darwin"))
        # Genuine cross-target Cargo captures cannot claim native execution hosts.
        for platform in ["x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]:
            for name in ROOTS["merkur-dataplane/test/" + platform]:
                self.assertNotEqual(NODES[name]["platform"], NODES[name]["execution_host"])

    def test_uncaptured_native_hosts_cannot_run_the_available_fixture(self):
        rule = attributes(declaration(ARGS.build, "real_helper_test", "real_helper"))
        required = ["@platforms//os:macos", "@platforms//cpu:aarch64"]
        self.assertEqual(ast.literal_eval(rule["target_compatible_with"]), required)
        self.assertEqual(ast.literal_eval(rule["exec_compatible_with"]), required)
        self.assertEqual(ast.literal_eval(rule["tags"]), ["manual", "no-sandbox", "no-remote", "external", "no-cache"])
        integration = attributes(declaration(ARGS.build, "integration_operation_bindings", "integration_operation_bindings"))
        self.assertIs(ast.literal_eval(integration["testonly"]), True)
        selection = integration["real_helper"]
        self.assertIsInstance(selection, ast.Call)
        self.assertEqual(selection.func.id, "select")
        self.assertEqual(ast.literal_eval(selection.args[0]), {
            "//tools/bazel/bun:compile_darwin_arm64": ":real_helper", "//conditions:default": None})

    def test_operation_uses_actual_target_and_preserves_qualification_pending(self):
        tree = ast.parse(ARGS.operations.read_text())
        pending = ast.literal_eval(next(node.value for node in tree.body if isinstance(node, ast.Assign) and node.targets[0].id == "_INTEGRATION_PENDING"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_integration_impl")
        default = object()
        rows = {}
        def descriptor(**values):
            rows.update(values)
            return values
        environment = {"DefaultInfo": default, "_INTEGRATION_PENDING": pending, "json": SimpleNamespace(encode=json.dumps),
                       "depset": lambda values: values, "StaticOperationBindingsInfo": descriptor, "OutputGroupInfo": lambda **values: values,
                       "fail": lambda message: (_ for _ in ()).throw(ValueError(message))}
        # Target data is a unit-test fixture; no uploaded descriptor grants execution authority.
        environment["DefaultInfo"] = type("Default", (), {"__new__": lambda cls, **values: values})
        token = environment["DefaultInfo"]
        class Target(dict):
            label = "@@//tools/bazel/verification:real_helper"
        target = Target({token: SimpleNamespace(files_to_run=SimpleNamespace(executable="actual-fixture-executable"))})
        actions = SimpleNamespace(declare_file=lambda name: name, write=lambda *args: None)
        context = SimpleNamespace(attr=SimpleNamespace(real_helper=target), label=SimpleNamespace(name="integration_operation_bindings"), actions=actions)
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(ARGS.operations), "exec"), environment)
        environment["_integration_impl"](context)
        record = next(row for row in rows["descriptor"]["operations"] if row["name"] == "test:real-helper")
        self.assertEqual(record["checks"], [{"label": "//tools/bazel/verification:real_helper", "kind": "test", "fresh": True}])
        self.assertEqual(len(record["pending"]), 1)
        self.assertIn("native four-platform runtime qualification", record["pending"][0])
        # Missing native context leaves a truthful pending helper entry while
        # retaining every unrelated operation descriptor on other platforms.
        context.attr.real_helper = None
        environment["_integration_impl"](context)
        foreign = rows["descriptor"]["operations"]
        record = next(row for row in foreign if row["name"] == "test:real-helper")
        self.assertEqual(record["checks"], [])
        self.assertEqual(len(record["pending"]), 2)
        self.assertIn("Exact native real-helper compiler/runtime context is missing", record["pending"][1])
        for name, reason in pending.items():
            self.assertEqual(next(row for row in foreign if row["name"] == name),
                             {"name": name, "checks": [], "pending": [reason]})
        context.attr.real_helper = target
        target[token].files_to_run.executable = None
        with self.assertRaisesRegex(ValueError, "declared runtime test executable"):
            environment["_integration_impl"](context)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["build", "context-root", "operations"]:
        parser.add_argument("--" + name, type=Path, required=True)
    ARGS = parser.parse_args()
    # The real production collector validates the captured Cargo documents and
    # computes identical compiler-unit keys; this does not publish a native receipt.
    sys.path.insert(0, str(ARGS.context_root / "tools/bazel/rust"))
    import units
    documents = sorted((ARGS.context_root / "tools/bazel/rust/contexts").glob("*/*/*/metadata.json"))
    NODES, ROOTS, _ = units.collect(documents, ())
    unittest.main(argv=[__file__])
