"""Original simulator macro controls; no native runtime qualification claim."""
import argparse
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

parser = argparse.ArgumentParser()
parser.add_argument("--macro", default=str(Path(__file__).with_name("sim_targets.bzl")))
parser.add_argument("--harness-directory", default=str(Path(__file__).with_name("tests")))
args, remaining = parser.parse_known_args()

class Selection:
    def __init__(self, choices, no_match_error):
        self.choices = choices
        self.no_match_error = no_match_error

    def resolve(self, host):
        if host not in self.choices:
            raise ValueError(self.no_match_error)
        return self.choices[host]

class SimulatorSuiteTests(unittest.TestCase):
    def setUp(self):
        self.harnesses = sorted(file.stem for file in Path(args.harness_directory).glob("*.rs"))
        self.assertIn("sweep", self.harnesses)
        self.assertIn("rotation", self.harnesses)
        self.aliases, self.tests, self.suites = [], [], []
        def fail(message):
            raise ValueError(message)
        def suite(**fields):
            if not isinstance(fields["tests"], list):
                raise ValueError('attribute "tests" is not configurable')
            self.suites.append(fields)
        tree = ast.parse(Path(args.macro).read_text())
        tree.body = [node for node in tree.body if not isinstance(node, ast.Expr)]
        self.symbols = {"native": SimpleNamespace(
            glob=lambda patterns: ["tests/" + name + ".rs" for name in self.harnesses],
            alias=lambda **fields: self.aliases.append(fields), test_suite=suite),
            "select": Selection, "fail": fail,
            "bun_command_test": lambda **fields: self.tests.append(fields),
            "configured_public_rust_test": lambda **fields: self.tests.append(fields)}
        exec(compile(tree, args.macro, "exec"), self.symbols)

    def binding(self, host):
        prefix = "//tools/bazel/rust/simulator/" + host + ":u_"
        return {"build": prefix + "build", "doctest": prefix + "doctest",
                "tests": {role: prefix + role for role in ["lib"] + self.harnesses}}

    def declare(self, hosts):
        self.symbols["declare_simulator_targets"]({host: self.binding(host) for host in hosts})

    def test_constant_suite_retains_every_original_test_and_missing_host_refuses(self):
        self.declare(["aarch64-apple-darwin"])
        suite = self.suites[0]
        expected = ["doctest", "lib"] + self.harnesses
        self.assertEqual(sorted(suite["tests"]), sorted(":scenario__" + role for role in expected))
        aliases = {row["name"]: row for row in self.aliases}
        selector = "//tools/bazel/rust/acquire:workspace_sdk_host_darwin_arm64"
        for role in expected:
            selected = aliases["scenario__" + role]["actual"]
            self.assertEqual(selected.resolve(selector), ":simulator_test__aarch64_apple_darwin__" + role)
            self.assertNotIn("//conditions:default", selected.choices)
            with self.assertRaisesRegex(ValueError, "no captured native release harnesses"):
                selected.resolve("//tools/bazel/rust/acquire:workspace_sdk_host_linux_x64")
        self.assertEqual(len(suite["tests"]), len(self.harnesses) + 2)
        self.assertTrue(all("configured_sweep" not in item for item in suite["tests"]))

    def test_two_actual_supplied_hosts_share_roles_without_foreign_members(self):
        self.declare(["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"])
        aliases = {row["name"]: row for row in self.aliases}
        for role in ["lib", "doctest"] + self.harnesses:
            selected = aliases["scenario__" + role]["actual"]
            self.assertEqual(len(selected.choices), 2)
            self.assertEqual(selected.resolve("//tools/bazel/rust/acquire:workspace_sdk_host_linux_x64"),
                             ":simulator_test__x86_64_unknown_linux_gnu__" + role)
        self.assertEqual(len(self.suites[0]["tests"]), len(self.harnesses) + 2)

    def test_sweep_policy_and_original_execution_constraints_are_preserved(self):
        self.declare(["aarch64-apple-darwin"])
        campaign = next(row for row in self.tests if row["name"] == "configured_sweep__aarch64_apple_darwin")
        self.assertEqual(campaign["fixed_args"], ["sweep"])
        self.assertIn("external", campaign["tags"])
        self.assertIn("no-cache", campaign["tags"])
        for row in self.tests:
            self.assertEqual(row["target_compatible_with"], ["@platforms//os:osx", "@platforms//cpu:aarch64"])
            self.assertEqual(row["exec_compatible_with"], row["target_compatible_with"])
            if row is not campaign and "fixed_args" in row:
                self.assertEqual(row["fixed_args"], ["test"])
        self.assertEqual(len(self.tests), len(self.harnesses) + 3)

    def test_missing_and_foreign_root_inventories_still_refuse(self):
        host = "aarch64-apple-darwin"
        for omit in ["rotation", "sweep", "lib"]:
            binding = self.binding(host)
            del binding["tests"][omit]
            with self.assertRaisesRegex(ValueError, "every original authored harness"):
                self.symbols["declare_simulator_targets"]({host: binding})
        binding = self.binding(host)
        binding["tests"]["rotation"] = "//foreign:capture"
        with self.assertRaisesRegex(ValueError, "original configured unit wrappers"):
            self.symbols["declare_simulator_targets"]({host: binding})
        with self.assertRaises(ValueError):
            self.symbols["declare_simulator_targets"]({})

if __name__ == "__main__":
    unittest.main(argv=[__file__] + remaining)
