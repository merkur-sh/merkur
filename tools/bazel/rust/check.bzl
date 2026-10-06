"""Cargo Check compiler units: emit metadata; execute host macros/scripts normally."""

load("@rules_rust//rust/private:common.bzl", "rust_common")
load("@rules_rust//rust/private:providers.bzl", "LintsInfo")
load("@rules_rust//rust/private:rust.bzl", "RUSTC_ATTRS")
load("@rules_rust//rust/private:rustc.bzl", "collect_deps", "collect_inputs", "construct_arguments")
load("@rules_rust//rust/private:utils.bzl", "find_cc_toolchain", "find_toolchain", "transform_deps")

RustCheckInfo = provider(fields = {"metadata": "Declared metadata File", "crate_types": "Exact Cargo target crate types"})

def _check_impl(ctx):
    toolchain = find_toolchain(ctx)
    cc_toolchain, feature_configuration = find_cc_toolchain(ctx)
    if not ctx.attr.crate_types or any([kind not in ["lib", "rlib", "cdylib", "staticlib", "dylib", "bin"] for kind in ctx.attr.crate_types]):
        fail("Check requires the exact supported Cargo target crate types")
    output = ctx.actions.declare_file("lib" + ctx.attr.crate_name + "-" + ctx.label.name + ".rmeta")
    aliases = dict(ctx.attr.aliases)
    aliases.update(ctx.attr.proc_macro_aliases)
    deps = transform_deps(ctx.attr.deps)
    macros = transform_deps(ctx.attr.proc_macro_deps)
    crate = rust_common.create_crate_info(
        name = ctx.attr.crate_name,
        type = "rlib" if "rlib" in ctx.attr.crate_types or "lib" in ctx.attr.crate_types else ctx.attr.crate_types[0],
        root = ctx.file.crate_root,
        root_path = "",
        srcs = depset(ctx.files.srcs),
        deps = depset(deps),
        proc_macro_deps = depset(macros),
        aliases = aliases,
        extra_named_deps = depset(),
        output = output,
        metadata = output,
        metadata_supports_pipelining = True,
        rustc_output = None,
        rustc_rmeta_output = None,
        edition = ctx.attr.edition,
        rustc_env = ctx.attr.rustc_env,
        rustc_env_files = ctx.files.rustc_env_files,
        is_test = False,
        data = depset(),
        compile_data = depset(ctx.files.compile_data),
        compile_data_targets = depset(ctx.attr.compile_data),
        owner = ctx.label,
        cfgs = None,
    )
    dep_info, build_info, _ = collect_deps(
        deps = deps,
        proc_macro_deps = macros,
        aliases = aliases,
        extra_named_deps = depset(),
    )
    lint_flags, lint_files = [], []
    if ctx.attr.lint_config:
        lint_flags = ctx.attr.lint_config[LintsInfo].rustc_lint_flags
        lint_files = ctx.attr.lint_config[LintsInfo].rustc_lint_files
    inputs, out_dir, build_env_files, build_flags_files, linkstamps, ambiguous_libs = collect_inputs(
        ctx = ctx,
        file = ctx.file,
        files = ctx.files,
        linkstamps = depset(),
        toolchain = toolchain,
        cc_toolchain = cc_toolchain,
        feature_configuration = feature_configuration,
        crate_info = crate,
        dep_info = dep_info,
        build_info = build_info,
        lint_files = lint_files,
        include_link_flags = False,
    )
    args, env = construct_arguments(
        ctx = ctx,
        attr = ctx.attr,
        file = ctx.file,
        toolchain = toolchain,
        tool_file = toolchain.rustc,
        cc_toolchain = cc_toolchain,
        feature_configuration = feature_configuration,
        crate_info = crate,
        dep_info = dep_info,
        linkstamp_outs = linkstamps,
        ambiguous_libs = ambiguous_libs,
        output_hash = ctx.label.name,
        rust_flags = lint_flags,
        out_dir = out_dir,
        build_env_files = build_env_files,
        build_flags_files = build_flags_files,
        emit = [("metadata", output)],
        include_link_flags = False,
        use_json_output = True,
    )
    # Cargo can check one target with several crate types. The final complete
    # list replaces construct_arguments' singular CrateInfo representation.
    args.rustc_flags.add_joined(ctx.attr.crate_types, join_with = ",", format_joined = "--crate-type=%s")
    ctx.actions.run(
        executable = ctx.executable._process_wrapper,
        inputs = inputs,
        outputs = [output],
        env = env,
        arguments = args.all,
        mnemonic = "MerkurRustCheck",
        progress_message = "Checking Rust %{label}",
        toolchain = "@rules_rust//rust:toolchain_type",
        execution_requirements = {"supports-path-mapping": ""} if args.supports_path_mapping else None,
    )
    return [DefaultInfo(files = depset([output])), crate, dep_info, RustCheckInfo(metadata = output, crate_types = ctx.attr.crate_types)]

rust_check = rule(
    implementation = _check_impl,
    attrs = RUSTC_ATTRS | {
        "crate_name": attr.string(mandatory = True),
        "crate_types": attr.string_list(mandatory = True),
        "crate_root": attr.label(allow_single_file = [".rs"], mandatory = True),
        "srcs": attr.label_list(allow_files = True),
        "compile_data": attr.label_list(allow_files = True),
        "deps": attr.label_list(),
        "proc_macro_deps": attr.label_list(cfg = "exec"),
        "aliases": attr.label_keyed_string_dict(),
        "proc_macro_aliases": attr.label_keyed_string_dict(cfg = "exec"),
        "edition": attr.string(mandatory = True),
        "version": attr.string(default = "0.0.0"),
        "crate_features": attr.string_list(),
        "rustc_flags": attr.string_list(),
        "rustc_env": attr.string_dict(),
        "rustc_env_files": attr.label_list(allow_files = True),
        "lint_config": attr.label(providers = [LintsInfo]),
        "apply_lints_in_exec": attr.bool(default = True),
    },
    fragments = ["cpp"],
    toolchains = ["@rules_rust//rust:toolchain_type", config_common.toolchain_type("@bazel_tools//tools/cpp:toolchain_type", mandatory = False)],
)
