#!/usr/bin/env python3
"""Capture and emit only the original retained-lock simulator compiler graph."""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import tomllib

PACKAGE = "workspace:tools/sim"
NAMESPACE = "//tools/bazel/rust/simulator/"
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fact(path):
    data = path.read_bytes()
    return {"path": str(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def original_sources(helper, sdk, root, provenance, descriptor, producer):
    inputs = helper.sources(sdk, root, provenance, descriptor, producer)
    sdk.require_locks([root / "Cargo.lock", root / "tools/sim/Cargo.lock"])
    required = {"tools/sim/manifest.toml", "tools/sim/build.rs", "tools/sim/src/lib.rs",
                "tools/sim/regressions.json", "scripts/sim-tests.ts", "scripts/generated-cargo-workspace.ts"}
    if not required <= inputs.keys():
        raise ValueError("Simulator source SDK lacks the original preparation/runtime inputs")
    return inputs


def capture(contexts, sdk, root):
    """Only the generated Cargo workspace is writable; the SDK source Tree is not."""
    previous = contexts.ROOT, contexts.DIRECTORY
    try:
        contexts.ROOT = root
        with tempfile.TemporaryDirectory(prefix="merkur-simulator-context-") as temporary:
            contexts.DIRECTORY = Path(temporary)
            production = tomllib.loads((root / "Cargo.toml").read_text())
            document = contexts.capture_simulator(sdk, "1.97.1", production)
            directory = contexts.DIRECTORY / "merkur-sim/simulator-test/native"
            generated = {name: (directory / name).read_bytes() for name in
                         ["Cargo.toml", "Cargo.lock", "merkur-sim/Cargo.toml", "BUILD.bazel"]}
            for name, expected in document["generated_inputs"].items():
                if hashlib.sha256(generated[name]).hexdigest() != expected:
                    raise ValueError("Simulator generated context changed during capture")
            return document, generated
    finally:
        contexts.ROOT, contexts.DIRECTORY = previous


def bindings(root, nodes, roots, packages, host):
    if set(roots) != {"merkur-sim/test/" + host}:
        raise ValueError("Simulator requires only its genuine original release test context")
    manifest = tomllib.loads((root / "tools/sim/manifest.toml").read_text())
    original_library = "tools/sim/" + manifest["lib"]["path"]
    library_name = manifest["lib"].get("name", manifest["package"]["name"].replace("-", "_"))
    harnesses = {path.stem: "tools/sim/tests/" + path.name
                 for path in sorted((root / "tools/sim/tests").iterdir()) if path.is_file() and path.suffix == ".rs"}
    if not harnesses or "lib" in harnesses:
        raise ValueError("Simulator original integration harness identities are missing or ambiguous")
    tests, docs = {}, []
    for identity in roots["merkur-sim/test/" + host]:
        node = nodes[identity]
        if node["pkg_id"] != PACKAGE or packages[PACKAGE]["manifest"] != "tools/sim/manifest.toml":
            raise ValueError("Simulator captured a foreign original root")
        if node["execution_host"] != host or node["platform"] not in (None, host) or node["profile"]["name"] != "release":
            raise ValueError("Simulator roots require the original native release profile")
        expected_flags = [] if node["mode"] == "doctest" else ["--cfg", "merkur_sim", "--cfg", "tokio_unstable"]
        if node["rust_flags"] != expected_flags:
            raise ValueError("Simulator root changed its original ordered compiler flags")
        kind, source = node["target"]["kind"], node["target"]["src_path"]
        label = NAMESPACE + host + ":u_" + identity
        is_library = kind == ["lib"] and source == original_library and node["target"]["name"] == library_name
        if node["mode"] == "doctest" and is_library:
            docs.append(identity)
        elif node["mode"] == "test":
            role = "lib" if is_library else node["target"]["name"]
            if not is_library and (kind != ["test"] or harnesses.get(role) != source):
                raise ValueError("Simulator test root is not an original authored harness")
            if role in tests:
                raise ValueError("Simulator duplicates an original test root")
            tests[role] = label
        else:
            raise ValueError("Simulator root has a foreign Cargo compiler role")
    if set(tests) != {"lib", *harnesses} or len(docs) != 1:
        raise ValueError("Simulator must retain its library, every original harness and rustdoc root")
    # The original Cargo doctest edge supplies the normal compiled library;
    # a package/name guess is not a substitute for that dependency relation.
    libraries = [edge["unit"] for edge in nodes[docs[0]]["dependencies"]
                 if nodes[edge["unit"]]["pkg_id"] == PACKAGE
                 and nodes[edge["unit"]]["mode"] == "build"
                 and nodes[edge["unit"]]["target"]["kind"] == ["lib"]
                 and nodes[edge["unit"]]["target"]["src_path"] == original_library]
    if len(libraries) != 1:
        raise ValueError("Simulator rustdoc lacks its actual matching compiled library dependency")
    library = nodes[libraries[0]]
    if library["execution_host"] != host or library["platform"] not in (None, host) or library["profile"]["name"] != "release" or library["rust_flags"] != ["--cfg", "merkur_sim", "--cfg", "tokio_unstable"]:
        raise ValueError("Simulator compiled library changed its original release placement")
    return {"build": NAMESPACE + host + ":u_" + libraries[0], "tests": tests,
            "doctest": NAMESPACE + host + ":u_" + docs[0]}


def selected_inputs(helper, sdk, root, nodes, packages, metadata, discovery, runtime, inputs):
    originals = {package["id"]: package for package in json.loads(metadata.read_text())["packages"]}
    selected = {node["pkg_id"] for node in nodes.values()}
    registry_ids = {identity for identity in selected if packages[identity]["source"] == REGISTRY}
    if registry_ids:
        # The original SDK verifies every retained lock pin, publisher checksum
        # and extracted member. Simulator-only dependencies share that authority.
        sdk._verify_registry()
        registry = sdk.descriptor["registry"]
        directory = sdk.original_tree(registry["directory"])
        pins = {(package["name"], package["version"]): package["checksum"] for package in registry["packages"]}
        members = {Path(row["path"]).resolve(strict=True): row for row in registry["files"]}
        locked = {}
        for name in ["Cargo.lock", "tools/sim/Cargo.lock"]:
            for package in tomllib.loads((root / name).read_text())["package"]:
                if package.get("source") == REGISTRY:
                    key = package["name"], package["version"]
                    if key in locked and locked[key] != package["checksum"]:
                        raise ValueError("Conflicting original simulator registry lock pin")
                    locked[key] = package["checksum"]
        for identity in registry_ids:
            package = packages[identity]
            key = package["name"], package["version"]
            if identity != REGISTRY + "#" + key[0] + "@" + key[1] or package["id"] != identity or key not in locked or pins.get(key) != locked[key]:
                raise ValueError("Simulator registry identity differs from its original retained lock and SDK pin")
            package_root = directory / (key[0] + "-" + key[1])
            paths = {"Cargo.toml"}
            for node in nodes.values():
                if node["pkg_id"] != identity:
                    continue
                target = node["target"]
                original = {"name": target["name"], "kind": target["kind"], "edition": target["edition"], "source": target["src_path"]}
                if original not in package.get("targets", []):
                    raise ValueError("Simulator registry target differs from the actual Cargo metadata target")
                paths.add(target["src_path"])
            for name in paths:
                relative = Path(name)
                if relative.is_absolute() or any(part in {".", ".."} for part in relative.parts) or str(relative) != name:
                    raise ValueError("Simulator registry target escapes its original package")
                path = package_root / relative
                expected = members.get(path.resolve(strict=True))
                if expected is None or fact(path)["size"] != expected["size"] or fact(path)["sha256"] != expected["sha256"]:
                    raise ValueError("Simulator registry target is not an original declared SDK member")
    production = {identity: node for identity, node in nodes.items()
                  if node["pkg_id"] != PACKAGE and not (node["pkg_id"] in registry_ids and node["pkg_id"] not in originals)}
    # Production normalization intentionally omits registry targets. The actual
    # target/source checks above retain their authority before this projection.
    common = {identity: ({**package, "targets": originals[identity].get("targets", [])}
                         if identity in registry_ids and identity in originals else package)
              for identity, package in packages.items()}
    helper.selected_inputs(root, production, common, metadata, discovery, runtime, inputs)
    for node in nodes.values():
        if node["pkg_id"] == PACKAGE and inputs.get(node["target"]["src_path"]) != fact(root / node["target"]["src_path"])["sha256"]:
            raise ValueError("Simulator target is not an original declared source SDK File")
    for path in (root / "tools/sim").rglob("*.rs"):
        logical = str(path.relative_to(root))
        if inputs.get(logical) != fact(path)["sha256"]:
            raise ValueError("Simulator source inventory is incomplete: " + logical)


def operations(binding, host):
    suffix = host.replace("-", "_")
    labels = ["//tools/sim:simulator_test__" + suffix + "__" + role for role in sorted(binding["tests"])]
    labels.append("//tools/sim:simulator_test__" + suffix + "__doctest")
    row = {"name": "test:sim", "checks": [{"label": label, "kind": "test", "fresh": True} for label in labels],
           "pending": ["Complete native simulator compiler/SDK/runtime qualification"]}
    return {host: {"operations": [row]}}, {host: labels}, {host: {label: label for label in labels}}


def emit(units, root, document, generated, nodes, roots, packages, metadata, discovery, runtime, host):
    binding = bindings(root, nodes, roots, packages, host)
    build = ['# Generated by tools/bazel/rust/simulator_generate.py. DO NOT EDIT.\n',
             'load("//tools/bazel/rust:units.bzl", "compiler_unit", "build_script_unit", "doctest_unit", "build_script_metadata")\n',
             'package(default_visibility = ["//visibility:public"])\n',
             'exports_files(["graph.json", "roots.bzl", "operations.bzl", "archives.MODULE.bazel"])\n',
             'filegroup(name = "verification_inputs", srcs = glob(["**"]))\n']
    separate, groups = units._unit_declarations(nodes, packages, build, metadata, discovery, runtime)
    if separate or groups or any(node["emit_cdylib"] for node in nodes.values()):
        raise ValueError("Simulator context unexpectedly emits a shipping WASM unit")
    checksum = units.locked_checksums(root)
    archives = ['# Original simulator selected archives; integrate only missing declarations.\n',
                'simulator_archive = use_repo_rule("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")\n']
    for package_id in sorted({node["pkg_id"] for node in nodes.values()}):
        package = packages[package_id]
        if package["source"] is None:
            continue
        if package["source"] != REGISTRY:
            raise ValueError("Simulator has an unsupported original registry")
        digest = checksum[(package["name"], package["version"], package["source"])]
        if not digest:
            raise ValueError("Simulator selected archive lacks its original lock checksum")
        archives.append('simulator_archive(name = ' + units.text(units.source_repository(package)) + ', urls = ' + units.text(['https://static.crates.io/crates/' + package['name'] + '/' + package['name'] + '-' + package['version'] + '.crate']) + ', sha256 = ' + units.text(digest) + ', strip_prefix = ' + units.text(package['name'] + '-' + package['version']) + ', type = "tar.gz", build_file = "//tools/bazel/rust:crate_sources.BUILD.bazel")\n')
    operation_rows, operation_targets, operation_canonical = operations(binding, host)
    operation_source = "# Original captured simulator operations; runtime qualification remains pending.\n"
    for name, value in [("SIMULATOR_OPERATION_BINDINGS", operation_rows), ("SIMULATOR_OPERATION_TARGETS", operation_targets), ("SIMULATOR_OPERATION_CANONICAL_TARGETS", operation_canonical)]:
        operation_source += name + " = " + units.starlark(value) + "\n"
    return {"operations.bzl": operation_source.encode(), "BUILD.bazel": "".join(build).encode(), "roots.bzl": ("# Original captured roots; runtime qualification remains pending.\nSIMULATOR_BINDINGS = " + units.starlark(binding) + "\n").encode(),
            "graph.json": (json.dumps({"nodes": nodes, "roots": roots}, sort_keys=True, indent=2) + "\n").encode(),
            "archives.MODULE.bazel": "".join(archives).encode(),
            "context/metadata.json": (json.dumps(document, sort_keys=True, indent=2) + "\n").encode(),
            **{"context/" + name: body for name, body in generated.items()}}


def publish(output, bodies, precreated=False):
    output.mkdir(exist_ok=precreated)
    if list(output.iterdir()):
        raise ValueError("Simulator capture requires an empty declared output Tree")
    for relative, body in bodies.items():
        path = output / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)



def format_graph(data, host, biome, config):
    """Format with the declared native formatter without configuration discovery."""
    result = subprocess.run([
        str(biome.resolve(strict=True)), "format",
        "--stdin-file-path=tools/bazel/rust/simulator/" + host + "/graph.json",
        "--config-path=" + str(config.resolve(strict=True)),
        "--vcs-enabled=false", "--use-editorconfig=false",
    ], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": ""}, check=True)
    if json.loads(result.stdout) != json.loads(data):
        raise ValueError("Declared simulator graph formatter changed the original Cargo graph")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["sdk-descriptor", "sdk-provenance", "sdk-resolver", "source-root", "contexts-helper", "unit-emitter", "native-helper", "metadata", "source-inputs", "runtime-inputs", "biome", "biome-config", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--producer", required=True)
    parser.add_argument("--engine-precreated-tree-roots", action="store_true")
    args = parser.parse_args()
    sys.path.insert(0, str(args.unit_emitter.parent.resolve(strict=True)))
    contexts = load("declared_simulator_contexts", args.contexts_helper)
    helper = load("declared_simulator_source_helper", args.native_helper)
    units = load("declared_simulator_units", args.unit_emitter)
    resolver = load("declared_simulator_sdk", args.sdk_resolver)
    sdk = resolver.NativeCargoSdk.load(args.sdk_descriptor)
    root = sdk.original_tree(args.source_root)
    tools = {"tools/bazel/rust/contexts.py": args.contexts_helper, "tools/bazel/rust/units.py": args.unit_emitter,
             "tools/bazel/rust/native_protocol_generate.py": args.native_helper, "tools/bazel/rust/acquisition_sdk.py": args.sdk_resolver,
             "tools/bazel/rust/metadata.json": args.metadata, "tools/bazel/rust/source_inputs.json": args.source_inputs,
             "tools/bazel/rust/runtime_inputs.json": args.runtime_inputs,
             "declared-native-biome": args.biome, "biome.json": args.biome_config}
    try:
        provenance = json.loads(args.sdk_provenance.read_text())
        inputs = original_sources(helper, sdk, root, provenance, args.sdk_descriptor, args.producer)
        tool_facts = {logical: fact(path) for logical, path in tools.items()}
        document, generated = capture(contexts, sdk, root)
        document["capture_tools"] = tool_facts
        if any(inputs.get(path) != expected for path, expected in document["inputs"].items()):
            raise ValueError("Simulator context includes an undeclared or changed original source File")
        with tempfile.TemporaryDirectory(prefix="merkur-simulator-units-") as temporary:
            context = Path(temporary) / "metadata.json"
            context.write_text(json.dumps(document))
            units.ROOT, units.HERE, units.DEST = root, root / "tools/bazel/rust", root / "tools/bazel/rust/units"
            nodes, roots, packages = units.collect([context])
            selected_inputs(helper, sdk, root, nodes, packages, args.metadata, args.source_inputs, args.runtime_inputs, inputs)
            bodies = emit(units, root, document, generated, nodes, roots, packages, args.metadata, args.source_inputs, args.runtime_inputs, sdk.host)
        bodies["graph.json"] = format_graph(bodies["graph.json"], sdk.host, args.biome, args.biome_config)
        if original_sources(helper, sdk, root, provenance, args.sdk_descriptor, args.producer) != inputs or tool_facts != {logical: fact(path) for logical, path in tools.items()}:
            raise ValueError("Simulator original source Files changed during capture")
        publish(args.output, bodies, args.engine_precreated_tree_roots)
    finally:
        sdk.close()


if __name__ == "__main__":
    main()
