"""Original runtime source/diagnostic archives; none assert complete attribution.

Profile binaries and final-link maps come from the same official Bun1.4.2 ZIPs.
WebKit LTO selection comes from that release's original native dependency config.
Keep archive Files intact so consumers can check exact member ownership and bytes.
"""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

_PROFILES = {
    "darwin_aarch64": ("darwin-aarch64", "09a5c3053e94669c837591bf9cf16a5ff84b2234dfb32304a251213f9816c7d1"),
    "darwin_x64": ("darwin-x64", "07367d2acad8af980944c247f57ce5a154c5b6f1964017fc6fbfb6e8bf2dc7d9"),
    "linux_aarch64": ("linux-aarch64", "905c31a277101362e63ddc07f5ff81e73b00fcd5d03eb05ed3a3cefd8fcef08d"),
    "linux_x64": ("linux-x64", "fad558e312e123abc9abc6fcdc2370b60e8a9726575fc6bcc2fdc93e6b600a7f"),
}

_WEBKIT_COMMIT = "2e2aa2290fac856d6f451ceacb58f7f5b44dd057"
_WEBKIT = {
    "darwin_aarch64": ("macos-arm64", "93c79936f3ef5d625dac0fa29deb12406fc6c356d755df654c69691667b3872d"),
    "darwin_x64": ("macos-amd64", "44950d3630d37c7995bf9ddc0d7796f479bf5d4e1b2c0edab8322341202b8ecf"),
    "linux_aarch64": ("linux-arm64", "b0fd42cfd66490a2f8e6afe67285e06eabe110cf808f5903b68f86e7580400aa"),
    "linux_x64": ("linux-amd64", "8f68d22b67fc0b72fb81b808aaf996a8a228cbaad193fd574d3b8655258db8b9"),
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
            urls = ["https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/" + asset],
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
