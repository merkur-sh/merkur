"""Native-host Cargo introspection; no Rust product compilation or host tool fallback."""

def _acquire_impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    bun = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    if rust.version != "1.97.1" or rust.exec_triple.str != ctx.attr.execution_host or rust.target_triple.str != ctx.attr.execution_host:
        fail("Cargo acquisition requires the exact native Rust1.97.1 host toolchain")
    sources = {}
    for file in ctx.files.sources:
        if file.is_directory or file.short_path.startswith("../"):
            fail("Acquisition source snapshot requires explicit first-party regular File inputs")
        sources[file.short_path] = file.path
    descriptor = ctx.actions.declare_file(ctx.label.name + ".descriptor.json")
    receipt = ctx.actions.declare_file(ctx.label.name + ".json")
    sdk = depset([rust.cargo, rust.rustc], transitive = [rust.rustc_lib])
    ctx.actions.write(descriptor, json.encode({
        "execution_host": ctx.attr.execution_host,
        "executor_image": ctx.attr.executor_image,
        "cargo": rust.cargo.path,
        "rustc": rust.rustc.path,
        "mode": ctx.attr.mode,
        "manifest": "tools/bazel/rust/contexts/merkur-fec/" + ctx.attr.mode + "/native/Cargo.toml",
        "original_manifest": "packages/merkur-fec/Cargo.toml",
        "sources": sources,
        "sdk": sorted([file.path for file in sdk.to_list()]),
    }))
    ctx.actions.run(
        executable = bun,
        arguments = ["--no-env-file", "--config=" + ctx.file._bun_config.path, ctx.file._runner.path, descriptor.path, receipt.path],
        inputs = depset([descriptor, ctx.file._runner, ctx.file._bun_config] + ctx.files.sources, transitive = [sdk]),
        tools = [bun],
        outputs = [receipt],
        mnemonic = "MerkurCargoHostAcquisition",
        env = {},
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset([descriptor, receipt]))]

_acquire = rule(
    implementation = _acquire_impl,
    attrs = {
        "execution_host": attr.string(mandatory = True),
        "executor_image": attr.string(mandatory = True),
        "mode": attr.string(default = "build", values = ["build", "test"]),
        "sources": attr.label_list(allow_files = True),
        "_runner": attr.label(default = ":runner.ts", allow_single_file = True),
        "_bun_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["@rules_rust//rust:toolchain_type", "//tools/bazel/bun:toolchain_type"],
)

def declare_acquisitions():
    sources = [
        "//:Cargo.toml", "//:Cargo.lock", "//:rust-toolchain.toml", "//:.cargo/config.toml",
        "//tools/bazel/rust:metadata.json",
        "//tools/bazel/rust:contexts.py", "//tools/bazel/rust:acquisition_sdk.py",
        "//packages/merkur-fec:package_data",
    ] + ["//packages/" + name + "-patch:package_data" for name in ["alacritty-terminal", "fontdue", "quinn", "quinn-proto", "vte", "wtransport"]]
    for host, cpu, image in [
        ("x86_64-unknown-linux-gnu", "x86_64", "a689e29bc3adf4663ef9a141d23081252764d1319c63f591a027bd6fd676f4c1"),
        ("aarch64-unknown-linux-gnu", "aarch64", "66035d353338cb93b64f621393dc6fecde85258651ca454f0cf36ff2639b1352"),
    ]:
        for mode in ["build", "test"]:
            _acquire(
                name = "fec__" + ("test__" if mode == "test" else "") + host.replace("-", "_"),
                execution_host = host,
                executor_image = "docker://gcc@sha256:" + image,
                mode = mode,
                sources = sources + ["//tools/bazel/rust/contexts/merkur-fec/" + mode + "/native:" + member for member in ["Cargo.toml", "Cargo.lock", "metadata.json"]],
                exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:" + cpu, "//tools/bazel/cc/native:gcc_14_3_bookworm"],
                target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:" + cpu],
                exec_properties = {"OSFamily": "linux", "Arch": "amd64" if cpu == "x86_64" else "arm64", "container-image": "docker://gcc@sha256:" + image, "network": "off", "recycle-runner": "false", "use-self-hosted-executors": "false"},
                tags = ["manual"],
            )
