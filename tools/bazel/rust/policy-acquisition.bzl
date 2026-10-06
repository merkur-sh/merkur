"""Current policy acquisition and nonce-bound controls use the same typed SDK."""

load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _inputs(ctx):
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    files = [sdk.descriptor, sdk.registry, sdk.sources, sdk.provenance]
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    declarations = {file.path: _runfile(file) for file in depset(files, transitive = [sdk.sdk_files]).to_list()}
    ctx.actions.write(request, json.encode({
        "descriptor": sdk.descriptor.path,
        "registry": sdk.registry.path,
        "sources": sdk.sources.path,
        "provenance": sdk.provenance.path,
        "producer": str(sdk.descriptor.owner),
        "declarations": declarations,
    }))
    inputs = depset(files + [request, ctx.file._driver, ctx.file._policy, ctx.file._controls,
                             ctx.file._resolver, ctx.file._presentation, ctx.file._capture], transitive = [sdk.sdk_files])
    return request, inputs

def _arguments(ctx, request, mode):
    return ["-I", "-B", ctx.file._driver.path, "--mode", mode,
            "--request", request.path, "--policy", ctx.file._policy.path,
            "--controls", ctx.file._controls.path, "--sdk-resolver", ctx.file._resolver.path,
            "--presentation", ctx.file._presentation.path, "--capture", ctx.file._capture.path]

def _refresh_impl(ctx):
    request, inputs = _inputs(ctx)
    output = ctx.actions.declare_directory(ctx.label.name + ".policy")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = _arguments(ctx, request, "refresh") + ["--output", output.path, "--private-parent", output.dirname, "--engine-precreated-tree-root"],
        inputs = inputs,
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output],
        env = {},
        use_default_shell_env = False,
        execution_requirements = {"no-cache": "1", "no-remote": "1"},
        mnemonic = "MerkurCurrentDependencyPolicy",
    )
    return [DefaultInfo(files = depset([output]))]

def _test_impl(ctx):
    request, inputs = _inputs(ctx)
    python = ctx.executable._python
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -I -B "$r/%s" --mode controls --private-parent "$TEST_TMPDIR" --runfiles-root "$r" --request "$r/%s" --policy "$r/%s" --controls "$r/%s" --sdk-resolver "$r/%s" --presentation "$r/%s" --capture "$r/%s"' % (
            _runfile(python), _runfile(ctx.file._driver), _runfile(request), _runfile(ctx.file._policy),
            _runfile(ctx.file._controls), _runfile(ctx.file._resolver), _runfile(ctx.file._presentation), _runfile(ctx.file._capture),
        ),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = [python], transitive_files = inputs).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runtime),
            DefaultInfo(executable = launcher, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

def _attributes():
    return {
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True),
        "_driver": attr.label(default = "//tools/bazel/rust:policy-acquisition.py", allow_single_file = True),
        "_policy": attr.label(default = "//tools/bazel/rust:policy_snapshots.py", allow_single_file = True),
        "_controls": attr.label(default = "//tools/bazel/rust:policy_snapshots_test.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_presentation": attr.label(default = "//tools/bazel/rust/acquire:sdk_metadata.py", allow_single_file = True),
        "_capture": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    }

policy_acquisition = rule(implementation = _refresh_impl, attrs = _attributes())

_test_attributes = _attributes()
_test_attributes["_revocation_epochs"] = TEST_EPOCH_ATTRIBUTE
policy_acquisition_test = rule(implementation = _test_impl, test = True, attrs = _test_attributes)

def _transport_test_impl(ctx):
    python = ctx.executable._python
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="$TEST_SRCDIR"',
        'exec "$r/%s" -I -B "$r/%s" --runner "$r/%s" --capture "$r/%s" --presentation "$r/%s"' % (
            _runfile(python), _runfile(ctx.file._transport_controls), _runfile(ctx.file._driver),
            _runfile(ctx.file._capture), _runfile(ctx.file._presentation),
        ),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = [python, ctx.file._transport_controls, ctx.file._driver,
                                  ctx.file._capture, ctx.file._presentation]).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runtime),
            DefaultInfo(executable = launcher, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

policy_acquisition_transport_test = rule(
    implementation = _transport_test_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "_transport_controls": attr.label(default = "//tools/bazel/rust:policy-acquisition-test.py", allow_single_file = True),
        "_driver": attr.label(default = "//tools/bazel/rust:policy-acquisition.py", allow_single_file = True),
        "_presentation": attr.label(default = "//tools/bazel/rust/acquire:sdk_metadata.py", allow_single_file = True),
        "_capture": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
