"""Pin original fish publisher runtimes and native shell utility distributions."""
load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

_PYTHON = {
    "darwin_arm64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-apple-darwin-install_only_stripped.tar.gz", "44b4716f4e63bc85e1c07ea2aca730d13a0ec3557d06526d84a13b1d111cf4f9"),
    "darwin_x64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-x86_64-apple-darwin-install_only_stripped.tar.gz", "419c8d110a393add7e20480f785a9cc2213978cdb10f8198ee7bb38b02cdb0fe"),
    "linux_arm64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz", "9b8bd45d06fc3fcdc56f2713a62535fe1c019816461ae87c170dd56184dd3f4d"),
    "linux_x64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz", "da5357f47b1d9c8d4c439004d463d893ef688a44c27438a62b47073d26d1377e"),
}

def _runtime_impl(ctx):
    ctx.read(ctx.attr.extractor)
    ctx.read(ctx.attr.validator)
    ctx.download_and_extract(url = ctx.attr.python_url, sha256 = ctx.attr.python_sha256, output = ".bootstrap", stripPrefix = "python")
    specification = []
    for package in json.decode(ctx.attr.packages):
        archive = ".archives/" + package["archive"]
        ctx.download(url = package["url"], sha256 = package["sha256"], output = archive)
        specification.append(dict(package, path = str(ctx.path(archive))))
    ctx.file(".archives/specification.json", json.encode(specification))
    binaries = ["bin/bash", "bin/sh", "bin/zsh", "bin/env", "bin/cat", "bin/touch", "bin/make", "bin/pkg-config.bin"]
    result = ctx.execute([str(ctx.path(".bootstrap/bin/python3")), "-I", "-B", str(ctx.path(ctx.attr.extractor)), str(ctx.path(".archives/specification.json")), str(ctx.path(".")), str(ctx.path("sdk-manifest.json")), str(ctx.attr.cpu), json.encode(binaries), str(ctx.path(ctx.attr.validator))], environment = {"PATH": "/__no_ambient_shell_sdk__", "PYTHONPATH": "", "PYTHONHOME": ""}, timeout = 180)
    if result.return_code != 0:
        fail("Original shell SDK extraction failed: " + result.stderr)
    ctx.file("BUILD.bazel", "exports_files(" + json.encode(binaries + ["sdk-manifest.json"]) + ', visibility = ["//visibility:public"])\nfilegroup(name = "runtime", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel", ".bootstrap/**", ".archives/**"]), visibility = ["//visibility:public"])\n')

_runtime = repository_rule(
    implementation = _runtime_impl,
    attrs = {
        "packages": attr.string(mandatory = True), "cpu": attr.int(mandatory = True),
        "python_url": attr.string(mandatory = True), "python_sha256": attr.string(mandatory = True),
        "extractor": attr.label(default = "//tools/bazel/tools/shell_sdk:extract.py", allow_single_file = True),
        "validator": attr.label(default = "//tools/bazel/tools/native:extract-sdk.py", allow_single_file = True),
    },
)

def _shell_tools_impl(ctx):
    if ctx.os.name == "mac os x":
        host = "darwin_arm64" if ctx.os.arch in ["aarch64", "arm64"] else "darwin_x64"
    elif ctx.os.name == "linux":
        host = "linux_arm64" if ctx.os.arch in ["aarch64", "arm64"] else "linux_x64"
    else:
        fail("Native shell SDK requires Darwin/Linux ARM64/x64")
    pins = json.decode(ctx.read(Label("//tools/bazel/tools/shell_sdk:runtime-pins.json")))
    for platform, packages in pins["platforms"].items():
        cpu = 16777228 if platform == "darwin_arm64" else 16777223 if platform == "darwin_x64" else 183 if platform == "linux_arm64" else 62
        _runtime(name = "shell_runtime_" + platform, packages = json.encode(packages), cpu = cpu, python_url = _PYTHON[host][0], python_sha256 = _PYTHON[host][1])
    fish = json.decode(ctx.read(Label("//tools/bazel/tools/shell_sdk:fish-pins.json")))
    http_archive(name = "shell_fish_source", urls = [fish["source"]["url"]], sha256 = fish["source"]["sha256"], strip_prefix = fish["source"]["strip_prefix"], type = "tar.xz", build_file_content = 'exports_files(["COPYING"], visibility = ["//visibility:public"])\nfilegroup(name = "source", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\n')
    for platform, archive in fish["platforms"].items():
        if platform.startswith("darwin_"):
            http_archive(name = "shell_fish_" + platform, urls = [archive["url"]], sha256 = archive["sha256"], strip_prefix = archive["strip_prefix"], type = "zip", build_file_content = 'exports_files(["bin/fish"], visibility = ["//visibility:public"])\nfilegroup(name = "runtime", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]) + ["@shell_fish_source//:source"], visibility = ["//visibility:public"])\n')
        else:
            http_archive(name = "shell_fish_" + platform, urls = [archive["url"]], sha256 = archive["sha256"], type = "tar.xz", build_file_content = 'exports_files(["fish"], visibility = ["//visibility:public"])\nfilegroup(name = "runtime", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]) + ["@shell_fish_source//:source"], visibility = ["//visibility:public"])\n')
    tmux = json.decode(ctx.read(Label("//tools/bazel/tools/shell_sdk:tmux-pins.json")))
    http_archive(name = "shell_tmux_source", urls = [tmux["source"]["url"]], sha256 = tmux["source"]["sha256"], strip_prefix = tmux["source"]["strip_prefix"], type = "tar.gz", patches = [Label("//tools/bazel/tools/shell_sdk:tmux-declared-shell.patch")], patch_args = ["-p1"], build_file_content = 'filegroup(name = "source", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\n')
    http_archive(name = "shell_zsh_source", urls = ["https://downloads.sourceforge.net/project/zsh/zsh/5.9/zsh-5.9.tar.xz"], sha256 = "9b8d1ecedd5b5e81fbf1918e876752a7dd948e05c1a0dba10ab863842d45acd5", type = "tar.xz", strip_prefix = "zsh-5.9", build_file_content = 'filegroup(name = "source", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\n')
    return ctx.extension_metadata(reproducible = True)

shell_tools = module_extension(implementation = _shell_tools_impl)
