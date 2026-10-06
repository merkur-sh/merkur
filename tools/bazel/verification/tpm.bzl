"""Original software TPM fixture over immutable Bookworm and native Rust inputs."""

load("@rules_rust//rust:defs.bzl", "rust_common")
load("//tools/bazel/bun:rules.bzl", "bun_command_test")
load(":natlab.bzl", "NatlabImageInfo")
load(":natlab/debian.bzl", "DebianRootfsInfo")
load(":test-nonce.bzl", "TestRuntimeInfo")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _image_impl(ctx):
    original = ctx.attr.rootfs[DebianRootfsInfo]
    if original.target != "linux-" + ctx.attr.architecture or original.distribution != "bookworm":
        fail("TPM simulator requires original matching Bookworm runtime and swtpm closure")
    archive = ctx.actions.declare_file(ctx.label.name + ".docker.tar")
    identity = ctx.actions.declare_file(ctx.label.name + ".image-id")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._builder.path, original.rootfs.path, archive.path, identity.path, ctx.attr.architecture, "tpm"],
        inputs = [ctx.file._builder, original.rootfs],
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [archive, identity],
        mnemonic = "TpmRuntimeImage",
        use_default_shell_env = False,
        env = {},
    )
    return [DefaultInfo(files = depset([archive, identity])), NatlabImageInfo(archive = archive, identity = identity)]

tpm_runtime_image = rule(
    implementation = _image_impl,
    attrs = {
        "rootfs": attr.label(providers = [DebianRootfsInfo], mandatory = True),
        "architecture": attr.string(values = ["amd64", "arm64"], mandatory = True),
        "_builder": attr.label(default = "//tools/bazel/verification:natlab/image.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)

def _inputs_impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    crate = ctx.attr.harness[rust_common.crate_info]
    if rust.version != "1.97.1" or rust.exec_triple.str != rust.target_triple.str:
        fail("TPM tests require matching original native Rust execution and target")
    if not crate.is_test or crate.name != "merkur_identity_seal" or crate.output != ctx.executable.harness or crate.root.short_path != "packages/merkur-identity-seal/src/lib.rs":
        fail("TPM tests require the original identity-seal Lib harness")
    # CrateInfo has no feature field. Before starting Docker, the runtime checks
    # the original named test gated by #[cfg(all(test, feature = "tpm-sim"))].
    # A no-feature harness exposes no such test and is refused, never substituted.
    image = ctx.attr.image[NatlabImageInfo]
    request = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(request, json.encode({
        "image": _runfile(image.archive),
        "identity": _runfile(image.identity),
        "harness": _runfile(ctx.executable.harness),
        "target": rust.target_triple.str,
        "docker_host": ctx.attr.docker_host,
    }))
    runfiles = ctx.runfiles(files = [request, image.archive, image.identity, ctx.executable.harness]).merge(ctx.attr.harness[TestRuntimeInfo].runfiles)
    return [DefaultInfo(files = depset([request]), runfiles = runfiles)]

_tpm_inputs = rule(
    implementation = _inputs_impl,
    attrs = {
        "harness": attr.label(executable = True, cfg = "target", providers = [TestRuntimeInfo, rust_common.crate_info], mandatory = True),
        "image": attr.label(providers = [NatlabImageInfo], mandatory = True),
        "docker_host": attr.string(mandatory = True),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def tpm_simulator_test(name, harness, image, docker, docker_host, **kwargs):
    if not docker_host.startswith("unix:///"):
        fail("TPM fixture requires an explicit declared local Docker socket")
    inputs = name + "_inputs"
    _tpm_inputs(name = inputs, harness = harness, image = image, docker_host = docker_host, testonly = True, visibility = ["//visibility:private"])
    bun_command_test(
        name = name,
        entry_point = "//tools/bazel/verification:tpm-runtime.ts",
        data = ["//tools/bazel/verification:tpm-runtime.ts", "//tools/bazel/verification:real-helper.ts", "//tools/bazel/bun:owned-files.ts", "//scripts:test-tpm-sim.ts", ":" + inputs],
        tools = {docker: "docker"},
        tool_environment = {"docker": "MERKUR_TPM_DOCKER"},
        environment_files = {":" + inputs: "MERKUR_TPM_INPUTS"},
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        **kwargs
    )
