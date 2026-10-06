"""Package a native authenticated oracle with its selected compiler input facts."""

load(":rules.bzl", "bun_inputs")

def _native_oracle_impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_directory(ctx.label.name + ".retained")
    manifest = ctx.actions.declare_file(ctx.label.name + ".json")
    sources = {}
    original_files = {}
    for file in ctx.files.sources:
        if file.short_path.startswith("../") or file.is_directory or not file.is_source:
            fail("Native oracle source authority requires firstparty regular-file facts: " + file.short_path)
        if file.short_path in sources:
            fail("Native oracle sources duplicate an original File: " + file.short_path)
        sources[file.short_path] = file.path
        original_files[file.short_path] = file
    descriptor = ctx.file.descriptor
    if original_files.get(descriptor.short_path) != descriptor:
        fail("Native oracle descriptor must be the same original File in its selected source provider")
    inputs = ctx.actions.declare_file(ctx.label.name + ".source-inputs.json")
    ctx.actions.write(inputs, json.encode(sources))
    executable = ctx.executable.oracle
    label = ctx.attr.oracle.label
    if label.workspace_root:
        fail("Native oracle requires its original main-repository configured root")
    configured_unit = "//" + label.package + ":" + label.name
    ctx.actions.run(
        executable = runtime,
        arguments = ["--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, inputs.path, executable.path, output.path, manifest.path, ctx.attr.producer, configured_unit, descriptor.path],
        inputs = depset([inputs, executable, ctx.file._config, ctx.file._runner] + ctx.files.sources, transitive = [bun_inputs([ctx.attr._runner])]),
        outputs = [output, manifest],
        mnemonic = "AuthenticatedOraclePackage",
    )
    return [OutputGroupInfo(oracle_manifest = depset([manifest]), oracle_binary = depset([executable])), DefaultInfo(files = depset([output, manifest] + ctx.files.sources), runfiles = ctx.runfiles(files = ctx.files.sources, symlinks = {"target/rust/client-session-oracle": output, "target/rust/client-session-oracle.json": manifest}))]

native_oracle_package = rule(
    implementation = _native_oracle_impl,
    attrs = {
        "producer": attr.string(mandatory = True),
        "descriptor": attr.label(allow_single_file = [".json"], mandatory = True),
        "oracle": attr.label(executable = True, cfg = "exec", mandatory = True),
        "sources": attr.label_list(allow_files = True, mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/bun:oracle_packager", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)
