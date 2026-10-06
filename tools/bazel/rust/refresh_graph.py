#!/usr/bin/env python3
"""Refresh the Rust graph snapshot, its declarations and the notice facts from the declared Cargo SDK."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / "tools/bazel/rust"
SDK = "//tools/bazel/rust/acquire:production_sdk"
ROLES = [".descriptor.json", ".provenance.json", ".sources", ".registry"]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared implementation File: " + str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bazel", type=Path, required=True)
    args = parser.parse_args()
    environment = {name: os.environ[name] for name in ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR"] if name in os.environ}

    def bazel(*command):
        return subprocess.run([str(args.bazel.resolve()), *command], cwd=ROOT, env=environment, check=True, text=True, stdout=subprocess.PIPE).stdout

    bazel("build", SDK)
    producer = bazel("cquery", SDK, "--output=starlark", "--starlark:expr=str(target.label)").strip()
    files = bazel("cquery", SDK, "--output=files").split()
    execution_root = Path(bazel("info", "execution_root").strip())
    outputs = []
    for role in ROLES:
        [output] = [Path(file) for file in files if file.endswith(role)]
        outputs.append(output)
    presentation = load("declared_presentation", HERE / "acquire/sdk_metadata.py")
    capture = load("declared_capture", HERE / "acquire/sdk_producer.py")
    resolver = load("declared_sdk", HERE / "acquisition_sdk.py")
    # The descriptor names its Files by execution path.
    os.chdir(execution_root)
    with tempfile.TemporaryDirectory(prefix="merkur-rust-graph-") as private:
        with presentation.materialized_sdk(*outputs, producer, capture, resolver, private_parent=private) as (sdk, source):
            # The generator rewrites its declarations in this private copy of the snapshot.
            for path in source.rglob("*"):
                path.chmod(path.stat().st_mode | 0o200)
            descriptor = Path(private) / "descriptor.json"
            descriptor.write_text(json.dumps(sdk.descriptor))
            # The notice facts name the graph snapshot, so they follow it.
            for generator in ["generate.py", "license_metadata.py"]:
                subprocess.run([sys.executable, "-I", "-B", str(source / "tools/bazel/rust" / generator), "--refresh",
                                "--sdk-descriptor", str(descriptor), "--source-root", str(source)],
                               check=True, env={"PATH": "", "HOME": private, "TMPDIR": private}, stdout=subprocess.DEVNULL)
            graph = json.loads((source / "tools/bazel/rust/metadata.json").read_bytes())
            for path, expected in graph["inputs"].items():
                if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != expected:
                    raise ValueError("Rust graph input changed during refresh: " + path)
            declarations = ["tools/bazel/rust/metadata.json", "tools/bazel/rust/license_metadata.json"] + sorted(
                str(Path(package["manifest"]).parent / "BUILD.bazel") for package in graph["packages"] if package["source"] is None)
            changed = []
            for name in declarations:
                data = (source / name).read_bytes()
                if not (ROOT / name).exists() or (ROOT / name).read_bytes() != data:
                    (ROOT / name).write_bytes(data)
                    changed.append(name)
    print(f"Rust graph refreshed: {len(graph['packages'])} locked packages, {len(changed)} of {len(declarations)} declarations changed")


if __name__ == "__main__":
    main()
