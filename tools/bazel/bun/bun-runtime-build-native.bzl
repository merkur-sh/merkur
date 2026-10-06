"""Same-action original Bun native compiler outputs; no selected-source provider."""

load("//tools/bazel/bun:bun-runtime-llvm.bzl", "bun_runtime_llvm_inputs", "bun_runtime_llvm_sdk_attr")
load("//tools/bazel/tools/native:providers.bzl", "DarwinCompilerSdkInfo", "NativeSdkInfo")

def _runtime_library_sdk(target):
    sdk = target[NativeSdkInfo]
    info = target[DefaultInfo]
    files = depset(transitive = [info.files, info.default_runfiles.files]).to_list()
    namespace = {}
    members = []
    tree = False
    for file in files:
        runfile = file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path
        if runfile == sdk.prefix_runfile:
            if not file.is_directory:
                fail("Runtime SDK namespace root must be its actual TreeArtifact")
            namespace[file.path] = True
            members.append(file.path)
            tree = True
        elif runfile.startswith(sdk.prefix_runfile + "/"):
            relative = runfile[len(sdk.prefix_runfile):]
            if not file.path.endswith(relative):
                fail("Runtime SDK File does not match its typed original namespace")
            namespace[file.path[:-len(relative)]] = True
            members.append(file.path)
    if len(namespace) != 1 or not members:
        fail("Runtime SDK has no unique actual declared namespace")
    root = namespace.keys()[0]
    if not tree and not any([file.startswith(root + "/lib/") for file in members]):
        fail("Runtime SDK has no declared original library members")
    return struct(
        specification = {"namespace": root, "root": root + "/lib", "files": members},
        inputs = depset(transitive = [info.files, info.default_runfiles.files]),
    )

def _native_impl(ctx):
    if ctx.attr.dsym_jobs <= 0:
        fail("Original dsymutil requires a positive declared CPU count")
    runtime = ctx.actions.declare_file(ctx.label.name + ".bun")
    build_tree = ctx.actions.declare_directory(ctx.label.name + ".original-build")
    native_configuration = ctx.actions.declare_file(ctx.label.name + ".native-configuration.json")
    specification = ctx.actions.declare_file(ctx.label.name + ".request.json")
    llvm = bun_runtime_llvm_inputs(ctx)
    npm_groups = ctx.attr.npm_cache[OutputGroupInfo]
    catalogs = npm_groups.original_catalog.to_list()
    npm_pins = npm_groups.original_pins.to_list()
    if len(catalogs) != 1 or catalogs[0].is_directory or len(npm_pins) != 1 or npm_pins[0].is_directory:
        fail("Native embedded npm sources require the original archive catalog/pins Files")
    npm_archives = npm_groups.original_archives
    if not npm_archives.to_list():
        fail("Native embedded npm sources require original locked archive Files")
    publisher_inputs = {}
    publisher_files = []
    for role, targets in [("metadata", ctx.attr.npm_publisher_metadata), ("source", ctx.attr.npm_publisher_sources)]:
        identities = {}
        for target, identity in targets.items():
            files = target[DefaultInfo].files.to_list()
            if len(files) != 1 or files[0].is_directory or identity in identities:
                fail("Original npm publisher " + role + " requires one unique File per locked identity")
            identities[identity] = True
            if identity not in publisher_inputs:
                publisher_inputs[identity] = {}
            publisher_inputs[identity][role] = files[0].path
            publisher_files += files
    if not publisher_inputs or any([len(value) != 2 for value in publisher_inputs.values()]):
        fail("Original npm publisher metadata/source identity sets differ or are absent")
    direct = [ctx.file.source_archive, ctx.file.registry,
              ctx.file.npm_cache, ctx.file._runner, ctx.file._engine,
              ctx.file._source_builder, ctx.file._pins, ctx.file._build_pins,
              ctx.file._custody, ctx.file._deployment, ctx.file._output_tree, ctx.file._dsym_patch, ctx.file._embedded_patch,
              ctx.file._workspace_manifest, ctx.file._workspace_license, ctx.file._generated_inputs, ctx.file._linked_sources, ctx.file._npm_origins, ctx.file._npm_collector, ctx.file._npm_publisher_pins, ctx.file._npm_publisher_selector] + catalogs + npm_pins + publisher_files
    direct += ctx.files._modules
    tools = {"bun": ctx.executable.bun.path, "python": ctx.executable._python.path,
             "cmake": ctx.executable.cmake.path}
    direct += [ctx.executable.bun, ctx.executable._python, ctx.executable.cmake]
    nightly_files = ctx.attr.nightly[DefaultInfo].files.to_list()
    nightly_namespace = ctx.attr.nightly.label.workspace_root + "/sdk"
    if not nightly_files or any([not file.path.startswith(nightly_namespace + "/") for file in nightly_files]):
        fail("Native Bun nightly requires its original complete repository SDK Files")
    nightly_archives = ctx.files.nightly_archives
    if not nightly_archives:
        fail("Native Bun requires the original pinned nightly archive carriers")
    direct += nightly_files + nightly_archives
    sdk_target = ctx.attr.sysroot
    if DarwinCompilerSdkInfo in sdk_target:
        darwin = sdk_target[DarwinCompilerSdkInfo]
        sysroot_namespace = darwin.root
        sysroot = darwin.root + "/" + darwin.sysroot
        sysroot_files = darwin.members.values()
        sysroot_inputs = darwin.files
    else:
        files = sdk_target[DefaultInfo].files.to_list()
        if len(files) != 1 or not files[0].is_directory:
            fail("Native Bun sysroot requires original Darwin SDK Files or a genuine Linux SDK Tree")
        sysroot_namespace = files[0].path
        sysroot = files[0].path
        sysroot_files = files
        sysroot_inputs = sdk_target[DefaultInfo].files
    libraries = [_runtime_library_sdk(target) for target in ctx.attr.runtime_library_roots]
    sdk_inputs = [library.inputs for library in libraries] + [sysroot_inputs, ctx.attr.bun[DefaultInfo].files, ctx.attr.bun[DefaultInfo].default_runfiles.files,
                  ctx.attr._python[DefaultInfo].files, ctx.attr._python[DefaultInfo].default_runfiles.files,
                  ctx.attr.cmake[DefaultInfo].files, ctx.attr.cmake[DefaultInfo].default_runfiles.files]
    for target, name in ctx.attr.tools.items():
        if name in tools:
            fail("Original native Bun utility name is repeated: " + name)
        binary = target[NativeSdkInfo].binary
        tools[name] = binary.path
        direct.append(binary)
        info = target[DefaultInfo]
        sdk_inputs += [info.files, info.default_runfiles.files]
    dependencies = {}
    dependency_archives = []
    for target, name in ctx.attr.dependencies.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or name in dependencies:
            fail("Original native Bun dependency requires one unique archive File")
        dependencies[name] = files[0].path
        direct += files
        dependency_archives += files
    if "webkit" in dependencies:
        fail("Original WebKit archive has a dedicated existing pin boundary")
    direct.append(ctx.file.webkit_archive)
    inputs = depset(direct, transitive = [llvm.inputs, npm_archives] + sdk_inputs)
    ctx.actions.write(specification, json.encode({
        "source_archive": ctx.file.source_archive.path,
        "dsym_patch": ctx.file._dsym_patch.path,
        "embedded_patch": ctx.file._embedded_patch.path,
        "generated_inputs": ctx.file._generated_inputs.path,
        "npm_origins": ctx.file._npm_origins.path,
        "npm_collector": ctx.file._npm_collector.path,
        "npm_catalog": catalogs[0].path,
        "npm_pins": npm_pins[0].path,
        "npm_publisher_pins": ctx.file._npm_publisher_pins.path,
        "npm_publisher_selector": ctx.file._npm_publisher_selector.path,
        "npm_publisher_inputs": publisher_inputs,
        "linked_sources": ctx.file._linked_sources.path,
        "dsym_jobs": ctx.attr.dsym_jobs,
        "nightly": nightly_namespace,
        "nightly_namespace": nightly_namespace,
        "nightly_files": [file.path for file in nightly_files],
        "nightly_archives": [file.path for file in nightly_archives],
        "registry": ctx.file.registry.path,
        "npm_cache": ctx.file.npm_cache.path,
        "sysroot": sysroot,
        "sysroot_namespace": sysroot_namespace,
        "sysroot_files": [file.path for file in sysroot_files],
        "runtime_library_roots": [{"namespace": nightly_namespace,
                                   "root": nightly_namespace + "/lib",
                                   "files": [file.path for file in nightly_files]}] +
                                 [library.specification for library in libraries],
        "llvm_root": llvm.environment["BUN_TOOLCHAIN_LLVM"],
        "llvm_manifest": llvm.manifest.path,
        "llvm_tools": {name: file.path for name, file in llvm.tools.items()},
        "tools": tools,
        "declared_files": [file.path for file in inputs.to_list()],
        "dependency_files": dependencies,
        "webkit": {"file": ctx.file.webkit_archive.path,
                   "url": ctx.attr.webkit_pin["url"],
                   "sha256": ctx.attr.webkit_pin["sha256"]},
        "build_pins": ctx.file._build_pins.path,
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, specification.path,
                     build_tree.path, runtime.path, ctx.file._engine.path, ctx.file._pins.path,
                     ctx.file._source_builder.path, ctx.file._custody.path,
                     ctx.file._deployment.path, ctx.file._output_tree.path, native_configuration.path],
        inputs = depset([specification], transitive = [inputs]),
        outputs = [runtime, build_tree, native_configuration],
        mnemonic = "OriginalBunNativeRuntime",
        progress_message = "Compile the original Bun native release graph %{label}",
        execution_requirements = {"block-network": "1"},
    )
    # The runtime can only become a production compiler input after native
    # qualification. Available build outputs assert no selected notice scope.
    return [DefaultInfo(executable = runtime, files = depset([runtime]), runfiles = ctx.runfiles(files = [runtime])),
            OutputGroupInfo(
                original_build = depset([build_tree]),
                native_configuration = depset([native_configuration]),
                native_request = depset([specification]),
                generator_runtime = depset([ctx.executable.bun]),
                # These are actual same-action origins and causal outputs.
                # Membership asserts no retained-source or notice selection.
                runtime_attribution_inputs = depset(
                    [build_tree, native_configuration, specification, ctx.file.source_archive, ctx.file.registry,
                     ctx.file.npm_cache, ctx.file.webkit_archive, ctx.file._pins,
                     ctx.file._build_pins, ctx.file._dsym_patch, ctx.file._embedded_patch,
                      ctx.file._workspace_manifest, ctx.file._workspace_license, ctx.file._npm_publisher_pins, ctx.file._npm_publisher_selector] + publisher_files + nightly_files + nightly_archives + dependency_archives,
                    transitive = [sysroot_inputs, llvm.inputs, npm_archives,
                                  npm_groups.original_catalog, npm_groups.original_pins] + sdk_inputs,
                ),
            )]

bun_runtime_build_native = rule(
    implementation = _native_impl,
    executable = True,
    attrs = {
        "llvm_sdk": bun_runtime_llvm_sdk_attr(),
        "dsym_jobs": attr.int(mandatory = True),
        "bun": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "cmake": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "source_archive": attr.label(default = "@bun_runtime_source_archive//file", allow_single_file = True),
        "nightly": attr.label(mandatory = True, cfg = "exec"),
        "nightly_archives": attr.label(mandatory = True, allow_files = True, cfg = "exec"),
        "registry": attr.label(mandatory = True, allow_single_file = True),
        "npm_cache": attr.label(mandatory = True, allow_single_file = True),
        "npm_publisher_metadata": attr.label_keyed_string_dict(mandatory = True, allow_files = True),
        "npm_publisher_sources": attr.label_keyed_string_dict(mandatory = True, allow_files = True),
        "_npm_publisher_pins": attr.label(default = "//tools/bazel/bun:npm_publisher_licenses/pins.json", allow_single_file = True),
        "_npm_publisher_selector": attr.label(default = "//tools/bazel/bun:npm_publisher_licenses/select.py", allow_single_file = True),
        "sysroot": attr.label(mandatory = True, cfg = "exec"),
        "runtime_library_roots": attr.label_list(providers = [NativeSdkInfo], cfg = "exec"),
        "tools": attr.label_keyed_string_dict(mandatory = True, providers = [NativeSdkInfo], cfg = "exec"),
        "dependencies": attr.label_keyed_string_dict(mandatory = True, allow_files = True),
        "webkit_archive": attr.label(mandatory = True, allow_single_file = True),
        "webkit_pin": attr.string_dict(mandatory = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/bun:bun-runtime-build-native.py", allow_single_file = True),
        "_npm_origins": attr.label(default = "//tools/bazel/bun:bun-runtime-generated-origins.py", allow_single_file = True),
        "_npm_collector": attr.label(default = "//tools/bazel/bun:bun-runtime-build-npm.py", allow_single_file = True),
        "_generated_inputs": attr.label(default = "//tools/bazel/bun:bun-runtime-generated-inputs.py", allow_single_file = True),
        "_linked_sources": attr.label(default = "//tools/bazel/bun:bun-runtime-linked-sources.py", allow_single_file = True),
        "_workspace_manifest": attr.label(default = "//:package.json", allow_single_file = True),
        "_workspace_license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "_embedded_patch": attr.label(default = "//tools/bazel/bun:bun-runtime-build-embedded-inputs.patch", allow_single_file = True),
        "_dsym_patch": attr.label(default = "//tools/bazel/bun:bun-runtime-build-dsym-jobs.patch", allow_single_file = True),
        "_engine": attr.label(default = "//tools/bazel/bun:bun-runtime-build-native.ts", allow_single_file = True),
        "_source_builder": attr.label(default = "//tools/bazel/bun:bun-runtime-build.py", allow_single_file = True),
        "_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution-pins.json", allow_single_file = True),
        "_build_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-build-pins.json", allow_single_file = True),
        "_custody": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution.py", allow_single_file = True),
        "_deployment": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_output_tree": attr.label(default = "//tools/bazel/packaging:output-tree.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
    },
)
