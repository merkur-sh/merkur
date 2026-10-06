"""Expose a native executable with its complete declared distribution runfiles."""

def _native_executable_impl(ctx):
    binary = ctx.file.binary
    output = ctx.actions.declare_file(ctx.label.name + ".bin")
    ctx.actions.symlink(output = output, target_file = binary, is_executable = True)
    runfiles = ctx.runfiles(files = [binary], transitive_files = ctx.attr.runtime[DefaultInfo].files)
    runfiles = runfiles.merge(ctx.attr.runtime[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = output, runfiles = runfiles)]

native_executable = rule(
    implementation = _native_executable_impl,
    executable = True,
    attrs = {
        "binary": attr.label(allow_single_file = True, mandatory = True),
        "runtime": attr.label(mandatory = True),
    },
)
