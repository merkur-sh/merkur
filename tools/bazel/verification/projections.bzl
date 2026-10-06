"""Pass configured WASM projection File identities directly to static policy actions."""

load("//tools/bazel/wasm:rules.bzl", "WasmStaticProjectionInfo")

def _impl(ctx):
    descriptions = []
    files = []
    expected = ["//apps/web:e2e_wasm_static_sources", "//apps/web:graphics_wasm_static_sources", "//apps/web:term_wasm_static_sources", "//packages/e2e-wasm:wasm_static_sources"]
    if sorted([str(target.label).removeprefix("@@") for target in ctx.attr.projections]) != expected:
        fail("Static policies require the complete configured WASM projection inventory")
    for target in ctx.attr.projections:
        info = target[WasmStaticProjectionInfo]
        members = info.files.to_list()
        if len(members) != 4 or len(info.destinations) != 4:
            fail("WASM static projection must expose its exact four configured Files")
        descriptions.append({
            "producer": str(info.producer),
            "projection": str(target.label),
            "manifest": info.manifest.short_path,
            "files": [{"artifact": file.short_path, "destination": info.destinations[file]} for file in members],
        })
        files.extend(members + [info.manifest])
    descriptor = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(descriptor, json.encode(descriptions))
    return [
        DefaultInfo(files = depset(files + [descriptor])),
        OutputGroupInfo(descriptor = depset([descriptor])),
    ]

declared_static_projections = rule(
    implementation = _impl,
    attrs = {
        "projections": attr.label_list(mandatory = True, providers = [WasmStaticProjectionInfo]),
    },
)
