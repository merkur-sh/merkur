"""Actual Linux-target metadata checks using configured rules_rust dependencies."""

load("@rules_rust//rust:rust_common.bzl", "rust_common")
load("@rules_rust//rust/private:rustc.bzl", "ExtraExecRustcEnvInfo", "ExtraExecRustcFlagsInfo", "ExtraRustcEnvInfo", "ExtraRustcFlagsInfo", "PerCrateRustcFlagsInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

ConfiguredWorkerRootInfo = provider(fields = ["owner", "rustc_flags"])

# Exact attribute inventory of the pinned binary rules and maintained worker
# extension, plus Bazel's common rule attributes. Unknown rule extensions refuse.
_ROOT_ATTRIBUTES = [
    "aliases", "alwayslink", "allocator_libraries", "binary_name", "compile_data",
    "crate_features", "crate_name", "crate_root", "crate_type", "data", "deps",
    "proc_macro_aliases", "native_link_map", "wasm_link_map", "apply_lints_in_exec", "semantic_metadata",
    "edition", "env", "experimental_use_cc_common_link", "link_deps", "link_std_dylib",
    "linker_script", "lint_config", "malloc", "platform", "proc_macro_deps",
    "require_explicit_unstable_features", "root_path", "rustc_env", "rustc_env_files",
    "rustc_flags", "srcs", "stamp", "unstable_rust_features_config", "version",
    "zself_profile_events", "incremental_confiner", "incremental_process_scope",
    "incremental_runtime", "incremental_worker", "napi_type_defs",
    "_allowlist_function_transition", "_always_enable_metadata_output_groups",
    "_bootstrap_process_wrapper", "_collect_cfgs", "_custom_malloc", "_error_format",
    "_extra_exec_rustc_env", "_extra_exec_rustc_flag", "_extra_exec_rustc_flags",
    "_extra_rustc_env", "_extra_rustc_flag", "_extra_rustc_flags", "_per_crate_rustc_flag",
    "_process_wrapper", "_rustc_output_diagnostics",
    "name", "visibility", "tags", "testonly", "features", "aspect_hints",
    "compatible_with", "restricted_to", "deprecation", "distribs", "licenses",
    "exec_compatible_with", "exec_group_compatible_with", "exec_properties",
    "generator_function", "generator_location", "generator_name", "package_metadata",
    "toolchains",
]

def _root_contract(kind, attr, crate):
    if kind not in ["rust_binary", "rust_binary_without_process_wrapper"]:
        fail("Linux metadata supports only the pinned ordinary binary rule contracts")
    for name in dir(attr):
        if name not in _ROOT_ATTRIBUTES:
            fail("Unmodeled configured worker root attribute: " + name)
    for name in ["crate_features", "rustc_flags", "rustc_env", "rustc_env_files", "compile_data", "proc_macro_deps", "data", "link_deps", "root_path", "unstable_rust_features_config", "zself_profile_events", "lint_config"]:
        if not hasattr(attr, name):
            fail("Pinned worker root attribute missing: " + name)
        if name != "rustc_flags" and getattr(attr, name):
            fail("Unsupported configured worker root input: " + name)
    for name in ["features", "napi_type_defs", "incremental_worker", "incremental_confiner", "incremental_process_scope", "incremental_runtime", "proc_macro_aliases", "native_link_map", "wasm_link_map", "apply_lints_in_exec", "semantic_metadata"]:
        if hasattr(attr, name) and getattr(attr, name):
            fail("Unsupported configured worker root extension: " + name)
    if crate.is_test or crate.compile_data.to_list() or crate.compile_data_targets.to_list():
        fail("Linux metadata does not model test mode or root compile data")
    return list(attr.rustc_flags)

def _root_aspect_impl(target, ctx):
    flags = _root_contract(ctx.rule.kind, ctx.rule.attr, target[rust_common.crate_info])
    settings = [
        ("_extra_rustc_flags", ExtraRustcFlagsInfo, "extra_rustc_flags"),
        ("_extra_rustc_flag", ExtraRustcFlagsInfo, "extra_rustc_flags"),
        ("_extra_exec_rustc_flags", ExtraExecRustcFlagsInfo, "extra_exec_rustc_flags"),
        ("_extra_exec_rustc_flag", ExtraExecRustcFlagsInfo, "extra_exec_rustc_flags"),
        ("_per_crate_rustc_flag", PerCrateRustcFlagsInfo, "per_crate_rustc_flags"),
        ("_extra_rustc_env", ExtraRustcEnvInfo, "extra_rustc_env"),
        ("_extra_exec_rustc_env", ExtraExecRustcEnvInfo, "extra_exec_rustc_env"),
    ]
    for name, provider_type, field in settings:
        if not hasattr(ctx.rule.attr, name):
            fail("Pinned worker compiler setting missing: " + name)
        setting = getattr(ctx.rule.attr, name)
        if provider_type not in setting or getattr(setting[provider_type], field):
            fail("Unsupported inherited worker compiler setting: " + name)
    return [ConfiguredWorkerRootInfo(owner = target.label, rustc_flags = flags)]

_configured_root = aspect(
    implementation = _root_aspect_impl,
    required_providers = [rust_common.crate_info],
    provides = [ConfiguredWorkerRootInfo],
)

def _impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    target = rust.target_triple.str
    if rust.version != "1.97.1" or rust.exec_triple.str != "aarch64-apple-darwin" or target not in ["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]:
        fail("Linux metadata requires pinned native Darwin Rust with an actual Linux target toolchain")
    crate = ctx.attr.crate[rust_common.crate_info]
    root_contract = ctx.attr.crate[ConfiguredWorkerRootInfo]
    if root_contract.owner != crate.owner:
        fail("Configured source attribute authority differs from the compiler crate")
    if rust.extra_rustc_flags or rust.extra_exec_rustc_flags or rust.extra_rustc_flags_for_crate_types:
        fail("This focused typecheck does not model additional toolchain compiler flags")
    sources = crate.srcs.to_list()
    if crate.root.is_directory or crate.root not in sources or crate.type not in ["bin", "lib", "rlib"]:
        fail("Typecheck requires the actual ordinary configured worker crate sources")
    if crate.rustc_env or crate.rustc_env_files or crate.extra_named_deps.to_list() or crate.proc_macro_deps.to_list():
        fail("This focused worker control does not model root build environments, features or proc macros")
    aliases = {dep.label: name for dep, name in crate.aliases.items()}
    dependencies = {}
    transitive = []
    for variant in crate.deps.to_list():
        child = variant.crate_info
        if child == None or variant.dep_info == None or child.type == "proc-macro":
            fail("Worker typecheck requires target-configured ordinary Rust dependency providers")
        name = aliases.get(child.owner, child.name)
        if name in dependencies:
            fail("Worker typecheck repeats a configured extern name")
        metadata = child.metadata if child.metadata else child.output
        if not metadata.basename.endswith(".rmeta") and not metadata.basename.endswith(".rlib"):
            fail("Dependency lacks Rustc metadata or rlib output")
        dependencies[name] = metadata.path
        transitive.append(depset([metadata]))
        transitive.append(variant.dep_info.transitive_metadata_outputs)
    dependency_files = depset(transitive = transitive)
    request = ctx.actions.declare_file(ctx.label.name + ".typecheck-inputs.json")
    ctx.actions.write(request, json.encode({
        "target": target,
        "execution_host": rust.exec_triple.str,
        "rustc": rust.rustc.path,
        "compiler_archive": ctx.file.compiler_archive.path,
        "std_archive": ctx.file.std_archive.path,
        "pins": ctx.file._pins.path,
        "compiler_files": [file.path for file in rust.all_files.to_list()],
        "configured_std": [file.path for file in rust.rust_std.to_list()],
        "sources": [file.path for file in sources],
        "root": crate.root.path,
        "crate_name": crate.name,
        "crate_type": "bin" if crate.type == "bin" else "lib",
        "edition": crate.edition,
        "rustc_flags": root_contract.rustc_flags,
        "dependencies": dependencies,
        "dependency_files": [file.path for file in dependency_files.to_list()],
    }))
    metadata = ctx.actions.declare_file(ctx.label.name + ".rmeta")
    python = ctx.attr.python[DefaultInfo].files_to_run
    ctx.actions.run(
        executable = python,
        tools = [python],
        inputs = depset(sources + [request, ctx.file._driver, ctx.file._pins, ctx.file.compiler_archive, ctx.file.std_archive], transitive = [rust.all_files, dependency_files, ctx.attr.python[DefaultInfo].default_runfiles.files]),
        outputs = [metadata],
        arguments = ["-B", "-I", ctx.file._driver.path, "--request", request.path, "--output", metadata.path],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurLinuxWorkerTypecheck",
    )
    return [DefaultInfo(files = depset([metadata])), OutputGroupInfo(typecheck_inputs = depset([request]))]

linux_worker_typecheck = rule(
    implementation = _impl,
    attrs = {
        "crate": attr.label(providers = [rust_common.crate_info, rust_common.dep_info], aspects = [_configured_root], mandatory = True),
        "compiler_archive": attr.label(allow_single_file = True, mandatory = True),
        "std_archive": attr.label(allow_single_file = True, mandatory = True),
        "python": attr.label(executable = True, cfg = "exec", mandatory = True),
        "_pins": attr.label(allow_single_file = True, default = "//tools/bazel/rust:stdlib_attribution.py"),
        "_driver": attr.label(allow_single_file = True, default = ":linux-typecheck.py"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _controls_impl(ctx):
    python = ctx.attr.python[DefaultInfo].files_to_run.executable
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, "#!/bin/sh\nset -eu\nr=${TEST_SRCDIR:?}\nexec \"$r/%s\" -B -I \"$r/%s\" --original-archive \"$r/%s\" --maintained-patch \"$r/%s\"\n" % (_runfile(python), _runfile(ctx.file._tests), _runfile(ctx.file.archive), _runfile(ctx.file.patch)), is_executable = True)
    runtime = ctx.runfiles(files = [python, ctx.file._tests, ctx.file._driver, ctx.file._rule_source, ctx.file.archive, ctx.file.patch]).merge(ctx.attr.python[DefaultInfo].default_runfiles)
    runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [DefaultInfo(executable = launcher, runfiles = runfiles), TestRuntimeInfo(runfiles = runtime)]

linux_typecheck_controls_test = rule(
    implementation = _controls_impl,
    test = True,
    attrs = {
        "archive": attr.label(allow_single_file = True, mandatory = True),
        "patch": attr.label(allow_single_file = True, mandatory = True),
        "python": attr.label(executable = True, cfg = "exec", mandatory = True),
        "_tests": attr.label(allow_single_file = True, default = ":linux-typecheck-test.py"),
        "_driver": attr.label(allow_single_file = True, default = ":linux-typecheck.py"),
        "_rule_source": attr.label(allow_single_file = True, default = ":linux_typecheck.bzl"),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)
