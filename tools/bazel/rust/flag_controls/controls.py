#!/usr/bin/env python3
"""Compare capture flags with actual pinned Cargo unit diagnostics, never builds."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


def cargo_unit_flags(stderr):
    # Pinned Cargo unit_dependencies.rs emits Unit's actual Rust Debug arrays.
    # This is a qualification-only channel; production never parses diagnostics.
    lines = iter(stderr.splitlines())
    observed = {"rustflags": [], "rustdocflags": []}
    for line in lines:
        line = line.strip()
        for name in observed:
            prefix = name + ": "
            if not line.startswith(prefix):
                continue
            value = line[len(prefix):]
            if value == "[],":
                flags = []
            elif value == "[":
                flags = []
                for item in lines:
                    item = item.strip()
                    if item == "],":
                        break
                    # Rust Debug escapes the four ASCII separators that Python
                    # incorrectly classifies as whitespace.
                    for scalar in ["1c", "1d", "1e", "1f"]:
                        item = item.replace("\\u{" + scalar + "}", "\\u00" + scalar)
                    flags.append(json.loads(item.removesuffix(",")))
                else:
                    raise AssertionError("Incomplete Cargo unit flag diagnostics")
            else:
                raise AssertionError("Unexpected pinned Cargo unit flag diagnostic shape")
            observed[name].append(flags)
    result = {}
    for name, values in observed.items():
        if not values or any(value != values[0] for value in values):
            raise AssertionError("Missing or inconsistent dependency-free Cargo unit flags")
        result[name] = values[0]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--contexts", type=Path, required=True)
    parser.add_argument("--cargo", type=Path, required=True)
    parser.add_argument("--rustc", type=Path, required=True)
    parser.add_argument("--sdk-inputs", type=Path, required=True)
    parser.add_argument("--sdk-resolver", type=Path, required=True)
    parser.add_argument("--runfiles-root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    cargo, rustc = args.cargo.resolve(strict=True), args.rustc.resolve(strict=True)
    base_env = {"PATH": "", "RUSTC_BOOTSTRAP": "1", "RUSTC": str(rustc)}
    identities = {}
    for name, executable in [("cargo", cargo), ("rustc", rustc)]:
        result = subprocess.run([str(executable), "-vV"], env=base_env, check=True, capture_output=True, text=True)
        if "release: 1.97.1" not in result.stdout.splitlines():
            raise AssertionError("Qualification requires exact Cargo/rustc 1.97.1")
        identities[name] = {"sha256": hashlib.sha256(executable.read_bytes()).hexdigest(), "version": result.stdout}
    spec = importlib.util.spec_from_file_location("captured_contexts", args.contexts)
    if spec is None or spec.loader is None:
        raise AssertionError("Missing authoritative capture helper")
    contexts = importlib.util.module_from_spec(spec)
    sdk_spec = importlib.util.spec_from_file_location("acquisition_sdk", args.sdk_resolver)
    if sdk_spec is None or sdk_spec.loader is None:
        raise AssertionError("Missing declared SDK resolver File")
    sdk_module = importlib.util.module_from_spec(sdk_spec)
    sys.modules["acquisition_sdk"] = sdk_module
    sdk_spec.loader.exec_module(sdk_module)
    spec.loader.exec_module(contexts)
    sdk_inputs = json.loads(args.sdk_inputs.read_text())
    sdk = sdk_module.NativeCargoSdk({
        "version": "1.97.1", "execution_host": sdk_inputs["execution_host"],
        "cargo": sdk_module.file_fact(cargo), "rustc": sdk_module.file_fact(rustc),
        "sdk": [sdk_module.file_fact(args.runfiles_root / path) for path in sdk_inputs["files"]],
        "locks": [], "registry": {"directory": None, "packages": [], "files": []},
    })
    run_native = subprocess.run
    triple = "x86_64-unknown-linux-gnu"
    target = '[target.x86_64-unknown-linux-gnu]\nrustflags=["--cfg","triple_fact"]\nrustdocflags=["--cfg","triple_doc_fact"]\n'
    cfg = '[target.\'cfg(target_arch="x86_64")\']\nrustflags=["--cfg","cfg_fact"]\nrustdocflags=["--cfg","cfg_doc_fact"]\n'
    build = '[build]\nrustflags=["--cfg","build_fact"]\nrustdocflags=["--cfg","build_doc_fact"]\n'
    cases = [
        ("literal-before-cfg", target + cfg, {}, False),
        ("build-fallback-without-target", build, {}, False),
        ("build-fallback-unmatched-target", build + '[target.wasm32-unknown-unknown]\nrustflags=["--cfg","irrelevant"]\n', {}, False),
        ("empty-target-build-fallback", build + '[target.x86_64-unknown-linux-gnu]\nrustflags=[]\nrustdocflags=[]\n', {}, False),
        ("string-flags", '[target.x86_64-unknown-linux-gnu]\nrustflags="--cfg string_fact"\nrustdocflags="--cfg string_doc_fact"\n' + cfg, {}, False),
        ("plain-environment-overrides", target + cfg + build, {"RUSTFLAGS": "  --cfg ordinary_fact  ", "RUSTDOCFLAGS": "--cfg ordinary_doc_fact"}, False),
        ("encoded-environment-precedes-plain", target + cfg + build, {"RUSTFLAGS": "--cfg ignored_plain", "RUSTDOCFLAGS": "--cfg ignored_plain_doc", "CARGO_ENCODED_RUSTFLAGS": '--cfg\x1fencoded_fact="a b"', "CARGO_ENCODED_RUSTDOCFLAGS": "--cfg\x1fencoded_doc_fact"}, False),
        ("empty-encoded-overrides-config", target + cfg + build, {"CARGO_ENCODED_RUSTFLAGS": "", "CARGO_ENCODED_RUSTDOCFLAGS": ""}, False),
        ("cargo-target-environment-leaf", target + cfg, {"CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS": "--cfg leaf_fact", "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTDOCFLAGS": "--cfg leaf_doc_fact"}, False),
        ("cargo-build-environment-leaf", build, {"CARGO_BUILD_RUSTFLAGS": "--cfg leaf_build_fact", "CARGO_BUILD_RUSTDOCFLAGS": "--cfg leaf_build_doc_fact"}, False),
        ("rust-unicode-whitespace-string", '[build]\nrustflags="--cfg\u00a0unicode_space_fact"\nrustdocflags="--cfg\u3000unicode_space_doc_fact"\n', {}, False),
        ("rust-nonwhitespace-metadata-string", '[build]\nrustflags="-Cmetadata=compiler\\u001c"\nrustdocflags="-Cmetadata=documentation\\u001d"\n', {}, False),
        ("rust-nonwhitespace-plain-environment", target + cfg, {"RUSTFLAGS": "-Cmetadata=compiler\x1e", "RUSTDOCFLAGS": "-Cmetadata=documentation\x1f"}, False),
        ("flag-derived-cfg-feedback", '[target.x86_64-unknown-linux-gnu]\nrustflags=["-C","target-feature=+ssse3"]\n[target.\'cfg(target_feature="ssse3")\']\nrustflags=["--cfg","after_ssse3"]\nrustdocflags=["--cfg","after_ssse3_doc"]\n', {}, False),
        ("compound-predicate-refusal", '[target.\'cfg(all(target_arch="x86_64",target_os="linux"))\']\nrustflags=["--cfg","compound_fact"]\n', {}, True),
        ("nonconvergent-predicate-refusal", '[target.x86_64-unknown-linux-gnu]\nrustflags=["-C","target-feature=+ssse3"]\n[target.\'cfg(target_feature="ssse3")\']\nrustflags=["-C","target-feature=-ssse3"]\n', {}, True),
    ]
    results = []
    with tempfile.TemporaryDirectory(prefix="merkur-cargo-flag-oracle-") as temporary:
        root = Path(temporary)
        for name, configuration, extra, refusal in cases:
            directory = root / name
            (directory / "src").mkdir(parents=True)
            (directory / ".cargo").mkdir()
            (directory / "src/lib.rs").write_text("pub fn declared_fixture() {}\n")
            (directory / "Cargo.toml").write_text('[package]\nname="declared-flag-oracle"\nversion="0.0.0"\nedition="2024"\n[workspace]\nresolver="3"\n')
            (directory / "Cargo.lock").write_text('version = 4\n[[package]]\nname="declared-flag-oracle"\nversion="0.0.0"\n')
            (directory / ".cargo/config.toml").write_text(configuration)
            env = {**base_env, "HOME": str(directory), "CARGO_HOME": str(directory / "cargo-home"), **extra}
            oracle = run_native([str(cargo), "test", "--doc", "--offline", "--locked", "--unit-graph", "-Z", "unstable-options", "--target", triple], cwd=directory, env={**env, "CARGO_LOG": "cargo::core::compiler::unit_dependencies=trace"}, check=True, capture_output=True, text=True)
            graph = json.loads(oracle.stdout)
            if graph["version"] != 1 or len(graph["roots"]) != 1 or graph["units"][graph["roots"][0]]["mode"] != "doctest":
                raise AssertionError("Native oracle must be the exact dependency-free doctest unit graph")
            expected = cargo_unit_flags(oracle.stderr)
            def declared_run(command, **kwargs):
                if command[0] not in [str(cargo), str(rustc)]:
                    raise AssertionError("Capture helper attempted an undeclared tool command")
                return run_native(command, **kwargs)
            error = None
            with patch.object(contexts.subprocess, "run", declared_run):
                try:
                    actual = contexts.effective_target_flags(directory, triple, "1.97.1", env, sdk=sdk)
                except ValueError as failure:
                    error = str(failure)
                    actual = None
            if refusal:
                if error is None:
                    raise AssertionError(name + " must refuse an unsupported or nonconvergent capture")
            elif actual != expected:
                raise AssertionError(json.dumps({"case": name, "captured": actual, "cargo": expected, "error": error}))
            artifacts = [str(path.relative_to(directory)) for pattern in ["*.rlib", "*.rmeta", "*.o"] for path in directory.rglob(pattern)]
            if artifacts:
                raise AssertionError("Qualification oracle unexpectedly compiled artifacts")
            results.append({"case": name, "cargo": expected, "captured": actual, "refused": error, "compiler_artifacts": artifacts})
            if args.evidence:
                args.evidence.mkdir(parents=True, exist_ok=True)
                (args.evidence / (name + ".unit-graph.json")).write_text(oracle.stdout)
                (args.evidence / (name + ".cargo.log")).write_text(oracle.stderr)
    receipt = {"scope": "Actual native Cargo1.97.1 read-only unit-graph qualification; no product compile", "identities": identities, "contexts_sha256": hashlib.sha256(args.contexts.read_bytes()).hexdigest(), "results": results}
    if args.evidence:
        (args.evidence / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"native_cases": len(results), "matched": sum(row["refused"] is None for row in results), "explicit_refusals": sum(row["refused"] is not None for row in results)}))
    sdk.close()


if __name__ == "__main__":
    main()
