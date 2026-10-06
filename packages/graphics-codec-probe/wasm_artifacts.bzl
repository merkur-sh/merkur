"""Package the declared native release graphics codec probe for Bun consumers."""

load("//tools/bazel/wasm:rules.bzl", "wasm_bindings", "wasm_optimized_bindings", "wasm_package")

def declare_wasm_artifacts():
    wasm_bindings(
        name = "wasm_bindings",
        wasm = "//tools/bazel/rust/units:graphics_codec_probe__release_wasm",
        module_name = "graphics_codec_probe",
        tags = ["manual"],
    )
    wasm_optimized_bindings(
        name = "wasm_optimized_bindings",
        bindings = ":wasm_bindings",
        module_name = "graphics_codec_probe",
        flags = ["-O"],
        tags = ["manual"],
    )
    wasm_package(
        name = "wasm_artifacts",
        bindings = ":wasm_optimized_bindings",
        crate_manifest = ":Cargo.toml",
        module_name = "graphics_codec_probe",
        out = "pkg",
        tags = ["manual"],
    )
