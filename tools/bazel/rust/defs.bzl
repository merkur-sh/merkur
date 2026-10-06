"""Native Rust compilation with the package isolation required by Merkur tests."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

load("@rules_rust//rust:defs.bzl", "rust_doc_test", "rust_test")

def _test_profile_impl(_settings, _attr):
    # Execution placement never selects a release profile for test compilation.
    return {
        "//command_line_option:compilation_mode": "fastbuild",
        "@rules_rust//rust/settings:extra_rustc_flags": [
            "-Copt-level=3",
            "-Cdebuginfo=0",
            "-Cdebug-assertions=yes",
            "-Coverflow-checks=yes",
        ],
    }

_test_profile = transition(
    implementation = _test_profile_impl,
    inputs = [],
    outputs = ["//command_line_option:compilation_mode", "@rules_rust//rust/settings:extra_rustc_flags"],
)

def _package_test_impl(ctx):
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    binary = ctx.executable.binary
    # Bazel provides an isolated runfiles tree. Child tests re-execute the real
    # Rust binary, and package fixtures are immutable inputs to this test action.
    ctx.actions.write(
        executable,
        """#!/bin/sh
set -eu
root="$TEST_SRCDIR/$TEST_WORKSPACE"
binary="$root/%s"
export CARGO_MANIFEST_DIR="$root/%s"
cd "$CARGO_MANIFEST_DIR"
exec "$binary" "$@"
""" % (binary.short_path, ctx.attr.package_path),
        is_executable = True,
    )
    runfiles = ctx.runfiles(files = [binary] + ctx.files.data)
    runfiles = runfiles.merge(ctx.attr.binary[0][TestRuntimeInfo].runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = executable, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

_package_test = rule(
    implementation = _package_test_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "binary": attr.label(providers = [TestRuntimeInfo], executable = True, cfg = _test_profile, mandatory = True),
        "package_path": attr.string(mandatory = True),
        "data": attr.label_list(allow_files = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def merkur_rust_test(name, data = [], tags = [], **kwargs):
    """Compile a distinct libtest binary, then execute in its package runfiles."""
    rust_test(
        name = name + "_binary",
        data = data,
        tags = ["manual"] + tags,
        **kwargs
    )
    _package_test(
        name = name,
        binary = ":" + name + "_binary",
        package_path = native.package_name(),
        data = data,
        tags = tags,
        size = "large",
    )

def merkur_rust_doc_test(name, data = [], tags = [], **kwargs):
    """Rustdoc compilation and execution use the same explicit test profile."""
    rust_doc_test(name = name + "_binary", tags = ["manual"] + tags, **kwargs)
    _package_test(
        name = name,
        binary = ":" + name + "_binary",
        package_path = native.package_name(),
        data = data,
        tags = tags,
        size = "large",
    )

def _model_failure_test_impl(ctx):
    binary = ctx.executable.binary
    checker = ctx.executable.checker
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, """#!/bin/sh
set -eu
root="$TEST_SRCDIR/$TEST_WORKSPACE"
export CARGO_MANIFEST_DIR="$root/%s"
cd "$CARGO_MANIFEST_DIR"
exec "$root/%s" "$root/%s" '%s' '%s'
""" % (ctx.label.package, checker.short_path, binary.short_path, ctx.attr.filter, ctx.attr.signal), is_executable = True)
    runfiles = ctx.runfiles(files = [binary, checker] + ctx.files.data)
    runfiles = runfiles.merge(ctx.attr.binary[0][TestRuntimeInfo].runfiles).merge(ctx.attr.checker[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = executable, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

_model_failure_test = rule(
    implementation = _model_failure_test_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "binary": attr.label(providers = [TestRuntimeInfo], executable = True, cfg = _test_profile, mandatory = True),
        "checker": attr.label(default = "//tools/bazel/rust:check_model_failure", executable = True, cfg = "target"),
        "data": attr.label_list(allow_files = True),
        "filter": attr.string(mandatory = True),
        "signal": attr.string(mandatory = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def merkur_rust_negative_test(name, filter, signal, data = [], **kwargs):
    """Build a separate mutant binary and require its intended model failure."""
    rust_test(name = name + "_binary", data = data, tags = ["manual"], **kwargs)
    _model_failure_test(name = name, binary = ":" + name + "_binary", filter = filter, signal = signal, data = data)

def profile_flags():
    """Match the workspace profiles without changing assertion semantics."""
    return select({
        "//tools/bazel/rust:dev": ["-Copt-level=0", "-Cdebuginfo=2", "-Cdebug-assertions=yes", "-Coverflow-checks=yes"],
        "//tools/bazel/rust:release": ["-Copt-level=3", "-Cdebuginfo=0", "-Cdebug-assertions=no", "-Coverflow-checks=no"],
        "//conditions:default": ["-Copt-level=1", "-Cdebuginfo=line-tables-only", "-Cdebug-assertions=yes", "-Coverflow-checks=yes"],
    }) + select({
        "@platforms//cpu:x86_64": ["-Ctarget-feature=+ssse3"],
        "//tools/bazel/rust:wasm": ["--cfg=getrandom_backend=\"wasm_js\""],
        "//conditions:default": [],
    })
