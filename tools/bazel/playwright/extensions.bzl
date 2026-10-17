"""The Chromium builds Playwright launches, by archive digest.

They are the revision the installed `playwright-core` names in its `browsers.json`
(`scripts/toolchain-pins.test.ts`), laid out as `playwright install` lays them out: each archive
unpacked into the revision's directory, with the markers that say the install completed.
"""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

CHROMIUM_REVISION = "1234"

CHROMIUM_VERSION = "151.0.7922.34"

_CFT = "https://cdn.playwright.dev/builds/cft/%s/" % CHROMIUM_VERSION

_PLAYWRIGHT = "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/%s/" % CHROMIUM_REVISION

_CHROMIUM = {
    "darwin_aarch64": (_CFT + "mac-arm64/chrome-mac-arm64.zip", "01a23ef9501b2745e0c2944c2e583207e6f6132d8d91c3a87ff65b5079e438ef"),
    "darwin_x64": (_CFT + "mac-x64/chrome-mac-x64.zip", "69bcc853db975a2380767e9ff36da17f1d7b782fbbe191a210f676d2d5967d3e"),
    "linux_aarch64": (_PLAYWRIGHT + "chromium-linux-arm64.zip", "b5ad7d8fe70f230b34198ddb5626d717c016db2f627cb44b922babbcaf3479b9"),
    "linux_x64": (_CFT + "linux64/chrome-linux64.zip", "ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8"),
}

_HEADLESS_SHELL = {
    "darwin_aarch64": (_CFT + "mac-arm64/chrome-headless-shell-mac-arm64.zip", "cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d"),
    "darwin_x64": (_CFT + "mac-x64/chrome-headless-shell-mac-x64.zip", "608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea"),
    "linux_aarch64": (_PLAYWRIGHT + "chromium-headless-shell-linux-arm64.zip", "b03443e1e1a60d06e07b6cdfe650b8c2bfcbb3db497d2b652f73dc6912f4ae15"),
    "linux_x64": (_CFT + "linux64/chrome-headless-shell-linux64.zip", "3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14"),
}

# The whole unpacked build; the install marker names the directory Playwright reads.
_BUILD = """filegroup(
    name = "browser",
    srcs = glob(["**"]),
    visibility = ["//visibility:public"],
)
"""

def _playwright_browsers_impl(module_ctx):
    for prefix, archives in [("chromium_", _CHROMIUM), ("chromium_headless_shell_", _HEADLESS_SHELL)]:
        for name, (url, digest) in archives.items():
            http_archive(
                name = prefix + name,
                build_file_content = _BUILD,
                patch_cmds = ["touch INSTALLATION_COMPLETE DEPENDENCIES_VALIDATED"],
                sha256 = digest,
                urls = [url],
            )
    return module_ctx.extension_metadata(reproducible = True)

playwright_browsers = module_extension(implementation = _playwright_browsers_impl)
