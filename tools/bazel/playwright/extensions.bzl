"""The browser builds Playwright launches, by archive digest.

They are the revisions the installed `playwright-core` names in its `browsers.json`
(`scripts/toolchain-pins.test.ts`), laid out as `playwright install` lays them out: each archive
unpacked into the revision's directory, with the markers that say the install completed.

WebKit is built per operating-system release, so its archives are those of the releases this
repository runs on: macOS 26 and Ubuntu 26.04, the owner's machines and CI's runners. Playwright
serves Ubuntu 26.04 the Ubuntu 24.04 Firefox build.
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

WEBKIT_REVISION = "2336"

FIREFOX_REVISION = "1538"

_BUILDS = "https://cdn.playwright.dev/dbazure/download/playwright/builds/"

_WEBKIT = {
    "darwin_aarch64": (_BUILDS + "webkit/%s/webkit-mac-26-arm64.zip" % WEBKIT_REVISION, "0bad39cd64706974156fd5fc1241cb45e05ae630b0cba26fddba098a6ff792ab"),
    "darwin_x64": (_BUILDS + "webkit/%s/webkit-mac-26.zip" % WEBKIT_REVISION, "021b8306878b8b4430ab3202fd0bbe1697507a733b17add41e4ca7b61f1f1496"),
    "linux_aarch64": (_BUILDS + "webkit/%s/webkit-ubuntu-26.04-arm64.zip" % WEBKIT_REVISION, "de9f89435407c13ea6e59544ba7d5f443b4a0da0c9b5051ee4d1c7c853fd551d"),
    "linux_x64": (_BUILDS + "webkit/%s/webkit-ubuntu-26.04.zip" % WEBKIT_REVISION, "c1d296d35c831a31db9d330f0a7ce44bded9bfeb82ca298dc35d11c8e3698b8e"),
}

_FIREFOX = {
    "darwin_aarch64": (_BUILDS + "firefox/%s/firefox-mac-arm64.zip" % FIREFOX_REVISION, "b7b8e068fb1776dee8abfeb649ad6313f9ec8f6bbaa333d8dc00d013cc389256"),
    "darwin_x64": (_BUILDS + "firefox/%s/firefox-mac.zip" % FIREFOX_REVISION, "984f0350062d2fcc7ac9e7736ad3ef2d8c15db33ee8fe3d19c57f26e24f9a766"),
    "linux_aarch64": (_BUILDS + "firefox/%s/firefox-ubuntu-24.04-arm64.zip" % FIREFOX_REVISION, "ec0600a40bd8f8ba221bd8e952aeaefb23aa06b5a239891c0e71c602109da30e"),
    "linux_x64": (_BUILDS + "firefox/%s/firefox-ubuntu-24.04.zip" % FIREFOX_REVISION, "49208d3ed74e525575eca41d053082902b88933e31943a091d25080bdfcfcb25"),
}

# The whole unpacked build; the install marker names the directory Playwright reads.
_BUILD = """filegroup(
    name = "browser",
    srcs = glob(["**"]),
    visibility = ["//visibility:public"],
)
"""

def _playwright_browsers_impl(module_ctx):
    for prefix, archives in [
        ("chromium_", _CHROMIUM),
        ("chromium_headless_shell_", _HEADLESS_SHELL),
        ("webkit_", _WEBKIT),
        ("firefox_", _FIREFOX),
    ]:
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
