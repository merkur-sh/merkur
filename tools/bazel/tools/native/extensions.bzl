"""Official standalone native Python distributions, including their entire runtime closure."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")
load(":distributions.bzl", "git_source_distribution")

_PYTHON = {
    "darwin_arm64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-apple-darwin-install_only_stripped.tar.gz", "44b4716f4e63bc85e1c07ea2aca730d13a0ec3557d06526d84a13b1d111cf4f9"),
    "darwin_x64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-x86_64-apple-darwin-install_only_stripped.tar.gz", "419c8d110a393add7e20480f785a9cc2213978cdb10f8198ee7bb38b02cdb0fe"),
    "linux_arm64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz", "9b8bd45d06fc3fcdc56f2713a62535fe1c019816461ae87c170dd56184dd3f4d"),
    "linux_x64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz", "da5357f47b1d9c8d4c439004d463d893ef688a44c27438a62b47073d26d1377e"),
}

def _darwin_sdk_impl(ctx):
    ctx.download_and_extract(url = ctx.attr.python_url, sha256 = ctx.attr.python_sha256, output = ".bootstrap", stripPrefix = "python")
    packages = json.decode(ctx.attr.packages)
    specification = []
    for package in packages:
        archive = ".archives/" + package["archive"]
        ctx.download(url = package["url"], sha256 = package["sha256"], output = archive)
        specification.append(dict(package, path = str(ctx.path(archive))))
    ctx.file(".archives/specification.json", json.encode(specification))
    binaries = ctx.attr.binaries
    result = ctx.execute([str(ctx.path(".bootstrap/bin/python3")), "-I", str(ctx.path(ctx.attr.extractor)), str(ctx.path(".archives/specification.json")), str(ctx.path(".")), str(ctx.path("sdk-manifest.json")), str(ctx.attr.cpu), json.encode(binaries)], environment = {"PATH": "/__no_ambient_native_sdk_tools__", "PYTHONPATH": "", "PYTHONHOME": ""}, timeout = 120)
    if result.return_code != 0:
        fail("Verified native SDK extraction failed: " + result.stderr)
    # Git runs from its own programs, the SDK's commands and shared libraries, its templates and
    # the certificate store; a check that declares only Git is not handed the SDK's manuals,
    # headers, terminal database and Perl library.
    ctx.file("BUILD.bazel", "exports_files(" + json.encode(binaries + ["sdk-manifest.json"]) + ', visibility = ["//visibility:public"])\nfilegroup(name = "runtime", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel", ".bootstrap/**", ".archives/**"]), visibility = ["//visibility:public"])\nfilegroup(name = "git_runtime", srcs = glob(["bin/**", "etc/**", "lib/*.dylib", "libexec/git-core/**", "share/git-core/**", "ssl/**"], allow_empty = True), visibility = ["//visibility:public"])\n')

_darwin_sdk = repository_rule(
    implementation = _darwin_sdk_impl,
    attrs = {
        "packages": attr.string(mandatory = True),
        "cpu": attr.int(mandatory = True),
        "binaries": attr.string_list(mandatory = True),
        "python_url": attr.string(mandatory = True),
        "python_sha256": attr.string(mandatory = True),
        "extractor": attr.label(default = "//tools/bazel/tools/native:extract-sdk.py", allow_single_file = True),
    },
)

def _native_tools_impl(module_ctx):
    git_source_distribution(name = "git_declared_shell_source")
    for platform, (url, digest) in _PYTHON.items():
        http_archive(
            name = "python_" + platform,
            urls = [url],
            sha256 = digest,
            strip_prefix = "python",
            build_file_content = 'exports_files(["bin/python3"], visibility = ["//visibility:public"])\nfilegroup(name = "runtime", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"]), visibility = ["//visibility:public"])\n',
        )
    if module_ctx.os.name == "mac os x":
        host = "darwin_arm64" if module_ctx.os.arch in ["aarch64", "arm64"] else "darwin_x64" if module_ctx.os.arch in ["x86_64", "amd64"] else None
    elif module_ctx.os.name == "linux":
        host = "linux_arm64" if module_ctx.os.arch in ["aarch64", "arm64"] else "linux_x64" if module_ctx.os.arch in ["x86_64", "amd64"] else None
    else:
        host = None
    if host == None:
        fail("Native SDK acquisition requires Darwin/Linux ARM64/x64")
    pins = json.decode(module_ctx.read(Label("//tools/bazel/tools/native:darwin-pins.json")))["platforms"]
    for platform, packages in pins.items():
        _darwin_sdk(name = "tools_" + platform, packages = json.encode(packages), binaries = ["bin/bash", "bin/mkdir", "bin/chmod", "bin/echo", "bin/touch", "bin/cp", "bin/rm", "bin/cat", "bin/env", "bin/git", "bin/tar", "bin/gzip", "bin/openssl", "bin/redis-server"], cpu = 16777228 if platform == "darwin_arm64" else 16777223, python_url = _PYTHON[host][0], python_sha256 = _PYTHON[host][1])
    linux_pins = json.decode(module_ctx.read(Label("//tools/bazel/tools/native:linux-redis-pins.json")))["platforms"]
    for platform, packages in linux_pins.items():
        _darwin_sdk(name = "redis_" + platform, packages = json.encode(packages), binaries = ["bin/redis-server", "bin/openssl"], cpu = 183 if platform == "linux_arm64" else 62, python_url = _PYTHON[host][0], python_sha256 = _PYTHON[host][1])
    utility_pins = json.decode(module_ctx.read(Label("//tools/bazel/tools/native:linux-tools-pins.json")))["platforms"]
    for platform, packages in utility_pins.items():
        _darwin_sdk(name = "tools_" + platform, packages = json.encode(packages), binaries = ["bin/bash", "bin/mkdir", "bin/chmod", "bin/echo", "bin/touch", "bin/cp", "bin/rm", "bin/cat", "bin/env", "bin/tar", "bin/gzip", "bin/openssl", "bin/redis-server", "bin/make", "bin/sed", "bin/grep", "bin/gawk", "bin/find", "bin/diff", "bin/uname"], cpu = 183 if platform == "linux_arm64" else 62, python_url = _PYTHON[host][0], python_sha256 = _PYTHON[host][1])
    build_pins = json.decode(module_ctx.read(Label("//tools/bazel/tools/native:git-build-pins.json")))["platforms"]
    for platform, packages in build_pins.items():
        if platform.startswith("darwin_"):
            _darwin_sdk(name = "build_tools_" + platform, packages = json.encode(packages), binaries = ["bin/bash", "bin/make", "bin/sed", "bin/grep", "bin/gawk", "bin/find", "bin/diff", "bin/uname"], cpu = 16777228 if platform == "darwin_arm64" else 16777223, python_url = _PYTHON[host][0], python_sha256 = _PYTHON[host][1])
    return module_ctx.extension_metadata(reproducible = True)

native_tools = module_extension(implementation = _native_tools_impl, os_dependent = True, arch_dependent = True)
