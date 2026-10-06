"""Exact publisher metadata/commit inputs; reuse original locked npm archives."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

def _name(package):
    return package["name"].replace(".", "_").replace("-", "_") + "_" + package["version"].replace(".", "_")

def _inputs_impl(ctx):
    inputs = {}
    files = []
    for entry in json.decode(ctx.attr.packages):
        package = entry["package"]
        identity = package["name"] + "@" + package["version"]
        values = {}
        for kind in ["metadata", "source"]:
            label = "@bun_npm_publisher_" + _name(package) + "_" + kind + "//file"
            values[kind] = label
            files.append(label)
        inputs[identity] = values
    ctx.file("defs.bzl", "PUBLISHER_NOTICE_INPUTS = " + json.encode(inputs) + "\n")
    ctx.file("BUILD.bazel", '\n'.join([
        'exports_files(["defs.bzl"])',
        'filegroup(name = "original_inputs", srcs = ' + json.encode(files) + ', visibility = ["//visibility:public"])',
        "",
    ]))

_inputs = repository_rule(
    implementation = _inputs_impl,
    attrs = {"packages": attr.string(mandatory = True)},
)

def _publishers_impl(ctx):
    pins = json.decode(ctx.read(Label("//tools/bazel/bun:npm_publisher_licenses/pins.json")))
    original = json.decode(ctx.read(Label("//tools/bazel/bun:bun-runtime-build-npm.json")))
    locked = {entry["name"] + "@" + entry["version"]: entry for entry in original["packages"]}
    seen = {}
    for entry in pins["packages"]:
        package = entry["package"]
        identity = package["name"] + "@" + package["version"]
        if identity in seen or locked.get(identity) != package:
            fail("Publisher notice differs from exact original locked npm package")
        seen[identity] = True
        for kind in ["metadata", "source"]:
            fact = entry[kind]
            http_file(
                name = "bun_npm_publisher_" + _name(package) + "_" + kind,
                urls = [fact["url"]],
                sha256 = fact["sha256"],
                downloaded_file_path = "publisher.json" if kind == "metadata" else "source.tar.gz",
            )
    _inputs(name = "bun_npm_publisher_notice_inputs", packages = json.encode(pins["packages"]))
    return ctx.extension_metadata(reproducible = True)

bun_npm_publisher_notices = module_extension(implementation = _publishers_impl)
