"""Original real-helper fixture through the shared declared Bun materializer."""

load("@rules_rust//rust:defs.bzl", "rust_common")
load("//tools/bazel/bun:rules.bzl", "bun_command_test")
load(":test-nonce.bzl", "TestRuntimeInfo")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _inputs_impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str != rust.target_triple.str:
        fail("Real helper tests require a native Rust target and execution toolchain")
    harness = ctx.executable.dataplane_test
    worker = ctx.executable.image_worker
    test_crate = ctx.attr.dataplane_test[rust_common.crate_info]
    helper_crate = ctx.attr.image_worker[rust_common.crate_info]
    if not test_crate.is_test or test_crate.name != "merkur_dataplane" or test_crate.output != harness or test_crate.root.short_path != ctx.attr.dataplane_root:
        fail("Real helper tests require the original compiled dataplane libtest executable")
    if helper_crate.is_test or helper_crate.name != "merkur_image_worker" or helper_crate.type != "bin" or helper_crate.output != worker or helper_crate.root.short_path != "packages/merkur-image-worker/src/main.rs":
        fail("Real helper tests require the original compiled image-worker executable")
    request = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(request, json.encode({
        "harness": _runfile(harness),
        "worker": _runfile(worker),
        "target": rust.target_triple.str,
    }))
    runtime = ctx.runfiles(files = [request, harness, worker])
    # Preserve the original raw Rust test fixture before its own nonce. Only
    # the outer bun_command_test adds the selected real-helper test epoch.
    runtime = runtime.merge(ctx.attr.dataplane_test[TestRuntimeInfo].runfiles)
    runtime = runtime.merge(ctx.attr.image_worker[DefaultInfo].default_runfiles)
    return [DefaultInfo(files = depset([request]), runfiles = runtime), TestRuntimeInfo(runfiles = runtime)]

native_graphics_inputs = rule(
    implementation = _inputs_impl,
    attrs = {
        "dataplane_test": attr.label(mandatory = True, executable = True, cfg = "target", providers = [TestRuntimeInfo, rust_common.crate_info]),
        "image_worker": attr.label(mandatory = True, executable = True, cfg = "target", providers = [rust_common.crate_info]),
        "dataplane_root": attr.string(default = "apps/daemon/dataplane/src/main.rs", values = ["apps/daemon/dataplane/src/main.rs", "apps/daemon/dataplane/src/lib.rs"]),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def real_helper_test(name, dataplane_test, image_worker, **kwargs):
    """Copy the exact declared TS closure before executing the original fixture."""
    inputs = name + "_inputs"
    native_graphics_inputs(
        name = inputs,
        dataplane_test = dataplane_test,
        dataplane_root = "apps/daemon/dataplane/src/lib.rs",
        image_worker = image_worker,
        testonly = True,
        visibility = ["//visibility:private"],
    )
    bun_command_test(
        name = name,
        entry_point = "//tools/bazel/verification:real-helper.ts",
        data = ["//tools/bazel/verification:real-helper.ts", "//tools/bazel/bun:owned-files.ts", ":" + inputs],
        environment_files = {":" + inputs: "MERKUR_REAL_HELPER_INPUTS"},
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        **kwargs
    )
