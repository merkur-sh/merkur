"""Original source utilities through the configured native C toolchain."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")

def _sources_impl(ctx):
    pins = json.decode(ctx.read(ctx.path(Label("//tools/bazel/tools/bun_build_utilities:pins.json"))))
    for kind in ["perl", "nasm", "bash", "readline", "ncurses"]:
        pin = pins[kind]
        http_file(name = "bun_build_" + kind + "_source", urls = [pin["url"]], sha256 = pin["sha256"], downloaded_file_path = kind + (".tar.gz" if kind in ["bash", "readline", "ncurses"] else ".tar.xz"))

bun_build_utility_sources = module_extension(
    implementation = _sources_impl,
)

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

def _prefix(sdk):
    if "/bin/" not in sdk.binary.path:
        fail("Bun build utility requires an original SDK bin File")
    return sdk.binary.path.rsplit("/bin/", 1)[0]

def _sdk_impl(ctx):
    kind = ctx.attr.kind
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__MERKUR_SOURCE__", output_file = "__MERKUR_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__MERKUR_EXECUTABLE__", is_using_linker = True)
    compiler_files = cc.all_files.to_list()
    paths = [file.path for file in compiler_files]
    tools = {"cc": cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.c_compile), "ar": cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_static_library), "ranlib": ctx.file.ranlib.path}
    if any([tool not in paths for tool in tools.values()]):
        fail("Bun utility compiler tools must be original Files in CcToolchain.all_files")
    sdk = ctx.attr.shell[NativeSdkInfo]
    make = ctx.attr.make[NativeSdkInfo]
    shell_files = ctx.attr.shell[DefaultInfo].default_runfiles.files
    make_files = ctx.attr.make[DefaultInfo].default_runfiles.files
    perl_files = ctx.attr.perl[DefaultInfo].default_runfiles.files if ctx.attr.perl else depset()
    if kind == "nasm" and not ctx.attr.perl:
        fail("Original NASM source requires its declared original Perl input")
    if kind == "bash" and (not ctx.file.readline_archive or not ctx.file.ncurses_archive):
        fail("Original Bash requires its declared readline and ncurses source archives")
    environment = {}
    for action in [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_link_executable]:
        environment.update(cc_common.get_environment_variables(feature_configuration = features, action_name = action, variables = link_variables if action == ACTION_NAMES.cpp_link_executable else variables))
    runtime = ctx.actions.declare_directory(ctx.label.name + ".sdk")
    binary = ctx.actions.declare_file(ctx.label.name + ".tools/" + kind)
    specification = ctx.actions.declare_file(ctx.label.name + ".build.json")
    request = {
        "kind": kind, "pins": ctx.file._pins.path, "archive": ctx.file.archive.path,
        "sdk": _prefix(sdk), "make_sdk": _prefix(make),
        "shell": sdk.binary.path, "make": make.binary.path,
        "git": ctx.attr.git[NativeSdkInfo].binary.path,
        "git_files": [file.path for file in ctx.attr.git[DefaultInfo].default_runfiles.files.to_list()],
        "patch": ctx.file.patch.path,
        "compiler_files": paths,
        "shell_files": [file.path for file in shell_files.to_list()],
        "make_files": [file.path for file in make_files.to_list()],
        "compile_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables), "__MERKUR_OBJECT__"),
        "link_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables), "__MERKUR_EXECUTABLE__"),
        "environment": environment, "runtime": runtime.path, "binary": binary.path,
        "perl": ctx.attr.perl[NativeSdkInfo].binary.path if ctx.attr.perl else None,
        "perl_files": [file.path for file in perl_files.to_list()],
    }
    bash_inputs = []
    if kind == "bash":
        bash_inputs = [ctx.file.readline_archive, ctx.file.ncurses_archive, ctx.file._bash_builder]
        cxx = cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile)
        if cxx not in paths:
            fail("Original ncurses C++ compiler must be an original CcToolchain File")
        request.update({
            "readline_archive": ctx.file.readline_archive.path,
            "ncurses_archive": ctx.file.ncurses_archive.path,
            "bash_builder": ctx.file._bash_builder.path,
            "cxx": cxx,
            "cxx_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile, variables = variables), "__MERKUR_OBJECT__"),
        })
    request.update(tools)
    ctx.actions.write(specification, json.encode(request))
    ctx.actions.run(
        executable = ctx.executable.python,
        arguments = ["-B", "-I", ctx.file.builder.path, specification.path],
        inputs = depset([ctx.file.builder, ctx.file.archive, ctx.file._pins, ctx.file.patch, specification] + bash_inputs, transitive = [cc.all_files, shell_files, make_files, perl_files, ctx.attr.git[DefaultInfo].default_runfiles.files]),
        tools = [ctx.attr.python[DefaultInfo].files_to_run],
        outputs = [runtime, binary],
        mnemonic = "BunBuildUtilitySdk",
        progress_message = "Building original %s with declared native compiler and utilities" % kind,
        use_default_shell_env = False,
    )
    return [DefaultInfo(executable = binary, files = depset([runtime, binary]), runfiles = ctx.runfiles(files = [runtime, binary])), NativeSdkInfo(prefix_runfile = "_main/" + runtime.short_path, binary = binary)]

declared_bun_build_utility = rule(
    implementation = _sdk_impl,
    executable = True,
    attrs = {
        "kind": attr.string(mandatory = True, values = ["perl", "nasm", "bash"]),
        "_pins": attr.label(default = "//tools/bazel/tools/bun_build_utilities:pins.json", allow_single_file = True),
        "archive": attr.label(mandatory = True, allow_single_file = True),
        "shell": attr.label(mandatory = True, providers = [NativeSdkInfo], cfg = "exec"),
        "make": attr.label(mandatory = True, providers = [NativeSdkInfo], cfg = "exec"),
        "git": attr.label(mandatory = True, providers = [NativeSdkInfo], cfg = "exec"),
        "patch": attr.label(mandatory = True, allow_single_file = True),
        "perl": attr.label(providers = [NativeSdkInfo], cfg = "exec"),
        "readline_archive": attr.label(allow_single_file = True),
        "ncurses_archive": attr.label(allow_single_file = True),
        "_bash_builder": attr.label(default = "//tools/bazel/tools/bun_build_utilities:bash-source-build.py", allow_single_file = True),
        "ranlib": attr.label(mandatory = True, allow_single_file = True),
        "python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "builder": attr.label(default = "//tools/bazel/tools/bun_build_utilities:source-build.py", allow_single_file = True),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)
