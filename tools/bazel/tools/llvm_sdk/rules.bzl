"""Build Bun's original LLVM tool family with genuine native compiler inputs."""
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")

LlvmSdkInfo = provider(fields = ["root", "tools", "manifest", "inputs", "source_archive"])

_TOOLS = ["clang", "clang++", "llvm-ar", "llvm-ranlib", "llvm-nm", "llvm-strip", "dsymutil", "ld.lld", "ld64.lld", "llvm-profdata"]

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

def _llvm_sdk_impl(ctx):
    constraints = {
        "darwin_arm64": [ctx.attr._macos, ctx.attr._arm64],
        "darwin_x64": [ctx.attr._macos, ctx.attr._x64],
        "linux_arm64": [ctx.attr._linux, ctx.attr._arm64],
        "linux_x64": [ctx.attr._linux, ctx.attr._x64],
    }
    for target in constraints[ctx.attr.platform]:
        if not ctx.target_platform_has_constraint(target[platform_common.ConstraintValueInfo]):
            fail("LLVM SDK must be configured for its exact native target platform")
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__MERKUR_SOURCE__", output_file = "__MERKUR_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__MERKUR_EXECUTABLE__", is_using_linker = True)
    actions = {"cc": ACTION_NAMES.c_compile, "cxx": ACTION_NAMES.cpp_compile, "ar": ACTION_NAMES.cpp_link_static_library}
    native_tools = {name: cc_common.get_tool_for_action(feature_configuration = features, action_name = action) for name, action in actions.items()}
    if ctx.file.ranlib.path not in [file.path for file in cc.all_files.to_list()]:
        fail("LLVM source build requires declared RANLIB in the native CcToolchain")
    sdk = ctx.attr.sdk[NativeSdkInfo]
    make = ctx.attr.make[NativeSdkInfo]
    runtime = ctx.actions.declare_directory(ctx.label.name + ".sdk")
    tools = {name: ctx.actions.declare_file(ctx.label.name + ".tools/" + name) for name in _TOOLS}
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    environment = {}
    for action in [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile, ACTION_NAMES.cpp_link_executable]:
        action_variables = link_variables if action == ACTION_NAMES.cpp_link_executable else variables
        environment.update(cc_common.get_environment_variables(feature_configuration = features, action_name = action, variables = action_variables))
    targets = [ctx.attr.sdk, ctx.attr.make, ctx.attr.cmake, ctx.attr.make_driver, ctx.attr.git, ctx.attr.python, ctx.attr.uname]
    closure = depset([ctx.file.source_archive, ctx.file.builder, ctx.file.helper], transitive = [cc.all_files] + [target[DefaultInfo].files for target in targets] + [target[DefaultInfo].default_runfiles.files for target in targets])
    ctx.actions.write(request, json.encode({
        "version": "21.1.8", "projects": ["clang", "lld"], "platform": ctx.attr.platform,
        "archive": ctx.file.source_archive.path, "runtime": runtime.path, "manifest": manifest.path,
        "tools": {name: file.path for name, file in tools.items()},
        "sdk": sdk.binary.path.rsplit("/bin/", 1)[0], "make_sdk": make.binary.path.rsplit("/bin/", 1)[0],
        "shell": sdk.binary.path, "make": make.binary.path, "make_driver": ctx.executable.make_driver.path,
        "cmake": ctx.executable.cmake.path, "git": ctx.executable.git.path, "python": ctx.executable.python.path,
        "uname": ctx.executable.uname.path, "helper": ctx.file.helper.path,
        "cc": native_tools["cc"], "cxx": native_tools["cxx"], "ar": native_tools["ar"], "ranlib": ctx.file.ranlib.path,
        "compile_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables), "__MERKUR_OBJECT__"),
        "cxx_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile, variables = variables), "__MERKUR_OBJECT__"),
        "link_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables), "__MERKUR_EXECUTABLE__"),
        "environment": environment,
        "inputs": [{"path": file.path, "kind": "tree" if file.is_directory else "symlink" if file.is_symlink else "file"} for file in closure.to_list()],
    }))
    ctx.actions.run(
        executable = ctx.executable.python,
        arguments = ["-B", "-I", ctx.file.builder.path, request.path],
        inputs = depset([request], transitive = [closure]),
        tools = [target[DefaultInfo].files_to_run for target in [ctx.attr.python, ctx.attr.cmake, ctx.attr.make_driver, ctx.attr.git, ctx.attr.uname]],
        outputs = [runtime, manifest] + tools.values(),
        mnemonic = "DeclaredLlvmSdk",
        progress_message = "Building original LLVM21.1.8 clang and lld for Bun",
        env = {},
        use_default_shell_env = False,
    )
    outputs = depset([runtime, manifest] + tools.values())
    return [DefaultInfo(files = outputs, runfiles = ctx.runfiles(transitive_files = outputs)),
            LlvmSdkInfo(root = runtime, tools = tools, manifest = manifest, inputs = closure, source_archive = ctx.file.source_archive)]

llvm_sdk = rule(
    implementation = _llvm_sdk_impl,
    attrs = {
        "source_archive": attr.label(mandatory = True, allow_single_file = True),
        "platform": attr.string(mandatory = True, values = ["darwin_arm64", "darwin_x64", "linux_arm64", "linux_x64"]),
        "sdk": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "make": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "make_driver": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "cmake": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "ranlib": attr.label(mandatory = True, allow_single_file = True),
        "git": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "uname": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "python": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "builder": attr.label(default = "//tools/bazel/tools/llvm_sdk:build.py", allow_single_file = True),
        "helper": attr.label(default = "//tools/bazel/tools/native:cmake_source_build.py", allow_single_file = True),
        "_macos": attr.label(default = "@platforms//os:macos"),
        "_linux": attr.label(default = "@platforms//os:linux"),
        "_arm64": attr.label(default = "@platforms//cpu:aarch64"),
        "_x64": attr.label(default = "@platforms//cpu:x86_64"),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)
