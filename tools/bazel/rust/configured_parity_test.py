#!/usr/bin/env python3
"""Mutation controls on the retained real Cargo compiler graph and declarations."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).absolute().parent
sys.path.insert(0, str(HERE))
import configured_parity as parity
import units


class ConfiguredParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = HERE.parents[2]
        cls.oracle = HERE / "contexts/merkur-identity-seal/build/native/metadata.json"
        cls.document = json.loads(cls.oracle.read_text())
        cls.nodes = json.loads((HERE / "units/graph.json").read_text())["nodes"]
        cls.declarations = parity.read_declarations([HERE / "units/BUILD.bazel", *sorted((HERE / "units").glob("*/BUILD.bazel"))])
        documents = [json.loads(path.read_text()) for path in sorted((HERE / "contexts").glob("*/*/*/metadata.json"))]
        documents += [json.loads(path.read_text()) for directory in ["diagnostics/bolero", "diagnostics/oracles"] for path in sorted((HERE / directory).glob("*.json"))]
        cls.packages = parity.validate_documents(documents)

    def mutated_graph(self):
        document = copy.deepcopy(self.document)
        graph = next(iter(next(iter(document["unit_graphs"].values())).values()))
        return document, graph

    def test_complete_real_declaration_inventory(self):
        self.assertGreater(parity.check_declarations(self.nodes, self.declarations), 10000)
        parity.check_profile_flags(self.nodes, self.packages, self.declarations)
        parity.check_action_inputs(self.root, self.nodes, self.packages, self.declarations)

    def test_generator_rejects_duplicate_configured_context_instead_of_overwriting(self):
        document, graph = self.mutated_graph()
        graph["units"][graph["roots"][0]]["rust_flags"].append("--cfg=merkur_parity_repro")
        with tempfile.TemporaryDirectory() as directory:
            conflicting = Path(directory) / "metadata.json"
            conflicting.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "duplicated configured Cargo"):
                units.collect([self.oracle, conflicting])

    def test_native_replacement_does_not_hide_ambiguous_original_context(self):
        parity.validate_documents([self.document], [self.document])
        with self.assertRaisesRegex(ValueError, "duplicated configured Cargo"):
            parity.validate_documents([self.document, self.document], [self.document])
        with self.assertRaisesRegex(ValueError, "duplicated native Cargo"):
            parity.validate_documents([self.document], [self.document, self.document])

    def test_invalid_unit_indexes_including_bool_are_rejected(self):
        for index in [True, -1, 100000]:
            with self.subTest(index=index):
                document, graph = self.mutated_graph()
                graph["units"][0]["dependencies"][0]["index"] = index
                with self.assertRaisesRegex(ValueError, "invalid Cargo compiler unit index"):
                    parity.validate_document(document)

    def test_extern_semantics_are_not_silently_discarded(self):
        for flag in ["nounused", "noprelude", "public"]:
            with self.subTest(flag=flag):
                document, graph = self.mutated_graph()
                graph["units"][0]["dependencies"][0][flag] = True
                with self.assertRaisesRegex(ValueError, "extern dependency semantics"):
                    parity.validate_document(document)

    def test_unrecognized_features_and_cross_target_macro_are_rejected(self):
        document, graph = self.mutated_graph()
        graph["units"][0]["features"] = ["undeclared-feature"]
        with self.assertRaisesRegex(ValueError, "feature set"):
            parity.validate_document(document)
        document, graph = self.mutated_graph()
        macro = next(unit for unit in graph["units"] if "proc-macro" in unit["target"]["kind"])
        macro["platform"] = graph["execution_host"]
        with self.assertRaisesRegex(ValueError, "procedural macro"):
            parity.validate_document(document)

    def test_cycle_and_build_script_dependency_loss_are_rejected(self):
        document, graph = self.mutated_graph()
        graph["units"][0]["dependencies"][0]["index"] = 0
        with self.assertRaisesRegex(ValueError, "cycle"):
            parity.validate_document(document)
        document, graph = self.mutated_graph()
        script = next(unit for unit in graph["units"] if unit["mode"] == "run-custom-build")
        script["dependencies"] = []
        with self.assertRaisesRegex(ValueError, "unique matching compiler"):
            parity.validate_document(document)

    def test_emitted_features_edition_host_and_edges_cannot_drift(self):
        for field in ["crate_features", "edition", "execution_host", "deps", "proc_macro_deps", "aliases", "proc_macro_aliases"]:
            identity = next(key for key, (_, attrs) in self.declarations.items() if attrs[field])
            declarations = dict(self.declarations)
            rule, attrs = declarations[identity]
            attrs = dict(attrs)
            attrs[field] = [] if isinstance(attrs[field], list) else {} if isinstance(attrs[field], dict) else "wrong"
            declarations[identity] = (rule, attrs)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "Cargo/Bazel " + field):
                parity.check_declarations(self.nodes, declarations)

    def test_compiler_and_cargo_environment_cannot_drift(self):
        identity = next(key for key, unit in self.nodes.items() if unit.get("compiler_env"))
        declarations = dict(self.declarations)
        rule, attrs = declarations[identity]
        declarations[identity] = (rule, dict(attrs, compiler_env={"RUSTC_BOOTSTRAP": "unrelated"}))
        with self.assertRaisesRegex(ValueError, "compiler_env differs"):
            parity.check_declarations(self.nodes, declarations)
        declarations[identity] = (rule, dict(attrs, cargo_env={"CARGO_PKG_NAME": "different-package"}))
        with self.assertRaisesRegex(ValueError, "cargo_env differs"):
            parity.check_action_inputs(self.root, self.nodes, self.packages, declarations)

    def test_build_script_custom_cfg_environment_cannot_drift(self):
        identity = next(key for key, unit in self.nodes.items() if unit["mode"] == "run-custom-build" and any(name.startswith("CARGO_CFG_") for name in self.declarations[key][1]["compiler_env"]))
        declarations = dict(self.declarations)
        rule, attrs = declarations[identity]
        declarations[identity] = (rule, dict(attrs, compiler_env={}))
        with self.assertRaisesRegex(ValueError, "compiler_env differs"):
            parity.check_declarations(self.nodes, declarations)

    def test_doctest_library_dependency_cannot_drift(self):
        identity = next(key for key, unit in self.nodes.items() if unit["mode"] == "doctest")
        declarations = dict(self.declarations)
        rule, attrs = declarations[identity]
        declarations[identity] = (rule, dict(attrs, crate=":wrong-library"))
        with self.assertRaisesRegex(ValueError, "doctest library dependency"):
            parity.check_declarations(self.nodes, declarations)

    def test_profile_and_declared_macro_inputs_cannot_drift(self):
        for field, check in [("rustc_flags", parity.check_profile_flags), ("macro_data", parity.check_action_inputs)]:
            identity = next(key for key, (_, attrs) in self.declarations.items() if attrs[field])
            declarations = dict(self.declarations)
            rule, attrs = declarations[identity]
            attrs = dict(attrs, **{field: []})
            declarations[identity] = (rule, attrs)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "differ"):
                if field == "macro_data":
                    check(self.root, self.nodes, self.packages, declarations)
                else:
                    check(self.nodes, self.packages, declarations)


if __name__ == "__main__":
    unittest.main()
