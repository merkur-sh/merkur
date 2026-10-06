"""Exercise Bazel's real precreated TreeArtifact boundary and rejected replacements."""

import ast
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

specification = importlib.util.spec_from_file_location("cmake_source_build", Path(__file__).with_name("cmake_source_build.py"))
producer = importlib.util.module_from_spec(specification)
specification.loader.exec_module(producer)


class TreeArtifactControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sdk = self.root / "input-sdk"
        self.sdk.mkdir()
        binary = self.sdk / "binary"
        binary.write_bytes(b"original native executable")
        binary.chmod(0o755)
        self.output = self.root / "output-sdk"

    def verify_copied_input(self):
        binary = self.output / "binary"
        self.assertEqual(binary.read_bytes(), b"original native executable")
        self.assertEqual(binary.stat().st_mode & 0o777, 0o755)
        self.assertFalse(binary.is_symlink())

    def test_absent_output(self):
        producer.materialize_runtime(self.sdk, self.output)
        self.verify_copied_input()

    def test_engine_precreated_empty_output(self):
        self.output.mkdir()
        producer.materialize_runtime(self.sdk, self.output)
        self.verify_copied_input()

    def test_occupied_output_is_preserved_and_refused(self):
        self.output.mkdir()
        incumbent = self.output / "incumbent"
        incumbent.write_bytes(b"preserve incumbent output")
        with self.assertRaises(ValueError):
            producer.materialize_runtime(self.sdk, self.output)
        self.assertEqual(incumbent.read_bytes(), b"preserve incumbent output")
        self.assertFalse((self.output / "binary").exists())

    def test_live_directory_alias_is_preserved_and_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.output.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            producer.materialize_runtime(self.sdk, self.output)
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(list(outside.iterdir()), [])

    def test_dangling_alias_is_preserved_and_refused(self):
        self.output.symlink_to(self.root / "absent")
        with self.assertRaises(ValueError):
            producer.materialize_runtime(self.sdk, self.output)
        self.assertTrue(self.output.is_symlink())
        self.assertFalse((self.root / "absent").exists())

    def test_regular_output_file_is_preserved_and_refused(self):
        self.output.write_bytes(b"ordinary incumbent")
        with self.assertRaises(ValueError):
            producer.materialize_runtime(self.sdk, self.output)
        self.assertEqual(self.output.read_bytes(), b"ordinary incumbent")


class ConfiguredRanlibControls(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).with_name("sdk.bzl").read_text()
        function = next(node for node in ast.parse(source).body
                        if isinstance(node, ast.FunctionDef) and node.name == "configured_ranlib")
        self.cc_provider, self.variables_provider = object(), object()
        def fail(message):
            raise ValueError(message)
        namespace = {"cc_common": SimpleNamespace(CcToolchainInfo=self.cc_provider),
                     "platform_common": SimpleNamespace(TemplateVariableInfo=self.variables_provider),
                     "fail": fail}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "sdk.bzl", "exec"), namespace)
        self.select = namespace["configured_ranlib"]
        self.file = SimpleNamespace(path="original/compiler/usr/bin/ranlib", is_directory=False,
                                    is_symlink=False)
        self.files = [self.file]
        self.cc = SimpleNamespace(all_files=SimpleNamespace(to_list=lambda: self.files))
        self.variables = {"RANLIB": self.file.path}
        self.selected = {self.cc_provider: self.cc,
                         self.variables_provider: SimpleNamespace(variables=self.variables)}

    def test_exact_same_configured_compiler_file(self):
        self.assertIs(self.select(self.cc, self.selected), self.file)

    def test_other_configured_compiler_refuses(self):
        self.selected[self.cc_provider] = object()
        with self.assertRaisesRegex(ValueError, "same configured"):
            self.select(self.cc, self.selected)

    def test_missing_or_foreign_make_variable_refuses(self):
        for value in [None, "", "/usr/bin/ranlib", "foreign/compiler/ranlib"]:
            with self.subTest(value=value):
                self.variables["RANLIB"] = value
                with self.assertRaisesRegex(ValueError, "one original RANLIB"):
                    self.select(self.cc, self.selected)

    def test_absent_or_ambiguous_tool_file_refuses(self):
        for files in [[], [self.file, SimpleNamespace(**vars(self.file))]]:
            with self.subTest(count=len(files)):
                self.files = files
                with self.assertRaisesRegex(ValueError, "one original RANLIB"):
                    self.select(self.cc, self.selected)

    def test_nonordinary_tool_refuses(self):
        for attribute in ["is_directory", "is_symlink"]:
            with self.subTest(attribute=attribute):
                setattr(self.file, attribute, True)
                with self.assertRaisesRegex(ValueError, "one original RANLIB"):
                    self.select(self.cc, self.selected)
                setattr(self.file, attribute, False)


if __name__ == "__main__":
    unittest.main()
