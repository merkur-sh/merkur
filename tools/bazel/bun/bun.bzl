"""Bun programs, run from the repository root in their runfiles."""

load("@aspect_rules_js//js:libs.bzl", "js_lib_helpers")
load("//tools/bazel:sources.bzl", "SYMLINKS")
load("//tools/bazel/playwright:extensions.bzl", "CHROMIUM_REVISION")

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

def _bun_test_impl(ctx):
    bun = ctx.file._bun
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo
    tests = sorted([f.short_path for f in ctx.files.tests])
    tools = "\n".join([
        'ln -s "$runfiles/_main/{path}" "$TEST_TMPDIR/bin/{name}"'.format(
            name = name,
            path = target[DefaultInfo].files_to_run.executable.short_path,
        )
        for target, name in ctx.attr.tools.items()
    ])
    # Each browser's directory, by the install marker at its root, under the name Playwright
    # looks for it in its browsers directory.
    browsers = "\n".join([
        'ln -s "$(dirname "$(realpath "$runfiles/_main/{marker}")")" "$TEST_TMPDIR/browsers/{name}"'.format(
            marker = [f for f in target.files.to_list() if f.basename == "INSTALLATION_COMPLETE"][0].short_path,
            name = name,
        )
        for target, name in ctx.attr.browsers.items()
    ])
    # Each mounted repository's files, copied to their checkout directory.
    mounts = "\n".join([
        'mkdir -p "$tree/{path}" && tar -C "$runfiles/{repo}" -chf - . | tar -C "$tree/{path}" -xf -'.format(
            path = path,
            repo = target.files.to_list()[0].short_path.split("/")[1],
        )
        for target, path in ctx.attr.mounts.items()
    ])
    links = "\n".join([
        'mkdir -p "$(dirname "$tree/{path}")" && ln -s "{target}" "$tree/{path}"'.format(
            path = path,
            target = target,
        )
        for path, target in sorted(ctx.attr.links.items())
    ])
    launcher = ctx.actions.declare_file(ctx.label.name)

    # The declared files become a checkout of their own in the test's scratch: real files, so a
    # walk or Bun's test discovery sees them as in a working tree, and nothing outside them is
    # reachable by a relative path. Installed packages stay links into rules_js's store.
    ctx.actions.write(
        output = launcher,
        content = """#!/usr/bin/env bash
set -euo pipefail
runfiles="$(cd "${{RUNFILES_DIR:-$0.runfiles}}" && pwd)"
main="$runfiles/_main"
# A test's scratch; a build action running this as a tool names one with `TEST_TMPDIR` too.
tree="$TEST_TMPDIR/checkout"
mkdir -p "$tree"
tar -C "$main" --exclude=node_modules -chf - . | tar -C "$tree" -xf -
modules_dirs=()
while read -r modules; do
  mkdir -p "$tree/$modules"
  for entry in "$main/$modules"/* "$main/$modules"/.[!.]*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then ln -s "$entry" "$tree/$modules/"; fi
  done
  modules_dirs+=("$tree/$modules")
done < <(cd "$main" && find . -name node_modules -prune -type d)
{mounts}
{links}
{git}
export HOME="$TEST_TMPDIR/home"
mkdir -p "$HOME" "$TEST_TMPDIR/bin"
# What the tests spawn by name: Bun (and `bunx`), and Node.
ln -s "$runfiles/_main/{bun}" "$TEST_TMPDIR/bin/bun"
ln -s "$runfiles/_main/{bun}" "$TEST_TMPDIR/bin/bunx"
ln -s "$runfiles/_main/{node}" "$TEST_TMPDIR/bin/node"
{tools}
export PATH="$TEST_TMPDIR/bin:$PATH"
"$runfiles/_main/{bun}" "$runfiles/_main/{link_bins}" ${{modules_dirs[@]+"${{modules_dirs[@]}}"}}
mkdir -p "$TEST_TMPDIR/browsers"
{browsers}
export PLAYWRIGHT_BROWSERS_PATH="$TEST_TMPDIR/browsers"
cd "$tree"
# `${{a[@]+...}}`: macOS's Bash 3.2 calls an empty array unbound.
files=({tests})
selected=()
if [ -n "${{TEST_TOTAL_SHARDS:-}}" ]; then
  touch "$TEST_SHARD_STATUS_FILE"
  for index in ${{files[@]+"${{!files[@]}}"}}; do
    if [ $((index % TEST_TOTAL_SHARDS)) -eq "$TEST_SHARD_INDEX" ]; then
      selected+=("./${{files[$index]}}")
    fi
  done
else
  for file in ${{files[@]+"${{files[@]}}"}}; do selected+=("./$file"); done
fi
exec "$runfiles/_main/{bun}" {args} ${{selected[@]+"${{selected[@]}}"}} "$@"
""".format(
            args = " ".join(ctx.attr.args_),
            browsers = browsers,
            bun = bun.short_path,
            link_bins = ctx.file._link_bins.short_path,
            mounts = mounts,
            git = "" if not ctx.attr.git else "(cd \"$tree\" && export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 && git init -q && git add -A && git -c user.name=bazel -c user.email=bazel@localhost commit -qm checkout)",
            links = links,
            node = node.node.short_path,
            tools = tools,
            tests = " ".join(tests),
        ),
        is_executable = True,
    )
    runfiles = js_lib_helpers.gather_runfiles(
        ctx = ctx,
        sources = depset(ctx.files.tests),
        data = ctx.attr.data,
        deps = [],
    ).merge(ctx.runfiles(files = [bun, ctx.file._link_bins, node.node] + node.tool_files))
    for target in ctx.attr.tools:
        runfiles = runfiles.merge(target[DefaultInfo].default_runfiles)
    for target in list(ctx.attr.browsers) + list(ctx.attr.mounts):
        runfiles = runfiles.merge(ctx.runfiles(transitive_files = target.files))
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

_CHECKOUT_ATTRS = {
    "args_": attr.string_list(doc = "Bun's arguments, before the test files."),
    "browsers": attr.label_keyed_string_dict(
        doc = "Playwright browsers, by the directory Playwright reads each from.",
    ),
    "data": attr.label_list(allow_files = True),
    "git": attr.bool(),
    "links": attr.string_dict(doc = "Symlinks to recreate, by path, with their targets."),
    "mounts": attr.label_keyed_string_dict(
        doc = "Other repositories' files, by the checkout directory they sit in.",
    ),
    "tests": attr.label_list(allow_files = True),
    "tools": attr.label_keyed_string_dict(
        doc = "Executables the tests spawn, by the name they run them under.",
    ),
    "_bun": attr.label(
        default = "//tools/bazel/bun",
        allow_single_file = True,
    ),
    "_link_bins": attr.label(
        default = "//tools/bazel/bun:link-bins.ts",
        allow_single_file = True,
    ),
}

bun_test = rule(
    implementation = _bun_test_impl,
    doc = """Bun over a checkout of the declared files: `bun <args_> <tests>`.

`tests` are appended as paths, a sharded run taking every Nth. `data` holds the files the run
reads and the `node_modules` it resolves through; `links` recreates the checkout's symlinks and
`git` makes the checkout a repository whose one commit holds every file. `browsers` installs
Playwright's browsers where the tests' Playwright launches them.""",
    attrs = _CHECKOUT_ATTRS,
    test = True,
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)

bun_checkout = rule(
    implementation = _bun_test_impl,
    doc = """`bun <args_> <arguments>` over a checkout of the declared files, as `bun_test` makes it.

A build action runs it as a tool, naming a scratch directory in `TEST_TMPDIR`.""",
    attrs = _CHECKOUT_ATTRS,
    executable = True,
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)

# The vendored transport crates, which Bazel loads only as these repositories (`MODULE.bazel`).
_VENDORED = {
    "@vendored_quinn_patch//:files": "packages/quinn-patch",
    "@vendored_quinn_proto_patch//:files": "packages/quinn-proto-patch",
    "@vendored_wtransport_patch//:files": "packages/wtransport-patch",
}

# What Bun tests read: the checkout, whose TypeScript holds Rust and prose to the same contracts,
# the installed dependencies, and the WebAssembly packages the sources import.
_TEST_DATA = [
    "//:sources",
    "//:wasm_packages",
    "//:workspace_node_modules",
]

def bun_tests(name = "test", tests = [], parallel = 4, browsers = False, **kwargs):
    """`bun test` over `tests` in a checkout of `data`, with the checkout's symlinks.

    Args:
      name: the test's name.
      tests: the test files.
      parallel: Bun's worker processes, which the test reserves as CPUs.
      browsers: whether the tests launch Playwright's Chromium.
      **kwargs: the common test attributes, such as `shard_count` or `size`.
    """
    bun_test(
        name = name,
        args_ = ["test", "--parallel=%d" % parallel],
        browsers = {
            "//tools/bazel/playwright:chromium": "chromium-" + CHROMIUM_REVISION,
            "//tools/bazel/playwright:chromium_headless_shell": "chromium_headless_shell-" + CHROMIUM_REVISION,
        } if browsers else {},
        data = _TEST_DATA,
        links = SYMLINKS,
        mounts = _VENDORED,
        tags = kwargs.pop("tags", []) + ["cpu:%d" % parallel],
        tests = tests,
        **kwargs
    )

def repo_check(name, script, **kwargs):
    """`bun run <script>`, a `package.json` gate, over a checkout of the whole repository.

    The checkout is a Git repository, so the gates see what Git ignores as a working tree does.

    Args:
      name: the test's name.
      script: the `package.json` script that is the gate.
      **kwargs: the common test attributes.
    """
    bun_test(
        name = name,
        args_ = ["run", script],
        data = _TEST_DATA,
        git = True,
        links = SYMLINKS,
        mounts = _VENDORED,
        **kwargs
    )

def repo_checkout(name, **kwargs):
    """`bun <arguments>` over a checkout of the whole repository, for build actions.

    Args:
      name: the executable's name.
      **kwargs: the common attributes.
    """
    bun_checkout(
        name = name,
        data = _TEST_DATA,
        links = SYMLINKS,
        mounts = _VENDORED,
        **kwargs
    )
