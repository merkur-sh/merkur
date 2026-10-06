"""Protocol ownership controls; these fixtures do not admit runtime qualification."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


class Provider:
    def __call__(self, **fields):
        return SimpleNamespace(**fields)


DEFAULT = Provider()
STATIC = Provider()


class Target:
    def __init__(self, provider, value):
        self.values = {provider: value}

    def __getitem__(self, key):
        return self.values[key]


class Actions:
    def declare_file(self, name):
        return name

    def write(self, path, value):
        self.descriptor = json.loads(value)


def fail(message):
    raise ValueError(message)


class ProtocolIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.namespace = {
            "provider": lambda **kwargs: STATIC,
            "rule": lambda **kwargs: kwargs,
            "attr": SimpleNamespace(label=lambda **kwargs: kwargs, label_list=lambda **kwargs: kwargs),
            "DefaultInfo": DEFAULT, "OutputGroupInfo": Provider(),
            "depset": lambda value: value, "json": SimpleNamespace(encode=json.dumps), "fail": fail,
        }
        source = Path(__file__).with_name("operations.bzl")
        exec(compile(source.read_text(), str(source), "exec"), self.namespace)
        self.operation = {"name": "check:protocol", "checks": [{"label": "//tools/bazel/wasm:wasm_cipher", "kind": "test", "fresh": True}],
                          "pending": ["Original native compiler context missing"]}
        self.protocol = {"operations": [self.operation], "crates": [], "browserOwners": []}

    def context(self):
        return SimpleNamespace(attr=SimpleNamespace(real_helper=None, protocol=Target(STATIC, SimpleNamespace(descriptor=self.protocol))),
                               label=SimpleNamespace(name="integration"), actions=Actions())

    def test_original_protocol_checks_and_pending_are_preserved(self):
        ctx = self.context()
        providers = self.namespace["_integration_impl"](ctx)
        operations = ctx.actions.descriptor["operations"]
        self.assertEqual([row for row in operations if row["name"] == "check:protocol"], [self.operation])
        self.assertEqual(providers[1].descriptor, ctx.actions.descriptor)
        self.assertIn("test:real-helper", [row["name"] for row in operations])
        self.assertEqual(len({row["name"] for row in operations}), len(operations))

    def test_protocol_binding_is_mandatory_typed_dependency(self):
        dependency = self.namespace["integration_operation_bindings"]["attrs"]["protocol"]
        self.assertIs(dependency["mandatory"], True)
        self.assertEqual(dependency["providers"], [STATIC])

    def test_another_operation_cannot_impersonate_protocol_owner(self):
        for operations in [[], [dict(self.operation, name="check:types")], [self.operation, self.operation]]:
            self.protocol["operations"] = operations
            with self.subTest(operations=operations), self.assertRaisesRegex(ValueError, "exactly the original protocol"):
                self.namespace["_integration_impl"](self.context())

    def test_rust_catalog_has_no_duplicate_protocol_owner_on_any_host(self):
        source = Path(__file__).parents[1] / "rust/operation_bindings.bzl"
        assignments = {node.targets[0].id: ast.literal_eval(node.value) for node in ast.parse(source.read_text()).body}
        catalogs = assignments["NATIVE_OPERATION_BINDINGS"]
        self.assertEqual(len(catalogs), 4)
        for host, catalog in catalogs.items():
            with self.subTest(host=host):
                self.assertNotIn("check:protocol", [operation["name"] for operation in catalog["operations"]])


if __name__ == "__main__":
    unittest.main()
