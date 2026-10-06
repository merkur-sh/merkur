"""Synthetic analysis controls compared with the unchanged original protocol selection."""
import ast
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).parents[3]
BINDINGS = Path(__file__).with_name("protocol-bindings.bzl")


def fail(message):
    raise ValueError(message)


class Provider:
    def __call__(self, **kwargs):
        return kwargs


DEFAULT = Provider()
RUNTIME = Provider()
STATIC = Provider()


class Target:
    def __init__(self, label, executable=True, runtime=True, build_outputs=True):
        self.label = label
        self.providers = {DEFAULT: SimpleNamespace(files_to_run=SimpleNamespace(executable=executable), files=SimpleNamespace(to_list=lambda: [object()] if build_outputs else []))}
        if runtime:
            self.providers[RUNTIME] = SimpleNamespace(runfiles=object())

    def __getitem__(self, key):
        return self.providers[key]

    def __contains__(self, key):
        return key in self.providers


class Actions:
    def declare_file(self, name):
        return name

    def write(self, file, data):
        self.descriptor = json.loads(data)


def original_constant(source, name):
    match = re.search(r"export const " + name + r"\s*=\s*(\[[\s\S]*?\]|'[^']*')\s*;", source)
    if match is None:
        raise AssertionError("Missing original source constant: " + name)
    return ast.literal_eval(re.sub(r"//[^\n]*", "", match.group(1)))


class ProtocolBindingsTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.namespace = {
            "load": lambda *args: None,
            "select": lambda choices: SimpleNamespace(choices=choices),
            "fail": fail,
            "attr": SimpleNamespace(**{name: lambda **kwargs: kwargs for name in ["string_keyed_label_dict", "string_list", "label_list", "label"]}),
            "rule": lambda **kwargs: lambda **values: self.calls.append(("binding", values)),
            "configured_public_rust_test": lambda **kwargs: self.calls.append(("test", kwargs)),
            "StaticOperationBindingsInfo": STATIC,
            "TestRuntimeInfo": RUNTIME,
            "DefaultInfo": DEFAULT,
            "OutputGroupInfo": Provider(),
            "depset": lambda files: files,
            "json": SimpleNamespace(encode=json.dumps),
        }
        exec(compile(BINDINGS.read_text(), str(BINDINGS), "exec"), self.namespace)
        self.roots = {crate + "/" + role: "//original/" + crate + ":" + role.replace(":", "_")
                      for crate in self.namespace["_CRATES"] for role in ["test:lib", "doctest:lib"]}
        self.roots["merkur-client/build:browser_session_oracle"] = "//original/client:test_profile_example"
        self.arguments = dict(name="protocol", native_configuration="//native:captured",
                              native_constraints=["@platforms//os:macos", "@platforms//cpu:aarch64"],
                              native_roots=self.roots,
                              expected_native_roles=list(self.roots), dataplane_lib="//original/dataplane:current_lib",
                              dataplane_bin="//original/dataplane:current_bin",
                              wasm_cipher="//original/wasm:release_lib_test", wasm_provenance="//original/wasm:provenance",
                              client_oracle="//original/client:browser_session_oracle")

    def declare(self, **changes):
        return self.namespace["declare_protocol_bindings"](**dict(self.arguments, **changes))

    def context(self):
        bun = [self.namespace["_bun_label"](file) for file in [self.namespace["_SCAN"]] + self.namespace["_BUN_TESTS"]]
        attributes = SimpleNamespace(native_roots={role: Target(label) for role, label in self.roots.items()},
                                     expected_native_roles=list(self.roots), bun_tests=[Target(label) for label in bun],
                                     dataplane=Target("//original/dataplane:filtered"),
                                     dataplane_bin=Target("//original/dataplane:filtered_bin"),
                                     wasm_cipher=Target(self.arguments["wasm_cipher"]),
                                     wasm_provenance=Target(self.arguments["wasm_provenance"]),
                                     client_oracle=Target(self.arguments["client_oracle"], runtime=False))
        return SimpleNamespace(attr=attributes, label=SimpleNamespace(name="protocol"), actions=Actions())

    def test_exact_unchanged_original_source_selection(self):
        source = (ROOT / "scripts/protocol-gates.ts").read_text()
        for original, bound in [("PROTOCOL_SCAN", "_SCAN"), ("PROTOCOL_TESTS", "_BUN_TESTS"),
                                ("PROTOCOL_DATAPLANE_FILTERS", "_DATAPLANE_FILTERS"),
                                ("PROTOCOL_DATAPLANE_SKIPS", "_DATAPLANE_SKIPS"), ("PROTOCOL_CRATES", "_CRATES")]:
            self.assertEqual(self.namespace[bound], original_constant(source, original))

    def test_native_filter_wrapper_preserves_actual_library_and_original_args(self):
        self.declare()
        kind, test = self.calls[0]
        self.assertEqual(kind, "test")
        self.assertEqual(test["binary"], self.arguments["dataplane_lib"])
        self.assertEqual(test["args"], self.namespace["_DATAPLANE_FILTERS"] + ["--skip", "live_edge_roundtrip"])
        self.assertNotIn("cargo", str(self.calls))
        self.assertNotIn("_revocation_epochs", test)
        self.assertEqual(self.calls[1][0], "test")
        self.assertEqual(self.calls[1][1]["binary"], self.arguments["dataplane_bin"])
        self.assertEqual(self.calls[1][1]["args"], test["args"])
        self.assertEqual(self.calls[2][1]["native_roots"].choices, {"//native:captured": self.roots, "//conditions:default": {}})
        self.assertEqual(test["target_compatible_with"], self.arguments["native_constraints"])
        self.assertEqual(test["exec_compatible_with"], self.arguments["native_constraints"])
        self.assertEqual(self.calls[2][1]["dataplane"].choices, {"//native:captured": ":protocol_dataplane", "//conditions:default": None})
        self.assertEqual(self.calls[2][1]["dataplane_bin"].choices, {"//native:captured": ":protocol_dataplane_bin", "//conditions:default": None})
        self.assertEqual(self.calls[2][1]["wasm_cipher"], self.arguments["wasm_cipher"])

    def test_captured_native_platform_authority_is_required_before_declaration(self):
        for change in [{"native_configuration": ""}, {"native_constraints": []}]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "original configuration"):
                self.declare(**change)
            self.assertEqual(self.calls, [])

    def test_foreign_configured_platform_keeps_native_capture_explicitly_missing(self):
        self.declare()
        binding = self.calls[2][1]
        ctx = self.context()
        for name in ["native_roots", "dataplane", "dataplane_bin"]:
            setattr(ctx.attr, name, binding[name].choices["//conditions:default"])
        self.namespace["_impl"](ctx)
        operation = ctx.actions.descriptor["operations"][0]
        self.assertFalse(any(check["label"].startswith("//original/dataplane:") for check in operation["checks"]))
        for role in self.roots:
            self.assertTrue(any("native root " + role + ":" in reason for reason in operation["pending"]))

    def test_missing_original_native_root_refuses_before_any_declaration(self):
        changed = dict(self.roots)
        del changed["merkur-client/doctest:lib"]
        with self.assertRaisesRegex(ValueError, "complete test/doctest"):
            self.declare(native_roots=changed)
        self.assertEqual(self.calls, [])

    def test_missing_whole_crate_and_duplicate_or_foreign_roles_refuse(self):
        no_client = {role: label for role, label in self.roots.items() if not role.startswith("merkur-client/")}
        cases = [(no_client, list(no_client)), (self.roots, list(self.roots) + [next(iter(self.roots))]),
                 ({"foreign/test:lib": "//foreign:test"}, ["foreign/test:lib"])]
        for roots, expected in cases:
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                self.declare(native_roots=roots, expected_native_roles=expected)
            self.assertEqual(self.calls, [])

    def test_partial_native_capture_refuses_before_dispatch(self):
        for role in ["dataplane_lib", "dataplane_bin"]:
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, "entirely bound"):
                self.declare(**{role: None})
            self.assertEqual(self.calls, [])

    def test_missing_native_capture_names_every_original_obligation(self):
        self.declare(native_roots={}, dataplane_lib=None, dataplane_bin=None)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0], "binding")
        self.assertIsNone(self.calls[0][1]["dataplane"])
        ctx = self.context()
        ctx.attr.native_roots = {}
        ctx.attr.dataplane = None
        ctx.attr.dataplane_bin = None
        self.namespace["_impl"](ctx)
        operation = ctx.actions.descriptor["operations"][0]
        self.assertEqual(len(operation["checks"]), 23)
        for role in self.roots:
            self.assertTrue(any("native root " + role + ":" in reason and "no matching original native compiler capture" in reason for reason in operation["pending"]))
        self.assertTrue(any("library and binary filtered harnesses" in reason for reason in operation["pending"]))

    def test_missing_special_runtime_is_explicit_pending(self):
        for role in ["wasm_cipher", "wasm_provenance", "client_oracle"]:
            with self.subTest(role=role):
                ctx = self.context()
                setattr(ctx.attr, role, None)
                self.namespace["_impl"](ctx)
                operation = ctx.actions.descriptor["operations"][0]
                self.assertEqual(len(operation["checks"]), 35)
                self.assertEqual(len(operation["pending"]), 4)

    def test_descriptor_depending_on_original_tests_is_testonly(self):
        self.declare()
        self.assertIs(self.calls[2][1].get("testonly"), True)

    def test_configured_descriptor_keeps_all_original_checks_and_pending_qualification(self):
        ctx = self.context()
        providers = self.namespace["_impl"](ctx)
        descriptor = ctx.actions.descriptor
        operation = descriptor["operations"][0]
        self.assertEqual(operation["name"], "check:protocol")
        self.assertEqual(len(operation["checks"]), 36)
        self.assertEqual(operation["checks"][0]["label"], "//scripts:test__current-protocol-hard-cut.test.ts")
        self.assertEqual([check["kind"] for check in operation["checks"]].count("build"), 2)
        self.assertIn({"label": "//original/client:test_profile_example", "kind": "build", "fresh": False}, operation["checks"])
        self.assertEqual(len(operation["pending"]), 3)
        self.assertEqual(providers[1]["descriptor"], descriptor)

    def test_missing_reordered_or_foreign_bun_selection_refuses(self):
        for change in [lambda tests: tests[:-1], lambda tests: list(reversed(tests)),
                       lambda tests: [Target("//foreign:test")] + tests[1:]]:
            ctx = self.context()
            ctx.attr.bun_tests = change(ctx.attr.bun_tests)
            with self.assertRaisesRegex(ValueError, "exact original source selection"):
                self.namespace["_impl"](ctx)

    def test_library_output_or_missing_runtime_cannot_impersonate_wasm_test(self):
        for target in [Target("//original/wasm:rlib", executable=False), Target("//original/wasm:test", runtime=False)]:
            ctx = self.context()
            ctx.attr.wasm_cipher = target
            with self.assertRaises(ValueError):
                self.namespace["_impl"](ctx)

    def test_native_preflight_build_container_preserves_original_artifact_outputs(self):
        ctx = self.context()
        ctx.attr.client_oracle = Target("//original/client:retained_oracle_package", executable=False, runtime=False)
        self.namespace["_impl"](ctx)
        check = ctx.actions.descriptor["operations"][0]["checks"][2]
        self.assertEqual(check, {"label": "//original/client:retained_oracle_package", "kind": "build", "fresh": False})

    def test_empty_preflight_build_output_cannot_satisfy_original_operation(self):
        ctx = self.context()
        ctx.attr.client_oracle = Target("//original/client:missing_package", executable=False, runtime=False, build_outputs=False)
        with self.assertRaisesRegex(ValueError, "actual configured build outputs"):
            self.namespace["_impl"](ctx)

    def test_same_target_cannot_replace_two_original_producer_roles(self):
        ctx = self.context()
        ctx.attr.wasm_cipher = ctx.attr.dataplane
        with self.assertRaisesRegex(ValueError, "alias another selected check"):
            self.namespace["_impl"](ctx)


if __name__ == "__main__":
    unittest.main()
