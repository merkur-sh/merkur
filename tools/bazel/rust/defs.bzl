"""Rust test rules for the crates whose tests need a dependency's test-only feature."""

load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_test")
load("@with_cfg.bzl", "with_cfg")

# Cargo enables a dev-dependency's feature for the whole graph of the test that asks for it. These
# tests build their graph with merkur-e2e's `testing` feature on; every other target, and every
# shipped binary, shares the graph without it.
rust_e2e_testing_test, _rust_e2e_testing_test = with_cfg(rust_test).set(
    Label("//packages/merkur-e2e:testing"),
    True,
).build()

# The same graph for a test harness built as a binary (`rustc --test`), which a build action runs:
# the dataplane's profile-guided training, which shipped targets depend on and a test cannot be.
rust_e2e_testing_binary, _rust_e2e_testing_binary = with_cfg(rust_binary).set(
    Label("//packages/merkur-e2e:testing"),
    True,
).build()

# A test built as `--config=release` builds: Cargo's release profile, for the suites that also
# hold the optimized build to account.
rust_release_test, _rust_release_test = with_cfg(rust_test).set(
    "compilation_mode",
    "opt",
).set(
    Label("@rules_rust//rust/settings:extra_rustc_flags"),
    [],
).build()
