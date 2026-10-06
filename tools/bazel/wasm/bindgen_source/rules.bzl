"""Use the existing declared native Cargo acquisition and compiler attribution."""
load("//tools/bazel/rust/acquire:sdk_rules.bzl", "cargo_acquisition_sdk")
load("//tools/bazel/rust/audit_tool:rules.bzl", "cargo_audit_context")
load(":data.bzl", "BINDGEN_REGISTRY_ARCHIVES", "BINDGEN_SOURCE_FILES")

_HOSTS = {
    "darwin_arm64": ("aarch64-apple-darwin", ["@platforms//os:macos", "@platforms//cpu:aarch64"]),
    "darwin_x64": ("x86_64-apple-darwin", ["@platforms//os:macos", "@platforms//cpu:x86_64"]),
    "linux_arm64": ("aarch64-unknown-linux-gnu", ["@platforms//os:linux", "@platforms//cpu:aarch64"]),
    "linux_x64": ("x86_64-unknown-linux-gnu", ["@platforms//os:linux", "@platforms//cpu:x86_64"]),
}

def declare_bindgen_acquisition():
    for name, (host, constraints) in _HOSTS.items():
        cargo_acquisition_sdk(
            name = "sdk_" + name,
            execution_host = host,
            source_files = BINDGEN_SOURCE_FILES,
            archives = BINDGEN_REGISTRY_ARCHIVES,
            locks = ["Cargo.lock"],
            target_compatible_with = constraints,
            exec_compatible_with = constraints,
            tags = ["manual"],
        )
        cargo_audit_context(
            name = "context_" + name,
            sdk = ":sdk_" + name,
            source_archive = "@merkur_wasm_bindgen_original//:original/wasm-bindgen-cli-0.2.127.crate",
            original = ":original.py",
            target_compatible_with = constraints,
            exec_compatible_with = constraints,
            tags = ["manual"],
        )
