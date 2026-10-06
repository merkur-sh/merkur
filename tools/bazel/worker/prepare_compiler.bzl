"""Pinned source preparation using the existing complete native Git SDK."""
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")

PreparedCompilerSourceInfo = provider(fields = ["source_tree", "source_subdirectory", "pins", "archive", "patch", "git", "git_sdk_files"])

def _prepare_impl(ctx):
    git = ctx.attr.git[NativeSdkInfo].binary
    if not git.path.endswith("/bin/git"):
        fail("NativeSdkInfo Git must identify bin/git")
    sdk_root = git.dirname[:-4]
    sdk_files = ctx.attr.git[DefaultInfo].default_runfiles.files
    if git not in sdk_files.to_list():
        fail("Git provider omits its original executable File")
    configuration = ctx.actions.declare_file(ctx.label.name + ".git-sdk.json")
    ctx.actions.write(configuration, json.encode({
        "git": git.path,
        "sdk_root": sdk_root,
        "sdk_files": [file.path for file in sdk_files.to_list()],
    }))
    output = ctx.actions.declare_directory(ctx.label.name + ".prepared")
    python = ctx.attr._python[DefaultInfo].files_to_run
    ctx.actions.run(
        executable = python,
        tools = [python, ctx.attr.git[DefaultInfo].files_to_run],
        inputs = depset([ctx.file.archive, ctx.file.pins, ctx.file.patch, ctx.file._prepare, configuration], transitive = [sdk_files, ctx.attr._python[DefaultInfo].default_runfiles.files]),
        outputs = [output],
        arguments = ["-B", "-I", ctx.file._prepare.path, "--archive", ctx.file.archive.path, "--pins", ctx.file.pins.path, "--patch", ctx.file.patch.path, "--git-sdk", configuration.path, "--destination", output.path + "/source"],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurCompilerSourcePreparation",
    )
    return [DefaultInfo(files = depset([output])), PreparedCompilerSourceInfo(
        source_tree = output,
        source_subdirectory = "source",
        pins = ctx.file.pins,
        archive = ctx.file.archive,
        patch = ctx.file.patch,
        git = git,
        git_sdk_files = sdk_files,
    )]

prepare_compiler_sources = rule(
    implementation = _prepare_impl,
    attrs = {
        "archive": attr.label(allow_single_file = True, mandatory = True),
        "pins": attr.label(allow_single_file = True, mandatory = True),
        "patch": attr.label(allow_single_file = True, mandatory = True),
        "git": attr.label(providers = [NativeSdkInfo], mandatory = True, cfg = "exec"),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_prepare": attr.label(default = ":prepare-compiler.py", allow_single_file = True),
    },
)
