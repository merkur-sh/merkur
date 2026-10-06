"""Build upstream Ninja using the configured Cc toolchain and declared native SDKs."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")

def _flags(flags, output):
    result = []
    skip = False
    for flag in flags:
        if skip:
            skip = False
        elif flag == "-o":
            skip = True
        elif flag not in [output, "__MERKUR_SOURCE__", "-c"]:
            result.append(flag)
    return result

def _declared_ninja_sdk_impl(ctx):
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__MERKUR_SOURCE__", output_file = "__MERKUR_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__MERKUR_EXECUTABLE__", is_using_linker = True)
    tools = {name: cc_common.get_tool_for_action(feature_configuration = features, action_name = action) for name, action in {"cxx": ACTION_NAMES.cpp_compile, "ar": ACTION_NAMES.cpp_link_static_library}.items()}
    toolchain_files = cc.all_files.to_list()
    if any([path not in [file.path for file in toolchain_files] for path in tools.values()]):
        fail("Ninja build tools require the declared CcToolchain File closure")
    sdk = ctx.attr.shell[NativeSdkInfo]
    shell = sdk.binary
    if shell.basename != "bash" or "/bin/" not in shell.path:
        fail("Ninja requires the original declared Bash SDK File")
    environment = {}
    for action, action_variables in [(ACTION_NAMES.cpp_compile, variables), (ACTION_NAMES.cpp_link_executable, link_variables)]:
        environment.update(cc_common.get_environment_variables(feature_configuration = features, action_name = action, variables = action_variables))
    source_root = ctx.attr.source.label.workspace_root
    source_files = ctx.attr.source[DefaultInfo].files.to_list()
    runtime = ctx.actions.declare_directory(ctx.label.name + ".sdk")
    binary = ctx.actions.declare_file(ctx.label.name + ".tools/ninja")
    specification = ctx.actions.declare_file(ctx.label.name + ".build.json")
    inputs = depset([ctx.file.builder, ctx.file.helper, ctx.file.pins, shell] + source_files, transitive = [cc.all_files, ctx.attr.shell[DefaultInfo].default_runfiles.files, ctx.attr.python[DefaultInfo].default_runfiles.files])
    ctx.actions.write(specification, json.encode({
        "source": [{"path": file.path, "relative": file.path.removeprefix(source_root + "/")} for file in source_files],
        "sdk": shell.path.rsplit("/bin/", 1)[0],
        "shell": shell.path,
        "python": ctx.executable.python.path,
        "cxx": tools["cxx"],
        "ar": tools["ar"],
        "compile_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile, variables = variables), "__MERKUR_OBJECT__"),
        "link_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables), "__MERKUR_EXECUTABLE__"),
        "environment": environment,
        "inputs": [file.path for file in inputs.to_list()] + [ctx.executable.python.path],
        "pins": ctx.file.pins.path,
        "helper": ctx.file.helper.path,
        "runtime": runtime.path,
        "binary": binary.path,
    }))
    ctx.actions.run(
        executable = ctx.executable.python,
        arguments = ["-B", "-I", ctx.file.builder.path, specification.path],
        inputs = depset([specification], transitive = [inputs]),
        tools = [ctx.attr.python[DefaultInfo].files_to_run],
        outputs = [runtime, binary],
        mnemonic = "DeclaredNinjaSdk",
        progress_message = "Bootstrapping original Ninja with declared Cc, Python and Bash",
        use_default_shell_env = False,
    )
    files = depset([runtime, binary], transitive = [ctx.attr.shell[DefaultInfo].default_runfiles.files, ctx.attr.python[DefaultInfo].default_runfiles.files])
    runfiles = ctx.runfiles(transitive_files = files).merge(ctx.attr.shell[DefaultInfo].default_runfiles).merge(ctx.attr.python[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = binary, files = files, runfiles = runfiles), NativeSdkInfo(prefix_runfile = "_main/" + runtime.short_path, binary = binary)]

declared_ninja_sdk = rule(
    implementation = _declared_ninja_sdk_impl,
    executable = True,
    attrs = {
        "source": attr.label(mandatory = True),
        "shell": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "builder": attr.label(default = "//tools/bazel/tools/ninja_sdk:build.py", allow_single_file = True),
        "helper": attr.label(default = "//tools/bazel/tools/native:cmake_source_build.py", allow_single_file = True),
        "pins": attr.label(default = "//tools/bazel/tools/ninja_sdk:pins.json", allow_single_file = True),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)
