"""Prepare Vite's original configured generator with the declared Bun compiler."""

load("@aspect_rules_js//js:providers.bzl", "JsInfo")
load(":rules.bzl", "bun_inputs")

def _vite_preload_impl(ctx):
    if ctx.file.source.is_directory or ctx.file._runner.is_directory or ctx.file._extractor.is_directory:
        fail("Vite generator preparation requires original source and executable JS Files")
    output = ctx.actions.declare_file(ctx.label.name + ".js")
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    inputs = depset(
        [ctx.file.source, ctx.file._extractor, ctx.file._runner, ctx.file._config],
        transitive = [bun_inputs([ctx.attr._runner])],
    )
    ctx.actions.run(
        executable = runtime,
        arguments = [
            "--no-install",
            "--no-env-file",
            "--config=" + ctx.file._config.path,
            ctx.file._runner.path,
            ctx.file.source.path,
            output.path,
        ],
        inputs = inputs,
        outputs = [output],
        env = {"PATH": "/__no_ambient_path__", "HOME": "/__no_ambient_home__"},
        use_default_shell_env = False,
        mnemonic = "ViteOriginalPreloadGenerator",
    )
    return [
        DefaultInfo(files = depset([output])),
        OutputGroupInfo(
            original_source = depset([ctx.file.source]),
            extractor = depset([ctx.file._extractor]),
        ),
    ]

vite_preload_script = rule(
    implementation = _vite_preload_impl,
    attrs = {
        "source": attr.label(allow_single_file = True, mandatory = True, cfg = "exec"),
        "_runner": attr.label(
            default = "//tools/bazel/bun:vite_preload_generator_sources",
            allow_single_file = True,
            providers = [JsInfo],
            cfg = "exec",
        ),
        "_extractor": attr.label(
            default = "//tools/bazel/bun:vite-preload-generator.ts",
            allow_single_file = True,
        ),
        "_config": attr.label(
            default = "//tools/bazel/bun:empty-bunfig.toml",
            allow_single_file = True,
        ),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)
