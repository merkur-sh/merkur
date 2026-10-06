#!/usr/bin/env python3
"""Retain Bolero's independent locked resolution and exact instrumented units.

Cargo runs only metadata/unit-graph introspection. Bazel owns every compiler,
build-script, link and engine invocation.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tomllib

_contexts_spec = importlib.util.spec_from_file_location("contexts", Path(__file__).with_name("contexts.py"))
if _contexts_spec is None or _contexts_spec.loader is None:
    raise ValueError("missing declared Cargo context helper File")
contexts = importlib.util.module_from_spec(_contexts_spec)
_contexts_spec.loader.exec_module(contexts)

ROOT = contexts.ROOT
HERE = ROOT / "tools/bazel/rust/diagnostics/bolero"
FLAGS = ["--cfg", "merkur_fuzz", "--cfg", "merkur_libfuzzer", "--cfg", "fuzzing", "--cfg", "fuzzing_libfuzzer", "-Cpasses=sancov-module", "-Cllvm-args=-sanitizer-coverage-inline-8bit-counters", "-Cllvm-args=-sanitizer-coverage-level=4", "-Cllvm-args=-sanitizer-coverage-pc-table", "-Cllvm-args=-sanitizer-coverage-trace-compares", "-Zsanitizer=address"]


def paths(value, directory, destination):
    if isinstance(value, list):
        return [paths(item, directory, destination) for item in value]
    if isinstance(value, dict):
        return {name: os.path.relpath((directory / item).resolve(), destination) if name == "path" and isinstance(item, str) else paths(item, directory, destination) for name, item in value.items()}
    return value


def refresh(sdk):
    sdk.require_locks([ROOT / "Cargo.lock", ROOT / "tools/bolero/Cargo.lock"])
    env = sdk.environment(bootstrap=True)
    version = tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    base = sdk.command("cargo", version)
    host = sdk.host
    flags = FLAGS + (["-Cllvm-args=-sanitizer-coverage-stack-depth"] if "linux" in host else []) + (["-Ctarget-feature=+ssse3"] if host.startswith("x86_64") else [])
    env["RUSTFLAGS"] = " ".join(flags)
    env["BOLERO_FUZZER"] = "libfuzzer"
    production = tomllib.loads((ROOT / "Cargo.toml").read_text())
    targets = json.loads((ROOT / "tools/bolero/targets.json").read_text())
    diagnostic_sources = sorted(str(path.relative_to(ROOT)) for path in (ROOT / "tools/bolero").glob("*.rs"))
    HERE.mkdir(parents=True, exist_ok=True)
    workspace = {"workspace": {"resolver": "3", "members": [target["crate"] for target in targets], "lints": production["workspace"]["lints"]}, "patch": paths(production["patch"], ROOT, HERE), "profile": {"fuzz": {"inherits": "dev", "opt-level": 3, "codegen-units": 1, "debug-assertions": True, "overflow-checks": True}}}
    manifest = HERE / "Cargo.toml"
    manifest.write_text(contexts.toml_text(workspace) + "\n")
    (HERE / "Cargo.lock").write_bytes((ROOT / "tools/bolero/Cargo.lock").read_bytes())
    original_manifests = {}
    for target in targets:
        original = ROOT / "packages" / target["crate"] / "Cargo.toml"
        destination = HERE / target["crate"]
        data = paths(tomllib.loads(original.read_text()), original.parent, destination)
        inventory = json.loads((ROOT / "tools/bazel/rust/metadata.json").read_text())
        owning = next(package for package in inventory["packages"] if package.get("manifest") == str(original.relative_to(ROOT)))
        for kind in ["bin", "bench", "example"]:
            targets_by_name = {item["name"]: item for item in owning["targets"] if kind in item["kind"]}
            for item in data.get(kind, []):
                item["path"] = os.path.relpath(ROOT / targets_by_name[item["name"]]["source"], destination)
        data["package"].update(name=target["crate"] + "-fuzz", autotests=False)
        data["lib"] = {**data.get("lib", {}), "name": target["crate"].replace("-", "_"), "path": os.path.relpath(original.parent / "src/lib.rs", destination)}
        data.setdefault("dev-dependencies", {})["bolero"] = "=0.13.6"
        if "source" in target:
            data["test"] = [{"name": "fuzz", "path": os.path.relpath(ROOT / "tools/bolero" / target["source"], destination)}]
        destination.mkdir(exist_ok=True)
        (destination / "Cargo.toml").write_text(contexts.toml_text(data) + "\n")
        original_manifests[data["package"]["name"]] = str(original.relative_to(ROOT))
    raw = subprocess.run(base + ["metadata", "--format-version=1", "--offline", "--locked", "--manifest-path", str(manifest)], cwd=HERE, env=env, check=True, capture_output=True, text=True)
    raw = json.loads(raw.stdout)
    normalized = contexts.normalize(raw, manifest, manifest)
    ids = {}
    for package in normalized["packages"]:
        previous = package["id"]
        if package["name"] in original_manifests:
            package["id"] = "diagnostic:bolero:" + package["name"]
            package["manifest"] = original_manifests[package["name"]]
        ids[previous] = package["id"]
    normalized["members"] = [ids[name] for name in normalized["members"]]
    lookup = {(package["name"], package["version"], package["source"]): package["id"] for package in normalized["packages"]}
    raw_ids = {package["id"]: lookup[(package["name"], package["version"], package["source"])] for package in raw["packages"]}
    package_paths = {package["id"]: Path(package["manifest_path"]).parent for package in raw["packages"]}
    for target in targets:
        result = subprocess.run(base + ["test", "--unit-graph", "-Zunstable-options", "--profile", "fuzz", "--target", host, "--offline", "--locked", "--manifest-path", str(manifest), "-p", target["crate"] + "-fuzz"], cwd=HERE, env=env, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)
        graph = json.loads(result.stdout)
        if graph["version"] != 1:
            raise ValueError("unmodeled Bolero Cargo oracle format")
        graph["execution_host"] = host
        for unit in graph["units"]:
            original_id = unit["pkg_id"]
            unit["pkg_id"] = raw_ids[original_id]
            package = next(package for package in normalized["packages"] if package["id"] == unit["pkg_id"])
            source = Path(unit["target"]["src_path"])
            unit["target"]["src_path"] = str(source.resolve().relative_to(ROOT)) if package["source"] is None else str(source.relative_to(package_paths[original_id]))
            unit["rust_flags"] = flags if unit["platform"] is not None else []
            unit["compiler_env"] = {"BOLERO_FUZZER": "libfuzzer", **({"RUSTC_BOOTSTRAP": "1"} if unit["platform"] is not None else {})}
            unit["diagnostic_macro_inputs"] = diagnostic_sources if package["name"].endswith("-fuzz") else []
        inputs = {"Cargo.toml", "tools/bolero/Cargo.lock", "tools/bolero/targets.json", "rust-toolchain.toml", "tools/bazel/rust/bolero.py", "tools/bazel/rust/contexts.py", "tools/bazel/rust/acquisition_sdk.py"}
        inputs.update(diagnostic_sources)
        inputs.update(package["manifest"] for package in normalized["packages"] if "manifest" in package)
        generated = list(HERE.glob("*/Cargo.toml")) + [manifest, HERE / "Cargo.lock"]
        document = {"package": "bolero:" + target["crate"], "mode": "bolero", "platform": "native", "inputs": {path: contexts.digest(ROOT / path) for path in sorted(inputs)}, "generated_inputs": {str(path.relative_to(HERE)): contexts.digest(path) for path in generated}, "contexts": {host: normalized}, "unit_graphs": {host: {"fuzz": graph}}}
        (HERE / (target["crate"] + ".json")).write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")


def main():
    global ROOT, HERE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--sdk-descriptor", type=Path)
    parser.add_argument("--source-root", type=Path)
    args = parser.parse_args()
    if args.refresh:
        if args.sdk_descriptor is None or args.source_root is None:
            parser.error("--refresh requires --sdk-descriptor and --source-root; ambient acquisition tools and checkout discovery are forbidden")
        ROOT = args.source_root.resolve(strict=True)
        contexts.ROOT = ROOT
        HERE = ROOT / "tools/bazel/rust/diagnostics/bolero"
        refresh(contexts.NativeCargoSdk.load(args.sdk_descriptor))
    expected = {target["crate"] + ".json" for target in json.loads((ROOT / "tools/bolero/targets.json").read_text())}
    if {path.name for path in HERE.glob("*.json")} != expected:
        raise ValueError("missing or unexpected independent Bolero compiler roots")
    if (HERE / "Cargo.lock").read_bytes() != (ROOT / "tools/bolero/Cargo.lock").read_bytes():
        raise ValueError("Bolero resolution differs from its retained independent lock")
    for name in expected:
        document = json.loads((HERE / name).read_text())
        for path, digest in document["inputs"].items():
            if contexts.digest(ROOT / path) != digest:
                raise ValueError("stale Bolero resolution input: " + path)
        for path, digest in document["generated_inputs"].items():
            if contexts.digest(HERE / path) != digest:
                raise ValueError("changed Bolero resolution manifest: " + path)
    targets = json.loads((ROOT / "tools/bolero/targets.json").read_text())
    print(f"Independent Bolero graph checked: {len(targets)} locked compiler roots, {sum(len(target['tests']) for target in targets)} campaign selectors")


if __name__ == "__main__":
    main()
