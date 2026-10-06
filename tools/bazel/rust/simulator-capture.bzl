"""Scoped original simulator context/declarations, sharing the acquired native SDK."""

load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo")
load("//tools/bazel/verification:native-tools.bzl", "NativeVerificationToolInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _capture_impl(ctx):
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str not in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"] or rust.target_triple.str != rust.exec_triple.str:
        fail("Simulator capture currently requires its original matching native Rust1.97.1 SDK")
    if ctx.attr.simulator_sources.label.repo_name != ctx.label.repo_name or ctx.attr.simulator_sources.label.package != "tools/sim" or ctx.attr.simulator_sources.label.name != "sources":
        fail("Simulator capture requires the complete original tools/sim:sources inventory")
    for file in ctx.files.simulator_sources:
        if not file.is_source or sdk.original_sources.get(file.short_path) != file:
            fail("Simulator original SourceFile is missing from the typed SDK: " + file.short_path)
    biome = ctx.attr._biome[NativeVerificationToolInfo]
    if biome.member != "biome":
        fail("Simulator graph formatting requires the declared native Biome member")
    output = ctx.actions.declare_directory(ctx.label.name)
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = [
            "-B", "-I", ctx.file._generator.path,
            "--sdk-descriptor", sdk.descriptor.path,
            "--sdk-provenance", sdk.provenance.path,
            "--sdk-resolver", ctx.file._resolver.path,
            "--source-root", sdk.sources.path,
            "--contexts-helper", ctx.file._contexts.path,
            "--unit-emitter", ctx.file._units.path,
            "--native-helper", ctx.file._native_helper.path,
            "--metadata", ctx.file.metadata.path,
            "--source-inputs", ctx.file.source_inputs.path,
            "--runtime-inputs", ctx.file.runtime_inputs.path,
            "--biome", biome.package.path + "/" + biome.member,
            "--biome-config", ctx.file._biome_config.path,
            "--producer", str(sdk.descriptor.owner),
            "--output", output.path, "--engine-precreated-tree-roots",
        ],
        inputs = depset([
            sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry,
            biome.package,
            ctx.file._generator, ctx.file._resolver, ctx.file._contexts,
            ctx.file._units, ctx.file._native_helper, ctx.file.metadata,
            ctx.file.source_inputs, ctx.file.runtime_inputs, ctx.file._biome_config,
        ] + ctx.files._unit_helpers + ctx.files.simulator_sources, transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run, ctx.attr._biome[DefaultInfo].files_to_run],
        outputs = [output],
        env = {},
        use_default_shell_env = False,
        mnemonic = "CaptureOriginalSimulator",
    )
    return [DefaultInfo(files = depset([output]))]

simulator_capture = rule(
    implementation = _capture_impl,
    toolchains = ["@rules_rust//rust:toolchain_type"],
    attrs = {
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True, cfg = "exec"),
        "metadata": attr.label(allow_single_file = True, mandatory = True),
        "source_inputs": attr.label(allow_single_file = True, mandatory = True),
        "runtime_inputs": attr.label(allow_single_file = True, mandatory = True),
        "simulator_sources": attr.label(mandatory = True),
        "_generator": attr.label(allow_single_file = True, default = "//tools/bazel/rust:simulator_generate.py"),
        "_resolver": attr.label(allow_single_file = True, default = "//tools/bazel/rust:acquisition_sdk.py"),
        "_contexts": attr.label(allow_single_file = True, default = "//tools/bazel/rust:contexts.py"),
        "_units": attr.label(allow_single_file = True, default = "//tools/bazel/rust:units.py"),
        "_native_helper": attr.label(allow_single_file = True, default = "//tools/bazel/rust:native_protocol_generate.py"),
        "_unit_helpers": attr.label_list(allow_files = True, default = ["//tools/bazel/rust:configured_parity.py", "//tools/bazel/rust:license_metadata.py", "//tools/bazel/rust:native_receipts.py"]),
        "_biome": attr.label(executable = True, providers = [NativeVerificationToolInfo], cfg = "exec", default = "//tools/bazel/verification:biome"),
        "_biome_config": attr.label(allow_single_file = True, default = "//:biome.json"),
        "_python": attr.label(executable = True, cfg = "exec", default = "//tools/bazel/tools/native:python3"),
    },
)

def declare_simulator_captures(name, sdk, simulator_sources, metadata, source_inputs, runtime_inputs, tags = []):
    """One original capture per native execution platform; selection does not configure exec constraints."""
    hosts = {
        "darwin_arm64": ["@platforms//os:osx", "@platforms//cpu:aarch64"],
        "darwin_x64": ["@platforms//os:osx", "@platforms//cpu:x86_64"],
        "linux_arm64": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
        "linux_x64": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
    }
    selected = {}
    compatibility = {}
    for host, constraints in hosts.items():
        target = name + "_" + host
        simulator_capture(
            name = target,
            sdk = sdk,
            simulator_sources = simulator_sources,
            metadata = metadata,
            source_inputs = source_inputs,
            runtime_inputs = runtime_inputs,
            target_compatible_with = constraints,
            exec_compatible_with = constraints,
            tags = tags,
        )
        selector = "//tools/bazel/rust/acquire:workspace_sdk_host_" + host
        selected[selector] = ":" + target
        compatibility[selector] = []
    selected["//conditions:default"] = ":" + name + "_darwin_arm64"
    compatibility["//conditions:default"] = ["@platforms//:incompatible"]
    native.alias(
        name = name,
        actual = select(selected),
        target_compatible_with = select(compatibility),
        tags = tags,
    )

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _controls_impl(ctx):
    python = ctx.executable._python
    biome = ctx.attr._biome[NativeVerificationToolInfo]
    if biome.member != "biome":
        fail("Simulator controls require the declared native Biome member")
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(script, """#!/bin/sh
set -eu
r="${TEST_SRCDIR:?}"
exec "$r/%s" -B -I "$r/%s" --unit-emitter "$r/%s" --unit-helpers "$r/%s" --contexts-helper "$r/%s" --biome "$r/%s/%s" --biome-config "$r/%s" --bun-rules "$r/%s"
""" % (_runfile(python), _runfile(ctx.file.controls), _runfile(ctx.file._units), _runfile(ctx.file._units).rsplit("/", 1)[0], _runfile(ctx.file._contexts), _runfile(biome.package), biome.member, _runfile(ctx.file._biome_config), _runfile(ctx.file._bun_rules)), is_executable = True)
    runtime = ctx.runfiles(files = [python, ctx.file.controls, ctx.file._generator, ctx.file._units, ctx.file._native_helper, ctx.file._definition, ctx.file._targets_factory, ctx.file._bun_rules, ctx.file._resolver, ctx.file._contexts, ctx.file._biome_config] + ctx.files._unit_helpers, transitive_files = ctx.attr._python[DefaultInfo].files)
    runtime = runtime.merge(ctx.attr._python[DefaultInfo].default_runfiles)
    runtime = runtime.merge(ctx.attr._biome[DefaultInfo].default_runfiles)
    return [
        TestRuntimeInfo(runfiles = runtime),
        DefaultInfo(executable = script, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
    ]

simulator_generation_test = rule(
    implementation = _controls_impl,
    test = True,
    attrs = {
        "controls": attr.label(allow_single_file = True, default = "//tools/bazel/rust:simulator_generate_test.py"),
        "_generator": attr.label(allow_single_file = True, default = "//tools/bazel/rust:simulator_generate.py"),
        "_definition": attr.label(allow_single_file = True, default = "//tools/bazel/rust:simulator-capture.bzl"),
        "_targets_factory": attr.label(allow_single_file = True, default = "//tools/sim:sim_targets.bzl"),
        "_bun_rules": attr.label(allow_single_file = True, default = "//tools/bazel/bun:rules.bzl"),
        "_resolver": attr.label(allow_single_file = True, default = "//tools/bazel/rust:acquisition_sdk.py"),
        "_contexts": attr.label(allow_single_file = True, default = "//tools/bazel/rust:contexts.py"),
        "_units": attr.label(allow_single_file = True, default = "//tools/bazel/rust:units.py"),
        "_native_helper": attr.label(allow_single_file = True, default = "//tools/bazel/rust:native_protocol_generate.py"),
        "_unit_helpers": attr.label_list(allow_files = True, default = ["//tools/bazel/rust:configured_parity.py", "//tools/bazel/rust:license_metadata.py", "//tools/bazel/rust:native_receipts.py"]),
        "_biome": attr.label(executable = True, providers = [NativeVerificationToolInfo], cfg = "exec", default = "//tools/bazel/verification:biome"),
        "_biome_config": attr.label(allow_single_file = True, default = "//:biome.json"),
        "_python": attr.label(executable = True, cfg = "exec", default = "//tools/bazel/tools:python3"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)
