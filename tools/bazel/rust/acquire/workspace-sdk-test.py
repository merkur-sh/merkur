"""Original SourceFile selection and five-lock archive declaration controls."""
import argparse
import ast
import importlib.util
import pathlib
import json
import tempfile
import types
import unittest
import hashlib

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("workspace_sdk", HERE / "workspace-sdk.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
namespace = {"fail": lambda message: (_ for _ in ()).throw(ValueError(message))}
body = ast.parse((HERE / "sdk_rules.bzl").read_text())
function = next(node for node in body.body if isinstance(node, ast.FunctionDef) and node.name == "_source_records")
exec(compile(ast.Module(body=[function], type_ignores=[]), "sdk_rules.bzl", "exec"), namespace)
implementation = next(node for node in body.body if isinstance(node, ast.FunctionDef) and node.name == "_sdk_impl")
exec(compile(ast.Module(body=[implementation], type_ignores=[]), "sdk_rules.bzl", "exec"), namespace)
select_sources = namespace["_source_records"]
ROOT = HERE.parents[3]


class Files:
    def __init__(self, direct=(), transitive=()):
        self.members = {item.path: item for item in direct}
        for nested in transitive:
            self.members.update({item.path: item for item in nested.to_list()})

    def to_list(self):
        return list(self.members.values())


class Actions:
    def __init__(self):
        self.runs = []
        self.writes = {}

    def declare_file(self, name):
        return file("bazel-out/control/bin/" + name, data=b"", is_source=False)

    def declare_directory(self, name):
        return file("bazel-out/control/bin/" + name, data=b"", is_source=False, is_directory=True)

    def write(self, output, content):
        output.data = content.encode()
        self.writes[output.path] = content

    def run(self, **arguments):
        self.runs.append(arguments)


def declared_sdk_control():
    """Execute the actual SDK action declaration with all required File fields."""
    default = lambda **values: types.SimpleNamespace(**values)
    provider = lambda **values: types.SimpleNamespace(**values)
    compiler = file("external/rust/bin/rustc", data=b"compiler")
    cargo = file("external/rust/bin/cargo", data=b"cargo")
    standard = file("external/rust/lib/rustlib/aarch64-apple-darwin/lib/libstd.rlib", data=b"stdlib")
    runtime = Files([compiler, cargo, standard])
    triple = types.SimpleNamespace(str="aarch64-apple-darwin")
    rust = types.SimpleNamespace(version="1.97.1", exec_triple=triple, target_triple=triple,
        cargo=cargo, rustc=compiler, sysroot_anchor=standard,
        rustc_lib=Files(), rust_std=Files([standard]), all_files=runtime)
    locks = [file(name, data=b"original lock") for name in generator.LOCKS]
    authored = file("packages/fixture/src/lib.rs", data=b"unrelated source")
    archive = file("external/original/fixture.crate", data=b"original archive")
    python = file("external/python/bin/python", data=b"python")
    actions = Actions()
    ctx = types.SimpleNamespace(label=types.SimpleNamespace(name="workspace_sdk"), actions=actions,
        toolchains={"@rules_rust//rust:toolchain_type":rust},
        attr=types.SimpleNamespace(execution_host=triple.str, source_files={}, locks=list(generator.LOCKS),
            archives={"original": "fixture@1.0.0"}, _python={default:types.SimpleNamespace(files_to_run=python)}),
        files=types.SimpleNamespace(source_inputs=locks+[authored], source_files=[], archives=[archive]),
        file=types.SimpleNamespace(_producer=file("producer.py", data=b"producer"),
            _resolver=file("resolver.py", data=b"resolver"), _materializer=file("materializer.py", data=b"materializer")),
        executable=types.SimpleNamespace(_python=python))
    # Label-keyed dictionaries contain targets with DefaultInfo, not guessed paths.
    class Target:
        def __getitem__(self, key):
            assert key is default
            return types.SimpleNamespace(files=Files([archive]))
        label = "@original//file"
    ctx.attr.archives = {Target(): "fixture@1.0.0"}
    local = {**namespace, "DefaultInfo":default, "CargoAcquisitionSdkInfo":provider,
        "OutputGroupInfo":provider, "depset":Files, "json":types.SimpleNamespace(encode=json.dumps)}
    exec(compile(ast.Module(body=[implementation], type_ignores=[]), "sdk_rules.bzl", "exec"), local)
    result = local["_sdk_impl"](ctx)
    return ctx, result[1], {"default":default, "locks":locks, "authored":authored,
        "compiler":compiler, "standard":standard, "python":python}


def action_signature(action):
    return (action["arguments"], sorted((item.path, hashlib.sha256(item.data).hexdigest())
        for item in action["inputs"].to_list()))


def declared_stock_action(ctx, sdk, original):
    default = original["default"]
    cargo_info, link_info, prepared_info = object(), object(), object()
    stock_source = (HERE.parents[1] / "packaging/stdlib-native-graph.bzl").read_text()
    action = next(node for node in ast.parse(stock_source).body
                  if isinstance(node, ast.FunctionDef) and node.name == "stdlib_native_graph_action")
    local = {"CargoAcquisitionSdkInfo":cargo_info, "RustLinkMapInfo":link_info,
        "PreparedCompilerSourceInfo":prepared_info, "DefaultInfo":default,
        "depset":Files, "json":types.SimpleNamespace(encode=json.dumps),
        "struct":lambda **values:types.SimpleNamespace(**values), "fail":namespace["fail"]}
    exec(compile(ast.Module(body=[action], type_ignores=[]), "stdlib-native-graph.bzl", "exec"), local)
    inputs = [file(name, data=name.encode(), is_directory=(name == "original.source_tree"))
              for name in ["original.source_tree", "source.tar.xz", "std.tar.xz", "compiler.tar.xz",
                           "stock.py", "resolver.py", "graph.py", "pair.py", "materializer.py", "capture.py"]]
    prepared = types.SimpleNamespace(source_tree=inputs[0], archive=inputs[1], source_subdirectory="rust-source")
    native = types.SimpleNamespace(compiler="1.97.1", target="aarch64-apple-darwin",
        execution_host="aarch64-apple-darwin", stdlib=Files([original["standard"]]))
    class Target(dict):
        label = "//tools/bazel/rust/acquire:workspace_sdk"
    local["stdlib_native_graph_action"](ctx, Target({cargo_info:sdk}), {link_info:native}, {prepared_info:prepared},
        *inputs[2:8], {default:types.SimpleNamespace(files_to_run=types.SimpleNamespace(executable=original["python"]))},
        *inputs[8:])
    return ctx.actions.runs[-1]


def file(logical, **overrides):
    values = dict(path=logical, short_path=logical, is_source=True, is_directory=False, is_symlink=False, owner="//fixture:" + logical)
    values.update(overrides)
    return types.SimpleNamespace(**values)


def locks(root, changes=None):
    runtime = root / "tools/bazel/rust/runtime_inputs.json"
    runtime.parent.mkdir(parents=True, exist_ok=True)
    runtime.write_text(json.dumps({"fixture": ["fixtures/runtime.json"]}))
    member = root / "fixtures/runtime.json"
    member.parent.mkdir(parents=True, exist_ok=True)
    member.write_text("original runtime fixture")
    for index, logical in enumerate(generator.LOCKS):
        destination = root / logical
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text('version = 4\n[[package]]\nname = "fixture"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "%s"\n' % ("a" * 64))
    if changes:
        logical, old, new = changes
        destination = root / logical
        destination.write_text(destination.read_text().replace(old, new))


class Controls(unittest.TestCase):
    def test_stock_capture_uses_only_original_locks_and_reuses_registry_runtime(self):
        ctx, sdk, original = declared_sdk_control()
        stock = next(action for action in ctx.actions.runs if action["mnemonic"] == "MerkurCargoAcquisitionStockSdk")
        workspace = next(action for action in ctx.actions.runs if action["mnemonic"] == "MerkurCargoAcquisitionSdk")
        request = json.loads(ctx.actions.writes["bazel-out/control/bin/workspace_sdk.stock.request.json"])
        self.assertEqual(request["locks"], list(generator.LOCKS))
        self.assertEqual([row["logical"] for row in request["sources"]], sorted(generator.LOCKS))
        self.assertEqual({row["path"] for row in request["sources"]}, {row.path for row in original["locks"]})
        self.assertNotIn(original["authored"], stock["inputs"].to_list())
        self.assertIn(original["authored"], workspace["inputs"].to_list())
        self.assertIn("workspace_sdk.registry.descriptor.json", stock["arguments"][stock["arguments"].index("--registry-descriptor")+1])
        before = action_signature(stock)
        workspace_before = action_signature(workspace)
        original["authored"].data = b"unrelated authored source edit"
        self.assertEqual(action_signature(stock), before)
        self.assertNotEqual(action_signature(workspace), workspace_before)

    def test_stock_graph_consumes_projection_and_original_lock_compiler_std_changes_invalidate(self):
        ctx, sdk, original = declared_sdk_control()
        stock = next(action for action in ctx.actions.runs if action["mnemonic"] == "MerkurCargoAcquisitionStockSdk")
        graph = declared_stock_action(ctx, sdk, original)
        request = json.loads(ctx.actions.writes["bazel-out/control/bin/workspace_sdk.native-stdlib-request.json"])
        self.assertEqual(request["sdk"], sdk.stock_descriptor.path)
        self.assertEqual(request["sdk_sources"], sdk.stock_sources.path)
        self.assertEqual(request["sdk_provenance"], sdk.stock_provenance.path)
        for member in [sdk.stock_descriptor, sdk.stock_sources, sdk.stock_provenance, sdk.registry, original["compiler"], original["standard"]]:
            self.assertIn(member, graph["inputs"].to_list())
        for member in [sdk.descriptor, sdk.sources, sdk.provenance, original["authored"]]:
            self.assertNotIn(member, graph["inputs"].to_list())
        before_stock, before_graph = action_signature(stock), action_signature(graph)
        original["authored"].data += b" changed"
        self.assertEqual(action_signature(stock), before_stock)
        self.assertEqual(action_signature(graph), before_graph)
        original["locks"][0].data += b" changed original lock"
        self.assertNotEqual(action_signature(stock), before_stock)
        original["compiler"].data += b" changed compiler"
        self.assertNotEqual(action_signature(graph), before_graph)
        self.assertNotEqual(action_signature(stock), before_stock)
        original["compiler"].data = b"compiler"
        self.assertEqual(action_signature(graph), before_graph)
        original["standard"].data += b" changed stdlib"
        self.assertNotEqual(action_signature(graph), before_graph)

    def test_original_union_sorted_deduplicated_and_mapped_fixture_preserved(self):
        a, b = file("Cargo.lock"), file("packages/fec/src/lib.rs")
        self.assertEqual(select_sources([(file("fixtures/lib.rs"), "src/lib.rs")], [b, a, b]), [
            {"logical": "Cargo.lock", "path": "Cargo.lock"},
            {"logical": "packages/fec/src/lib.rs", "path": "packages/fec/src/lib.rs"},
            {"logical": "src/lib.rs", "path": "fixtures/lib.rs"},
        ])

    def test_generated_external_tree_symlink_and_noncanonical_inputs_refuse(self):
        for candidate in [file("bazel-out/copy.rs", is_source=False), file("../foreign/source.rs"),
                          file("registry", is_directory=True), file("alias.rs", is_symlink=True),
                          file("source.rs", path="external/foreign/source.rs"), file("source/./lib.rs"),
                          file("source//lib.rs"), file("source/../lib.rs"), file("/lib.rs")]:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                select_sources([], [candidate])

    def test_conflicting_logical_mapping_refuses(self):
        with self.assertRaises(ValueError):
            select_sources([(file("other.lock"), "Cargo.lock")], [file("Cargo.lock")])

    def test_missing_original_lock_refuses_before_action_declaration(self):
        triple = types.SimpleNamespace(str="aarch64-apple-darwin")
        rust = types.SimpleNamespace(version="1.97.1", exec_triple=triple, target_triple=triple)
        ctx = types.SimpleNamespace(
            toolchains={"@rules_rust//rust:toolchain_type": rust},
            attr=types.SimpleNamespace(execution_host="aarch64-apple-darwin", source_files={}, locks=["Cargo.lock"]),
            files=types.SimpleNamespace(source_inputs=[file("src/lib.rs")]),
        )
        # There is no actions object: the exact implementation must refuse first.
        with self.assertRaisesRegex(ValueError, "lock must be an original"):
            namespace["_sdk_impl"](ctx)

    def test_original_five_lock_union_and_host_declarations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            locks(root)
            packages, guards = generator.catalog(root)
            self.assertEqual(packages, {("fixture", "1.0.0"): "a" * 64})
            self.assertEqual(list(guards), list(generator.LOCKS))
            outputs = generator.render(root)
            module = outputs["workspace-archives.MODULE.bazel"]
            self.assertEqual(module.count("workspace_cargo_archive("), 1)
            self.assertIn('"http_file"', module)
            self.assertNotIn("http_archive", module)
            declaration = outputs["workspace-sdk.bzl"]
            self.assertEqual(declaration.count("    cargo_acquisition_sdk("), 4)
            for suffix, host, _, _ in generator.HOSTS:
                self.assertIn('name = "workspace_sdk_%s"' % suffix, declaration)
                self.assertIn('execution_host = "%s"' % host, declaration)
            self.assertIn('name = "production_sdk"', declaration)
            self.assertIn('"//conditions:default": ["@platforms//:incompatible"]', declaration)
            self.assertNotIn("archive_sdk_control", declaration)
            self.assertIn("production_acquisition_sources", declaration)
            self.assertNotIn("static_source_inputs", declaration)

    def test_cross_lock_conflict_refuses_before_declarations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            locks(root, (generator.LOCKS[-1], "a" * 64, "b" * 64))
            with self.assertRaises(ValueError):
                generator.render(root)

    def test_missing_checksum_or_nonoriginal_registry_refuses(self):
        for old, new in [("a" * 64, ""), ("a" * 64, "g" * 64),
                         ("registry+https://github.com/rust-lang/crates.io-index", "git+https://outside.invalid/repo")]:
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                locks(root, (generator.LOCKS[0], old, new))
                with self.subTest(new=new), self.assertRaises(ValueError):
                    generator.render(root)

    def test_runtime_inventory_selects_only_actual_original_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            locks(root)
            self.assertEqual(generator.runtime_sources(root), {"//:fixtures/runtime.json": "fixtures/runtime.json", "//:tools/bazel/rust/runtime_inputs.json": "tools/bazel/rust/runtime_inputs.json"})
            outputs = generator.render(root)
            self.assertEqual(outputs["workspace-sdk.bzl"].count("source_files = _WORKSPACE_RUNTIME_SOURCES"), 4)
            (root / "fixtures/runtime.json").unlink()
            with self.assertRaisesRegex(ValueError, "runtime source File is missing"):
                generator.render(root)

    def test_runtime_paths_cannot_escape_original_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            locks(root)
            for value in ["../outside", "/outside", "fixtures/./runtime.json", "fixtures//runtime.json", None]:
                (root / "tools/bazel/rust/runtime_inputs.json").write_text(json.dumps({"fixture": [value]}))
                with self.subTest(value=value), self.assertRaisesRegex(ValueError, "canonical and relative"):
                    generator.render(root)

    def test_current_original_locks_match_retained_declarations(self):
        for name, data in generator.render(ROOT).items():
            self.assertEqual((HERE / name).read_text(), data, name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path, default=ROOT)
    args, remaining = parser.parse_known_args()
    ROOT = args.root
    unittest.main(argv=[__file__, *remaining])
