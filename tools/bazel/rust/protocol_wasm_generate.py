"""Declare only the original no-default SIMD WASM cipher library test graph."""
import argparse
import hashlib
import importlib.util
import json
import stat
from pathlib import Path
import sys

LOCKS = ["Cargo.lock", "tools/bolero/Cargo.lock", "tools/ownership-proofs/Cargo.lock",
         "tools/edge-kernel-profile/Cargo.lock", "tools/sim/Cargo.lock"]
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise ValueError("Missing declared generator File")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def capture_original_graph(sdk, source_root):
    contexts = load("original_protocol_contexts", source_root / "tools/bazel/rust/contexts.py")
    contexts.ROOT = source_root
    manifest = source_root / "Cargo.toml"
    version = sdk.descriptor["version"]
    raw = contexts.resolve(manifest, "wasm32-unknown-unknown", version, False,
                           features=["merkur-e2e/wasm"], no_default_features=True, sdk=sdk)
    normalized = contexts.normalize(raw, manifest, manifest)
    original = contexts.unit_graph(manifest, "wasm32-unknown-unknown", version, "test", raw, normalized,
                                   source_root / "packages/e2e-wasm", features=["wasm"], library=True,
                                   sdk=sdk, release=True, package="merkur-e2e", no_default_features=True)
    return normalized, original


def validate(document, sdk, source_root, provenance, descriptor_file, producer):
    descriptor_bytes = descriptor_file.read_bytes()
    expected_descriptor = {"path": str(descriptor_file), "size": len(descriptor_bytes), "sha256": hashlib.sha256(descriptor_bytes).hexdigest()}
    if provenance["producer"] != producer or provenance["execution_host"] != sdk.host or provenance["descriptor"] != expected_descriptor:
        raise ValueError("Protocol source SDK differs from its declared producer/descriptor File")
    sdk.require_locks([source_root / path for path in LOCKS])
    if document["package"] != "merkur-e2e" or set(document["contexts"]) != {"wasm32-unknown-unknown"}:
        raise ValueError("Protocol context must select original merkur-e2e WASM package")
    if set(document["unit_graphs"]) != {"wasm32-unknown-unknown"} or set(document["unit_graphs"]["wasm32-unknown-unknown"]) != {"test-release"}:
        raise ValueError("Protocol context must select one release test graph")
    facts = {}
    for fact in provenance["source_files"]:
        original = Path(fact["path"]).resolve(strict=True)
        relative = str(original.relative_to(source_root))
        if relative in facts:
            raise ValueError("Duplicated original source File")
        facts[relative] = fact
    if set(document["inputs"]) != set(facts):
        raise ValueError("Protocol context differs from its original source SDK inventory")
    for path, expected in document["inputs"].items():
        file = source_root / path
        fact = facts[path]
        content = file.read_bytes()
        if hashlib.sha256(content).hexdigest() != expected or fact["sha256"] != expected or fact["size"] != len(content):
            raise ValueError("Changed original protocol context source File: " + path)
    graph = document["unit_graphs"]["wasm32-unknown-unknown"]["test-release"]
    if graph["execution_host"] != sdk.host:
        raise ValueError("Protocol graph execution host differs from native acquisition SDK")
    if len(graph["roots"]) != 1:
        raise ValueError("Protocol graph must select exactly one library harness")
    root = graph["units"][graph["roots"][0]]
    if root["pkg_id"] != "workspace:packages/merkur-e2e" or root["mode"] != "test" or root["target"]["kind"] != ["lib"] or root["target"]["src_path"] != "packages/merkur-e2e/src/lib.rs":
        raise ValueError("Protocol root is not the original library test harness")
    if root["features"] != ["wasm"] or root["platform"] != "wasm32-unknown-unknown" or root["profile"]["name"] != "release":
        raise ValueError("Protocol harness changed original features, target or release profile")
    normalized, original = capture_original_graph(sdk, source_root)
    # The original source-bound oracle derives effective ordered target flags,
    # host flags and every Cargo release profile. Membership checks cannot detect
    # a later overriding flag or a modified dependency/build-script profile.
    if document["contexts"]["wasm32-unknown-unknown"] != normalized or graph != original:
        raise ValueError("Protocol context differs from its original source-bound Cargo recipe")


def declarations(units, nodes, roots, packages, metadata_file, source_inputs_file, runtime_inputs_file):
    if any(unit["emit_cdylib"] for unit in nodes.values()):
        raise ValueError("Protocol library test graph cannot emit a shipping cdylib")
    build = ['# Generated by tools/bazel/rust/protocol_wasm_generate.py. DO NOT EDIT.\n',
             'load("//tools/bazel/rust:units.bzl", "compiler_unit", "build_script_unit", "doctest_unit", "build_script_metadata")\n',
             'package(default_visibility = ["//visibility:public"])\n',
             'exports_files(["BUILD.bazel", "context.json", "graph.json", "archives.MODULE.bazel"])\n',
             'filegroup(name = "verification_inputs", srcs = ["BUILD.bazel", "context.json", "graph.json", "archives.MODULE.bazel"])\n\n']
    separate, source_groups = units._unit_declarations(nodes, packages, build, metadata_file, source_inputs_file, runtime_inputs_file)
    if separate or source_groups:
        raise ValueError("Protocol library test graph unexpectedly produced shipping artifacts")
    identifiers = next(iter(roots.values()))
    if len(identifiers) != 1:
        raise ValueError("Protocol compiler graph has ambiguous test roots")
    build.append('alias(name = "cipher_harness", actual = ":u_' + identifiers[0] + '_binary", tags = ["manual"])\n')
    checksums = units.locked_checksums(units.ROOT)
    archives = ['# Original selected Cargo lock archives for protocol WASM test.\n',
                'protocol_archive = use_repo_rule("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")\n']
    for package_id in sorted({unit["pkg_id"] for unit in nodes.values()}):
        package = packages[package_id]
        if package["source"] is None:
            continue
        if package["source"] != REGISTRY:
            raise ValueError("Protocol compiler context has an unmodeled source registry")
        checksum = checksums[(package["name"], package["version"], package["source"])]
        if not checksum:
            raise ValueError("Protocol source archive lacks original lock checksum")
        archives.extend(['protocol_archive(\n', '    name = ' + units.text(units.source_repository(package)) + ',\n',
                         '    urls = ' + units.text(['https://static.crates.io/crates/' + package['name'] + '/' + package['name'] + '-' + package['version'] + '.crate']) + ',\n',
                         '    sha256 = ' + units.text(checksum) + ',\n',
                         '    strip_prefix = ' + units.text(package['name'] + '-' + package['version']) + ',\n',
                         '    type = "tar.gz",\n', '    build_file = "//tools/bazel/rust:crate_sources.BUILD.bazel",\n)\n'])
    return "".join(build), "".join(archives)


def publish(output, bodies, engine_precreated=False):
    if engine_precreated:
        info = output.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o7000 or any(output.iterdir()):
            raise ValueError("Protocol generation requires an empty ordinary engine-created output Tree")
    else:
        output.mkdir()
    for name, body in bodies.items():
        with (output / name).open("xb") as destination:
            destination.write(body)


def main():
    parser = argparse.ArgumentParser()
    for name in ["context", "sdk-descriptor", "sdk-provenance", "sdk-resolver", "source-root", "unit-emitter", "metadata", "source-inputs", "runtime-inputs", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--producer", required=True)
    parser.add_argument("--engine-precreated-tree-roots", action="store_true")
    args = parser.parse_args()
    resolver = load("declared_protocol_sdk", args.sdk_resolver)
    sdk = resolver.NativeCargoSdk.load(args.sdk_descriptor)
    try:
        document = json.loads(args.context.read_text())
        source_root = sdk.original_tree(args.source_root)
        validate(document, sdk, source_root, json.loads(args.sdk_provenance.read_text()), args.sdk_descriptor, args.producer)
        # Existing sibling imports are exact declared source Files in this package.
        sys.path.insert(0, str(args.unit_emitter.parent.resolve(strict=True)))
        units = load("declared_protocol_units", args.unit_emitter)
        units.ROOT = source_root
        units.HERE = source_root / "tools/bazel/rust"
        units.DEST = source_root / "tools/bazel/rust/units"
        nodes, roots, packages = units.collect([args.context])
        build, archives = declarations(units, nodes, roots, packages, args.metadata, args.source_inputs, args.runtime_inputs)
        publish(args.output, {
            "BUILD.bazel": build.encode(),
            "graph.json": (json.dumps({"nodes": nodes, "roots": roots}, indent=2, sort_keys=True) + "\n").encode(),
            "context.json": args.context.read_bytes(),
            "archives.MODULE.bazel": archives.encode(),
        }, args.engine_precreated_tree_roots)
    finally:
        sdk.close()


if __name__ == "__main__":
    main()
