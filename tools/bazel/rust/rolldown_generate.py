#!/usr/bin/env python3
"""Emit native Rolldown actions from its retained original Cargo unit graph.

Only Cargo metadata/unit-graph acquisition uses Cargo. Product compilation uses
the same declared Rust compiler and build-script actions as the main workspace.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tomllib

NATIVE_HOSTS = {"aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"}
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared compiler graph emitter File")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def original_lock(archive, original):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != original["archive_sha256"]:
        raise ValueError("Rolldown emitter requires its exact original archive")
    with tarfile.open(archive, "r:gz") as source:
        def member(name):
            file = source.extractfile("rolldown-" + original["commit"] + "/" + name)
            if file is None:
                raise ValueError("original Rolldown configuration member absent")
            return tomllib.loads(file.read().decode())
        configuration = member(".cargo/config.toml")
        if configuration.get("env") != {"WORKSPACE_DIR": {"value": "", "relative": True}}:
            raise ValueError("unmodeled Rolldown configured compiler environment")
        return {(package["name"], package["version"], package["source"]): package["checksum"]
                for package in member("Cargo.lock")["package"] if "source" in package}


def repository_name(package):
    identity = json.dumps([package["name"], package["version"], package["source"]], separators=(",", ":"))
    return "merkur_rolldown_crate_" + hashlib.sha256(identity.encode()).hexdigest()


def effective_lto(nodes, roots):
    """Cargo1.97.1 compiler/lto.rs: propagate and merge actual output needs.

    A unit's profile is not its rustc LTO setting. In particular, host tools
    ignore profile LTO and a mixed rlib/cdylib root needs object and bitcode.
    Keep the original Cargo target types even when publishing only its cdylib.
    """
    result = {}

    def types(unit):
        return ["bin"] if unit["mode"] in {"test", "doctest"} else unit["target"]["crate_types"]

    def host(unit):
        return bool({"custom-build", "proc-macro"} & set(unit["target"]["kind"]))

    def needs_object(crate_types):
        return any(kind in {"bin", "staticlib", "cdylib", "dylib", "proc-macro"} for kind in crate_types)

    def when_needs_object(crate_types):
        return "object" if all(kind == "dylib" for kind in crate_types) else "object+bitcode"

    def visit(key, parent):
        unit = nodes[key]
        crate_types = types(unit)
        if host(unit):
            value = "object"
        elif all(kind in {"bin", "staticlib", "cdylib"} for kind in crate_types):
            profile = unit["profile"]["lto"]
            value = "object" if profile == "false" else "off" if profile == "off" else "run:" + profile
        elif parent.startswith("run:") and not needs_object(crate_types):
            value = "bitcode"
        elif parent in {"bitcode"} or parent.startswith("run:"):
            value = when_needs_object(crate_types) if needs_object(crate_types) else parent
        else:
            value = parent
        previous = result.get(key)
        if previous is not None and previous != value:
            if value.startswith("run:"):
                pass
            elif previous.startswith("run:"):
                value = previous
            elif "off" in {value, previous}:
                value = "off"
            else:
                value = "object+bitcode"
        if previous == value:
            return
        result[key] = value
        for edge in unit["dependencies"]:
            visit(edge["unit"], value)

    for key in sorted({key for context in roots.values() for key in context}):
        unit = nodes[key]
        profile = unit["profile"]["lto"]
        initial = "object" if profile == "false" else "off" if profile == "off" else "object" if host(unit) else when_needs_object(types(unit)) if needs_object(types(unit)) else "bitcode"
        visit(key, initial)
    return result


def compiler_profile_flags(unit, lto, units):
    # rules_rust defaults to embed-bitcode=no. Explicitly preserve Cargo's
    # default embedding for units whose graph requires bitcode.
    result = units.flags({**unit["profile"], "lto": "false"})
    if lto.startswith("run:"):
        result += ["-Clto=" + lto.removeprefix("run:"), "-Cembed-bitcode=yes"]
    elif lto == "off":
        result += ["-Clto=off", "-Cembed-bitcode=no"]
    elif lto == "bitcode":
        result += ["-Clinker-plugin-lto", "-Cembed-bitcode=yes"]
    else:
        result.append("-Cembed-bitcode=" + ("yes" if lto == "object+bitcode" else "no"))
    return result


def native_build(package, unit):
    if unit["mode"] != "run-custom-build" or package["name"] != "libmimalloc-sys2":
        return None
    if package["version"] != "0.1.60" or package["source"] != REGISTRY:
        raise ValueError("unmodeled Rolldown native allocator build dependency")
    return "cmake"


def emit(documents, archive, units, original, source_repository):
    checksums = original_lock(archive, original)
    for path in documents:
        document = json.loads(path.read_text())
        if document.get("original_source") != {key: original[key] for key in ["commit", "archive_sha256", "package_version"]}:
            raise ValueError("Rolldown compiler context lacks its original source identity")
        if document["package"] != "rolldown-binding" or set(document["contexts"]) - NATIVE_HOSTS:
            raise ValueError("unexpected Rolldown package or execution host")
        if any(set(profiles) != {"release"} for profiles in document["unit_graphs"].values()):
            raise ValueError("Rolldown binding requires the exact acquired release graph")
    nodes, roots, packages = units.collect(documents)
    for context, root_ids in roots.items():
        if len(root_ids) != 1:
            raise ValueError("Rolldown native binding has ambiguous Cargo roots")
        original = nodes[root_ids[0]]
        if original["pkg_id"] != "workspace:crates/rolldown_binding" or original["mode"] != "build" or "cdylib" not in original["target"]["crate_types"]:
            raise ValueError("Rolldown acquired root is not its native binding library")
        root = dict(original, emit_cdylib=True)
        root_key = units.key(root)
        nodes[root_key] = root
        del nodes[root_ids[0]]
        roots[context] = [root_key]
    lto = effective_lto(nodes, roots)
    registry = ["# Generated by tools/bazel/rust/rolldown_generate.py.\n",
                'rolldown_archive = use_repo_rule("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")\n']
    for package_id in sorted({unit["pkg_id"] for unit in nodes.values()}):
        package = packages[package_id]
        if package["source"] is None:
            continue
        if package["source"] != REGISTRY:
            raise ValueError("unsupported Rolldown source registry")
        digest = checksums.get((package["name"], package["version"], package["source"]))
        if not digest:
            raise ValueError("Rolldown configured package absent from original lock")
        registry.extend([
            "rolldown_archive(\n",
            "    name = " + units.text(repository_name(package)) + ",\n",
            "    urls = " + units.text(["https://static.crates.io/crates/" + package["name"] + "/" + package["name"] + "-" + package["version"] + ".crate"]) + ",\n",
            "    sha256 = " + units.text(digest) + ",\n",
            "    strip_prefix = " + units.text(package["name"] + "-" + package["version"]) + ",\n",
            '    type = "tar.gz",\n    build_file = "//tools/bazel/rust:crate_sources.BUILD.bazel",\n)\n',
        ])
    declarations = ["# Generated by tools/bazel/rust/rolldown_generate.py.\n",
                    'load("//tools/bazel/rust:rolldown.bzl", "rolldown_compiler_unit", "rolldown_build_script_unit", "rolldown_native_binding")\n\n',
                    "def declare_rolldown_units(sdk, compiler_context):\n"]
    for unit_key, unit in sorted(nodes.items()):
        package = packages[unit["pkg_id"]]
        first_party = package["source"] is None
        manifest = Path(package["manifest"]) if first_party else Path("Cargo.toml")
        prefix = "@" + source_repository + "//" + str(manifest.parent) if first_party else "@" + repository_name(package) + "//"
        root = unit["target"]["src_path"]
        if first_party:
            root = str(Path(root).relative_to(manifest.parent))
        deps, macros, aliases, macro_aliases = [], [], {}, {}
        script = None
        for edge in unit["dependencies"]:
            child = nodes[edge["unit"]]
            label = ":u_" + edge["unit"]
            if unit["mode"] == "run-custom-build" and child["target"]["kind"] == ["custom-build"] and child["mode"] == "build":
                if script is not None:
                    raise ValueError("duplicate Rolldown build-script compiler")
                script = label
                continue
            if "bin" in child["target"]["kind"]:
                raise ValueError("unmodeled Rolldown compiler binary helper")
            is_macro = "proc-macro" in child["target"]["kind"]
            (macros if is_macro else deps).append(label)
            if child["mode"] != "run-custom-build":
                (macro_aliases if is_macro else aliases)[label] = edge["extern_crate_name"]
        attrs = {
            "name": "u_" + unit_key, "crate_name": unit["target"]["name"].replace("-", "_"),
            "crate_root": prefix + ":" + root, "sources": prefix + ":rust_sources",
            "compile_data": prefix + ":package_data", "manifest": prefix + ":Cargo.toml",
            "edition": unit["target"]["edition"], "version": package["version"],
            "crate_features": unit["features"], "deps": deps, "proc_macro_deps": macros,
            "aliases": aliases, "proc_macro_aliases": macro_aliases,
            "rustc_flags": compiler_profile_flags(unit, lto[unit_key], units) + ["--check-cfg=cfg(feature,values(" + ",".join(units.text(feature) for feature in sorted(package["features"])) + "))"],
            "kind": unit["target"]["kind"], "mode": unit["mode"],
            "platform": unit["platform"] or unit["execution_host"], "execution_host": unit["execution_host"],
            "first_party": first_party, "lint_owned": first_party,
            "cargo_env": {"CARGO_PKG_NAME": package["name"], "CARGO_PKG_AUTHORS": ":".join(package.get("authors", [])),
                          "CARGO_PKG_DESCRIPTION": package.get("description") or "", "CARGO_PKG_HOMEPAGE": package.get("homepage") or "",
                          "CARGO_PKG_REPOSITORY": package.get("repository") or "", "CARGO_PKG_LICENSE": package.get("license") or "",
                          "CARGO_PKG_RUST_VERSION": package.get("rust_version") or ""},
            "rust_flags": unit["rust_flags"], "emit_cdylib": unit["emit_cdylib"],
            "crate_types": unit["target"]["crate_types"], "compiler_env": unit.get("compiler_env", {}),
        }
        if source_repository != "merkur_rolldown_source":
            attrs["source_manifest"] = "@" + source_repository + "//:Cargo.toml"
        if unit["mode"] == "run-custom-build":
            if script is None:
                raise ValueError("missing Rolldown build-script compiler")
            attrs.update(script=script, pkg_name=package["name"], links=package["links"], profile=unit["profile"])
            attrs["compiler_env"] = {**attrs["compiler_env"], **units.custom_cfg_env(unit["rust_flags"])}
            attrs["native_build"] = native_build(package, unit)
        elif unit["mode"] != "build":
            raise ValueError("unexpected mode in release Rolldown graph")
        rule = "rolldown_build_script_unit" if unit["mode"] == "run-custom-build" else "rolldown_compiler_unit"
        declarations.append("    " + rule + "(\n")
        for name, value in attrs.items():
            if value is not None:
                declarations.append("        " + name + " = " + units.starlark(value) + ",\n")
        declarations.append("    )\n")
    for context, root_ids in sorted(roots.items()):
        host = context.rsplit("/", 1)[1]
        declarations.append("    rolldown_native_binding(name = " + units.text("binding_" + units.identifier(host)) +
                            ", library = " + units.text(":u_" + root_ids[0]) + ", platform = " + units.text(host) +
                            ", sdk = sdk, compiler_context = compiler_context, tags = [\"manual\"])\n")
    return "".join(declarations), "".join(registry)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, action="append", required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--module-output", type=Path, required=True)
    for name in ["units", "parity", "licenses", "native-receipts"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--source-instances", type=Path, required=True)
    parser.add_argument("--source-instance", required=True)
    parser.add_argument("--source-repository", required=True)
    args = parser.parse_args()
    original = json.loads(args.source_instances.read_text())[args.source_instance]
    load_module("configured_parity", args.parity)
    load_module("license_metadata", args.licenses)
    load_module("native_receipts", args.native_receipts)
    units = load_module("declared_rolldown_units", args.units)
    declarations, registries = emit(args.context, args.archive, units, original, args.source_repository)
    args.output.write_text(declarations)
    args.module_output.write_text(registries)


if __name__ == "__main__":
    main()
