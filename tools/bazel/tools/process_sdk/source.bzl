"""Original process utilities for the unmodified Bazel TestRunner watcher."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")

def _sources(ctx):
    pins = json.decode(ctx.read(ctx.path(Label("//tools/bazel/tools/process_sdk:pins.json"))))
    for platform in ["darwin", "linux"]:
        pin = pins[platform]
        http_file(name = "process_" + platform + "_source", urls = [pin["url"]], sha256 = pin["sha256"], downloaded_file_path = "process.tar.gz" if platform == "darwin" else "process.tar.xz")

process_sources = module_extension(implementation = _sources)

def _flags(values, output):
    result = []
    skip = False
    for value in values:
        if skip:
            skip = False
        elif value == "-o":
            skip = True
        elif value not in ["__MERKUR_SOURCE__", output, "-c"]:
            result.append(value)
    return result

def _prefix(sdk, files):
    # A source-built executable can be an alias below the configuration's bin
    # directory. Its actual declared SDK Tree supplies the runtime adjacency.
    runfile = sdk.prefix_runfile.removeprefix("_main/")
    trees = [file for file in files.to_list() if file.is_directory and file.short_path == runfile]
    if trees:
        if len(trees) != 1:
            fail("Process utility bootstrap requires one original declared SDK Tree")
        return trees[0].path
    if "/bin/" in sdk.binary.path:
        return sdk.binary.path.rsplit("/bin/", 1)[0]
    fail("Process utility bootstrap requires its original declared SDK adjacency")

def _implementation(ctx):
    platform = "darwin" if ctx.target_platform_has_constraint(ctx.attr._darwin[platform_common.ConstraintValueInfo]) else "linux" if ctx.target_platform_has_constraint(ctx.attr._linux[platform_common.ConstraintValueInfo]) else None
    if platform == None:
        fail("Original process utilities require a configured native Darwin or Linux platform")
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    compile_variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__MERKUR_SOURCE__", output_file = "__MERKUR_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__MERKUR_EXECUTABLE__", is_using_linker = True)
    compiler_files = cc.all_files.to_list()
    paths = [file.path for file in compiler_files]
    tools = {"cc": cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.c_compile), "ar": cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_static_library), "ranlib": ctx.file.ranlib.path}
    if any([value not in paths for value in tools.values()]):
        fail("Process utility compiler tools must be original configured CcToolchain Files")
    shell = ctx.attr.shell[NativeSdkInfo]
    make = ctx.attr.make[NativeSdkInfo]
    shell_files = ctx.attr.shell[DefaultInfo].default_runfiles.files
    make_files = ctx.attr.make[DefaultInfo].default_runfiles.files
    environment = {}
    for action in [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_link_executable]:
        environment.update(cc_common.get_environment_variables(feature_configuration = features, action_name = action, variables = compile_variables if action == ACTION_NAMES.c_compile else link_variables))
    runtime = ctx.actions.declare_directory(ctx.label.name + ".sdk")
    binary = ctx.actions.declare_file(ctx.label.name + ".tools/ps")
    request = ctx.actions.declare_file(ctx.label.name + ".build.json")
    specification = {
        "platform": platform, "archive": ctx.file.archive.path, "pins": ctx.file._pins.path,
        "common": ctx.file._common.path, "runtime": runtime.path, "binary": binary.path,
        "compiler_files": paths, "compile_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = compile_variables), "__MERKUR_OBJECT__"),
        "link_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables), "__MERKUR_EXECUTABLE__"),
        "environment": environment, "shell": shell.binary.path, "sdk": _prefix(shell, shell_files),
        "make": make.binary.path, "make_sdk": _prefix(make, make_files),
        "shell_files": [file.path for file in shell_files.to_list()],
        "make_files": [file.path for file in make_files.to_list()],
    }
    specification.update(tools)
    ctx.actions.write(request, json.encode(specification))
    ctx.actions.run(executable = ctx.executable.python, arguments = ["-B", "-I", ctx.file._builder.path, request.path], inputs = depset([ctx.file._builder, ctx.file._common, ctx.file._pins, ctx.file.archive, request], transitive = [cc.all_files, shell_files, make_files]), tools = [ctx.attr.python[DefaultInfo].files_to_run], outputs = [runtime, binary], mnemonic = "DeclaredProcessUtilitySdk", use_default_shell_env = False)
    return [DefaultInfo(executable = binary, files = depset([runtime, binary]), runfiles = ctx.runfiles(files = [runtime, binary])), NativeSdkInfo(prefix_runfile = "_main/" + runtime.short_path, binary = binary)]

declared_process_sdk = rule(
    implementation = _implementation,
    executable = True,
    attrs = {
        "archive": attr.label(mandatory = True, allow_single_file = True),
        "shell": attr.label(mandatory = True, providers = [NativeSdkInfo], cfg = "exec"),
        "make": attr.label(mandatory = True, providers = [NativeSdkInfo], cfg = "exec"),
        "ranlib": attr.label(mandatory = True, allow_single_file = True),
        "python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_builder": attr.label(default = ":build.py", allow_single_file = True),
        "_common": attr.label(default = "//tools/bazel/tools/bun_build_utilities:source-build.py", allow_single_file = True),
        "_pins": attr.label(default = ":pins.json", allow_single_file = True),
        "_darwin": attr.label(default = "@platforms//os:osx"),
        "_linux": attr.label(default = "@platforms//os:linux"),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)
