"""Concrete original runtime producers; live qualification remains a separate test."""

load("@debian_natlab_amd64//:defs.bzl", natlab_amd64_rootfs = "define_rootfs")
load("@debian_natlab_arm64//:defs.bzl", natlab_arm64_rootfs = "define_rootfs")
load("@debian_edge_amd64//:defs.bzl", edge_amd64_rootfs = "define_rootfs")
load("@debian_edge_arm64//:defs.bzl", edge_arm64_rootfs = "define_rootfs")
load("@debian_stun_amd64//:defs.bzl", stun_amd64_rootfs = "define_rootfs")
load("@debian_stun_arm64//:defs.bzl", stun_arm64_rootfs = "define_rootfs")
load("//tools/bazel/rust/native_protocol:roots.bzl", "NATIVE_PROTOCOL_BINDINGS")
load("//tools/bazel/verification:natlab.bzl", "natlab_runtime_image", "natlab_test")
load("//tools/bazel/verification:natlab/debian.bzl", "DebianRootfsInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

_FACTORIES = {
    "natlab_amd64": natlab_amd64_rootfs,
    "natlab_arm64": natlab_arm64_rootfs,
    "edge_amd64": edge_amd64_rootfs,
    "edge_arm64": edge_arm64_rootfs,
    "stun_amd64": stun_amd64_rootfs,
    "stun_arm64": stun_arm64_rootfs,
}

def debian_runtime_targets(name, **kwargs):
    """Create all six source producers, runnable without executing Linux utilities."""
    for profile, factory in _FACTORIES.items():
        factory(name = name + "_" + profile, **kwargs)

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _source_controls_impl(ctx):
    runtime = ctx.attr.runtime[DebianRootfsInfo]
    if runtime.target != "linux-" + ctx.attr.architecture or runtime.distribution != "trixie":
        fail("Natlab source controls require the original matching native Trixie runtime")
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(script, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -I -B "$r/%s" "$r/%s" %s' % (
            _runfile(ctx.executable._python), _runfile(ctx.file._controls),
            _runfile(runtime.rootfs), ctx.attr.architecture,
        ),
        "",
    ]), is_executable = True)
    runfiles = ctx.runfiles(files = [ctx.executable._python, ctx.file._controls, runtime.rootfs]).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = script, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

natlab_source_controls_test = rule(
    implementation = _source_controls_impl,
    test = True,
    attrs = {
        "runtime": attr.label(providers = [DebianRootfsInfo], mandatory = True),
        "architecture": attr.string(values = ["amd64", "arm64"], mandatory = True),
        "_controls": attr.label(default = "//tools/bazel/verification:natlab/source-controls.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)

def natlab_runtime_targets(name, runtimes):
    """Create source images/controls before native compiler or Docker qualification."""
    for architecture in ["amd64", "arm64"]:
        runtime = ":" + runtimes + "_natlab_" + architecture
        natlab_runtime_image(name = name + "_image_" + architecture, rootfs = runtime, architecture = architecture)
        natlab_source_controls_test(
            name = name + "_source_controls_" + architecture,
            runtime = runtime,
            architecture = architecture,
        )

def natlab_qualified_targets(name, runtime_images, stun, docker_host):
    """Bind the captured library harness to both original privileged Linux labs.

    runtime_images names an existing natlab_runtime_targets family. Each real
    Rust dependency remains subject to its configured platform constraints;
    a Darwin-only capture cannot provide either Linux lab's required harness.
    """
    if not docker_host.startswith("unix:///"):
        fail("Natlab requires an explicit local Docker Unix socket")
    for architecture, cpu in [("amd64", "x86_64"), ("arm64", "aarch64")]:
        natlab_test(
            name = name + "_" + architecture,
            runtime_image = ":" + runtime_images + "_image_" + architecture,
            docker = "@docker_cli_" + architecture + "//:docker",
            docker_host = docker_host,
            stun = stun,
            dataplane = NATIVE_PROTOCOL_BINDINGS["dataplane_lib"],
            lab = "//scripts:natlab/lab.sh",
            discovery = "//scripts:natlab/discovery.sh",
            portmap = "//scripts:natlab/portmap.sh",
            target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:" + cpu],
        )
