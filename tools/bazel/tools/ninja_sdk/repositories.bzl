"""Original upstream Ninja source, with only declared POSIX shell selection patched."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

def _ninja_sources_impl(module_ctx):
    pins = json.decode(module_ctx.read(Label("//tools/bazel/tools/ninja_sdk:pins.json")))
    source = pins["source"]
    http_archive(
        name = "ninja_declared_shell_source",
        urls = [source["url"]],
        sha256 = source["sha256"],
        type = "tar.gz",
        strip_prefix = source["strip_prefix"],
        patches = [Label("//tools/bazel/tools/ninja_sdk:declared-shell.patch")],
        patch_args = ["-p1"],
        build_file_content = 'filegroup(name = "source", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\nexports_files(["COPYING"], visibility = ["//visibility:public"])\n',
    )
    return module_ctx.extension_metadata(reproducible = True)

ninja_sources = module_extension(implementation = _ninja_sources_impl)
