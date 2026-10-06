#!/usr/bin/env python3
"""Prepare only the pinned compiler source and exact worker patch, never build an app."""

import argparse
import hashlib
import json
import pathlib
import subprocess
import tarfile
import tempfile


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git_sdk(configuration):
    """Consume the action's NativeSdkInfo File inventory, never discover a tool."""
    if set(configuration) != {"git", "sdk_root", "sdk_files"}:
        raise ValueError("Git requires the declared native SDK configuration")
    git = pathlib.Path(configuration["git"]).absolute()
    root = pathlib.Path(configuration["sdk_root"]).absolute()
    if git != root / "bin/git":
        raise ValueError("Git must be the native SDK's exact bin/git member")
    files = configuration["sdk_files"]
    if not isinstance(files, list) or not files or len(set(files)) != len(files):
        raise ValueError("Git requires a nonempty unique SDK File inventory")
    paths = [pathlib.Path(path).absolute() for path in files]
    if git not in paths:
        raise ValueError("Git executable is absent from the declared SDK Files")
    for required in [root / "libexec/git-core/git", root / "share/git-core/templates/description"]:
        if required not in paths:
            raise ValueError("Git SDK is missing libexec or template Files")
    facts = []
    for logical, path in zip(files, paths):
        if not path.is_file():
            raise ValueError("Declared Git SDK input is not a regular File: " + str(path))
        facts.append({"path": logical, "sha256": digest(path)})
    env = {
        "PATH": "",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_EXEC_PATH": str(root / "libexec/git-core"),
        "GIT_TEMPLATE_DIR": str(root / "share/git-core/templates"),
        "LD_LIBRARY_PATH": str(root / "lib"),
        "DYLD_FALLBACK_LIBRARY_PATH": str(root / "lib"),
    }
    return git, env, facts


def prepare(archive, destination, pins, patch, sdk):
    pin = json.loads(pins.read_text())
    if digest(archive) != pin["source_archive"]["sha256"]:
        raise ValueError("Compiler source archive does not match its content pin")
    if digest(patch) != pin["patch"]["sha256"]:
        raise ValueError("Compiler patch does not match its content pin")
    if patch.name != pin["patch"]["path"]:
        raise ValueError("Compiler patch File does not match the pinned path")
    git, env, sdk_facts = git_sdk(sdk)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Compiler source destination must be new")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".compiler-source-", dir=destination.parent) as scratch:
        scratch = pathlib.Path(scratch)
        prefix = "rustc-" + pin["version"] + "-src"
        with tarfile.open(archive, "r:xz") as source:
            for member in source.getmembers():
                path = pathlib.PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or path.parts[0] != prefix:
                    raise ValueError("Unexpected path in pinned compiler archive")
            source.extractall(scratch, filter="data")
        root = scratch / prefix
        for entry in pin["files"]:
            if digest(root / entry["path"]) != entry["base_sha256"]:
                raise ValueError("Compiler patch base differs: " + entry["path"])
        env["HOME"] = str(scratch)
        env["TMPDIR"] = str(scratch)
        env["GIT_CEILING_DIRECTORIES"] = str(scratch)
        for flags in [["--check"], []]:
            subprocess.run([str(git), "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "apply", *flags, "--whitespace=error", str(patch)], cwd=root, env=env, check=True)
        for entry in pin["files"]:
            if digest(root / entry["path"]) != entry["patched_sha256"]:
                raise ValueError("Applied compiler patch differs: " + entry["path"])
        receipt = {
            "source_archive_sha256": pin["source_archive"]["sha256"],
            "source_commit": pin["commit"],
            "patch_sha256": pin["patch"]["sha256"],
            "files": pin["files"],
            "compiler_built": False,
            "qualified": False,
            "git_sdk": sdk_facts,
            "git_sdk_root": sdk["sdk_root"],
            "git_environment": {
                "PATH": "",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "GIT_OPTIONAL_LOCKS": "0",
                "GIT_EXEC_PATH": str(pathlib.Path(sdk["sdk_root"]) / "libexec/git-core"),
                "GIT_TEMPLATE_DIR": str(pathlib.Path(sdk["sdk_root"]) / "share/git-core/templates"),
                "LD_LIBRARY_PATH": str(pathlib.Path(sdk["sdk_root"]) / "lib"),
                "DYLD_FALLBACK_LIBRARY_PATH": str(pathlib.Path(sdk["sdk_root"]) / "lib"),
            },
        }
        if digest(archive) != pin["source_archive"]["sha256"] or digest(patch) != pin["patch"]["sha256"]:
            raise ValueError("Pinned compiler inputs changed during preparation")
        for fact in sdk_facts:
            if digest(pathlib.Path(fact["path"])) != fact["sha256"]:
                raise ValueError("Declared Git SDK File changed during preparation")
        (root / "merkur-source-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        root.rename(destination)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=pathlib.Path, required=True)
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    parser.add_argument("--pins", type=pathlib.Path, required=True)
    parser.add_argument("--patch", type=pathlib.Path, required=True)
    parser.add_argument("--git-sdk", type=pathlib.Path, required=True)
    args = parser.parse_args()
    prepare(args.archive.resolve(strict=True), args.destination.absolute(), args.pins.resolve(strict=True), args.patch.resolve(strict=True), json.loads(args.git_sdk.read_text()))
