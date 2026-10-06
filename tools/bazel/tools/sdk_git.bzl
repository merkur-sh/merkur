"""Build Git's native verification/HTTPS binaries with the declared shell."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load("//tools/bazel/tools/native:sdk.bzl", "configured_ranlib")

GitSdkInfo = provider(fields = {"binaries": "Exact emitted native executable Files by supported basename.", "runtime": "Complete generated native SDK TreeArtifact.", "prefix_runfile": "Exact common SDK runtime prefix."})
_TOOLS = ["sh", "bash", "mkdir", "chmod", "echo", "git", "tar", "gzip", "openssl", "redis-server", "make", "sed", "grep", "gawk", "find", "diff"]

def _without_output_flags(flags, marker):
    result = []
    skip = False
    for flag in flags:
        if skip:
            skip = False
        elif flag == "-o":
            skip = True
        elif flag not in [marker, "__MERKUR_SOURCE__", "-c"]:
            result.append(flag)
    return result

def _git_sdk_impl(ctx):
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    compile_variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__MERKUR_SOURCE__", output_file = "__MERKUR_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__MERKUR_EXECUTABLE__", is_using_linker = True)
    compile_flags = cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = compile_variables)
    link_flags = cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables)
    environment = dict(cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = compile_variables))
    for key, value in cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables).items():
        environment[key] = value
    sdk = ctx.attr.sdk[NativeSdkInfo]
    make = ctx.attr.make[NativeSdkInfo]
    ranlib = configured_ranlib(cc, ctx.attr._cc_toolchain).path
    binaries = {name: ctx.actions.declare_file(ctx.label.name + ".tools/" + name) for name in _TOOLS}
    binary = binaries["git"]
    runtime = ctx.actions.declare_directory(ctx.label.name + ".sdk")
    specification = ctx.actions.declare_file(ctx.label.name + ".build.json")
    source_root = ctx.attr.source.label.workspace_root
    source_files = ctx.attr.source[DefaultInfo].files.to_list()
    ctx.actions.write(specification, json.encode({
        "source": [{"path": file.path, "relative": file.path.removeprefix(source_root + "/")} for file in source_files],
        "sdk": sdk.binary.path.rsplit("/bin/", 1)[0],
        "make": make.binary.path,
        "make_sdk": make.binary.path.rsplit("/bin/", 1)[0],
        "cc": cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.c_compile),
        "ar": cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_static_library),
        "ranlib": ranlib,
        "compile_flags": _without_output_flags(compile_flags, "__MERKUR_OBJECT__"),
        "link_flags": _without_output_flags(link_flags, "__MERKUR_EXECUTABLE__"),
        "environment": environment,
        "runtime": runtime.path,
        "binary": binary.path,
        "binaries": {name: file.path for name, file in binaries.items()},
    }))
    ctx.actions.run(
        executable = ctx.executable.python,
        arguments = ["-B", "-I", ctx.file.builder.path, specification.path],
        inputs = depset([ctx.file.builder, specification] + source_files, transitive = [cc.all_files, ctx.attr.sdk[DefaultInfo].default_runfiles.files, ctx.attr.make[DefaultInfo].default_runfiles.files]),
        tools = [ctx.attr.python[DefaultInfo].files_to_run],
        outputs = binaries.values() + [runtime],
        mnemonic = "DeclaredGitSdk",
        progress_message = "Building Git with the declared native compiler, Make and shell",
        use_default_shell_env = False,
    )
    prefix = "_main/" + runtime.short_path
    files = binaries.values() + [runtime]
    return [DefaultInfo(executable = binary, files = depset(files), runfiles = ctx.runfiles(files = files)), NativeSdkInfo(prefix_runfile = prefix, binary = binary), GitSdkInfo(binaries = binaries, runtime = runtime, prefix_runfile = prefix), OutputGroupInfo(git = depset([binary]), runtime = depset([runtime]))]

declared_git_sdk = rule(
    implementation = _git_sdk_impl,
    executable = True,
    attrs = {
        "source": attr.label(mandatory = True),
        "sdk": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "make": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "_cc_toolchain": attr.label(default = "@rules_cc//cc:current_cc_toolchain", providers = [cc_common.CcToolchainInfo, platform_common.TemplateVariableInfo]),
        "python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "builder": attr.label(default = "//tools/bazel/tools/native:sdk_git_build.py", allow_single_file = True),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)

def _git_sdk_tool_impl(ctx):
    sdk = ctx.attr.sdk[GitSdkInfo]
    binary = sdk.binaries[ctx.attr.tool]

    # A controller admits a tool only as its SDK's own bin member, so the carrier
    # aliases into the generated SDK tree instead of the copied basename.
    executable = ctx.actions.declare_symlink(ctx.label.name + ".bin")
    ctx.actions.symlink(output = executable, target_path = "../" * executable.short_path.count("/") + sdk.runtime.short_path + "/bin/" + ctx.attr.tool)
    return [DefaultInfo(executable = executable, files = depset([executable, binary, sdk.runtime]), runfiles = ctx.attr.sdk[DefaultInfo].default_runfiles.merge(ctx.runfiles(files = [executable]))), NativeSdkInfo(prefix_runfile = sdk.prefix_runfile, binary = binary)]

git_sdk_tool = rule(
    implementation = _git_sdk_tool_impl,
    executable = True,
    attrs = {"sdk": attr.label(mandatory = True, providers = [GitSdkInfo]), "tool": attr.string(mandatory = True, values = _TOOLS)},
)
