#!/usr/bin/env python3
"""Capture portable locked all-features policy graphs without building any crate."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / "tools/bazel/rust/policy_snapshots"
GRAPHS = {"production": "Cargo.toml", "bolero": "tools/bazel/rust/diagnostics/bolero/Cargo.toml", "ownership": "tools/ownership-proofs/Cargo.toml", "aya": "tools/edge-kernel-profile/Cargo.toml"}
INDEX_RECORDS = {}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def original_locks():
    locks = {name: ROOT / Path(manifest).with_name("Cargo.lock") for name, manifest in GRAPHS.items()}
    # The diagnostic manifest is generated from this original lock, not an
    # independent source authority. Both lock files remain inputs below.
    locks["bolero"] = ROOT / "tools/bolero/Cargo.lock"
    return locks


def require_graph_locks(sdk):
    locks = original_locks()
    sdk.require_locks(list(locks.values()))
    generated = ROOT / Path(GRAPHS["bolero"]).with_name("Cargo.lock")
    def external_packages(path):
        return {
            (package["source"], package["name"], package["version"], package.get("checksum"))
            for package in tomllib.loads(path.read_text())["package"] if "source" in package
        }
    # Cargo prunes unused packages from the generated diagnostic workspace. Its
    # retained registry identities must still come from the original lock.
    if not external_packages(generated) <= external_packages(locks["bolero"]):
        raise ValueError("policy diagnostic lock exceeds its original Bolero lock authority")


def metadata(sdk, version, manifest):
    result = subprocess.run(
        sdk.command("cargo", version) + ["metadata", "--all-features", "--offline", "--locked", "--format-version=1", "--manifest-path", str(ROOT / manifest)],
        cwd=ROOT, env=sdk.environment(), check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)


def registry_shard(name):
    lower = name.lower()
    return "1/" + lower if len(lower) == 1 else "2/" + lower if len(lower) == 2 else "3/" + lower[0] + "/" + lower if len(lower) == 3 else lower[:2] + "/" + lower[2:4] + "/" + lower


def acquire_index(name):
    url = "https://index.crates.io/" + registry_shard(name)
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=60) as response:
        records = [json.loads(line) for line in response.read().splitlines()]
    if not records or any(record["name"] != name for record in records):
        raise ValueError("unexpected registry index acquisition: " + name)
    return name, records


def index_features(raw, lock):
    """Acquire current index evidence and bind archive checksums to the lock."""
    locked = {(p["name"], p["version"]): p.get("checksum") for p in lock["package"] if p.get("source") == "registry+https://github.com/rust-lang/crates.io-index"}
    facts = []
    missing = {package["name"] for package in raw["packages"] if package["source"] == "registry+https://github.com/rust-lang/crates.io-index" and package["name"] not in INDEX_RECORDS}
    with ThreadPoolExecutor(max_workers=8) as workers:
        INDEX_RECORDS.update(workers.map(acquire_index, sorted(missing)))
    for package in raw["packages"]:
        if package["source"] != "registry+https://github.com/rust-lang/crates.io-index":
            continue
        name, version = package["name"], package["version"]
        records = INDEX_RECORDS[name]
        selected = [r for r in records if r["vers"] == version and r["name"] == name]
        if len(selected) != 1 or selected[0]["cksum"] != locked[(name, version)]:
            raise ValueError("registry index/archive lock disagreement: " + name + " " + version)
        record = selected[0]
        features = dict(record["features"])
        features.update(record.get("features2", {}))
        facts.append({"name": name, "version": version, "checksum": record["cksum"], "features": features, "record": record, "record_sha256": hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":")).encode()).hexdigest()})
    return sorted(facts, key=lambda fact: (fact["name"], fact["version"]))


def refresh(sdk):
    version = tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    require_graph_locks(sdk)
    sdk.command("cargo", version)
    if digest(ROOT / "tools/bazel/rust/policy_snapshots.py") != digest(Path(__file__)):
        raise ValueError("policy source snapshot differs from the actual declared generator File")
    DEST.mkdir(exist_ok=True)
    documents = {}
    for name, manifest in GRAPHS.items():
        raw = metadata(sdk, version, manifest)
        raw["merkur_registry_index"] = index_features(raw, tomllib.loads((ROOT / Path(manifest).with_name("Cargo.lock")).read_text()))
        inputs = {"Cargo.toml", "rust-toolchain.toml", "tools/bazel/rust/policy_snapshots.py", manifest, str(Path(manifest).with_name("Cargo.lock"))}
        inputs.add(str(original_locks()[name].relative_to(ROOT)))
        registry = set()
        for package in raw["packages"]:
            path = Path(package["manifest_path"])
            if package["source"] is None:
                inputs.add(str(path.relative_to(ROOT)))
            else:
                registry.add(str(path.parent.parent))
        def portable(value):
            if isinstance(value, dict):
                return {key: portable(item) for key, item in value.items()}
            if isinstance(value, list):
                return [portable(item) for item in value]
            if isinstance(value, str):
                value = value.replace(str(ROOT), "__MERKUR_WORKSPACE__")
                for directory in sorted(registry):
                    value = value.replace(directory, "__MERKUR_REGISTRY__")
            return value
        document = {"inputs": {path: digest(ROOT / path) for path in sorted(inputs)}, "metadata": portable(raw)}
        documents[name] = document
    for name, document in documents.items():
        (DEST / (name + ".json")).write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    render_targets(True)
    print("Current registry index evidence acquired: " + str(len(INDEX_RECORDS)) + " package names")


def render_targets(refresh=False):
    lines = ['# Generated by policy_snapshots.py. DO NOT EDIT.\n', 'load(":policy.bzl", "dependency_policy_graph_test")\n\n', 'def declare_policy_graphs():\n']
    for name in GRAPHS:
        metadata = json.loads((DEST / (name + ".json")).read_text())["metadata"]
        local = {"//tools/bazel/rust:policy_root_inputs"}
        registry = {}
        for package in metadata["packages"]:
            if package["source"] is None:
                path = Path(package["manifest_path"].removeprefix("__MERKUR_WORKSPACE__/"))
                directory = path.parent
                if str(directory).startswith("tools/bazel/rust/"):
                    local.add("//tools/bazel/rust:policy_bolero_generated_inputs")
                else:
                    local.add("//" + str(directory) + ":verification_inputs")
                for target in package["targets"]:
                    source = (ROOT / target["src_path"].removeprefix("__MERKUR_WORKSPACE__/")).resolve().relative_to(ROOT)
                    owner = source.parent
                    while owner != Path(".") and not (ROOT / owner / "BUILD.bazel").is_file():
                        owner = owner.parent
                    if owner == Path("."):
                        raise ValueError("policy target source has no declared owning package: " + str(source))
                    local.add("//" + str(owner) + ":verification_inputs")
            else:
                repository = "merkur_rust_source_" + (package["name"] + "_" + package["version"]).replace("-", "_").replace(".", "_").replace("+", "_")
                registry[package["name"] + "-" + package["version"]] = "@" + repository + "//:package_data"
        names = sorted(registry)
        lines.append('    dependency_policy_graph_test(name = "policy_graph__' + name + '", graph = ' + json.dumps(name) + ', local_sources = ' + json.dumps(sorted(local)) + ', registry_sources = ' + json.dumps([registry[n] for n in names]) + ', registry_names = ' + json.dumps(names) + ', snapshot = ":policy_snapshots/' + name + '.json", tags = ["manual", "external", "no-cache", "no-remote"])\n')
    lines.append('    native.test_suite(name = "dependency_policy_graphs", tests = ' + json.dumps([":policy_graph__" + name for name in GRAPHS]) + ', tags = ["manual"])\n')
    destination = ROOT / "tools/bazel/rust/policy_graphs.bzl"
    if refresh:
        destination.write_text("".join(lines))
    elif destination.read_text() != "".join(lines):
        raise ValueError("generated policy targets differ from declared graph source inventory")


def main():
    global ROOT, DEST
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--sdk-descriptor", type=Path)
    parser.add_argument("--sdk-resolver", type=Path)
    parser.add_argument("--source-root", type=Path)
    args = parser.parse_args()
    if args.refresh:
        if args.sdk_descriptor is None or args.sdk_resolver is None or args.source_root is None:
            parser.error("--refresh requires --sdk-descriptor, --sdk-resolver and --source-root; ambient tools and checkout discovery are forbidden")
        ROOT = args.source_root.resolve(strict=True)
        DEST = ROOT / "tools/bazel/rust/policy_snapshots"
        spec = importlib.util.spec_from_file_location("declared_policy_sdk", args.sdk_resolver)
        if spec is None or spec.loader is None:
            raise ValueError("missing declared native acquisition SDK resolver File")
        resolver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(resolver)
        sdk = resolver.NativeCargoSdk.load(args.sdk_descriptor)
        try:
            refresh(sdk)
        finally:
            sdk.close()
    if {p.name for p in DEST.glob("*.json")} != {name + ".json" for name in GRAPHS}:
        raise ValueError("missing or unexpected production/diagnostic policy snapshot")
    for name in GRAPHS:
        document = json.loads((DEST / (name + ".json")).read_text())
        for path, digest in document["inputs"].items():
            if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != digest:
                raise ValueError("stale policy resolution input: " + path)
        expected = {(p["name"], p["version"]) for p in document["metadata"]["packages"] if p["source"] == "registry+https://github.com/rust-lang/crates.io-index"}
        facts = document["metadata"]["merkur_registry_index"]
        lock = tomllib.loads((ROOT / Path(GRAPHS[name]).with_name("Cargo.lock")).read_text())
        checksums = {(p["name"], p["version"]): p.get("checksum") for p in lock["package"] if p.get("source") == "registry+https://github.com/rust-lang/crates.io-index"}
        if len(facts) != len(expected) or {(p["name"], p["version"]) for p in facts} != expected:
            raise ValueError("policy registry feature inventory differs from metadata")
        for fact in facts:
            record = fact["record"]
            digest = hashlib.sha256(json.dumps(record, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            features = dict(record["features"])
            features.update(record.get("features2", {}))
            if digest != fact["record_sha256"] or record["cksum"] != fact["checksum"] or features != fact["features"] or record["name"] != fact["name"] or record["vers"] != fact["version"] or checksums[(fact["name"], fact["version"])] != fact["checksum"]:
                raise ValueError("policy registry index fact altered")
    render_targets()
    print("Exact locked policy snapshots checked: production and three independent diagnostic graphs")


if __name__ == "__main__":
    main()
