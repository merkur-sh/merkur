"""Bun programs, run from the repository root in their runfiles."""

load("@aspect_rules_js//js:libs.bzl", "js_lib_helpers")
load("//tools/bazel:modules.bzl", "MODULES", "TYPE_PROJECTS")
load("//tools/bazel:sources.bzl", "PACKAGES", "SYMLINKS", "WORKSPACE_DEPENDENCIES", "WORKSPACE_LINKS")
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

    # A whole-repository checkout is cloned from the snapshot built once (`repo_snapshot`), its
    # files and its repository, and only what else the run declares is copied beside it. macOS
    # clones copy-on-write, as Linux does where its filesystem can.
    snapshot = ctx.file.snapshot
    checkout = 'tar -C "$main" --exclude=node_modules -chf - . | tar -C "$tree" -xf -'
    if snapshot:
        checkout = """if [ "$(uname -s)" = Darwin ]; then clone=-c; else clone=--reflink=auto; fi
cp -R -L $clone "$main/{snapshot}/." "$tree/"
# Bazel seals what an action wrote read-only; a working tree is the owner's to write.
chmod -R u+w "$tree"
tar -C "$main" --exclude=node_modules --exclude="./{snapshot}" -chf - . | tar -C "$tree" -xf -""".format(
            snapshot = snapshot.short_path,
        )

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
{checkout}
modules_dirs=()
while read -r modules; do
  mkdir -p "$tree/$modules"
  for entry in "$main/$modules"/* "$main/$modules"/.[!.]*; do
    if [ -d "$entry" ] && [[ "${{entry##*/}}" == @* ]]; then
      # A scope holds its packages one link each, so a workspace package's can be its own.
      mkdir -p "$tree/$modules/${{entry##*/}}"
      for package in "$entry"/*; do ln -s "$package" "$tree/$modules/${{entry##*/}}/"; done
    elif [ -e "$entry" ] || [ -L "$entry" ]; then
      ln -s "$entry" "$tree/$modules/"
    fi
  done
  modules_dirs+=("$tree/$modules")
done < <(cd "$main" && find . -name node_modules -prune -type d)
# A workspace package resolves to the checkout's own copy, as in a working tree, so its relative
# paths (a `tsconfig.json` that extends the root's) stay inside the checkout. A package the
# checkout does not hold is one nothing it holds imports.
{workspace}
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
            checkout = checkout,
            link_bins = ctx.file._link_bins.short_path,
            mounts = mounts,
            git = "" if not ctx.attr.git else "(cd \"$tree\" && export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 && git init -q && git add -A && git -c user.name=bazel -c user.email=bazel@localhost commit -qm checkout)",
            links = links,
            node = node.node.short_path,
            tools = tools,
            tests = " ".join(tests),
            workspace = "\n".join([
                'if [ -d "$tree/{directory}" ]; then mkdir -p "$tree/{parent}" && ln -sfn "$tree/{directory}" "$tree/{path}"; fi'.format(
                    directory = directory,
                    parent = path.rpartition("/")[0],
                    path = path,
                )
                for path, directory in sorted(ctx.attr.workspace.items())
            ]),
        ),
        is_executable = True,
    )
    runfiles = js_lib_helpers.gather_runfiles(
        ctx = ctx,
        sources = depset(ctx.files.tests),
        data = ctx.attr.data,
        deps = [],
    ).merge(ctx.runfiles(
        files = [bun, ctx.file._link_bins, node.node] + node.tool_files + ([snapshot] if snapshot else []),
    ))
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
    "snapshot": attr.label(
        allow_single_file = True,
        doc = "A whole-repository checkout (`repo_snapshot`) the run's checkout is cloned from.",
    ),
    "mounts": attr.label_keyed_string_dict(
        doc = "Other repositories' files, by the checkout directory they sit in.",
    ),
    "tests": attr.label_list(allow_files = True),
    "tools": attr.label_keyed_string_dict(
        doc = "Executables the tests spawn, by the name they run them under.",
    ),
    "workspace": attr.string_dict(
        doc = "Workspace packages' checkout directories, by the `node_modules` path that links each.",
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

def _snapshot_file(file):
    return "file\t%s\t%s" % (file.path, file.short_path)

def _repo_snapshot_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    manifest = ctx.actions.args()
    manifest.set_param_file_format("multiline")
    manifest.use_param_file("%s", use_always = True)
    files = depset(transitive = [target.files for target in ctx.attr.srcs])
    manifest.add_all(files, map_each = _snapshot_file)
    mounted = []
    for target, directory in ctx.attr.mounts.items():
        for file in target.files.to_list():
            # `../<repository>/<path>`: the file at its path in the repository's checkout directory.
            within = file.short_path.split("/", 2)[2]
            manifest.add("file\t%s\t%s/%s" % (file.path, directory, within))
            mounted.append(file)
    for path, link in sorted(ctx.attr.links.items()):
        manifest.add("link\t%s\t%s" % (path, link))
    ctx.actions.run(
        executable = ctx.file._bun,
        arguments = [ctx.file._script.path, output.path, manifest],
        inputs = depset(mounted + [ctx.file._script], transitive = [files]),
        outputs = [output],
        mnemonic = "RepoSnapshot",
        progress_message = "Checking out the repository for %{label}",
        # Hundreds of megabytes a commit, rebuilt in seconds: kept in the output tree only. It reads
        # only its declared inputs, which a sandbox would stage one link per file.
        execution_requirements = {"no-remote-cache": "1", "no-sandbox": "1"},
    )
    return [DefaultInfo(files = depset([output]))]

repo_snapshot = rule(
    implementation = _repo_snapshot_impl,
    doc = """The whole repository as one checkout (`snapshot.ts`): `srcs` at their paths, `mounts`'
files under their directories, and `links`, committed to a Git repository. A test that reads the
repository as a whole clones it.""",
    attrs = {
        "links": attr.string_dict(doc = "Symlinks to commit, by path, with their targets."),
        "mounts": attr.label_keyed_string_dict(
            allow_files = True,
            doc = "Other repositories' files, by the checkout directory they sit in.",
        ),
        "srcs": attr.label_list(allow_files = True),
        "_bun": attr.label(default = "//tools/bazel/bun", allow_single_file = True, cfg = "exec"),
        "_script": attr.label(default = "//tools/bazel/bun:snapshot.ts", allow_single_file = True),
    },
)

# The vendored transport crates, which Bazel loads only as these repositories (`MODULE.bazel`).
_VENDORED = {
    "@vendored_quinn_patch//:files": "packages/quinn-patch",
    "@vendored_quinn_proto_patch//:files": "packages/quinn-proto-patch",
    "@vendored_wtransport_patch//:files": "packages/wtransport-patch",
}

# Each workspace package a package depends on, by the `node_modules` path that links it, with its
# directory in the checkout.
_WORKSPACE = {
    (package + "/" if package else "") + "node_modules/" + name: WORKSPACE_LINKS[name]
    for package, names in WORKSPACE_DEPENDENCIES.items()
    for name in names
}

_BROWSERS = {
    "//tools/bazel/playwright:chromium": "chromium-" + CHROMIUM_REVISION,
    "//tools/bazel/playwright:chromium_headless_shell": "chromium_headless_shell-" + CHROMIUM_REVISION,
}

# The whole repository as every test that reads it as a whole clones it (`checkout_snapshot`).
_SNAPSHOT = "//:checkout"

# The tag of a test that reads the repository as a whole, which reruns after any edit.
_REPOSITORY_TAG = "repository"

def checkout_snapshot(name):
    """The whole repository as one checkout: every package's files, whose TypeScript holds Rust
    and prose to the same contracts, the WebAssembly packages the sources import, the vendored
    crates and the tracked symlinks, committed to a Git repository.

    Args:
      name: the snapshot's name.
    """
    repo_snapshot(
        name = name,
        srcs = ["//:sources", "//:wasm_packages"],
        links = SYMLINKS,
        mounts = _VENDORED,
        visibility = ["//visibility:public"],
    )

# What every Bun test loads beyond its own file: `bunfig.toml` and the preloads it names. A
# module's installed third-party packages come with its package's manifest.
_TEST_BASE = ["//:bun_test_config"]

_NEEDS = ["browsers", "checkout", "data", "size", "tools"]

def bun_test_files(name = "test", tests = [], files = {}):
    """One `bun test` per test file, over a checkout of what that file loads.

    A file's checkout is its module target (`tools/bazel/modules.bzl`): the file and everything it
    imports or names with a literal URL, as `scripts/bazel-modules.ts` resolves it, so its test
    reruns only when one of those changes. `src/a.test.ts` is the test `src/a.test`.

    Args:
      name: a suite of every file's test.
      tests: the test files.
      files: what a test file needs beyond what it loads, by file: `data`, labels it reads;
        `tools`, executables it spawns, by the name it runs each under; `browsers`, whether it
        launches Playwright's Chromium; `checkout`, whether it reads the repository as a whole;
        `size`.
    """
    package = native.package_name()
    modules = MODULES.get(package, {})
    for file, needs in files.items():
        if file not in tests:
            fail("%s: %s is not a test file" % (package, file))
        for need in needs:
            if need not in _NEEDS:
                fail("%s: %s needs %s, which is none of %s" % (package, file, need, _NEEDS))
    targets = []
    for test in tests:
        if test not in modules:
            fail("%s/%s is not in tools/bazel/modules.bzl: bun run scripts/bazel-sources.ts" % (package, test))
        needs = files.get(test, {})
        checkout = needs.get("checkout", False)
        target = test.removesuffix(".ts")
        bun_test(
            name = target,
            args_ = ["test"],
            browsers = _BROWSERS if needs.get("browsers", False) else {},
            data = [":%s.module" % test] + _TEST_BASE +
                   (["//:test_node_modules"] if checkout else []) + needs.get("data", []),
            links = SYMLINKS if checkout else {},
            size = needs.get("size", "medium"),
            snapshot = _SNAPSHOT if checkout else None,
            # A test of the repository as a whole, declared or named with its root's URL, which
            # `--config=quick` leaves for the push.
            tags = [_REPOSITORY_TAG] if checkout or "//:sources" in modules[test] else [],
            tests = [test],
            tools = needs.get("tools", {}),
            workspace = _WORKSPACE,
        )
        targets.append(":" + target)
    native.test_suite(name = name, tests = targets)

def type_checks(name, script):
    """`check:types` as one test per TypeScript project, `<name>/<its tsconfig.json>`.

    Each runs `script --project <tsconfig>` over a checkout of what that project's `tsc` reads
    (`TYPE_PROJECTS`), so it reruns only when one of those files changes.

    Args:
      name: a suite of every project's test.
      script: the module target of `scripts/check-types.ts`.
    """
    targets = []
    for project, inputs in TYPE_PROJECTS.items():
        # The whole path: a project's directory can hold another's (`apps/server/scripts`).
        target = "%s/%s" % (name, project)
        bun_test(
            name = target,
            args_ = ["run", "scripts/check-types.ts", "--project", project],
            data = [script, "//:test_node_modules"] + inputs,
            workspace = _WORKSPACE,
        )
        targets.append(":" + target)
    native.test_suite(name = name, tests = targets)

def slop_checks(name, script, data):
    """`check:slop` as one test per Bazel package, `<name>/<package>/BUILD.bazel`.

    Each runs `script --package <directory>` over a checkout of the package's own files and the
    gate's rules and baseline, so a package's findings are measured again only when one of its
    files, a rule or the baseline changes. The anti-slop rules read one file at a time.

    Args:
      name: a suite of every package's test.
      script: the module target of `scripts/check-slop.ts`.
      data: the rules, the baseline and the package list the gate reads.
    """
    targets = []
    for package in [""] + [label.removeprefix("//") for label in PACKAGES]:
        target = "%s/%sBUILD.bazel" % (name, package + "/" if package else "")
        bun_test(
            name = target,
            args_ = ["run", "scripts/check-slop.ts", "--package", package or "."],
            data = [script, "//%s:%s" % (package, "files" if package else "root_files")] +
                   data + ["//:test_node_modules"],
            git = True,
            workspace = _WORKSPACE,
        )
        targets.append(":" + target)
    native.test_suite(name = name, tests = targets)

def lint_checks(name, data):
    """`check:lint` as one test per Bazel package, `<name>/<package>/BUILD.bazel`.

    Each runs `biome check .` over a checkout of the package's own files and Biome's
    configuration, so a package is linted and format-checked again only when one of its files or
    the configuration changes. No rule the configuration enables reads more than one file.

    Args:
      name: a suite of every package's test.
      data: Biome's configuration and installed package.
    """
    targets = []
    for package in [""] + [label.removeprefix("//") for label in PACKAGES]:
        target = "%s/%sBUILD.bazel" % (name, package + "/" if package else "")
        bun_test(
            name = target,
            args_ = ["x", "biome", "check", "."],
            data = ["//%s:%s" % (package, "files" if package else "root_files")] + data,
            git = True,
            workspace = _WORKSPACE,
        )
        targets.append(":" + target)
    native.test_suite(name = name, tests = targets)

def scoped_check(name, script, data, args = [], **kwargs):
    """A gate's script over a checkout of what it reads: its own loads and `data`.

    For a gate that reads named parts of the repository, not the whole of it, so an edit
    elsewhere leaves its answer cached.

    Args:
      name: the test's name.
      script: the gate's module target, `//<package>:<path>.module`.
      data: the files the gate reads beyond what its script loads.
      args: the script's arguments.
      **kwargs: the common test attributes.
    """
    package, _, file = script.removeprefix("//").partition(":")
    path = "%s/%s" % (package, file.removesuffix(".module")) if package else file.removesuffix(".module")
    bun_test(
        name = name,
        args_ = ["run", path] + args,
        data = [script] + data,
        workspace = _WORKSPACE,
        **kwargs
    )

def repo_check(name, script, data = [], **kwargs):
    """`bun run <script>`, a `package.json` gate, over a checkout of the whole repository.

    The checkout, cloned from `//:checkout`, is a Git repository, so the gates see what Git
    ignores as a working tree does.

    Args:
      name: the test's name.
      script: the `package.json` script that is the gate, or the script file it runs.
      data: what the gate reads beyond the checkout, which joins it.
      **kwargs: the common test attributes.
    """
    bun_test(
        name = name,
        args_ = ["run", script],
        data = ["//:test_node_modules"] + data,
        links = SYMLINKS,
        snapshot = _SNAPSHOT,
        tags = kwargs.pop("tags", []) + [_REPOSITORY_TAG],
        workspace = _WORKSPACE,
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
        data = ["//:test_node_modules"],
        links = SYMLINKS,
        snapshot = _SNAPSHOT,
        workspace = _WORKSPACE,
        **kwargs
    )
