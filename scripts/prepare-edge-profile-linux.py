#!/usr/bin/env python3
"""Build and pin diagnostic binaries against their exact source inputs on Linux."""
import argparse
import hashlib
import json
import os
import platform
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    checksum = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def source_inputs(root=ROOT):
    paths = [root / name for name in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml"]]
    # Every workspace manifest affects resolution, even when its crate does not
    # enter the edge binary. Only these path dependencies supply its Rust source.
    for directory in [root / "apps", root / "packages"]:
        paths.extend(directory.rglob("Cargo.toml"))
    for name in ["apps/edge", "packages/merkur-edge-protocol", "packages/quinn-patch",
                 "packages/quinn-proto-patch", "packages/wtransport-patch", "tools/edge-kernel-profile"]:
        directory = root / name
        paths.extend(directory.rglob("*.rs"))
        paths.extend(directory.rglob("*.c"))
        paths.extend(directory.rglob("Cargo.toml"))
        paths.extend(directory.rglob("Cargo.lock"))
    paths.extend([root / "scripts/prepare-edge-profile-linux.py", root / "scripts/profile-edge-linux.py"])
    return {str(path.relative_to(root)): digest(path) for path in sorted(set(paths))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("Linux binaries and tracepoints must be built on Linux")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    commands = [
        ["cargo", "build", "-p", "merkur-edge", "--features", "profiling", "--bin", "merkur-edge", "--bin", "relay_profile", "--release", "--locked", "--target-dir", str(output / "edge-target")],
        ["cargo", "build", "--manifest-path", "tools/edge-kernel-profile/Cargo.toml", "--release", "--locked", "--target-dir", str(output / "aya-target")],
        ["clang", "-O2", "-g", "-target", "bpf", "-c", "tools/edge-kernel-profile/trace.bpf.c", "-o", str(output / "trace.bpf.o")],
    ]
    before = source_inputs()
    environment = dict(os.environ)
    environment.pop("RUSTUP_TOOLCHAIN", None)
    # Line tables provide native symbolization without changing optimization,
    # overflow behavior, frame-pointer policy or the transport configuration.
    environment["CARGO_PROFILE_RELEASE_DEBUG"] = "line-tables-only"
    for command in commands:
        subprocess.run(command, cwd=ROOT, env=environment, check=True)
    if source_inputs() != before:
        raise RuntimeError("source changed during preparation; rebuild before recording")
    binaries = {"edge": output / "edge-target/release/merkur-edge",
                "peer": output / "edge-target/release/relay_profile",
                "aya": output / "aya-target/release/merkur-edge-kernel-profile",
                "ebpf": output / "trace.bpf.o"}
    receipt = {"source_inputs": before, "commands": commands,
               "rustc": subprocess.check_output(["rustc", "-Vv"], cwd=ROOT, env=environment, text=True),
               "clang": subprocess.check_output(["clang", "--version"], text=True),
               "platform": platform.platform(), "machine": platform.machine(),
               "profile": {"inherits": "release", "debug": "line-tables-only"},
               "binaries": {name: {"path": str(path), "sha256": digest(path)} for name, path in binaries.items()}}
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(output / "receipt.json")


if __name__ == "__main__":
    main()
