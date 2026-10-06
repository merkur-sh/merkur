"""Exact original command/data selection; no generated-artifact execution."""
import ast
from pathlib import Path
import unittest


class Controls(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name("protocol-artifacts.bzl").read_text()
        tree = ast.parse("\n".join(line for line in source.splitlines() if not line.startswith("load(")))
        calls = []
        environment = {"bun_command_test": lambda **kwargs: calls.append(kwargs)}
        exec(compile(tree, "protocol-artifacts.bzl", "exec"), environment)
        environment["declare_protocol_artifacts"]("preflight")
        self.calls = calls
        self.call = calls[0]

    def test_one_real_command_rule(self):
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.call["name"], "preflight")
        self.assertEqual(self.call["entry_point"], "//scripts:check-wasm-artifacts.ts")
        self.assertEqual(self.call["fixed_args"], [])

    def test_complete_original_package_pair_is_mandatory(self):
        self.assertIn("//packages/term-wasm:wasm_artifacts", self.call["data"])
        self.assertIn("//apps/web:term_wasm_runtime", self.call["data"])
        self.assertIn("//packages/graphics-wasm:wasm_artifacts", self.call["data"])
        self.assertIn("//apps/web:graphics_wasm_runtime", self.call["data"])
        self.assertEqual(len(self.call["data"]), len(set(self.call["data"])))

    def test_original_source_hash_namespace(self):
        self.assertEqual(self.call["data"], [
            "//tools/bazel/verification:production_acquisition_sources",
            "//packages/term-wasm:wasm_artifacts",
            "//apps/web:term_wasm_runtime",
            "//packages/graphics-wasm:wasm_artifacts",
            "//apps/web:graphics_wasm_runtime",
        ])

    def test_neutral_runtime_and_pending_qualification(self):
        self.assertEqual(self.call["bun_config"], "//tools/bazel/bun:empty-bunfig.toml")
        self.assertEqual(self.call["tags"], ["manual", "unqualified-wasm-runtime"])
        self.assertNotIn("tools", self.call)


if __name__ == "__main__":
    unittest.main()
