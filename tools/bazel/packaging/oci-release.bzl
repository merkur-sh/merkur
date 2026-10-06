"""Original service images from actual native artifacts and immutable Debian inputs."""

load("//tools/bazel/verification:natlab/debian.bzl", "DebianRootfsInfo")
load(":notices.bzl", "SelectedAttributionInfo")

_BASE_INDEX = "sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171"

def _release_impl(_settings, _attr):
    return {"//command_line_option:compilation_mode": "opt", "//command_line_option:platforms": ["//tools/bazel/platforms:linux_x64"]}

_release = transition(implementation = _release_impl, inputs = [], outputs = ["//command_line_option:compilation_mode", "//command_line_option:platforms"])

def _descriptor(file):
    return {"input": file.path, "label": str(file.owner)}

def _image_impl(ctx):
    kind = ctx.attr.kind
    runtime = ctx.attr.runtime[DebianRootfsInfo]
    if runtime.target != "linux-amd64" or runtime.distribution != "bookworm" or runtime.base_index_digest != _BASE_INDEX:
        fail("Release image requires the original pinned Bookworm Linux amd64 closure")
    outputs = ctx.attr.executable[DefaultInfo].files.to_list()
    if len(outputs) != 1 or outputs[0].is_directory:
        fail("Release image requires one exact compiled service executable")
    executable = outputs[0]
    selected = ctx.attr.attribution[SelectedAttributionInfo]
    if selected.scope != "rust" or selected.artifacts.to_list() != [executable] or selected.producer != str(executable.owner):
        fail("Image attribution lacks custody of its actual native release executable")
    expected = "//apps/%s:merkur_%s" % (kind, kind)
    actual = "//%s:%s" % (ctx.attr.executable.label.package, ctx.attr.executable.label.name)
    if actual != expected or ctx.file.entrypoint.owner != Label("//apps/%s:entrypoint.sh" % kind):
        fail("Release image must retain the original executable and entrypoint labels")
    artifact = ctx.actions.declare_file(kind + "-image.tar.gz")
    signing = ctx.actions.declare_file(kind + "-image.signing-inputs.json")
    inventory = ctx.actions.declare_file(kind + "-image.attribution.json")
    notices = ctx.actions.declare_file(kind + "-image.NOTICES.txt")
    source = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    runtime_files = {
        "rootfs": runtime.rootfs,
        "base_config": runtime.base_config,
        "base_index": runtime.base_index,
        "base_manifest": runtime.base_manifest,
        "attribution": runtime.attribution,
        "licenses": runtime.licenses,
        "inventory": runtime.inventory,
        "context": runtime.context,
    }
    ctx.actions.write(source, json.encode({
        "kind": kind,
        "producer": str(artifact.owner),
        "runtime": {name: _descriptor(file) for name, file in runtime_files.items()},
        "executable": _descriptor(executable),
        "entrypoint": _descriptor(ctx.file.entrypoint),
        "rust": {
            "role": kind,
            "scope": selected.scope,
            "producer": selected.producer,
            "configuration": _descriptor(selected.configuration),
            "source_inventory": _descriptor(selected.source_inventory),
            "inventory": _descriptor(selected.inventory),
            "notices": _descriptor(selected.notices),
        },
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", "-B", ctx.file._runner.path, source.path, artifact.path, signing.path, inventory.path, notices.path],
        inputs = depset([source, ctx.file._runner, executable, ctx.file.entrypoint, selected.configuration, selected.source_inventory, selected.inventory, selected.notices] + runtime_files.values() + ctx.files._modules, transitive = [runtime.sdk_files]),
        outputs = [artifact, signing, inventory, notices],
        env = {"PYTHONHASHSEED": "0"},
        mnemonic = "UnsignedServiceImage",
        use_default_shell_env = False,
    )
    contract = ctx.actions.declare_file(ctx.label.name + ".unsigned-contract.json")
    ctx.actions.write(contract, json.encode({
        "label": "//%s:%s" % (ctx.label.package, ctx.label.name),
        "group": "default",
        "outputs": [{"path": file.path, "destination": file.basename} for file in [artifact, signing]],
    }))
    return [
        DefaultInfo(files = depset([artifact, signing])),
        SelectedAttributionInfo(scope = "container-image", producer = str(artifact.owner), artifacts = depset([artifact]), configuration = runtime.context, source_inventory = source, inventory = inventory, notices = notices),
        OutputGroupInfo(archive = depset([artifact]), signing_inputs = depset([signing]), attribution = depset([inventory]), notices = depset([notices]), unsigned_contract = depset([contract])),
    ]

unsigned_service_image = rule(
    implementation = _image_impl,
    cfg = _release,
    attrs = {
        "kind": attr.string(mandatory = True, values = ["edge", "stun"]),
        "runtime": attr.label(providers = [DebianRootfsInfo], mandatory = True),
        "executable": attr.label(mandatory = True),
        "entrypoint": attr.label(allow_single_file = True, mandatory = True),
        "attribution": attr.label(providers = [SelectedAttributionInfo], mandatory = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
        "_runner": attr.label(default = "//tools/bazel/packaging:oci-release.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:native-release.py", "//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:deployment-notices.py", "//tools/bazel/packaging:license-closure.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    },
)

def declare_unsigned_service_images(edge_runtime, stun_runtime, edge_attribution, stun_attribution):
    for kind, runtime, attribution in [("edge", edge_runtime, edge_attribution), ("stun", stun_runtime, stun_attribution)]:
        unsigned_service_image(
            name = kind + "_image_unsigned",
            kind = kind,
            runtime = runtime,
            attribution = attribution,
            executable = "//apps/%s:merkur_%s" % (kind, kind),
            entrypoint = "//apps/%s:entrypoint.sh" % kind,
            tags = ["manual"],
        )
