"""Compiler bootstrap execution controls; fixture drivers are not qualification."""

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest


def implementation():
    path = pathlib.Path(__file__).with_name("build-compiler.py")
    specification = importlib.util.spec_from_file_location("build_compiler", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class CompilerBuildControls(unittest.TestCase):
    def setUp(self):
        self.private = tempfile.TemporaryDirectory(prefix="compiler-build-control-")
        self.addCleanup(self.private.cleanup)
        self.root = pathlib.Path(self.private.name)
        self.module = implementation()
        source = self.root / "source"
        source.mkdir()
        (source / "x.py").write_text('''import os,pathlib,sys,tomllib
configuration=pathlib.Path(sys.argv[sys.argv.index("--config")+1])
values=tomllib.loads(configuration.read_text())
assert sys.argv[1:2]==["build"]
assert sys.argv[-3:]==["compiler/rustc","library","src/tools/rustdoc"]
assert os.environ["CARGO_NET_OFFLINE"]=="true"
assert os.environ["PATH"].startswith(str(configuration.parent))
assert "RUSTUP_HOME" not in os.environ
assert all(pathlib.Path(values["target"]["aarch64-apple-darwin"][name]).is_absolute() for name in ["cc","cxx","ar","ranlib","linker"])
stage=pathlib.Path(values["build"]["build-dir"])/"aarch64-apple-darwin"/"stage1"
(stage/"bin").mkdir(parents=True)
(stage/"bin/rustc").write_text("fixture compiler")
(stage/"bin/rustc").chmod(0o755)
(stage/"bin/rustdoc").write_text("fixture rustdoc")
(stage/"bin/rustdoc").chmod(0o755)
(stage/"lib/rustlib/aarch64-apple-darwin/lib").mkdir(parents=True)
(stage/"lib/rustlib/aarch64-apple-darwin/lib/libstd-fixture.rlib").write_text("fixture library")
print("fixture original selectors completed")
''')
        tool = self.root / "tool"
        tool.write_text("declared fixture, never executed as compiler")
        recipe = {"stage": 1, "selectors": self.module.SELECTORS, "build": {"build": self.module.HOST, "host": [self.module.HOST], "target": [self.module.HOST], "rustc": str(tool), "cargo": str(tool), "rustdoc": str(tool), "vendor": True, "locked-deps": True}, "rust": {"download-rustc": False}, "llvm": {"download-ci-llvm": False}, "target": {self.module.HOST: {"llvm-config": str(tool)}}}
        configuration = self.root / "configuration.json"
        configuration.write_text(json.dumps({"host": self.module.HOST, "bootstrap": recipe, "compiler_built": False, "rustdoc_built": False, "qualified": False}))
        self.request = {"configuration": str(configuration), "sources": str(source), "native_files": [str(tool)], "native": {name: {"tool": str(tool), "flags": [], "environment": {}} for name in ["cc", "cxx", "ar", "ranlib", "linker"]}, "tools": {name: str(tool) for name in ["sh", "make", "git", "cmake"]}, "sysroot": str(self.root), "python": sys.executable}
        self.output = self.root / "output"
        self.log = self.root / "build.log"

    def test_driver_completes_all_original_selectors_with_sealed_environment(self):
        self.module.build(self.request, self.output, self.log)
        self.assertEqual((self.output / "bin/rustc").read_text(), "fixture compiler")
        self.assertIn("selectors completed", self.log.read_text())
        self.assertFalse(list(self.root.glob(".compiler-build-*")))

    def test_failed_driver_does_not_publish_partial_compiler(self):
        source = pathlib.Path(self.request["sources"]) / "x.py"
        source.write_text("import sys; print('fixture concrete failure'); sys.exit(2)")
        with self.assertRaisesRegex(RuntimeError, "exit 2"):
            self.module.build(self.request, self.output, self.log)
        self.assertFalse(self.output.exists())
        self.assertIn("concrete failure", self.log.read_text())

    def test_bazel_precreated_empty_tree_is_a_valid_output(self):
        self.output.mkdir()
        self.module.build(self.request, self.output, self.log)
        self.assertEqual((self.output / "bin/rustdoc").read_text(), "fixture rustdoc")

    def test_joined_linker_sysroot_and_environment_paths_survive_changed_cwd(self):
        original = self.request["native"]["linker"]
        root = pathlib.Path.cwd()
        with tempfile.TemporaryDirectory(prefix="native-options-") as private:
            # A declared input may live under an exec-relative Bazel output.
            nested = pathlib.Path(private).resolve() / "bazel-out"
            nested.mkdir()
            tool = nested / "ld"
            tool.write_text("original tool")
            try:
                os.chdir(private)
                command, environment = self.module.native_command({**original, "tool": "bazel-out/ld", "flags": ["--ld-path=bazel-out/ld", "--sysroot=bazel-out", "-isysroot", "bazel-out"], "environment": {"SDKROOT": "bazel-out", "PATH": "bazel-out"}}, {str(tool)}, "bazel-out")
            finally:
                os.chdir(root)
            self.assertEqual(command[1:], ["--ld-path=" + str(tool), "--sysroot=" + str(nested), "-isysroot", str(nested)])
            self.assertEqual(environment, {"SDKROOT": str(nested), "PATH": str(nested)})

    def test_zero_exit_without_rustdoc_is_not_a_compiler_result(self):
        source = pathlib.Path(self.request["sources"]) / "x.py"
        source.write_text(source.read_text().replace('(stage/"bin/rustdoc").write_text("fixture rustdoc")\n(stage/"bin/rustdoc").chmod(0o755)', "pass"))
        with self.assertRaisesRegex(ValueError, "bin/rustdoc"):
            self.module.build(self.request, self.output, self.log)
        self.assertFalse(self.output.exists())

    def test_zero_exit_with_wrong_output_kinds_is_not_a_compiler_result(self):
        source = pathlib.Path(self.request["sources"]) / "x.py"
        original = source.read_text()
        cases = [
            (original.replace('(stage/"bin/rustc").write_text("fixture compiler")\n(stage/"bin/rustc").chmod(0o755)', '(stage/"bin/rustc").mkdir()'), "bin/rustc"),
            (original.replace('write_text("fixture rustdoc")', 'write_text("")'), "bin/rustdoc"),
            (original.replace('(stage/"lib/rustlib/aarch64-apple-darwin/lib/libstd-fixture.rlib").write_text("fixture library")', "pass"), "standard-library"),
        ]
        for contents, expectation in cases:
            with self.subTest(expectation=expectation):
                source.write_text(contents)
                with self.assertRaisesRegex(ValueError, expectation):
                    self.module.build(self.request, self.output, self.log)
                self.assertFalse(self.output.exists())

    def test_undeclared_native_executable_rejects_before_output(self):
        self.request["native_files"] = []
        with self.assertRaisesRegex(ValueError, "declared regular File"):
            self.module.build(self.request, self.output, self.log)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.log.exists())

    def test_missing_utility_does_not_use_ambient_path(self):
        del self.request["tools"]["git"]
        with self.assertRaisesRegex(ValueError, "declared shell"):
            self.module.build(self.request, self.output, self.log)
        self.assertFalse(self.log.exists())

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        (self.output / "retained").write_text("original")
        with self.assertRaisesRegex(ValueError, "must be new"):
            self.module.build(self.request, self.output, self.log)
        self.assertEqual((self.output / "retained").read_text(), "original")


if __name__ == "__main__":
    unittest.main()
