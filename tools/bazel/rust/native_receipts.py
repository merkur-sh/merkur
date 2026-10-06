#!/usr/bin/env python3
"""Validate and retain actual native-host FEC Cargo introspection receipts.

This bounded importer admits only the two Linux hosts and the independent build
and test roots actually acquired by acquire/rules.bzl. It does not qualify a
product compile, filesystem identity, worker, or shipping artifact.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
DIRECTORY = Path(__file__).resolve().parent / "native_contexts"
HOSTS = {"x86_64-unknown-linux-gnu": "x64", "aarch64-unknown-linux-gnu": "arm64"}
EXPECTED = {f"{host}/{mode}.json" for host in HOSTS for mode in ["build", "test"]}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def same_json(left, right):
    # Python equality equates booleans with integers; compiler schemas do not.
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def declared_sources(mode):
    """Exact regular File inventory of acquire/rules.bzl's package_data groups."""
    names = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "tools/bazel/rust/metadata.json"}
    names.update(f"tools/bazel/rust/contexts/merkur-fec/{mode}/native/{name}" for name in ["Cargo.toml", "Cargo.lock", "metadata.json"])
    packages = ["merkur-fec"] + [name + "-patch" for name in ["alacritty-terminal", "fontdue", "quinn", "quinn-proto", "vte", "wtransport"]]
    for package in packages:
        directory = ROOT / "packages" / package
        for filename in directory.rglob("*"):
            relative = filename.relative_to(directory)
            if not filename.is_file() or relative.parts[0] in {"node_modules", "target", "dist", "pkg", "test-results", "__pycache__"} or any(part.startswith(".") or part == "__pycache__" for part in relative.parts) or filename.suffix == ".pyc" or relative.as_posix() in {"BUILD.bazel", "Cargo.lock"}:
                continue
            # Bazel globs stop at nested package boundaries.
            if any((parent / "BUILD.bazel").is_file() or (parent / "BUILD").is_file() for parent in filename.parents if parent != directory and parent.is_relative_to(directory)):
                continue
            names.add(filename.relative_to(ROOT).as_posix())
    return names


def validate(document):
    host, mode = document["execution_host"], document["mode"]
    if host not in HOSTS or mode not in ["build", "test"] or document["package"] != "merkur-fec" or document["platform"] != "native":
        raise ValueError("unsupported native-host receipt root")
    if document["native_runtime"] != {"bun": "1.4.2", "os": "linux", "arch": HOSTS[host]}:
        raise ValueError("native execution identity does not match the selected host")
    identity = document["rustc_identity"].splitlines()
    if not document["cargo_identity"].startswith("cargo 1.97.1 ") or not identity[0].startswith("rustc 1.97.1 ") or f"host: {host}" not in identity or "commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452" not in identity or "LLVM version: 22.1.6" not in identity:
        raise ValueError("receipt compiler identity differs from the pinned native toolchain")
    facts = document["source_facts"]
    names = [fact["path"] for fact in facts]
    if len(names) != len(set(names)) or set(names) != declared_sources(mode) or document["inputs"] != {fact["path"]: fact["sha256"] for fact in facts}:
        raise ValueError("source facts have incomplete or duplicate byte authority")
    for fact in facts:
        member = Path(fact["path"])
        if member.is_absolute() or ".." in member.parts:
            raise ValueError("source fact escaped the declared workspace")
        data = (ROOT / member).read_bytes()
        if type(fact["size"]) is not int or digest(data) != fact["sha256"] or len(data) != fact["size"]:
            raise ValueError("stale native acquisition source fact: " + str(member))
    sdk = document["sdk_facts"]
    pins = json.loads((DIRECTORY.parent / "native_sdk_pins.json").read_text())[host]
    sdk_members = {}
    for fact in sdk:
        prefix, separator, member = fact["path"].partition("/rust_toolchain/")
        if not separator or member in sdk_members or f"__{host}__stable_tools/" not in prefix + "/":
            raise ValueError("native SDK member has another repository/host identity")
        sdk_members[member] = {"size": fact["size"], "sha256": fact["sha256"]}
    if not same_json(sdk_members, pins["files"]):
        raise ValueError("native SDK membership/bytes differ from the verified pinned distribution")
    if document["executor_image"] != pins["executor_image"]:
        raise ValueError("native receipt ran outside the admitted executor image")
    if document["resolution_cfg"] != pins["resolution_cfg"]:
        raise ValueError("native default compiler cfg differs from its pinned host")
    scoped = ROOT / "tools/bazel/rust/contexts/merkur-fec" / mode / "native"
    for name in ["Cargo.toml", "Cargo.lock"]:
        if digest((scoped / name).read_bytes()) != document["generated_inputs"][name]:
            raise ValueError("native root no longer matches its scoped manifest/lock authority")
    oracle = json.loads((scoped / "metadata.json").read_text())
    if set(document["contexts"]) != {host} or not same_json(document["contexts"][host], oracle["contexts"][host]):
        raise ValueError("native FEC effective manifest/resolver facts diverge from the locked root")
    profiles = {"dev", "release"} if mode == "build" else {"test"}
    if set(document["unit_graphs"]) != {host} or set(document["unit_graphs"][host]) != profiles or set(document["effective_cfg"]) != profiles:
        raise ValueError("native receipt has an incomplete profile inventory")
    for profile, graph in document["unit_graphs"][host].items():
        expected = oracle["unit_graphs"][host][profile]
        normalized = copy.deepcopy(graph)
        if normalized["execution_host"] != host:
            raise ValueError("compiler graph masquerades as a different native host")
        normalized["execution_host"] = expected["execution_host"]
        for unit in normalized["units"]:
            if unit["platform"] is not None:
                raise ValueError("actual native Cargo graph must retain its implicit native target")
            unit["platform"] = host
        if not same_json(normalized, expected):
            raise ValueError("native compiler units differ from the bounded FEC locked oracle")
        cfg = document["effective_cfg"][profile]
        pinned_cfg = pins["effective_cfg"]["dev" if profile == "test" else profile]
        if cfg != pinned_cfg:
            raise ValueError("native effective compiler cfg differs from its exact profile/flag pins")
        if ("debug_assertions" in cfg) != graph["units"][0]["profile"]["debug_assertions"] or f'target_arch="{"x86_64" if HOSTS[host] == "x64" else "aarch64"}"' not in cfg or 'target_os="linux"' not in cfg:
            raise ValueError("native compiler cfg differs from its captured profile/host")
    return f"{host}/{mode}.json"


def load():
    index_path = DIRECTORY / "index.json"
    index = json.loads(index_path.read_text())
    if set(index) != EXPECTED or {str(path.relative_to(DIRECTORY)) for path in DIRECTORY.glob("*/*.json")} != EXPECTED:
        raise ValueError("missing or extra native-host context receipts")
    result = []
    for name, expected in sorted(index.items()):
        filename = DIRECTORY / name
        if digest(filename.read_bytes()) != expected or validate(json.loads(filename.read_text())) != name:
            raise ValueError("native receipt filename/hash authority mismatch")
        result.append(filename)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, action="append")
    parser.add_argument("--formatter", type=Path)
    args = parser.parse_args()
    if args.receipt:
        if args.formatter is None:
            raise ValueError("import requires the explicit pinned Biome2.5.10 formatter")
        formatter = args.formatter.resolve(strict=True)
        version = subprocess.run([str(formatter), "--version"], capture_output=True, text=True, check=True).stdout.strip()
        if version != "Version: 2.5.10":
            raise ValueError("native receipt formatter differs from pinned Biome2.5.10")
        output = {}
        for filename in args.receipt:
            data = filename.read_bytes()
            name = validate(json.loads(data))
            if name in output:
                raise ValueError("duplicate native receipt root")
            output[name] = subprocess.run([str(formatter), "format", "--stdin-file-path=tools/bazel/rust/native_contexts/" + name], input=data, capture_output=True, check=True, cwd=ROOT).stdout
        if set(output) != EXPECTED:
            raise ValueError("import requires all four native FEC host/mode receipts")
        for name, data in output.items():
            filename = DIRECTORY / name
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_bytes(data)
        (DIRECTORY / "index.json").write_text(json.dumps({name: digest(data) for name, data in sorted(output.items())}, sort_keys=True, indent=2) + "\n")
    print(f"Native FEC host receipts checked: {len(load())} complete host/mode contexts")


if __name__ == "__main__":
    main()
