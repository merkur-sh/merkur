"""Rolldown source acquisition and native binding publication foundations.

Graph acquisition is introspection only. The binding consumes a native Rust
cdylib producer; it never starts a Cargo build or admits frontend attribution.
"""
load("//tools/bazel/rust/acquire:sdk_rules.bzl", "CargoAcquisitionSdkInfo")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load("//tools/bazel/rust:units.bzl", "compiler_unit", "build_script_unit")
load("@rules_rust//rust:rust_common.bzl", "TestCrateInfo", "DepInfo")

RolldownNativeBindingInfo = provider(fields = ["native", "type_defs", "sources", "compiler_context", "platform", "inputs", "source_manifest", "source_manifests", "workspace_manifest", "workspace_license"])

def _compiler_environment(kwargs):
    environment = dict(kwargs.get("compiler_env", {}))
    if "WORKSPACE_DIR" in environment:
        fail("Rolldown WORKSPACE_DIR belongs to its original source configuration")
    environment["WORKSPACE_DIR"] = "$${pwd}/" + Label(kwargs.pop("source_manifest", "@merkur_rolldown_source//:Cargo.toml")).workspace_root
    return environment

def rolldown_compiler_unit(**kwargs):
    kwargs["compiler_env"] = _compiler_environment(kwargs)
    if kwargs["crate_name"] == "rolldown_binding":
        _native_preload_inputs(kwargs)
    if kwargs["emit_cdylib"]:
        if kwargs["crate_name"] != "rolldown_binding":
            fail("Only the actual Rolldown binding compiler emits NAPI metadata")
        kwargs["napi_type_defs"] = True
    compiler_unit(**kwargs)

def _native_preload_inputs(kwargs):
    # Native NAPI owns invoking the original configured generator. Its included
    # source and prepared script are compiler inputs, not caller supplied code.
    inputs = {
        "SCRIPT": "//tools/bazel/bun:vite_preload_script",
        "SOURCE": "//tools/bazel/bun:vite_published_preload_source",
        "EXTRACTOR": "//tools/bazel/bun:vite-preload-generator.ts",
    }
    environment = kwargs["compiler_env"]
    for role, label in inputs.items():
        for variable, value in {
            # rules_rust adds the execution-time ${pwd} prefix exactly once.
            "MERKUR_VITE_PRELOAD_" + role: "$(execpath " + label + ")",
            "MERKUR_VITE_PRELOAD_" + role + "_PATH": "$(rootpath " + label + ")",
        }.items():
            if variable in environment:
                fail("Native Vite generator inputs belong to the declared compiler action")
            environment[variable] = value
    # The native hook embeds this original cross-package source verbatim.
    # Its Rust dependency does not declare the source File for this action.
    plugin_source = (
        "@@" + Label(kwargs["crate_root"]).repo_name +
        "//crates/rolldown_plugin_vite_build_import_analysis:src/lib.rs"
    )
    kwargs["macro_data"] = kwargs.get("macro_data", []) + inputs.values() + [plugin_source]

def rolldown_build_script_unit(**kwargs):
    kwargs["compiler_env"] = _compiler_environment(kwargs)
    native_build = kwargs.pop("native_build", None)
    if native_build != None:
        if native_build != "cmake" or kwargs["pkg_name"] != "libmimalloc-sys2" or kwargs["version"] != "0.1.60":
            fail("Only the exact original allocator build uses the declared CMake SDK")
        if kwargs.get("build_tools") or kwargs.get("build_data"):
            fail("Rolldown native build tool inputs belong to the original allocator binding")
        host = _NATIVE_TOOL_HOSTS[kwargs["execution_host"]]
        cmake = "//tools/bazel/tools/native:build_cmake_" + host
        make = "//tools/bazel/tools/native:build_make_" + host
        shell = "//tools/bazel/tools/native:build_bash_" + host
        uname = "//tools/bazel/tools/native:build_uname_" + host
        driver = "//tools/bazel/rust:declared_cmake_driver"
        make_driver = driver + "_make"
        toolchain = kwargs["name"] + "_cmake_toolchain"
        _cmake_toolchain(
            name = toolchain,
            platform = kwargs["platform"],
            execution_host = kwargs["execution_host"],
            shell = shell,
            tags = ["manual"],
        )
        if kwargs["execution_host"].endswith("apple-darwin"):
            environment_target = toolchain + "_environment"
            native.filegroup(
                name = environment_target,
                srcs = [":" + toolchain],
                output_group = "environment",
                tags = ["manual"],
            )
            kwargs["build_script_env_files"] = kwargs.get("build_script_env_files", []) + [":" + environment_target]
        environment = kwargs["compiler_env"]
        for variable, value in {
            "CMAKE": "$(execpath " + driver + ")",
            "MERKUR_CMAKE_EXECUTABLE": "$(execpath " + cmake + ")",
            "MERKUR_CMAKE_UNAME": "$(execpath " + uname + ")",
            "CMAKE_GENERATOR": "Unix Makefiles",
            "CMAKE_TOOLCHAIN_FILE": "$(execpath :" + toolchain + ")",
            "MERKUR_CMAKE_MAKE": "$(execpath " + make_driver + ")",
            "MERKUR_CMAKE_MAKE_EXECUTABLE": "$(execpath " + make + ")",
            "MERKUR_CMAKE_SHELL": "$(execpath " + shell + ")",
        }.items():
            if variable in environment:
                fail("Rolldown native build tool environment is owned by its declared SDK")
            environment[variable] = value
        # CMake clears MAKEFLAGS for compiler probes. The native Make driver
        # supplies the declared shell as a command-line variable instead;
        # original request arguments and jobserver environment remain intact.
        # Pinned rules_rust declares full runtime closures from data; its tools
        # attribute participates in location expansion but not action inputs.
        kwargs["build_data"] = [driver, make_driver, cmake, make, shell, uname, ":" + toolchain]
    build_script_unit(**kwargs)

_NATIVE_TOOL_HOSTS = {
    "aarch64-apple-darwin": "darwin_arm64",
    "x86_64-apple-darwin": "darwin_x64",
    "aarch64-unknown-linux-gnu": "linux_arm64",
    "x86_64-unknown-linux-gnu": "linux_x64",
}

def _cmake_toolchain_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".cmake")
    contents = """# The original allocator build consumes only its declared native tools.
foreach(variable CC CXX AR MERKUR_CMAKE_MAKE)
  if("$ENV{${variable}}" STREQUAL "")
    message(FATAL_ERROR "Missing declared native tool: ${variable}")
  endif()
endforeach()
set(CMAKE_C_COMPILER "$ENV{CC}" CACHE FILEPATH "")
set(CMAKE_CXX_COMPILER "$ENV{CXX}" CACHE FILEPATH "")
set(CMAKE_AR "$ENV{AR}" CACHE FILEPATH "")
set(CMAKE_MAKE_PROGRAM "$ENV{MERKUR_CMAKE_MAKE}" CACHE FILEPATH "")
"""
    if ctx.attr.platform.endswith("apple-darwin"):
        contents += """if("$ENV{SDKROOT}" STREQUAL "")
  message(FATAL_ERROR "Missing declared Apple SDKROOT")
endif()
set(CMAKE_OSX_SYSROOT "$ENV{SDKROOT}" CACHE PATH "")
"""
    ctx.actions.write(output, contents)
    environment_files = []
    if ctx.attr.execution_host.endswith("apple-darwin"):
        shell = ctx.attr.shell[NativeSdkInfo].binary
        if not shell.path.endswith("/bin/bash"):
            fail("Original native build shell must belong to its declared SDK bin namespace")
        environment = ctx.actions.declare_file(ctx.label.name + ".env")
        prefix = shell.path.rsplit("/bin/", 1)[0]
        ctx.actions.write(environment, "DYLD_FALLBACK_LIBRARY_PATH=${pwd}/" + prefix + "/lib\n")
        environment_files.append(environment)
    return [DefaultInfo(files = depset([output])), OutputGroupInfo(environment = depset(environment_files))]

_cmake_toolchain = rule(
    implementation = _cmake_toolchain_impl,
    attrs = {
        "platform": attr.string(values = sorted(_NATIVE_TOOL_HOSTS.keys()), mandatory = True),
        "execution_host": attr.string(values = sorted(_NATIVE_TOOL_HOSTS.keys()), mandatory = True),
        "shell": attr.label(providers = [NativeSdkInfo], mandatory = True),
    },
)

_PLATFORMS = {
    "aarch64-apple-darwin": ("darwin-arm64", ["@platforms//cpu:aarch64", "@platforms//os:macos"]),
    "x86_64-apple-darwin": ("darwin-x64", ["@platforms//cpu:x86_64", "@platforms//os:macos"]),
    "aarch64-unknown-linux-gnu": ("linux-arm64-gnu", ["@platforms//cpu:aarch64", "@platforms//os:linux"]),
    "x86_64-unknown-linux-gnu": ("linux-x64-gnu", ["@platforms//cpu:x86_64", "@platforms//os:linux"]),
}

def _context_impl(ctx):
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    arguments = ["-B", "-I", ctx.file._runner.path, "acquire",
                 "--descriptor", sdk.descriptor.path, "--source-root", sdk.sources.path,
                 "--registry", sdk.registry.path, "--provenance", sdk.provenance.path,
                 "--producer", str(ctx.attr.sdk.label), "--source-archive", ctx.file.source_archive.path,
                 "--sdk-resolver", ctx.file._resolver.path, "--contexts", ctx.file._contexts.path,
                 "--parity", ctx.file._parity.path, "--materializer", ctx.file._materializer.path,
                 "--capture", ctx.file._capture.path, "--output", output.path,
                 "--source-instances", ctx.file._source_instances.path, "--source-instance", ctx.attr.source_instance]
    inputs = [sdk.descriptor, sdk.sources, sdk.registry, sdk.provenance, ctx.file.source_archive,
              ctx.file._runner, ctx.file._resolver, ctx.file._contexts, ctx.file._parity,
              ctx.file._materializer, ctx.file._capture, ctx.file._source_instances]
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = arguments,
        inputs = depset(inputs, transitive = [sdk.sdk_files]),
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output],
        env = {},
        use_default_shell_env = False,
        mnemonic = "RolldownCompilerContext",
    )
    return [DefaultInfo(files = depset([output]))]

rolldown_compiler_context = rule(
    implementation = _context_impl,
    attrs = {
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True),
        "source_archive": attr.label(allow_single_file = True, mandatory = True),
        "source_instance": attr.string(mandatory = True),
        "_source_instances": attr.label(default = "//tools/bazel/rust:rolldown-source-instances.json", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/rust:rolldown_acquire.py", allow_single_file = True),
        "_resolver": attr.label(default = "//tools/bazel/rust:acquisition_sdk.py", allow_single_file = True),
        "_contexts": attr.label(default = "//tools/bazel/rust:contexts.py", allow_single_file = True),
        "_parity": attr.label(default = "//tools/bazel/rust:configured_parity.py", allow_single_file = True),
        "_materializer": attr.label(default = "//tools/bazel/rust/acquire:sdk_metadata.py", allow_single_file = True),
        "_capture": attr.label(default = "//tools/bazel/rust/acquire:sdk_producer.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)

def _binding_impl(ctx):
    crate = ctx.attr.library[TestCrateInfo].crate
    if crate.type != "cdylib" or crate.name != "rolldown_binding":
        fail("Rolldown binding requires its actual native Rust cdylib producer")
    sdk = ctx.attr.sdk[CargoAcquisitionSdkInfo]
    package = crate.root.owner.package
    if package != "crates/rolldown_binding" or not crate.root.is_source:
        fail("Rolldown native association requires its original compiler-selected source root")
    source_manifest = sdk.original_sources.get(package + "/Cargo.toml")
    workspace_manifest = sdk.original_sources.get("Cargo.toml")
    workspace_license = sdk.original_sources.get("LICENSE")
    for file, member in [(source_manifest, package + "/Cargo.toml"), (workspace_manifest, "Cargo.toml"), (workspace_license, "LICENSE")]:
        if file == None or not file.is_source or file.is_directory or file.is_symlink or file.owner.repo_name != crate.root.owner.repo_name or file.owner.workspace_root + "/" + member != file.path:
            fail("Rolldown native original manifest/license differs from its compiler source SDK")
    if source_manifest not in crate.compile_data.to_list():
        fail("Rolldown native manifest is absent from its actual compiler input closure")
    source_manifests = {source_manifest.owner: source_manifest}
    for dependency in ctx.attr.library[DepInfo].transitive_crates.to_list():
        if dependency.root.owner.repo_name != crate.root.owner.repo_name:
            continue
        member = dependency.root.owner.package + "/Cargo.toml"
        manifest = sdk.original_sources.get(member)
        if manifest == None or manifest not in dependency.compile_data.to_list() or not manifest.is_source or manifest.is_directory or manifest.is_symlink or manifest.owner.repo_name != crate.root.owner.repo_name or manifest.owner.workspace_root + "/" + member != manifest.path:
            fail("Rolldown native dependency manifest differs from its identical selected compiler/SDK File")
        previous = source_manifests.get(manifest.owner)
        if previous != None and previous != manifest:
            fail("Rolldown native source manifest identity is duplicated")
        source_manifests[manifest.owner] = manifest
    output = ctx.actions.declare_file("rolldown-binding." + _PLATFORMS[ctx.attr.platform][0] + ".node")
    if OutputGroupInfo not in ctx.attr.library or not hasattr(ctx.attr.library[OutputGroupInfo], "napi_type_defs_file"):
        fail("Rolldown binding requires the exact original NAPI File from its Rust compiler action")
    definitions = ctx.attr.library[OutputGroupInfo].napi_type_defs_file.to_list()
    if len(definitions) != 1 or definitions[0].is_directory or definitions[0].is_symlink:
        fail("Rolldown compiler must declare exactly one ordinary NAPI metadata File")
    metadata = ctx.actions.declare_file(ctx.label.name + ".napi.jsonl")
    ctx.actions.run(
        executable = ctx.executable._python,
        arguments = ["-B", "-I", ctx.file._runner.path, "publish-binding", "--input", crate.output.path,
                     "--output", output.path, "--platform", ctx.attr.platform,
                     "--type-defs-file", definitions[0].path, "--metadata-output", metadata.path],
        inputs = [crate.output, definitions[0], ctx.file._runner],
        tools = [ctx.attr._python[DefaultInfo].files_to_run],
        outputs = [output, metadata],
        env = {},
        use_default_shell_env = False,
        mnemonic = "RolldownNativeBinding",
    )
    return [DefaultInfo(files = depset([output, metadata])),
            RolldownNativeBindingInfo(native = output, type_defs = metadata,
                                     sources = sdk.sources, compiler_context = ctx.file.compiler_context,
                                     platform = ctx.attr.platform,
                                     source_manifest = source_manifest, source_manifests = depset(source_manifests.values()), workspace_manifest = workspace_manifest,
                                     workspace_license = workspace_license,
                                     inputs = depset([output, metadata, sdk.sources, sdk.registry, sdk.descriptor,
                                                      sdk.provenance, ctx.file.compiler_context, source_manifest,
                                                      workspace_manifest, workspace_license],
                                                     transitive = [depset(source_manifests.values()), sdk.sdk_files, ctx.attr.library[DefaultInfo].files])),
            OutputGroupInfo(native = depset([output]))]

_binding = rule(
    implementation = _binding_impl,
    attrs = {
        "library": attr.label(providers = [TestCrateInfo, DepInfo], mandatory = True),
        "platform": attr.string(values = sorted(_PLATFORMS.keys()), mandatory = True),
        "sdk": attr.label(providers = [CargoAcquisitionSdkInfo], mandatory = True),
        "compiler_context": attr.label(allow_single_file = True, mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/rust:rolldown_acquire.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)

def rolldown_native_binding(name, library, platform, **kwargs):
    _binding(name = name, library = library, platform = platform, target_compatible_with = _PLATFORMS[platform][1], **kwargs)
