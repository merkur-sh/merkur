"""Emit cargo-audit's actual captured compiler units through native Rust rules."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("Missing declared cargo-audit graph implementation")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def dependencies(unit, nodes, packages):
    deps, macros, aliases, macro_aliases, linked_scripts = [], [], {}, {}, []
    script = None
    for edge in unit["dependencies"]:
        child = nodes[edge["unit"]]
        label = ":u_" + edge["unit"]
        if unit["mode"] == "run-custom-build" and child["mode"] == "build" and child["target"]["kind"] == ["custom-build"]:
            if script is not None or child["pkg_id"] != unit["pkg_id"]:
                raise ValueError("Invalid cargo-audit build-script compiler")
            script = label
            continue
        if unit["mode"] == "run-custom-build" and child["mode"] == "run-custom-build":
            if not packages[child["pkg_id"]]["links"] or child["pkg_id"] == unit["pkg_id"]:
                raise ValueError("Cargo build-script metadata edge lacks a linked dependency")
            linked_scripts.append(label)
            continue
        if "bin" in child["target"]["kind"]:
            raise ValueError("Unmodeled cargo-audit compiler binary helper")
        macro = "proc-macro" in child["target"]["kind"]
        (macros if macro else deps).append(label)
        if child["mode"] != "run-custom-build":
            (macro_aliases if macro else aliases)[label] = edge["extern_crate_name"]
    return deps, macros, aliases, macro_aliases, script, linked_scripts


def emit(documents, archive, original, units, lto):
    files, catalog = original.original(archive)
    locks = {(entry["name"], entry["version"]): entry["sha256"] for entry in catalog}
    expected = original.document(archive)
    if not documents:
        raise ValueError("cargo-audit requires an actual captured native compiler context")
    for filename in documents:
        value = json.loads(filename.read_text())
        if value["package"] != "cargo-audit" or value["original_source"] != {
            "name": original.NAME, "version": original.VERSION, "archive_sha256": original.SHA256,
            "cargo_lock_sha256": expected["source_files"]["Cargo.lock"]["sha256"],
        }:
            raise ValueError("cargo-audit compiler context lacks its exact original archive")
        if value["inputs"] != {path: fact["sha256"] for path, fact in expected["source_files"].items()}:
            raise ValueError("cargo-audit compiler source membership differs")
        if value.get("mode") != "release" or value.get("platform") != "native" or not value["contexts"] or set(value["contexts"]) != set(value["unit_graphs"]):
            raise ValueError("cargo-audit executable requires its original native release graph")
        if set(value["contexts"]) - {"aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"}:
            raise ValueError("Unsupported cargo-audit native host")
        if any(set(profiles) != {"release"} for profiles in value["unit_graphs"].values()):
            raise ValueError("cargo-audit executable requires its original release graph")
    nodes, roots, packages = units.collect(documents)
    for package in packages.values():
        if package["source"] is not None and (package["source"] != original.REGISTRY or (package["name"], package["version"]) not in locks):
            raise ValueError("cargo-audit configured package is absent from its original lock")
    binaries = {}
    for context, identifiers in roots.items():
        root = original.native_binary([nodes[identifier] for identifier in identifiers])
        binaries[context] = next(identifier for identifier in identifiers if nodes[identifier] is root)
    states = lto.effective_lto(nodes, roots)
    result = ['# Generated from original cargo-audit locked native compiler contexts.\n',
              '# Context SHA256: ' + ', '.join(sorted(hashlib.sha256(path.read_bytes()).hexdigest() for path in documents)) + '\n',
              'load("//tools/bazel/rust:units.bzl", "compiler_unit", "build_script_unit", "build_script_metadata")\n\n',
              'def declare_audit_units():\n']
    for key, unit in sorted(nodes.items()):
        package = packages[unit["pkg_id"]]
        owned = package["source"] is None
        prefix = "@" + original.REPOSITORY + "//" + ("source" if owned else "registry/" + package["name"] + "-" + package["version"])
        deps, macros, aliases, macro_aliases, script, linked_scripts = dependencies(unit, nodes, packages)
        metadata = []
        for index, linked in enumerate(linked_scripts):
            name = "u_" + key + "__links_" + str(index)
            result.append("    build_script_metadata(name = " + units.text(name) + ", build_script = " + units.text(linked) + ", tags = [\"manual\"])\n")
            metadata.append(":" + name)
        attrs = {
            "name": "u_" + key, "crate_name": unit["target"]["name"].replace("-", "_"),
            "crate_root": prefix + ":" + unit["target"]["src_path"], "sources": prefix + ":rust_sources",
            "compile_data": prefix + ":package_data", "manifest": prefix + ":Cargo.toml",
            "edition": unit["target"]["edition"], "version": package["version"],
            "crate_features": unit["features"], "deps": deps, "proc_macro_deps": macros,
            "aliases": aliases, "proc_macro_aliases": macro_aliases,
            "rustc_flags": lto.compiler_profile_flags(unit, states[key], units) + ["--check-cfg=cfg(docsrs,test)", "--check-cfg=cfg(feature,values(" + ",".join(units.text(feature) for feature in sorted(package["features"])) + "))"],
            "kind": unit["target"]["kind"], "mode": unit["mode"],
            "platform": unit["platform"] or unit["execution_host"], "execution_host": unit["execution_host"],
            "first_party": owned, "lint_owned": owned,
            "cargo_env": {"CARGO_PKG_NAME": package["name"], "CARGO_PKG_AUTHORS": ":".join(package.get("authors", [])),
                          "CARGO_PKG_DESCRIPTION": package.get("description") or "", "CARGO_PKG_HOMEPAGE": package.get("homepage") or "",
                          "CARGO_PKG_REPOSITORY": package.get("repository") or "", "CARGO_PKG_LICENSE": package.get("license") or "",
                          "CARGO_PKG_RUST_VERSION": package.get("rust_version") or ""},
            "rust_flags": unit["rust_flags"], "emit_cdylib": unit["emit_cdylib"],
            "crate_types": unit["target"]["crate_types"], "compiler_env": unit.get("compiler_env", {}),
        }
        if unit["mode"] == "run-custom-build":
            if script is None:
                raise ValueError("Missing cargo-audit build-script compiler")
            attrs.update(script=script, pkg_name=package["name"], links=package["links"], profile=unit["profile"])
            if metadata:
                attrs.update(build_script_env_files=metadata, build_data=metadata)
            attrs["compiler_env"] = {**attrs["compiler_env"], **units.custom_cfg_env(unit["rust_flags"])}
        elif unit["mode"] != "build":
            raise ValueError("Unexpected cargo-audit release compiler mode")
        result.append("    " + ("build_script_unit" if unit["mode"] == "run-custom-build" else "compiler_unit") + "(\n")
        for name, value in attrs.items():
            if value is not None:
                result.append("        " + name + " = " + units.starlark(value) + ",\n")
        result.append("    )\n")
    choices = {}
    constraints = {"aarch64-apple-darwin": ["@platforms//os:macos", "@platforms//cpu:aarch64"], "x86_64-apple-darwin": ["@platforms//os:macos", "@platforms//cpu:x86_64"], "aarch64-unknown-linux-gnu": ["@platforms//os:linux", "@platforms//cpu:aarch64"], "x86_64-unknown-linux-gnu": ["@platforms//os:linux", "@platforms//cpu:x86_64"]}
    for context, identifiers in sorted(roots.items()):
        host = context.rsplit("/", 1)[1]
        setting = "host_" + units.identifier(host)
        result.append("    native.config_setting(name = " + units.text(setting) + ", constraint_values = " + units.starlark(constraints[host]) + ")\n")
        choices[":" + setting] = ":u_" + binaries[context]
    # No default: a missing host capture refuses rather than choosing a foreign executable.
    result.append('    native.alias(name = "cargo_audit", actual = select(' + units.starlark(choices) + '), visibility = ["//visibility:public"])\n')
    return "".join(result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, action="append", required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    for name in ["original", "units", "lto", "parity", "licenses", "native-receipts"]:
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    load("configured_parity", args.parity)
    load("license_metadata", args.licenses)
    load("native_receipts", args.native_receipts)
    units = load("audit_units", args.units)
    original = load("audit_original", args.original)
    lto = load("audit_lto", args.lto)
    value = emit(args.context, args.archive, original, units, lto)
    args.output.write_text(value)


if __name__ == "__main__":
    main()
