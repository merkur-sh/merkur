"""Native compiler and build-script actions for exact configured Cargo units."""
load("//tools/bazel/rust:check.bzl", "rust_check")
load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_library", "rust_proc_macro", "rust_shared_library", "rust_test", "rust_doc_test", "rust_clippy_test")
load("@rules_rust//cargo/private:cargo_build_script.bzl", "cargo_build_script", "cargo_build_script_runfiles")
load("@rules_rust//rust:rust_common.bzl", "BuildInfo", "TestCrateInfo", "rust_common")
load("//tools/bazel/packaging:rust-link-map.bzl", "RustLinkMapInfo")
load("//tools/bazel/tools/native:darwin-swift.bzl", "darwin_identity_build_script_kwargs")

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

_PLATFORMS = {
    "aarch64-apple-darwin": ["@platforms//cpu:aarch64", "@platforms//os:macos"],
    "x86_64-apple-darwin": ["@platforms//cpu:x86_64", "@platforms//os:macos"],
    "aarch64-unknown-linux-gnu": ["@platforms//cpu:aarch64", "@platforms//os:linux"],
    "x86_64-unknown-linux-gnu": ["@platforms//cpu:x86_64", "@platforms//os:linux"],
    "wasm32-unknown-unknown": ["@platforms//cpu:wasm32", "@platforms//os:none"],
}

def confinement_test_tags(package, name, platform):
    # Darwin cannot install a nested seatbelt sandbox. These tests exercise
    # the actual product helper's confinement, so only their outer runner is
    # local. Fresh execution remains mandatory for this exact fixture scope.
    if package == "merkur-image-worker" and name in ["test_composition", "test_descriptor", "test_encoding_allocations", "test_isolation"] and platform.endswith("apple-darwin"):
        return ["manual", "no-sandbox", "no-remote", "external", "no-cache"]
    return ["manual"]

def _wasm_transition_impl(_settings, _attr):
    return {"//command_line_option:platforms": ["//tools/bazel/platforms:wasm32"]}

_wasm_transition = transition(
    implementation = _wasm_transition_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms"],
)

def _wasm_artifact_impl(ctx):
    original = ctx.attr.target[0]
    crate = original[TestCrateInfo].crate
    if crate.type != "cdylib" or crate.is_test or crate.output not in original[DefaultInfo].files.to_list():
        fail("WASM facade requires its original transitioned compiler cdylib File")
    return [DefaultInfo(files = original[DefaultInfo].files), crate, original[RustLinkMapInfo], original[OutputGroupInfo]]

wasm_artifact = rule(
    implementation = _wasm_artifact_impl,
    attrs = {
        "target": attr.label(cfg = _wasm_transition, mandatory = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _directory(manifest):
    label = Label(manifest)
    return "/".join([part for part in [label.workspace_root, label.package] if part])

def _configured_package_test_impl(ctx):
    binary = ctx.executable.binary
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    tool_env = ""
    for variable, tool in ctx.attr.runtime_tools.items():
        if not variable or any([char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" for char in variable.elems()]):
            fail("invalid declared runtime tool environment name")
        tool_env += 'export %s="$root/%s"\n' % (variable, tool[DefaultInfo].files_to_run.executable.short_path)
    ctx.actions.write(executable, """#!/bin/sh
set -eu
root="$TEST_SRCDIR/$TEST_WORKSPACE"
export CARGO_MANIFEST_DIR="$root/%s"
%s
cd "$CARGO_MANIFEST_DIR"
exec "$root/%s" "$@"
""" % (ctx.attr.package_path, tool_env, binary.short_path), is_executable = True)
    helpers = {ctx.attr.package_path + "/.cargo-bin/" + name: target[DefaultInfo].files_to_run.executable for name, target in ctx.attr.binary_helpers.items()}
    runfiles = ctx.runfiles(files = [binary] + ctx.files.data, symlinks = helpers)
    runfiles = runfiles.merge(ctx.attr.binary[TestRuntimeInfo].runfiles)
    for tool in ctx.attr.runtime_tools.values():
        runfiles = runfiles.merge(tool[DefaultInfo].default_runfiles).merge(ctx.runfiles(files = tool[DefaultInfo].files.to_list()))
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = executable, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

_configured_package_test = rule(
    implementation = _configured_package_test_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "binary": attr.label(providers = [TestRuntimeInfo], executable = True, cfg = "target", mandatory = True),
        "package_path": attr.string(mandatory = True),
        "data": attr.label_list(allow_files = True),
        "binary_helpers": attr.string_keyed_label_dict(cfg = "target"),
        "runtime_tools": attr.string_keyed_label_dict(cfg = "exec"),
    },
)

def compiler_unit(name, crate_name, crate_root, sources, compile_data, manifest, edition, version, crate_features, deps, proc_macro_deps, aliases, proc_macro_aliases, rustc_flags, kind, mode, platform, execution_host, first_party, cargo_env, rust_flags, emit_cdylib, crate_types = [], compiler_env = {}, profile_data = [], macro_data = [], runtime_data = [], binary_helpers = {}, lint_owned = True, runtime_tools = {}, semantic_metadata = "", napi_type_defs = False, native_link_map = False, wasm_link_map = False, profile_training = False):
    cargo_env = dict(cargo_env)
    for binary_name in binary_helpers:
        cargo_env["CARGO_BIN_EXE_" + binary_name] = "./.cargo-bin/" + binary_name
    flags = list(rustc_flags) + rust_flags
    if not lint_owned:
        flags.append("--cap-lints=allow")
    rule = rust_test if mode == "test" else rust_proc_macro if "proc-macro" in kind else rust_binary if "bin" in crate_types or "custom-build" in kind else rust_shared_library if emit_cdylib else rust_library
    kwargs = {}
    if type(profile_training) != "bool":
        fail("Release PGO training compiler role must be explicit Boolean")
    if profile_training:
        if (native.package_name() != "tools/bazel/rust/release_pgo/" + platform or
            platform != execution_host or platform not in ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"] or
            mode != "test" or kind != ["lib"] or crate_types != ["lib"] or
            crate_name != "merkur_dataplane" or crate_root != "//apps/daemon/dataplane:src/lib.rs" or
            cargo_env["CARGO_PKG_NAME"] != "merkur-dataplane" or not first_party or
            [flag for flag in rust_flags if flag.startswith("-Cprofile-")] != ["-Cprofile-generate=merkur-release-pgo"] or profile_data or
            not all([flag in rustc_flags for flag in ["-Copt-level=3", "-Cdebuginfo=0", "-Cdebug-assertions=no", "-Coverflow-checks=no"]])):
            fail("Release PGO training requires its captured native release library-test root")
        # The original --test executable trains production profile bytes. Its
        # actual configured test wrapper and TestRunner nonce remain unchanged.
        kwargs["testonly"] = False
    if napi_type_defs:
        if not emit_cdylib or mode != "build":
            fail("NAPI type-definition outputs require the actual cdylib build action")
        kwargs["napi_type_defs"] = True
    if lint_owned:
        manifest_label = Label(manifest)
        kwargs["lint_config"] = "@@" + manifest_label.repo_name + "//" + manifest_label.package + ":manifest_lints"
        kwargs["apply_lints_in_exec"] = True
    if first_party and platform != "wasm32-unknown-unknown" and cargo_env["CARGO_PKG_NAME"] in ["merkur-dataplane", "merkur-tui", "merkur-image-worker", "merkur-edge", "merkur-stun"]:
        kwargs["rustc_env_files"] = ["//tools/bazel/bun:public_release_context"]
    native_linked = platform != "wasm32-unknown-unknown" and mode == "build" and ("bin" in crate_types or "proc-macro" in kind)
    wasm_linked = platform == "wasm32-unknown-unknown" and mode == "build" and emit_cdylib
    if native_link_map and not native_linked:
        fail("Native source attribution requires an actual native binary or proc-macro build action")
    if wasm_link_map and not wasm_linked:
        fail("WASM source attribution requires the actual WASM cdylib build action")
    if native_link_map or (native_linked and ("proc-macro" in kind or (first_party and "bin" in crate_types and cargo_env["CARGO_PKG_NAME"] in ["merkur-dataplane", "merkur-tui", "merkur-image-worker", "merkur-edge", "merkur-stun"]))):
        kwargs["native_link_map"] = True
    if wasm_link_map or (first_party and wasm_linked):
        kwargs["wasm_link_map"] = True
    if mode == "check":
        rust_check(
            name = name,
            crate_name = crate_name,
            crate_root = crate_root,
            srcs = [sources],
            compile_data = [compile_data] + macro_data,
            edition = edition,
            version = version,
            crate_features = crate_features,
            deps = deps,
            proc_macro_deps = proc_macro_deps,
            aliases = aliases,
            proc_macro_aliases = proc_macro_aliases,
            rustc_flags = flags,
            crate_types = crate_types,
            rustc_env = dict(dict(cargo_env, **compiler_env), CARGO_MANIFEST_DIR = "$${pwd}/" + _directory(manifest)),
            target_compatible_with = _PLATFORMS[platform],
            exec_compatible_with = _PLATFORMS[execution_host],
            tags = ["manual"],
            **kwargs
        )
        return
    rule(
        name = name + "_binary" if mode == "test" else name,
        crate_name = crate_name,
        crate_root = crate_root,
        srcs = [sources],
        compile_data = [compile_data] + profile_data + macro_data,
        data = [compile_data] + macro_data + runtime_data + binary_helpers.values() if mode == "test" else [],
        edition = edition,
        version = version,
        crate_features = crate_features,
        deps = deps,
        proc_macro_deps = proc_macro_deps,
        aliases = aliases,
        proc_macro_aliases = proc_macro_aliases,
        rustc_flags = flags,
        semantic_metadata = semantic_metadata,
        rustc_env = dict(dict(cargo_env, **compiler_env), CARGO_MANIFEST_DIR = "$${pwd}/" + _directory(manifest)),
        target_compatible_with = _PLATFORMS[platform],
        exec_compatible_with = _PLATFORMS[execution_host],
        tags = ["manual"] + ([] if lint_owned else ["no_clippy"]),
        **kwargs
    )
    if mode == "test":
        _configured_package_test(
            name = name,
            binary = ":" + name + "_binary",
            package_path = _directory(manifest),
            data = [compile_data],
            binary_helpers = binary_helpers,
            runtime_tools = runtime_tools,
            target_compatible_with = _PLATFORMS[platform],
            exec_compatible_with = _PLATFORMS[execution_host],
            tags = confinement_test_tags(cargo_env["CARGO_PKG_NAME"], "test_" + crate_name, platform),
        )

def _build_script_metadata_impl(ctx):
    info = ctx.attr.build_script[BuildInfo]
    if not info.dep_env or not info.out_dir or not info.out_dir.is_directory:
        fail("Linked Cargo build script must provide its metadata File and output directory")
    return [DefaultInfo(
        files = depset([info.dep_env]),
        runfiles = ctx.runfiles(files = [info.out_dir], transitive_files = info.compile_data),
    )]

# Cargo's unit graph links one run-custom-build unit directly to another.
# Project that existing BuildInfo; compiling the sys library is unnecessary.
build_script_metadata = rule(
    implementation = _build_script_metadata_impl,
    attrs = {"build_script": attr.label(providers = [BuildInfo], mandatory = True)},
)

def build_script_unit(name, crate_name, crate_root, sources, compile_data, manifest, edition, version, crate_features, deps, proc_macro_deps, aliases, proc_macro_aliases, rustc_flags, kind, mode, platform, execution_host, first_party, script, pkg_name, profile, cargo_env, rust_flags, emit_cdylib, crate_types = [], compiler_env = {}, profile_data = [], macro_data = [], runtime_data = [], binary_helpers = {}, lint_owned = True, runtime_tools = {}, links = "", semantic_metadata = "", build_data = [], build_script_env_files = [], swift_sdk = None):
    swift = darwin_identity_build_script_kwargs(pkg_name, platform, swift_sdk)
    build_data = build_data + swift["data"]
    compiler_env = dict(compiler_env, **swift["environment"])
    cargo_build_script_runfiles(name = name + "_data", data = [compile_data] + profile_data + macro_data + build_data, tags = ["manual"])
    cargo_build_script(
        name = name,
        script = script,
        declared_cc_path = platform == "wasm32-unknown-unknown",
        data_runfiles = ":" + name + "_data",
        data = [compile_data] + profile_data + macro_data + build_data,
        crate_features = crate_features,
        version = version,
        pkg_name = pkg_name,
        links = links,
        link_deps = deps,
        build_script_env_files = build_script_env_files,
        toolchains = swift["toolchains"],
        rundir = _directory(manifest),
        build_script_env = dict(dict(cargo_env, **compiler_env), CARGO_MANIFEST_DIR = _directory(manifest), OPT_LEVEL = profile["opt_level"], DEBUG = "false" if profile["debuginfo"] == 0 else "true", PROFILE = "release" if profile["name"] == "release" else "debug"),
        rustc_flags = rust_flags,
        target_compatible_with = _PLATFORMS[platform],
        exec_compatible_with = _PLATFORMS[execution_host],
        tags = ["manual"],
    )

def doctest_unit(name, crate, deps, proc_macro_deps, crate_features, rustc_flags, rust_flags, platform, execution_host, **_kwargs):
    rust_doc_test(
        name = name,
        crate = crate,
        deps = [dep for dep in deps if dep != crate],
        proc_macro_deps = proc_macro_deps,
        crate_features = crate_features,
        rustdoc_flags = rustc_flags + rust_flags,
        target_compatible_with = _PLATFORMS[platform],
        exec_compatible_with = _PLATFORMS[execution_host],
        tags = ["manual"],
    )

def configured_clippy_test(name, target, platform):
    rust_clippy_test(
        name = name,
        targets = [target],
        target_compatible_with = _PLATFORMS[platform],
        tags = ["manual"],
    )


def _configured_public_rust_test_impl(ctx):
    binary = ctx.executable.binary
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, """#!/bin/sh
set -eu
exec "$TEST_SRCDIR/$TEST_WORKSPACE/%s" "$@"
""" % binary.short_path, is_executable = True)
    runfiles = ctx.runfiles(files = [binary]).merge(ctx.attr.binary[TestRuntimeInfo].runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = executable, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

configured_public_rust_test = rule(
    implementation = _configured_public_rust_test_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,"binary": attr.label(providers = [TestRuntimeInfo], executable = True, cfg = "target", mandatory = True)},
)
