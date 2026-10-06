"""Relate stock native std metadata to the original configured Cargo units.

This captures dependency selection, not byte equivalence with rebuilt std.
The caller separately proves original SDK archive/member custody. Metadata
comes from the original separate .rmeta Files, never archive-name guesses.
"""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import stat
import subprocess
import tarfile

VERSION = "1.97.1"
SOURCE_SHA256 = "0ed06fdaffd4722a7702e0b4eebfafc897ab8f513e8e1b247cdd7e5c6df6ded2"
SOURCE_PREFIX = "rustc-1.97.1-src/"
HOSTS = {"aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"}
WASM = "wasm32-unknown-unknown"
TARGETS = HOSTS | {WASM}
# Original bootstrap std_features/std_cargo + the four distribution jobs:
# panic-unwind/backtrace defaults, enabled profiler, optimized compiler-rt.
FEATURES = ["backtrace", "compiler-builtins-c", "panic-unwind", "profiler"]
RECIPE_INPUTS = [
    "src/bootstrap/src/lib.rs",
    "src/bootstrap/src/core/build_steps/compile.rs",
    "src/bootstrap/src/core/builder/cargo.rs",
    "src/bootstrap/src/core/config/config.rs",
    "src/ci/run.sh",
    "src/ci/github-actions/jobs.yml",
    "src/ci/docker/host-aarch64/dist-aarch64-linux/Dockerfile",
    "src/ci/docker/host-x86_64/dist-x86_64-linux/Dockerfile",
    "library/Cargo.toml", "library/Cargo.lock", ".cargo/config.toml",
]
WASM_FEATURES = ["backtrace", "compiler-builtins-c", "panic-unwind"]


def features(target):
    if target not in TARGETS:
        raise ValueError("Only original native or wasm32-unknown-unknown distribution targets are supported")
    return WASM_FEATURES if target == WASM else FEATURES


def recipe_inputs(target):
    features(target)
    if target == WASM:
        # Original dist-various-2 enables optimized compiler builtins through
        # run.sh, retains backtrace/panic-unwind defaults, and leaves profiler off.
        return [name for name in RECIPE_INPUTS if name not in {
            "src/ci/docker/host-aarch64/dist-aarch64-linux/Dockerfile",
            "src/ci/docker/host-x86_64/dist-x86_64-linux/Dockerfile",
        }] + [
            "src/ci/docker/host-x86_64/dist-various-2/Dockerfile",
        ]
    return RECIPE_INPUTS


def compiler_host(sdk, target, host):
    if host is None and target == WASM:
        raise ValueError("WASM stock graph requires its separately explicit original compiler host")
    if host is not None and (host not in HOSTS or host != sdk.host):
        raise ValueError("Stock graph compiler host differs from its declared original SDK")
    return sdk.host


IDENTITY = re.compile(r"([A-Za-z_][A-Za-z_0-9]*)-([0-9a-f]{16})\Z")
HASH = r"[0-9a-f]{1,32}"


def fact(path):
    path = Path(path)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("Stock graph input must be an ordinary File")
    body = path.read_bytes()
    return {"path": str(path), "size": len(body), "sha256": hashlib.sha256(body).hexdigest()}


def checked_fact(value):
    if not isinstance(value, dict) or set(value) != {"path", "size", "sha256"} or fact(value["path"]) != value:
        raise ValueError("Changed original stock graph File")
    return Path(value["path"])


def metadata_root(body):
    """Decode the exact original rustc_metadata list_crate_metadata root grammar."""
    lines = body.splitlines()
    if not lines or lines[0] != "Crate info:" or lines.count("=External Dependencies=") != 1:
        raise ValueError("Incomplete original compiler metadata root")
    fields = {}
    for key in ["name", "hash", "triple", "edition"]:
        matches = [line[len(key) + 1:] for line in lines if line.startswith(key + " ")]
        if len(matches) != 1:
            raise ValueError("Missing or repeated original metadata field: " + key)
        fields[key] = matches[0]
    identity = IDENTITY.fullmatch(fields["name"])
    pinned_hash = re.fullmatch("(" + HASH + r") stable_crate_id StableCrateId\([0-9]+\)", fields["hash"])
    if not identity or not pinned_hash or fields["triple"] not in TARGETS or fields["edition"] not in {"2015", "2018", "2021", "2024"}:
        raise ValueError("Unsupported original metadata identity or target")
    dependencies = []
    for line in lines[lines.index("=External Dependencies=") + 1:]:
        if not line:
            continue
        match = re.fullmatch(r"([0-9]+) (\S+) hash (" + HASH + r") host_hash (None|Some\([^)]*\)) kind (\S+) (private|public)(?: linkage .+)?", line)
        if not match or not IDENTITY.fullmatch(match[2]) or int(match[1]) != len(dependencies) + 1:
            raise ValueError("Invalid original metadata dependency record")
        dependencies.append({"identity": match[2], "hash": match[3], "host_hash": match[4], "kind": match[5], "privacy": match[6]})
    if len({dependency["identity"] for dependency in dependencies}) != len(dependencies):
        raise ValueError("Repeated original metadata dependency")
    return {"identity": fields["name"], "crate": identity[1], "hash": pinned_hash[1],
            "target": fields["triple"], "edition": fields["edition"], "dependencies": dependencies}


def relation(graph, metadata, target):
    if target not in TARGETS or graph.get("version") != 1 or not isinstance(graph.get("units"), list):
        raise ValueError("Original configured Cargo unit graph required")
    units = graph["units"]
    roots = graph.get("roots")
    if not isinstance(roots, list) or len(roots) != 1 or type(roots[0]) is not int or not 0 <= roots[0] < len(units):
        raise ValueError("Original configured sysroot unit required")
    root = units[roots[0]]
    if root.get("target", {}).get("name") != "sysroot" or root.get("platform") != target or root.get("features") != sorted(features(target) + ["default"]) or root.get("profile", {}).get("name") != "dist":
        raise ValueError("Original target distribution recipe required")
    indexes = {}
    for index, unit in enumerate(units):
        if not isinstance(unit, dict) or not isinstance(unit.get("dependencies"), list):
            raise ValueError("Incomplete configured Cargo unit")
        for dependency in unit["dependencies"]:
            if type(dependency.get("index")) is not int or not 0 <= dependency["index"] < len(units):
                raise ValueError("Invalid configured Cargo dependency index")
        declaration = unit.get("target", {})
        kinds = declaration.get("kind")
        if unit.get("mode") == "build" and unit.get("platform") == target and isinstance(kinds, list) and kinds and set(kinds) <= {"lib", "rlib", "dylib"}:
            key = (declaration.get("name"), declaration.get("edition"))
            if key in indexes:
                raise ValueError("Ambiguous configured source unit for stock crate")
            if not isinstance(unit.get("pkg_id"), str) or not unit["pkg_id"]:
                raise ValueError("Original Cargo source identity is missing")
            indexes[key] = index
    identities = {}
    selected = {}
    for record in metadata:
        if record["target"] != target or record["identity"] in identities:
            raise ValueError("Foreign or duplicate original stock metadata")
        key = (record["crate"], record["edition"])
        index = indexes.get(key)
        if index is None:
            raise ValueError("Stock compiler crate has no configured original Cargo unit")
        identities[record["identity"]] = record
        if index in selected:
            raise ValueError("Multiple stock identities map to one configured source unit")
        selected[index] = record
    if set(selected) != set(indexes.values()):
        raise ValueError("Stock metadata does not cover the complete configured target libraries")
    result = []
    for index, record in sorted(selected.items()):
        closure = set()
        pending = [index]
        while pending:
            member = pending.pop()
            if member in closure:
                continue
            closure.add(member)
            pending.extend(dependency["index"] for dependency in units[member]["dependencies"])
        for dependency in record["dependencies"]:
            upstream = identities.get(dependency["identity"])
            if upstream is None or upstream["hash"] != dependency["hash"]:
                raise ValueError("Stock metadata dependency hash has no exact original SDK crate")
            upstream_index = indexes[(upstream["crate"], upstream["edition"])]
            if upstream_index not in closure:
                raise ValueError("Stock metadata dependency is outside its configured Cargo closure")
        result.append({"identity": record["identity"], "unit": index,
                       "pkg_id": units[index]["pkg_id"], "closure": sorted(closure)})
    return result


def original_sources(source_root, archive, paths):
    archive_fact = fact(archive)
    if archive_fact["sha256"] != SOURCE_SHA256:
        raise ValueError("Original Rust1.97.1 source archive required")
    wanted = {}
    for path in paths:
        relative = Path(path).relative_to(source_root).as_posix()
        wanted[SOURCE_PREFIX + relative] = (relative, Path(path))
    result = []
    with tarfile.open(archive, "r|xz") as source:
        for member in source:
            selected = wanted.pop(member.name, None)
            if selected is None:
                continue
            relative, path = selected
            if not member.isfile() or source.extractfile(member).read() != path.read_bytes():
                raise ValueError("Configured graph source differs from original archive: " + relative)
            actual = fact(path)
            result.append({**actual, "path": relative})
    if wanted:
        raise ValueError("Graph source absent from pinned archive")
    return archive_fact, sorted(result, key=lambda value: value["path"])



def original_source_namespace(source_root, descriptor):
    # Called only after the existing typed SDK descriptor/provenance checks.
    # The SDK's ordinary declared output File anchors the original execution
    # namespace; a matching member suffix alone cannot authorize another Tree.
    inputs = (source_root, descriptor)
    source_root, descriptor = (Path(value) for value in inputs)
    for raw, value in zip(inputs, (source_root, descriptor)):
        if value.is_absolute() or str(value) != str(raw) or "\\" in str(raw) or not value.parts or any(part in {".", ".."} for part in value.parts):
            raise ValueError("Exact original relative declared input paths required")
    physical = descriptor.resolve(strict=True)
    fact(physical)
    namespace = physical.parents[len(descriptor.parts) - 1]
    if namespace / descriptor != physical:
        raise ValueError("SDK descriptor leaves its exact declared output namespace")
    return namespace / source_root


def original_source_root(source_root, archive, names, authority=None):
    # Authenticate original archive bytes before unwrapping engine carriers.
    # Only the caller's exact original Tree namespace authorizes leaf carriers;
    # ordinary standalone source inputs retain their original strict semantics.
    archive_fact = fact(archive)
    if archive_fact["sha256"] != SOURCE_SHA256:
        raise ValueError("Original Rust1.97.1 source archive required")
    source_root = Path(source_root).resolve(strict=True)
    original = source_root if authority is None else Path(authority).absolute()
    if original.resolve(strict=True) != original or not stat.S_ISDIR(original.lstat().st_mode):
        raise ValueError("Original source Tree authority must be an ordinary directory")
    wanted = {SOURCE_PREFIX + name: name for name in names}
    with tarfile.open(archive, "r|xz") as source:
        for member in source:
            name = wanted.pop(member.name, None)
            if name is None:
                continue
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Original source member leaves its declared Tree")
            presented = source_root / relative
            if not member.isfile() or source.extractfile(member).read() != presented.read_bytes():
                raise ValueError("Configured graph source differs from original archive: " + name)
            physical = presented.resolve(strict=True)
            if original / relative != physical:
                raise ValueError("Original source member leaves its exact declared Tree authority")
            directory = original
            for part in relative.parts[:-1]:
                directory /= part
                if not stat.S_ISDIR(directory.lstat().st_mode):
                    raise ValueError("Original source Tree contains an aliased directory")
            fact(physical)
    if wanted:
        raise ValueError("Graph source absent from pinned archive")
    return original


def capture_commands(sdk, source_root, target):
    selected_features = features(target)
    manifest = source_root / "library/sysroot/Cargo.toml"
    common = ["--offline", "--locked", "--manifest-path", str(manifest), "--features", ",".join(selected_features)]
    return {
        "units": sdk.command("cargo", VERSION) + ["build", "--unit-graph", "-Zunstable-options", "--profile=dist", "--target=" + target] + common,
        "packages": sdk.command("cargo", VERSION) + ["metadata", "--format-version=1"] + common,
    }


def capture(source_root, archive, sdk, metadata_files, target, output, host=None, *, source_authority=None):
    selected_features = features(target)
    selected_recipe_inputs = recipe_inputs(target)
    actual_host = compiler_host(sdk, target, host)
    source_root = original_source_root(source_root, archive, selected_recipe_inputs, source_authority)
    sources = [source_root / name for name in selected_recipe_inputs]
    inputs = [checked_fact(value) for value in metadata_files]
    if len(set(inputs)) != len(inputs) or not inputs or any(path.suffix != ".rmeta" for path in inputs):
        raise ValueError("Complete unique original separate metadata Files required")
    output = Path(output)
    output.mkdir()
    environment = sdk.environment(bootstrap=True)
    # This is original bootstrap's metadata introspection environment only;
    # no Rust build action or pipelining feature receives RUSTC_BOOTSTRAP.
    commands = capture_commands(sdk, source_root, target)
    raw = {}
    for name, command in commands.items():
        process = subprocess.run(command, cwd=source_root, env=environment, check=True, capture_output=True)
        (output / (name + ".json")).write_bytes(process.stdout)
        raw[name] = json.loads(process.stdout)
    records = []
    for index, (value, path) in enumerate(zip(metadata_files, inputs)):
        command = sdk.command("rustc", VERSION) + ["--target=" + target, "-Zls=root", str(path)]
        process = subprocess.run(command, cwd=output, env=environment, check=True, capture_output=True)
        (output / ("metadata-" + str(index) + ".txt")).write_bytes(process.stdout)
        record = metadata_root(process.stdout.decode("utf-8"))
        records.append({**record, "file": value})
    associations = relation(raw["units"], records, target)
    ids = {unit["pkg_id"] for unit in raw["units"]["units"]}
    packages = {package["id"]: package for package in raw["packages"]["packages"]}
    if not ids <= packages.keys():
        raise ValueError("Configured package source identity missing from original Cargo metadata")
    selected_packages = [packages[package] for package in sorted(ids)]
    for package in selected_packages:
        sources.append(Path(package["manifest_path"]))
    sources.extend(Path(unit["target"]["src_path"]) for unit in raw["units"]["units"])
    archive_fact, source_facts = original_sources(source_root, archive, sorted(set(sources)))
    for value in metadata_files:
        checked_fact(value)
    result = {"target": target, "version": VERSION, "features": selected_features, "profile": "dist",
              "source_archive": archive_fact, "source_root": str(source_root),
              "source_inputs": source_facts, "compiler": sdk.identities,
              "unit_graph": raw["units"], "packages": selected_packages,
              "metadata": records, "associations": associations,
              "qualification": "Configured original-source dependency relation; no rebuilt std byte equivalence claimed"}
    if target == WASM:
        result["compiler_host"] = actual_host
    (output / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
    (output / "graph.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source-root", "source-archive", "sdk", "sdk-resolver", "metadata-files", "target", "output"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--compiler-host")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("declared_sdk", args.sdk_resolver)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sdk = module.NativeCargoSdk.load(args.sdk)
    try:
        capture(args.source_root, args.source_archive, sdk, json.loads(Path(args.metadata_files).read_text()), args.target, args.output, args.compiler_host)
    finally:
        sdk.close()
