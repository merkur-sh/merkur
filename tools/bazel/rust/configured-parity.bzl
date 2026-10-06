"""Declared Python checks over the exact retained Cargo/compiler source graph."""
load(":metadata_resolution_inputs.bzl", "METADATA_RESOLUTION_INPUTS")
load("//tools/bazel/rust/units:source_groups.bzl", "UNIT_SOURCE_GROUPS")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _configured_parity_impl(ctx):
    python = ctx.executable._python
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        '"$r/%s" -B -I "$r/%s" --root "$r/_main"' % (_runfile(python), _runfile(ctx.file.checker)),
        'exec "$r/%s" -B -I "$r/%s"' % (_runfile(python), _runfile(ctx.file.controls)),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = [python, ctx.file.checker, ctx.file.controls] + ctx.files.sources).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [
        TestRuntimeInfo(runfiles = runtime),
        DefaultInfo(executable = launcher, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
    ]

_configured_parity_test = rule(
    implementation = _configured_parity_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "checker": attr.label(allow_single_file = True, default = "//tools/bazel/rust:configured_parity.py"),
        "controls": attr.label(allow_single_file = True, default = "//tools/bazel/rust:configured_parity_test.py"),
        "sources": attr.label_list(allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)

def configured_rust_parity_test(name, **kwargs):
    # Reuse the generator-owned original metadata inventory. Package data is
    # needed by the existing native receipt validator, rather than a new index.
    packages = sorted({Label(label).package: True for label in METADATA_RESOLUTION_INPUTS if label.endswith(":Cargo.toml") and not Label(label).package.startswith("tools/bazel/rust/contexts/")}.keys())
    _configured_parity_test(
        name = name,
        sources = METADATA_RESOLUTION_INPUTS + UNIT_SOURCE_GROUPS + [
            "//tools/bazel/rust:verification_inputs",
            "//tools/bazel/rust/units:verification_inputs",
        ] + ["//" + package + ":verification_inputs" for package in packages],
        **kwargs
    )
