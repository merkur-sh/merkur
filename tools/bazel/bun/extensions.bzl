"""The Bun release `.bun-version` names, by archive digest (`bun run build:bun-archives`)."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

BUN_VERSION = "1.4.4"

_BUN = {
    "darwin_aarch64": ("darwin-aarch64", "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510"),
    "darwin_x64": ("darwin-x64", "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e"),
    "linux_aarch64": ("linux-aarch64", "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e"),
    # The baseline build, which needs no AVX2: `bun build --compile` embeds this runtime in
    # the released CLI, as the images do.
    "linux_x64": ("linux-x64-baseline", "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76"),
}

def _bun_impl(module_ctx):
    for name, (platform, digest) in _BUN.items():
        http_archive(
            name = "bun_" + name,
            build_file_content = 'exports_files(["bun"], visibility = ["//visibility:public"])\n',
            sha256 = digest,
            strip_prefix = "bun-" + platform,
            urls = ["https://github.com/oven-sh/bun/releases/download/bun-v%s/bun-%s.zip" % (BUN_VERSION, platform)],
        )
    return module_ctx.extension_metadata(reproducible = True)

bun = module_extension(implementation = _bun_impl)
