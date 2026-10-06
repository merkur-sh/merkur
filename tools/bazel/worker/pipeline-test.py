#!/usr/bin/env python3
"""Exercise real stable-rustc metadata completion and worker-compatible crate identity."""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ.get("TEST_TMPDIR"))
        self.root = Path(self.temporary.name).resolve(strict=True)
        self.addCleanup(self.temporary.cleanup)
        for name in ("early", "full", "consumer", "incremental"):
            (self.root / name).mkdir()
        (self.root / "a.rs").write_text("pub fn value() -> u32 { 7 }\n")
        (self.root / "b.rs").write_text("pub fn value() -> u32 { a::value() }\n")
        (self.root / "main.rs").write_text("fn main() { assert_eq!(b::value(), 7); }\n")
        self.env = {"PATH": "", "HOME": str(self.root), "TMPDIR": str(self.root)}
        self.common = ["--sysroot", str(ARGS.sysroot), "--edition=2024", "-Cdebuginfo=0", "-Cmetadata=merkur_pipeline_control", "-Copt-level=0"]

    def run_command(self, args):
        return subprocess.run(args, cwd=self.root, env=self.env, capture_output=True, text=True, timeout=60)

    def compiler(self, args):
        return self.run_command([str(ARGS.rustc), *self.common, *args])

    def early(self, *, compatible=True, source="a.rs", scratch="early/liba.rmeta.incremental"):
        options = ["--rustc-output-format", "rendered", "--rustc-quit-on-rmeta", "true"]
        if compatible:
            options += ["--rustc-metadata-incremental-dir", scratch]
        return self.run_command([str(ARGS.wrapper), *options, "--", str(ARGS.rustc), *self.common, source, "--crate-name=a", "--crate-type=rlib", "--emit=metadata,link", "--error-format=json", "--json=artifacts", "--out-dir=early", f"--remap-path-prefix={self.root}=."])

    def consume(self):
        full = self.compiler(["a.rs", "--crate-name=a", "--crate-type=rlib", "--emit=metadata,link", "--error-format=json", "--json=artifacts", "--out-dir=full", f"-Cincremental={self.root}/incremental", f"--remap-path-prefix={self.root}=/merkur/execroot"])
        self.assertEqual(full.returncode, 0, full.stderr)
        consumer = self.compiler(["b.rs", "--crate-name=b", "--crate-type=rlib", "--emit=metadata,link", "--out-dir=consumer", "--extern=a=early/liba.rmeta"])
        self.assertEqual(consumer.returncode, 0, consumer.stderr)
        return self.compiler(["main.rs", "--extern=b=consumer/libb.rlib", "--extern=a=full/liba.rlib", "-Ldependency=full", "-Ldependency=consumer", "--emit=metadata", "-o=main.rmeta"])

    def test_original_recipe_has_incompatible_metadata(self):
        early = self.early(compatible=False)
        self.assertEqual(early.returncode, 0, early.stderr)
        final = self.consume()
        self.assertNotEqual(final.returncode, 0)
        self.assertIn("E0460", final.stderr)

    def test_matching_metadata_propagates_to_real_object_consumer(self):
        early = self.early()
        self.assertEqual(early.returncode, 0, early.stderr)
        final = self.consume()
        self.assertEqual(final.returncode, 0, final.stderr)
        self.assertEqual((self.root / "early/liba.rmeta").read_bytes(), (self.root / "full/liba.rmeta").read_bytes())
        self.assertFalse((self.root / "early/liba.rmeta.incremental").exists())

    def test_explicit_profile_and_codegen_units_match(self):
        self.common += ["-Copt-level=3", "-Ccodegen-units=2"]
        early = self.early()
        self.assertEqual(early.returncode, 0, early.stderr)
        final = self.consume()
        self.assertEqual(final.returncode, 0, final.stderr)
        self.assertEqual((self.root / "early/liba.rmeta").read_bytes(), (self.root / "full/liba.rmeta").read_bytes())
        self.assertFalse((self.root / "early/liba.rmeta.incremental").exists())

    def test_compiler_failure_retires_owned_scratch(self):
        (self.root / "a.rs").write_text("pub fn value() -> u32 { missing() }\n")
        result = self.early()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "early/liba.rmeta.incremental").exists())
        self.assertFalse((self.root / "early/liba.rmeta").exists())

    def test_missing_compiler_retires_owned_scratch(self):
        result = self.run_command([str(ARGS.wrapper), "--rustc-output-format", "rendered", "--rustc-quit-on-rmeta", "true", "--rustc-metadata-incremental-dir", "early/scratch", "--", str(self.root / "absent-rustc")])
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "early/scratch").exists())

    def test_existing_directory_and_alias_are_preserved(self):
        caller = self.root / "caller"
        caller.mkdir()
        marker = caller / "marker"
        marker.write_bytes(b"caller-owned")
        for path in (self.root / "early/existing", self.root / "early/alias"):
            if path.name == "existing":
                path.mkdir()
                (path / "marker").write_bytes(b"caller-owned")
            else:
                path.symlink_to(caller, target_is_directory=True)
            result = self.early(scratch=path.relative_to(self.root).as_posix())
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((path / "marker").read_bytes(), b"caller-owned")
        self.assertEqual(marker.read_bytes(), b"caller-owned")
        self.assertTrue((self.root / "early/alias").is_symlink())

    def test_nonrelative_paths_and_missing_completion_refuse(self):
        for scratch in (str(self.root / "absolute"), "../outside", "early/./scratch"):
            result = self.early(scratch=scratch)
            self.assertNotEqual(result.returncode, 0)
        result = self.run_command([str(ARGS.wrapper), "--rustc-metadata-incremental-dir", "early/scratch", "--", str(ARGS.rustc), "-vV"])
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "early/scratch").exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrapper", type=Path, required=True)
    parser.add_argument("--rustc", type=Path, required=True)
    parser.add_argument("--sysroot", type=Path, required=True)
    ARGS = parser.parse_args()
    for name in ("wrapper", "rustc", "sysroot"):
        setattr(ARGS, name, getattr(ARGS, name).absolute())
    version = subprocess.run([str(ARGS.rustc), "-vV"], env={"PATH": ""}, check=True, capture_output=True, text=True).stdout
    if "release: 1.97.1" not in version.splitlines():
        raise ValueError("pipeline controls require the declared pinned stable compiler")
    unittest.main(argv=[__file__])
