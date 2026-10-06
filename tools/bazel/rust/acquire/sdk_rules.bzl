"""Original locked archive Files + native toolchain Files produce introspection inputs."""

CargoAcquisitionSdkInfo = provider(fields = ["descriptor", "registry", "sources", "provenance", "sdk_files", "original_sources", "stock_descriptor", "stock_sources", "stock_provenance"])

def _source_records(mapped, original_files):
    sources = {}
    for file, logical in mapped:
        if file.is_directory:
            fail("Acquisition source mappings require one declared regular File")
        previous = sources.get(logical)
        if previous != None and previous != file.path:
            fail("Acquisition source logical path is duplicated")
        sources[logical] = file.path
    for file in original_files:
        logical = file.short_path
        if not file.is_source or file.is_directory or file.is_symlink or file.path != logical:
            fail("Acquisition source union requires original main-workspace SourceFiles")
        if logical.startswith("/") or "" in logical.split("/") or "." in logical.split("/") or ".." in logical.split("/"):
            fail("Acquisition source logical path must be canonical and relative")
        previous = sources.get(logical)
        if previous != None and previous != file.path:
            fail("Acquisition source logical path is duplicated")
        sources[logical] = file.path
    return [{"logical": logical, "path": sources[logical]} for logical in sorted(sources)]

def _sdk_impl(ctx):
    rust = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    if rust.version != "1.97.1" or rust.exec_triple.str != ctx.attr.execution_host or rust.target_triple.str != ctx.attr.execution_host:
        fail("Acquisition SDK requires matching native Rust1.97.1 target and execution host")
    mapped_sources = []
    for target, logical in ctx.attr.source_files.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("Acquisition source mappings require one declared regular File")
        mapped_sources.append((files[0], logical))
    sources = _source_records(mapped_sources, ctx.files.source_inputs)
    original_sources = {logical: file for file, logical in mapped_sources}
    for file in ctx.files.source_inputs:
        original_sources[file.short_path] = file
    logical_sources = {source["logical"]: True for source in sources}
    for lock in ctx.attr.locks:
        if lock not in logical_sources:
            fail("Acquisition SDK lock must be an original declared source input")
    archives = []
    for target, package in ctx.attr.archives.items():
        files = target[DefaultInfo].files.to_list()
        identity = package.split("@")
        if len(identity) != 2 or len(files) != 1 or files[0].is_directory:
            fail("Original archive mappings require name@version and one declared File")
        archives.append({"name": identity[0], "version": identity[1], "path": files[0].path, "label": str(target.label)})
    # Cargo metadata/unit-graph and rustc probes never compile or link a unit.
    # Preserve the complete compiler/Cc/notice closure in the provider. The
    # acquisition actions only read and probe the declared Rust runtime Files.
    runtime = depset([rust.cargo, rust.rustc, rust.sysroot_anchor], transitive = [rust.rustc_lib, rust.rust_std])
    sdk_files = depset(transitive = [runtime, rust.all_files])
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    registry_request = ctx.actions.declare_file(ctx.label.name + ".registry.request.json")
    registry_descriptor = ctx.actions.declare_file(ctx.label.name + ".registry.descriptor.json")
    registry_provenance = ctx.actions.declare_file(ctx.label.name + ".registry.provenance.json")
    descriptor = ctx.actions.declare_file(ctx.label.name + ".descriptor.json")
    provenance = ctx.actions.declare_file(ctx.label.name + ".provenance.json")
    stock_request = ctx.actions.declare_file(ctx.label.name + ".stock.request.json")
    stock_descriptor = ctx.actions.declare_file(ctx.label.name + ".stock.descriptor.json")
    stock_provenance = ctx.actions.declare_file(ctx.label.name + ".stock.provenance.json")
    stock_snapshot = ctx.actions.declare_directory(ctx.label.name + ".stock.sources")
    registry = ctx.actions.declare_directory(ctx.label.name + ".registry")
    snapshot = ctx.actions.declare_directory(ctx.label.name + ".sources")
    common = {
        "producer": str(ctx.label),
        "version": rust.version,
        "execution_host": rust.exec_triple.str,
        "cargo": rust.cargo.path,
        "rustc": rust.rustc.path,
        "sdk": sorted([file.path for file in runtime.to_list()]),
        "archives": archives,
    }
    ctx.actions.write(registry_request, json.encode(dict(common, sources = [], locks = [])))
    ctx.actions.write(request, json.encode(dict(common, sources = sources, locks = ctx.attr.locks)))
    # Stock Cargo capture reads the original Rust distribution source manifest,
    # not the application's source snapshot. Its complete registry authority
    # still requires these exact original locks and the same native SDK Files.
    stock_sources = [source for source in sources if source["logical"] in ctx.attr.locks]
    stock_files = [original_sources[logical] for logical in ctx.attr.locks]
    ctx.actions.write(stock_request, json.encode(dict(common, sources = stock_sources, locks = ctx.attr.locks)))
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._producer.path, "--phase", "registry", "--engine-precreated-tree-roots",
                     "--request", registry_request.path, "--descriptor", registry_descriptor.path,
                     "--registry", registry.path, "--provenance", registry_provenance.path,
                     "--sdk-resolver", ctx.file._resolver.path],
        inputs = depset([registry_request, ctx.file._producer, ctx.file._resolver] + ctx.files.archives, transitive = [runtime]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [registry_descriptor, registry, registry_provenance],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurCargoAcquisitionRegistry",
    )
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._producer.path, "--phase", "source", "--engine-precreated-tree-roots",
                     "--request", request.path, "--descriptor", descriptor.path,
                     "--snapshot", snapshot.path, "--provenance", provenance.path,
                     "--registry-descriptor", registry_descriptor.path, "--registry-provenance", registry_provenance.path,
                     "--sdk-resolver", ctx.file._resolver.path, "--sdk-materializer", ctx.file._materializer.path],
        inputs = depset([request, registry_descriptor, registry, registry_provenance, ctx.file._producer, ctx.file._resolver, ctx.file._materializer] + ctx.files.source_files + ctx.files.source_inputs + ctx.files.archives, transitive = [runtime]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [descriptor, snapshot, provenance],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurCargoAcquisitionSdk",
    )
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._producer.path, "--phase", "source", "--engine-precreated-tree-roots",
                     "--request", stock_request.path, "--descriptor", stock_descriptor.path,
                     "--snapshot", stock_snapshot.path, "--provenance", stock_provenance.path,
                     "--registry-descriptor", registry_descriptor.path, "--registry-provenance", registry_provenance.path,
                     "--sdk-resolver", ctx.file._resolver.path, "--sdk-materializer", ctx.file._materializer.path],
        inputs = depset([stock_request, registry_descriptor, registry, registry_provenance, ctx.file._producer, ctx.file._resolver, ctx.file._materializer] + stock_files + ctx.files.archives, transitive = [runtime]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [stock_descriptor, stock_snapshot, stock_provenance],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurCargoAcquisitionStockSdk",
    )
    return [DefaultInfo(files = depset([descriptor, registry, snapshot, provenance])),
            CargoAcquisitionSdkInfo(descriptor = descriptor, registry = registry, sources = snapshot, provenance = provenance, sdk_files = sdk_files, original_sources = original_sources, stock_descriptor = stock_descriptor, stock_sources = stock_snapshot, stock_provenance = stock_provenance),
            OutputGroupInfo(descriptor = depset([descriptor]), provenance = depset([provenance]))]

cargo_acquisition_sdk = rule(
    implementation = _sdk_impl,
    attrs = {
        "execution_host": attr.string(mandatory = True),
        "source_files": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "source_inputs": attr.label_list(allow_files = True),
        "locks": attr.string_list(mandatory = True),
        "archives": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "_producer": attr.label(default = ":sdk_producer.py", allow_single_file = True),
        "_materializer": attr.label(default = ":sdk_metadata.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def _metadata_impl(ctx):
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    result = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-I", "-B", ctx.file._runner.path, "--descriptor", sdk.descriptor.path,
                     "--source-root", sdk.sources.path, "--manifest", ctx.attr.manifest,
                     "--registry", sdk.registry.path, "--provenance", sdk.provenance.path,
                     "--producer", str(ctx.attr.sdk.label), "--capture", ctx.file._capture.path,
                     "--sdk-resolver", ctx.file._resolver.path, "--output", result.path],
        inputs = depset([sdk.descriptor, sdk.registry, sdk.sources, sdk.provenance, ctx.file._runner, ctx.file._resolver, ctx.file._capture], transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [result],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurCargoAcquisitionMetadata",
    )
    return [DefaultInfo(files = depset([result]))]

cargo_acquisition_metadata = rule(
    implementation = _metadata_impl,
    attrs = {
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True),
        "manifest": attr.string(default = "Cargo.toml"),
        "_runner": attr.label(default = ":sdk_metadata.py", allow_single_file = True),
        "_capture": attr.label(default = ":sdk_producer.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
