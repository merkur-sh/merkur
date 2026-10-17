"""The WebAssembly packaging tools, by archive digest.

wasm-bindgen's CLI must be the release of the `wasm-bindgen` crate `Cargo.lock` pins, or the glue
it writes does not match the runtime the module links (`scripts/toolchain-pins.test.ts`).
binaryen is the release wasm-pack 0.15 ran, for the same `wasm-opt -O`.
"""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

WASM_BINDGEN_VERSION = "0.2.127"

BINARYEN_VERSION = "version_117"

_WASM_BINDGEN = {
    "darwin_aarch64": ("aarch64-apple-darwin", "cd93e691eb5953ace5d8ffce52a20b024077a3dac3e2215b8224136b0efb7585"),
    "darwin_x64": ("x86_64-apple-darwin", "81049c79f4e283e1725e6582a0528af1301a70ad23add1df1c4d042ec825263d"),
    "linux_aarch64": ("aarch64-unknown-linux-musl", "699ddbb724ece16f912b73a98b5341a75f4b8c7886ce152d40dbe09f694e46c7"),
    "linux_x64": ("x86_64-unknown-linux-musl", "61d4a7dc85acfa0d2354ccc0b8361928c7e52a746d17f28ebaa795ed3dc1614a"),
}

_BINARYEN = {
    "darwin_aarch64": ("arm64-macos", "f2d962ff294b38ea3cfbbae8f6c728089d9375a57bac9a1880eb86779d6d3a84"),
    "darwin_x64": ("x86_64-macos", "c0be7b448888f2c851a853ca19299b09d42cac8c3090c716d14cc8ec3c0ac849"),
    "linux_aarch64": ("aarch64-linux", "ad560204426015a815faa45693c83bef7d58677d38a39422c272a30ba4b6da2a"),
    "linux_x64": ("x86_64-linux", "3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212"),
}

# `wasm-opt` with the shared library the macOS builds load from `../lib`.
_BINARYEN_BUILD = """filegroup(
    name = "wasm-opt",
    srcs = ["bin/wasm-opt"] + glob(["lib/*.dylib"], allow_empty = True),
    visibility = ["//visibility:public"],
)
"""

def _wasm_tools_impl(module_ctx):
    for name, (platform, digest) in _WASM_BINDGEN.items():
        http_archive(
            name = "wasm_bindgen_" + name,
            build_file_content = 'exports_files(["wasm-bindgen", "wasm-bindgen-test-runner"], visibility = ["//visibility:public"])\n',
            sha256 = digest,
            strip_prefix = "wasm-bindgen-%s-%s" % (WASM_BINDGEN_VERSION, platform),
            urls = ["https://github.com/wasm-bindgen/wasm-bindgen/releases/download/%s/wasm-bindgen-%s-%s.tar.gz" % (WASM_BINDGEN_VERSION, WASM_BINDGEN_VERSION, platform)],
        )
    for name, (platform, digest) in _BINARYEN.items():
        http_archive(
            name = "binaryen_" + name,
            build_file_content = _BINARYEN_BUILD,
            sha256 = digest,
            strip_prefix = "binaryen-" + BINARYEN_VERSION,
            urls = ["https://github.com/WebAssembly/binaryen/releases/download/%s/binaryen-%s-%s.tar.gz" % (BINARYEN_VERSION, BINARYEN_VERSION, platform)],
        )
    return module_ctx.extension_metadata(reproducible = True)

wasm_tools = module_extension(implementation = _wasm_tools_impl)
