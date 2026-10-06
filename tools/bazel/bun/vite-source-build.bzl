"""Declared original Vite source build and original published generator member."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageStoreInfo", "NpmPackageInfo")
load(":rolldown-glue.bzl", "RolldownGlueInfo")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")

load(":source-providers.bzl", "ViteSourceBuildInfo")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _vite_build_impl(ctx):
    glue = ctx.attr.rolldown[RolldownGlueInfo]
    if NativeSdkInfo not in ctx.attr._git:
        fail("Original Vite source build requires a declared native Git SDK")
    sdk = ctx.attr._git[NativeSdkInfo]
    if not sdk.binary.dirname.endswith("/bin") or _runfile(sdk.binary).rsplit("/bin/", 1)[0] != sdk.prefix_runfile:
        fail("Declared Git SDK prefix and original executable File disagree")
    sdk_files = ctx.attr._git[DefaultInfo].default_runfiles.files
    files = ctx.attr.js_inputs[DefaultInfo].default_runfiles.files
    original_files = {}
    for file in files.to_list():
        logical = _runfile(file)
        if logical in original_files and original_files[logical] != file.path:
            fail("Original Vite dependency File identity is ambiguous")
        original_files[logical] = file.path
    output = ctx.actions.declare_directory(ctx.label.name)
    selection = ctx.actions.declare_file(ctx.label.name + ".source-selection.json")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "operation": "qualify" if ctx.attr._qualify_output_parity else "build",
        "declarations": ctx.file.js_inputs.path,
        "original_files": original_files,
        "source_namespace": ctx.attr.source_namespace,
        "source_patch": ctx.file.source_patch.path,
        "rolldown": glue.package.path,
        "rolldown_sources": glue.sources.path,
        "native": glue.native.path,
        "compiler_context": glue.compiler_context.path,
        "preload": ctx.file.preload.path,
        "git": sdk.binary.path,
        "git_sdk": sdk.binary.dirname[:-4],
        "bun_config": ctx.file._config.path,
        "output": output.path,
        "selection": selection.path,
    }))
    inputs = depset(
        [ctx.file.js_inputs, ctx.file.source_patch, ctx.file.preload, glue.package,
         glue.sources, glue.native, glue.type_defs, glue.compiler_context,
         ctx.file._runner, ctx.file._config, specification, sdk.binary],
        transitive = [files, glue.inputs, sdk_files],
    )
    ctx.actions.run(
        executable = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path,
                     ctx.file._runner.path, specification.path],
        inputs = inputs,
        tools = [ctx.attr._git[DefaultInfo].files_to_run],
        outputs = [output, selection],
        env = {"PATH": "/__no_ambient_path__", "HOME": "/__no_ambient_home__"},
        use_default_shell_env = False,
        mnemonic = "ViteOriginalSourceBuild",
    )
    return [
        DefaultInfo(files = depset([output])),
        ViteSourceBuildInfo(tree = output,
                           package_directory = ctx.attr.source_namespace + "/packages/vite",
                           inputs = inputs, native = glue.native, preload = ctx.file.preload,
                           source_manifest = glue.source_manifest, source_manifests = glue.source_manifests, workspace_manifest = glue.workspace_manifest,
                           workspace_license = glue.workspace_license),
        OutputGroupInfo(frontend_source_selection = depset([selection]),
                        declarations = depset([ctx.file.js_inputs]),
                        generator = depset([ctx.file.preload]), native = depset([glue.native])),
    ]

_SOURCE_BUILD_ATTRS = {
    "js_inputs": attr.label(allow_single_file = True, mandatory = True, cfg = "exec"),
    "rolldown": attr.label(providers = [RolldownGlueInfo], mandatory = True, cfg = "exec"),
    "preload": attr.label(allow_single_file = True, mandatory = True, cfg = "exec"),
    "source_patch": attr.label(allow_single_file = True, mandatory = True),
    "source_namespace": attr.string(mandatory = True),
    "_runner": attr.label(default = "//tools/bazel/bun:vite-source-build.ts", allow_single_file = True),
    "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    "_git": attr.label(default = "//tools/bazel/tools:git", executable = True, cfg = "exec"),
}

vite_source_build = rule(
    implementation = _vite_build_impl,
    attrs = dict(_SOURCE_BUILD_ATTRS, _qualify_output_parity = attr.bool(default = False)),
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

# This separate causal qualification action preserves the production build cost.
vite_source_build_parity = rule(
    implementation = _vite_build_impl,
    attrs = dict(_SOURCE_BUILD_ATTRS, _qualify_output_parity = attr.bool(default = True)),
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def _published_package_source_impl(_target, ctx):
    # The pinned npm_package_store source is the original NpmPackageInfo,
    # rather than the reconstructed directory carrier seen by sandbox children.
    source = getattr(ctx.rule.attr, "src", None)
    if source != None and NpmPackageInfo in source:
        return [source[NpmPackageInfo]]
    return []

_published_package_source = aspect(
    implementation = _published_package_source_impl,
    provides = [NpmPackageInfo],
)

def _published_chunk_impl(ctx):
    package = ctx.attr.package[NpmPackageStoreInfo]
    if package.package != "vite" or package.version != "8.2.2(@types/node@25.6.0)(jiti@2.6.1)" or package.package_store_directory == None:
        fail("Published preload source requires the actual original locked Vite8.2.2 store")
    original = ctx.attr.package[NpmPackageInfo]
    if original.package != "vite" or original.version != package.version or original.src.is_directory or original.src.extension not in ["tgz", "gz"]:
        fail("Published preload source requires its original npm archive File")
    output = ctx.actions.declare_file(ctx.label.name + ".js")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "operation": "extract",
        "package": package.package_store_directory.path,
        "source_archive": original.src.path,
        "output": output.path,
    }))
    ctx.actions.run(
        executable = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path,
                     ctx.file._runner.path, specification.path],
        inputs = [package.package_store_directory, original.src, ctx.file._runner, ctx.file._config, specification],
        outputs = [output],
        env = {"PATH": "/__no_ambient_path__", "HOME": "/__no_ambient_home__"},
        use_default_shell_env = False,
        mnemonic = "ViteOriginalPublishedPreloadSource",
    )
    return [DefaultInfo(files = depset([output])),
            OutputGroupInfo(original_package = depset([package.package_store_directory]), original_archive = depset([original.src]))]

vite_published_preload_source = rule(
    implementation = _published_chunk_impl,
    attrs = {
        "package": attr.label(providers = [NpmPackageStoreInfo, NpmPackageInfo], aspects = [_published_package_source], mandatory = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/bun:vite-source-build.ts", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)
