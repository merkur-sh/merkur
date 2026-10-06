"""Native GNU SDK resident in an immutable, explicitly constrained executor image."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:cc_toolchain_config_lib.bzl", "action_config", "tool", "tool_path")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/toolchains:cc_toolchain_config_info.bzl", "CcToolchainConfigInfo")

def _impl(ctx):
    return [cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = "gcc-14.3-bookworm-" + ctx.attr.cpu,
        host_system_name = ctx.attr.cpu + "-linux-gnu",
        target_system_name = ctx.attr.cpu + "-linux-gnu",
        target_cpu = ctx.attr.cpu,
        target_libc = "glibc",
        compiler = "gcc",
        abi_version = "gcc14",
        abi_libc_version = "glibc2.36",
        cxx_builtin_include_directories = ["/usr/include", "/usr/local/include", "/usr/local/lib/gcc", "/usr/lib/gcc"],
        action_configs = [action_config(action_name = action, enabled = True, tools = [tool(path = "gxx.sh")]) for action in [
            ACTION_NAMES.cpp_compile,
            ACTION_NAMES.cpp_link_executable,
            ACTION_NAMES.cpp_link_dynamic_library,
            ACTION_NAMES.cpp_link_nodeps_dynamic_library,
        ]],
        tool_paths = [tool_path(name = name, path = filename) for name, filename in [
            ("gcc", "gcc.sh"), ("cpp", "gcc.sh"), ("ar", "ar.sh"),
            ("ld", "ld.sh"), ("nm", "nm.sh"), ("objdump", "objdump.sh"),
            ("objcopy", "objcopy.sh"), ("strip", "strip.sh"), ("gcov", "gcov.sh"),
        ]],
    )]

native_config = rule(
    implementation = _impl,
    attrs = {"cpu": attr.string(mandatory = True), "compiler": attr.string(default = "gcc")},
    provides = [CcToolchainConfigInfo],
)
