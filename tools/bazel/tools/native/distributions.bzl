"""Original Git source required by the declared native shell build."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

GIT_VERSION = "2.56.0"
GIT_SOURCE_SHA256 = "26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3"

def git_source_distribution(name):
    """Acquire unchanged release source, with the publisher's release checksum.

    The native build must use SHELL_PATH=sh and a PATH containing only declared
    SDK executables. Existing distribution binaries compiled with /bin/sh do
    not qualify the credential-helper execution boundary.
    """
    http_archive(
        name = name,
        urls = ["https://www.kernel.org/pub/software/scm/git/git-" + GIT_VERSION + ".tar.xz"],
        sha256 = GIT_SOURCE_SHA256,
        strip_prefix = "git-" + GIT_VERSION,
        build_file_content = 'filegroup(name = "source", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\nexports_files(["Makefile", "run-command.c"], visibility = ["//visibility:public"])\n',
    )
