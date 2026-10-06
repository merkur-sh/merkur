#!/usr/bin/env python3
"""Emit narrow native protocol/helper units from original source-bound Cargo recipes."""
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import tomllib

LOCKS = ["Cargo.lock", "tools/bolero/Cargo.lock", "tools/ownership-proofs/Cargo.lock", "tools/edge-kernel-profile/Cargo.lock", "tools/sim/Cargo.lock"]
RECIPES = {
    "protocol-native": ("test", "test", ["merkur-client", "merkur-client-native", "merkur-e2e", "merkur-edge", "merkur-wire"]),
    "dataplane-native": ("test", "test", "merkur-dataplane"),
    "image-worker-native": ("dev", "dev", "merkur-image-worker"),
    "browser-session-oracle": ("build", "dev", None),
}
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
NATIVE_HOSTS = {"aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"}

TPM_PACKAGE = "merkur-identity-seal"
TPM_SOURCE = "packages/merkur-identity-seal/src/lib.rs"
TPM_IDENTITY = "workspace:packages/merkur-identity-seal"
TPM_CARGO_TEST = ["cargo", "test", "-p", TPM_PACKAGE, "--locked", "--features", "tpm-sim", "--", "tpm_sim"]

def tpm_recipe(source_root):
    """The original script uses one literal Cargo argv, not a computed selector."""
    script = (source_root / "scripts/test-tpm-sim.ts").read_text()
    marker = "const test = Bun.spawn("
    if script.count(marker) != 1:
        raise ValueError("Original TPM Cargo invocation is missing or ambiguous")
    invocation = script.split(marker, 1)[1].lstrip()
    if not invocation.startswith("["):
        raise ValueError("Original TPM Cargo argv must remain its literal selection")
    closing = invocation.index("]")
    if ast.literal_eval(invocation[:closing + 1]) != TPM_CARGO_TEST:
        raise ValueError("Original TPM Cargo package, features, profile or filter changed")
    manifest = tomllib.loads((source_root / "packages/merkur-identity-seal/Cargo.toml").read_text())
    if manifest["package"]["name"] != TPM_PACKAGE or manifest["features"].get("tpm-sim") != ["dep:tpm2-protocol"]:
        raise ValueError("Original TPM feature declaration changed")
    return TPM_CARGO_TEST[:]

def tpm_harnesses(graph, host):
    if graph["execution_host"] != host:
        raise ValueError("TPM graph must be captured on its native execution host")
    roots = graph["roots"]
    if not roots or len(set(roots)) != len(roots):
        raise ValueError("Original TPM roots are missing or duplicated")
    harness = []
    doctests = []
    for index in roots:
        if type(index) is not int or not 0 <= index < len(graph["units"]):
            raise ValueError("Original TPM root index is invalid")
        unit = graph["units"][index]
        if unit["pkg_id"] != TPM_IDENTITY or unit["target"]["kind"] != ["lib"] or unit["target"]["src_path"] != TPM_SOURCE or unit["mode"] not in ("test", "doctest"):
            raise ValueError("TPM root must be the original selected library test or doctest")
        if unit["features"] != ["tpm-sim"] or unit["platform"] not in (None, host):
            raise ValueError("TPM root changed its original feature or native target")
        if unit["mode"] == "test":
            if unit["profile"]["name"] != "test":
                raise ValueError("TPM harness changed the original default test profile")
            harness.append(index)
        else:
            doctests.append(index)
    if len(harness) != 1 or len(doctests) != 1:
        raise ValueError("TPM requires the genuine feature-enabled library harness and original doctest")
    return harness[0]



def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def fact(path):
    data = path.read_bytes()
    return {"path": str(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def tool_facts(contexts_path, oracle_path):
    return {role: {**fact(path), "path": logical} for role, path, logical in [("contexts", contexts_path, "tools/bazel/rust/contexts.py"), ("oracle", oracle_path, "tools/bazel/rust/native_oracle.py")]}


def sources(sdk, root, provenance, descriptor, producer):
    if sdk.host not in NATIVE_HOSTS or provenance["execution_host"] != sdk.host or provenance["producer"] != producer or provenance["descriptor"] != fact(descriptor):
        raise ValueError("Native protocol requires its original matched native SDK producer and descriptor File")
    sdk.require_locks([root / path for path in LOCKS])
    inputs = {}
    for original in provenance["source_files"]:
        path = Path(original["path"])
        if fact(path) != original:
            raise ValueError("Changed or duplicated original native source File: " + str(path))
        logical = str(path.resolve(strict=True).relative_to(root))
        if logical in inputs:
            raise ValueError("Changed or duplicated original native source File: " + logical)
        inputs[logical] = original["sha256"]
    if {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()} != set(inputs):
        raise ValueError("Native source SDK File membership changed")
    return inputs


def capture(scope, contexts, oracle, sdk, root, inputs, tools):
    mode, profile, packages = ("test", "test", [TPM_PACKAGE]) if scope == "tpm-native" else RECIPES[scope]
    if scope == "tpm-native":
        tpm_recipe(root)
    contexts.ROOT = root
    if packages is None:
        # Reuse the exact source-owned example recipe rather than a Test graph example.
        with tempfile.TemporaryDirectory(prefix="native-session-context-") as temporary:
            oracle.ROOT = root
            oracle.contexts.ROOT = root
            oracle.DEST = Path(temporary) / "context.json"
            oracle.refresh(sdk)
            document = json.loads(oracle.DEST.read_text())
        document["inputs"] = inputs
        document["capture_tools"] = tools
        return document
    manifest = root / "Cargo.toml"
    metadata_options = {"features": [TPM_PACKAGE + "/tpm-sim"]} if scope == "tpm-native" else {}
    raw = contexts.resolve(manifest, sdk.host, sdk.descriptor["version"], False, sdk=sdk, **metadata_options)
    metadata = contexts.normalize(raw, manifest, manifest)
    graph_options = {"features": ["tpm-sim"]} if scope == "tpm-native" else {}
    graph = contexts.unit_graph(manifest, sdk.host, sdk.descriptor["version"], mode, raw, metadata, root, sdk=sdk, package=packages, **graph_options)
    if scope == "tpm-native":
        tpm_harnesses(graph, sdk.host)
    return {"package": scope, "mode": mode, "platform": "native", "inputs": inputs,
            "capture_tools": tools, "contexts": {sdk.host: metadata}, "unit_graphs": {sdk.host: {profile: graph}}}


def validate_documents(documents, contexts, oracle, sdk, root, inputs, tools, recipe_set="protocol"):
    if recipe_set not in ("protocol", "tpm"):
        raise ValueError("Native recipe set must be protocol or tpm")
    scopes = {"tpm-native"} if recipe_set == "tpm" else set(RECIPES)
    if len(documents) != len(scopes) or {document["package"] for document in documents} != scopes:
        raise ValueError("Native protocol/helper recipe inventory is incomplete or duplicated")
    for document in documents:
        if document["inputs"] != inputs or document["capture_tools"] != tools:
            raise ValueError("Native context differs from its original source/tool File inventory")
        if document != capture(document["package"], contexts, oracle, sdk, root, inputs, tools):
            raise ValueError("Native context differs from its original default Cargo recipe")


def selected_inputs(root, nodes, packages, metadata_file, source_file, runtime_file, original_inputs):
    metadata = json.loads(metadata_file.read_text())
    discovery = json.loads(source_file.read_text())
    if discovery["metadata_sha256"] != fact(metadata_file)["sha256"]:
        raise ValueError("Native selected source discovery differs from its original metadata File")
    original_packages = {package["id"]: package for package in metadata["packages"]}
    if len(original_packages) != len(metadata["packages"]):
        raise ValueError("Native metadata duplicates original package identities")
    for package_id in {node["pkg_id"] for node in nodes.values()}:
        original = original_packages.get(package_id)
        if original is None or any(original.get(field) != packages[package_id].get(field) for field in ["id", "name", "version", "source", "manifest", "edition", "features"]):
            raise ValueError("Native metadata differs from original selected package facts: " + package_id)
        targets = [{field: target[field] for field in ["name", "kind", "source"]} for target in original.get("targets", [])]
        if targets != packages[package_id].get("targets", []):
            raise ValueError("Native metadata differs from original selected target facts: " + package_id)
    owners = {packages[node["pkg_id"]]["manifest"] for node in nodes.values() if packages[node["pkg_id"]]["source"] is None}
    selected = {node["target"]["src_path"] for node in nodes.values() if packages[node["pkg_id"]]["source"] is None}
    selected.update(path for owner in owners for path in discovery["macros"].get(owner, []))
    runtime = json.loads(runtime_file.read_text())
    for node in nodes.values():
        if node["mode"] == "test":
            for path in runtime.get(packages[node["pkg_id"]]["name"], []):
                if original_inputs.get(path) != fact(root / path)["sha256"]:
                    raise ValueError("Native runtime input differs from its original source SDK File: " + path)
    originals = {**discovery["sources"], **discovery["included_sources"]}
    for path in selected:
        if originals.get(path) != fact(root / path)["sha256"]:
            raise ValueError("Native selected source discovery is stale or missing: " + path)


def native_bindings(nodes, roots, packages):
    bindings = {"native_roots": {}}
    contexts = {scope + "/" + recipe[1] + "/aarch64-apple-darwin": scope for scope, recipe in RECIPES.items()}
    if set(roots) != set(contexts):
        raise ValueError("Native bindings differ from the complete original compiler contexts")
    for context_key, keys in roots.items():
        context = contexts[context_key]
        for key in keys:
            node = nodes[key]
            package = packages[node["pkg_id"]]["name"]
            label = "//tools/bazel/rust/native_protocol:u_" + key
            kind = node["target"]["kind"]
            if context == "protocol-native":
                if package not in RECIPES[context][2] or node["mode"] not in ["test", "doctest", "build"]:
                    raise ValueError("Native protocol bindings require the original package and compiler mode")
                role = package + "/" + node["mode"] + ":" + node["target"]["name"]
                if role in bindings["native_roots"]:
                    raise ValueError("Native protocol roots duplicate an original compiler role: " + role)
                bindings["native_roots"][role] = label
                continue
            if context == "dataplane-native":
                if package != RECIPES[context][2] or node["mode"] != "test" or kind not in [["lib"], ["bin"]]:
                    raise ValueError("Native dataplane bindings require the original library and binary test roots")
                role = "dataplane_" + kind[0]
                label += "_binary"
            elif context == "image-worker-native":
                if package != RECIPES[context][2] or node["mode"] != "build" or kind not in [["lib"], ["bin"]]:
                    raise ValueError("Native image worker bindings require the original dev library and binary roots")
                if kind == ["lib"]:
                    continue
                role = "image_worker"
            elif context == "browser-session-oracle":
                if package != "merkur-client" or node["mode"] != "build" or node["target"]["name"] != "browser_session_oracle":
                    raise ValueError("Native oracle binding requires the original separate dev example root")
                role = "client_oracle"
            else:
                raise ValueError("Native binding has a foreign original recipe: " + context)
            if role in bindings:
                raise ValueError("Native bindings duplicate an original compiler role: " + role)
            bindings[role] = label
    if set(bindings) != {"native_roots", "dataplane_lib", "dataplane_bin", "image_worker", "client_oracle"} or not bindings["native_roots"]:
        raise ValueError("Native bindings lack the complete original recipe roots")
    return bindings


def oracle_sources(units, nodes, roots, packages, source_inputs):
    context = "browser-session-oracle/dev/aarch64-apple-darwin"
    selected = roots.get(context, [])
    if len(selected) != 1:
        raise ValueError("Native oracle requires its single captured dev compiler root")
    root = nodes[selected[0]]
    if (root["mode"] != "build" or root["profile"]["name"] != "dev"
            or root["target"]["name"] != "browser_session_oracle"
            or root["target"]["kind"] != ["example"]
            or packages[root["pkg_id"]]["name"] != "merkur-client"):
        raise ValueError("Native oracle requires the original dev example configuration")
    closure, pending = {}, list(selected)
    while pending:
        identity = pending.pop()
        if identity in closure:
            continue
        closure[identity] = nodes[identity]
        pending.extend(edge["unit"] for edge in nodes[identity]["dependencies"])
    package_ids = sorted({node["pkg_id"] for node in closure.values()})
    discovery = json.loads(Path(source_inputs).read_text())
    descriptor = {"roots": selected, "compiler_label": "//tools/bazel/rust/native_protocol:u_" + selected[0], "units": closure,
                  "packages": {identity: packages[identity] for identity in package_ids},
                  "macro_inputs": {identity: discovery["macros"].get(packages[identity].get("manifest", ""), []) for identity in package_ids}}
    name = "browser_session_oracle_native"
    logical = "tools/bazel/rust/native_protocol/provenance/" + name + ".json"
    labels = [":" + name + ".json", "//:Cargo.toml", "//:Cargo.lock", "//:rust-toolchain.toml", "//:MODULE.bazel", "//:.cargo/config.toml",
              "//tools/bazel/rust:units.bzl", "//tools/bazel/rust:units.py", "//tools/bazel/rust:contexts.py", "//tools/bazel/rust:rust.MODULE.bazel",
              "//tools/bazel/rust:metadata.json", "//tools/bazel/rust:source_inputs.json", "//tools/bazel/rust:source_inputs.rs", "//tools/bazel/rust:runtime_inputs.json",
              "//tools/bazel/rust:native_oracle.py", "//tools/bazel/rust:native_protocol_generate.py", "//tools/bazel/worker:rules_rust-0.74.0.patch",
              "//tools/bazel/bun:BUILD.bazel", "//tools/bazel/bun:rules.bzl", "//tools/bazel/bun:public-release-context.ts",
              "//tools/bazel/rust/native_protocol:contexts/browser-session-oracle.json"]
    membership = {logical}
    for identity in package_ids:
        package = packages[identity]
        if package["source"] is not None:
            continue
        prefix = units.source(package)
        labels += [prefix + ":rust_sources", prefix + ":Cargo.toml", prefix + ":BUILD.bazel"]
        labels += [units.source_file_label(path) for path in descriptor["macro_inputs"][identity]]
        directory = Path(package["manifest"]).parent
        membership.update(path for path in discovery["sources"] if Path(path).is_relative_to(directory))
        membership.update(descriptor["macro_inputs"][identity])
    for label in labels:
        if label.startswith("//") and not label.endswith(":rust_sources"):
            owner, name = label.removeprefix("//").split(":", 1)
            membership.add(str(Path(owner) / name))
    descriptor["source_membership"] = sorted(membership)
    build = ['# Selected original dev oracle compiler sources. Generated; do not edit.\n',
             'package(default_visibility = ["//visibility:public"])\n',
             'exports_files(["browser_session_oracle_native.json"])\n',
             'filegroup(name = "browser_session_oracle_native_sources", srcs = ' + units.starlark(sorted(set(labels))) + ')\n']
    return {"provenance/browser_session_oracle_native.json": json.dumps(descriptor, indent=2, sort_keys=True) + "\n",
            "provenance/BUILD.bazel": "".join(build)}


def emit(units, documents, nodes, roots, packages, metadata, source_inputs, runtime_inputs, recipe_set="protocol"):
    build = ['# Generated by tools/bazel/rust/native_protocol_generate.py. DO NOT EDIT.\n',
             'load("//tools/bazel/rust:units.bzl", "compiler_unit", "build_script_unit", "doctest_unit", "build_script_metadata")\n',
             'package(default_visibility = ["//visibility:public"])\n',
             'exports_files(["BUILD.bazel", "graph.json", "roots.bzl", "archives.MODULE.bazel"] + glob(["contexts/*.json"]))\n',
             'filegroup(name = "verification_inputs", srcs = ["BUILD.bazel", "graph.json", "roots.bzl", "archives.MODULE.bazel"] + glob(["contexts/*.json"]))\n\n']
    separate, groups = units._unit_declarations(nodes, packages, build, metadata, source_inputs, runtime_inputs)
    if separate or groups or any(node["emit_cdylib"] for node in nodes.values()):
        raise ValueError("Native protocol graph unexpectedly emitted shipping WASM")
    rows = []
    for context, keys in sorted(roots.items()):
        for key in keys:
            node = nodes[key]
            label = "//tools/bazel/rust/" + ("native_tpm" if recipe_set == "tpm" else "native_protocol") + ":u_" + key
            rows.append({"context": context, "label": label, "binary": label + "_binary" if node["mode"] == "test" else label,
                         "owner_manifest": packages[node["pkg_id"]]["manifest"], "mode": node["mode"], "target": node["target"], "features": node["features"], "profile": node["profile"]})
    checksums = units.locked_checksums(units.ROOT)
    archives = ['# Original selected Cargo lock archives; diagnostic catalog, not a duplicate MODULE include.\n',
                'native_protocol_archive = use_repo_rule("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")\n']
    for package_id in sorted({node["pkg_id"] for node in nodes.values()}):
        package = packages[package_id]
        if package["source"] is None:
            continue
        if package["source"] != REGISTRY:
            raise ValueError("Native compiler graph has an unsupported source registry")
        checksum = checksums[(package["name"], package["version"], package["source"])]
        archives.append('native_protocol_archive(name = ' + units.text(units.source_repository(package)) + ', urls = ' + units.text(['https://static.crates.io/crates/' + package['name'] + '/' + package['name'] + '-' + package['version'] + '.crate']) + ', sha256 = ' + units.text(checksum) + ', strip_prefix = ' + units.text(package['name'] + '-' + package['version']) + ', type = "tar.gz", build_file = "//tools/bazel/rust:crate_sources.BUILD.bazel")\n')
    root_aliases = "# Original source-bound native roots; complete four-platform qualification remains pending.\n" + ("NATIVE_TPM_ROOTS" if recipe_set == "tpm" else "NATIVE_PROTOCOL_ROOTS") + " = " + units.starlark(rows) + "\n"
    if recipe_set == "protocol":
        root_aliases += "NATIVE_PROTOCOL_BINDINGS = " + units.starlark(native_bindings(nodes, roots, packages)) + "\n"
    return {"BUILD.bazel": "".join(build), "graph.json": json.dumps({"nodes": nodes, "roots": roots}, indent=2, sort_keys=True) + "\n",
            "roots.bzl": root_aliases,
            "archives.MODULE.bazel": "".join(archives),
            **(oracle_sources(units, nodes, roots, packages, source_inputs) if recipe_set == "protocol" else {}),
            **{"contexts/" + document["package"] + ".json": json.dumps(document, indent=2, sort_keys=True) + "\n" for document in documents}}


def collect_documents(units, documents):
    with tempfile.TemporaryDirectory(prefix="native-protocol-contexts-") as temporary:
        paths = []
        for document in documents:
            path = Path(temporary) / (document["package"] + ".json")
            path.write_text(json.dumps(document, sort_keys=True))
            paths.append(path)
        return units.collect(paths)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["sdk-descriptor", "sdk-provenance", "sdk-resolver", "source-root", "contexts-helper", "unit-emitter", "metadata", "source-inputs", "runtime-inputs", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--context", type=Path, action="append")
    selection.add_argument("--capture", action="store_true")
    parser.add_argument("--producer", required=True)
    parser.add_argument("--recipe-set", choices=["protocol", "tpm"], default="protocol")
    parser.add_argument("--engine-precreated-tree-roots", action="store_true")
    args = parser.parse_args()
    resolver = load("declared_native_sdk", args.sdk_resolver)
    sdk = resolver.NativeCargoSdk.load(args.sdk_descriptor)
    try:
        root = sdk.original_tree(args.source_root)
        contexts = load("declared_native_contexts", args.contexts_helper)
        oracle_path = root / "tools/bazel/rust/native_oracle.py"
        oracle = load("original_native_session_oracle", oracle_path)
        tools = tool_facts(args.contexts_helper, oracle_path)
        provenance = json.loads(args.sdk_provenance.read_text())
        inputs = sources(sdk, root, provenance, args.sdk_descriptor, args.producer)
        scopes = ["tpm-native"] if args.recipe_set == "tpm" else RECIPES
        documents = [capture(scope, contexts, oracle, sdk, root, inputs, tools) for scope in scopes] if args.capture else [json.loads(path.read_text()) for path in args.context]
        validate_documents(documents, contexts, oracle, sdk, root, inputs, tools, args.recipe_set)
        sys.path.insert(0, str(args.unit_emitter.parent.resolve(strict=True)))
        units = load("declared_native_units", args.unit_emitter)
        units.ROOT, units.HERE, units.DEST = root, root / "tools/bazel/rust", root / "tools/bazel/rust/units"
        nodes, roots, packages = collect_documents(units, documents)
        selected_inputs(root, nodes, packages, args.metadata, args.source_inputs, args.runtime_inputs, inputs)
        bodies = emit(units, documents, nodes, roots, packages, args.metadata, args.source_inputs, args.runtime_inputs, args.recipe_set)
        if sources(sdk, root, provenance, args.sdk_descriptor, args.producer) != inputs or tools != tool_facts(args.contexts_helper, oracle_path):
            raise ValueError("Native source/tool Files changed during replay")
        if args.engine_precreated_tree_roots:
            if args.output.is_symlink():
                raise ValueError("Native output must be an ordinary declared TreeArtifact")
            args.output.mkdir(exist_ok=True)
            if list(args.output.iterdir()):
                raise ValueError("Native output must be an empty declared TreeArtifact")
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
