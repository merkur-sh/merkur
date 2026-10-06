"""Build the original CMake source through declared compiler, SDK and process tools."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load("//tools/bazel/tools/native:sdk.bzl", "configured_ranlib")

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

def _declared_cmake_sdk_impl(ctx):
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__MERKUR_SOURCE__", output_file = "__MERKUR_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__MERKUR_EXECUTABLE__", is_using_linker = True)
    actions = {"cc": ACTION_NAMES.c_compile, "cxx": ACTION_NAMES.cpp_compile, "ar": ACTION_NAMES.cpp_link_static_library}
    tools = {name: cc_common.get_tool_for_action(feature_configuration = features, action_name = action) for name, action in actions.items()}
    ranlib = configured_ranlib(cc, ctx.attr._cc_toolchain).path
    environment = {}
    for action in [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile, ACTION_NAMES.cpp_link_executable]:
        action_variables = link_variables if action == ACTION_NAMES.cpp_link_executable else variables
        environment.update(cc_common.get_environment_variables(feature_configuration = features, action_name = action, variables = action_variables))
    sdk = ctx.attr.sdk[NativeSdkInfo]
    make = ctx.attr.make[NativeSdkInfo]
    source_root = ctx.attr.source.label.workspace_root
    source_files = ctx.attr.source[DefaultInfo].files.to_list()
    runtime = ctx.actions.declare_directory(ctx.label.name + ".sdk")
    binary = ctx.actions.declare_file(ctx.label.name + ".tools/cmake")
    specification = ctx.actions.declare_file(ctx.label.name + ".request.json")
    configuration = ctx.actions.declare_file(ctx.label.name + ".build.json")
    commands = ctx.actions.declare_file(ctx.label.name + ".compile_commands.json")
    captured = {name: ctx.actions.declare_directory(ctx.label.name + "." + name) for name in [
        "dependencies", "link_maps", "compiler_objects", "compiler_archives", "original_notices",
    ]}
    helper_files = [ctx.file.source_join, ctx.file.linked_sources, ctx.file.runtime_sections,
                   ctx.file.native_mapper, ctx.file.original_licenses]
    original_files = [ctx.file.source_archive, ctx.file.pins, ctx.file.workspace_license] + ctx.files.source_patches
    target = ctx.attr.target
    ctx.actions.write(specification, json.encode({
        "producer": str(ctx.label),
        "source_archive": ctx.file.source_archive.path,
        "pins": ctx.file.pins.path,
        "source_patches": [file.path for file in ctx.files.source_patches],
        "workspace_license": ctx.file.workspace_license.path,
        "source_join": ctx.file.source_join.path,
        "linked_sources": ctx.file.linked_sources.path,
        "runtime_sections": ctx.file.runtime_sections.path,
        "native_mapper": ctx.file.native_mapper.path,
        "original_licenses": ctx.file.original_licenses.path,
        "target": target,
        "sysroot": cc.sysroot or "",
        "compiler_configuration": configuration.path,
        "compiler_commands": commands.path,
        "dependencies": captured["dependencies"].path,
        "link_maps": captured["link_maps"].path,
        "compiler_objects": captured["compiler_objects"].path,
        "compiler_archives": captured["compiler_archives"].path,
        "original_notices": captured["original_notices"].path,
        "source": [{"path": file.path, "relative": file.path.removeprefix(source_root + "/")} for file in source_files],
        "sdk": sdk.binary.path.rsplit("/bin/", 1)[0],
        "shell": sdk.binary.path,
        "make": make.binary.path,
        "make_sdk": make.binary.path.rsplit("/bin/", 1)[0],
        "make_driver": ctx.executable.make_driver.path,
        "git": ctx.executable.git.path,
        "cc": tools["cc"],
        "cxx": tools["cxx"],
        "ar": tools["ar"],
        "ranlib": ranlib,
        "compile_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables), "__MERKUR_OBJECT__"),
        "cxx_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile, variables = variables), "__MERKUR_OBJECT__"),
        "link_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables), "__MERKUR_EXECUTABLE__"),
        "environment": environment,
        "runtime": runtime.path,
        "binary": binary.path,
    }))
    ctx.actions.run(
        executable = ctx.executable.python,
        arguments = ["-B", "-I", ctx.file.builder.path, specification.path],
        inputs = depset([ctx.file.builder, specification] + source_files + helper_files + original_files, transitive = [cc.all_files, ctx.attr.sdk[DefaultInfo].default_runfiles.files, ctx.attr.make[DefaultInfo].default_runfiles.files]),
        tools = [ctx.attr.python[DefaultInfo].files_to_run, ctx.attr.make_driver[DefaultInfo].files_to_run, ctx.attr.git[DefaultInfo].files_to_run],
        outputs = [runtime, binary, configuration, commands] + captured.values(),
        mnemonic = "DeclaredCMakeSdk",
        progress_message = "Building original CMake with the declared compiler, Make and shell",
        use_default_shell_env = False,
    )
    files = [runtime, binary]
    return [
        DefaultInfo(executable = binary, files = depset(files), runfiles = ctx.runfiles(files = files)),
        NativeSdkInfo(prefix_runfile = "_main/" + runtime.short_path, binary = binary),
        OutputGroupInfo(
            compiler_configuration = depset([configuration]),
            compiler_commands = depset([commands]),
            compiler_dependencies = depset([captured["dependencies"]]),
            native_link_maps = depset([captured["link_maps"]]),
            compiler_objects = depset([captured["compiler_objects"]]),
            compiler_archives = depset([captured["compiler_archives"]]),
            original_sources = depset(source_files + original_files),
            original_notices = depset([captured["original_notices"]]),
        ),
    ]

declared_cmake_sdk = rule(
    implementation = _declared_cmake_sdk_impl,
    executable = True,
    attrs = {
        "source": attr.label(mandatory = True),
        "target": attr.string(mandatory = True, values = [
            "aarch64-apple-darwin", "x86_64-apple-darwin",
            "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu",
        ]),
        "source_archive": attr.label(default = "@cmake_source_archive//file", allow_single_file = True),
        "pins": attr.label(default = "//tools/bazel/tools/native:cmake-pins.json", allow_single_file = True),
        "source_patches": attr.label_list(default = [
            "//tools/bazel/tools/native:cmake-darwin-native-memory.patch",
            "//tools/bazel/tools/native:cmake-darwin-native-runtime.patch",
        ], allow_files = True),
        "workspace_license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "source_join": attr.label(default = "//tools/bazel/tools/native:cmake-selected-source.py", allow_single_file = True),
        "linked_sources": attr.label(default = "//tools/bazel/bun:bun-runtime-linked-sources.py", allow_single_file = True),
        "runtime_sections": attr.label(default = "//tools/bazel/bun:runtime-sections.py", allow_single_file = True),
        "native_mapper": attr.label(default = "//tools/bazel/rust:stdlib_attribution.py", allow_single_file = True),
        "original_licenses": attr.label(default = "//tools/bazel/packaging:license-inputs.py", allow_single_file = True),
        "sdk": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "make": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "make_driver": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "_cc_toolchain": attr.label(default = "@rules_cc//cc:current_cc_toolchain", providers = [cc_common.CcToolchainInfo, platform_common.TemplateVariableInfo]),
        "git": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "builder": attr.label(default = "//tools/bazel/tools/native:cmake_source_build.py", allow_single_file = True),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)
