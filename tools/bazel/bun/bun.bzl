"""Bun programs, run from the repository root in their runfiles."""

def _bun_binary_impl(ctx):
    bun = ctx.file._bun
    launcher = ctx.actions.declare_file(ctx.label.name)

    # `RUNFILES_DIR` is set when this runs as a test or as another target's data; `$0.runfiles`
    # when it is run directly or as an action's tool, from the execution root. The repository root is `_main` in both, where every source and
    # every package's `node_modules` sit at their checkout paths.
    ctx.actions.write(
        output = launcher,
        content = """#!/usr/bin/env bash
set -euo pipefail
runfiles="$(cd "${{RUNFILES_DIR:-$0.runfiles}}" && pwd)"
cd "$runfiles/_main"
exec "$runfiles/_main/{bun}" run {entry} "$@"
""".format(bun = bun.short_path, entry = ctx.file.entry.short_path),
        is_executable = True,
    )
    runfiles = ctx.runfiles(files = [bun, ctx.file.entry] + ctx.files.data)
    for target in ctx.attr.data:
        runfiles = runfiles.merge(target[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

bun_binary = rule(
    implementation = _bun_binary_impl,
    doc = "A script Bun runs, with the sources and packages it imports as `data`.",
    attrs = {
        "data": attr.label_list(allow_files = True),
        "entry": attr.label(allow_single_file = [".ts", ".js", ".mjs"], mandatory = True),
        "_bun": attr.label(
            default = "//tools/bazel/bun",
            allow_single_file = True,
        ),
    },
    executable = True,
)
