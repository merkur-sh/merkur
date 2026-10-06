"""Original privileged Linux NAT lab over declared binaries and immutable image bytes."""

load("@rules_rust//rust:defs.bzl", "rust_common")

load(":test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")
load(":natlab/debian.bzl", "DebianRootfsInfo")

NatlabImageInfo = provider(fields = {"archive": "Docker-load image archive", "identity": "Image configuration digest File"})

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _image_impl(ctx):
    runtime = ctx.attr.rootfs[DebianRootfsInfo]
    if runtime.target != "linux-" + ctx.attr.architecture or runtime.distribution != "trixie":
        fail("Natlab image requires its original matching native Trixie runtime")
    archive = ctx.actions.declare_file(ctx.label.name + ".docker.tar")
    identity = ctx.actions.declare_file(ctx.label.name + ".image-id")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._builder.path, runtime.rootfs.path, archive.path, identity.path, ctx.attr.architecture],
        inputs = [ctx.file._builder, runtime.rootfs],
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [archive, identity],
        mnemonic = "NatlabRuntimeImage",
        use_default_shell_env = False,
        env = {},
    )
    return [DefaultInfo(files = depset([archive, identity])), NatlabImageInfo(archive = archive, identity = identity)]

natlab_runtime_image = rule(
    implementation = _image_impl,
    attrs = {
        "rootfs": attr.label(providers = [DebianRootfsInfo], mandatory = True),
        "architecture": attr.string(values = ["amd64", "arm64"], mandatory = True),
        "_builder": attr.label(default = "//tools/bazel/verification:natlab/image.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)

def _test_impl(ctx):
    crate = ctx.attr.dataplane[rust_common.crate_info]
    if not crate.is_test or crate.name != "merkur_dataplane" or crate.root.short_path != "apps/daemon/dataplane/src/lib.rs" or crate.output != ctx.executable.dataplane:
        fail("Natlab discovery requires the original compiled dataplane library test binary")
    image = ctx.attr.runtime_image[NatlabImageInfo]
    scripts = [ctx.file.lab, ctx.file.discovery, ctx.file.portmap]
    descriptor = ctx.actions.declare_file(ctx.label.name + ".natlab.json")
    ctx.actions.write(descriptor, json.encode({
        "image": _runfile(image.archive),
        "identity": _runfile(image.identity),
        "docker": _runfile(ctx.executable.docker),
        "docker_host": ctx.attr.docker_host,
        "stun": _runfile(ctx.executable.stun),
        "dataplane": _runfile(ctx.executable.dataplane),
        "scripts": [_runfile(file) for file in scripts],
    }))
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -I -B "$r/%s" "$r/%s" "$r"' % (_runfile(ctx.executable._python), _runfile(ctx.file._runner), _runfile(descriptor)),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = scripts + [descriptor, image.archive, image.identity, ctx.executable.docker, ctx.executable.stun, ctx.executable.dataplane, ctx.executable._python, ctx.file._runner])
    for target in [ctx.attr.docker, ctx.attr.stun, ctx.attr._python]:
        runtime = runtime.merge(target[DefaultInfo].default_runfiles)
    runtime = runtime.merge(ctx.attr.dataplane[TestRuntimeInfo].runfiles)
    return [TestRuntimeInfo(runfiles = runtime), DefaultInfo(executable = executable, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

_natlab_test = rule(
    implementation = _test_impl,
    test = True,
    attrs = {
        "runtime_image": attr.label(providers = [NatlabImageInfo], mandatory = True),
        "docker": attr.label(executable = True, cfg = "exec", mandatory = True),
        "docker_host": attr.string(mandatory = True),
        "stun": attr.label(executable = True, cfg = "target", mandatory = True),
        "dataplane": attr.label(executable = True, cfg = "target", providers = [TestRuntimeInfo, rust_common.crate_info], mandatory = True),
        "lab": attr.label(allow_single_file = [".sh"], mandatory = True),
        "discovery": attr.label(allow_single_file = [".sh"], mandatory = True),
        "portmap": attr.label(allow_single_file = [".sh"], mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/verification:natlab/runner.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)

def natlab_test(name, tags = [], **kwargs):
    # A real kernel/privileged daemon is a live external fixture. Neither ambient
    # engine results nor hosted execution qualification can discharge it.
    _natlab_test(
        name = name,
        tags = tags + ["manual", "external", "no-cache", "no-remote", "local"],
        timeout = "long",
        **kwargs
    )

def _controls_impl(ctx):
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(script, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -I -B "$r/%s" "$r/%s" "$r/%s" "$r/%s"' % (_runfile(ctx.executable._python), _runfile(ctx.file._controls), _runfile(ctx.file._declaration), _runfile(ctx.file._caller), _runfile(ctx.file._bindings)),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = [ctx.executable._python, ctx.file._controls, ctx.file._image, ctx.file._runner, ctx.file._rootfs, ctx.file._declaration, ctx.file._caller, ctx.file._bindings]).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runtime), DefaultInfo(executable = script, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

natlab_controls_test = rule(
    implementation = _controls_impl,
    test = True,
    attrs = {
        "_bindings": attr.label(default = "//tools/bazel/rust/native_protocol:roots.bzl", allow_single_file = True),
        "_caller": attr.label(default = "//tools/bazel/verification:natlab/qualified-targets.bzl", allow_single_file = True),
        "_declaration": attr.label(default = "//tools/bazel/verification:natlab.bzl", allow_single_file = True),
        "_controls": attr.label(default = "//tools/bazel/verification:natlab/controls.py", allow_single_file = True),
        "_image": attr.label(default = "//tools/bazel/verification:natlab/image.py", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/verification:natlab/runner.py", allow_single_file = True),
        "_rootfs": attr.label(default = "//tools/bazel/verification:natlab/rootfs.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)
