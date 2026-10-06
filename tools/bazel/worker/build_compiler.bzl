"""Build the original pinned, patched compiler with declared native inputs."""

load(":bootstrap_inputs.bzl", "CompilerBootstrapInputsInfo")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")

def _build_compiler_impl(ctx):
    bootstrap = ctx.attr.bootstrap[CompilerBootstrapInputsInfo]
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    compile_variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc)
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc)
    files = {file.path: True for file in cc.all_files.to_list()}
    native = {}
    for name, action, variables in [
        ("cc", ACTION_NAMES.c_compile, compile_variables),
        ("cxx", ACTION_NAMES.cpp_compile, compile_variables),
        ("linker", ACTION_NAMES.cpp_link_executable, link_variables),
        ("ar", ACTION_NAMES.cpp_link_static_library, link_variables),
    ]:
        tool = cc_common.get_tool_for_action(feature_configuration = features, action_name = action)
        if tool not in files:
            fail("Compiler bootstrap requires every native tool in CcToolchainInfo.all_files: " + tool)
        native[name] = {
            "tool": tool,
            "flags": cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = action, variables = variables) if name != "ar" else [],
            "environment": cc_common.get_environment_variables(feature_configuration = features, action_name = action, variables = variables),
        }
    # CcToolchainInfo has no ranlib action. Require the original explicit File,
    # and prove it belongs to the same native toolchain closure.
    if ctx.file.ranlib.path not in files:
        fail("Compiler bootstrap ranlib must belong to CcToolchainInfo.all_files")
    native["ranlib"] = {"tool": ctx.file.ranlib.path, "flags": [], "environment": {}}
    tools = {}
    transitive = [bootstrap.input_files, ctx.attr.bootstrap[DefaultInfo].files, cc.all_files, ctx.attr._python[DefaultInfo].default_runfiles.files]
    for target, name in ctx.attr.tools.items():
        tool = target[NativeSdkInfo].binary if NativeSdkInfo in target else target[DefaultInfo].files_to_run.executable
        if name in tools or not tool:
            fail("Compiler bootstrap requires unique executable utility names")
        tools[name] = tool.path
        transitive.extend([target[DefaultInfo].files, target[DefaultInfo].default_runfiles.files])
    for required in ["sh", "make", "git", "cmake"]:
        if required not in tools:
            fail("Compiler bootstrap requires declared " + required)
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    ctx.actions.write(request, json.encode({
        "configuration": bootstrap.configuration.path,
        "sources": bootstrap.sources.path + "/source",
        "native": native,
        "sysroot": cc.sysroot,
        "native_files": files.keys(),
        "tools": tools,
        "python": ctx.executable._python.path,
    }))
    output = ctx.actions.declare_directory(ctx.label.name + ".compiler")
    log = ctx.actions.declare_file(ctx.label.name + ".build.log")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-B", "-I", ctx.file._runner.path, "--request", request.path, "--output", output.path, "--log", log.path],
        inputs = depset([request, ctx.file._runner], transitive = transitive),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output, log],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurPatchedCompilerBootstrap",
        progress_message = "Building original patched stage1 compiler and rustdoc",
    )
    runtime = ctx.actions.declare_directory(ctx.label.name + ".runtime")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-B", "-I", ctx.file._split.path, "--stage1", output.path, "--runtime", runtime.path],
        inputs = depset([output, ctx.file._split], transitive = [ctx.attr._python[DefaultInfo].default_runfiles.files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [runtime],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurCompilerRuntimeSdk",
    )
    return [
        DefaultInfo(files = depset([runtime, log])),
        OutputGroupInfo(runtime = depset([runtime]), sources = depset([bootstrap.sources]), original_stage1 = depset([output])),
    ]

build_patched_compiler = rule(
    implementation = _build_compiler_impl,
    attrs = {
        "bootstrap": attr.label(providers = [CompilerBootstrapInputsInfo], mandatory = True),
        "ranlib": attr.label(allow_single_file = True, mandatory = True),
        "tools": attr.label_keyed_string_dict(cfg = "exec", mandatory = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/worker:build-compiler.py", allow_single_file = True),
        "_split": attr.label(default = "//tools/bazel/worker:split-compiler-sdk.py", allow_single_file = True),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)
