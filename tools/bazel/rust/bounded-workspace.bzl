"""The original generated Bolero/Kani workspace and its locked offline sources."""
load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo")

BoundedWorkspaceInfo = provider(fields = ["tree", "manifest", "lock", "vendor_config", "execution_host", "rust_flags"])

def _bounded_workspace_impl(ctx):
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    tree = ctx.actions.declare_directory(ctx.label.name + ".workspace")
    manifest = ctx.actions.declare_file(ctx.label.name + ".Cargo.toml")
    lock = ctx.actions.declare_file(ctx.label.name + ".Cargo.lock")
    vendor_config = ctx.actions.declare_file(ctx.label.name + ".vendor-config.toml")
    files = {
        "descriptor": sdk.descriptor,
        "provenance": sdk.provenance,
        "source-root": sdk.sources,
        "registry": sdk.registry,
        "capture": ctx.file._capture,
        "materializer": ctx.file._materializer,
        "sdk-resolver": ctx.file._resolver,
        "contexts": ctx.file._contexts,
        "tree": tree,
        "manifest": manifest,
        "lock": lock,
        "vendor-config": vendor_config,
    }
    arguments = ["-B", "-I", ctx.file._runner.path, "--producer", str(ctx.attr.sdk.label), "--execution-host", ctx.attr.execution_host]
    for flag, file in files.items():
        arguments.extend(["--" + flag, file.path])
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = arguments,
        inputs = depset([sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry, ctx.file._runner, ctx.file._capture, ctx.file._materializer, ctx.file._resolver, ctx.file._contexts], transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [tree, manifest, lock, vendor_config],
        env = {},
        use_default_shell_env = False,
        mnemonic = "BoundedCargoWorkspace",
    )
    rust_flags = ["--cfg", "merkur_fuzz"]
    if ctx.attr.execution_host.startswith("x86_64-"):
        rust_flags.extend(["-C", "target-feature=+ssse3"])
    outputs = depset([tree, manifest, lock, vendor_config])
    return [
        DefaultInfo(files = outputs, runfiles = ctx.runfiles(transitive_files = outputs)),
        BoundedWorkspaceInfo(tree = tree, manifest = manifest, lock = lock, vendor_config = vendor_config,
                             execution_host = ctx.attr.execution_host, rust_flags = rust_flags),
    ]

bounded_workspace = rule(
    implementation = _bounded_workspace_impl,
    attrs = {
        "sdk": attr.label(mandatory = True, providers = [CargoAcquisitionSdkInfo]),
        "execution_host": attr.string(mandatory = True, values = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]),
        "_runner": attr.label(default = "//tools/bazel/rust:bounded-workspace.py", allow_single_file = True),
        "_capture": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_materializer": attr.label(default = "//tools/bazel/rust/acquire:sdk_metadata.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
