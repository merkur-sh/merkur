#!/usr/bin/env python3
"""Separate upstream source components from the genuine stage1 runtime SDK."""

import argparse
import pathlib
import shutil


SOURCE_COMPONENTS = {pathlib.PurePosixPath("lib/rustlib/src"), pathlib.PurePosixPath("lib/rustlib/rustc-src")}


def split(stage1, runtime):
    if runtime.is_symlink() or (runtime.exists() and (not runtime.is_dir() or any(runtime.iterdir()))):
        raise ValueError("Compiler runtime output must be empty")
    if runtime.exists():
        runtime.rmdir()
    for name in ["bin/rustc", "bin/rustdoc"]:
        if not (stage1 / name).is_file():
            raise ValueError("Original stage1 compiler and rustdoc are mandatory")

    def source_components(directory, names):
        relative = pathlib.Path(directory).relative_to(stage1)
        return [name for name in names if pathlib.PurePosixPath(relative.as_posix(), name) in SOURCE_COMPONENTS]

    # Every remaining original runtime, codegen, native library and notice File
    # stays at its upstream relative path. The source Tree is exposed separately
    # through the existing pinned producer, rather than copied into worker input.
    shutil.copytree(stage1, runtime, ignore=source_components)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage1", type=pathlib.Path, required=True)
    parser.add_argument("--runtime", type=pathlib.Path, required=True)
    args = parser.parse_args()
    split(args.stage1.absolute(), args.runtime.absolute())
