"""Expose actual engine Artifact identities without reading their dynamic contents."""

EngineStatusInputsInfo = provider(fields = {
    "stable": "The engine's ctx.info_file Artifact.",
    "volatile": "The engine's ctx.version_file Artifact.",
    "descriptor": "Configured metadata output; serialized facts alone are not authority.",
})

def _file_identity(file):
    return {
        "path": file.path,
        "root": file.root.path,
        "owner": str(file.owner) if file.owner != None else None,
        "is_source": file.is_source,
        "is_directory": file.is_directory,
    }

def _engine_status_inputs_impl(ctx):
    stable = ctx.info_file
    volatile = ctx.version_file
    if stable == volatile or stable.is_source or volatile.is_source:
        fail("Engine workspace-status Artifacts must be distinct generated Files")
    if stable.is_directory or volatile.is_directory or stable.root != volatile.root:
        fail("Engine workspace-status Artifacts must share their regular output root")
    descriptor = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(descriptor, json.encode({
        "producer": str(ctx.label),
        "stable": _file_identity(stable),
        "volatile": _file_identity(volatile),
    }) + "\n")
    # FileWrite produces only the descriptor. The status Files retain their genuine
    # engine system producer; they are neither fabricated outputs nor content inputs.
    return [
        DefaultInfo(files = depset([descriptor])),
        OutputGroupInfo(descriptor = depset([descriptor])),
        EngineStatusInputsInfo(stable = stable, volatile = volatile, descriptor = descriptor),
    ]

engine_status_inputs = rule(implementation = _engine_status_inputs_impl)
