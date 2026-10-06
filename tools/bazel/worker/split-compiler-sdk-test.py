"""Original runtime/source component boundary controls."""

import importlib.util
import pathlib
import tempfile
import unittest


class CompilerSdkSplitControls(unittest.TestCase):
    def setUp(self):
        self.private = tempfile.TemporaryDirectory(prefix="compiler-sdk-split-")
        self.addCleanup(self.private.cleanup)
        self.root = pathlib.Path(self.private.name)
        self.stage = self.root / "stage1"
        self.runtime = self.root / "runtime"
        path = pathlib.Path(__file__).with_name("split-compiler-sdk.py")
        specification = importlib.util.spec_from_file_location("split_sdk", path)
        self.module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(self.module)
        self.original = {
            "bin/rustc": b"fixture compiler", "bin/rustdoc": b"fixture rustdoc",
            "lib/libLLVM.dylib": b"native runtime", "lib/rustlib/host/lib/libstd.rlib": b"standard library",
            "lib/rustlib/host/codegen-backends/llvm.dylib": b"codegen backend",
            "lib/rustlib/src/library/lib.rs": b"matched standard source",
            "lib/rustlib/rustc-src/compiler/lib.rs": b"matched compiler source",
            "COPYRIGHT-library.html": b"upstream selected dependency notice",
            "lib/rustlib/host/lib/src": b"runtime name is not a source component",
        }
        for name, data in self.original.items():
            path = self.stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

    def test_exact_source_roots_separate_and_every_runtime_notice_byte_retains(self):
        self.runtime.mkdir()
        self.module.split(self.stage, self.runtime)
        expected = {name: data for name, data in self.original.items() if not name.startswith(("lib/rustlib/src/", "lib/rustlib/rustc-src/"))}
        actual = {path.relative_to(self.runtime).as_posix(): path.read_bytes() for path in self.runtime.rglob("*") if path.is_file()}
        self.assertEqual(actual, expected)
        self.assertEqual((self.stage / "lib/rustlib/src/library/lib.rs").read_bytes(), self.original["lib/rustlib/src/library/lib.rs"])

    def test_occupied_runtime_is_preserved(self):
        self.runtime.mkdir()
        (self.runtime / "existing").write_bytes(b"retained")
        with self.assertRaisesRegex(ValueError, "must be empty"):
            self.module.split(self.stage, self.runtime)
        self.assertEqual((self.runtime / "existing").read_bytes(), b"retained")

    def test_missing_rustdoc_refuses(self):
        (self.stage / "bin/rustdoc").unlink()
        with self.assertRaisesRegex(ValueError, "compiler and rustdoc"):
            self.module.split(self.stage, self.runtime)
        self.assertFalse(self.runtime.exists())


if __name__ == "__main__":
    unittest.main()
