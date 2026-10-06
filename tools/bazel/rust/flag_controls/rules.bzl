"""Native Cargo is an introspection oracle for capture controls, never a builder."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    if file.short_path.startswith("../"):
        return file.short_path[3:]
    return "_main/" + file.short_path

def _cargo_flag_capture_test_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    cargo = toolchain.cargo
    rustc = toolchain.rustc
    if cargo == None or rustc == None or toolchain.version != "1.97.1":
        fail("Cargo flag capture controls require the pinned native Rust1.97.1 SDK")
    if toolchain.exec_triple.str != toolchain.target_triple.str:
        fail("Cargo flag controls require the exact native execution-host SDK")
    python = ctx.executable._python
    sdk_inputs = ctx.actions.declare_file(ctx.label.name + ".sdk-inputs.json")
    ctx.actions.write(sdk_inputs, json.encode({
        "execution_host": toolchain.exec_triple.str,
        "files": sorted([_runfile(file) for file in toolchain.all_files.to_list()]),
    }))
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(
        executable,
        "\n".join([
            "#!/bin/sh",
            "set -eu",
            'r="${RUNFILES_DIR:-$0.runfiles}"',
            'exec "$r/%s" -I "$r/%s" --contexts "$r/%s" --cargo "$r/%s" --rustc "$r/%s" --sdk-inputs "$r/%s" --sdk-resolver "$r/%s" --runfiles-root "$r"' % (
                _runfile(python),
                _runfile(ctx.file.controls),
                _runfile(ctx.file.contexts),
                _runfile(cargo),
                _runfile(rustc),
                _runfile(sdk_inputs),
                _runfile(ctx.file.sdk_resolver),
            ),
            "",
        ]),
        is_executable = True,
    )
    runfiles = ctx.runfiles(
        files = [python, ctx.file.controls, ctx.file.contexts, ctx.file.sdk_resolver, sdk_inputs],
        transitive_files = toolchain.all_files,
    ).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    runtime_runfiles = runfiles
    # The one selected epoch enters TestRunner only, after launcher publication.
    runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [DefaultInfo(executable = executable, runfiles = runfiles), TestRuntimeInfo(runfiles = runtime_runfiles)]

cargo_flag_capture_test = rule(
    implementation = _cargo_flag_capture_test_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "controls": attr.label(allow_single_file = True, mandatory = True),
        "contexts": attr.label(allow_single_file = True, mandatory = True),
        "sdk_resolver": attr.label(allow_single_file = True, default = "//tools/bazel/rust:acquisition_sdk.py"),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)
