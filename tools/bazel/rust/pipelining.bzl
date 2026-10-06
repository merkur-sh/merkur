"""Qualification fixture for the pinned stable metadata-termination pipeline."""
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _rust_pipelining_test_impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str != rust.target_triple.str:
        fail("Pipelining qualification requires the exact native stable Rust1.97.1 toolchain")
    python = ctx.executable._python
    wrapper = ctx.executable._wrapper
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -B -I "$r/%s" --rustc "$r/%s" --wrapper "$r/%s" --dependency "$r/%s" --consumer "$r/%s" --failure "$r/%s"' % (
            _runfile(python), _runfile(ctx.file.controls), _runfile(rust.rustc),
            _runfile(wrapper), _runfile(ctx.file.dependency), _runfile(ctx.file.consumer),
            _runfile(ctx.file.failure),
        ),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(
        files = [python, wrapper, ctx.file.controls, ctx.file.dependency, ctx.file.consumer, ctx.file.failure],
        transitive_files = rust.all_files,
    ).merge(ctx.attr._python[DefaultInfo].default_runfiles).merge(ctx.attr._wrapper[DefaultInfo].default_runfiles)
    return [
        TestRuntimeInfo(runfiles = runtime),
        DefaultInfo(executable = launcher, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
    ]

rust_pipelining_test = rule(
    implementation = _rust_pipelining_test_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "controls": attr.label(allow_single_file = True, default = "//tools/bazel/rust:pipelining_controls.py"),
        "dependency": attr.label(allow_single_file = True, default = "//tools/bazel/rust:pipelining_dependency.rs"),
        "consumer": attr.label(allow_single_file = True, default = "//tools/bazel/rust:pipelining_consumer.rs"),
        "failure": attr.label(allow_single_file = True, default = "//tools/bazel/rust:pipelining_failure.rs"),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_wrapper": attr.label(default = "@rules_rust//util/process_wrapper:process_wrapper", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)
