"""Manual original-SDK protocol captures; outputs do not qualify native execution."""

load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

_NATIVE_HOSTS = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
]

def _require_native_toolchain(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str != rust.target_triple.str or rust.exec_triple.str not in _NATIVE_HOSTS:
        fail("Protocol capture requires the pinned native Rust 1.97.1 execution toolchain")

def _capture_action(ctx, selection, selection_inputs, mnemonic):
    _require_native_toolchain(ctx)
    for source in [ctx.file.metadata, ctx.file.source_inputs, ctx.file.runtime_inputs]:
        if not source.is_source:
            fail("Protocol capture requires original metadata, source and runtime input SourceFiles")
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    output = ctx.actions.declare_directory(ctx.label.name)
    arguments = [
        "-I", "-B", ctx.file._generator.path,
        "--sdk-descriptor", sdk.descriptor.path,
        "--sdk-provenance", sdk.provenance.path,
        "--sdk-resolver", ctx.file._resolver.path,
        "--source-root", sdk.sources.path,
        "--unit-emitter", ctx.file._units.path,
        "--metadata", ctx.file.metadata.path,
        "--source-inputs", ctx.file.source_inputs.path,
        "--runtime-inputs", ctx.file.runtime_inputs.path,
        "--producer", str(sdk.provenance.owner),
        "--output", output.path,
        "--engine-precreated-tree-roots",
    ] + selection
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = arguments,
        inputs = depset([
            sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry,
            ctx.file._generator, ctx.file._resolver, ctx.file._units,
            ctx.file.metadata, ctx.file.source_inputs, ctx.file.runtime_inputs,
        ] + ctx.files._unit_helpers + ctx.files._selection_inputs + selection_inputs, transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output],
        env = {},
        use_default_shell_env = False,
        mnemonic = mnemonic,
    )
    return [DefaultInfo(files = depset([output]))]

def _native_capture_impl(ctx):
    return _capture_action(ctx, [
        "--capture",
        "--recipe-set", ctx.attr.recipe_set,
        "--contexts-helper", ctx.file._contexts.path,
    ], [ctx.file._contexts], "NativeProtocolCapture")

def _wasm_capture_impl(ctx):
    return _capture_action(ctx, ["--context", ctx.file.context.path], [ctx.file.context], "WasmProtocolCapture")

def _capture_attrs(generator, selection_inputs):
    return {
        "sdk": attr.label(mandatory = True, providers = [CargoAcquisitionSdkInfo]),
        "metadata": attr.label(mandatory = True, allow_single_file = True),
        "source_inputs": attr.label(mandatory = True, allow_single_file = True),
        "runtime_inputs": attr.label(mandatory = True, allow_single_file = True),
        "_generator": attr.label(default = generator, allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_units": attr.label(default = "//tools/bazel/rust:units.py", allow_single_file = True),
        "_unit_helpers": attr.label_list(default = [
            "//tools/bazel/rust:configured_parity.py",
            "//tools/bazel/rust:license_metadata.py",
            "//tools/bazel/rust:native_receipts.py",
            "//tools/bazel/rust:contexts.py",
        ], allow_files = True),
        "_selection_inputs": attr.label_list(default = selection_inputs, allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    }

_native_attrs = _capture_attrs("//tools/bazel/rust:native_protocol_generate.py", [
    "//tools/bazel/rust:contexts.py",
    "//tools/bazel/rust:native_oracle.py",
])
_native_attrs.update({
    "recipe_set": attr.string(mandatory = True, values = ["protocol", "tpm"]),
    "_contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
})
native_protocol_capture = rule(
    implementation = _native_capture_impl,
    attrs = _native_attrs,
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

_wasm_attrs = _capture_attrs("//tools/bazel/rust:protocol_wasm_generate.py", [])
_wasm_attrs.update({"context": attr.label(mandatory = True, allow_single_file = True)})
protocol_wasm_capture = rule(
    implementation = _wasm_capture_impl,
    attrs = _wasm_attrs,
    toolchains = ["@rules_rust//rust:toolchain_type"],
)


def _wasm_context_capture_impl(ctx):
    _require_native_toolchain(ctx)
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = [
            "-I", "-B", ctx.file._context_generator.path,
            "--sdk-descriptor", sdk.descriptor.path,
            "--sdk-provenance", sdk.provenance.path,
            "--sdk-resolver", ctx.file._resolver.path,
            "--source-root", sdk.sources.path,
            "--source-helper", ctx.file._source_helper.path,
            "--protocol-generator", ctx.file._protocol_generator.path,
            "--producer", str(sdk.provenance.owner),
            "--output", output.path,
        ],
        inputs = depset([
            sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry,
            ctx.file._context_generator, ctx.file._resolver,
            ctx.file._source_helper, ctx.file._protocol_generator, ctx.file._contexts,
        ], transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output],
        env = {},
        use_default_shell_env = False,
        mnemonic = "WasmProtocolContextCapture",
    )
    return [DefaultInfo(files = depset([output]))]

protocol_wasm_context_capture = rule(
    implementation = _wasm_context_capture_impl,
    attrs = {
        "sdk": attr.label(mandatory = True, providers = [CargoAcquisitionSdkInfo]),
        "_context_generator": attr.label(default = "//tools/bazel/rust:protocol_wasm_context.py", allow_single_file = True),
        "_source_helper": attr.label(default = "//tools/bazel/rust:native_protocol_generate.py", allow_single_file = True),
        "_protocol_generator": attr.label(default = "//tools/bazel/rust:protocol_wasm_generate.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)


def _wasm_context_controls_impl(ctx):
    _require_native_toolchain(ctx)
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    python = ctx.attr._python[DefaultInfo].files_to_run.executable
    # Same test-runfiles launcher contract as package_controls_test. Each argument
    # names its original declared File; context is the fresh capture action output.
    arguments = [
        "--producer", ctx.file._context_generator,
        "--generator", ctx.file._protocol_generator,
        "--source-helper", ctx.file._source_helper,
        "--context", ctx.file.context,
        "--source-root", sdk.sources,
        "--provenance", sdk.provenance,
        "--descriptor", sdk.descriptor,
        "--sdk-resolver", ctx.file._resolver,
    ]
    command = "#!/bin/sh\nset -eu\nr=${TEST_SRCDIR:?}\nexec \"$r/_main/%s\" -I -B \"$r/_main/%s\"" % (python.short_path, ctx.file._test.short_path)
    for index in range(0, len(arguments), 2):
        if arguments[index] == "--source-root":
            command += " --source-root \"%s\"" % arguments[index + 1].path
        else:
            command += " %s \"$r/_main/%s\"" % (arguments[index], arguments[index + 1].short_path)
    command += " \"$@\"\n"
    ctx.actions.write(executable, command, is_executable = True)
    files = [
        ctx.file._test, ctx.file._context_generator, ctx.file._protocol_generator,
        ctx.file._source_helper, ctx.file._contexts, ctx.file._resolver, ctx.file.context,
        sdk.descriptor, sdk.registry, sdk.sources, sdk.provenance, python,
    ]
    runfiles = ctx.runfiles(files = files, transitive_files = sdk.sdk_files)
    runfiles = runfiles.merge(ctx.attr._python[DefaultInfo].default_runfiles)
    runtime = runfiles
    runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [
        DefaultInfo(executable = executable, runfiles = runfiles),
        TestRuntimeInfo(runfiles = runtime),
    ]

protocol_wasm_context_controls_test = rule(
    implementation = _wasm_context_controls_impl,
    test = True,
    attrs = {
        "sdk": attr.label(mandatory = True, providers = [CargoAcquisitionSdkInfo]),
        "context": attr.label(mandatory = True, allow_single_file = True),
        "_test": attr.label(default = "//tools/bazel/rust:protocol_wasm_context_test.py", allow_single_file = True),
        "_context_generator": attr.label(default = "//tools/bazel/rust:protocol_wasm_context.py", allow_single_file = True),
        "_source_helper": attr.label(default = "//tools/bazel/rust:native_protocol_generate.py", allow_single_file = True),
        "_protocol_generator": attr.label(default = "//tools/bazel/rust:protocol_wasm_generate.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)
