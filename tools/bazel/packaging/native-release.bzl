"""Native unsigned release actions; unavailable selected attribution refuses analysis."""

load(":notices.bzl", "SelectedAttributionInfo")

NATIVE_RELEASE_PLATFORMS = {
    "darwin-arm64": ["@platforms//os:macos", "@platforms//cpu:aarch64"],
    "darwin-x64": ["@platforms//os:macos", "@platforms//cpu:x86_64"],
    "linux-arm64": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
    "linux-x64": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
}

NATIVE_RELEASE_TARGETS = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
}

_DAEMON_FILES = {
    "//apps/daemon:daemon": "merkur",
    "//packages/merkur-image-worker:bin_merkur_image_worker": "merkur-image-worker",
    "//apps/tui:bin_merkur_tui": "merkur-tui",
}

def native_release_layout(kind, platform):
    """Exact artifact/member contract shared by declarations and analysis controls."""
    if platform not in NATIVE_RELEASE_PLATFORMS:
        fail("Native release requires one of the four declared platforms")
    if kind == "daemon":
        files = dict(_DAEMON_FILES)
        files["//tools/bazel/rust/release_pgo/" + NATIVE_RELEASE_TARGETS[platform] + ":dataplane_release"] = "merkur-dataplane"
        return struct(name = "merkur-daemon-" + platform, artifact = "merkur-daemon-" + platform + ".tar.gz", files = files)
    if kind != "verify" or not platform.startswith("linux-"):
        fail("Raw verification artifacts require a declared native Linux platform")
    return struct(name = kind + "-" + platform, artifact = kind + "-" + platform, files = {"//scripts:release_verifier": kind})

def _release_transition_impl(_settings, _attr):
    return {"//command_line_option:compilation_mode": "opt"}

_release_transition = transition(
    implementation = _release_transition_impl,
    inputs = [],
    outputs = ["//command_line_option:compilation_mode"],
)

def _native_release_impl(ctx):
    layout = native_release_layout(ctx.attr.kind, ctx.attr.platform)
    if ctx.label.name != layout.name:
        fail("Native release target name must match its original consumer artifact: " + layout.name)
    files = []
    members = {}
    for target, member in ctx.attr.files.items():
        expected = layout.files.get("//%s:%s" % (target.label.package, target.label.name))
        outputs = target[DefaultInfo].files.to_list()
        if expected != member or member in members or len(outputs) != 1 or outputs[0].is_directory:
            fail("Native release member must be its exact original declared executable: " + member)
        members[member] = outputs[0]
        files.append(outputs[0])
    if sorted(members) != sorted(layout.files.values()):
        fail("Native release member inventory differs from the original consumer")
    required = {}
    for member in members:
        required[member] = ["first-party", "npm", "wasm", "embedded-runtime"] if member in ["merkur", "verify"] else ["rust"]
    selected = {}
    attributions = []
    for target in ctx.attr.attributions:
        source = target[SelectedAttributionInfo]
        artifacts = source.artifacts.to_list()
        roles = [member for member, file in members.items() if artifacts == [file]]
        if len(roles) != 1:
            fail("Native notice provider lacks exact selected executable custody: " + str(target.label))
        role = roles[0]
        pair = role + "/" + source.scope
        if source.scope not in required[role] or pair in selected or source.producer != str(members[role].owner):
            fail("Native notice provider has foreign, duplicate or unsupported identity: " + pair)
        selected[pair] = True
        attributions.append({
            "role": role,
            "scope": source.scope,
            "producer": source.producer,
            "configuration": {"input": source.configuration.path, "label": str(source.configuration.owner)},
            "source_inventory": {"input": source.source_inventory.path, "label": str(source.source_inventory.owner)},
            "inventory": {"input": source.inventory.path, "label": str(source.inventory.owner)},
            "notices": {"input": source.notices.path, "label": str(source.notices.owner)},
        })
        files += [source.configuration, source.source_inventory, source.inventory, source.notices]
    missing = sorted([member + "/" + scope for member, scopes in required.items() for scope in scopes if member + "/" + scope not in selected])
    if missing:
        fail("Native release attribution lacks original selected providers: " + ", ".join(missing))
    if not ctx.files.licenses:
        fail("Native release requires original external license Files")
    artifact = ctx.actions.declare_file(layout.artifact)
    signing = ctx.actions.declare_file(layout.name + ".signing-inputs.json")
    spec = ctx.actions.declare_file(layout.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "platform": ctx.attr.platform,
        "kind": ctx.attr.kind,
        "files": [{"path": member, "artifact_path": file.basename, "input": file.path, "label": str(file.owner), "mode": "0555"} for member, file in members.items()],
        "expected": sorted(members),
        "licenses": [{"input": file.path, "label": str(file.owner)} for file in ctx.files.licenses],
        "attributions": attributions,
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", "-B", ctx.file._runner.path, spec.path, artifact.path, signing.path],
        inputs = depset([spec, ctx.file._runner] + files + ctx.files.licenses + ctx.files._modules),
        outputs = [artifact, signing],
        env = {"PYTHONHASHSEED": "0"},
        mnemonic = "UnsignedNativeRelease",
        use_default_shell_env = False,
    )
    descriptor = ctx.actions.declare_file(layout.name + ".unsigned-contract.json")
    ctx.actions.write(descriptor, json.encode({
        "label": "//%s:%s" % (ctx.label.package, ctx.label.name),
        "group": "default",
        "outputs": [{"path": file.path, "destination": file.basename} for file in [artifact, signing]],
    }))
    return [
        DefaultInfo(files = depset([artifact, signing])),
        OutputGroupInfo(archive = depset([artifact]), signing_inputs = depset([signing]), unsigned_contract = depset([descriptor])),
    ]

native_unsigned_release = rule(
    implementation = _native_release_impl,
    cfg = _release_transition,
    attrs = {
        "kind": attr.string(mandatory = True, values = ["daemon", "verify"]),
        "platform": attr.string(mandatory = True, values = NATIVE_RELEASE_PLATFORMS.keys()),
        "files": attr.label_keyed_string_dict(mandatory = True),
        "attributions": attr.label_list(providers = [SelectedAttributionInfo], mandatory = True),
        "licenses": attr.label_list(default = ["//:LICENSE"], allow_files = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
        "_runner": attr.label(default = "//tools/bazel/packaging:native-release.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:deployment-notices.py", "//tools/bazel/packaging:license-closure.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    },
)

def declare_native_unsigned_release(attributions):
    """Instantiate six native actions; empty maps retain precise missing-scope failures."""
    for platform, constraints in NATIVE_RELEASE_PLATFORMS.items():
        for kind in (["daemon", "verify"] if platform.startswith("linux-") else ["daemon"]):
            layout = native_release_layout(kind, platform)
            native_unsigned_release(
                name = layout.name,
                kind = kind,
                platform = platform,
                files = layout.files,
                attributions = attributions.get(layout.name, []),
                target_compatible_with = constraints,
                tags = ["manual"],
            )
