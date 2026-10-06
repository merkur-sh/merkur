"""Original compiler archive members as Files and unresolved symlink artifacts.

Generated Files retain arbitrary original SDK filenames. Symlink artifacts retain
recursive framework topology without traversing it as a TreeArtifact.
"""
load(":providers.bzl", _DarwinCompilerSdkInfo = "DarwinCompilerSdkInfo")

DarwinCompilerSdkInfo = _DarwinCompilerSdkInfo

def _impl(ctx):
    specification = json.decode(ctx.attr.specification)
    inventory = json.decode(ctx.attr.members)
    members = {}
    for member in inventory:
        logical = member["path"]
        if member["kind"] not in ["file", "symlink"] or not logical or logical.startswith("/") or ".." in logical.split("/") or "\\" in logical:
            fail("Unsupported original SDK artifact member")
        if logical in members:
            fail("Duplicate original SDK artifact member")
        path = ctx.label.name + "/payload/" + logical
        members[logical] = ctx.actions.declare_symlink(path) if member["kind"] == "symlink" else ctx.actions.declare_file(path)
    if not members:
        fail("Original SDK artifact inventory is empty")
    first = inventory[0]["path"]
    root = members[first].path[:-(len(first) + 1)]
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    manifest = ctx.actions.declare_file(ctx.label.name + ".members.json")
    ctx.actions.write(request, ctx.attr.specification)
    ctx.actions.write(manifest, ctx.attr.members)
    outputs = members.values()
    ctx.actions.run(
        executable = ctx.executable.python,
        arguments = ["-I", "-B", ctx.file._runner.path, request.path, manifest.path, ctx.file.archive.path, root, ctx.file._compiler.path, ctx.file._loader.path],
        inputs = [request, manifest, ctx.file.archive, ctx.file._runner, ctx.file._compiler, ctx.file._loader],
        tools = [ctx.attr.python[DefaultInfo].files_to_run],
        outputs = outputs,
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurDarwinCompilerSdk",
    )
    files = depset(outputs + [ctx.file.archive])
    return [DefaultInfo(files = files), DarwinCompilerSdkInfo(root = root, files = files, members = members, sysroot = specification["sysroot"], resource_dir = specification["resource_dir"], cxx_headers = specification["cxx_headers"], execution_cpu = specification["execution_cpu"], tools = specification["tools"])]

darwin_compiler_sdk = rule(
    implementation = _impl,
    attrs = {
        "archive": attr.label(allow_single_file = True, mandatory = True),
        "specification": attr.string(mandatory = True),
        "members": attr.string(mandatory = True),
        "python": attr.label(executable = True, cfg = "exec", mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/tools/native:darwin-artifacts.py", allow_single_file = True),
        "_compiler": attr.label(default = "//tools/bazel/tools/native:darwin-compiler.py", allow_single_file = True),
        "_loader": attr.label(default = "//tools/bazel/tools/native:extract-sdk.py", allow_single_file = True),
    },
)

def _member_impl(ctx):
    sdk = ctx.attr.sdk[DarwinCompilerSdkInfo]
    if ctx.attr.member not in sdk.members:
        fail("Original SDK member selector is absent from its declared archive")
    return [DefaultInfo(files = depset([sdk.members[ctx.attr.member]]))]

darwin_compiler_member = rule(implementation = _member_impl, attrs = {"sdk": attr.label(providers = [DarwinCompilerSdkInfo], mandatory = True), "member": attr.string(mandatory = True)})
