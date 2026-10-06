"""Acquire only the four official checksum-pinned native Bazel release payloads."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

_PLATFORMS = ["darwin-arm64", "darwin-x86_64", "linux-arm64", "linux-x86_64"]

def _metadata_impl(ctx):
    documents = json.decode(ctx.attr.documents)
    for platform, document in documents.items():
        ctx.file(platform + ".json", json.encode(document) + "\n")
    ctx.file("BUILD.bazel", "exports_files(" + json.encode([platform + ".json" for platform in _PLATFORMS]) + ', visibility = ["//visibility:public"])\n')

_metadata = repository_rule(
    implementation = _metadata_impl,
    attrs = {"documents": attr.string(mandatory = True)},
)

def _engines_impl(ctx):
    pins = json.decode(ctx.read(Label("//:.github/bazel/engine-pins.json")))
    if sorted(pins.keys()) != ["binaries", "version"] or pins["version"] != "9.2.0":
        fail("Bazel engine acquisition requires the exact 9.2.0 pin document")
    binaries = pins["binaries"]
    if type(binaries) != "dict" or sorted(binaries.keys()) != sorted(_PLATFORMS):
        fail("Bazel engine pins must cover exactly four native platforms")
    documents = {}
    for platform in _PLATFORMS:
        digest = binaries[platform]
        if type(digest) != "string" or len(digest) != 64 or any([character not in "0123456789abcdef" for character in digest.elems()]):
            fail("Bazel engine payload requires a canonical SHA256: " + platform)
        url = "https://github.com/bazelbuild/bazel/releases/download/9.2.0/bazel-9.2.0-" + platform
        http_file(
            name = "bazel_engine_" + platform.replace("-", "_"),
            urls = [url],
            sha256 = digest,
            downloaded_file_path = "bazel",
            executable = True,
        )
        documents[platform] = {"version": pins["version"], "platform": platform, "sha256": digest, "url": url, "pins": "//:.github/bazel/engine-pins.json"}
    _metadata(name = "bazel_engine_metadata", documents = json.encode(documents))
    return ctx.extension_metadata(reproducible = True)

engines = module_extension(implementation = _engines_impl)
