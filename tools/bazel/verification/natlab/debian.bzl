"""One original Debian rootfs/package acquisition boundary for native consumers."""

DebianRootfsInfo = provider(fields = {
    "rootfs": "Composed original rootfs tar File",
    "base_rootfs": "Original publisher OCI rootfs layer File",
    "base_config": "Original publisher OCI config File",
    "base_index": "Original publisher multi-platform OCI index File",
    "base_manifest": "Original publisher native OCI manifest File",
    "attribution": "SHA-bound original package and license facts JSON File",
    "licenses": "Actual resolved original copyright bytes TreeArtifact",
    "inventory": "Exact original input byte/mode inventory JSON File",
    "context": "Consumer, native platform and source inventory binding JSON File",
    "sdk_files": "Complete original input File depset",
    "target": "linux-amd64 or linux-arm64",
    "distribution": "Original Debian distribution",
    "base_index_digest": "Original publisher pinned OCI index digest",
})

def _impl(ctx):
    rootfs = ctx.actions.declare_file(ctx.label.name + ".rootfs.tar")
    licenses = ctx.actions.declare_directory(ctx.label.name + ".licenses")
    attribution = ctx.actions.declare_file(ctx.label.name + ".attribution.json")
    inventory = ctx.actions.declare_file(ctx.label.name + ".inventory.json")
    context = ctx.actions.declare_file(ctx.label.name + ".context.json")
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    packages = {}
    for target, name in ctx.attr.packages.items():
        files = target[DefaultInfo].files.to_list()
        if name in packages or len(files) != 1 or files[0].is_directory:
            fail("Debian packages require one unique package name and original archive File")
        packages[name] = files[0].path
    ctx.actions.write(request, json.encode({
        "consumer": ctx.attr.consumer,
        "architecture": ctx.attr.architecture,
        "distribution": ctx.attr.distribution,
        "base_index_digest": ctx.attr.base_index_digest,
        "lock": ctx.file.lock.path,
        "base": ctx.file.base.path,
        "config": ctx.file.base_config.path,
        "index": ctx.file.base_index.path,
        "manifest": ctx.file.base_manifest.path,
        "packages": packages,
        "rootfs": rootfs.path,
        "licenses": licenses.path,
        "attribution": attribution.path,
        "inventory": inventory.path,
        "context": context.path,
    }))
    inputs = [ctx.file.lock, ctx.file.base, ctx.file.base_config, ctx.file.base_index, ctx.file.base_manifest] + ctx.files.packages
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._builder.path, request.path],
        inputs = [request, ctx.file._builder] + inputs,
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [rootfs, licenses, attribution, inventory, context],
        mnemonic = "OriginalDebianRootfs",
        env = {},
        use_default_shell_env = False,
    )
    return [
        DefaultInfo(files = depset([rootfs, licenses, attribution, inventory, context])),
        DebianRootfsInfo(
            rootfs = rootfs, base_rootfs = ctx.file.base, base_config = ctx.file.base_config,
            base_index = ctx.file.base_index, base_manifest = ctx.file.base_manifest,
            attribution = attribution, licenses = licenses, inventory = inventory, context = context,
            sdk_files = depset(inputs), target = "linux-" + ctx.attr.architecture,
            distribution = ctx.attr.distribution, base_index_digest = ctx.attr.base_index_digest,
        ),
    ]

debian_rootfs = rule(
    implementation = _impl,
    attrs = {
        "consumer": attr.string(values = ["natlab", "edge", "stun", "tpm"], mandatory = True),
        "architecture": attr.string(values = ["amd64", "arm64"], mandatory = True),
        "distribution": attr.string(values = ["bookworm", "trixie"], mandatory = True),
        "base_index_digest": attr.string(mandatory = True),
        "lock": attr.label(allow_single_file = True, mandatory = True),
        "base": attr.label(allow_single_file = True, mandatory = True),
        "base_config": attr.label(allow_single_file = True, mandatory = True),
        "base_index": attr.label(allow_single_file = True, mandatory = True),
        "base_manifest": attr.label(allow_single_file = True, mandatory = True),
        "packages": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "_builder": attr.label(default = "//tools/bazel/verification:natlab/rootfs.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
