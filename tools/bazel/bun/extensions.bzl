"""The Bun release `.bun-version` names, by archive digest."""

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
            build_file_content = 'exports_files(["bun"], visibility = ["//visibility:public"])\n',
            sha256 = digest,
            strip_prefix = "bun-" + platform,
            urls = ["https://github.com/oven-sh/bun/releases/download/bun-v%s/bun-%s.zip" % (BUN_VERSION, platform)],
        )
    return module_ctx.extension_metadata(reproducible = True)

bun = module_extension(implementation = _bun_impl)
