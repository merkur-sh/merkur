"""Narrow declaration controls; these do not compile or execute native Rust."""

import unittest
from pathlib import Path


class GraphicsDeclarations(unittest.TestCase):
    def factory(self):
        calls = []
        source = Path(__file__).with_name("graphics-long.bzl").read_text()
        scope = {
            "load": lambda *args: None,
            "fail": lambda message: (_ for _ in ()).throw(ValueError(message)),
            "native_graphics_inputs": lambda **kwargs: calls.append(("inputs", kwargs)),
            "bun_command_test": lambda **kwargs: calls.append(("test", kwargs)),
        }
        exec(compile(source, "graphics-long.bzl", "exec"), scope)
        return scope["graphics_long_tests"], calls

    def test_both_genuine_caller_roots_and_original_helper_mandatory(self):
        factory, calls = self.factory()
        factory("long", "//current:lib", "//current:bin", "//current:worker")
        self.assertEqual([kind for kind, _ in calls], ["inputs", "test", "inputs", "test"])
        for role, root, offset in [("lib", "lib.rs", 0), ("bin", "main.rs", 2)]:
            inputs = calls[offset][1]
            test = calls[offset + 1][1]
            self.assertEqual(inputs["dataplane_test"], "//current:" + role)
            self.assertEqual(inputs["dataplane_root"], "apps/daemon/dataplane/src/" + root)
            self.assertEqual(inputs["image_worker"], "//current:worker")
            self.assertTrue(inputs["testonly"])
            self.assertEqual(test["fixed_args"], [role])
            self.assertEqual(test["environment_files"], {":long_" + role + "_inputs": "MERKUR_REAL_HELPER_INPUTS"})
            self.assertEqual(test["entry_point"], "//tools/bazel/verification:graphics-long.ts")
            self.assertNotIn("tools", test)

    def test_real_helper_fixed_library_root_preserves_original_wrapper(self):
        calls = []
        class Attr:
            def __getattr__(self, name):
                return lambda *args, **kwargs: (name, args, kwargs)
        scope = {
            "load": lambda *args: None,
            "attr": Attr(),
            "rule": lambda **kwargs: lambda **attributes: calls.append(("inputs", attributes)),
            "rust_common": type("Rust", (), {"crate_info": object()})(),
            "TestRuntimeInfo": object(),
            "bun_command_test": lambda **kwargs: calls.append(("test", kwargs)),
        }
        exec(compile(Path(__file__).with_name("real-helper.bzl").read_text(), "real-helper.bzl", "exec"), scope)
        scope["real_helper_test"]("helper", "current_library", "original_worker")
        self.assertEqual(calls[0][1]["dataplane_root"], "apps/daemon/dataplane/src/lib.rs")
        self.assertEqual(calls[0][1]["dataplane_test"], "current_library")
        self.assertTrue(calls[0][1]["testonly"])
        self.assertEqual(calls[1][1]["entry_point"], "//tools/bazel/verification:real-helper.ts")
        self.assertNotIn("fixed_args", calls[1][1])

    def test_missing_or_duplicate_harnesses_refuse_before_rule_creation(self):
        for lib, binary, worker in [(None, "bin", "worker"), ("lib", None, "worker"), ("lib", "bin", None), ("same", "same", "worker")]:
            factory, calls = self.factory()
            with self.assertRaises(ValueError):
                factory("long", lib, binary, worker)
            self.assertEqual(calls, [])

    def test_qualification_attributes_preserved_for_both_tests(self):
        factory, calls = self.factory()
        factory("long", "lib", "bin", "worker", tags=["manual", "unqualified-native"], timeout="long")
        for kind, test in calls:
            if kind == "test":
                self.assertEqual(test["tags"], ["manual", "unqualified-native"])
                self.assertEqual(test["timeout"], "long")


if __name__ == "__main__":
    unittest.main()
