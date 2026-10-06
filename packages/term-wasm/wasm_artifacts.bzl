"""Terminal release bindings consume the exact instrumented training/profile-use graph."""

load("//tools/bazel/wasm:rules.bzl", "terminal_wasm_profile", "wasm_bindings", "wasm_optimized_bindings", "repository_input_tree", "wasm_package")

def declare_wasm_artifacts():
    terminal_wasm_profile(
        name = "terminal_profile",
        driver = "//tools/bazel/rust/units:term_wasm__instrumented_wasm",
        font = "//apps/web:public/fonts/JetBrainsMonoNF-Regular.ttf",
        zstd_fixture = "//tools/bazel/rust/units:zstd_fixture__release_native",
        profdata_tool = "//tools/bazel/rust:llvm_profdata",
        tags = ["manual"],
    )
    wasm_bindings(
        name = "wasm_bindings",
        wasm = "//tools/bazel/rust/units:term_wasm__profile_use_wasm",
        module_name = "term_wasm",
        tags = ["manual"],
    )
    wasm_optimized_bindings(
        name = "wasm_optimized_bindings",
        bindings = ":wasm_bindings",
        module_name = "term_wasm",
        flags = ["-O"],
        tags = ["manual"],
    )
    repository_input_tree(
        name = "provenance_inputs",
        srcs = ["//:.bazelrc", "//:.bazelversion", "//:.cargo/config.toml", "//:Cargo.lock", "//:Cargo.toml", "//:MODULE.bazel", "//:rust-toolchain.toml", "//:tsconfig.json", "//:tsconfig.base.json", "//apps/daemon/dataplane:Cargo.toml", "//apps/edge:Cargo.toml", "//apps/stun:Cargo.toml", "//apps/tui:Cargo.toml", "//apps/web:public/fonts/JetBrainsMonoNF-Regular.ttf", "//packages/alacritty-terminal-patch:Cargo.toml", "//packages/alacritty-terminal-patch:rust_sources", "//packages/e2e-wasm:Cargo.toml", "//packages/fontdue-patch:Cargo.toml", "//packages/fontdue-patch:rust_sources", "//packages/graphics-codec-probe:Cargo.toml", "//packages/graphics-wasm:Cargo.toml", "//packages/merkur-authorization:Cargo.toml", "//packages/merkur-authorization:rust_sources", "//packages/merkur-client-native:Cargo.toml", "//packages/merkur-client:Cargo.toml", "//packages/merkur-client:rust_sources", "//packages/merkur-codec:Cargo.toml", "//packages/merkur-codec:rust_sources", "//packages/merkur-e2e:Cargo.toml", "//packages/merkur-e2e:rust_sources", "//packages/merkur-edge-protocol:Cargo.toml", "//packages/merkur-edge-protocol:rust_sources", "//packages/merkur-fec:Cargo.toml", "//packages/merkur-fec:rust_sources", "//packages/merkur-graphics:Cargo.toml", "//packages/merkur-graphics:rust_sources", "//packages/merkur-identity-seal:Cargo.toml", "//packages/merkur-image-worker:Cargo.toml", "//packages/merkur-stun-protocol:Cargo.toml", "//packages/merkur-wire:Cargo.toml", "//packages/merkur-wire:rust_sources", "//packages/quinn-patch:Cargo.toml", "//packages/quinn-proto-patch:Cargo.toml", "//packages/term-wasm-pgo:Cargo.toml", "//packages/term-wasm-pgo:rust_sources", "//packages/term-wasm:.cargo/config.toml", "//packages/term-wasm:Cargo.toml", "//packages/term-wasm:rust_sources", "//packages/term-wasm:wasm_artifacts.bzl", "//packages/vte-patch:Cargo.toml", "//packages/vte-patch:rust_sources", "//packages/wtransport-patch:Cargo.toml", "//packages/zstd-fixture:Cargo.toml", "//packages/zstd-fixture:rust_sources", "//scripts:build-term-wasm.ts", "//scripts:sync-term-wasm.ts", "//scripts:term-wasm-current-glue.ts", "//scripts:term-wasm-ingress-fixture.ts", "//scripts:term-wasm-pgo.ts", "//scripts:term-wasm-provenance.ts", "//scripts:wasm-toolchain.ts", "//tools/bazel/bun:bun.MODULE.bazel", "//tools/bazel/bun:extensions.bzl", "//tools/bazel/bun:rules.bzl", "//tools/bazel/cc:cc.MODULE.bazel", "//tools/bazel/cc:sdk.BUILD.bazel", "//tools/bazel/cc:wasm_config.bzl", "//tools/bazel/rust/units/provenance:term_wasm_instrumented.json", "//tools/bazel/rust/units/provenance:term_wasm_instrumented_sources", "//tools/bazel/rust/units/provenance:term_wasm_profile_use.json", "//tools/bazel/rust/units/provenance:term_wasm_profile_use_sources", "//tools/bazel/rust:contexts.py", "//tools/bazel/rust:defs.bzl", "//tools/bazel/rust:generate.py", "//tools/bazel/rust:llvm_tools.bzl", "//tools/bazel/rust:rust.MODULE.bazel", "//tools/bazel/rust:units.bzl", "//tools/bazel/rust:units.py", "//tools/bazel/wasm:BUILD.bazel", "//tools/bazel/wasm:extensions.bzl", "//tools/bazel/wasm:input-tree.ts", "//tools/bazel/wasm:optimize.ts", "//tools/bazel/wasm:package.ts", "//tools/bazel/wasm:rules.bzl", "//tools/bazel/wasm:train-profile.ts", "//tools/bazel/wasm:wasm.MODULE.bazel"],
        tags = ["manual", "unqualified-provenance-scope"],
    )
    wasm_package(
        name = "wasm_artifacts",
        bindings = ":wasm_optimized_bindings",
        crate_manifest = ":Cargo.toml",
        module_name = "term_wasm",
        terminal = True,
        source_tree = ":provenance_inputs",
        out = "pkg",
        tags = ["manual", "unqualified-provenance-scope"],
    )
