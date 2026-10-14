"""Verified Bun runtime acquisition. No install script or ambient executable."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

BUN_VERSION = "1.4.3"
_BUN = {
    "darwin_aarch64": ("darwin-aarch64", "80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403"),
    "darwin_x64": ("darwin-x64", "62660e6438eb872278877acca77e1152d5d031324df368d4a81b428211489d2d"),
    "linux_aarch64": ("linux-aarch64", "efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21"),
    "linux_x64": ("linux-x64", "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18"),
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
