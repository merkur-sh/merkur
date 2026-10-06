"""Freestanding wasm32 C actions from the declared WASI SDK compiler distribution."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:cc_toolchain_config_lib.bzl", "action_config", "feature", "flag_group", "flag_set", "tool", "tool_path", "variable_with_value")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/toolchains:cc_toolchain_config_info.bzl", "CcToolchainConfigInfo")

def _tool_path(ctx, file):
    prefix = ctx.label.workspace_root + "/"
    if not ctx.label.workspace_root or not file.path.startswith(prefix):
        fail("WASM C configuration must reside with its declared SDK tools")
    return file.path[len(prefix):]

_COMPILE = [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile, ACTION_NAMES.assemble, ACTION_NAMES.preprocess_assemble]
_LINK = [ACTION_NAMES.cpp_link_executable, ACTION_NAMES.cpp_link_dynamic_library, ACTION_NAMES.cpp_link_nodeps_dynamic_library]

def _impl(ctx):
    compiler = ctx.file.clang.path
    root = compiler.rsplit("/", 2)[0]
    headers = root + "/lib/clang/22/include"
    return [cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = ctx.label.name,
        host_system_name = ctx.attr.host,
        target_system_name = "wasm32-unknown-unknown",
        target_cpu = "wasm32",
        target_libc = "none",
        compiler = "clang",
        abi_version = "wasm32",
        abi_libc_version = "none",
        cxx_builtin_include_directories = [headers],
        action_configs = [action_config(action_name = action, enabled = True, tools = [tool(path = _tool_path(ctx, ctx.file.clang))]) for action in _COMPILE] +
            [action_config(action_name = action, enabled = True, tools = [tool(path = _tool_path(ctx, ctx.file.linker))]) for action in _LINK] +
            [action_config(action_name = ACTION_NAMES.cpp_link_static_library, enabled = True, tools = [tool(path = _tool_path(ctx, ctx.file.archiver))])],
        tool_paths = [tool_path(name = name, path = _tool_path(ctx, file)) for name, file in [
            ("gcc", ctx.file.clang), ("cpp", ctx.file.clang),
            ("ar", ctx.file.archiver), ("ld", ctx.file.linker),
            ("nm", ctx.file.nm), ("objdump", ctx.file.objdump), ("strip", ctx.file.strip),
        ]],
        features = [
            feature(name = "archive_flags", enabled = True, flag_sets = [flag_set(actions = [ACTION_NAMES.cpp_link_static_library], flag_groups = [
                flag_group(flags = ["rcsD", "%{output_execpath}"]),
                flag_group(iterate_over = "libraries_to_link", flag_groups = [
                    flag_group(flags = ["%{libraries_to_link.name}"], expand_if_equal = variable_with_value(name = "libraries_to_link.type", value = "object_file")),
                    flag_group(flags = ["%{libraries_to_link.object_files}"], iterate_over = "libraries_to_link.object_files", expand_if_equal = variable_with_value(name = "libraries_to_link.type", value = "object_file_group")),
                ]),
            ])]),
            feature(name = "freestanding_wasm", enabled = True, flag_sets = [flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["--no-default-config", "--target=wasm32-unknown-unknown", "-ffreestanding", "-nostdinc", "-isystem", headers])])]),
            feature(name = "user_compile_flags", enabled = True, flag_sets = [flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["%{user_compile_flags}"], iterate_over = "user_compile_flags", expand_if_available = "user_compile_flags")])]),
            feature(name = "preprocessor_defines", enabled = True, flag_sets = [flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["-D%{preprocessor_defines}"], iterate_over = "preprocessor_defines", expand_if_available = "preprocessor_defines")])]),
            feature(name = "compiler_input_flags", enabled = True, flag_sets = [flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["-c", "%{source_file}"], expand_if_available = "source_file")])]),
            feature(name = "compiler_output_flags", enabled = True, flag_sets = [flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["-o", "%{output_file}"], expand_if_available = "output_file")])]),
        ],
    )]

wasm_config = rule(
    implementation = _impl,
    attrs = dict({name: attr.label(allow_single_file = True, mandatory = True) for name in ["clang", "archiver", "linker", "nm", "objdump", "strip"]}, host = attr.string(mandatory = True), compiler = attr.string(default = "clang")),
    provides = [CcToolchainConfigInfo],
)
