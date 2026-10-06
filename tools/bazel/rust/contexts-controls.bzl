"""Unchanged simulator metadata controls with their declared SDK/source argv."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _contexts_controls_impl(ctx):
    python = ctx.executable._python
    bun = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(script, """#!/bin/sh
set -eu
r="${TEST_SRCDIR:?}"
exec "$r/%s" -B -I "$r/%s" --bun "$r/%s" --recipe "$r/%s" --workspace-helper "$r/%s"
""" % (_runfile(python), _runfile(ctx.file.controls), _runfile(bun), _runfile(ctx.file.recipe), _runfile(ctx.file.workspace_helper)), is_executable = True)
    runtime = ctx.runfiles(files = [python, bun, ctx.file.controls, ctx.file.contexts, ctx.file.acquisition_sdk, ctx.file.recipe, ctx.file.workspace_helper], transitive_files = ctx.attr._python[DefaultInfo].files)
    runtime = runtime.merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [
        TestRuntimeInfo(runfiles = runtime),
        DefaultInfo(executable = script, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
    ]

contexts_simulator_controls_test = rule(
    implementation = _contexts_controls_impl,
    test = True,
    attrs = {
        "controls": attr.label(default = "//tools/bazel/rust:contexts_simulator_test.py", allow_single_file = True),
        "contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
        "acquisition_sdk": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "recipe": attr.label(default = "//scripts:sim-tests.ts", allow_single_file = True),
        "workspace_helper": attr.label(default = "//scripts:generated-cargo-workspace.ts", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def _protocol_controls_impl(ctx):
    python = ctx.executable._python
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(script, """#!/bin/sh
set -eu
r="${TEST_SRCDIR:?}"
exec "$r/%s" -B -I "$r/%s" --contexts "$r/%s"
""" % (_runfile(python), _runfile(ctx.file.controls), _runfile(ctx.file.contexts)), is_executable = True)
    runtime = ctx.runfiles(files = [python, ctx.file.controls, ctx.file.contexts, ctx.file.acquisition_sdk], transitive_files = ctx.attr._python[DefaultInfo].files)
    runtime = runtime.merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [
        TestRuntimeInfo(runfiles = runtime),
        DefaultInfo(executable = script, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
    ]

contexts_protocol_controls_test = rule(
    implementation = _protocol_controls_impl,
    test = True,
    attrs = {
        "controls": attr.label(default = "//tools/bazel/rust:contexts_protocol_test.py", allow_single_file = True),
        "contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
        "acquisition_sdk": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)
