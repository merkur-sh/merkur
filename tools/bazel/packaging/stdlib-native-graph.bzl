"""Configured stock graph from the actual compile SDK; no mapper dependency cycle."""

load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo")
load("//tools/bazel/packaging:rust-link-map.bzl", "RustLinkMapInfo")
load("//tools/bazel/worker:prepare_compiler.bzl", "PreparedCompilerSourceInfo")

def stdlib_native_graph_action(ctx, sdk_target, native_target, source_target, stdlib_archive, compiler_archive, runner, resolver, graph, pair, python_target, sdk_materializer, sdk_capture):
    """Produce dependency relation evidence before the existing stock mapper.

    native_target supplies the original shipping compiler action's exact stock
    Files. Raw original distribution/source archives are mandatory action
    inputs. The runner verifies archive members and original compiler SVH
    pairing before publishing the graph consumed by the mapper. The same SDK's
    lock-only view retains its complete registry authority without depending on
    unrelated application source snapshot members.
    """
    sdk = sdk_target[CargoAcquisitionSdkInfo]
    native = native_target[RustLinkMapInfo]
    source = source_target[PreparedCompilerSourceInfo]
    source_root = source.source_tree
    source_archive = source.archive
    if native.compiler != "1.97.1" or not source_root.is_directory:
        fail("Stock dependency capture requires original Rust1.97.1 compiler and source Tree")
    for file in [source_archive, stdlib_archive, compiler_archive]:
        if file.is_directory:
            fail("Stock native dependency capture requires original regular archive Files")
    output = ctx.actions.declare_directory(ctx.label.name + ".native-stdlib-graph")
    graph_output = ctx.actions.declare_file(ctx.label.name + ".native-stdlib-graph.json")
    request = ctx.actions.declare_file(ctx.label.name + ".native-stdlib-request.json")
    ctx.actions.write(request, json.encode({
        "compiler": native.compiler,
        "target": native.target,
        "execution_host": native.execution_host,
        "stdlib": [{"path": file.path, "label": str(file.owner)} for file in native.stdlib.to_list()],
        "source_root": source_root.path + "/" + source.source_subdirectory,
        "source_archive": source_archive.path,
        "source_archive_label": str(source_archive.owner),
        "stdlib_archive": stdlib_archive.path,
        "compiler_archive": compiler_archive.path,
        "sdk": sdk.stock_descriptor.path,
        "sdk_provenance": sdk.stock_provenance.path,
        "sdk_sources": sdk.stock_sources.path,
        "sdk_registry": sdk.registry.path,
        "sdk_producer": str(sdk_target.label),
        "output": output.path + "/configured",
        "graph_output": graph_output.path,
    }))
    python = python_target[DefaultInfo].files_to_run
    if python.executable == None:
        fail("Stock dependency capture requires the declared Python executable")
    ctx.actions.run(
        executable = python,
        arguments = ["-B", "-I", runner.path, "--request", request.path,
                     "--sdk-resolver", resolver.path,
                     "--sdk-materializer", sdk_materializer.path, "--sdk-capture", sdk_capture.path,
                     "--graph-resolver", graph.path, "--pair-resolver", pair.path],
        inputs = depset([request, source_root, source_archive, stdlib_archive, compiler_archive,
                         runner, resolver, graph, pair, sdk_materializer, sdk_capture, sdk.stock_descriptor, sdk.registry, sdk.stock_sources, sdk.stock_provenance],
                        transitive = [sdk.sdk_files, native.stdlib]),
        tools = [python],
        outputs = [output, graph_output],
        env = {"PATH": ""},
        use_default_shell_env = False,
        mnemonic = "MerkurStockStdlibNativeGraph",
    )
    return struct(graph = graph_output, logs = output)


def _stdlib_native_graph_impl(ctx):
    output = stdlib_native_graph_action(
        ctx, ctx.attr.sdk, ctx.attr.producer, ctx.attr.source,
        ctx.file.stdlib_archive, ctx.file.compiler_archive,
        ctx.file._runner, ctx.file._resolver, ctx.file._graph, ctx.file._pair, ctx.attr._python, ctx.file._sdk_materializer, ctx.file._sdk_capture,
    )
    return [DefaultInfo(files = depset([output.graph])),
            OutputGroupInfo(graph = depset([output.graph]), qualification = depset([output.logs]))]

stock_stdlib_native_graph = rule(
    implementation = _stdlib_native_graph_impl,
    attrs = {
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True),
        "producer": attr.label(providers = [RustLinkMapInfo], mandatory = True),
        "source": attr.label(providers = [PreparedCompilerSourceInfo], mandatory = True),
        "stdlib_archive": attr.label(allow_single_file = True, mandatory = True),
        "compiler_archive": attr.label(allow_single_file = True, mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/packaging:stdlib-native-stock.py", allow_single_file = True),
        "_sdk_materializer": attr.label(default = "//tools/bazel/rust/acquire:sdk_metadata.py", allow_single_file = True),
        "_sdk_capture": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_graph": attr.label(default = "//tools/bazel/packaging:stdlib-native-graph.py", allow_single_file = True),
        "_pair": attr.label(default = "//tools/bazel/packaging:stdlib-native-pair.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
