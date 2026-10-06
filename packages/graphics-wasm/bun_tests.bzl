"""Bun conformance consumes the declared graphics wrapper and shared preload."""

load(":bun_inputs.bzl", "declare_conformance_sources")
load("//tools/bazel/bun:rules.bzl", "bun_test")
load("//tools/bazel/packaging:rules.bzl", "package_controls_test")
load("//tools/bazel/wasm:rules.bzl", "wasm_bindings", "wasm_optimized_bindings", "wasm_package")

def declare_bun_tests():
    native.exports_files(["conformance.test.ts", "wasm-artifacts-test.py"])
    wasm_bindings(
        name = "wasm_bindings",
        wasm = "//tools/bazel/rust/units:graphics_wasm__release_wasm",
        module_name = "graphics_wasm",
        tags = ["manual"],
    )
    wasm_optimized_bindings(
        name = "wasm_optimized_bindings",
        bindings = ":wasm_bindings",
        module_name = "graphics_wasm",
        flags = ["-O"],
        tags = ["manual"],
    )
    wasm_package(
        name = "wasm_artifacts",
        bindings = ":wasm_optimized_bindings",
        crate_manifest = ":Cargo.toml",
        module_name = "graphics_wasm",
        out = "pkg",
        tags = ["manual"],
    )
    declare_conformance_sources()
    bun_test(
        name = "test__conformance.test.ts",
        test_files = ["./packages/graphics-wasm/conformance.test.ts"],
        data = [":conformance_sources", ":wasm_artifacts", "//packages/e2e-wasm:wasm_artifacts", "//packages/term-wasm:wasm_artifacts", "//scripts:test_preload"],
        tags = ["bun", "manual", "no-remote-cache", "unqualified-runtime-inputs"],
    )
    package_controls_test(
        name = "wasm_artifacts_test",
        src = "wasm-artifacts-test.py",
        data = ["bun_tests.bzl", "bun_inputs.bzl", "Cargo.toml", "//tools/bazel/rust:package_targets.bzl", "//tools/bazel/rust/units:graph.json"],
        tags = ["manual"],
    )
