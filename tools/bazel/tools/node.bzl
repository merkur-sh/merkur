"""Expose the pinned Node distribution as a declared executable child tool."""

def _node_executable_impl(ctx):
    # Child-tool attributes transition this target to their execution platform.
    # The runtime toolchain selects that target platform rather than selecting an
    # independent execution platform for the adapter itself.
    toolchain = ctx.toolchains["@rules_nodejs//nodejs:runtime_toolchain_type"]
    node = toolchain.nodeinfo
    if node.node == None or node.node_path:
        fail("Declared Node requires its downloaded executable File; host node_path is forbidden")
    output = ctx.actions.declare_file(ctx.label.name + ".bin")
    ctx.actions.symlink(output = output, target_file = node.node, is_executable = True)
    # The original toolchain binds :node_bin (the native distribution File),
    # not its env/Bash :node wrapper. Preserve its complete declared resources.
    files = depset(node.tool_files, transitive = [toolchain.default.files, node.npm_sources])
    runfiles = ctx.runfiles(transitive_files = files)
    for original in [toolchain.default.default_runfiles, toolchain.default.data_runfiles]:
        if original != None:
            runfiles = runfiles.merge(original)
    return [DefaultInfo(executable = output, runfiles = runfiles)]

node_executable = rule(
    implementation = _node_executable_impl,
    executable = True,
    toolchains = ["@rules_nodejs//nodejs:runtime_toolchain_type"],
)
