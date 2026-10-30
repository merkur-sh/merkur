"""The LLVM release the C and C++ toolchain runs, as the files the toolchain names.

A release archive holds about 8 GB, most of it MLIR, LLDB, Flang, BOLT and LLVM's development
headers and libraries, in 1.5 GB of xz: over two minutes of every macOS CI job's download and a
minute of a Linux job's decoding. `scripts/llvm-distribution.ts` cuts each release to what
`@toolchains_llvm//toolchain:BUILD.llvm_repo.tpl` and the toolchain's tools directory name, the
programs their links resolve to and LLVM's licence, and publishes the result, 190-235 MB of
zstd, as the repository's `toolchain-llvm-<version>` release, which this rule fetches.
"""

_RELEASE = "https://github.com/merkur-sh/merkur/releases/download/toolchain-llvm-{version}/LLVM-{version}-{platform}.tar.zst"

def _llvm_distribution_impl(rctx):
    rctx.download_and_extract(
        url = _RELEASE.format(version = rctx.attr.version, platform = rctx.attr.platform),
        sha256 = rctx.attr.sha256,
        type = "tar.zst",
    )
    rctx.file("BUILD.bazel", rctx.read(Label("@toolchains_llvm//toolchain:BUILD.llvm_repo.tpl")).format(
        LLVM_VERSION = rctx.attr.version.split(".")[0],
    ))
    return rctx.repo_metadata(reproducible = True)

llvm_distribution = repository_rule(
    implementation = _llvm_distribution_impl,
    attrs = {
        "platform": attr.string(mandatory = True, doc = "The release's platform, `Linux-X64` in `LLVM-23.1.3-Linux-X64`."),
        "sha256": attr.string(mandatory = True, doc = "The trimmed archive's, which `scripts/llvm-distribution.ts` prints."),
        "version": attr.string(mandatory = True),
    },
)
