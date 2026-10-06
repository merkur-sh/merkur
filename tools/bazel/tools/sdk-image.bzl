"""Executable utilities supplied by the digest-pinned GNU execution SDK."""

ImageToolInfo = provider(fields = {
    "path": "Absolute executable path within the immutable SDK.",
    "images": "Permitted native-architecture OCI images, including their digests.",
})

_IMAGES = {
    "x86_64": "docker://gcc@sha256:a689e29bc3adf4663ef9a141d23081252764d1319c63f591a027bd6fd676f4c1",
    "aarch64": "docker://gcc@sha256:66035d353338cb93b64f621393dc6fecde85258651ca454f0cf36ff2639b1352",
}

def _sdk_image_tool_impl(ctx):
    if not ctx.attr.path.startswith("/") or any([part in ["", ".", ".."] for part in ctx.attr.path.split("/")[1:]]):
        fail("SDK utility requires a canonical absolute image path")
    if any([character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-_." for character in ctx.attr.path.elems()]):
        fail("SDK utility path contains shell syntax")
    output = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(output, """#!/bin/sh
set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
exec %s "$@"
""" % ctx.attr.path, is_executable = True)
    return [
        DefaultInfo(executable = output),
        ImageToolInfo(path = ctx.attr.path, images = _IMAGES),
    ]

sdk_image_tool = rule(
    implementation = _sdk_image_tool_impl,
    executable = True,
    attrs = {"path": attr.string(mandatory = True)},
)
