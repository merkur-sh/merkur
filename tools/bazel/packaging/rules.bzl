"""Package only declared producer files; unsigned bytes never consume secrets."""

load("//tools/bazel/bun:rules.bzl", "BunCompileInfo", "BunConfigurationInfo")
load(":notices.bzl", "DeploymentNoticesInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _unsigned_contract(ctx, files):
    # The same declared ordinary outputs supply DefaultInfo and this contract.
    # This identifies available unsigned bytes, never full release qualification.
    descriptor = ctx.actions.declare_file(ctx.label.name + ".unsigned-contract.json")
    ctx.actions.write(descriptor, json.encode({
        "label": "//%s:%s" % (ctx.label.package, ctx.label.name),
        "group": "default",
        "outputs": [{"path": file.path, "destination": file.basename} for file in files],
    }))
    return depset([descriptor])

def _unsigned_impl(ctx):
    files = []
    spec_files = []
    for target, path in ctx.attr.files.items():
        outputs = target[DefaultInfo].files.to_list()
        if len(outputs) != 1 or outputs[0].is_directory:
            fail("Unsigned package requires a single declared regular file: " + str(target.label))
        files.append(outputs[0])
        spec_files.append({"path": path, "input": outputs[0].path, "label": str(target.label), "mode": "0555" if path in ctx.attr.executables else "0444"})
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    archive = ctx.actions.declare_file(ctx.label.name + ".tar.gz")
    manifest = ctx.actions.declare_file(ctx.label.name + ".signing-inputs.json")
    ctx.actions.write(spec, json.encode({"files": spec_files, "expected": ctx.attr.expected, "licenses": ctx.attr.licenses}))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", ctx.file._runner.path, spec.path, archive.path, manifest.path],
        inputs = files + [spec, ctx.file._runner],
        outputs = [archive, manifest],
        env = {"PYTHONHASHSEED": "0"},
        mnemonic = "UnsignedPackage",
        progress_message = "Inventory canonical unsigned bytes %{label}",
    )
    return [DefaultInfo(files = depset([archive, manifest]), runfiles = ctx.runfiles(files = [archive, manifest])),
            OutputGroupInfo(archive = depset([archive]), signing_inputs = depset([manifest]), unsigned_contract = _unsigned_contract(ctx, [archive, manifest]))]

unsigned_package = rule(
    implementation = _unsigned_impl,
    attrs = {
        "files": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "expected": attr.string_list(mandatory = True),
        "executables": attr.string_list(),
        "licenses": attr.string_list(mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/packaging:pack.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    },
)

def _one_output(target, directory):
    files = target[DefaultInfo].files.to_list()
    if len(files) != 1 or files[0].is_directory != directory:
        fail("Deployment requires one exact declared %s output: %s" % ("tree" if directory else "file", target.label))
    return files[0]

def _deployment_impl(ctx):
    server = ctx.attr._server[BunCompileInfo]
    binary = _one_output(ctx.attr._server, False)
    if binary != server.executable:
        fail("Deployment server must be its typed original compiler output")
    migrations = _one_output(ctx.attr._migrations, True)
    frontend = _one_output(ctx.attr._frontend, True)
    notices = ctx.attr._notices[DeploymentNoticesInfo]
    if notices.producers != {"server": binary, "migrations": migrations, "web": frontend}:
        fail("External NOTICES must belong to these exact configured deployment producers")
    evidence = ctx.files._license_evidence
    if not evidence:
        fail("Deployment requires explicit declared source license evidence")
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    archive = ctx.actions.declare_file(ctx.label.name + "/deployment.tar.gz")
    inventory = ctx.actions.declare_file(ctx.label.name + "/deployment.inputs.json")
    ctx.actions.write(spec, json.encode({
        "server": {"input": binary.path, "label": str(ctx.attr._server.label)},
        "server_context": {"input": server.configuration.path, "label": str(ctx.attr._server.label)},
        "migrations": {"input": migrations.path, "label": str(ctx.attr._migrations.label)},
        "web": {"input": frontend.path, "label": str(ctx.attr._frontend.label)},
        "build_id": ctx.attr._frontend_id[BunConfigurationInfo].value,
        "license_evidence": [{"input": file.path, "label": str(file.owner)} for file in evidence],
        "notices": {"inventory": {"input": notices.inventory.path, "label": str(notices.inventory.owner)}, "notices": {"input": notices.notices.path, "label": str(notices.notices.owner)}},
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", ctx.file._runner.path, spec.path, archive.path, inventory.path],
        inputs = [spec, binary, server.configuration, migrations, frontend, notices.inventory, notices.notices, ctx.file._runner, ctx.file._pack, ctx.file._notice_runner, ctx.file._closure, ctx.file._inputs] + evidence,
        outputs = [archive, inventory],
        env = {"PYTHONHASHSEED": "0"},
        mnemonic = "UnsignedDeployment",
        progress_message = "Archive declared unsigned deployment %{label}",
    )
    return [
        DefaultInfo(files = depset([archive, inventory])),
        OutputGroupInfo(archive = depset([archive]), signing_inputs = depset([inventory]), notices = depset([notices.notices]), attribution = depset([notices.inventory]), unsigned_contract = _unsigned_contract(ctx, [archive, inventory])),
    ]

unsigned_deployment = rule(
    implementation = _deployment_impl,
    attrs = {
        "_server": attr.label(default = "//apps/server:server", providers = [BunCompileInfo]),
        "_migrations": attr.label(default = "//apps/server:migrations"),
        "_frontend": attr.label(default = "//apps/web:frontend_precompressed"),
        "_frontend_id": attr.label(default = "//tools/bazel/bun:frontend_build_id", providers = [BunConfigurationInfo]),
        "_license_evidence": attr.label_list(default = ["//:LICENSE"], allow_files = True),
        "_notices": attr.label(default = "//tools/bazel/packaging:deployment_notices", providers = [DeploymentNoticesInfo]),
        "_runner": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_pack": attr.label(default = "//tools/bazel/packaging:pack.py", allow_single_file = True),
        "_notice_runner": attr.label(default = "//tools/bazel/packaging:deployment-notices.py", allow_single_file = True),
        "_closure": attr.label(default = "//tools/bazel/packaging:license-closure.py", allow_single_file = True),
        "_inputs": attr.label(default = "//tools/bazel/packaging:license-inputs.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    },
)

def _controls_impl(ctx):
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    python = ctx.attr._python[DefaultInfo].files_to_run.executable
    ctx.actions.write(executable, "#!/bin/sh\nset -eu\nr=${TEST_SRCDIR:?}\nexec \"$r/_main/%s\" -I \"$r/_main/%s\" \"$@\"\n" % (python.short_path, ctx.file.src.short_path), is_executable = True)
    runfiles = ctx.runfiles(files = [ctx.file.src, ctx.file.runner, python] + ctx.files.data)
    runfiles = runfiles.merge(ctx.attr._python[DefaultInfo].default_runfiles)
    runtime = runfiles
    runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [DefaultInfo(executable = executable, runfiles = runfiles), TestRuntimeInfo(runfiles = runtime)]

package_controls_test = rule(
    implementation = _controls_impl,
    test = True,
    attrs = {
        "src": attr.label(allow_single_file = True, mandatory = True),
        "runner": attr.label(default = "//tools/bazel/packaging:pack.py", allow_single_file = True),
        "data": attr.label_list(allow_files = True),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    },
)
