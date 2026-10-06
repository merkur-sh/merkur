"""Original Binaryen 117 and its exact upstream Googletest submodule."""

def _original_impl(ctx):
    pins = json.decode(ctx.read(ctx.attr.pins))
    if pins["version"] != "117" or pins["commit"] != "c62a0c97168e88f97bca4bd96298a5ffc041844d":
        fail("Binaryen requires its original version_117 source revision")
    for name, mount in [("source", "source"), ("googletest", "source/third_party/googletest")]:
        pin = pins[name]
        ctx.download(pin["url"], output = name + ".tar.gz", sha256 = pin["sha256"])
        ctx.extract(ctx.path(name + ".tar.gz"), output = mount, strip_prefix = pin["prefix"], type = "tar.gz")
    unicode_files = []
    for role in ["generator", "data", "readme", "original_cpp", "terms", "license"]:
        pin = pins["unicode"][role]
        ctx.download(pin["url"], output = pin["file"], sha256 = pin["sha256"])
        unicode_files.append(pin["file"])
    # Preserve original bytes without introducing upstream Bazel package boundaries
    # into the declared CMake source closure. The action restores exact member names.
    for member in pins["bazel_members"]:
        ctx.rename("source/" + member, "source/" + member + ".publisher")
    ctx.file("BUILD.bazel", 'package(default_visibility = ["//visibility:public"])\nexports_files(' + repr(["source.tar.gz", "googletest.tar.gz"] + unicode_files) + ')\nfilegroup(name = "source_files", srcs = glob(["source/**"]))\n')

binaryen_original = repository_rule(
    implementation = _original_impl,
    attrs = {"pins": attr.label(default = "//tools/bazel/wasm/binaryen_source:original.json", allow_single_file = True)},
)
