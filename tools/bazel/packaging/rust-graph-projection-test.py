"""Exercise exact Cargo BuildInfo metadata projection in the attribution aspect."""
import argparse
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


def load_aspect(path):
    tree = ast.parse(path.read_text())
    symbols = {"type": lambda value: "list" if isinstance(value, list) else type(value).__name__, "BuildInfo": object(), "DefaultInfo": object(), "_CompilerGraphInfo": object(),
               "fail": lambda message: (_ for _ in ()).throw(ValueError(message)),
               "depset": lambda direct, transitive: SimpleNamespace(to_list=lambda: direct + [item for group in transitive for item in group.to_list()])}
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             and node.name in ["_compiler_graph_impl", "_unit_id"]]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), symbols)
    return symbols


class StarlarkString(str):
    def __getitem__(self, key):
        return StarlarkString(super().__getitem__(key))

    def elems(self):
        return list(self)


class Graph:
    def __init__(self, root, units, inputs):
        self.root, self.units, self.inputs = root, units, inputs


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.environment = load_aspect(ARGS.rule)
        self.dep_env, self.out_dir, self.compile_data = object(), object(), object()
        self.graph = object()
        build = SimpleNamespace(dep_env=self.dep_env, out_dir=self.out_dir,
                                compile_data=SimpleNamespace(to_list=lambda: [self.compile_data]))
        self.child = {self.environment["BuildInfo"]: build, self.environment["_CompilerGraphInfo"]: self.graph}
        self.default = SimpleNamespace(files=SimpleNamespace(to_list=lambda: [self.dep_env]),
                                       default_runfiles=SimpleNamespace(files=SimpleNamespace(to_list=lambda: [self.out_dir, self.compile_data])))
        self.target = {self.environment["DefaultInfo"]: self.default}
        self.context = SimpleNamespace(rule=SimpleNamespace(kind="build_script_metadata", attr=SimpleNamespace(build_script=self.child)),
                                       label=SimpleNamespace(name="u_real__links_0"))

    def test_projection_forwards_exact_actual_child_graph_without_unit_identity(self):
        self.assertIs(self.environment["_compiler_graph_impl"](self.target, self.context)[0], self.graph)

    def test_missing_actual_buildinfo_or_graph_refused(self):
        for key in ["BuildInfo", "_CompilerGraphInfo"]:
            child = dict(self.child)
            del child[self.environment[key]]
            self.context.rule.attr.build_script = child
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "actual BuildInfo/compiler graph"):
                self.environment["_compiler_graph_impl"](self.target, self.context)

    def test_foreign_metadata_file_refused(self):
        self.default.files = SimpleNamespace(to_list=lambda: [object()])
        with self.assertRaisesRegex(ValueError, "actual metadata File"):
            self.environment["_compiler_graph_impl"](self.target, self.context)

    def test_missing_declared_output_or_compile_data_refused(self):
        for retained in [[self.out_dir], [self.compile_data]]:
            self.default.default_runfiles.files = SimpleNamespace(to_list=lambda: retained)
            with self.subTest(retained=retained), self.assertRaisesRegex(ValueError, "declared output Files"):
                self.environment["_compiler_graph_impl"](self.target, self.context)

    def test_reproduced_original_helper_label_fails_while_projection_preserves_child(self):
        original = load_aspect(ARGS.before_rule)
        with self.assertRaisesRegex(ValueError, "maintained configured compiler unit"):
            original["_compiler_graph_impl"](self.target, self.context)
        self.assertIs(self.environment["_compiler_graph_impl"](self.target, self.context)[0], self.graph)

    def test_actual_run_to_run_edge_is_preserved_without_metadata_helper_unit(self):
        environment = self.environment
        environment["_CompilerGraphInfo"] = Graph
        environment["rust_common"] = SimpleNamespace(crate_info=object())
        environment["TestCrateInfo"] = object()
        environment["json"] = SimpleNamespace(encode=json.dumps)
        env_file = SimpleNamespace(path="linked.depenv", owner="//:linked", is_directory=False)
        source_file = SimpleNamespace(path="Cargo.toml", owner="//:manifest", is_directory=False)
        sys_id = "3ef607e0679d02a63240e6fdf73ee6bb95f22ca4e96fed507d8c856f2be02394"
        compiler_id = "c61cf8773e5437b4d08c69ee7187ba24484a0460308f4b3987ce0903653852d1"
        rs_id = "e223e99cb6b5c5cdd6cfd1d713314e59fef0399501000089b7082e9446c96499"
        def child(identifier, label):
            value = {Graph: Graph(identifier, SimpleNamespace(to_list=lambda: []), SimpleNamespace(to_list=lambda: []))}
            class Target(dict):
                pass
            target = Target(value)
            target.label = label
            return target
        attributes = SimpleNamespace(script=child(compiler_id, "//:u_" + compiler_id),
                                     build_script_env_files=[child(sys_id, "//:u_" + rs_id + "__links_0")],
                                     pkg_name="aws-lc-rs", build_script_env={}, rundir="original/aws-lc-rs")
        context = SimpleNamespace(rule=SimpleNamespace(kind="cargo_build_script", attr=attributes,
                                                       files=SimpleNamespace(data=[source_file], build_script_env_files=[env_file])),
                                  label=SimpleNamespace(name=StarlarkString("u_" + rs_id)),
                                  toolchains={"@rules_rust//rust:toolchain_type": SimpleNamespace(version="1.97.1", target_triple=SimpleNamespace(str="aarch64-apple-darwin"), rust_std=SimpleNamespace(to_list=lambda: []))})
        graph = environment["_compiler_graph_impl"]({}, context)[0]
        record = json.loads(graph.units.to_list()[0])
        self.assertEqual(graph.root, rs_id)
        self.assertEqual(record["dependencies"], sorted([sys_id, compiler_id]))
        self.assertEqual(record["inputs"], [
            {"input": "Cargo.toml", "label": "//:manifest", "tree": False},
            {"input": "linked.depenv", "label": "//:linked", "tree": False}])
        self.assertEqual(len(graph.units.to_list()), 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rule", type=Path, required=True)
    parser.add_argument("--before-rule", type=Path, required=True)
    ARGS = parser.parse_args()
    unittest.main(argv=[__file__])
