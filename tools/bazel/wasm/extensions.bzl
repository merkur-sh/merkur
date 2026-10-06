"""The wasm-bindgen CLI must match the wasm-bindgen runtime in Cargo.lock."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

WASM_BINDGEN_VERSION = "0.2.127"
BINARYEN_VERSION = "117"
_OPTIMIZERS = {
    "darwin_aarch64": ("arm64-macos", "f2d962ff294b38ea3cfbbae8f6c728089d9375a57bac9a1880eb86779d6d3a84"),
    "darwin_x64": ("x86_64-macos", "c0be7b448888f2c851a853ca19299b09d42cac8c3090c716d14cc8ec3c0ac849"),
    "linux_aarch64": ("aarch64-linux", "ad560204426015a815faa45693c83bef7d58677d38a39422c272a30ba4b6da2a"),
    "linux_x64": ("x86_64-linux", "3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212"),
}
_RELEASES = {
    "darwin_aarch64": ("aarch64-apple-darwin", "cd93e691eb5953ace5d8ffce52a20b024077a3dac3e2215b8224136b0efb7585"),
    "darwin_x64": ("x86_64-apple-darwin", "81049c79f4e283e1725e6582a0528af1301a70ad23add1df1c4d042ec825263d"),
    "linux_aarch64": ("aarch64-unknown-linux-gnu", "1ce0ebd74e378d989651091f93c917bd7700996945d4c5ce37ec9507f149225c"),
    "linux_x64": ("x86_64-unknown-linux-musl", "61d4a7dc85acfa0d2354ccc0b8361928c7e52a746d17f28ebaa795ed3dc1614a"),
}

def _bindings_impl(module_ctx):
    for name, (platform, digest) in _RELEASES.items():
        prefix = "wasm-bindgen-%s-%s" % (WASM_BINDGEN_VERSION, platform)
        http_archive(
            name = "wasm_bindgen_" + name,
            urls = ["https://github.com/wasm-bindgen/wasm-bindgen/releases/download/%s/%s.tar.gz" % (WASM_BINDGEN_VERSION, prefix)],
            sha256 = digest,
            strip_prefix = prefix,
            build_file_content = "exports_files([\"wasm-bindgen\", \"wasm-bindgen-test-runner\"], visibility = [\"//visibility:public\"])\n",
        )
    for name, (platform, digest) in _OPTIMIZERS.items():
        http_archive(
            name = "binaryen_" + name,
            urls = ["https://github.com/WebAssembly/binaryen/releases/download/version_%s/binaryen-version_%s-%s.tar.gz" % (BINARYEN_VERSION, BINARYEN_VERSION, platform)],
            sha256 = digest,
            strip_prefix = "binaryen-version_" + BINARYEN_VERSION,
            build_file_content = "exports_files([\"bin/wasm-opt\"], visibility = [\"//visibility:public\"])\nfilegroup(name = \"runtime_files\", srcs = glob([\"lib/**\"]), visibility = [\"//visibility:public\"])\n",
        )
    return module_ctx.extension_metadata(reproducible = True)

bindings = module_extension(implementation = _bindings_impl)
