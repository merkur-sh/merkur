"""`bazel run` installs built files into the checkout's ignored paths, where Vite, Bun, the daemon
and the harnesses read them."""

def _checkout_sync_impl(ctx):
    by_destination = {}
    files = []
    for target, destinations in ctx.attr.sources.items():
        sources = target[DefaultInfo].files.to_list()
        files.extend(sources)
        for destination in destinations.split(" "):
            by_destination.setdefault(destination, []).extend([source.short_path for source in sources])
    lines = [
        "sync {} {}".format(destination, " ".join(paths))
        for destination, paths in sorted(by_destination.items())
    ]
    launcher = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.write(
        output = launcher,
        content = """#!/usr/bin/env bash
# Each destination becomes exactly its files; one already equal is left untouched, so a dev
# server watching it does not reload and a running program keeps its executable.
set -euo pipefail
runfiles="$(cd "${{RUNFILES_DIR:-$0.runfiles}}" && pwd)/_main"
cd "$BUILD_WORKSPACE_DIRECTORY"
sync() {{
  local destination="$1"
  shift
  local staged
  staged="$(mktemp -d)"
  for file in "$@"; do
    cp "$runfiles/$file" "$staged/"
  done
  chmod {mode} "$staged"/*
  if ! diff -r "$staged" "$destination" >/dev/null 2>&1; then
    rm -rf "$destination"
    mkdir -p "$destination"
    cp -p "$staged"/* "$destination/"
    echo "synced $destination"
  fi
  rm -rf "$staged"
}}
{lines}
""".format(lines = "\n".join(lines), mode = "0755" if ctx.attr.executable else "0644"),
        is_executable = True,
    )
    return [DefaultInfo(executable = launcher, runfiles = ctx.runfiles(files = files))]

checkout_sync = rule(
    implementation = _checkout_sync_impl,
    doc = "Copies each target's files into its space-separated checkout destinations.",
    attrs = {
        "executable": attr.bool(doc = "Whether the files are programs, installed executable."),
        "sources": attr.label_keyed_string_dict(mandatory = True),
    },
    executable = True,
)
