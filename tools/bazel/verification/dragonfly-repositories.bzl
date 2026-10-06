"""Original publisher Dragonfly with a checksum-pinned native Linux runtime."""

_PYTHON = {
    "darwin_arm64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-apple-darwin-install_only_stripped.tar.gz", "44b4716f4e63bc85e1c07ea2aca730d13a0ec3557d06526d84a13b1d111cf4f9"),
    "darwin_x64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-x86_64-apple-darwin-install_only_stripped.tar.gz", "419c8d110a393add7e20480f785a9cc2213978cdb10f8198ee7bb38b02cdb0fe"),
    "linux_arm64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz", "9b8bd45d06fc3fcdc56f2713a62535fe1c019816461ae87c170dd56184dd3f4d"),
    "linux_x64": ("https://github.com/astral-sh/python-build-standalone/releases/download/20260929/cpython-3.14.7%2B20260929-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz", "da5357f47b1d9c8d4c439004d463d893ef688a44c27438a62b47073d26d1377e"),
}

def _runtime_impl(ctx):
    ctx.download_and_extract(url = ctx.attr.python_url, sha256 = ctx.attr.python_sha256, output = ".bootstrap", stripPrefix = "python")
    specification = json.decode(ctx.attr.specification)
    archives = []
    for archive in specification["archives"]:
        file = ".archives/" + archive["archive"]
        ctx.download(url = archive["url"], sha256 = archive["sha256"], output = file)
        archives.append(dict(archive, path = str(ctx.path(file))))
    specification["archives"] = archives
    ctx.file(".archives/specification.json", json.encode(specification))
    result = ctx.execute(
        [str(ctx.path(".bootstrap/bin/python3")), "-B", "-I", str(ctx.path(ctx.attr.producer)), str(ctx.path(".archives/specification.json")), str(ctx.path(".")), str(ctx.path(ctx.attr.elf_parser))],
        environment = {"PATH": "/__no_ambient_native_tools__", "PYTHONPATH": "", "PYTHONHOME": ""},
        timeout = 120,
    )
    if result.return_code != 0:
        fail("Original Dragonfly runtime acquisition failed: " + result.stderr)
    members = json.decode(ctx.read(".dragonfly-members.json"))
    loader = "bin/" + specification["interpreter"].rsplit("/", 1)[1]
    constraints = ["@platforms//os:linux", "@platforms//cpu:aarch64" if specification["cpu"] == 183 else "@platforms//cpu:x86_64"]
    original_archives = [".archives/" + archive["archive"] for archive in archives]
    ctx.file("BUILD.bazel", "\n".join([
        "load(" + json.encode(str(ctx.attr.sdk_rule)) + ', "sdk_executable")',
        'filegroup(name = "runtime", srcs = ' + json.encode(members) + ', visibility = ["//visibility:public"])',
        'filegroup(name = "original_archives", srcs = ' + json.encode(original_archives) + ', visibility = ["//visibility:public"])',
        'exports_files(' + json.encode(members + original_archives) + ', visibility = ["//visibility:public"])',
        'sdk_executable(name = "dragonfly", binary = "bin/dragonfly", sdk = ":runtime", target_compatible_with = ' + json.encode(constraints) + ', visibility = ["//visibility:public"])',
        'sdk_executable(name = "loader", binary = ' + json.encode(loader) + ', sdk = ":runtime", target_compatible_with = ' + json.encode(constraints) + ', visibility = ["//visibility:public"])',
        "",
    ]))

_runtime = repository_rule(
    implementation = _runtime_impl,
    attrs = {
        "specification": attr.string(mandatory = True),
        "python_url": attr.string(mandatory = True),
        "python_sha256": attr.string(mandatory = True),
        "producer": attr.label(default = "//tools/bazel/verification:dragonfly-acquire.py", allow_single_file = True),
        "elf_parser": attr.label(default = "//tools/bazel/tools/native:extract-sdk.py", allow_single_file = True),
        "sdk_rule": attr.label(default = "//tools/bazel/tools/native:sdk.bzl", allow_single_file = True),
    },
)

def _dragonfly_impl(ctx):
    os = "darwin" if ctx.os.name == "mac os x" else "linux" if ctx.os.name == "linux" else None
    cpu = "arm64" if ctx.os.arch in ["aarch64", "arm64"] else "x64" if ctx.os.arch in ["x86_64", "amd64"] else None
    if os == None or cpu == None:
        fail("Dragonfly acquisition requires declared native Darwin/Linux ARM64/x64 Python")
    python = _PYTHON[os + "_" + cpu]
    pins = json.decode(ctx.read(Label("//tools/bazel/verification:dragonfly-pins.json")))
    for platform, specification in pins["platforms"].items():
        _runtime(name = "dragonfly_" + platform, specification = json.encode(specification), python_url = python[0], python_sha256 = python[1])
    return ctx.extension_metadata(reproducible = True)

dragonfly = module_extension(implementation = _dragonfly_impl)
