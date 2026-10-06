"""Ownership extraction is a declared action, with no checkout discovery."""

def _ownership_sources_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    args = ctx.actions.args()
    args.add(ctx.file.e2e)
    args.add(ctx.file.client)
    args.add(ctx.file.edge)
    args.add_all([output], expand_directories = False)
    args.add(ctx.attr.control)
    ctx.actions.run(
        executable = ctx.executable.extractor,
        arguments = [args],
        inputs = [ctx.file.e2e, ctx.file.client, ctx.file.edge],
        outputs = [output],
        mnemonic = "OwnershipAstExtraction",
        progress_message = "Extracting ownership predicates from production AST",
    )
    return [DefaultInfo(files = depset([output]))]

ownership_sources = rule(
    implementation = _ownership_sources_impl,
    attrs = {
        "extractor": attr.label(executable = True, cfg = "exec", mandatory = True),
        "e2e": attr.label(allow_single_file = [".rs"], mandatory = True),
        "client": attr.label(allow_single_file = [".rs"], mandatory = True),
        "edge": attr.label(allow_single_file = [".rs"], mandatory = True),
        "control": attr.string(default = "", values = ["", "custody", "route_guard", "retirement", "slot_drop", "stale_detach"]),
    },
)
