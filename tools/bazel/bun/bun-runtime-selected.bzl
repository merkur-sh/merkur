"""Read actual same-build runtime inputs; pending source scopes refuse admission."""

load("//tools/bazel/bun:rules.bzl", "BunCompileInfo")

_TARGETS = {
    "bun-darwin-arm64": "aarch64-apple-darwin",
    "bun-darwin-x64": "x86_64-apple-darwin",
    "bun-linux-arm64": "aarch64-unknown-linux-gnu",
    "bun-linux-x64": "x86_64-unknown-linux-gnu",
}

def _one(files, description, tree = False):
    files = files.to_list()
    if len(files) != 1 or files[0].is_directory != tree:
        fail(description + " requires one actual original " + ("TreeArtifact" if tree else "File"))
    return files[0]

def _authored(file, label):
    if not file.is_source or file.is_directory or file.owner.workspace_root or file.owner != Label(label):
        fail("Builtin patch ownership requires its exact original main-workspace SourceFile: " + label)
    return {"input": file.path, "label": label, "tree": False, "authored": True}

def _selected_impl(ctx):
    compiler = ctx.attr.producer[BunCompileInfo]
    source = ctx.attr.source_runtime
    runtime = _one(source[DefaultInfo].files, "Source-built runtime")
    if compiler.runtime != runtime:
        fail("Bun compiler must embed the exact same source-built runtime File")
    if compiler.compile_target not in _TARGETS:
        fail("Selected runtime requires an explicit original native compiler target")
    groups = source[OutputGroupInfo]
    tree = _one(groups.original_build, "Original native build", tree = True)
    configuration = _one(groups.native_configuration, "Original native configuration")
    native_request = _one(groups.native_request, "Original native action specification")
    original = groups.runtime_attribution_inputs
    generator = _one(groups.generator_runtime, "Original builtin generator runtime")
    if any([file not in original.to_list() for file in
            [ctx.file.archive, ctx.file.pins, ctx.file._build_pins, native_request, ctx.file._generator_patch, generator,
             ctx.file._workspace_manifest, ctx.file._workspace_license]]):
        fail("Original runtime source pins/archive/patch/generator must belong to the same native build action")
    private_sources = {"patch": _authored(ctx.file._generator_patch, "//tools/bazel/bun:bun-runtime-build-embedded-inputs.patch"),
                       "manifest": _authored(ctx.file._workspace_manifest, "//:package.json"),
                       "license": _authored(ctx.file._workspace_license, "//:LICENSE")}
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    output = ctx.actions.declare_file(ctx.label.name + ".selected-source-inputs.json")
    helpers = {"linked": ctx.file._linked, "generated": ctx.file._generated,
               "licenses": ctx.file._licenses, "sections": ctx.file._sections,
               "mapper": ctx.file._mapper, "custody": ctx.file._custody,
               "closure": ctx.file._closure, "deployment": ctx.file._deployment, "pack": ctx.file._pack}
    ctx.actions.write(request, json.encode(dict(
        {name: file.path for name, file in helpers.items()},
        published = tree.path,
        configuration = configuration.path,
        native_request = native_request.path,
        build_pins = ctx.file._build_pins.path,
        runtime = runtime.path,
        target = _TARGETS[compiler.compile_target],
        archive = ctx.file.archive.path,
        pins = ctx.file.pins.path,
        generator_patch = ctx.file._generator_patch.path,
        generator_runtime = generator.path,
        private_sources = private_sources,
    )))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, request.path, output.path],
        inputs = depset([request, ctx.file._runner, tree, configuration, native_request, ctx.file._build_pins, runtime,
                         ctx.file.archive, ctx.file.pins, ctx.file._generator_patch, generator,
                         ctx.file._workspace_manifest, ctx.file._workspace_license] + helpers.values(),
                        transitive = [original, compiler.inputs]),
        outputs = [output],
        mnemonic = "OriginalBunSelectedRuntimeInputs",
        execution_requirements = {"block-network": "1"},
    )
    # No SelectedAttributionInfo: full generated/LTO/nightly selection remains
    # mandatory pending until actual original same-build collectors can join.
    return [DefaultInfo(files = depset([output]))]

bun_runtime_selected_inputs = rule(
    implementation = _selected_impl,
    attrs = {
        "producer": attr.label(mandatory = True, providers = [BunCompileInfo]),
        "source_runtime": attr.label(mandatory = True),
        "archive": attr.label(default = "@bun_runtime_source_archive//file", allow_single_file = True),
        "pins": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution-pins.json", allow_single_file = True),
        "_build_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-build-pins.json", allow_single_file = True),
        "_workspace_manifest": attr.label(default = "//:package.json", allow_single_file = True),
        "_workspace_license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "_pack": attr.label(default = "//tools/bazel/packaging:pack.py", allow_single_file = True),
        "_closure": attr.label(default = "//tools/bazel/packaging:license-closure.py", allow_single_file = True),
        "_deployment": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_generator_patch": attr.label(default = "//tools/bazel/bun:bun-runtime-build-embedded-inputs.patch", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/bun:bun-runtime-selected.py", allow_single_file = True),
        "_linked": attr.label(default = "//tools/bazel/bun:bun-runtime-linked-sources.py", allow_single_file = True),
        "_generated": attr.label(default = "//tools/bazel/bun:bun-runtime-generated-inputs.py", allow_single_file = True),
        "_licenses": attr.label(default = "//tools/bazel/packaging:license-inputs.py", allow_single_file = True),
        "_sections": attr.label(default = "//tools/bazel/bun:runtime-sections.py", allow_single_file = True),
        # Only original ld64/ar grammars are reused. Stock compiler/source custody
        # is never used as authority for Bun's rebuilt nightly standard library.
        "_mapper": attr.label(default = "//tools/bazel/rust:stdlib_attribution.py", allow_single_file = True),
        "_custody": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution.py", allow_single_file = True),
    },
)
