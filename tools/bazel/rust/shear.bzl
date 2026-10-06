"""The upstream CargoShear parser consumes only declared sources and locked metadata."""
load(":shear_inputs.bzl", "SHEAR_SOURCE_GROUPS")

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _impl(ctx):
    bun = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    sources = {}
    for file in ctx.files.sources:
        if file.is_directory or file.short_path.startswith("../"):
            fail("CargoShear workspace sources must be first-party regular File inputs")
        if file.short_path in sources:
            fail("Duplicate CargoShear logical source: " + file.short_path)
        sources[file.short_path] = file.short_path
    pieces = {}
    for file in ctx.files.metadata_parts:
        if file.basename in pieces:
            fail("Duplicate CargoShear metadata member")
        pieces[file.basename] = file.short_path
    descriptor = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(descriptor, json.encode({
        "sources": sources,
        "pieces": pieces,
        "authority": ctx.file.authority.short_path,
        "analyzer": ctx.executable.analyzer.short_path,
    }))
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, """#!/bin/bash
set -euo pipefail
root="${RUNFILES_DIR:-$0.runfiles}/_main"
exec "$root/%s" --no-env-file --config="$root/%s" "$root/%s" "$root/%s" "$root"
""" % (bun.short_path, ctx.file._bun_config.short_path, ctx.file._runner.short_path, descriptor.short_path), is_executable = True)
    files = ctx.files.sources + ctx.files.metadata_parts + [ctx.file.authority, ctx.executable.analyzer, descriptor, bun, ctx.file._runner, ctx.file._bun_config]
    runfiles = ctx.runfiles(files = files).merge(ctx.attr.analyzer[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = executable, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

_shear_test = rule(
    implementation = _impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "analyzer": attr.label(default = "//tools/bazel/rust/shear_tools:cargo_shear", cfg = "exec", executable = True),
        "sources": attr.label_list(allow_files = True),
        "authority": attr.label(default = ":shear/snapshot.json", allow_single_file = True),
        "metadata_parts": attr.label_list(allow_files = True),
        "_runner": attr.label(default = ":shear.ts", allow_single_file = True),
        "_bun_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def rust_dependency_shear_test(name):
    _shear_test(
        name = name,
        sources = ["//:Cargo.toml", "//:Cargo.lock", "//:rust-toolchain.toml", "//:.cargo/config.toml", "//:.gitignore"] + SHEAR_SOURCE_GROUPS,
        metadata_parts = native.glob(["shear/*.json"], exclude = ["shear/snapshot.json"]),
        tags = ["manual"],
    )
