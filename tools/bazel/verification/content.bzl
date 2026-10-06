"""Content gates over a declared immutable repository tree, executed by Bazel."""

load("//tools/bazel/bun:rules.bzl", "bun_inputs")
load(":test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runtime_runfiles(target):
    return target[TestRuntimeInfo].runfiles if TestRuntimeInfo in target else target[DefaultInfo].default_runfiles

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"

def _impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_file(ctx.label.name + ".sh")
    tool = ctx.executable.native_tool
    entry = _quote(ctx.attr.entry_point)
    if tool:
        entry = '"$runfiles/%s" "$tree" %s "$runfiles/%s"' % (_runfile(ctx.file.runner), _quote(ctx.attr.command), _runfile(tool))
    elif ctx.file.runner:
        fail("Native content runners require a declared executable dependency")
    ctx.actions.write(output, """#!/bin/sh
set -eu
runfiles=${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}
export RUNFILES_DIR="$runfiles"
runtime="$runfiles/%s"
tree="$runfiles/%s"
configuration="$runfiles/%s"
export HOME="$TEST_TMPDIR"
export PATH="${runtime%%/bun}"
unset NODE_PATH BUN_INSTALL BUN_OPTIONS BUN_CONFIG_VERBOSE_FETCH BUN_CONFIG_NO_CLEAR_TERMINAL
cd "$tree"
# Runfiles provide a carrier alias for the declared TreeArtifact. Native scanners
# must receive its physical root, matching the directory returned by getcwd().
tree=$(pwd -P)
exec "$runtime" --no-install --no-env-file --config="$configuration" %s
""" % (_runfile(runtime), _runfile(ctx.file.tree), _runfile(ctx.file._config), entry), is_executable = True)
    runfiles = ctx.runfiles(files = [runtime, ctx.file.tree, ctx.file._config] + ([ctx.file.runner] if ctx.file.runner else []), transitive_files = bun_inputs(ctx.attr.data))
    for target in ctx.attr.data:
        runfiles = runfiles.merge(_runtime_runfiles(target))
    if tool:
        runfiles = runfiles.merge(ctx.runfiles(files = [tool])).merge(_runtime_runfiles(ctx.attr.native_tool))
    runtime_info = TestRuntimeInfo(runfiles = runfiles)
    runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [DefaultInfo(executable = output, runfiles = runfiles), runtime_info]

content_check_test = rule(
    implementation = _impl,
    attrs = {
        "tree": attr.label(allow_single_file = True, mandatory = True),
        "entry_point": attr.string(),
        "runner": attr.label(allow_single_file = True),
        "command": attr.string(),
        "native_tool": attr.label(executable = True, cfg = "exec"),
        "data": attr.label_list(allow_files = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
    test = True,
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)
