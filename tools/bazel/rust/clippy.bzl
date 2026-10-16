"""Clippy over every first-party Rust target, the transitioned test targets included."""

load("@rules_rust//rust:defs.bzl", "rust_clippy_aspect")

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

# `scripts/rust-lint.ts` builds every first-party target with this aspect and reads the
# `clippy_diagnostics` output group.
clippy_diagnostics = aspect(
    implementation = _clippy_diagnostics_impl,
    attr_aspects = ["exports"],
    requires = [rust_clippy_aspect],
)
