"""Exercise the maintained rules_rust build-script C/C++ path normalization."""
import argparse
import ast
from pathlib import Path
import posixpath
from types import SimpleNamespace
import unittest


def load_normalization(path):
    tree = ast.parse(path.read_text())
    symbols = {"paths": SimpleNamespace(is_absolute=posixpath.isabs),
               "_BAZEL_PATH_PLACEHOLDERS": ["__BAZEL_XCODE_DEVELOPER_DIR__", "__BAZEL_XCODE_SDKROOT__"],
               "fail": lambda message: (_ for _ in ()).throw(ValueError(message))}
    nodes = [node for node in tree.body if (
        isinstance(node, ast.FunctionDef) and (
            node.name.startswith("_pwd_") or node.name.startswith("_prefix_pwd_")
            or node.name in ["_should_prefix_pwd", "_expects_space_separated_arg", "_validate_declared_linker_flags"]
        )
    ) or (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
        and target.id in ["_DIRECT_LIB_EXTENSIONS", "_PWD_FLAG_PASSES"] for target in node.targets))]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), symbols)
    return symbols


def files(*values):
    return SimpleNamespace(to_list=lambda: [SimpleNamespace(path=path, is_directory=directory)
                                            for path, directory in values])


class RelocationTests(unittest.TestCase):
    def test_exact_linker_and_framework_paths_preserve_flags_and_order(self):
        flags = ["--no-default-config", "--target=arm64-apple-macos15.0", "--ld-path=bazel-out/sdk/bin/ld",
                 "-F", "bazel-out/sdk/Frameworks", "-Fbazel-out/sdk/Extra", "-Wl,-dead_strip", "-O3"]
        ACTUAL["_validate_declared_linker_flags"](flags, files(("bazel-out/sdk/bin/ld", False)))
        self.assertEqual(ACTUAL["_pwd_flags"](flags), [
            "--no-default-config", "--target=arm64-apple-macos15.0", "--ld-path=${pwd}/bazel-out/sdk/bin/ld",
            "-F", "${pwd}/bazel-out/sdk/Frameworks", "-F${pwd}/bazel-out/sdk/Extra", "-Wl,-dead_strip", "-O3"])

    def test_declared_tree_member_is_supported(self):
        ACTUAL["_validate_declared_linker_flags"](["--ld-path=bazel-out/sdk/bin/ld"], files(("bazel-out/sdk", True)))

    def test_foreign_or_unrepresentable_linker_refused(self):
        for value in ["", "/usr/bin/ld", "bazel-out/sdk-other/bin/ld", "bazel-out/sdk/../foreign/ld",
                      "bazel-out/sdk//bin/ld", "./bazel-out/sdk/bin/ld"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                ACTUAL["_validate_declared_linker_flags"](["--ld-path=" + value], files(("bazel-out/sdk", True)))
        with self.assertRaises(ValueError):
            ACTUAL["_validate_declared_linker_flags"](["--ld-path=bazel-out/sdk/bin/ld"], files())

    def test_original_supported_paths_still_relocate(self):
        original = ["--sysroot=bazel-out/sdk", "-resource-dir", "bazel-out/resource", "-isystem", "external/headers",
                    "-Lexternal/lib", "-Bexternal/bin", "external/lib.a"]
        self.assertEqual(ACTUAL["_pwd_flags"](original), [
            "--sysroot=${pwd}/bazel-out/sdk", "-resource-dir", "${pwd}/bazel-out/resource", "-isystem", "${pwd}/external/headers",
            "-L${pwd}/external/lib", "-B${pwd}/external/bin", "${pwd}/external/lib.a"])

    def test_normalized_absolute_and_other_options_unchanged(self):
        args = ["--ld-path=${pwd}/bazel-out/sdk/ld", "-F/absolute/Frameworks", "-F", "${pwd}/external/frameworks",
                "-iframeworkwithsysroot", "/System/Library/Frameworks", "-fuse-ld=lld", "-Wl,-rpath,@loader_path"]
        self.assertEqual(ACTUAL["_pwd_flags"](args), args)

    def test_clang_cl_wrapped_linker_and_framework_relocation(self):
        ACTUAL["_validate_declared_linker_flags"](["/clang:--ld-path=bazel-out/sdk/ld", "--ld-path=${pwd}/bazel-out/sdk/ld"], files(("bazel-out/sdk/ld", False)))
        with self.assertRaises(ValueError):
            ACTUAL["_validate_declared_linker_flags"](["/clang:--ld-path=foreign/ld"], files(("bazel-out/sdk/ld", False)))
        self.assertEqual(ACTUAL["_pwd_flags"](["/clang:--ld-path=bazel-out/sdk/ld", "/clang:-Fexternal/frameworks"]),
                         ["/clang:--ld-path=${pwd}/bazel-out/sdk/ld", "/clang:-F${pwd}/external/frameworks"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rule", type=Path, required=True)
    args = parser.parse_args()
    ACTUAL = load_normalization(args.rule)
    unittest.main(argv=[__file__])
