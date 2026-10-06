"""Native verification tools from exact locked npm package directory Files."""

NativeVerificationToolInfo = provider(fields = {
    "package": "Declared package directory File.",
    "member": "Exact executable member in that package.",
})

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _impl(ctx):
    package = ctx.file.package
    if not package.is_directory or ctx.attr.member not in ["biome", "fallow", "lib/tsc"]:
        fail("Native verification tools require an exact directory File and executable member")
    output = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(output, """#!/bin/sh
set -eu
runfiles=${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}
exec "$runfiles/%s/%s" "$@"
""" % (_runfile(package), ctx.attr.member), is_executable = True)
    return [
        DefaultInfo(executable = output, runfiles = ctx.runfiles(files = [package])),
        NativeVerificationToolInfo(package = package, member = ctx.attr.member),
    ]

native_verification_tool = rule(
    implementation = _impl,
    executable = True,
    attrs = {
        "package": attr.label(allow_single_file = True, mandatory = True, cfg = "exec"),
        "member": attr.string(mandatory = True),
    },
)
