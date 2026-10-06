#!/usr/bin/env python3
"""Check exact Cargo compiler contexts and the emitted Bazel rule boundary.

This checks retained Cargo unit graphs, not aggregate metadata feature unions.
It does not qualify compilation, remote execution, or platform toolchains.
"""
import ast
import json
from pathlib import Path


RULES = {"compiler_unit", "build_script_unit", "doctest_unit"}


def validate_document(document):
    packages = {}
    for context in document["contexts"].values():
        for package in context["packages"]:
            previous = packages.setdefault(package["id"], package)
            if previous != package:
                raise ValueError("conflicting Cargo package facts: " + package["id"])
    for triple, profiles in document["unit_graphs"].items():
        for profile, graph in profiles.items():
            if type(graph["version"]) is not int or graph["version"] != 1:
                raise ValueError("unsupported Cargo unit graph version")
            units = graph["units"]
            if not units or not graph["roots"] or len(set(graph["roots"])) != len(graph["roots"]):
                raise ValueError("empty or duplicated Cargo compiler roots")

            def index(value):
                if type(value) is not int or not 0 <= value < len(units):
                    raise ValueError("invalid Cargo compiler unit index")
                return value

            for root in graph["roots"]:
                index(root)
            for unit in units:
                package = packages.get(unit["pkg_id"])
                if package is None:
                    raise ValueError("Cargo unit has no package facts")
                features = unit["features"]
                if features != sorted(set(features)) or any(feature not in package["features"] for feature in features):
                    raise ValueError("Cargo compiler feature set is invalid")
                if unit["mode"] not in {"build", "check", "test", "doctest", "run-custom-build"}:
                    raise ValueError("unsupported Cargo compiler mode")
                if unit["platform"] not in {None, triple, graph["execution_host"]}:
                    raise ValueError("Cargo unit escaped its host/target context")
                if "proc-macro" in unit["target"]["kind"] and unit["platform"] is not None:
                    raise ValueError("Cargo procedural macro must compile in its host context")
                edges = unit["dependencies"]
                edge_ids = [index(edge["index"]) for edge in edges]
                if len(edge_ids) != len(set(edge_ids)):
                    raise ValueError("duplicated Cargo compiler dependency")
                for edge in edges:
                    # These bits change rustc's extern semantics. The emitter has
                    # no implementation for them, so accepting them loses parity.
                    if any(type(edge[flag]) is not bool or edge[flag] for flag in ["noprelude", "nounused", "public"]):
                        raise ValueError("unsupported Cargo extern dependency semantics")
                    if not isinstance(edge["extern_crate_name"], str) or not edge["extern_crate_name"]:
                        raise ValueError("Cargo compiler dependency lacks its extern name")
                if unit["mode"] == "run-custom-build":
                    scripts = [units[i] for i in edge_ids if units[i]["target"]["kind"] == ["custom-build"] and units[i]["mode"] == "build"]
                    if len(scripts) != 1 or scripts[0]["pkg_id"] != unit["pkg_id"]:
                        raise ValueError("Cargo build-script execution has no unique matching compiler unit")
            active, complete = set(), set()

            def visit(unit_index):
                if unit_index in active:
                    raise ValueError("cycle in Cargo compiler units")
                if unit_index in complete:
                    return
                active.add(unit_index)
                for edge in units[unit_index]["dependencies"]:
                    visit(edge["index"])
                active.remove(unit_index)
                complete.add(unit_index)

            for unit_index in range(len(units)):
                visit(unit_index)
    return packages


def validate_documents(documents, native_documents=()):
    """Permit only the explicitly acquired native replacement contexts."""
    replacements = set()
    packages, contexts, original_contexts = {}, set(), set()
    for document in native_documents:
        for triple, profiles in document["unit_graphs"].items():
            for profile in profiles:
                identity = document["package"], profile, triple
                if identity in replacements:
                    raise ValueError("duplicated native Cargo replacement context")
                replacements.add(identity)
    for native, documents_group in [(False, documents), (True, native_documents)]:
        for document in documents_group:
            for package_id, package in validate_document(document).items():
                if packages.setdefault(package_id, package) != package:
                    raise ValueError("conflicting Cargo package facts: " + package_id)
            for triple, profiles in document["unit_graphs"].items():
                for profile in profiles:
                    identity = document["package"], profile, triple
                    if not native:
                        if identity in original_contexts:
                            raise ValueError("duplicated configured Cargo compiler context")
                        original_contexts.add(identity)
                        if identity in replacements:
                            continue
                    if identity in contexts:
                        raise ValueError("duplicated configured Cargo compiler context")
                    contexts.add(identity)
    return packages


def read_declarations(paths):
    """Parse compiler calls with Python's literal AST; never execute Starlark."""
    declarations = {}
    for path in paths:
        lines = iter(path.read_text().splitlines())
        for line in lines:
            if line not in {rule + "(" for rule in RULES}:
                continue
            body = [line]
            for line in lines:
                body.append(line)
                if line == ")":
                    break
            call = ast.parse("\n".join(body), mode="eval").body
            if not isinstance(call, ast.Call) or call.args:
                raise ValueError("invalid emitted Cargo compiler declaration")
            attributes = {argument.arg: ast.literal_eval(argument.value) for argument in call.keywords}
            if len(attributes) != len(call.keywords) or None in attributes:
                raise ValueError("ambiguous emitted Cargo compiler attributes")
            name = attributes["name"]
            unit = path.parent.name if name == "cdylib" else name.removeprefix("u_")
            if unit in declarations:
                raise ValueError("duplicated emitted Cargo compiler declaration")
            declarations[unit] = (call.func.id, attributes)
    return declarations


def compiler_environment(unit):
    expected = dict(unit.get("compiler_env", {}))
    if unit["mode"] != "run-custom-build":
        return expected
    declarations = {}
    flags = iter(unit["rust_flags"])
    for flag in flags:
        if flag == "--cfg":
            declaration = next(flags, None)
            if declaration is None:
                raise ValueError("Cargo cfg flag lacks its declaration")
        elif flag.startswith("--cfg="):
            declaration = flag[6:]
        else:
            continue
        name, separator, encoded = declaration.partition("=")
        if not name.isidentifier() or not name.isascii():
            raise ValueError("unsupported Cargo cfg declaration")
        values = declarations.setdefault("CARGO_CFG_" + name.upper(), [])
        if separator:
            value = json.loads(encoded)
            if not isinstance(value, str):
                raise ValueError("unsupported Cargo cfg value")
            if value not in values:
                values.append(value)
    expected.update({name: ",".join(values) for name, values in declarations.items()})
    return expected


def check_declarations(nodes, declarations):
    if set(nodes) != set(declarations):
        raise ValueError("Cargo/Bazel compiler unit inventory differs")
    for identity, unit in nodes.items():
        rule, attrs = declarations[identity]
        expected_rule = {"run-custom-build": "build_script_unit", "doctest": "doctest_unit"}.get(unit["mode"], "compiler_unit")
        expected = {
            "crate_name": unit["target"]["name"].replace("-", "_"),
            "edition": unit["target"]["edition"], "crate_features": unit["features"],
            "kind": unit["target"]["kind"], "crate_types": unit["target"]["crate_types"],
            "mode": unit["mode"], "platform": unit["platform"] or unit["execution_host"],
            "execution_host": unit["execution_host"], "rust_flags": unit["rust_flags"],
            "profile_data": unit.get("profile_data", []),
            "compiler_env": compiler_environment(unit),
            "semantic_metadata": unit.get("semantic_metadata", ""),
            "emit_cdylib": unit["emit_cdylib"],
        }
        if rule != expected_rule:
            raise ValueError("Cargo/Bazel compiler rule differs: " + identity)
        for field, value in expected.items():
            if attrs[field] != value:
                raise ValueError("Cargo/Bazel " + field + " differs: " + identity)
        prefix = "//tools/bazel/rust/units:" if unit["emit_cdylib"] else ":"
        deps, macros, aliases, macro_aliases, helpers = [], [], {}, {}, {}
        for edge in unit["dependencies"]:
            child = nodes[edge["unit"]]
            label = prefix + "u_" + edge["unit"]
            if unit["mode"] == "doctest" and child["pkg_id"] == unit["pkg_id"] and child["target"]["src_path"] == unit["target"]["src_path"] and child["mode"] == "build":
                if attrs["crate"] != label:
                    raise ValueError("Cargo/Bazel doctest library dependency differs")
            if unit["mode"] == "run-custom-build" and child["target"]["kind"] == ["custom-build"] and child["mode"] == "build":
                if attrs["script"] != label:
                    raise ValueError("Cargo/Bazel build-script compiler dependency differs")
                continue
            if unit["mode"] == "doctest" and child["mode"] == "run-custom-build":
                continue
            if child["target"]["kind"] == ["bin"]:
                helpers[child["target"]["name"]] = label
                continue
            macro = "proc-macro" in child["target"]["kind"]
            (macros if macro else deps).append(label)
            if child["mode"] != "run-custom-build":
                (macro_aliases if macro else aliases)[label] = edge["extern_crate_name"]
        for field, value in {"deps": deps, "proc_macro_deps": macros, "aliases": aliases, "proc_macro_aliases": macro_aliases, "binary_helpers": helpers}.items():
            if attrs[field] != value:
                raise ValueError("Cargo/Bazel " + field + " differs: " + identity)
        if unit["mode"] == "run-custom-build" and attrs["profile"] != unit["profile"]:
            raise ValueError("Cargo/Bazel build-script profile differs")
    return len(nodes)


def profile_flags(profile):
    options = {
        "opt-level": profile["opt_level"], "debuginfo": str(profile["debuginfo"]),
        "debug-assertions": "yes" if profile["debug_assertions"] else "no",
        "overflow-checks": "yes" if profile["overflow_checks"] else "no",
    }
    if profile["panic"] != "unwind":
        options["panic"] = profile["panic"]
    for field in ["codegen_units", "split_debuginfo"]:
        if profile.get(field) is not None:
            options[field.replace("_", "-")] = str(profile[field])
    if profile["lto"] not in {"false", "off"}:
        options["lto"] = profile["lto"]
    if profile["rpath"]:
        options["rpath"] = "yes"
    strip = profile.get("strip", {}).get("resolved", "None")
    if strip != "None":
        options["strip"] = strip["Named"]
    if profile.get("codegen_backend") is not None:
        raise ValueError("unsupported Cargo codegen backend")
    return ["-C" + name + "=" + value for name, value in options.items()]


def check_profile_flags(nodes, packages, declarations):
    for identity, unit in nodes.items():
        features = sorted(packages[unit["pkg_id"]]["features"])
        declared = "--check-cfg=cfg(feature,values(" + ",".join(json.dumps(feature) for feature in features) + "))"
        if declarations[identity][1]["rustc_flags"] != profile_flags(unit["profile"]) + [declared]:
            raise ValueError("Cargo/Bazel profile flags differ: " + identity)


def source_path(label):
    if not label.startswith("//") or ":" not in label:
        raise ValueError("Cargo source input is not a first-party File label")
    package, filename = label[2:].split(":", 1)
    path = Path(package) / filename
    if not filename or path.is_absolute() or ".." in path.parts:
        raise ValueError("Cargo source input escaped the declared workspace")
    return path.as_posix()


def check_action_inputs(root, nodes, packages, declarations):
    here = root / "tools/bazel/rust"
    macros = json.loads((here / "source_inputs.json").read_text())["macros"]
    runtime = json.loads((here / "runtime_inputs.json").read_text())
    for identity, unit in nodes.items():
        package = packages[unit["pkg_id"]]
        attrs = declarations[identity][1]
        if package["source"] is None:
            prefix = "//" + str(Path(package["manifest"]).parent)
            if source_path(attrs["crate_root"]) != unit["target"]["src_path"]:
                raise ValueError("Cargo/Bazel declared crate_root differs: " + identity)
            crate_root = attrs["crate_root"]
        else:
            repository = "merkur_rust_source_" + (package["name"] + "_" + package["version"])
            for character in [":", "-", ".", "+"]:
                repository = repository.replace(character, "_")
            prefix = "@" + repository + "//"
            crate_root = prefix + ":" + unit["target"]["src_path"]
        expected = {
            "sources": prefix + ":rust_sources", "compile_data": prefix + ":package_data",
            "manifest": prefix + ":Cargo.toml", "crate_root": crate_root,
            "version": package["version"], "first_party": package["source"] is None,
            "cargo_env": {
                "CARGO_PKG_NAME": package["name"], "CARGO_PKG_AUTHORS": ":".join(package.get("authors", [])),
                "CARGO_PKG_DESCRIPTION": package.get("description") or "",
                "CARGO_PKG_HOMEPAGE": package.get("homepage") or "",
                "CARGO_PKG_REPOSITORY": package.get("repository") or "",
                "CARGO_PKG_LICENSE": package.get("license") or "",
                "CARGO_PKG_RUST_VERSION": package.get("rust_version") or "",
            },
            "runtime_tools": {"MERKUR_BROWSER_REGISTRATION_ORACLE": "//packages/merkur-client-native:browser_registration_oracle"} if package["name"] == "merkur-client-native" and unit["mode"] == "test" else {},

        }
        for field, value in expected.items():
            if attrs[field] != value:
                raise ValueError("Cargo/Bazel declared " + field + " differs: " + identity)
        for field, paths in {
            "macro_data": sorted(set(macros.get(package.get("manifest"), []) + unit.get("diagnostic_macro_inputs", []))),
            "runtime_data": runtime.get(package["name"], []) if unit["mode"] == "test" else [],
        }.items():
            if [source_path(label) for label in attrs[field]] != paths:
                raise ValueError("Cargo/Bazel declared " + field + " differs: " + identity)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).absolute().parents[3])
    args = parser.parse_args()
    root = args.root.absolute()
    here = root / "tools/bazel/rust"
    # The generator's native receipt loader already verifies the original-file
    # compiler/SDK custody; use it rather than introducing another receipt.
    import sys
    sys.path.insert(0, str(here))
    import native_receipts
    import units
    native_receipts.ROOT = root
    native_receipts.DIRECTORY = here / "native_contexts"
    paths = sorted((here / "contexts").glob("*/*/*/metadata.json"))
    paths += [path for directory in ["diagnostics/bolero", "diagnostics/oracles"] for path in sorted((here / directory).glob("*.json"))]
    native_paths = native_receipts.load()
    nodes, roots, packages = units.collect(paths, native_paths)
    units.terminal_variants(nodes, roots)
    if json.loads((here / "units/graph.json").read_text()) != {"nodes": nodes, "roots": roots}:
        raise ValueError("Retained Bazel units differ from the exact Cargo compiler contexts")
    declarations = read_declarations([here / "units/BUILD.bazel", *sorted((here / "units").glob("*/BUILD.bazel"))])
    check_declarations(nodes, declarations)
    check_profile_flags(nodes, packages, declarations)
    check_action_inputs(root, nodes, packages, declarations)
    print(f"Configured Cargo/Bazel parity checked: {len(nodes)} compiler units")


if __name__ == "__main__":
    main()
