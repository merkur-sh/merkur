#!/usr/bin/env python3
"""Capture the original native release PGO contexts using the existing Cargo emitter."""

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tempfile


PACKAGE = "merkur-dataplane"
LIBRARY = "apps/daemon/dataplane/src/lib.rs"
BINARY = "apps/daemon/dataplane/src/main.rs"
NAMESPACE = "//tools/bazel/rust/release_pgo"


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def fact(path):
    data = path.read_bytes()
    return {"path": str(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def original_sources(sdk, root, provenance, descriptor, producer):
    if provenance["execution_host"] != sdk.host or provenance["producer"] != producer or provenance["descriptor"] != fact(descriptor):
        raise ValueError("Release PGO requires the actual native source SDK and descriptor")
    sdk.require_locks([root / "Cargo.lock"])
    inputs = {}
    for original in provenance["source_files"]:
        path = Path(original["path"])
        if fact(path) != original:
            raise ValueError("Release PGO original source File changed")
        logical = str(path.resolve(strict=True).relative_to(root))
        if logical in inputs:
            raise ValueError("Release PGO original source File is duplicated")
        inputs[logical] = original["sha256"]
    if {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()} != set(inputs):
        raise ValueError("Release PGO source SDK File membership changed")
    if "scripts/build-daemon-artifacts.ts" not in inputs:
        raise ValueError("Release PGO requires its original released command source")
    return inputs


def select_root(graph, packages, phase, host):
    selected = []
    for index in graph["roots"]:
        node = graph["units"][index]
        if packages[node["pkg_id"]]["name"] != PACKAGE:
            raise ValueError("Release PGO contains a foreign compiler root")
        expected = ("test", ["lib"], LIBRARY) if phase == "generate" else ("build", ["bin"], BINARY)
        if (node["mode"], node["target"]["kind"], node["target"]["src_path"]) == expected:
            if node["platform"] != host or node["profile"]["name"] != "release":
                raise ValueError("Release PGO root requires its explicit native release profile")
            selected.append(index)
    if len(selected) != 1:
        raise ValueError("Release PGO requires one original " + phase + " compiler role")
    # Cargo test also lists the empty binary harness and doctests. The original
    # release trains the library executable; retain exactly its dependency closure.
    graph = copy.deepcopy(graph)
    graph["roots"] = selected
    live = set()

    def visit(index):
        if index not in live:
            live.add(index)
            for edge in graph["units"][index]["dependencies"]:
                visit(edge["index"])

    visit(selected[0])
    order = sorted(live)
    positions = {index: position for position, index in enumerate(order)}
    graph["units"] = [graph["units"][index] for index in order]
    for node in graph["units"]:
        for edge in node["dependencies"]:
            edge["index"] = positions[edge["index"]]
    graph["roots"] = [positions[selected[0]]]
    return graph


def capture(contexts, sdk, root, inputs, phase, flag, tpm_sim=False):
    if phase not in ("generate", "use") or not flag.startswith("-Cprofile-" + phase + "="):
        raise ValueError("Release PGO requires the original phase's explicit compiler flag")
    contexts.ROOT = root
    manifest = root / "Cargo.toml"
    features = [PACKAGE + "/tpm-sim"] if tpm_sim else []
    raw = contexts.resolve(manifest, sdk.host, "1.97.1", False, sdk=sdk, features=features)
    metadata = contexts.normalize(raw, manifest, manifest)
    graph = contexts.unit_graph(manifest, sdk.host, "1.97.1", "test" if phase == "generate" else "release",
                                raw, metadata, root, sdk=sdk, release=True, package=PACKAGE,
                                features=["tpm-sim"] if tpm_sim else [], explicit_target=True,
                                target_rust_flags=[flag])
    packages = {package["id"]: package for package in metadata["packages"]}
    graph = select_root(graph, packages, phase, sdk.host)
    for node in graph["units"]:
        flags = node["rust_flags"]
        if node["platform"] is None and any(value.startswith("-Cprofile-") for value in flags):
            raise ValueError("Release PGO instrumented an original host compiler unit")
        if node["platform"] == sdk.host and flag not in flags:
            raise ValueError("Release PGO target unit lost its actual Cargo target flags")
    return {"package": "dataplane-pgo-" + phase, "mode": "test" if phase == "generate" else "release",
            "platform": "native", "inputs": inputs, "contexts": {sdk.host: metadata},
            "unit_graphs": {sdk.host: {"release": graph}}}


def graph_json(value):
    """Emit the configured graph with structural indentation and fitted scalar arrays."""
    def render(item, depth, column):
        indent = "  " * depth
        child_indent = indent + "  "
        if isinstance(item, dict) and item:
            members = []
            for name, child in sorted(item.items()):
                prefix = child_indent + json.dumps(name) + ": "
                members.append(prefix + render(child, depth + 1, len(prefix)))
            return "{\n" + ",\n".join(members) + "\n" + indent + "}"
        if isinstance(item, list) and item:
            if all(not isinstance(child, (dict, list)) for child in item):
                inline = json.dumps(item)
                if column + len(inline) <= 100:
                    return inline
            return "[\n" + ",\n".join(child_indent + render(child, depth + 1, len(child_indent)) for child in item) + "\n" + indent + "]"
        return json.dumps(item)

    return render(value, 0, 0) + "\n"


def emit(units, documents, nodes, roots, packages, metadata, source_inputs, runtime_inputs, host, flags, phases=("generate", "use")):
    namespace = NAMESPACE + "/" + host
    # Relocate only the exact captured output-path flags. The profile bytes are
    # ordinary declared input data; neither Cargo's target flags nor host flags
    # are reconstructed from guessed package dependencies.
    emitted = copy.deepcopy(nodes)
    for node in emitted.values():
        rewritten = []
        for flag in node["rust_flags"]:
            if flag == flags["generate"]:
                rewritten.append("-Cprofile-generate=merkur-release-pgo")
            elif flag == flags["use"]:
                rewritten.append("-Cprofile-use=$(location :dataplane_profile)")
                node["profile_data"] = [":dataplane_profile"]
            else:
                rewritten.append(flag)
        node["rust_flags"] = rewritten
    binding = {}
    for phase in phases:
        selected = roots["dataplane-pgo-" + phase + "/release/" + host]
        if len(selected) != 1:
            raise ValueError("Release PGO binding is missing its original root")
        node = nodes[selected[0]]
        expected = ("test", ["lib"], LIBRARY) if phase == "generate" else ("build", ["bin"], BINARY)
        if (node["mode"], node["target"]["kind"], node["target"]["src_path"]) != expected:
            raise ValueError("Release PGO binding changed the original library/binary compiler role")
        binding[phase] = namespace + ":u_" + selected[0] + ("_binary" if phase == "generate" else "")
    build = ['# Generated from the original native release PGO compiler contexts.\n',
             'load("//tools/bazel/rust:units.bzl", "compiler_unit", "build_script_unit", "doctest_unit", "build_script_metadata")\n',
             'load("//tools/bazel/rust:release-pgo.bzl", "dataplane_release_profile")\n',
             'package(default_visibility = ["//visibility:public"])\n',
             'exports_files(["BUILD.bazel", "graph.json", "roots.bzl"] + glob(["contexts/*.json"]))\n']
    separate, groups = units._unit_declarations(emitted, packages, build, metadata, source_inputs, runtime_inputs, profile_training=roots["dataplane-pgo-generate/release/" + host][0])
    if separate or groups:
        raise ValueError("Native release PGO unexpectedly emitted a shipping WASM unit")
    build.append('dataplane_release_profile(name = "dataplane_profile", instrumented_library = ' + units.text(binding["generate"]) + ', target = ' + units.text(host) + ')\n')
    if "use" in binding:
        build.append('alias(name = "dataplane_release", actual = ' + units.text(binding["use"]) + ', tags = ["manual"])\n')
    return {"BUILD.bazel": "".join(build),
            "roots.bzl": "RELEASE_PGO_BINDINGS = " + units.starlark(binding) + "\n",
            "graph.json": graph_json({"nodes": nodes, "roots": roots}),
            **{"contexts/" + document["package"] + ".json": json.dumps(document, indent=2, sort_keys=True) + "\n" for document in documents}}


def project_provenance(units, nodes, roots, packages, source_inputs, host):
    """Project the trained binary through the existing selected Rust schema."""
    context = "dataplane-pgo-use/release/" + host
    selected = roots[context]
    if len(selected) != 1:
        raise ValueError("PGO attribution requires its one original profile-use binary")
    identity = selected[0]
    binary = nodes[identity]
    if binary["mode"] != "build" or binary["target"]["kind"] != ["bin"] or binary["target"]["src_path"] != BINARY or binary["profile"]["name"] != "release":
        raise ValueError("PGO attribution cannot substitute a library/test compiler role")
    if packages[binary["pkg_id"]]["name"] != PACKAGE or binary["platform"] != host or binary["execution_host"] != host or "-Cprofile-use=target/rust/pgo/dataplane.profdata" not in binary["rust_flags"]:
        raise ValueError("PGO attribution requires the actual native profile-use compiler root")
    closure = {}

    def include(identity):
        if identity not in closure:
            closure[identity] = nodes[identity]
            for edge in nodes[identity]["dependencies"]:
                include(edge["unit"])

    include(identity)
    notices = units.license_metadata.check()
    checksums = units.locked_checksums(units.ROOT)
    original_packages = {}
    for package_id in sorted({node["pkg_id"] for node in closure.values()}):
        package = packages[package_id]
        notice = notices[package_id]
        if any(package[field] != notice[field] for field in ("name", "version", "source", "license", "repository")):
            raise ValueError("PGO compiler and original locked notice identities differ")
        original_packages[package_id] = dict(package, license_file=notice["license_file"],
            archive_checksum=checksums.get((package["name"], package["version"], package["source"])))
    macros = json.loads(source_inputs.read_text())
    namespace = NAMESPACE + "/" + host
    filename = "merkur_dataplane__profile_use.json"
    descriptor = {"roots": selected, "units": closure, "packages": original_packages,
                  "macro_inputs": {package_id: macros["macros"].get(package.get("manifest", ""), []) for package_id, package in original_packages.items()},
                  "configuration": {"compiler_root": PACKAGE + "/profile_use/" + host, "target": host,
                      "captured_execution_hosts": sorted({node["execution_host"] for node in closure.values()}),
                      "public_release_context": "//tools/bazel/bun:public_release_context"},
                  "package_sources": {package_id: units.source(package) + ":package_data" for package_id, package in original_packages.items()},
                  "package_manifests": {package_id: units.source(package) + ":Cargo.toml" for package_id, package in original_packages.items()},
                  "shipping_qualified": False,
                  "pending": ["Native release PGO training and profile-use binary execution", "Compiled selected Rust/stdlib attribution", "Quiet four-platform executor and unsigned release qualification"]}
    descriptor["license_sources"] = {"workspace": {"manifest": "//:Cargo.toml", "text": "//:LICENSE"}, "packages": descriptor["package_sources"]}
    labels = [":" + filename, namespace + ":BUILD.bazel", namespace + ":graph.json", namespace + ":roots.bzl",
              "//:Cargo.toml", "//:Cargo.lock", "//:rust-toolchain.toml", "//:MODULE.bazel", "//:LICENSE", "//:.cargo/config.toml",
              "//scripts:build-daemon-artifacts.ts", "//tools/bazel/rust:units.bzl", "//tools/bazel/rust:units.py",
              "//tools/bazel/rust:contexts.py", "//tools/bazel/rust:acquisition_sdk.py", "//tools/bazel/rust:llvm_tools.bzl",
              "//tools/bazel/rust:release-pgo.bzl", "//tools/bazel/rust:release_pgo_generate.py", "//tools/bazel/rust:release_pgo_train.py",
              "//tools/bazel/rust:metadata.json", "//tools/bazel/rust:source_inputs.json", "//tools/bazel/rust:source_inputs.rs",
              "//tools/bazel/rust:runtime_inputs.json", "//tools/bazel/rust:license_metadata.json",
              "//tools/bazel/worker:rules_rust-0.74.0.patch", "//tools/bazel/bun:public-release-context.ts"]
    labels.extend(namespace + ":contexts/" + scope + ".json" for scope in ("dataplane-pgo-generate", "dataplane-pgo-use"))
    membership = {namespace[2:] + "/provenance/" + filename}
    for package_id, package in original_packages.items():
        if package["source"] is not None:
            continue
        prefix = units.source(package)
        labels.extend([prefix + ":rust_sources", prefix + ":Cargo.toml", prefix + ":BUILD.bazel"])
        labels.extend(units.source_file_label(path) for path in descriptor["macro_inputs"][package_id])
        directory = Path(package["manifest"]).parent
        membership.update(path for path in macros["sources"] if Path(path).is_relative_to(directory))
        membership.update(descriptor["macro_inputs"][package_id])
    for label in labels:
        if label.startswith("//") and not label.endswith(":rust_sources"):
            owner, member = label[2:].split(":", 1)
            membership.add(str(Path(owner) / member))
    descriptor["source_membership"] = sorted(membership)
    build = ('package(default_visibility = ["//visibility:public"])\nexports_files(["' + filename + '"])\n'
             'filegroup(name = "dataplane_profile_use_sources", srcs = ' + units.starlark(sorted(set(labels))) + ')\n')
    return {"provenance/" + filename: json.dumps(descriptor, indent=2, sort_keys=True) + "\n", "provenance/BUILD.bazel": build}


def phase_inputs(phase, trained_profile, instrumented_context):
    if phase not in ("generate", "use"):
        raise ValueError("Release PGO requires an explicit capture phase")
    if phase == "generate" and (trained_profile is not None or instrumented_context is not None):
        raise ValueError("Instrumented capture cannot inherit another training profile/context")
    if phase == "use" and (trained_profile is None or instrumented_context is None):
        raise ValueError("Profile-use capture requires its actual trained profile and original instrumented context")


def profile_use_capture(contexts, sdk, root, inputs, instrumented_context, trained_profile, profdata, training, tpm_sim=False):
    generation = json.loads(instrumented_context.read_text())
    generate_flag = "-Cprofile-generate=target/rust/pgo/profiles"
    if generation != capture(contexts, sdk, root, inputs, "generate", generate_flag, tpm_sim):
        raise ValueError("Profile-use capture differs from its original instrumented compiler context")
    original_profile = fact(trained_profile)
    if not original_profile["size"] or not trained_profile.is_file():
        raise ValueError("Profile-use capture requires ordinary nonempty trained profile bytes")
    environment = sdk.environment()
    training.matching_tools(str(sdk.rustc), str(profdata), environment)
    observed = subprocess.run([str(profdata), "show", str(trained_profile)], env=environment, capture_output=True)
    if observed.returncode:
        raise ValueError("Profile-use capture refuses malformed matching LLVM profile bytes")
    actual_flag = "-Cprofile-use=" + str(trained_profile.resolve(strict=True))
    use = capture(contexts, sdk, root, inputs, "use", actual_flag, tpm_sim)
    # Cargo's real target probe consumes this exact ordinary File. Preserve its
    # original logical release path in identities; action emission binds the
    # same trained producer through $(location :dataplane_profile).
    for unit in use["unit_graphs"][sdk.host]["release"]["units"]:
        unit["rust_flags"] = ["-Cprofile-use=target/rust/pgo/dataplane.profdata" if value == actual_flag else value for value in unit["rust_flags"]]
    if fact(trained_profile) != original_profile:
        raise ValueError("Trained profile bytes changed during original compiler capture")
    return [generation, use]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("sdk-descriptor", "sdk-provenance", "sdk-resolver", "source-root", "contexts-helper", "unit-emitter", "native-helper", "metadata", "source-inputs", "runtime-inputs", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--producer", required=True)
    parser.add_argument("--phase", choices=("generate", "use"), required=True)
    parser.add_argument("--trained-profile", type=Path)
    parser.add_argument("--instrumented-context", type=Path)
    parser.add_argument("--llvm-profdata", type=Path)
    parser.add_argument("--training-helper", type=Path)
    parser.add_argument("--tpm-sim", action="store_true")
    parser.add_argument("--engine-precreated-tree-roots", action="store_true")
    args = parser.parse_args()
    phase_inputs(args.phase, args.trained_profile, args.instrumented_context)
    if args.phase == "use" and (args.llvm_profdata is None or args.training_helper is None):
        raise ValueError("Profile-use capture requires the matching declared LLVM and training helper")
    sys.path.insert(0, str(args.unit_emitter.parent.resolve(strict=True)))
    contexts = load("declared_release_pgo_contexts", args.contexts_helper)
    resolver = load("declared_release_pgo_sdk", args.sdk_resolver)
    helper = load("declared_release_pgo_source_helper", args.native_helper)
    units = load("declared_release_pgo_units", args.unit_emitter)
    sdk = resolver.NativeCargoSdk.load(args.sdk_descriptor)
    try:
        root = sdk.original_tree(args.source_root)
        units.ROOT, units.HERE, units.DEST = root, root / "tools/bazel/rust", root / "tools/bazel/rust/units"
        units.license_metadata.ROOT = root
        units.license_metadata.DEST = root / "tools/bazel/rust/license_metadata.json"
        provenance = json.loads(args.sdk_provenance.read_text())
        inputs = original_sources(sdk, root, provenance, args.sdk_descriptor, args.producer)
        # These locations are capture-only Cargo output arguments. Emission
        # relocates exactly these flags to the action output and declared profile.
        with tempfile.TemporaryDirectory(prefix="merkur-release-pgo-capture-") as temporary:
            flags = {"generate": "-Cprofile-generate=target/rust/pgo/profiles",
                     "use": "-Cprofile-use=target/rust/pgo/dataplane.profdata"}
            documents = [capture(contexts, sdk, root, inputs, "generate", flags["generate"], args.tpm_sim)] if args.phase == "generate" else profile_use_capture(contexts, sdk, root, inputs, args.instrumented_context, args.trained_profile, args.llvm_profdata, load("declared_pgo_training", args.training_helper), args.tpm_sim)
            paths = []
            for document in documents:
                path = Path(temporary) / (document["package"] + ".json")
                path.write_text(json.dumps(document))
                paths.append(path)
            nodes, roots, packages = units.collect(paths)
            helper.selected_inputs(root, nodes, packages, args.metadata, args.source_inputs, args.runtime_inputs, inputs)
            bodies = emit(units, documents, nodes, roots, packages, args.metadata, args.source_inputs, args.runtime_inputs, sdk.host, flags, phases=("generate",) if args.phase == "generate" else ("generate", "use"))
            if args.phase == "use":
                bodies.update(project_provenance(units, nodes, roots, packages, args.source_inputs, sdk.host))
        if original_sources(sdk, root, provenance, args.sdk_descriptor, args.producer) != inputs:
            raise ValueError("Release PGO original source Files changed during capture")
        if args.engine_precreated_tree_roots:
            args.output.mkdir(exist_ok=True)
            if list(args.output.iterdir()):
                raise ValueError("Release PGO output must be an empty declared TreeArtifact")
        else:
            args.output.mkdir()
        for relative, body in bodies.items():
            path = args.output / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body)
    finally:
        sdk.close()


if __name__ == "__main__":
    main()
