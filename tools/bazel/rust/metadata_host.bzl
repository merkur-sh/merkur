"""Declared native host/tool inventory for exact Cargo metadata acquisition."""

_HOSTS = {
    "darwin_arm64": ("aarch64-apple-darwin", ["@platforms//os:macos", "@platforms//cpu:aarch64"]),
    "darwin_x64": ("x86_64-apple-darwin", ["@platforms//os:macos", "@platforms//cpu:x86_64"]),
    "linux_arm64": ("aarch64-unknown-linux-gnu", ["@platforms//os:linux", "@platforms//cpu:aarch64"]),
    "linux_x64": ("x86_64-unknown-linux-gnu", ["@platforms//os:linux", "@platforms//cpu:x86_64"]),
}

def _metadata_host_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if toolchain.version != "1.97.1" or toolchain.exec_triple.str != ctx.attr.execution_host:
        fail("Metadata acquisition requires exact Rust1.97.1 and the declared native execution host")
    inputs = {}
    for source in ctx.files.sources:
        inputs[source.path] = "source"
    for source in toolchain.all_files.to_list():
        inputs[source.path] = "toolchain"
    descriptor = ctx.actions.declare_file(ctx.label.name + ".descriptor.json")
    receipt = ctx.actions.declare_file(ctx.label.name + ".receipt.json")
    ctx.actions.write(descriptor, json.encode({
        "execution_host": ctx.attr.execution_host,
        "rust_release": toolchain.version,
        "cargo": toolchain.cargo.path,
        "rustc": toolchain.rustc.path,
        "targets": sorted([identity[0] for identity in _HOSTS.values()] + ["wasm32-unknown-unknown"]),
        "inputs": [{"path": path, "role": role} for path, role in sorted(inputs.items())],
    }))
    ctx.actions.run(
        executable = ctx.executable._capture,
        arguments = [descriptor.path, receipt.path],
        inputs = depset([descriptor] + ctx.files.sources, transitive = [toolchain.all_files]),
        tools = [ctx.attr._capture[DefaultInfo].files_to_run],
        outputs = [receipt],
        mnemonic = "MerkurMetadataHostIdentity",
        env = {},
    )
    return [DefaultInfo(files = depset([descriptor, receipt]))]

_metadata_host = rule(
    implementation = _metadata_host_impl,
    attrs = {
        "execution_host": attr.string(mandatory = True),
        "sources": attr.label_list(allow_files = True),
        "_capture": attr.label(default = ":metadata_host_identity", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def declare_metadata_hosts(sources):
    for name, identity in _HOSTS.items():
        _metadata_host(
            name = "metadata_host__" + name,
            execution_host = identity[0],
            sources = sources,
            exec_compatible_with = identity[1],
            tags = ["manual"],
        )
