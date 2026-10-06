#!/usr/bin/env python3
"""Capture locked package notice facts without assigning compiler feature contexts.

Cargo metadata is used only for immutable package identity, effective manifest
license/repository fields and license-file. Shipping closure membership comes
from the separately captured compiler-unit graph, never this workspace union.
"""
import argparse
import hashlib
import json
import importlib.util
from pathlib import Path
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / "tools/bazel/rust/license_metadata.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def refresh(sdk):
    version = tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    sdk.require_locks([ROOT / "Cargo.lock"])
    output = subprocess.run(sdk.command("cargo", version) + ["metadata", "--locked", "--offline", "--format-version", "1"], cwd=ROOT, env=sdk.environment(), check=True, capture_output=True, text=True)
    raw = json.loads(output.stdout)
    inputs = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "tools/bazel/rust/license_metadata.py", "tools/bazel/rust/metadata.json"}
    packages = {}
    for package in raw["packages"]:
        manifest = Path(package["manifest_path"])
        package_id = package["id"]
        if package["source"] is None:
            relative = str(manifest.relative_to(ROOT))
            inputs.add(relative)
            package_id = "workspace:" + str(manifest.parent.relative_to(ROOT))
        if package_id in packages:
            raise ValueError("duplicate package notice identity")
        packages[package_id] = {key: package[key] for key in ["name", "version", "source", "license", "license_file", "repository"]}
    document = {"cargo_release": version, "inputs": {path: digest(ROOT / path) for path in sorted(inputs)}, "packages": packages}
    DEST.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")


def check():
    document = json.loads(DEST.read_text())
    if document["cargo_release"] != tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]:
        raise ValueError("stale notice metadata compiler identity")
    inventory = json.loads((ROOT / "tools/bazel/rust/metadata.json").read_text())
    required_inputs = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "tools/bazel/rust/license_metadata.py", "tools/bazel/rust/metadata.json"}
    required_inputs.update(package["manifest"] for package in inventory["packages"] if package["source"] is None)
    if set(document["inputs"]) != required_inputs or set(document["packages"]) != {package["id"] for package in inventory["packages"]}:
        raise ValueError("missing or unexpected locked notice package/input inventory")
    for package in inventory["packages"]:
        fact = document["packages"][package["id"]]
        if any(fact[key] != package[key] for key in ["name", "version", "source"]):
            raise ValueError("notice package differs from locked package identity")
    for path, expected in document["inputs"].items():
        if digest(ROOT / path) != expected:
            raise ValueError("stale notice metadata manifest input: " + path)
    for package_id, package in document["packages"].items():
        if not package_id or set(package) != {"name", "version", "source", "license", "license_file", "repository"}:
            raise ValueError("invalid notice package identity")
    return document["packages"]


def main():
    global ROOT, DEST
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--sdk-descriptor", type=Path)
    parser.add_argument("--source-root", type=Path)
    args = parser.parse_args()
    if args.refresh:
        if args.sdk_descriptor is None or args.source_root is None:
            parser.error("--refresh requires --sdk-descriptor and --source-root; ambient acquisition tools are forbidden")
        ROOT = args.source_root.resolve(strict=True)
        DEST = ROOT / "tools/bazel/rust/license_metadata.json"
        spec = importlib.util.spec_from_file_location("declared_sdk", Path(__file__).with_name("acquisition_sdk.py"))
        if spec is None or spec.loader is None:
            raise ValueError("missing declared native acquisition SDK resolver File")
        resolver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(resolver)
        sdk = resolver.NativeCargoSdk.load(args.sdk_descriptor)
        try:
            refresh(sdk)
        finally:
            sdk.close()
    print("Locked notice package facts checked: " + str(len(check())) + " packages")


if __name__ == "__main__":
    main()
