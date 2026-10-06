"""Exact original pipeline rule admission/closure controls; fixtures qualify no compiler execution."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

RULE = Path(__file__).with_name("pipeline_controls.bzl")
HOSTS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]


class Runtime:
    def __init__(self, files):
        self.files = list(files)

    def merge(self, other):
        return Runtime(self.files + other.files)


class Default:
    def __call__(self, **kwargs):
        return kwargs


class NativePipelineDeclaration(unittest.TestCase):
    def fixture(self, host=HOSTS[0], target=None, version="1.97.1"):
        default = Default()
        calls = []
        writes = []
        def file(path):
            return SimpleNamespace(path=path, short_path=path)
        python, wrapper, checker, rustc, anchor, runtime = [file(path) for path in
            ["native/python", "native/wrapper", "worker/pipeline-test.py", "sdk/bin/rustc", "sdk/sysroot_anchor", "sdk/lib/original-runtime"]]
        std = file("sdk/lib/rustlib/" + (target or host) + "/lib/original-std.rlib")
        toolchain = SimpleNamespace(version=version, exec_triple=SimpleNamespace(str=host),
                                    target_triple=SimpleNamespace(str=target or host),
                                    rustc=rustc, sysroot_anchor=anchor, all_files=[rustc, anchor, runtime, std])
        def write(*args, **kwargs):
            writes.append((args, kwargs))
        def declare(name):
            calls.append(name)
            return file(name)
        ctx = SimpleNamespace(toolchains={"@rules_rust//rust:toolchain_type": toolchain},
                              attr=SimpleNamespace(python={default:SimpleNamespace(files_to_run=SimpleNamespace(executable=python),default_runfiles=Runtime([python]))},
                                                   wrapper={default:SimpleNamespace(default_runfiles=Runtime([wrapper]))}),
                              executable=SimpleNamespace(wrapper=wrapper), file=SimpleNamespace(_test=checker),
                              label=SimpleNamespace(name="pipeline_control"),
                              actions=SimpleNamespace(declare_file=declare,write=write),
                              runfiles=lambda files=(),transitive_files=():Runtime([*files,*transitive_files]))
        epoch = file("epochs/original")
        def fail(message):
            raise ValueError(message)
        scope = {"DefaultInfo":default,"TestRuntimeInfo":lambda **kwargs:kwargs,
                 "test_nonce_file":lambda ctx:epoch,"fail":fail}
        source = ast.parse(RULE.read_text())
        nodes = [node for node in source.body if isinstance(node,ast.FunctionDef) and node.name in ["_runfile","_impl"]]
        exec(compile(ast.Module(body=nodes,type_ignores=[]),str(RULE),"exec"),scope)
        return scope["_impl"], ctx, calls, writes, toolchain, epoch

    def test_all_four_exact_native_hosts_keep_compiler_std_and_runtime_closure(self):
        for host in HOSTS:
            with self.subTest(host=host):
                implementation, ctx, calls, writes, toolchain, epoch = self.fixture(host)
                result = implementation(ctx)
                runtime = result[1]["runfiles"].files
                for original in toolchain.all_files:
                    self.assertIn(original, runtime)
                self.assertNotIn(epoch, runtime)
                self.assertIn(epoch, result[0]["runfiles"].files)
                self.assertEqual(calls, ["pipeline_control.sh"])
                launcher = writes[0][0][1]
                self.assertIn('--rustc "$r/_main/sdk/bin/rustc"', launcher)
                self.assertIn('--sysroot "$r/_main/sdk"', launcher)

    def test_cross_target_refuses_before_any_launcher_or_runtime_publication(self):
        for target in ["wasm32-unknown-unknown", "x86_64-unknown-linux-gnu"]:
            implementation, ctx, calls, writes, _, _ = self.fixture(target=target)
            with self.subTest(target=target), self.assertRaisesRegex(ValueError,"matching native Rust1.97.1"):
                implementation(ctx)
            self.assertEqual(calls, [])
            self.assertEqual(writes, [])

    def test_foreign_compiler_version_refuses_before_any_launcher(self):
        implementation, ctx, calls, _, _, _ = self.fixture(version="1.98.0")
        with self.assertRaisesRegex(ValueError,"matching native Rust1.97.1"):
            implementation(ctx)
        self.assertEqual(calls, [])

    def test_unsupported_matching_host_is_not_published_as_native_control(self):
        implementation, ctx, calls, _, _, _ = self.fixture(host="wasm32-unknown-unknown")
        with self.assertRaisesRegex(ValueError,"matching native Rust1.97.1"):
            implementation(ctx)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
