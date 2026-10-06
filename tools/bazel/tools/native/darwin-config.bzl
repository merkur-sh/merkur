"""CcToolchainConfigInfo that consumes only the original declared Darwin closure."""
load(":darwin-artifacts.bzl", "DarwinCompilerSdkInfo")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:cc_toolchain_config_lib.bzl", "action_config", "env_entry", "env_set", "feature", "flag_group", "flag_set", "make_variable", "tool", "variable_with_value")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/toolchains:cc_toolchain_config_info.bzl", "CcToolchainConfigInfo")

_COMPILE = [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile, ACTION_NAMES.assemble, ACTION_NAMES.preprocess_assemble]
_LINK = [ACTION_NAMES.cpp_link_executable, ACTION_NAMES.cpp_link_dynamic_library, ACTION_NAMES.cpp_link_nodeps_dynamic_library]

def _declared_tool(ctx, file, role):
    sdk = ctx.attr.sdk[DarwinCompilerSdkInfo]
    if file != sdk.members.get(sdk.tools[role]) or file not in sdk.files.to_list() or not file.path.startswith(sdk.root + "/"):
        fail("Darwin compiler tool is absent from its complete original File closure")
    return file

def _directory(ctx, role):
    sdk = ctx.attr.sdk[DarwinCompilerSdkInfo]
    path = getattr(sdk, role)
    if not path or path.startswith("/") or ".." in path.split("/") or "\\" in path:
        fail("Darwin compiler directories must be exact declared relative members")
    return sdk.root + "/" + path

def _impl(ctx):
    if ctx.attr.cpu not in ["aarch64", "x86_64"] or ctx.attr.cpu != ctx.attr.sdk[DarwinCompilerSdkInfo].execution_cpu:
        fail("Darwin compiler requires an exact native CPU")
    if any([not part or any([digit not in "0123456789" for digit in part.elems()]) for part in ctx.attr.deployment_target.split(".")]):
        fail("Darwin deployment target requires an explicit OS release")
    for role in ["clang", "clangxx", "ld", "ar", "ranlib", "nm", "strip", "objdump"]:
        _declared_tool(ctx, getattr(ctx.file, role), role)
    sysroot = _directory(ctx, "sysroot")
    resource = _directory(ctx, "resource_dir")
    cxx_headers = _directory(ctx, "cxx_headers")
    target = ("arm64" if ctx.attr.cpu == "aarch64" else "x86_64") + "-apple-macos" + ctx.attr.deployment_target
    clang = _declared_tool(ctx, ctx.file.clang, "clang")
    clangxx = _declared_tool(ctx, ctx.file.clangxx, "clangxx")
    linker = _declared_tool(ctx, ctx.file.ld, "ld")
    archiver = _declared_tool(ctx, ctx.file.ar, "ar")
    ranlib = _declared_tool(ctx, ctx.file.ranlib, "ranlib")
    flags = ["--no-default-config", "--target=" + target, "-isysroot", sysroot, "-resource-dir", resource]
    return [cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = str(ctx.label),
        host_system_name = ctx.attr.cpu + "-apple-darwin",
        target_system_name = ctx.attr.cpu + "-apple-darwin",
        target_cpu = ctx.attr.cpu,
        target_libc = "macos",
        compiler = "clang",
        abi_version = "darwin",
        abi_libc_version = ctx.attr.deployment_target,
        builtin_sysroot = sysroot,
        cxx_builtin_include_directories = ["%workspace%/" + directory for directory in [sysroot + "/usr/include", sysroot + "/System/Library/Frameworks", resource + "/include", cxx_headers]],
        action_configs = [action_config(action_name = action, enabled = True, tools = [tool(tool = clangxx if action == ACTION_NAMES.cpp_compile else clang)]) for action in _COMPILE] +
            [action_config(action_name = action, enabled = True, tools = [tool(tool = clangxx)]) for action in _LINK] +
            [action_config(action_name = ACTION_NAMES.cpp_link_static_library, enabled = True, tools = [tool(tool = archiver)]),
             action_config(action_name = ACTION_NAMES.strip, enabled = True, tools = [tool(tool = ctx.file.strip)])],
        tool_paths = [],
        make_variables = [make_variable(name = "RANLIB", value = ctx.file.ranlib.path)],
        features = [
            feature(name = "archive_flags", enabled = True, flag_sets = [flag_set(actions = [ACTION_NAMES.cpp_link_static_library], flag_groups = [
                flag_group(flags = ["rcs", "%{output_execpath}"], expand_if_available = "output_execpath"),
                flag_group(iterate_over = "libraries_to_link", flag_groups = [
                    flag_group(flags = ["%{libraries_to_link.name}"], expand_if_equal = variable_with_value(name = "libraries_to_link.type", value = "object_file")),
                    flag_group(flags = ["%{libraries_to_link.object_files}"], iterate_over = "libraries_to_link.object_files", expand_if_equal = variable_with_value(name = "libraries_to_link.type", value = "object_file_group")),
                ]),
            ])]),
            feature(name = "declared_darwin_sdk", enabled = True,
                    flag_sets = [flag_set(actions = _COMPILE + _LINK, flag_groups = [flag_group(flags = flags)]),
                                 flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["-nostdinc", "-F", sysroot + "/System/Library/Frameworks"])]),
                                 flag_set(actions = [action for action in _COMPILE if action != ACTION_NAMES.cpp_compile], flag_groups = [flag_group(flags = ["-isystem", resource + "/include", "-isystem", sysroot + "/usr/include"])]),
                                 flag_set(actions = [ACTION_NAMES.cpp_compile], flag_groups = [flag_group(flags = ["-nostdinc++", "-isystem", cxx_headers, "-isystem", resource + "/include", "-isystem", sysroot + "/usr/include"])]),
                                 flag_set(actions = _LINK, flag_groups = [flag_group(flags = ["--ld-path=" + ctx.file.ld.path])])],
                    env_sets = [env_set(actions = _COMPILE + _LINK + [ACTION_NAMES.cpp_link_static_library], env_entries = [env_entry(key = "PATH", value = ":".join(sorted({file.dirname: True for file in [ctx.file.clang, ctx.file.clangxx, ctx.file.ld, ctx.file.ar, ctx.file.ranlib, ctx.file.nm, ctx.file.strip, ctx.file.objdump]}))), env_entry(key = "SDKROOT", value = sysroot), env_entry(key = "ZERO_AR_DATE", value = "1")])]),
        ],
    )]

darwin_config = rule(
    implementation = _impl,
    attrs = dict({name: attr.label(allow_single_file = True, mandatory = True) for name in ["clang", "clangxx", "ld", "ar", "ranlib", "nm", "strip", "objdump"]},
                 cpu = attr.string(mandatory = True), deployment_target = attr.string(mandatory = True),
                 sdk = attr.label(providers = [DarwinCompilerSdkInfo], mandatory = True)),
    provides = [CcToolchainConfigInfo],
)
