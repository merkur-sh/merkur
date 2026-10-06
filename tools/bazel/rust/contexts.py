#!/usr/bin/env python3
"""Resolve independent configured Cargo roots without building or upgrading.

The production lock seeds each generated context. A scoped lock refresh may
remove irrelevant package edges, but every resolved source/version/checksum must
already occur in that production lock. Ordinary checking performs no resolution.
"""
import argparse
import copy
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

_sdk_spec = importlib.util.spec_from_file_location("merkur_acquisition_sdk", Path(__file__).with_name("acquisition_sdk.py"))
if _sdk_spec is None or _sdk_spec.loader is None:
    raise ValueError("missing declared acquisition SDK resolver File")
_sdk_module = importlib.util.module_from_spec(_sdk_spec)
_sdk_spec.loader.exec_module(_sdk_module)
NativeCargoSdk = _sdk_module.NativeCargoSdk


ROOT = Path(__file__).resolve().parents[3]
DIRECTORY = ROOT / "tools/bazel/rust/contexts"
NATIVE = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]
WASM = ["wasm32-unknown-unknown"]
SIMULATOR_FLAGS = ["--cfg", "merkur_sim", "--cfg", "tokio_unstable"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def toml_text(mapping, prefix=()):
    """Serialize manifest data deterministically, retaining TOML table structure."""
    lines = []
    for key, value in sorted(mapping.items()):
        if not isinstance(value, dict) and not (isinstance(value, list) and value and isinstance(value[0], dict)):
            lines.append(json.dumps(key) + " = " + json.dumps(value, ensure_ascii=False))
    for key, value in sorted(mapping.items()):
        name = (*prefix, key)
        header = ".".join(json.dumps(part) for part in name)
        if isinstance(value, dict):
            lines += ["", "[" + header + "]", toml_text(value, name)]
        elif isinstance(value, list) and value and isinstance(value[0], dict):
            for entry in value:
                lines += ["", "[[" + header + "]]", toml_text(entry, name)]
    return "\n".join(lines)


def package_manifests():
    workspace = tomllib.loads((ROOT / "Cargo.toml").read_text())
    return workspace, [ROOT / path / "Cargo.toml" for path in workspace["workspace"]["members"]]


def manifest_for(original, destination, mode, workspace):
    data = copy.deepcopy(tomllib.loads(original.read_text()))
    # Source compilation continues to use the original first-party source roots.
    # These manifests are dependency-resolution inputs only.
    source_root = original.parent
    data.pop("lints", None)
    data["workspace"] = {"resolver": workspace["workspace"]["resolver"]}
    data["profile"] = copy.deepcopy(workspace.get("profile", {}))
    # A scoped resolution root must preserve Cargo's workspace-member profile
    # exemption. In the isolated workspace, original members become path deps;
    # explicit package profiles prevent the external `*` override applying.
    for member in workspace["workspace"]["members"]:
        name = tomllib.loads((ROOT / member / "Cargo.toml").read_text())["package"]["name"]
        for profile, opt, debug in [("dev", 0, 2), ("test", 1, "line-tables-only")]:
            value = data["profile"].setdefault(profile, {}).setdefault("package", {}).setdefault(name, {})
            value.setdefault("opt-level", opt)
            value.setdefault("debug", debug)
    data["patch"] = copy.deepcopy(workspace.get("patch", {}))
    for dependencies in data["patch"].values():
        for spec in dependencies.values():
            if isinstance(spec, dict) and "path" in spec:
                spec["path"] = os.path.relpath(ROOT / spec["path"], destination)
    if (source_root / "build.rs").exists():
        data["package"]["build"] = os.path.relpath(source_root / "build.rs", destination)
    for target_kind, default_source in [("lib", "src/lib.rs"), ("bin", "src/main.rs")]:
        source = source_root / default_source
        if target_kind == "lib" and ("lib" in data or source.exists()):
            value = data.setdefault("lib", {})
            value["path"] = os.path.relpath(source_root / value.get("path", default_source), destination)
        elif target_kind == "bin" and source.exists() and "bin" not in data:
            data["bin"] = [{"name": data["package"]["name"], "path": os.path.relpath(source, destination)}]
    for target_kind in ["bin", "bench", "example", "test"]:
        for value in data.get(target_kind, []):
            name = value["name"]
            if target_kind == "bin":
                default = "src/bin/" + name + ".rs"
            else:
                default = {"bench": "benches", "example": "examples", "test": "tests"}[target_kind] + "/" + name + ".rs"
            path = value.get("path", default)
            # The automatically synthesized main target already has a rewritten path.
            if not path.startswith("../") or (source_root / path).exists():
                value["path"] = os.path.relpath(source_root / path, destination)
    # Cargo discovers targets relative to the manifest. An isolated metadata
    # root has no copied source tree, so materialize the exact original targets
    # instead of silently losing automatically discovered integration suites.
    inventory = json.loads((ROOT / "tools/bazel/rust/metadata.json").read_text())
    owning = next(package for package in inventory["packages"] if package.get("manifest") == str(original.relative_to(ROOT)))
    for target_kind, autodiscover in [("bin", "autobins"), ("bench", "autobenches"), ("example", "autoexamples"), ("test", "autotests")]:
        data["package"][autodiscover] = False
        existing = {target["name"]: target for target in data.get(target_kind, [])}
        targets = []
        for target in owning["targets"]:
            if target_kind not in target["kind"]:
                continue
            value = copy.deepcopy(existing.get(target["name"], {}))
            value["name"] = target["name"]
            value["path"] = os.path.relpath(ROOT / target["source"], destination)
            if target["required_features"]:
                value["required-features"] = target["required_features"]
            targets.append(value)
        if targets:
            data[target_kind] = targets
        else:
            data.pop(target_kind, None)
    def rewrite_dependencies(table):
        if mode == "build":
            table.pop("dev-dependencies", None)
        for kind in ["dependencies", "dev-dependencies", "build-dependencies"]:
            for dependency in table.get(kind, {}).values():
                if isinstance(dependency, dict) and "path" in dependency:
                    dependency["path"] = os.path.relpath(source_root / dependency["path"], destination)
    rewrite_dependencies(data)
    for target in data.get("target", {}).values():
        rewrite_dependencies(target)
    return toml_text(data) + "\n"


def resolve(manifest, triple, version, refresh, features=(), *, sdk, rust_flags=(), no_default_features=False):
    env = sdk.environment()
    if rust_flags:
        env.pop("CARGO_ENCODED_RUSTFLAGS", None)
        env["RUSTFLAGS"] = " ".join(rust_flags)
    # This inventory is deliberately unfiltered: target filtering discards host
    # build/proc-macro packages that the exact unit graph still needs.
    args = sdk.command("cargo", version) + ["metadata", "--offline", "--format-version=1", "--manifest-path", str(manifest)]
    if not refresh:
        args.append("--locked")
    if no_default_features:
        args.append("--no-default-features")
    if features:
        args += ["--features", ",".join(features)]
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


def normalize(raw, original, context_manifest):
    ids = {}
    for package in raw["packages"]:
        if package["source"] is None:
            manifest = Path(package["manifest_path"])
            if manifest == context_manifest:
                manifest = original
            ids[package["id"]] = "workspace:" + str(manifest.parent.relative_to(ROOT))
        else:
            ids[package["id"]] = package["id"]
    packages = []
    for package in raw["packages"]:
        entry = {key: package[key] for key in ["name", "version", "source", "edition", "features", "links", "authors", "description", "homepage", "repository", "license", "rust_version"]}
        entry["id"] = ids[package["id"]]
        if package["source"] is None:
            manifest = Path(package["manifest_path"])
            if manifest == context_manifest:
                manifest = original
            entry["manifest"] = str(manifest.relative_to(ROOT))
            entry["targets"] = [{"name": target["name"], "kind": target["kind"], "source": str(Path(target["src_path"]).resolve().relative_to(ROOT))} for target in package["targets"]]
        packages.append(entry)
    return {
        "root": ids[raw["resolve"]["root"]] if raw["resolve"]["root"] else "workspace:.",
        "members": [ids[member] for member in raw["workspace_members"]],
        "packages": sorted(packages, key=lambda package: package["id"]),
    }


def effective_target_flags(cwd, triple, version, env, *, sdk):
    """Capture Cargo 1.97.1's target flags without compiling a product unit.

    Cargo joins literal-triple flags before sorted matching cfg flags, falls
    back to build flags when that list is empty, and lets encoded/plain flag
    environment variables replace both. The cfg query uses the selected Rust
    flags, including Cargo's two-query fixed-point resolution. Nonconvergent
    or compound predicates are refused rather than captured inaccurately.
    """
    cargo = sdk.command("cargo", version) + ["-Z", "unstable-options", "config", "get"]
    result = subprocess.run(cargo + ["--format", "json"], cwd=cwd, env=env, check=True, capture_output=True, text=True)
    configuration = json.loads(result.stdout)
    if not isinstance(configuration, dict):
        raise ValueError("Cargo configuration must be a table")
    if "host" in configuration or configuration.get("target-applies-to-host") is False:
        raise ValueError("host-specific Cargo flags need a distinct host capture")
    target = configuration.get("target", {})
    build = configuration.get("build", {})
    if not isinstance(target, dict) or not isinstance(build, dict):
        raise ValueError("Cargo target and build configuration must be tables")
    target = {key: dict(value) if isinstance(value, dict) else value for key, value in target.items()}
    build = dict(build)
    # `config get` on a table deliberately does not merge environment leaves.
    # Query only declared flag overrides as leaves, letting Cargo own StringList
    # merging rather than reimplementing its environment/config precedence.
    for name in ["rustflags", "rustdocflags"]:
        suffix = name.upper()
        for key, table in [("build", build), ("target." + triple, target.setdefault(triple, {}))]:
            environment_key = "CARGO_" + key.replace(".", "_").replace("-", "_").upper() + "_" + suffix
            if environment_key not in env:
                continue
            leaf = subprocess.run(cargo + [key + "." + name, "--format", "json"], cwd=cwd, env=env, check=True, capture_output=True, text=True)
            value = json.loads(leaf.stdout)
            for part in key.split("."):
                value = value[part]
            table[name] = value[name]

    # Rust1.97.1 core Unicode White_Space, not Python's extra U+001C..U+001F.
    whitespace = "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"

    def flag_list(value):
        if isinstance(value, str):
            separated = value.translate({ord(character): " " for character in whitespace})
            return [flag for flag in separated.split(" ") if flag]
        if isinstance(value, list) and all(isinstance(flag, str) for flag in value):
            return list(value)
        raise ValueError("Cargo flags must be a string or a string array")

    def selected(name, facts):
        variable = name.upper()
        encoded = "CARGO_ENCODED_" + variable
        if encoded in env:
            return [] if env[encoded] == "" else env[encoded].split("\x1f")
        if variable in env:
            return [flag.strip(whitespace) for flag in env[variable].split(" ") if flag.strip(whitespace)]
        settings = target[triple]
        if not isinstance(settings, dict):
            raise ValueError("Cargo target configuration must be a table")
        flags = flag_list(settings.get(name, []))
        if facts is not None:
            for predicate, settings in sorted(target.items()):
                if not predicate.startswith("cfg(") or not predicate.endswith(")"):
                    continue
                atom = predicate[4:-1].strip(whitespace)
                if "(" in atom or "," in atom:
                    raise ValueError("unmodeled Cargo target flag predicate: " + predicate)
                key, separator, value = atom.partition("=")
                atom = key.strip(whitespace)
                if separator:
                    value = json.loads(value.strip(whitespace))
                    if not isinstance(value, str):
                        raise ValueError("Cargo cfg values must be strings")
                    atom += "=" + json.dumps(value, ensure_ascii=False)
                if atom in facts:
                    if not isinstance(settings, dict):
                        raise ValueError("Cargo cfg configuration must be a table")
                    flags += flag_list(settings.get(name, []))
        return flags if flags else flag_list(build.get(name, []))

    flags = selected("rustflags", None)
    # This exact two-query boundary comes from pinned Cargo TargetInfo::new;
    # refusal on nonconvergence is stricter than Cargo's warning and stale cfg.
    for turn in range(2):
        result = subprocess.run(sdk.command("rustc", version) + ["--print", "cfg", "--target", triple] + flags, env=env, check=True, capture_output=True, text=True)
        facts = set(result.stdout.splitlines()) - {"proc_macro"}
        resolved = selected("rustflags", facts)
        if resolved == flags:
            return {"rustflags": flags, "rustdocflags": selected("rustdocflags", facts)}
        if turn == 1:
            raise ValueError("Cargo target flags and cfg did not converge within Cargo's two queries")
        flags = resolved
    raise AssertionError("unreachable Cargo cfg resolution")


def unit_graph(manifest, triple, version, mode, raw, normalized, cwd, features=(), library=False, *, sdk, release=False, rust_flags=(), package=None, no_default_features=False, explicit_target=False, target_rust_flags=()):
    """Capture Cargo's compiler-unit oracle; this command never builds a unit.

    Stable Cargo gates this introspection flag behind unstable-options. The
    bootstrap env exists only in this metadata subprocess, never Rust actions.
    Unlike metadata nodes, units distinguish host/target feature contexts.
    """
    packages = [] if package is None else [package] if isinstance(package, str) else package
    if not isinstance(packages, list) or (package is not None and not packages) or any(not isinstance(name, str) or not name for name in packages) or len(set(packages)) != len(packages):
        raise ValueError("Cargo package selection must be a nonempty distinct string or string list")
    if type(explicit_target) is not bool or not isinstance(target_rust_flags, (list, tuple)) or any(not isinstance(flag, str) or not flag or any(char.isspace() for char in flag) for flag in target_rust_flags):
        raise ValueError("Explicit Cargo target flags require distinct literal flag arguments")
    if target_rust_flags and (rust_flags or not explicit_target):
        raise ValueError("Target-only Cargo flags require explicit --target and cannot replace RUSTFLAGS")
    env = sdk.environment(bootstrap=True)
    if target_rust_flags:
        if "RUSTFLAGS" in env or "CARGO_ENCODED_RUSTFLAGS" in env:
            raise ValueError("Target-only Cargo flags cannot inherit overriding global flags")
        env["CARGO_TARGET_" + triple.upper().replace("-", "_") + "_RUSTFLAGS"] = " ".join(target_rust_flags)
    if rust_flags:
        env.pop("CARGO_ENCODED_RUSTFLAGS", None)
        env["RUSTFLAGS"] = " ".join(rust_flags)
    execution_host = sdk.host
    implicit_native = triple == execution_host and not explicit_target
    command = "check" if mode == "workspace-check" else "test" if mode in ["test", "workspace-test"] else "build"
    args = sdk.command("cargo", version) + [command, "--unit-graph", "-Z", "unstable-options", "--offline", "--locked", "--manifest-path", str(manifest)]
    if not implicit_native:
        args += ["--target", triple]
    if mode in ["workspace-test", "workspace-clippy", "workspace-check"]:
        args.append("--workspace")
    if mode == "workspace-clippy":
        args.append("--all-targets")
    if mode == "release" or release:
        args.append("--release")
    for name in packages:
        args += ["-p", name]
    if no_default_features:
        args.append("--no-default-features")
    if features:
        args += ["--features", ",".join(features)]
    if library:
        args.append("--lib")
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    graph = json.loads(result.stdout)
    check_graph = None
    if mode == "workspace-clippy":
        # Cargo's Check mode serializes both ordinary and harness units as
        # `check`. Build exposes the harness distinction. Prove that the exact
        # compiler-context multiset matches, omitting only executable helper
        # data edges that Check does not build; never guess from dev-deps.
        check_args = list(args)
        check_args[1] = "check"
        check_result = subprocess.run(check_args, cwd=cwd, env=env, capture_output=True, text=True)
        if check_result.returncode:
            raise RuntimeError(check_result.stderr)
        check_graph = json.loads(check_result.stdout)
        def signatures(oracle):
            memo = {}
            def visit(index):
                if index not in memo:
                    unit = copy.deepcopy(oracle["units"][index])
                    unit.pop("mode")
                    unit["dependencies"] = [{**edge, "index": visit(edge["index"])} for edge in unit["dependencies"] if oracle["units"][edge["index"]]["target"]["kind"] != ["bin"]]
                    memo[index] = hashlib.sha256(json.dumps(unit, sort_keys=True).encode()).hexdigest()
                return memo[index]
            return Counter(visit(index) for index in oracle["roots"])
        if signatures(graph) != signatures(check_graph):
            raise ValueError("Cargo all-targets Clippy compiler contexts diverge from the harness oracle")
    if graph["version"] != 1:
        raise ValueError("unmodeled Cargo unit graph format")
    # Match by source/name/version instead of metadata array order.
    lookup = {(package["name"], package["version"], package["source"]): package["id"] for package in normalized["packages"]}
    identities = {package["id"]: lookup[(package["name"], package["version"], package["source"])] for package in raw["packages"]}
    package_paths = {package["id"]: Path(package["manifest_path"]).parent for package in raw["packages"]}
    target_flags = effective_target_flags(cwd, triple, version, env, sdk=sdk)
    for oracle in [graph] + ([check_graph] if check_graph is not None else []):
        for unit in oracle["units"]:
            package_id = unit["pkg_id"]
            unit["pkg_id"] = identities[package_id]
            unit["rust_flags"] = target_flags["rustdocflags" if unit["mode"] == "doctest" else "rustflags"] if unit["platform"] is not None or implicit_native else []
            source = Path(unit["target"]["src_path"])
            if unit["pkg_id"].startswith("workspace:"):
                unit["target"]["src_path"] = str(source.resolve().relative_to(ROOT))
            else:
                unit["target"]["src_path"] = str(source.relative_to(package_paths[package_id]))
    # Host identity is a qualification input, never an implied cross-host claim.
    graph["execution_host"] = execution_host
    if check_graph is not None:
        graph["clippy_check_oracle"] = check_graph
    return graph


def check_lock(lockfile, production):
    allowed = {(package["name"], package["version"], package.get("source")): package.get("checksum") for package in production["package"]}
    for package in tomllib.loads(lockfile.read_text())["package"]:
        key = package["name"], package["version"], package.get("source")
        if key not in allowed or allowed[key] != package.get("checksum"):
            raise ValueError("context changed the production dependency inventory: " + repr(key))


def simulator_manifests(source, production):
    """Use the original sim-tests.ts prepare recipe, without production membership."""
    def absolute_paths(value, directory):
        if isinstance(value, list):
            return [absolute_paths(item, directory) for item in value]
        if not isinstance(value, dict):
            return value
        return {key: os.path.abspath(directory / item) if key == "path" and isinstance(item, str)
                else absolute_paths(item, directory) for key, item in value.items()}

    crate = absolute_paths(tomllib.loads((source / "manifest.toml").read_text()), source)
    build = crate["package"].get("build")
    if not isinstance(build, str) or not build:
        raise ValueError("Original simulator manifest requires its declared build script")
    crate["package"] = {**crate["package"], "autotests": False,
                        "build": os.path.abspath(source / build)}
    crate["test"] = [{"name": file.name[:-3], "path": str(source / "tests" / file.name)}
                     for file in sorted((source / "tests").iterdir()) if file.name.endswith(".rs")]
    workspace = {"workspace": {"resolver": "3", "members": ["merkur-sim"],
                                "lints": production["workspace"]["lints"]},
                 "patch": absolute_paths(production["patch"], ROOT)}
    return workspace, crate


def capture_simulator(sdk, version, production):
    """Capture the genuine retained-lock simulator test-release compiler oracle."""
    source = ROOT / "tools/sim"
    retained_lock = source / "Cargo.lock"
    sdk.require_locks([ROOT / "Cargo.lock", retained_lock])
    destination = DIRECTORY / "merkur-sim/simulator-test/native"
    crate_directory = destination / "merkur-sim"
    crate_directory.mkdir(parents=True, exist_ok=True)
    workspace, crate = simulator_manifests(source, production)
    (destination / "Cargo.toml").write_text(toml_text(workspace) + "\n")
    manifest = crate_directory / "Cargo.toml"
    manifest.write_text(toml_text(crate) + "\n")
    lock = destination / "Cargo.lock"
    lock.write_bytes(retained_lock.read_bytes())
    triple = sdk.host
    raw = resolve(manifest, triple, version, refresh=False, sdk=sdk, rust_flags=SIMULATOR_FLAGS)
    normalized = normalize(raw, source / "manifest.toml", manifest)
    registry_targets = {}
    for package in raw["packages"]:
        if package["source"] is not None:
            package_root = Path(package["manifest_path"]).resolve(strict=True).parent
            registry_targets[package["id"]] = [
                {"name": target["name"], "kind": target["kind"], "edition": target["edition"],
                 "source": str(Path(target["src_path"]).resolve(strict=False).relative_to(package_root))}
                for target in package["targets"]]
    for package in normalized["packages"]:
        if package["source"] is not None:
            package["targets"] = registry_targets[package["id"]]
    # Cargo metadata for a virtual workspace may omit resolve.root. Its exact
    # one original selected member, not a guessed root package, supplies identity.
    original_id = "workspace:tools/sim"
    if normalized["members"] != [original_id]:
        raise ValueError("Simulator acquisition inherited another workspace member")
    if normalized["root"] == "workspace:.":
        normalized["root"] = original_id
    if normalized["root"] != original_id:
        raise ValueError("Simulator acquisition did not select its original member")
    graph = unit_graph(manifest, triple, version, "test", raw, normalized, ROOT,
                       sdk=sdk, release=True, rust_flags=SIMULATOR_FLAGS)
    if lock.read_bytes() != retained_lock.read_bytes():
        raise ValueError("Simulator acquisition changed its retained lock")
    inputs = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml",
              "tools/bazel/rust/metadata.json", "tools/bazel/rust/contexts.py",
              "tools/bazel/rust/acquisition_sdk.py", "tools/sim/manifest.toml",
              "tools/sim/Cargo.lock", "scripts/sim-tests.ts", "scripts/generated-cargo-workspace.ts"}
    inputs.update(str(file.relative_to(ROOT)) for file in source.rglob("*.rs"))
    inputs.add("tools/sim/regressions.json")
    inputs.update(package["manifest"] for package in normalized["packages"] if "manifest" in package)
    document = {"package": "merkur-sim", "mode": "simulator-test", "platform": "native",
                "rust_flags": SIMULATOR_FLAGS, "inputs": {path: digest(ROOT / path) for path in sorted(inputs)},
                "generated_inputs": {path: digest(destination / path) for path in ["Cargo.toml", "Cargo.lock", "merkur-sim/Cargo.toml"]},
                "contexts": {triple: normalized}, "unit_graphs": {triple: {"test": graph}}}
    (destination / "metadata.json").write_text(json.dumps(document, sort_keys=True, indent=2) + "\n")
    (destination / "BUILD.bazel").write_text('package(default_visibility = ["//visibility:public"])\nexports_files(["Cargo.toml", "Cargo.lock", "merkur-sim/Cargo.toml", "metadata.json"])\nfilegroup(name = "verification_inputs", srcs = ["Cargo.toml", "Cargo.lock", "merkur-sim/Cargo.toml", "metadata.json", "BUILD.bazel"])\n')
    return document


def validate_inventory(manifests, selected=None, workspace_tests=False):
    names = {tomllib.loads(path.read_text())["package"]["name"] for path in manifests}
    if selected:
        unknown = set(selected) - names
        if unknown:
            raise ValueError("unknown configured Rust roots: " + ", ".join(sorted(unknown)))
        names = set(selected)
    expected = {f"{name}/{mode}/{platform}/metadata.json" for name in names for mode in ["build", "test"] for platform in ["native", "wasm"]}
    if "term-wasm" in names:
        expected.add("term-wasm/training/wasm/metadata.json")
    if workspace_tests or not selected:
        expected.add("workspace-test/test/native/metadata.json")
    if not selected:
        expected.add("workspace-clippy/check/native/metadata.json")
        expected.add("workspace-check/check/native/metadata.json")
    if not selected and (ROOT / "tools/sim/manifest.toml").is_file():
        expected.add("merkur-sim/simulator-test/native/metadata.json")
    actual = {str(path.relative_to(DIRECTORY)) for path in DIRECTORY.glob("*/*/*/metadata.json")}
    missing = expected - actual
    if missing:
        raise ValueError("missing configured Rust contexts: " + ", ".join(sorted(missing)))
    if not selected and actual != expected:
        raise ValueError("unexpected configured Rust contexts: " + ", ".join(sorted(actual - expected)))
    for name in expected:
        document = json.loads((DIRECTORY / name).read_text())
        package, mode, platform, _ = name.split("/")
        simulator = package == "merkur-sim" and mode == "simulator-test"
        triples = NATIVE if platform == "native" and not package.startswith("workspace-") and not simulator else WASM if platform == "wasm" else list(document["contexts"])
        if simulator and (len(triples) != 1 or triples[0] not in NATIVE or document.get("rust_flags") != SIMULATOR_FLAGS):
            raise ValueError("Simulator requires its exact native host and original compiler flags")
        if package.startswith("workspace-") and (len(triples) != 1 or triples[0] not in NATIVE):
            raise ValueError("workspace test execution-host oracle is missing or invalid")
        if set(document["contexts"]) != set(triples) or set(document["unit_graphs"]) != set(triples):
            raise ValueError("configured Rust platform inventory mismatch: " + name)
        for triple in triples:
            profiles = {"instrumented"} if mode == "training" else {"clippy"} if package == "workspace-clippy" else {"check"} if package == "workspace-check" else {"test"} if mode == "test" or simulator else {"dev", "release"}
            if set(document["unit_graphs"][triple]) != profiles:
                raise ValueError("configured Rust profile inventory mismatch: " + name)
            if mode == "training" and document.get("features") != ["pgo-train"]:
                raise ValueError("terminal training feature inventory mismatch")
            for graph in document["unit_graphs"][triple].values():
                if simulator and graph["execution_host"] != triple:
                    raise ValueError("Simulator capture cannot claim a foreign native execution host")
                if not graph["roots"] or any(index >= len(graph["units"]) or index < 0 for index in graph["roots"]):
                    raise ValueError("configured Rust graph has missing roots: " + name)
    return expected


def refresh_plan(args):
    """A bare refresh captures every original context before strict checking."""
    scoped = bool(args.package or args.workspace_tests or args.workspace_clippy or args.workspace_check
                  or args.terminal_training or args.simulator)
    return {
        "packages": bool(args.package) or not scoped,
        "simulator": args.simulator or not scoped,
        "training": args.terminal_training or not scoped,
        "workspaces": [name for name, selected in [("workspace-test", args.workspace_tests),
                                                     ("workspace-clippy", args.workspace_clippy),
                                                     ("workspace-check", args.workspace_check)] if selected or not scoped],
    }


def main():
    global ROOT, DIRECTORY
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--package", action="append", help="refresh selected root packages; checking examines all retained contexts")
    parser.add_argument("--workspace-tests", action="store_true", help="retain the exact original cargo test --workspace configured root")
    parser.add_argument("--workspace-clippy", action="store_true", help="retain and prove exact cargo clippy --workspace --all-targets compiler contexts")
    parser.add_argument("--workspace-check", action="store_true", help="capture exact cargo check --workspace --locked default compiler targets")
    parser.add_argument("--simulator", action="store_true", help="capture the original retained-lock simulator test-release workspace")
    parser.add_argument("--terminal-training", action="store_true", help="capture the exact terminal cdylib root with pgo-train enabled")
    parser.add_argument("--sdk-descriptor", type=Path, help="declared native toolchain and complete offline registry File descriptor; required for refresh")
    parser.add_argument("--source-root", type=Path, help="explicit materialized first-party acquisition snapshot; required for refresh")
    args = parser.parse_args()
    plan = refresh_plan(args)
    if args.refresh:
        if args.sdk_descriptor is None or args.source_root is None:
            parser.error("--refresh requires --sdk-descriptor and --source-root; ambient tools and checkout discovery are forbidden")
        ROOT = args.source_root.resolve(strict=True)
        DIRECTORY = ROOT / "tools/bazel/rust/contexts"
    sdk = None
    if args.refresh:
        sdk = NativeCargoSdk.load(args.sdk_descriptor)
        sdk.require_locks([ROOT / "Cargo.lock"])
    workspace, manifests = package_manifests()
    version = tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    production_lock = tomllib.loads((ROOT / "Cargo.lock").read_text())
    if args.refresh:
        sdk.command("cargo", version)
    if args.refresh and plan["simulator"]:
        capture_simulator(sdk, version, workspace)
    if args.refresh and plan["training"]:
        original = ROOT / "packages/term-wasm/Cargo.toml"
        destination = DIRECTORY / "term-wasm/training/wasm"
        destination.mkdir(parents=True, exist_ok=True)
        manifest = destination / "Cargo.toml"
        manifest.write_text(manifest_for(original, destination, "build", workspace))
        lock = destination / "Cargo.lock"
        lock.write_bytes((ROOT / "Cargo.lock").read_bytes())
        triple = "wasm32-unknown-unknown"
        raw = resolve(manifest, triple, version, refresh=True, features=["pgo-train"], sdk=sdk)
        normalized = normalize(raw, original, manifest)
        graph = unit_graph(manifest, triple, version, "release", raw, normalized, original.parent, features=["pgo-train"], library=True, sdk=sdk)
        check_lock(lock, production_lock)
        inputs = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "packages/term-wasm/.cargo/config.toml", "tools/bazel/rust/metadata.json", "tools/bazel/rust/contexts.py", "tools/bazel/rust/acquisition_sdk.py"}
        inputs.update(package["manifest"] for package in normalized["packages"] if "manifest" in package)
        document = {"package": "term-wasm", "mode": "training", "platform": "wasm", "features": ["pgo-train"], "inputs": {path: digest(ROOT / path) for path in sorted(inputs)}, "generated_inputs": {"Cargo.toml": digest(manifest), "Cargo.lock": digest(lock)}, "contexts": {triple: normalized}, "unit_graphs": {triple: {"instrumented": graph}}}
        (destination / "metadata.json").write_text(json.dumps(document, sort_keys=True, indent=2) + "\n")
        (destination / "BUILD.bazel").write_text('# Generated locked terminal training context.\npackage(default_visibility = ["//visibility:public"])\nexports_files(["Cargo.toml", "Cargo.lock", "metadata.json"])\nfilegroup(name = "verification_inputs", srcs = ["Cargo.toml", "Cargo.lock", "metadata.json", "BUILD.bazel"])\n')
    if args.refresh:
        for context_name in plan["workspaces"]:
            context_mode = "test" if context_name == "workspace-test" else "check"
            profile = {"workspace-test": "test", "workspace-clippy": "clippy", "workspace-check": "check"}[context_name]
            destination = DIRECTORY / context_name / context_mode / "native"
            destination.mkdir(parents=True, exist_ok=True)
            manifest = ROOT / "Cargo.toml"
            raw = resolve(manifest, "", version, refresh=False, sdk=sdk)
            normalized = normalize(raw, manifest, manifest)
            triple = sdk.host
            graph = unit_graph(manifest, triple, version, context_name, raw, normalized, ROOT, sdk=sdk)
            for name in ["Cargo.toml", "Cargo.lock"]:
                (destination / name).write_bytes((ROOT / name).read_bytes())
            inputs = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "tools/bazel/rust/metadata.json", "tools/bazel/rust/contexts.py", "tools/bazel/rust/acquisition_sdk.py"}
            inputs.update(package["manifest"] for package in normalized["packages"] if "manifest" in package)
            document = {"package": context_name, "mode": context_name, "platform": "native", "inputs": {path: digest(ROOT / path) for path in sorted(inputs)}, "generated_inputs": {name: digest(destination / name) for name in ["Cargo.toml", "Cargo.lock"]}, "contexts": {triple: normalized}, "unit_graphs": {triple: {profile: graph}}}
            (destination / "metadata.json").write_text(json.dumps(document, sort_keys=True, indent=2) + "\n")
            (destination / "BUILD.bazel").write_text('package(default_visibility = ["//visibility:public"])\nexports_files(["Cargo.toml", "Cargo.lock", "metadata.json"])\nfilegroup(name = "verification_inputs", srcs = glob(["**"], exclude = [".*", "**/.*", ".*/**", "**/.*/**", "__pycache__/**", "**/__pycache__/**", "*.pyc", "**/*.pyc"]))\n')
    if args.refresh and plan["packages"]:
        for original in manifests:
            package = tomllib.loads(original.read_text())["package"]["name"]
            if args.package and package not in args.package:
                continue
            for mode in ["build", "test"]:
                for platform, triples in [("native", NATIVE), ("wasm", WASM)]:
                    destination = DIRECTORY / package / mode / platform
                    destination.mkdir(parents=True, exist_ok=True)
                    manifest = destination / "Cargo.toml"
                    manifest.write_text(manifest_for(original, destination, mode, workspace))
                    lock = destination / "Cargo.lock"
                    lock.write_bytes((ROOT / "Cargo.lock").read_bytes())
                    contexts = {}
                    units = {}
                    # wasm-pack builds from the crate directory. Terminal PGO
                    # deliberately uses term-wasm's scoped SIMD config too.
                    cwd = ROOT if platform == "native" else ROOT / "packages/term-wasm" if package == "term-wasm-pgo" else original.parent
                    for index, triple in enumerate(triples):
                        raw = resolve(manifest, triple, version, refresh=index == 0, sdk=sdk)
                        contexts[triple] = normalize(raw, original, manifest)
                        units[triple] = {profile: unit_graph(manifest, triple, version, profile, raw, contexts[triple], cwd, sdk=sdk) for profile in (["test"] if mode == "test" else ["dev", "release"])}
                    check_lock(lock, production_lock)
                    inputs = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "tools/bazel/rust/metadata.json", "tools/bazel/rust/contexts.py", "tools/bazel/rust/acquisition_sdk.py", str(original.relative_to(ROOT))}
                    current = cwd
                    while current.is_relative_to(ROOT):
                        for name in ["config", "config.toml"]:
                            configuration = current / ".cargo" / name
                            if configuration.exists():
                                inputs.add(str(configuration.relative_to(ROOT)))
                        if current == ROOT:
                            break
                        current = current.parent
                    for context in contexts.values():
                        inputs.update(package["manifest"] for package in context["packages"] if "manifest" in package)
                    document = {"package": package, "mode": mode, "platform": platform, "inputs": {path: digest(ROOT / path) for path in sorted(inputs)}, "generated_inputs": {"Cargo.toml": digest(manifest), "Cargo.lock": digest(lock)}, "contexts": contexts, "unit_graphs": units}
                    (destination / "metadata.json").write_text(json.dumps(document, sort_keys=True, indent=2) + "\n")
                    (destination / "BUILD.bazel").write_text('# Generated locked resolution context.\npackage(default_visibility = ["//visibility:public"])\nexports_files(["Cargo.toml", "Cargo.lock", "metadata.json"])\nfilegroup(name = "verification_inputs", srcs = glob(["**"], exclude = ["node_modules/**", "target/**", "dist/**", "pkg/**", "test-results/**", ".*", "**/.*", ".*/**", "**/.*/**", "__pycache__/**", "**/__pycache__/**", "*.pyc", "**/*.pyc"]))\n')
    validate_inventory(manifests, args.package, args.workspace_tests)
    count = 0
    for metadata in DIRECTORY.glob("*/*/*/metadata.json"):
        count += 1
        document = json.loads(metadata.read_text())
        for path, expected in document["inputs"].items():
            if digest(ROOT / path) != expected:
                raise ValueError("stale configured resolution input: " + path)
        for path, expected in document["generated_inputs"].items():
            if digest(metadata.parent / path) != expected:
                raise ValueError("changed generated resolution input: " + str(metadata.parent / path))
        if document["mode"] == "simulator-test":
            if (metadata.parent / "Cargo.lock").read_bytes() != (ROOT / "tools/sim/Cargo.lock").read_bytes():
                raise ValueError("changed retained simulator lock input")
        else:
            check_lock(metadata.parent / "Cargo.lock", production_lock)
        for context in document["contexts"].values():
            if not document["mode"].startswith("workspace-") and context["members"] != [context["root"]]:
                raise ValueError("independent configured root inherited another workspace member")
    sources = set()
    for metadata in DIRECTORY.glob("*/*/*/metadata.json"):
        document = json.loads(metadata.read_text())
        sources.update(document["inputs"])
        sources.update(str((metadata.parent / name).relative_to(ROOT)) for name in [*document["generated_inputs"], "metadata.json", "BUILD.bazel"])
    labels = set()
    for source in sources:
        path = Path(source)
        owner = path.parent
        while owner != Path(".") and not (ROOT / owner / "BUILD.bazel").is_file():
            owner = owner.parent
        labels.add("//" + ("" if owner == Path(".") else str(owner)) + ":" + str(path.relative_to(owner)))
    inventory = "# Generated from the complete locked configured-context inventory.\nMETADATA_RESOLUTION_INPUTS = " + repr(sorted(labels)) + "\n"
    target = ROOT / "tools/bazel/rust/metadata_resolution_inputs.bzl"
    if args.refresh:
        target.write_text(inventory)
    elif not target.is_file() or target.read_text() != inventory:
        raise ValueError("stale configured metadata acquisition input inventory")
    print(f"Configured Rust resolution checked: {count} independent roots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
