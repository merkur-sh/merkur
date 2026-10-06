"""Nonce-keyed standalone Kani compilation and bounded verification tests."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")

_TYPE = "//tools/bazel/rust:kani_toolchain_type"

def _kani_toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(driver = ctx.file.driver, cargo = ctx.file.cargo, files = depset(ctx.files.files + [ctx.file.cargo]))]

kani_toolchain = rule(
    implementation = _kani_toolchain_impl,
    attrs = {
        "driver": attr.label(allow_single_file = True, mandatory = True),
        "cargo": attr.label(allow_single_file = True, mandatory = True),
        "files": attr.label_list(allow_files = True),
    },
)

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def kani_native_environment(ctx):
    """The exact declared native preprocessor closure shared by Kani tests."""
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc)
    compiler = cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.c_compile)
    files = {file.path: _runfile(file) for file in cc.all_files.to_list()}
    if compiler not in files:
        fail("Kani requires its native preprocessor in the complete declared CcToolchain File closure")
    return struct(files = cc.all_files, configuration = {
        "compiler": compiler,
        "flags": cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables),
        "environment": cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables),
        "files": files,
    })

def _kani_proof_impl(ctx):
    toolchain = ctx.toolchains[_TYPE]
    cc = kani_native_environment(ctx)
    native = ctx.actions.declare_file(ctx.label.name + ".native.json")
    ctx.actions.write(native, json.encode(dict(cc.configuration, checker = ctx.executable.checker.path, production_sources = ctx.file.production_sources.path)))
    python = ctx.executable._python
    checker = ctx.executable.checker
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    # The entire genuine compiler/solver pipeline belongs to the test action.
    # Its result is keyed by the nonce; no solver verdict is a cached build output.
    ctx.actions.write(executable, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -B -I "$r/%s" --driver "$r/%s" --checker "$r/%s" --source "$r/%s" --native "$r/%s" --runfiles "$r" %s' % (
            _runfile(python), _runfile(ctx.file._runner), _runfile(toolchain.driver),
            _runfile(checker), _runfile(ctx.file.src),
            _runfile(native),
            "--negative" if ctx.attr.negative else "",
        ),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(
        files = [python, ctx.file._runner, toolchain.driver, ctx.file.src, ctx.file.production_sources, checker, native],
        transitive_files = depset(transitive = [toolchain.files, cc.files]),
    ).merge(ctx.attr._python[DefaultInfo].default_runfiles).merge(ctx.attr.checker[DefaultInfo].default_runfiles)
    return [
        TestRuntimeInfo(runfiles = runtime),
        DefaultInfo(executable = executable, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
    ]

kani_proof_test = rule(
    implementation = _kani_proof_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "src": attr.label(allow_single_file = [".rs"], mandatory = True),
        "production_sources": attr.label(allow_single_file = True, mandatory = True),
        "checker": attr.label(default = "//tools/bazel/rust:check_kani", executable = True, cfg = "target"),
        "negative": attr.bool(default = False),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(allow_single_file = True, default = "//tools/bazel/rust:kani_runner.py"),
    },
    toolchains = [_TYPE] + use_cc_toolchain(),
    fragments = ["cpp"],
)
