"""Original runtime source/diagnostic archives; none assert complete attribution.

Profile binaries and final-link maps come from the same official Bun1.4.3 ZIPs.
WebKit LTO selection comes from that release's original native dependency config.
Keep archive Files intact so consumers can check exact member ownership and bytes.
"""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

_PROFILES = {
    "darwin_aarch64": ("darwin-aarch64", "75f64c0576854e701dd1dc306cf57a934ffdad40855f9e12a8ad6b63856603d4"),
    "darwin_x64": ("darwin-x64", "b216c00754c53e5a54502ff136f35724dc595b3ed19a3a304a15cc5559db47cf"),
    "linux_aarch64": ("linux-aarch64", "0ab465027121ffcb9317e521ffe099fbecc649244cf89ad67f1519d35309461f"),
    "linux_x64": ("linux-x64", "0f0a4f143fdb562853223cdc1a6b040a0aafa88a012a876db936e7ba2079c36c"),
}

_WEBKIT_COMMIT = "0c06faadf65bf8e8c8ad3a5a8aca83e1e9ed653f"
_WEBKIT = {
    "darwin_aarch64": ("macos-arm64", "26bea28d6d1efb8609816745dd959122120fb5fe64e390fd83e0ee6a1d9b616f"),
    "darwin_x64": ("macos-amd64", "bc156b48d62292e695cd1bcbadf643e749b31b1259692724b208a769c66949ae"),
    "linux_aarch64": ("linux-arm64", "7739eb7ca5d5155a630ab616bfed874277c909ca9661866173b7e7ff6190144e"),
    "linux_x64": ("linux-amd64", "19354fbb91f4dc5d0c2346598ab73d5b9046101dc01d8c5bfdb59db24d0c0cfd"),
}

def runtime_webkit_pin(platform):
    """The original release's exact platform-specific WebKit LTO archive."""
    asset_platform, digest = _WEBKIT[platform]
    asset = "bun-webkit-%s-lto.tar.gz" % asset_platform
    return struct(
        url = "https://github.com/oven-sh/WebKit/releases/download/autobuild-%s/%s" % (_WEBKIT_COMMIT, asset),
        sha256 = digest,
    )

def _runtime_archives_impl(module_ctx):
    for platform, (asset_platform, digest) in _PROFILES.items():
        asset = "bun-%s-profile.zip" % asset_platform
        http_file(
            name = "bun_profile_" + platform,
            urls = ["https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/" + asset],
            sha256 = digest,
            downloaded_file_path = asset,
        )
    for platform in _WEBKIT:
        pin = runtime_webkit_pin(platform)
        http_file(
            name = "bun_webkit_" + platform,
            urls = [pin.url],
            sha256 = pin.sha256,
            downloaded_file_path = pin.url.split("/")[-1],
        )
    http_file(
        name = "bun_icu_sources",
        urls = ["https://github.com/unicode-org/icu/releases/download/release-78.3/icu4c-78.3-sources.tgz"],
        sha256 = "3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0",
        downloaded_file_path = "icu4c-78.3-sources.tgz",
    )
    return module_ctx.extension_metadata(reproducible = True)

runtime_archives = module_extension(implementation = _runtime_archives_impl)
