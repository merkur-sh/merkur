"""Original-source Rolldown JS glue and compiler-derived NAPI declarations.

This rule consumes the actual native publisher and the original upstream lock
dependency graph. It neither compiles Rust nor exposes frontend attribution.
"""

load("//tools/bazel/rust:rolldown.bzl", "RolldownNativeBindingInfo")
load("//tools/bazel/bun:rules.bzl", "BunNpmSourcesInfo", "bun_test")
load("@aspect_rules_js//npm:providers.bzl", "NpmPackageStoreInfo")

ROLLDOWN_SOURCE_NAMESPACE = "upstream/" + Label("@merkur_rolldown_source//:node_modules").repo_name
VITE_ROLLDOWN_SOURCE_NAMESPACE = "upstream/" + Label("@merkur_vite_rolldown_source//:node_modules").repo_name

RolldownGlueInfo = provider(fields = {
    "package": "Original-source built package TreeArtifact.",
    "declarations": "Actual locked NAPI generator output File.",
    "native": "Actual native binding File consumed by the source build.",
    "type_defs": "Actual compiler-produced JSONL File.",
    "sources": "Original prepared source TreeArtifact.",
    "compiler_context": "Original captured native compiler context File.",
    "inputs": "Declared source, dependency and native input closure.",
    "source_manifest": "Original compiler-selected native package manifest File.",
    "source_manifests": "Original native workspace manifests from the actual compiler dependency closure.",
    "workspace_manifest": "Original native source workspace Cargo manifest File.",
    "workspace_license": "Original native source workspace license File.",
})

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _glue_impl(ctx):
    native = ctx.attr.native_binding[RolldownNativeBindingInfo]
    cli = ctx.attr.napi_cli[NpmPackageStoreInfo]
    if cli.package != "@napi-rs/cli" or cli.version != "3.8.6(@emnapi/core@2.0.0-alpha.4)(@emnapi/runtime@2.0.0-alpha.4)(@types/node@24.10.3)(emnapi@2.0.0-alpha.4)(supports-color@10.2.2)" or cli.package_store_directory == None:
        fail("Rolldown glue requires original locked @napi-rs/cli3.8.6")
    if not native.sources.is_directory or native.type_defs.is_directory:
        fail("Rolldown glue requires native source TreeArtifact and compiler JSONL File")
    dependencies = ctx.attr.js_inputs[DefaultInfo].default_runfiles
    files = depset(transitive = [dependencies.files])
    original_files = {}
    for file in files.to_list():
        logical = _runfile(file)
        previous = original_files.get(logical)
        if previous != None and previous != file.path:
            fail("Rolldown original dependency File identity is ambiguous")
        original_files[logical] = file.path
    if _runfile(cli.package_store_directory) not in original_files:
        fail("Rolldown original CLI File is absent from its declared JS graph")
    workspace_packages = [
        package for package in ctx.attr.js_inputs[BunNpmSourcesInfo].workspace_packages.to_list()
        if package.store != None and package.owner.package == "packages/rolldown" and package.owner.name == "npm_package" and ctx.attr.dependency_namespace == "upstream/" + package.owner.repo_name
    ]
    if len(workspace_packages) != 1:
        fail("Rolldown self-link requires one actual original authored npm_package source/store relation")
    workspace_package = workspace_packages[0]
    if workspace_package.source.owner != workspace_package.owner or _runfile(workspace_package.store) not in original_files:
        fail("Rolldown self-link original source/store File identity is absent from its configured graph")
    repository_prefix = "../" + workspace_package.owner.repo_name + "/"
    if not workspace_package.store.short_path.startswith(repository_prefix):
        fail("Rolldown workspace store belongs to a foreign repository namespace")
    original_files[_runfile(workspace_package.source)] = workspace_package.source.path
    package = ctx.actions.declare_directory(ctx.label.name)
    declarations = ctx.actions.declare_file(ctx.label.name + ".binding.d.cts")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "sources": native.sources.path,
        "native": native.native.path,
        "type_defs": native.type_defs.path,
        "compiler_context": native.compiler_context.path,
        "platform": native.platform,
        "declarations": ctx.file.js_inputs.path,
        "original_files": original_files,
        "dependency_namespace": ctx.attr.dependency_namespace,
        "napi_cli": _runfile(cli.package_store_directory),
        "workspace_source": {
            "input": _runfile(workspace_package.source),
            "owner": str(workspace_package.owner),
            "namespace": ctx.attr.dependency_namespace + "/packages/rolldown",
            "canonical": ctx.attr.dependency_namespace + "/" + workspace_package.store.short_path[len(repository_prefix):],
        },
        "node": ctx.executable._node.path,
        "output": package.path,
        "generated_declarations": declarations.path,
    }))
    inputs = depset(
        [native.native, native.type_defs, native.sources, native.compiler_context,
         workspace_package.source, ctx.file.js_inputs, ctx.file._runner, ctx.file._runtime_materializer, ctx.file._portable_path, ctx.file._config, specification],
        transitive = [native.inputs, files],
    )
    ctx.actions.run(
        executable = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path,
                     ctx.file._runner.path, specification.path],
        inputs = inputs,
        tools = [ctx.attr._node[DefaultInfo].files_to_run],
        outputs = [package, declarations],
        env = {"PATH": "/__no_ambient_path__"},
        use_default_shell_env = False,
        mnemonic = "RolldownSourceJsGlue",
    )
    return [
        DefaultInfo(files = depset([package]), runfiles = ctx.runfiles(files = [package])),
        RolldownGlueInfo(package = package, declarations = declarations, native = native.native,
                         type_defs = native.type_defs, sources = native.sources,
                         compiler_context = native.compiler_context, inputs = inputs,
                         source_manifest = native.source_manifest, source_manifests = native.source_manifests, workspace_manifest = native.workspace_manifest,
                         workspace_license = native.workspace_license),
        OutputGroupInfo(generated_declarations = depset([declarations]), package = depset([package]), sources = depset([native.sources])),
    ]

rolldown_js_glue = rule(
    implementation = _glue_impl,
    attrs = {
        "native_binding": attr.label(providers = [RolldownNativeBindingInfo], mandatory = True, cfg = "exec"),
        "js_inputs": attr.label(allow_single_file = True, mandatory = True, providers = [BunNpmSourcesInfo], cfg = "exec"),
        "napi_cli": attr.label(providers = [NpmPackageStoreInfo], mandatory = True, cfg = "exec"),
        "dependency_namespace": attr.string(mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/bun:rolldown-glue.ts", allow_single_file = True),
        "_runtime_materializer": attr.label(default = "//tools/bazel/bun:rolldown-package-runtime.ts", allow_single_file = True),
        "_portable_path": attr.label(default = "//tools/bazel/bun:portable-path.ts", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
        "_node": attr.label(default = "//tools/bazel/tools:node", executable = True, cfg = "exec"),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def rolldown_native_origin_test(name, glue, **kwargs):
    """Exercise the real source-built moduleParsed API with existing Bun tests."""
    sources = name + "_sources"
    native.filegroup(name = sources, srcs = [glue], output_group = "sources")
    bun_test(
        name = name,
        entry_point = "//tools/bazel/bun:rolldown-native-origin.test.ts",
        test_files = ["tools/bazel/bun/rolldown-native-origin.test.ts"],
        data = [glue, ":" + sources],
        environment_files = {
            glue: "MERKUR_ROLLDOWN_GLUE_PACKAGE",
            ":" + sources: "MERKUR_ROLLDOWN_GLUE_SOURCES",
        },
        **kwargs
    )
