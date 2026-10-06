"""Original Kitware CMake executable and complete adjacent resource distributions."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive", "http_file")

def _cmake_distributions_impl(module_ctx):
    pins = json.decode(module_ctx.read(Label("//tools/bazel/tools/native:cmake-pins.json")))
    for platform, archive in pins["platforms"].items():
        binary = archive["binary"]
        http_archive(
            name = "cmake_" + platform,
            urls = [archive["url"]],
            sha256 = archive["sha256"],
            strip_prefix = archive["strip_prefix"],
            build_file_content = 'exports_files(' + json.encode([binary]) + ', visibility = ["//visibility:public"])\n' +
                                 'filegroup(name = "cmake", srcs = ' + json.encode([binary]) + ', visibility = ["//visibility:public"])\n' +
                                 'filegroup(name = "runtime", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\n',
        )
    source = pins["source"]
    http_file(
        name = "cmake_source_archive",
        urls = [source["url"]],
        sha256 = source["sha256"],
        downloaded_file_path = "cmake-" + pins["version"] + ".tar.gz",
    )
    http_archive(
        name = "cmake_source",
        urls = [source["url"]],
        sha256 = source["sha256"],
        strip_prefix = source["strip_prefix"],
        patches = [
            Label("//tools/bazel/tools/native:cmake-darwin-native-memory.patch"),
            Label("//tools/bazel/tools/native:cmake-darwin-native-runtime.patch"),
        ],
        patch_args = ["-p1"],
        build_file_content = 'filegroup(name = "source", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\n',
    )
    return module_ctx.extension_metadata(reproducible = True)

cmake_distributions = module_extension(implementation = _cmake_distributions_impl)
