"""Original Bun native build sources, separate from selected runtime attribution."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

def _tool_origins_impl(ctx):
    pins = json.decode(ctx.read(Label("//tools/bazel/bun:bun-runtime-build-pins.json")))
    manifest = pins["nightly"]["manifest"]
    http_file(name = "bun_rust_nightly_manifest", urls = [manifest["url"]], sha256 = manifest["sha256"])
    for component, value in pins["nightly"]["components"].items():
        for target, archive in value["targets"].items():
            suffix = "source" if target == "*" else target.replace("-", "_")
            http_file(
                name = "bun_nightly_" + component.replace("-", "_") + "_" + suffix,
                urls = [archive["url"]],
                sha256 = archive["sha256"],
            )
    # LLVM source/executable SDK acquisition belongs to the dedicated LLVM SDK
    # producer. Keep its exact original pin here as the required build contract.
    for name, archive in pins["dependencies"].items():
        http_file(
            name = "bun_build_dep_" + name.replace("-", "_"),
            urls = [archive["url"]],
            sha256 = archive["sha256"],
        )
    # Four WebKit archives are already acquired by bun runtime-archives.bzl.
    # Original archive acquisition does not grant an executable SDK or source
    # selection provider. Those require actual declared build actions separately.
    return ctx.extension_metadata(reproducible = True)

bun_runtime_build_tool_origins = module_extension(implementation = _tool_origins_impl)

def _sources_impl(ctx):
    sources = ctx.actions.declare_directory(ctx.label.name + ".sources")
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, ctx.file.source_archive.path,
                     ctx.file._pins.path, sources.path, ctx.file._custody.path,
                     ctx.file._deployment.path, ctx.file._output_tree.path],
        inputs = depset([ctx.file.source_archive, ctx.file._runner, ctx.file._pins,
                         ctx.file._custody, ctx.file._deployment, ctx.file._output_tree] + ctx.files._modules),
        outputs = [sources],
        mnemonic = "OriginalBunNativeBuildSources",
        progress_message = "Materialize original Bun native build inputs %{label}",
    )
    # Source availability grants no selected runtime notice scope.
    return [DefaultInfo(files = depset([sources])),
            OutputGroupInfo(original_sources = depset([sources]))]

bun_runtime_build_sources = rule(
    implementation = _sources_impl,
    attrs = {
        "source_archive": attr.label(default = "@bun_runtime_source_archive//file", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/bun:bun-runtime-build.py", allow_single_file = True),
        "_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution-pins.json", allow_single_file = True),
        "_custody": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_deployment": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_output_tree": attr.label(default = "//tools/bazel/packaging:output-tree.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
    },
)

def _requirements_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".source-requirements.json")
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, "--requirements",
                     ctx.file.source_archive.path, ctx.file._pins.path, output.path,
                     ctx.file._custody.path, ctx.file._deployment.path, ctx.file._output_tree.path,
                     ctx.file._engine.path, ctx.executable.bun.path],
        inputs = depset([ctx.file.source_archive, ctx.file._runner, ctx.file._pins,
                         ctx.file._custody, ctx.file._deployment, ctx.file._output_tree,
                         ctx.file._engine] + ctx.files._modules,
                        transitive = [ctx.attr.bun[DefaultInfo].files]),
        tools = [ctx.attr.bun[DefaultInfo].files_to_run],
        outputs = [output],
        mnemonic = "OriginalBunBuildSourceRequirements",
        progress_message = "Evaluate original Bun dependency acquisition inputs %{label}",
        execution_requirements = {"block-network": "1"},
    )
    return [DefaultInfo(files = depset([output]))]

bun_runtime_build_source_requirements = rule(
    implementation = _requirements_impl,
    attrs = {
        "source_archive": attr.label(default = "@bun_runtime_source_archive//file", allow_single_file = True),
        "bun": attr.label(default = "//tools/bazel/tools:bun", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/bun:bun-runtime-build.py", allow_single_file = True),
        "_engine": attr.label(default = "//tools/bazel/bun:bun-runtime-build.ts", allow_single_file = True),
        "_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution-pins.json", allow_single_file = True),
        "_custody": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_deployment": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_output_tree": attr.label(default = "//tools/bazel/packaging:output-tree.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
    },
)
