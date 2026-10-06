"""Original bounded proof registration controls; no compiler or solver qualification."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).parents[3]
OPS = Path(__file__).with_name("operations.bzl")
PROOFS = ROOT / "tools/bazel/rust/bounded-kani.bzl"
CAMPAIGN = ROOT / "tools/bolero/targets.json"
KEEPER = ROOT / "packages/merkur-e2e/src/rebind_keeper/proofs.rs"
RUNNER = ROOT / "tools/bazel/rust/bounded_kani_runner.py"


def declaration(path, name):
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and any(isinstance(item, ast.Name) and item.id == name for item in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError("Missing original declaration: " + name)


def reject(message):
    raise ValueError(message)


def default(**values):
    return values


def target(name, executable=True):
    label = type("Label", (), {"name": name, "__str__": lambda self: "@@//tools/bazel/rust:" + self.name})()
    return type("Target", (), {"label": label, "__getitem__": lambda self, _: SimpleNamespace(files_to_run=SimpleNamespace(executable=executable))})()


def evaluate(targets):
    source = ast.parse(OPS.read_text())
    nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "_bounded_proof_impl" or isinstance(node, ast.Assign) and any(isinstance(item, ast.Name) and item.id == "_BOUNDED_PROOF_ATTRIBUTES" for item in node.targets)]
    namespace = {"fail": reject, "DefaultInfo": default, "StaticOperationBindingsInfo": default, "OutputGroupInfo": default, "depset": lambda files: files, "json": SimpleNamespace(encode=json.dumps)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(OPS), "exec"), namespace)
    writes = []
    context = SimpleNamespace(attr=SimpleNamespace(**targets), label=SimpleNamespace(name="bindings"), actions=SimpleNamespace(declare_file=lambda name: name, write=lambda path, content: writes.append((path,content))))
    namespace["_bounded_proof_impl"](context)
    return json.loads(writes[0][1])


class Controls(unittest.TestCase):
    def names(self):
        return declaration(OPS, "_BOUNDED_PROOF_ATTRIBUTES")

    def test_original_campaign_six_proofs_and_factory_match(self):
        authority = {row["crate"]: row["proofs"] for row in json.loads(CAMPAIGN.read_text()) if row.get("proofs")}
        self.assertEqual(declaration(PROOFS, "_PROOFS"), authority)
        self.assertEqual(self.names(), [name for names in authority.values() for name in names])
        self.assertEqual(len(self.names()), 6)

    def test_original_predicates_keep_proof_annotations_and_nonvacuity(self):
        for row in json.loads(CAMPAIGN.read_text()):
            if not row.get("proofs"):
                continue
            if "source" not in row:
                self.assertEqual(row["crate"], "merkur-e2e")
                self.assertEqual(row["proofs"], ["proof_rebind_keeper_chain"])
                source = KEEPER.read_text()
                before, body = source.split("fn proof_rebind_keeper_chain()", 1)
                self.assertIn("#[kani::proof]", before)
                self.assertIn("kani::cover!", body)
                self.assertIn("assert", body)
                continue
            source = (CAMPAIGN.parent / row["source"]).read_text()
            for name in row["proofs"]:
                before, body = source.split("fn " + name + "()", 1)
                self.assertIn("#[cfg_attr(kani, kani::proof)]", before.rsplit("#[test]", 1)[1])
                self.assertIn("kani::cover!", body.split("\n#[test]", 1)[0])
                self.assertIn("assert", body.split("\n#[test]", 1)[0])

    def test_original_keeper_unwind_steps_and_solver_budget_are_retained(self):
        source = KEEPER.read_text()
        self.assertIn("#[kani::unwind(130)]", source)
        self.assertIn("const STEPS: usize = 2;", source)
        self.assertIn('"--harness-timeout", "15m"', RUNNER.read_text())

    def test_complete_binding_selects_original_tests_and_retains_qualification(self):
        value = evaluate({name: target("kani__" + name) for name in self.names()})
        self.assertEqual([row["name"] for row in value["operations"]], ["check:proofs", "test:fuzz:kani"])
        for row in value["operations"]:
            self.assertEqual(row["checks"], [{"label": "//tools/bazel/rust:kani__" + name, "kind": "test", "fresh": True} for name in self.names()])
            self.assertTrue(row["pending"])
        self.assertEqual(value["crates"], [])
        self.assertEqual(value["browserOwners"], [])

    def test_missing_native_context_remains_explicit_pending(self):
        for row in evaluate({name: None for name in self.names()})["operations"]:
            self.assertEqual(row["checks"], [])
            self.assertEqual(len(row["pending"]), 2)
            self.assertIn("proof execution context is not bound", row["pending"][1])

    def test_partial_campaign_cannot_hide_missing_application(self):
        targets = {name: target("kani__" + name) for name in self.names()}
        targets[self.names()[0]] = None
        with self.assertRaisesRegex(ValueError, "every original"):
            evaluate(targets)

    def test_fuzz_or_ownership_target_cannot_substitute_a_proof(self):
        for foreign in ["fuzz_wire", "ownership_proofs", "kani__proof_heartbeat_ladder"]:
            targets = {name: target("kani__" + name) for name in self.names()}
            targets[self.names()[0]] = target(foreign)
            with self.assertRaisesRegex(ValueError, "another application"):
                evaluate(targets)

    def test_nonexecutable_selected_target_refuses(self):
        targets = {name: target("kani__" + name) for name in self.names()}
        targets[self.names()[0]] = target("kani__" + self.names()[0], executable=None)
        with self.assertRaisesRegex(ValueError, "executable"):
            evaluate(targets)


if __name__ == "__main__":
    unittest.main()
