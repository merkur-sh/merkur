"""Original Bun compiler-runtime source custody; never complete shipping notices."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")
load("//tools/bazel/bun:rules.bzl", "BunCompileInfo")

def _origins_impl(ctx):
    pins = json.decode(ctx.read(Label("//tools/bazel/bun:bun-runtime-attribution-pins.json")))
    http_file(
        name = "bun_runtime_source_archive",
        urls = [pins["source"]["url"]],
        sha256 = pins["source"]["sha256"],
        downloaded_file_path = pins["source"]["archive"],
    )
    for target, runtime in pins["runtimes"].items():
        http_file(
            name = "bun_runtime_original_" + target[4:].replace("-", "_"),
            urls = [runtime["url"]],
            sha256 = runtime["sha256"],
            downloaded_file_path = runtime["archive"],
        )
    return ctx.extension_metadata(reproducible = True)

bun_runtime_origins = module_extension(implementation = _origins_impl)

def _custody_impl(ctx):
    compiler = ctx.attr.producer[BunCompileInfo]
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    originals = ctx.actions.declare_directory(ctx.label.name + ".originals")
    ctx.actions.write(specification, json.encode({
        "producer": compiler.producer,
        "compile_target": compiler.compile_target,
        "configuration": compiler.configuration.path,
        "runtime": compiler.runtime.path,
        "runtime_archive": ctx.file.runtime_archive.path,
        "source_archive": ctx.file.source_archive.path,
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, specification.path, ctx.file._pins.path,
                     originals.path, ctx.file._deployment.path, ctx.file._output_tree.path],
        inputs = depset([specification, compiler.configuration, compiler.runtime,
                         ctx.file.runtime_archive, ctx.file.source_archive, ctx.file._runner,
                         ctx.file._pins, ctx.file._deployment, ctx.file._output_tree] + ctx.files._modules),
        outputs = [originals],
        mnemonic = "OriginalBunRuntimeSourceCustody",
        progress_message = "Bind original Bun runtime source/license inputs %{label}",
    )
    # These are original input custody facts, not compiler-selected linked source.
    # Existing release consumers require a genuine SelectedAttributionInfo scope
    # separately and therefore cannot mistake these artifacts for qualification.
    return [
        DefaultInfo(files = depset([originals])),
        OutputGroupInfo(original_inputs = depset([originals])),
    ]

bun_runtime_source_custody = rule(
    implementation = _custody_impl,
    attrs = {
        "producer": attr.label(providers = [BunCompileInfo], mandatory = True),
        "source_archive": attr.label(default = "@bun_runtime_source_archive//file", allow_single_file = True),
        "runtime_archive": attr.label(allow_single_file = True, mandatory = True),
        "_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution-pins.json", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_deployment": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_output_tree": attr.label(default = "//tools/bazel/packaging:output-tree.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
    },
)
