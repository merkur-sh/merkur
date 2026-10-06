"""Expose the original native engine File and its acquisition authority."""

BazelEngineInfo = provider(fields = {
    "binary": "Original checksum-verified official native executable File.",
    "acquisition": "Exact platform/version/URL/SHA256 acquisition metadata File.",
})

def _bazel_engine_impl(ctx):
    binary = ctx.file.binary
    acquisition = ctx.file.acquisition
    output = ctx.actions.declare_file(ctx.label.name + ".bin")
    ctx.actions.symlink(output = output, target_file = binary, is_executable = True)
    return [
        DefaultInfo(executable = output, runfiles = ctx.runfiles(files = [binary, acquisition])),
        BazelEngineInfo(binary = binary, acquisition = acquisition),
        OutputGroupInfo(acquisition = depset([acquisition]), payload = depset([binary])),
    ]

bazel_engine = rule(
    implementation = _bazel_engine_impl,
    executable = True,
    attrs = {
        "binary": attr.label(allow_single_file = True, mandatory = True),
        "acquisition": attr.label(allow_single_file = True, mandatory = True),
    },
)

def _acquisition_impl(ctx):
    metadata = ctx.attr.engine[BazelEngineInfo].acquisition
    return [DefaultInfo(files = depset([metadata]))]

engine_acquisition = rule(
    implementation = _acquisition_impl,
    attrs = {"engine": attr.label(providers = [BazelEngineInfo], mandatory = True, cfg = "exec")},
)
