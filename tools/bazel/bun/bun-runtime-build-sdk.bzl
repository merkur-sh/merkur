"""Assemble original pinned nightly SDK payloads; qualification is separate."""

_TARGETS = {
    "darwin_arm64": "aarch64-apple-darwin",
    "darwin_x64": "x86_64-apple-darwin",
    "linux_arm64": "aarch64-unknown-linux-gnu",
    "linux_x64": "x86_64-unknown-linux-gnu",
}

def _sdk_impl(ctx):
    pins = json.decode(ctx.read(ctx.attr.pins))
    archives = {}
    for name, component in pins["nightly"]["components"].items():
        key = "*" if name == "rust-src" else ctx.attr.target
        archive = component["targets"][key]
        output = ".archives/" + archive["url"].rsplit("/", 1)[1]
        ctx.download(url = archive["url"], sha256 = archive["sha256"], output = output)
        archives[name] = str(ctx.path(output))
    ctx.file(".archives/spec.json", json.encode({"target": ctx.attr.target, "archives": archives}))
    # Resolve declared helpers before invoking the original standalone Python.
    # Its immutable source repository contains the complete adjacent runtime.
    for helper in ctx.attr.modules:
        ctx.path(helper)
    result = ctx.execute(
        [str(ctx.path(ctx.attr.python)), "-B", "-I", str(ctx.path(ctx.attr.runner)),
         str(ctx.path(".archives/spec.json")), str(ctx.path(ctx.attr.pins)), str(ctx.path("sdk")),
         str(ctx.path(ctx.attr.custody)), str(ctx.path(ctx.attr.deployment)),
         str(ctx.path(ctx.attr.output_tree)), str(ctx.path(ctx.attr.builder))],
        environment = {"PATH": "", "PYTHONPATH": "", "PYTHONHOME": "", "HOME": str(ctx.path(".home"))},
        timeout = 120,
    )
    if result.return_code != 0:
        fail("Original Bun nightly SDK payload assembly failed: " + result.stderr)
    payload = json.decode(ctx.read("sdk/sdk-payload.json"))
    members = ["sdk/" + file["path"] for file in payload["files"]] + ["sdk/sdk-payload.json"]
    original_archives = [".archives/" + path.rsplit("/", 1)[1] for path in archives.values()]
    ctx.file("BUILD.bazel", "\n".join([
        'exports_files(' + json.encode(members + original_archives) + ', visibility = ["//visibility:public"])',
        'filegroup(name = "payload", srcs = ' + json.encode(members) + ', visibility = ["//visibility:public"])',
        'filegroup(name = "original_archives", srcs = ' + json.encode(original_archives) + ', visibility = ["//visibility:public"])',
        "",
    ]))
    # Deliberately no NativeSdkInfo or SelectedAttributionInfo. Original payload
    # assembly cannot stand in for loader execution or selected linked source.

_nightly_sdk = repository_rule(
    implementation = _sdk_impl,
    attrs = {
        "target": attr.string(mandatory = True),
        "python": attr.label(allow_single_file = True, mandatory = True),
        "pins": attr.label(default = "//tools/bazel/bun:bun-runtime-build-pins.json", allow_single_file = True),
        "runner": attr.label(default = "//tools/bazel/bun:bun-runtime-build-sdk.py", allow_single_file = True),
        "custody": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution.py", allow_single_file = True),
        "deployment": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "output_tree": attr.label(default = "//tools/bazel/packaging:output-tree.py", allow_single_file = True),
        "builder": attr.label(default = "//tools/bazel/bun:bun-runtime-build.py", allow_single_file = True),
        "modules": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
    },
)

def _nightly_sdks_impl(ctx):
    os = "darwin" if ctx.os.name == "mac os x" else "linux" if ctx.os.name == "linux" else None
    arch = "arm64" if ctx.os.arch in ["arm64", "aarch64"] else "x64" if ctx.os.arch in ["x86_64", "amd64"] else None
    if os == None or arch == None:
        fail("Original Bun nightly payload assembly requires declared native Darwin/Linux ARM64/x64 Python")
    python = Label("@python_" + os + "_" + arch + "//:bin/python3")
    for platform, target in _TARGETS.items():
        _nightly_sdk(name = "bun_nightly_sdk_" + platform, target = target, python = python)
    return ctx.extension_metadata(reproducible = True)

bun_runtime_build_nightly_sdks = module_extension(implementation = _nightly_sdks_impl)
