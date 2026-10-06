"""Macro contract controls; these do not qualify simulator execution or its graph."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class SimulatorTargetTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name("sim_targets.bzl")
        tree = ast.parse(source.read_text())
        tree.body = [node for node in tree.body if not isinstance(node, ast.Expr)]
        self.aliases, self.tests, self.suites = [], [], []
        self.package = "tools/sim"
        self.source_files = ["tests/retained.rs", "tests/rotation.rs", "tests/sweep.rs"]
        def fail(message):
            raise ValueError(message)
        def sources(patterns, *, allow_empty):
            self.assertEqual(patterns, ["tests/*.rs"])
            self.assertFalse(allow_empty)
            return self.source_files
        self.symbols = {
            "native": SimpleNamespace(alias=lambda **args: self.aliases.append(args),
                                      test_suite=lambda **args: self.suites.append(args),
                                      package_name=lambda: self.package, glob=sources),
            "bun_command_test": lambda **args: self.tests.append(args), "fail": fail,
        }
        exec(compile(tree, str(source), "exec"), self.symbols)
        self.roots = {name: "//actual-capture:" + name for name in ["lib", "retained", "rotation", "sweep"]}

    def test_exact_original_harnesses_and_rustdoc_are_required(self):
        self.symbols["declare_simulator_targets"]("//actual-capture:lib_build", self.roots, "//actual-capture:doc")
        self.assertEqual(len(self.tests), 5)
        self.assertEqual(len(self.suites[0]["tests"]), 5)
        self.assertEqual(self.suites[0]["tests"][-1], ":test_doc")
        for target in self.tests[:-1]:
            self.assertEqual(target["fixed_args"], ["test"])
            name = target["name"].removeprefix("test_")
            self.assertEqual(target["tools"], {":configured_" + name: "simulator"})
            self.assertEqual(target["tool_environment"], {"simulator": "MERKUR_SIM_BINARY"})
            self.assertIn("//tools/sim:regressions.json", target["data"])
        self.assertEqual({alias["name"].removeprefix("configured_"): alias["actual"]
                          for alias in self.aliases if alias["name"].startswith("configured_")}, self.roots)

    def test_missing_or_foreign_roots_are_not_exposed_as_complete(self):
        for changed in [dict(self.roots, foreign="//foreign:unit"),
                        {key: value for key, value in self.roots.items() if key != "sweep"},
                        {key: value for key, value in self.roots.items() if key != "rotation"}]:
            with self.subTest(roots=changed), self.assertRaises(ValueError):
                self.symbols["declare_simulator_targets"]("//actual-capture:build", changed, "//actual-capture:doc")
        with self.assertRaises(ValueError):
            self.symbols["declare_simulator_targets"]("//actual-capture:build", self.roots, None)
        self.assertEqual(self.tests, [])

    def test_harness_source_package_cannot_be_substituted(self):
        self.package = "foreign/sim"
        with self.assertRaisesRegex(ValueError, "original tools/sim source package"):
            self.symbols["declare_simulator_targets"]("//actual-capture:build", self.roots, "//actual-capture:doc")
        self.assertEqual(self.aliases, [])
        self.assertEqual(self.tests, [])

    def test_sweep_retains_original_random_default_and_is_fresh(self):
        self.symbols["declare_simulator_targets"]("//actual-capture:build", self.roots, "//actual-capture:doc")
        target = self.tests[-1]
        self.assertEqual(target["name"], "seed_sweep")
        self.assertEqual(target["fixed_args"], ["sweep"])
        self.assertEqual(target["tools"], {":configured_sweep": "simulator"})
        self.assertIn("no-cache", target["tags"])
        self.assertIn("external", target["tags"])


if __name__ == "__main__":
    unittest.main()
