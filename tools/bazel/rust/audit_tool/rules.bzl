"""Native cargo-audit introspection consumes the existing original-archive SDK."""
load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo", "cargo_acquisition_sdk")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")
load(":data.bzl", "AUDIT_REGISTRY_ARCHIVES", "AUDIT_SOURCE_FILES")

_HOSTS = {
    "darwin_arm64": ("aarch64-apple-darwin", ["@platforms//os:macos", "@platforms//cpu:aarch64"]),
    "darwin_x64": ("x86_64-apple-darwin", ["@platforms//os:macos", "@platforms//cpu:x86_64"]),
    "linux_arm64": ("aarch64-unknown-linux-gnu", ["@platforms//os:linux", "@platforms//cpu:aarch64"]),
    "linux_x64": ("x86_64-unknown-linux-gnu", ["@platforms//os:linux", "@platforms//cpu:x86_64"]),
}

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _original_test_impl(ctx):
    sdk = ctx.attr._python[NativeSdkInfo]
    archive_paths = {}
    for target, identity in ctx.attr.archives.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or identity in archive_paths:
            fail("Original cargo-audit controls require unique ordinary archive Files")
        archive_paths[identity] = _runfile(files[0])
    registry_manifest = ctx.actions.declare_file(ctx.label.name + ".archives.json")
    # Runtime paths are relative to the runfiles root; no checkout discovery.
    ctx.actions.write(registry_manifest, json.encode(archive_paths))
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    files = {
        "archive": ctx.file.archive,
        "original": ctx.file._original,
        "generator": ctx.file._generator,
        "catalog": ctx.file._catalog,
        "declarations": ctx.file._declarations,
        "registry-manifest": registry_manifest,
    }
    arguments = " ".join(['--%s "$r/%s"' % (flag, _runfile(file)) for flag, file in files.items()])
    ctx.actions.write(launcher, "\n".join([
        "#!/bin/sh",
        "set -eu",
        'r="${RUNFILES_DIR:-$0.runfiles}"',
        'export PATH=/__no_ambient_path__',
        'export DYLD_LIBRARY_PATH="$r/%s/lib"' % sdk.prefix_runfile,
        'export DYLD_FALLBACK_LIBRARY_PATH=/__no_ambient_libraries__',
        'export LD_LIBRARY_PATH="$r/%s/lib"' % sdk.prefix_runfile,
        'cd "$r"',
        'exec "$r/%s" -B -I "$r/%s" %s' % (_runfile(sdk.binary), _runfile(ctx.file._checker), arguments),
        "",
    ]), is_executable = True)
    runtime = ctx.runfiles(files = [sdk.binary, ctx.file._checker] + files.values() + ctx.files.archives).merge(ctx.attr._python[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = launcher, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))), TestRuntimeInfo(runfiles = runtime)]

audit_original_test = rule(
    implementation = _original_test_impl,
    test = True,
    attrs = {
        "archive": attr.label(allow_single_file = True, mandatory = True),
        "archives": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "_checker": attr.label(default = "//tools/bazel/rust/audit_tool:controls.py", allow_single_file = True),
        "_original": attr.label(default = "//tools/bazel/rust/audit_tool:original.py", allow_single_file = True),
        "_generator": attr.label(default = "//tools/bazel/rust/audit_tool:generate.py", allow_single_file = True),
        "_catalog": attr.label(default = "//tools/bazel/rust/audit_tool:original.json", allow_single_file = True),
        "_declarations": attr.label(default = "//tools/bazel/rust/audit_tool:data.bzl", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec", providers = [NativeSdkInfo]),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)

def _context_impl(ctx):
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    files = {
        "source-archive": ctx.file.source_archive,
        "original": ctx.file.original,
        "capture": ctx.file._capture,
        "materializer": ctx.file._materializer,
        "sdk-resolver": ctx.file._resolver,
        "contexts": ctx.file._contexts,
        "parity": ctx.file._parity,
    }
    arguments = ["-B", "-I", ctx.file._runner.path,
                 "--descriptor", sdk.descriptor.path, "--provenance", sdk.provenance.path,
                 "--source-root", sdk.sources.path, "--registry", sdk.registry.path,
                 "--producer", str(ctx.attr.sdk.label), "--output", output.path]
    for flag, file in files.items():
        arguments.extend(["--" + flag, file.path])
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = arguments,
        inputs = depset([sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry, ctx.file._runner] + files.values(), transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output],
        env = {},
        use_default_shell_env = False,
        mnemonic = "CargoAuditCompilerContext",
    )
    return [DefaultInfo(files = depset([output]))]

cargo_audit_context = rule(
    implementation = _context_impl,
    attrs = {
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True),
        "source_archive": attr.label(allow_single_file = True, mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/rust/audit_tool:acquire.py", allow_single_file = True),
        "original": attr.label(allow_single_file = True, mandatory = True),
        "_capture": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_materializer": attr.label(default = "//tools/bazel/rust/acquire:sdk_metadata.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
        "_parity": attr.label(default = "//tools/bazel/rust:configured_parity.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)

def declare_audit_acquisition():
    audit_original_test(
        name = "original_controls_test",
        archive = "@merkur_cargo_audit_original//:original/cargo-audit-0.22.2.crate",
        archives = AUDIT_REGISTRY_ARCHIVES,
        tags = ["manual"],
    )
    for name, (host, constraints) in _HOSTS.items():
        cargo_acquisition_sdk(
            name = "sdk_" + name,
            execution_host = host,
            source_files = AUDIT_SOURCE_FILES,
            locks = ["Cargo.lock"],
            archives = AUDIT_REGISTRY_ARCHIVES,
            target_compatible_with = constraints,
            exec_compatible_with = constraints,
            tags = ["manual"],
        )
        cargo_audit_context(
            name = "context_" + name,
            sdk = ":sdk_" + name,
            source_archive = "@merkur_cargo_audit_original//:original/cargo-audit-0.22.2.crate",
            original = ":original.py",
            target_compatible_with = constraints,
            exec_compatible_with = constraints,
            tags = ["manual"],
        )
