"""Executable adapters retain the complete checksum-pinned browser distribution."""

def _browser_executable_impl(ctx):
    executable = ctx.actions.declare_file(ctx.label.name + ".bin")
    ctx.actions.symlink(output = executable, target_file = ctx.file.binary, is_executable = True)
    return [DefaultInfo(executable = executable, runfiles = ctx.runfiles(files = [ctx.file.binary], transitive_files = ctx.attr.payload[DefaultInfo].files))]

browser_executable = rule(
    implementation = _browser_executable_impl,
    attrs = {"binary": attr.label(allow_single_file = True, mandatory = True), "payload": attr.label(mandatory = True)},
    executable = True,
)
