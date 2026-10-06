"""Own a real NAPI compiler side output through the original Rust output group."""
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _napi_output_test_impl(ctx):
    groups = ctx.attr.library[OutputGroupInfo]
    if not hasattr(groups, "napi_type_defs"):
        fail("NAPI controls require the original compiler napi_type_defs output group")
    outputs = groups.napi_type_defs.to_list()
    if len(outputs) != 1 or not outputs[0].is_directory:
        fail("NAPI compiler output group must contain exactly one directory")
    sdk = ctx.attr._python[NativeSdkInfo]
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="${RUNFILES_DIR:-$0.runfiles}"',
        'export PATH=/__no_ambient_path__',
        'export DYLD_LIBRARY_PATH="$r/%s/lib"' % sdk.prefix_runfile,
        'export DYLD_FALLBACK_LIBRARY_PATH=/__no_ambient_libraries__',
        'export LD_LIBRARY_PATH="$r/%s/lib"' % sdk.prefix_runfile,
        'exec "$r/%s" -I "$r/%s" --directory "$r/%s" --publisher "$r/%s"' % (_runfile(sdk.binary), _runfile(ctx.file._checker), _runfile(outputs[0]), _runfile(ctx.file._publisher)),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = [sdk.binary, ctx.file._checker, ctx.file._publisher] + outputs).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [DefaultInfo(executable = launcher, runfiles = runfiles), TestRuntimeInfo(runfiles = runtime)]

napi_output_test = rule(
    implementation = _napi_output_test_impl,
    test = True,
    attrs = {
        "library": attr.label(mandatory = True, providers = [OutputGroupInfo]),
        "_publisher": attr.label(default = "//tools/bazel/rust:rolldown_acquire.py", allow_single_file = True),
        "_checker": attr.label(default = "//tools/bazel/rust/napi_controls:check_output.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec", providers = [NativeSdkInfo]),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)
