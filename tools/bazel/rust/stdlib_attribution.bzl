"""Original source/license and same-action linked stdlib custody intermediate."""

load("//tools/bazel/packaging:rust-link-map.bzl", "RustLinkMapInfo")

def _file(file):
    if file.is_directory:
        fail("Stdlib attribution requires original regular Files")
    return {"path": file.path, "label": str(file.owner)}

def _impl(ctx):
    linked = ctx.attr.compiler[RustLinkMapInfo]
    if linked.compiler != "1.97.1" or linked.target not in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu", "wasm32-unknown-unknown"]:
        fail("Stdlib attribution requires pinned Rust1.97.1 native or wasm32 compiler")
    stdlib = linked.stdlib.to_list()
    if not stdlib:
        fail("Original linked compiler must expose its exact toolchain stdlib Files")
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    inventory = ctx.actions.declare_file(ctx.label.name + ".inventory.json")
    notices = ctx.actions.declare_directory(ctx.label.name + ".source-notices")
    ctx.actions.write(request, json.encode({
        "producer": str(ctx.attr.compiler.label),
        "compiler": linked.compiler,
        "target": linked.target,
        "execution_host": linked.execution_host,
        "rustc": _file(linked.rustc),
        "artifact": _file(linked.artifact),
        "link_map": _file(linked.link_map),
        "stdlib": [_file(file) for file in sorted(stdlib, key = _path)],
        "source": _file(ctx.file.source_archive),
        "stdlib_archive": _file(ctx.file.stdlib_archive),
        "rustc_archive": _file(ctx.file.rustc_archive),
        "graph": _file(ctx.file.graph),
    }))
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._runner.path, "--request", request.path,
                     "--inventory", inventory.path, "--notices", notices.path,
                     "--deployment-module", ctx.file._custody.path,
                     "--outputs-module", ctx.file._outputs.path,
                     "--graph-module", ctx.file._graph_module.path],
        inputs = depset([request, linked.rustc, linked.artifact, linked.link_map, ctx.file.source_archive,
                         ctx.file.stdlib_archive, ctx.file.rustc_archive, ctx.file.graph,
                         ctx.file._runner, ctx.file._custody, ctx.file._outputs,
                         ctx.file._graph_module] + ctx.files._custody_inputs,
                        transitive = [linked.stdlib]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [inventory, notices],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurLinkedStdlibSourceAttribution",
    )
    # No complete SelectedAttributionInfo is exposed by this source intermediate.
    return [DefaultInfo(files = depset([inventory, notices])),
            OutputGroupInfo(inventory = depset([inventory]), source_notices = depset([notices]),
                            native_inputs = depset([linked.rustc, linked.artifact, linked.link_map, ctx.file.source_archive,
                                                   ctx.file.stdlib_archive, ctx.file.rustc_archive, ctx.file.graph],
                                                  transitive = [linked.stdlib]))]

def _path(file):
    return file.path

stdlib_source_attribution = rule(
    implementation = _impl,
    attrs = {
        "compiler": attr.label(mandatory = True, providers = [RustLinkMapInfo]),
        "source_archive": attr.label(default = "@merkur_worker_compiler_source//file", allow_single_file = True),
        "stdlib_archive": attr.label(mandatory = True, allow_single_file = True),
        "rustc_archive": attr.label(mandatory = True, allow_single_file = True),
        "graph": attr.label(mandatory = True, allow_single_file = True),
        "_graph_module": attr.label(default = "//tools/bazel/packaging:stdlib-native-graph.py", allow_single_file = True),
        "_runner": attr.label(default = ":stdlib_attribution.py", allow_single_file = True),
        "_custody": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_custody_inputs": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
        "_outputs": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
