"""Union the original configured native, deployment and image attribution outputs."""

load(":native-release.bzl", "NATIVE_RELEASE_PLATFORMS", "native_release_layout")
load(":notices.bzl", "DeploymentNoticesInfo", "SelectedAttributionInfo")

def _darwin_arm64(_settings, _attr):
    return {"//command_line_option:compilation_mode": "opt", "//command_line_option:platforms": ["//tools/bazel/platforms:macos_arm64"]}

def _darwin_x64(_settings, _attr):
    return {"//command_line_option:compilation_mode": "opt", "//command_line_option:platforms": ["//tools/bazel/platforms:macos_x64"]}

def _linux_arm64(_settings, _attr):
    return {"//command_line_option:compilation_mode": "opt", "//command_line_option:platforms": ["//tools/bazel/platforms:linux_arm64"]}

def _linux_x64(_settings, _attr):
    return {"//command_line_option:compilation_mode": "opt", "//command_line_option:platforms": ["//tools/bazel/platforms:linux_x64"]}

_OUTPUTS = ["//command_line_option:compilation_mode", "//command_line_option:platforms"]
_TRANSITIONS = {
    "darwin_arm64": transition(implementation = _darwin_arm64, inputs = [], outputs = _OUTPUTS),
    "darwin_x64": transition(implementation = _darwin_x64, inputs = [], outputs = _OUTPUTS),
    "linux_arm64": transition(implementation = _linux_arm64, inputs = [], outputs = _OUTPUTS),
    "linux_x64": transition(implementation = _linux_x64, inputs = [], outputs = _OUTPUTS),
}

def _file(file):
    return {"input": file.path, "label": str(file.owner)}

def unsigned_release_projection_error(files):
    """Select only the original ten shipping Files, never signing diagnostics."""
    expected = ["deployment.tar.gz", "edge-image.tar.gz", "stun-image.tar.gz", "NOTICES.txt"]
    for platform in NATIVE_RELEASE_PLATFORMS:
        kinds = ["daemon", "verify"] if platform.startswith("linux-") else ["daemon"]
        expected += [native_release_layout(kind, platform).artifact for kind in kinds]
    names = [file.basename for file in files]
    if any([file.is_directory for file in files]) or len({file: True for file in files}) != len(files):
        return "Unsigned release requires distinct ordinary original artifact Files"
    if sorted(names) != sorted(expected):
        return "Unsigned release requires exactly the ten original platform artifact Files"
    return None

def unsigned_release_projection(files):
    problem = unsigned_release_projection_error(files)
    if problem:
        fail(problem)
    return depset(files)

def _require_release_inputs(ctx):
    missing = []
    for platform in _TRANSITIONS:
        if not getattr(ctx.attr, platform + "_daemon"):
            missing.append(platform.replace("_", "-") + " daemon")
        if platform.startswith("linux_") and not getattr(ctx.attr, platform + "_utilities"):
            missing.append(platform.replace("_", "-") + " verifier")
    if not ctx.attr.deployment:
        missing.append("complete deployment NOTICES")
    if not ctx.attr.unsigned_deployment:
        missing.append("unsigned Linux amd64 deployment")
    if not ctx.attr.images:
        missing.append("original edge and STUN OCI images")
    if missing:
        fail("Unsigned release is missing real configured inputs: " + ", ".join(missing))

def _release_notices_impl(ctx):
    _require_release_inputs(ctx)
    inputs = []
    packages = []
    shipping = []
    for platform in _TRANSITIONS:
        targets = getattr(ctx.attr, platform + "_daemon")
        if len(targets) != 1:
            fail("Global notices require one exact native daemon configuration")
        if platform.startswith("linux_"):
            targets += getattr(ctx.attr, platform + "_utilities")
        expected = ["merkur-daemon-" + platform.replace("_", "-")]
        if platform.startswith("linux_"):
            expected += ["verify-" + platform.replace("_", "-")]
        if sorted([target.label.name for target in targets]) != sorted(expected):
            fail("Global notices require all exact native release producer labels")
        for target in targets:
            if target.label.package != "tools/bazel/packaging":
                fail("Global native attribution must come from original declared package actions")
            files = target[DefaultInfo].files.to_list()
            inventories = target[OutputGroupInfo].signing_inputs.to_list()
            if len(files) != 2 or len(inventories) != 1 or inventories[0] not in files:
                fail("Global notices require the package action's original signing-input File")
            artifacts = [file for file in files if file != inventories[0]]
            packages.append({"platform": platform.replace("_", "-"), "name": target.label.name, "artifact": _file(artifacts[0]), "inventory": _file(inventories[0])})
            inputs += files
            shipping += artifacts
    if len(ctx.attr.deployment) != 1:
        fail("Global notices require one exact Linux amd64 deployment configuration")
    service = ctx.attr.deployment[0][DeploymentNoticesInfo]
    deployment = ctx.attr.unsigned_deployment
    if len(deployment) != 1 or deployment[0].label != Label("//tools/bazel/packaging:deployment_unsigned"):
        fail("Unsigned release requires the original configured Linux amd64 deployment producer")
    target = deployment[0]
    archives = target[OutputGroupInfo].archive.to_list()
    if len(archives) != 1 or archives[0] not in target[DefaultInfo].files.to_list() or archives[0].basename != "deployment.tar.gz" or archives[0].is_directory or archives[0].owner != target.label:
        fail("Unsigned release requires the deployment producer's original archive File")
    shipping += archives
    images = []
    for target in ctx.attr.images:
        selected = target[SelectedAttributionInfo]
        files = selected.artifacts.to_list()
        if selected.scope != "container-image" or len(files) != 1 or files[0].basename not in ["edge-image.tar.gz", "stun-image.tar.gz"] or selected.producer != str(files[0].owner):
            fail("Global image notices require custody of both original configured images")
        images.append({"artifact": _file(files[0]), "producer": selected.producer, "configuration": _file(selected.configuration), "source_inventory": _file(selected.source_inventory), "inventory": _file(selected.inventory), "notices": _file(selected.notices)})
        inputs += files + [selected.configuration, selected.source_inventory, selected.inventory, selected.notices]
        shipping += files
    if sorted([item["artifact"]["input"].split("/")[-1] for item in images]) != ["edge-image.tar.gz", "stun-image.tar.gz"]:
        fail("Global notices require exact edge and STUN image closure")
    text = ctx.actions.declare_file("NOTICES.txt")
    inventory = ctx.actions.declare_file(ctx.label.name + ".attribution.json")
    source = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(source, json.encode({"packages": packages, "deployment": {"inventory": _file(service.inventory), "notices": _file(service.notices), "producers": {role: _file(file) for role, file in service.producers.items()}}, "images": images}))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", "-B", ctx.file._runner.path, source.path, inventory.path, text.path],
        inputs = depset(inputs + [service.inventory, service.notices, source, ctx.file._runner] + service.producers.values() + ctx.files._modules),
        outputs = [inventory, text],
        env = {"PYTHONHASHSEED": "0"},
        mnemonic = "CompleteReleaseNotices",
        use_default_shell_env = False,
    )
    contract = ctx.actions.declare_file(ctx.label.name + ".unsigned-contract.json")
    ctx.actions.write(contract, json.encode({"label": "//%s:%s" % (ctx.label.package, ctx.label.name), "group": "default", "outputs": [{"path": text.path, "destination": text.basename}]}))
    return [DefaultInfo(files = depset([text])), OutputGroupInfo(attribution = depset([inventory]), notices = depset([text]), unsigned_contract = depset([contract]), unsigned_artifacts = unsigned_release_projection(shipping + [text]))]

def _attrs():
    attrs = {
    "unsigned_deployment": attr.label(cfg = _TRANSITIONS["linux_x64"]),
    "deployment": attr.label(providers = [DeploymentNoticesInfo], cfg = _TRANSITIONS["linux_x64"]),
    "images": attr.label_list(providers = [SelectedAttributionInfo], cfg = _TRANSITIONS["linux_x64"]),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    "_runner": attr.label(default = "//tools/bazel/packaging:release-notices.py", allow_single_file = True),
    "_modules": attr.label_list(default = ["//tools/bazel/packaging:native-release.py", "//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:deployment-notices.py", "//tools/bazel/packaging:license-closure.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
    "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    }
    for platform, edge in _TRANSITIONS.items():
        attrs[platform + "_daemon"] = attr.label(cfg = edge)
        if platform.startswith("linux_"):
            attrs[platform + "_utilities"] = attr.label_list(cfg = edge)
    return attrs

complete_release_notices = rule(implementation = _release_notices_impl, attrs = _attrs())

def declare_complete_release_notices(deployment, edge_image, stun_image, native_suppliers, name = "release_notices"):
    """Join only registered original suppliers; absent native roles refuse analysis."""
    expected = [native_release_layout(kind, platform).name
                for platform in NATIVE_RELEASE_PLATFORMS
                for kind in (["daemon", "verify"] if platform.startswith("linux-") else ["daemon"])]
    if type(native_suppliers) != "dict" or (native_suppliers and sorted(native_suppliers) != sorted(expected)):
        fail("Complete release requires exactly six original native supplier roles")
    for role, value in native_suppliers.items():
        if Label(value) != Label("//tools/bazel/packaging:" + role):
            fail("Complete release requires the original registered native supplier: " + role)
    kwargs = {}
    for platform in NATIVE_RELEASE_PLATFORMS:
        field = platform.replace("-", "_")
        daemon = native_suppliers.get("merkur-daemon-" + platform)
        if daemon:
            kwargs[field + "_daemon"] = daemon
        if platform.startswith("linux-"):
            kwargs[field + "_utilities"] = [native_suppliers[role] for role in ["verify-" + platform] if role in native_suppliers]
    complete_release_notices(
        name = name,
        deployment = deployment,
        unsigned_deployment = "//tools/bazel/packaging:deployment_unsigned",
        images = [edge_image, stun_image],
        tags = ["manual", "unqualified-release-inventory"],
        **kwargs
    )
