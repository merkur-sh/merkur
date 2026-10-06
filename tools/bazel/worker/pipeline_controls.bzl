"""Real compiler metadata-to-object controls; worker production remains disabled."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if toolchain.version != "1.97.1" or toolchain.exec_triple.str not in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"] or toolchain.target_triple.str != toolchain.exec_triple.str:
        fail("Pipeline controls require their original matching native Rust1.97.1 toolchain")
    python = ctx.attr.python[DefaultInfo].files_to_run.executable
    wrapper = ctx.executable.wrapper
    anchor = toolchain.sysroot_anchor
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "#!/bin/sh\nset -eu\nr=${TEST_SRCDIR:?}\nexec \"$r/%s\" -B -I \"$r/%s\" --wrapper \"$r/%s\" --rustc \"$r/%s\" --sysroot \"$r/%s\"\n" % (_runfile(python), _runfile(ctx.file._test), _runfile(wrapper), _runfile(toolchain.rustc), _runfile(anchor).rsplit("/", 1)[0]), is_executable = True)
    runtime = ctx.runfiles(files = [python, wrapper, ctx.file._test], transitive_files = toolchain.all_files).merge(ctx.attr.python[DefaultInfo].default_runfiles).merge(ctx.attr.wrapper[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = launcher, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))), TestRuntimeInfo(runfiles = runtime)]

stable_pipeline_controls_test = rule(
    implementation = _impl,
    test = True,
    attrs = {
        "python": attr.label(executable = True, cfg = "exec", mandatory = True),
        "wrapper": attr.label(executable = True, cfg = "exec", default = "@rules_rust//util/process_wrapper"),
        "_test": attr.label(allow_single_file = True, default = ":pipeline-test.py"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)
