"""The original LLVM21.1.8 source File used to build Bun's LLVM tools."""
load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

def llvm_source():
    http_file(
        name = "merkur_llvm_21_1_8_source",
        urls = ["https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.8/llvm-project-21.1.8.src.tar.xz"],
        sha256 = "4633a23617fa31a3ea51242586ea7fb1da7140e426bd62fc164261fe036aa142",
        downloaded_file_path = "llvm-project-21.1.8.src.tar.xz",
    )

def _source_impl(_module_ctx):
    llvm_source()
    return _module_ctx.extension_metadata(reproducible = True)

llvm_sources = module_extension(implementation = _source_impl)
