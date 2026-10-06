"""Bun conformance consumes the declared package produced from the Rust wrapper."""

load(":bun_inputs.bzl", "declare_conformance_sources")
load("//tools/bazel/bun:rules.bzl", "bun_test")
load("//tools/bazel/packaging:rules.bzl", "package_controls_test")
load("//tools/bazel/wasm:rules.bzl", "wasm_bindings", "wasm_optimized_bindings", "wasm_package", "wasm_static_projection")

def declare_bun_tests():
    native.exports_files(["conformance.test.ts", "wasm-artifacts-test.py"])
    wasm_bindings(
        name = "wasm_bindings",
        wasm = "//tools/bazel/rust/units:e2e_wasm__release_wasm",
        module_name = "e2e_wasm",
        tags = ["manual"],
    )
    wasm_optimized_bindings(
        name = "wasm_optimized_bindings",
        bindings = ":wasm_bindings",
        module_name = "e2e_wasm",
        flags = ["-O"],
        tags = ["manual"],
    )
    wasm_package(
        name = "wasm_artifacts",
        bindings = ":wasm_optimized_bindings",
        crate_manifest = ":Cargo.toml",
        module_name = "e2e_wasm",
        out = "pkg",
        tags = ["manual"],
    )
    wasm_static_projection(
        name = "wasm_static_sources",
        package_tree = ":wasm_artifacts",
        module = "e2e_wasm",
        logical_directory = "packages/e2e-wasm/pkg",
        tags = ["manual"],
    )
    declare_conformance_sources()
    bun_test(
        name = "test__conformance.test.ts",
        test_files = ["./packages/e2e-wasm/conformance.test.ts"],
        data = [":conformance_sources", ":wasm_artifacts", "//scripts:test_preload"],
        tags = ["bun", "manual", "no-remote-cache", "unqualified-runtime-inputs"],
    )
    package_controls_test(
        name = "wasm_artifacts_test",
        src = "wasm-artifacts-test.py",
        data = [
            "bun_tests.bzl",
            "Cargo.toml",
            "conformance.test.ts",
            "//tools/bazel/rust/units:graph.json",
            "//apps/web:src/lib/e2e-wasm-module.ts",
            "//packages/shared:src/e2e-wasm-runtime.ts",
        ],
        tags = ["manual"],
    )
