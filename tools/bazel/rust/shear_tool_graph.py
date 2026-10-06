#!/usr/bin/env python3
"""Resolve the pinned analyzer SDK graph without compiling any Cargo target."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools/bazel/rust/shear_tools"
TRIPLES = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]
GENERATOR_SHA256 = "53f6b548a29b2b4cceaf131824ff28489dfc8437ab9f5eb96fdc8500eb531a64"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["generator", "cargo", "rustc", "cargo-home"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generator = args.generator.resolve(strict=True)
    cargo = args.cargo.resolve(strict=True)
    rustc = args.rustc.resolve(strict=True)
    if hashlib.sha256(generator.read_bytes()).hexdigest() != GENERATOR_SHA256:
        raise ValueError("Expected the published rules_rust 0.74.0 Darwin ARM generator")
    env = {"PATH": "/usr/bin:/bin", "HOME": str(args.cargo_home), "CARGO_HOME": str(args.cargo_home),
           "CARGO_NET_OFFLINE": "true", "LANG": "C", "LC_ALL": "C"}
    for tool, command, prefix in [(cargo, ["--version"], "cargo 1.97.1 "), (rustc, ["-vV"], "rustc 1.97.1 ")]:
        if not subprocess.check_output([str(tool), *command], env=env, text=True).startswith(prefix):
            raise ValueError("Expected the pinned Rust 1.97.1 resolution SDK")
    with tempfile.TemporaryDirectory(prefix="merkur-shear-tool-resolution-") as directory:
        work = Path(directory)
        # This adapter only scopes introspection metadata to the admitted native
        # platforms. The upstream host/target cargo-tree resolver is unchanged.
        # Cargo build/test/check commands are never issued by this recipe.
        adapter = work / "cargo-native-metadata"
        filters = " ".join("--filter-platform=" + triple for triple in TRIPLES)
        adapter.write_text("#!/bin/sh\nif [ \"$1\" = metadata ]; then\n exec " + shlex.quote(str(cargo)) +
                           " \"$@\" " + filters + "\nfi\nexec " + shlex.quote(str(cargo)) + " \"$@\"\n")
        adapter.chmod(0o755)
        config = {
            "annotations": {}, "cargo_config": None, "generate_binaries": False, "generate_build_scripts": True,
            "rendering": {
                "build_file_template": "@crates_shear_tools//crates_shear_tools:BUILD.{name}-{version}.bazel",
                "crate_alias_template": "@{repository}//{name}-{version}",
                "crate_label_template": "@{repository}__{name}-{version}//:{target}",
                "crate_repository_template": "{repository}__{name}-{version}",
                "crates_module_template": "@crates_shear_tools//crates_shear_tools:{file}",
                "default_alias_rule": "alias", "default_package_name": None, "generate_cargo_toml_env_vars": True,
                "generate_rules_license_metadata": False, "generate_target_compatible_with": True,
                "incompatible_no_root_alias_targets": False, "platforms_template": "@rules_rust//rust/platform:{triple}",
                "regen_command": "bazel mod deps", "repository_name": "crates_shear_tools", "vendor_mode": "remote",
            },
            "supported_platform_triples": TRIPLES,
        }
        splicing = {"cargo_config": None, "direct_packages": {}, "resolver_version": "3",
                    "manifests": {str(TOOLS / "Cargo.toml"): "@@//tools/bazel/rust/shear_tools:Cargo.toml"}}
        (work / "config.json").write_text(json.dumps(config))
        (work / "splicing.json").write_text(json.dumps(splicing))
        common = ["--config", str(work / "config.json"), "--splicing-manifest", str(work / "splicing.json"),
                  "--cargo-lockfile", str(TOOLS / "Cargo.lock"), "--nonhermetic-root-bazel-workspace-dir", str(ROOT),
                  "--skip-cargo-lockfile-overwrite", "--rustc", str(rustc)]
        subprocess.run([str(generator), "splice", *common, "--cargo", str(adapter), "--output-dir", str(work / "spliced"),
                        "--repository-name", "crates_shear_tools"], env=env, check=True)
        lock = work / "Bazel.lock"
        subprocess.run([str(generator), "generate", *common, "--cargo", str(cargo), "--repository-dir", str(work / "render"),
                        "--metadata", str(work / "spliced/metadata.json"), "--lockfile", str(lock), "--repin",
                        "--paths-to-track", str(work / "paths.json"), "--warnings-output-path", str(work / "warnings.json"),
                        "--hub-packages-output-path", str(work / "hubs.json")], env=env, check=True)
        if args.check:
            if lock.read_bytes() != (TOOLS / "Bazel.lock").read_bytes():
                raise ValueError("The CargoShear host/target feature graph has changed")
        else:
            shutil.copyfile(lock, TOOLS / "Bazel.lock")


if __name__ == "__main__":
    main()
