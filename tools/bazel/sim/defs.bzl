"""The simulator's tests: every crate compiled as `scripts/sim-tests.ts` compiles it."""

load("@rules_rust//rust:defs.bzl", "rust_test")
load("@with_cfg.bzl", "with_cfg")

# Cargo's release profile, with the simulator's hooks (`merkur_sim`) and turmoil's per-host
# scheduler seed (`tokio_unstable`) on in every crate, as `RUSTFLAGS` sets them for Cargo.
sim_test, _sim_test = with_cfg(rust_test).set(
    "compilation_mode",
    "opt",
).set(
    Label("//tools/bazel/sim:simulating"),
    True,
).set(
    Label("@rules_rust//rust/settings:extra_rustc_flags"),
    [
        "--cfg=merkur_sim",
        "--cfg=tokio_unstable",
    ],
).build()

# The simulator's libraries compile only with its cfgs, which only `sim_test` sets: anywhere else,
# such as a `bazel test //...` that reaches them directly, they are incompatible and skipped.
SIMULATING = select({
    Label("//tools/bazel/sim:simulating_build"): [],
    "//conditions:default": ["@platforms//:incompatible"],
})
