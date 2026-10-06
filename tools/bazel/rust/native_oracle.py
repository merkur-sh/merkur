#!/usr/bin/env python3
"""Capture the exact native authenticated browser Session example compiler graph."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tomllib

_contexts_spec = importlib.util.spec_from_file_location("contexts", Path(__file__).with_name("contexts.py"))
if _contexts_spec is None or _contexts_spec.loader is None:
    raise ValueError("missing declared Cargo context helper File")
contexts = importlib.util.module_from_spec(_contexts_spec)
_contexts_spec.loader.exec_module(contexts)

ROOT = contexts.ROOT
DEST = ROOT / "tools/bazel/rust/diagnostics/oracles/browser-session-oracle.json"


def refresh(sdk):
    sdk.require_locks([ROOT / "Cargo.lock"])
    env = sdk.environment(bootstrap=True)
    version = tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    base = sdk.command("cargo", version)
    host = sdk.host
    raw = contexts.resolve(ROOT / "Cargo.toml", host, version, False, sdk=sdk)
    normalized = contexts.normalize(raw, ROOT / "Cargo.toml", ROOT / "Cargo.toml")
    command = base + ["build", "--locked", "--offline", "--unit-graph", "-Zunstable-options", "-p", "merkur-client", "--example", "browser_session_oracle"]
    graph = json.loads(subprocess.run(command, cwd=ROOT, env=env, check=True, capture_output=True, text=True).stdout)
    if graph["version"] != 1 or len(graph["roots"]) != 1:
        raise ValueError("unmodeled native Session oracle compiler inventory")
    lookup = {(package["name"], package["version"], package["source"]): package["id"] for package in normalized["packages"]}
    ids = {package["id"]: lookup[(package["name"], package["version"], package["source"])] for package in raw["packages"]}
    package_paths = {package["id"]: Path(package["manifest_path"]).parent for package in raw["packages"]}
    flags = contexts.effective_target_flags(ROOT, host, version, env, sdk=sdk)["rustflags"]
    for unit in graph["units"]:
        original = unit["pkg_id"]
        unit["pkg_id"] = ids[original]
        source = Path(unit["target"]["src_path"])
        unit["target"]["src_path"] = str(source.resolve().relative_to(ROOT)) if unit["pkg_id"].startswith("workspace:") else str(source.relative_to(package_paths[original]))
        unit["rust_flags"] = flags
    root = graph["units"][graph["roots"][0]]
    if root["target"]["name"] != "browser_session_oracle" or root["target"]["crate_types"] != ["bin"] or root["mode"] != "build":
        raise ValueError("incorrect authenticated Session oracle compiler root")
    graph["execution_host"] = host
    inputs = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "tools/bazel/rust/native_oracle.py", "tools/bazel/rust/contexts.py", "tools/bazel/rust/acquisition_sdk.py"}
    inputs.update(package["manifest"] for package in normalized["packages"] if "manifest" in package)
    document = {"package": "browser-session-oracle", "mode": "build", "platform": "native", "inputs": {path: contexts.digest(ROOT / path) for path in sorted(inputs)}, "contexts": {host: normalized}, "unit_graphs": {host: {"dev": graph}}}
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")


def main():
    global ROOT, DEST
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
        DEST = ROOT / "tools/bazel/rust/diagnostics/oracles/browser-session-oracle.json"
        refresh(contexts.NativeCargoSdk.load(args.sdk_descriptor))
    if {path.name for path in DEST.parent.glob("*.json")} != {DEST.name}:
        raise ValueError("missing or unexpected native Session compiler context")
    document = json.loads(DEST.read_text())
    for path, digest in document["inputs"].items():
        if contexts.digest(ROOT / path) != digest:
            raise ValueError("stale native Session oracle input: " + path)
    print("Exact native browser Session oracle compiler context checked")


if __name__ == "__main__":
    main()
