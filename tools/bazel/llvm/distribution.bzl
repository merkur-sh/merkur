"""The LLVM release the C and C++ toolchain runs, unpacked to the files the toolchain names.

A release archive holds about 8 GB, most of it MLIR, LLDB, Flang, BOLT and LLVM's development
headers and libraries. Bazel's own decoder unpacked all of it on one CPU, six minutes of every CI
job; `tar` here decodes with every CPU the host's `xz` has (GNU tar) or with libarchive (bsdtar)
and writes only what `@toolchains_llvm//toolchain:BUILD.llvm_repo.tpl` and the toolchain's tools
directory name, with the programs their links resolve to.
"""

_RELEASE = "https://github.com/llvm/llvm-project/releases/download/llvmorg-{version}/{archive}.tar.xz"

_PROGRAMS = [
    "clang",
    "clang++",
    "clang-23",
    "clang-cpp",
    "clang-format",
    "clang-tidy",
    "clangd",
    "ld.lld",
    "ld64.lld",
    "lld",
    "llvm-ar",
    "llvm-as",
    "llvm-cov",
    "llvm-dwp",
    "llvm-install-name-tool",
    "llvm-nm",
    "llvm-objcopy",
    "llvm-objdump",
    "llvm-profdata",
    "llvm-ranlib",
    "llvm-readelf",
    "llvm-readobj",
    "llvm-strip",
    "llvm-symbolizer",
    "wasm-ld",
]

_HEADERS = [
    "include/c++",
    "include/__libunwind_config.h",
    "include/libunwind.h",
    "include/libunwind.modulemap",
    "include/unwind.h",
    "include/unwind_arm_ehabi.h",
    "include/unwind_itanium.h",
]

# Darwin's libc++ and libunwind sit in `lib`, beside the LTO plugin Apple's linker loads; Linux
# keeps its libraries and `__config_site` under the target's triple.
_DARWIN = [
    "bin/llvm-libtool-darwin",
    "lib/libc++.a",
    "lib/libc++abi.a",
    "lib/libc++experimental.a",
    "lib/libunwind.a",
    "lib/libLTO.dylib",
]

def _llvm_distribution_impl(rctx):
    archive = "LLVM-%s-%s" % (rctx.attr.version, rctx.attr.platform)
    rctx.download(
        url = _RELEASE.format(version = rctx.attr.version, archive = archive),
        sha256 = rctx.attr.sha256,
        output = "llvm.tar.xz",
    )
    members = ["bin/" + program for program in _PROGRAMS] + _HEADERS + ["lib/clang"] + (
        ["include/" + rctx.attr.triple, "lib/" + rctx.attr.triple] if rctx.attr.triple else _DARWIN
    )
    rctx.file("members", "".join(["%s/%s\n" % (archive, member) for member in members]))
    result = rctx.execute(
        ["tar", "-xf", "llvm.tar.xz", "--strip-components=1", "-T", "members"],
        timeout = 1800,
    )
    if result.return_code:
        fail("unpacking %s: %s" % (archive, result.stderr))
    rctx.delete("llvm.tar.xz")
    rctx.delete("members")
    rctx.file("BUILD.bazel", rctx.read(Label("@toolchains_llvm//toolchain:BUILD.llvm_repo.tpl")).format(
        LLVM_VERSION = rctx.attr.version.split(".")[0],
    ))
    return rctx.repo_metadata(reproducible = True)

llvm_distribution = repository_rule(
    implementation = _llvm_distribution_impl,
    attrs = {
        "platform": attr.string(mandatory = True, doc = "The release's platform, `Linux-X64` in `LLVM-23.1.3-Linux-X64.tar.xz`."),
        "sha256": attr.string(mandatory = True),
        "triple": attr.string(doc = "The target triple Linux's libraries and `__config_site` sit under; empty for Darwin."),
        "version": attr.string(mandatory = True),
    },
)
