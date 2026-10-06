"""Native producer regression with original inputs in nonce-keyed TestRunner."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _sdk_test_impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str != ctx.attr.execution_host or rust.target_triple.str != ctx.attr.execution_host:
        fail("SDK producer regression requires matching native Rust1.97.1 target and execution host")
    sources = []
    for target, logical in ctx.attr.source_files.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("Acquisition source mappings require one declared regular File")
        sources.append({"logical": logical, "path": files[0].short_path})
    archives = []
    for target, package in ctx.attr.archives.items():
        files = target[DefaultInfo].files.to_list()
        identity = package.split("@")
        if len(identity) != 2 or len(files) != 1 or files[0].is_directory:
            fail("Original archive mappings require name@version and one declared File")
        archives.append({"name": identity[0], "version": identity[1], "path": files[0].short_path, "label": str(target.label)})
    # Match the production metadata-only runtime descriptor. The full toolchain
    # stays in runfiles, including Cc inputs that acquisition never executes.
    runtime_sdk = depset([rust.cargo, rust.rustc, rust.sysroot_anchor], transitive = [rust.rustc_lib, rust.rust_std])
    sdk = depset(transitive = [runtime_sdk, rust.all_files])
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    ctx.actions.write(request, json.encode({
        "producer": str(ctx.label),
        "version": rust.version,
        "execution_host": rust.exec_triple.str,
        "cargo": rust.cargo.short_path,
        "rustc": rust.rustc.short_path,
        "sdk": sorted([file.short_path for file in runtime_sdk.to_list()]),
        "sources": sources,
        "locks": ctx.attr.locks,
        "archives": archives,
    }))
    python = ctx.executable._python
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        # The nine-field producer request retains short paths. External Files
        # naturally resolve through ../<repository> from the main workspace.
        'cd "$r/$TEST_WORKSPACE"',
        'exec "$r/%s" -I -B "$r/%s" --request "$r/%s" --producer "$r/%s" --sdk-resolver "$r/%s"' % (
            _runfile(python), _runfile(ctx.file._driver), _runfile(request),
            _runfile(ctx.file._producer), _runfile(ctx.file._resolver),
        ),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(
        files = [python, ctx.file._driver, ctx.file._producer, ctx.file._resolver, request] + ctx.files.source_files + ctx.files.archives,
        transitive_files = sdk,
    ).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [
        TestRuntimeInfo(runfiles = runtime),
        DefaultInfo(executable = executable, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
    ]

cargo_acquisition_sdk_test = rule(
    implementation = _sdk_test_impl,
    test = True,
    attrs = {
        "execution_host": attr.string(mandatory = True),
        "source_files": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "locks": attr.string_list(mandatory = True),
        "archives": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "_driver": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer_test.py", allow_single_file = True),
        "_producer": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)
