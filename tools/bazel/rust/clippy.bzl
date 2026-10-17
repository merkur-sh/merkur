"""Clippy over every first-party Rust target, the transitioned test targets included."""

load("@rules_rust//rust:defs.bzl", "rust_clippy_aspect")

# The provider of `--@rules_rust//rust/settings:clippy_flag`, which rules_rust keeps private.
load("@rules_rust//rust/private:clippy.bzl", "ClippyFlagsInfo")

_ClippyDiagnosticsInfo = provider(
    doc = "The Clippy JSON diagnostics of a target and of what it builds in another configuration.",
    fields = {"files": "depset of the `.clippy.diagnostics` files"},
)

def _clippy_diagnostics_impl(target, ctx):
    files = []
    if OutputGroupInfo in target and hasattr(target[OutputGroupInfo], "clippy_output"):
        files.append(target[OutputGroupInfo].clippy_output)

    # A `with_cfg` test builds its Rust target through `exports`, in the configuration that
    # turns on a dependency's test-only feature; its diagnostics are this target's.
    exported = getattr(ctx.rule.attr, "exports", None)
    if exported != None and _ClippyDiagnosticsInfo in exported:
        files.append(exported[_ClippyDiagnosticsInfo].files)
    merged = depset(transitive = files)
    return [
        _ClippyDiagnosticsInfo(files = merged),
        OutputGroupInfo(clippy_diagnostics = merged),
    ]

# Each package's `:clippy_diagnostics` report applies it to the package's Rust targets.
clippy_diagnostics = aspect(
    implementation = _clippy_diagnostics_impl,
    attr_aspects = ["exports"],
    requires = [rust_clippy_aspect],
)

def _clippy_report_impl(ctx):
    return [DefaultInfo(files = depset(transitive = [
        target[_ClippyDiagnosticsInfo].files
        for target in ctx.attr.targets
    ]))]

clippy_report = rule(
    implementation = _clippy_report_impl,
    doc = "The Clippy diagnostics of `targets`.",
    attrs = {"targets": attr.label_list(aspects = [clippy_diagnostics])},
)

_LINUX = Label("@platforms//os:linux")
_WASM32 = Label("@platforms//cpu:wasm32")

def _lint_targets_impl(name, visibility):
    everywhere = []
    linux = []
    for rule in native.existing_rules().values():
        tags = rule.get("tags", [])
        if not rule["kind"].startswith("rust_") or "noclippy" in tags or "manual" in tags:
            continue
        constraints = rule.get("target_compatible_with", [])
        # `existing_rules` hands a list attribute back as a tuple; a `select` it cannot judge.
        if type(constraints) not in ("list", "tuple"):
            fail("{}: a linted target's platforms must be a list, not {}".format(rule["name"], type(constraints)))
        constraints = [Label(constraint) for constraint in constraints]
        if not constraints:
            everywhere.append(":" + rule["name"])
        elif constraints == [_LINUX]:
            linux.append(":" + rule["name"])
        elif _WASM32 not in constraints:
            fail("{}: no lint rule for a target limited to {}".format(rule["name"], constraints))
    clippy_report(
        name = name,
        targets = everywhere + select({_LINUX: linux, "//conditions:default": []}),
        testonly = True,
        # The root manifest gathers every package's report.
        visibility = ["//visibility:public"],
    )

# Each package's `:clippy_diagnostics` (`package_files()` declares it): the diagnostics of the
# Rust targets `bazel build //...` builds on this platform. A finalizer sees every target the
# package declares. A wasm32 crate builds only in a WebAssembly build, which Clippy does not lint.
lint_targets = macro(implementation = _lint_targets_impl, finalizer = True)

def _short_path(file):
    return file.short_path

def _clippy_manifest_impl(ctx):
    files = depset(transitive = [report[DefaultInfo].files for report in ctx.attr.reports])
    manifest = ctx.actions.declare_file(ctx.label.name + ".txt")
    lines = ctx.actions.args()
    lines.set_param_file_format("multiline")
    lines.add_all(ctx.attr._clippy_flag[ClippyFlagsInfo].clippy_flags, format_each = "flag %s")
    lines.add_all(files, format_each = "file %s", map_each = _short_path)
    ctx.actions.write(manifest, lines)
    return [DefaultInfo(
        files = depset([manifest], transitive = [files]),
        runfiles = ctx.runfiles(files = [manifest], transitive_files = files),
    )]

# What `scripts/rust-lint.ts` reads: the flags Clippy ran with, one `flag` line each, and every
# report's diagnostics, one `file` line each by its path in the checkout.
clippy_manifest = rule(
    implementation = _clippy_manifest_impl,
    doc = "The Clippy flags and the diagnostics files of `reports`, as one manifest.",
    attrs = {
        "reports": attr.label_list(),
        "_clippy_flag": attr.label(default = "@rules_rust//rust/settings:clippy_flag"),
    },
)
