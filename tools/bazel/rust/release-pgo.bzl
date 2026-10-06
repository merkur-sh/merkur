"""Native release-library training with the selected Rust compiler's LLVM tools."""

load("@rules_rust//rust:rust_common.bzl", "rust_common")
load("//tools/bazel/verification:test-nonce.bzl", "TestRuntimeInfo")
load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo")

def _runtime_records(runtime):
    records = {}
    for file in runtime.files.to_list():
        logical = "external/" + file.short_path[3:] if file.short_path.startswith("../") else file.short_path
        records[logical] = file.path
    for entry in runtime.symlinks.to_list():
        if entry.path in records and records[entry.path] != entry.target_file.path:
            fail("Release PGO runtime has conflicting original File placements")
        records[entry.path] = entry.target_file.path
    if runtime.root_symlinks.to_list():
        fail("Release PGO requires the original workspace-relative runtime placements")
    return [{"logical": logical, "path": records[logical]} for logical in sorted(records)]

def _profile_impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str != ctx.attr.target or rust.target_triple.str != ctx.attr.target:
        fail("Release PGO training requires its matching native Rust1.97.1 compiler")
    if rust.llvm_profdata == None:
        fail("Release PGO requires llvm-profdata from that same Rust toolchain")
    crate = ctx.attr.instrumented_library[rust_common.crate_info]
    if not crate.is_test or crate.name != "merkur_dataplane" or crate.root.short_path != "apps/daemon/dataplane/src/lib.rs" or crate.output != ctx.executable.instrumented_library:
        fail("Release PGO must execute the original dataplane library test harness")
    runtime = ctx.attr.instrumented_library[TestRuntimeInfo].runfiles
    output = ctx.actions.declare_file(ctx.label.name + ".profdata")
    raw = ctx.actions.declare_directory(ctx.label.name + ".profraw")
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    ctx.actions.write(request, json.encode({
        "binary": crate.output.path,
        "rustc": rust.rustc.path,
        "profdata": rust.llvm_profdata.path,
        "target": ctx.attr.target,
        "runtime": _runtime_records(runtime),
        "output": output.path,
        "raw_output": raw.path,
    }))
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._runner.path, "--request", request.path],
        inputs = depset([request, ctx.file._runner, ctx.file.release_script, crate.output, rust.rustc, rust.llvm_profdata] + [entry.target_file for entry in runtime.symlinks.to_list()], transitive = [runtime.files, rust.rustc_lib, depset(rust.llvm_lib)]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output, raw],
        env = {},
        use_default_shell_env = False,
        mnemonic = "TrainDataplaneReleasePgo",
        progress_message = "Train original native dataplane library release workloads %{label}",
    )
    return [DefaultInfo(files = depset([output])), OutputGroupInfo(raw_profile = depset([raw]))]

dataplane_release_profile = rule(
    implementation = _profile_impl,
    attrs = {
        "instrumented_library": attr.label(executable = True, cfg = "target", providers = [rust_common.crate_info, TestRuntimeInfo], mandatory = True),
        "target": attr.string(mandatory = True, values = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]),
        "release_script": attr.label(allow_single_file = [".ts"], default = "//scripts:build-daemon-artifacts.ts"),
        "_runner": attr.label(allow_single_file = True, default = "//tools/bazel/rust:release_pgo_train.py"),
        "_python": attr.label(executable = True, cfg = "exec", default = "//tools/bazel/tools/native:python3"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def _capture_impl(ctx):
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str != rust.target_triple.str:
        fail("PGO capture requires the matching native pinned Rust toolchain")
    use_inputs = []
    if ctx.attr.phase == "use":
        namespace = "tools/bazel/rust/release_pgo/" + rust.exec_triple.str
        if ctx.attr.trained_profile == None or ctx.attr.instrumented_context == None:
            fail("PGO profile-use capture requires its original trained profile and instrumented context")
        for target, name in [(ctx.attr.trained_profile, "dataplane_profile"), (ctx.attr.instrumented_context, "contexts/dataplane-pgo-generate.json")]:
            if target.label.repo_name != ctx.label.repo_name or target.label.package != namespace or target.label.name != name:
                fail("PGO profile-use capture requires its exact original native producer identities")
        use_inputs = [ctx.file.trained_profile, ctx.file.instrumented_context]
    elif ctx.attr.trained_profile != None or ctx.attr.instrumented_context != None:
        fail("PGO instrumented capture cannot inherit another profile/context")
    output = ctx.actions.declare_directory(ctx.label.name)
    arguments = ["-I", "-B", ctx.file._generator.path,
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
                 "--producer", str(ctx.attr.sdk.label), "--phase", ctx.attr.phase,
                 "--output", output.path, "--engine-precreated-tree-roots"]
    if ctx.attr.phase == "use":
        arguments += ["--trained-profile", ctx.file.trained_profile.path, "--instrumented-context", ctx.file.instrumented_context.path, "--llvm-profdata", ctx.executable._profdata.path, "--training-helper", ctx.file._training.path]
    if ctx.attr.tpm_sim:
        arguments.append("--tpm-sim")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = arguments,
        inputs = depset([sdk.descriptor, sdk.provenance, sdk.sources, sdk.registry,
                         ctx.file._generator, ctx.file._resolver, ctx.file._contexts,
                         ctx.file._units, ctx.file._native_helper, ctx.file.metadata,
                         ctx.file.source_inputs, ctx.file.runtime_inputs, ctx.file._training] + use_inputs + ctx.files._unit_helpers,
                        transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run] + ([ctx.attr._profdata[DefaultInfo].files_to_run] if ctx.attr.phase == "use" else []),
        outputs = [output],
        env = {},
        use_default_shell_env = False,
        mnemonic = "CaptureDataplaneReleasePgo",
    )
    return [DefaultInfo(files = depset([output]))]

dataplane_release_pgo_capture = rule(
    implementation = _capture_impl,
    toolchains = ["@rules_rust//rust:toolchain_type"],
    attrs = {
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True),
        "phase": attr.string(mandatory = True, values = ["generate", "use"]),
        "trained_profile": attr.label(allow_single_file = True),
        "instrumented_context": attr.label(allow_single_file = True),
        "_profdata": attr.label(executable = True, cfg = "exec", default = "//tools/bazel/rust:llvm_profdata"),
        "_training": attr.label(allow_single_file = True, default = "//tools/bazel/rust:release_pgo_train.py"),
        "metadata": attr.label(allow_single_file = True, mandatory = True),
        "source_inputs": attr.label(allow_single_file = True, mandatory = True),
        "runtime_inputs": attr.label(allow_single_file = True, mandatory = True),
        "tpm_sim": attr.bool(),
        "_generator": attr.label(allow_single_file = True, default = "//tools/bazel/rust:release_pgo_generate.py"),
        "_resolver": attr.label(allow_single_file = True, default = "//tools/bazel/rust:acquisition_sdk.py"),
        "_contexts": attr.label(allow_single_file = True, default = "//tools/bazel/rust:contexts.py"),
        "_units": attr.label(allow_single_file = True, default = "//tools/bazel/rust:units.py"),
        "_native_helper": attr.label(allow_single_file = True, default = "//tools/bazel/rust:native_protocol_generate.py"),
        "_unit_helpers": attr.label_list(allow_files = True, default = ["//tools/bazel/rust:configured_parity.py", "//tools/bazel/rust:license_metadata.py", "//tools/bazel/rust:native_receipts.py"]),
        "_python": attr.label(executable = True, cfg = "exec", default = "//tools/bazel/tools/native:python3"),
    },
)
