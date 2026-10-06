"""The original Cargo/Kani bounded parser and state harnesses, keyed by test revocation."""

load("//tools/bazel/rust:kani.bzl", "kani_native_environment")
load("//tools/bazel/rust:bounded-workspace.bzl", "BoundedWorkspaceInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")
load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")

_PROOFS = {
    "merkur-wire": ["proof_proto_frame", "proof_data_handshake"],
    "merkur-codec": ["proof_frame_header"],
    "merkur-client": ["proof_input_mapping", "proof_input_serial_order"],
    "merkur-e2e": ["proof_rebind_keeper_chain"],
}

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _bounded_impl(ctx):
    if ctx.attr.harness not in _PROOFS[ctx.attr.package]:
        fail("bounded Kani target must select an original registered package harness")
    toolchain = ctx.toolchains["//tools/bazel/rust:kani_toolchain_type"]
    workspace = ctx.attr.workspace[BoundedWorkspaceInfo]
    cc = kani_native_environment(ctx)
    native = ctx.actions.declare_file(ctx.label.name + ".native.json")
    configuration = dict(cc.configuration, anchor = native.path, workspace = workspace.tree.path, rustflags = workspace.rust_flags)
    ctx.actions.write(native, json.encode(configuration))
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -B -I "$r/%s" --helpers "$r/%s" --driver "$r/%s" --cargo "$r/%s" --native "$r/%s" --runfiles "$r" --lock "$r/%s" --production-lock "$r/%s" --package %s-fuzz --harness %s' % (
            _runfile(ctx.executable._python), _runfile(ctx.file._runner), _runfile(ctx.file._helpers),
            _runfile(toolchain.driver), _runfile(toolchain.cargo), _runfile(native),
            _runfile(workspace.lock), _runfile(ctx.file.production_lock), ctx.attr.package, ctx.attr.harness,
        ),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(
        files = [ctx.executable._python, ctx.file._runner, ctx.file._helpers, toolchain.driver, native, workspace.tree, workspace.manifest, workspace.lock, workspace.vendor_config, ctx.file.production_lock, toolchain.cargo],
        transitive_files = depset(transitive = [toolchain.files, cc.files, ctx.attr.workspace[DefaultInfo].files]),
    ).merge(ctx.attr._python[DefaultInfo].default_runfiles).merge(ctx.attr.workspace[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runtime), DefaultInfo(executable = executable, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

bounded_kani_test = rule(
    implementation = _bounded_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "workspace": attr.label(providers = [BoundedWorkspaceInfo], cfg = "exec", mandatory = True),
        "production_lock": attr.label(allow_single_file = True, mandatory = True),
        "package": attr.string(mandatory = True, values = _PROOFS.keys()),
        "harness": attr.string(mandatory = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/rust:bounded_kani_runner.py", allow_single_file = True),
        "_helpers": attr.label(default = "//tools/bazel/rust:kani_runner.py", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/rust:kani_toolchain_type"] + use_cc_toolchain(),
    fragments = ["cpp"],
)

def declare_bounded_kani_proofs(workspace, production_lock):
    tests = []
    for package, harnesses in _PROOFS.items():
        for harness in harnesses:
            name = "kani__" + harness
            bounded_kani_test(name = name, package = package, harness = harness, workspace = workspace, production_lock = production_lock, size = "large", timeout = "long", tags = ["manual"])
            tests.append(":" + name)
    native.test_suite(name = "bounded_kani_proofs", tests = tests, tags = ["manual"])
