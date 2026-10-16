"""The original LLVM23.1.1 source File used to build Bun's LLVM tools."""
load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

def llvm_source():
    http_file(
        name = "merkur_llvm_23_1_1_source",
        urls = ["https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.1/llvm-project-23.1.1.src.tar.xz"],
        sha256 = "ebe9be46fe8756d58c5b198ffad0fa2a766257add81a4dc52179bfacc7888ee6",
        downloaded_file_path = "llvm-project-23.1.1.src.tar.xz",
    )

def _source_impl(_module_ctx):
    llvm_source()
    return _module_ctx.extension_metadata(reproducible = True)

llvm_sources = module_extension(implementation = _source_impl)
