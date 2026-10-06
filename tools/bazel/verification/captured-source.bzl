"""The original captured source: one complete TreeArtifact, and the payload it is built from."""

def _members(ctx):
    members = {}
    for target, logical in ctx.attr.inputs.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or not files[0].is_source:
            fail("Captured source requires one original payload SourceFile per logical path")
        if files[0].owner != target.label or target.label.workspace_root != ctx.label.workspace_root or target.label.package != "" or not target.label.name.startswith("payload/"):
            fail("Captured source requires its exact context-owned original payload File")
        if logical in members:
            fail("Captured source contains duplicate logical source paths")
        members[logical] = struct(file = files[0], name = target.label.name)
    return members

def _impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    members = _members(ctx)
    files = [member.file for member in members.values()]
    mapping = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(mapping, json.encode({logical: member.file.path for logical, member in members.items()}))
    output = ctx.actions.declare_directory(ctx.label.name)
    ctx.actions.run(
        executable = runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path,
                     ctx.file._runner.path, ctx.file.manifest.path, mapping.path, output.path],
        inputs = depset(files + [ctx.file.manifest, mapping, ctx.file._runner, ctx.file._config] + ctx.files._helpers),
        outputs = [output],
        mnemonic = "CapturedOriginalSource",
    )
    return [DefaultInfo(files = depset([output]))]

captured_source_tree = rule(
    implementation = _impl,
    attrs = {
        "manifest": attr.label(mandatory = True, allow_single_file = True),
        "inputs": attr.label_keyed_string_dict(mandatory = True, allow_files = True),
        "_runner": attr.label(default = "//tools/bazel/verification:captured-source.ts", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
        "_helpers": attr.label_list(default = [
            "//tools/bazel/verification:source-tree.ts", "//tools/bazel/verification:snapshot.ts",
            "//tools/bazel/verification:artifacts.ts", "//tools/bazel/bun:owned-files.ts",
        ], allow_files = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def _payload_impl(ctx):
    members = _members(ctx)
    mapping = ctx.actions.declare_file(ctx.label.name + ".json")

    # A consumer finds the payload in its runfiles: this repository's directory there, and each
    # original File's place in it.
    ctx.actions.write(mapping, json.encode({
        "directory": ctx.label.workspace_name or "_main",
        "files": {logical: member.name for logical, member in members.items()},
    }))
    files = [member.file for member in members.values()] + [mapping]
    return [DefaultInfo(files = depset([mapping]), runfiles = ctx.runfiles(files = files))]

captured_source_payload = rule(
    implementation = _payload_impl,
    attrs = {"inputs": attr.label_keyed_string_dict(mandatory = True, allow_files = True)},
)
