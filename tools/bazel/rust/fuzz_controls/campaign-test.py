"""Campaign declarations preserve the original five owners and runtime predicates."""
import argparse
import ast
import json
import pathlib
import types
import unittest

HERE = pathlib.Path(__file__).absolute().parent
ROOT = HERE.parents[3]
FACTORY = HERE.parent / "fuzz.bzl"


def emitted_call(root):
    calls = []
    with (root / "tools/bazel/rust/units/BUILD.bazel").open() as source:
        for line in source:
            if line.startswith("declare_fuzz_campaigns("):
                expression = ast.parse(line).body[0].value
                calls.append(tuple(ast.literal_eval(argument) for argument in expression.args))
    if len(calls) != 1:
        raise ValueError("The actual configured unit package requires one five-root campaign declaration")
    return calls[0]


def evaluate(factory, harnesses, flags):
    declarations = {}
    def record(kind):
        def declare(**attributes):
            name = attributes["name"]
            if name in declarations:
                raise ValueError("Configured rule name conflict: " + name)
            declarations[name] = {"kind": kind, **attributes}
        return declare
    namespace = {
        "native_fuzz_campaign_test": record("campaign"),
        "native_fuzz_replay_test": record("replay"),
        "instrumentation_sentinel_test": record("sentinel"),
        "native": types.SimpleNamespace(test_suite=record("suite")),
        "fail": lambda message: (_ for _ in ()).throw(ValueError(message)),
    }
    source = ast.parse(factory.read_text())
    statements = [node for node in source.body if (
        isinstance(node, ast.FunctionDef) and node.name == "declare_fuzz_campaigns"
    ) or (
        isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == "_CAMPAIGN_SELECTORS" for name in node.targets)
    )]
    exec(compile(ast.Module(body=statements, type_ignores=[]), str(factory), "exec"), namespace)
    error = None
    try:
        namespace["declare_fuzz_campaigns"](harnesses, flags)
    except ValueError as exception:
        error = str(exception)
    return {"error": error, "declarations": declarations, "selectors": namespace.get("_CAMPAIGN_SELECTORS")}


class CampaignControls(unittest.TestCase):
    def test_actual_all_five_root_call_keeps_exact_original_selectors(self):
        harnesses, flags = emitted_call(ROOT)
        original = json.loads((ROOT / "tools/bolero/targets.json").read_text())
        expected = {target["crate"]: target["tests"] for target in original}
        result = evaluate(FACTORY, harnesses, flags)
        self.assertIsNone(result["error"])
        self.assertEqual(result["selectors"], expected)
        self.assertEqual(sorted(harnesses), sorted(expected))
        declarations = result["declarations"]
        for mode in ["campaign", "replay"]:
            rows = [row for row in declarations.values() if row["kind"] == mode]
            self.assertEqual(len(rows), 5)
            for owner, selectors in expected.items():
                for selector in selectors:
                    name = mode + "__" + owner + "__" + selector.replace("::", "__")
                    row = declarations[name]
                    self.assertEqual(row["harness"], harnesses[owner])
                    self.assertEqual(row["selector"], selector)
                    if mode == "replay":
                        self.assertEqual(row["corpus"], ["//tools/bolero:corpus__" + selector.replace("::", "__")])
            suite = declarations["fuzz_campaigns" if mode == "campaign" else "fuzz_replays"]
            self.assertEqual(suite["tests"], [":" + row["name"] for row in rows])
        self.assertEqual(declarations["fuzz_instrumentation_sentinel"]["rust_flags"], flags)

    def test_each_owner_has_an_original_selected_test_harness(self):
        harnesses, _ = emitted_call(ROOT)
        for owner in harnesses:
            with self.subTest(owner=owner):
                diagnostic = json.loads((ROOT / "tools/bazel/rust/diagnostics/bolero" / (owner + ".json")).read_text())
                self.assertEqual(diagnostic["package"], "bolero:" + owner)
                graph = diagnostic["unit_graphs"]["aarch64-apple-darwin"]["fuzz"]
                roots = [graph["units"][index] for index in graph["roots"]]
                self.assertTrue(any(unit["mode"] == "test" and unit["pkg_id"] == "diagnostic:bolero:" + owner + "-fuzz" for unit in roots))
                self.assertTrue(any(unit["compiler_env"].get("BOLERO_FUZZER") == "libfuzzer" for unit in roots))

    def test_missing_or_unrelated_owner_refuses_before_declarations(self):
        harnesses, flags = emitted_call(ROOT)
        for changed in [{owner: harness for owner, harness in harnesses.items() if owner != "merkur-client"},
                        {**harnesses, "unrelated": ":unrelated"}]:
            result = evaluate(FACTORY, changed, flags)
            self.assertIn("all five original owning packages", result["error"])
            self.assertEqual(result["declarations"], {})

    def test_proof_only_roots_do_not_invent_display_campaigns(self):
        harnesses, flags = emitted_call(ROOT)
        result = evaluate(FACTORY, harnesses, flags)
        for owner in ["merkur-client", "merkur-codec"]:
            self.assertIn(owner, result["selectors"])
            self.assertEqual(result["selectors"][owner], [])
            self.assertFalse(any(row.get("harness") == harnesses[owner] for row in result["declarations"].values()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path, default=ROOT)
    parser.add_argument("--factory", type=pathlib.Path, default=FACTORY)
    parser.add_argument("--observe", type=pathlib.Path)
    args, remaining = parser.parse_known_args()
    ROOT, FACTORY = args.root, args.factory
    if args.observe:
        args.observe.write_text(json.dumps(evaluate(FACTORY, *emitted_call(ROOT)), indent=2) + "\n")
    else:
        unittest.main(argv=[__file__, *remaining])
