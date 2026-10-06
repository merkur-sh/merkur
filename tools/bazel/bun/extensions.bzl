"""Verified Bun runtime acquisition. No install script or ambient executable."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

BUN_VERSION = "1.4.2"
_BUN = {
    "darwin_aarch64": ("darwin-aarch64", "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f"),
    "darwin_x64": ("darwin-x64", "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012"),
    "linux_aarch64": ("linux-aarch64", "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7"),
    "linux_x64": ("linux-x64", "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"),
}

def _bun_impl(module_ctx):
    for name, (platform, digest) in _BUN.items():
        http_archive(
            name = "bun_" + name,
            urls = ["https://github.com/oven-sh/bun/releases/download/bun-v%s/bun-%s.zip" % (BUN_VERSION, platform)],
            sha256 = digest,
            strip_prefix = "bun-" + platform,
            build_file_content = "exports_files([\"bun\"], visibility = [\"//visibility:public\"])\n",
        )
    http_archive(
        name = "node_api_headers",
        urls = ["https://nodejs.org/download/release/v24.13.0/node-v24.13.0-headers.tar.gz"],
        sha256 = "f5589e2b4b962af05381a31d11c3c9b004daf8bd63c95c0e1a406600daa8ae88",
        strip_prefix = "node-v24.13.0",
        build_file_content = 'load("@rules_cc//cc:defs.bzl", "cc_library")\ncc_library(name = "headers", hdrs = glob(["include/node/**/*.h"]), includes = ["include/node"], visibility = ["//visibility:public"])\n',
    )
    http_archive(
        name = "msgpackr_extract_source",
        urls = ["https://registry.npmjs.org/msgpackr-extract/-/msgpackr-extract-3.0.4.tgz"],
        integrity = "sha512-4kmO/MdyUIkLIvTPr8VHLil4AtoKIoniWPIEk5+CDy0xnWC84azhSFmuJ7PxZdsYtiP5kEeQsORAVIeMgxT+Hw==",
        strip_prefix = "package",
        build_file_content = 'exports_files(["src/extract.cpp"], visibility = ["//visibility:public"])\n',
    )
    http_archive(
        name = "msgpackr_extract_linux_arm64_source",
        urls = ["https://registry.npmjs.org/@msgpackr-extract/msgpackr-extract-linux-arm64/-/msgpackr-extract-linux-arm64-3.0.4.tgz"],
        integrity = "sha512-dgX0P/9wGPJeHFBG+ZmhgE6bmtMt7NP5CRBGyyktpopdk/mW4POnrpQsSLtKI1dwpc+pPLuXHDh6vvskyQE/sw==",
        strip_prefix = "package",
        build_file_content = 'filegroup(name = "files", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\n',
    )
    return module_ctx.extension_metadata(reproducible = True)

bun = module_extension(implementation = _bun_impl)
