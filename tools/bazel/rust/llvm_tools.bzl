"""Executables from the selected, pinned Rust compiler's LLVM toolchain."""

def _llvm_profdata_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    binary = toolchain.llvm_profdata
    if binary == None:
        fail("the pinned Rust toolchain must provide LLVM profdata")
    executable = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.symlink(output = executable, target_file = binary, is_executable = True)
    return [DefaultInfo(executable = executable, runfiles = ctx.runfiles(files = [binary] + toolchain.llvm_lib))]

rust_llvm_profdata = rule(
    implementation = _llvm_profdata_impl,
    executable = True,
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def _rust_tool_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    binary = getattr(toolchain, ctx.attr.tool)
    if binary == None:
        fail("the pinned Rust toolchain must provide " + ctx.attr.tool)
    executable = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.symlink(output = executable, target_file = binary, is_executable = True)
    return [DefaultInfo(executable = executable, runfiles = ctx.runfiles(transitive_files = toolchain.all_files))]

rust_tool = rule(
    implementation = _rust_tool_impl,
    executable = True,
    attrs = {"tool": attr.string(mandatory = True, values = ["cargo", "rustc"])},
    toolchains = ["@rules_rust//rust:toolchain_type"],
)
