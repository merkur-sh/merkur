"""Manual native stock regressions using original configured compiler Files."""
load("//tools/bazel/packaging:rust-link-map.bzl", "RustLinkMapInfo")
load("//tools/bazel/packaging:stdlib-native-graph.bzl", "stock_stdlib_native_graph")
load("//tools/bazel/rust:stdlib_attribution.bzl", "stdlib_source_attribution")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _file(file):
    if file.is_directory:
        fail("Original stock ordinary File required")
    return {"path": file.path, "label": str(file.owner)}

def _linked(ctx):
    linked = ctx.attr.compiler[RustLinkMapInfo]
    if linked.compiler != "1.97.1" or linked.target != ctx.attr.execution_host:
        fail("Original stock test requires matching native pinned Rust1.97.1 compiler")
    if linked.target not in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]:
        fail("Native stock target required")
    return linked

def _launcher(ctx, value, files, driver):
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    unique = {}
    for file in files:
        if file.path in unique and unique[file.path] != file:
            fail("Conflicting original stock File path")
        unique[file.path] = file
    ctx.actions.write(request, json.encode({"request": value, "carriers": [{"input": path, "runfile": _runfile(file)} for path, file in sorted(unique.items())]}))
    python = ctx.executable._python
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="${TEST_SRCDIR:?}"',
        'exec "$r/%s" -I -B "$r/%s" --request "$r/%s" --runfiles "$r"' % (_runfile(python), _runfile(driver), _runfile(request)),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = files + [request, python, driver] + ctx.files._helpers).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = executable, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))), TestRuntimeInfo(runfiles = runtime)]

def _controls_impl(ctx):
    linked = _linked(ctx)
    stdlib = sorted(linked.stdlib.to_list(), key = _path)
    value = {"producer": str(ctx.attr.compiler.label), "compiler": linked.compiler, "target": linked.target,
             "execution_host": linked.execution_host, "rustc": _file(linked.rustc),
             "artifact": _file(linked.artifact), "link_map": _file(linked.link_map),
             "stdlib": [_file(file) for file in stdlib], "source": _file(ctx.file.source_archive),
             "stdlib_archive": _file(ctx.file.stdlib_archive), "rustc_archive": _file(ctx.file.rustc_archive),
             "graph": _file(ctx.file.graph)}
    files = stdlib + [linked.rustc, linked.artifact, linked.link_map, ctx.file.source_archive, ctx.file.stdlib_archive, ctx.file.rustc_archive, ctx.file.graph]
    return _launcher(ctx, value, files, ctx.file._driver)

def _callback_impl(ctx):
    linked = _linked(ctx)
    inventory = ctx.attr.attribution[OutputGroupInfo].inventory.to_list()
    notices = ctx.attr.attribution[OutputGroupInfo].source_notices.to_list()
    if len(inventory) != 1 or inventory[0].is_directory or len(notices) != 1 or not notices[0].is_directory:
        fail("Exact original stock inventory and source-notices Tree required")
    stdlib = sorted(linked.stdlib.to_list(), key = _path)
    value = {"value": {"input": inventory[0].path, "label": str(inventory[0].owner), "notices": {"input": notices[0].path, "label": str(notices[0].owner)}},
             "artifact": _file(linked.artifact), "link_map": _file(linked.link_map), "rustc": _file(linked.rustc),
             "stdlib": [_file(file) for file in stdlib], "target": linked.target, "compiler": linked.compiler}
    return _launcher(ctx, value, stdlib + [linked.rustc, linked.artifact, linked.link_map, inventory[0], notices[0]], ctx.file._driver)

def _path(file):
    return file.path

def _attrs(driver):
    return {
        "compiler": attr.label(mandatory = True, providers = [RustLinkMapInfo]),
        "execution_host": attr.string(mandatory = True),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "_driver": attr.label(default = driver, allow_single_file = True),
        "_helpers": attr.label_list(default = [":stdlib_attribution.py", ":stdlib_attribution_test.py", ":stdlib_attribution_stock_test.py",
            "//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py",
            "//tools/bazel/packaging:stdlib-native-graph.py", "//tools/bazel/rust/acquire:sdk_producer.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    }

_control_attrs = _attrs(":stdlib_attribution_stock_test.py")
_control_attrs.update({
    "source_archive": attr.label(mandatory = True, allow_single_file = True),
    "stdlib_archive": attr.label(mandatory = True, allow_single_file = True),
    "rustc_archive": attr.label(mandatory = True, allow_single_file = True),
    "graph": attr.label(mandatory = True, allow_single_file = True),
})
stock_stdlib_controls_test = rule(implementation = _controls_impl, test = True, attrs = _control_attrs)
_callback_attrs = _attrs(":stdlib_attribution_stock_callback_test.py")
_callback_attrs.update({"attribution": attr.label(mandatory = True, providers = [OutputGroupInfo])})
stock_stdlib_callback_test = rule(implementation = _callback_impl, test = True, attrs = _callback_attrs)


def stdlib_attribution_tests(name, compiler, graph, source_archive, stdlib_archive, rustc_archive, execution_host, target_compatible_with):
    """Join same-action stock Files against a mandatory original native graph."""
    stdlib_source_attribution(
        name = name, compiler = compiler, source_archive = source_archive,
        stdlib_archive = stdlib_archive, rustc_archive = rustc_archive,
        graph = graph, target_compatible_with = target_compatible_with,
        tags = ["manual"],
    )
    stock_stdlib_controls_test(
        name = name + "_stock_test", compiler = compiler, execution_host = execution_host,
        source_archive = source_archive, stdlib_archive = stdlib_archive,
        rustc_archive = rustc_archive, graph = graph,
        target_compatible_with = target_compatible_with, tags = ["manual"],
    )
    stock_stdlib_callback_test(
        name = name + "_callback_test", compiler = compiler, execution_host = execution_host,
        attribution = ":" + name, target_compatible_with = target_compatible_with,
        tags = ["manual"],
    )


def stock_stdlib_attribution_tests(name, compiler, sdk, source, source_archive, stdlib_archive, rustc_archive, execution_host, target_compatible_with):
    """Original standalone stock fixture, including its own native graph."""
    stock_stdlib_native_graph(
        name = name + "_graph", sdk = sdk, producer = compiler, source = source,
        stdlib_archive = stdlib_archive, compiler_archive = rustc_archive,
        target_compatible_with = target_compatible_with,
        exec_compatible_with = target_compatible_with, tags = ["manual"],
    )
    stdlib_attribution_tests(
        name = name, compiler = compiler, graph = ":" + name + "_graph",
        source_archive = source_archive, stdlib_archive = stdlib_archive,
        rustc_archive = rustc_archive, execution_host = execution_host,
        target_compatible_with = target_compatible_with,
    )
