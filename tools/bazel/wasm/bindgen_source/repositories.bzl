"""Fetch exact original CLI and locked registry source archives."""

def _original_impl(ctx):
    value = json.decode(ctx.read(ctx.attr.inventory))
    if value["archive_sha256"] != "6123f525ba36df42e57b67027637a78591e712a9f6a025ffd3d74298fa1c3f4c" or value["name"] != "wasm-bindgen-cli" or value["version"] != "0.2.127":
        fail("wasm-bindgen CLI source inventory differs from its original published pin")
    archive = "original/wasm-bindgen-cli-0.2.127.crate"
    ctx.download(value["archive_url"], output = archive, sha256 = value["archive_sha256"])
    ctx.extract(ctx.path(archive), output = "source", strip_prefix = "wasm-bindgen-cli-0.2.127", type = "tar.gz")
    files = sorted(value["source_files"])
    lints = value["lints"]
    rustc = {name: entry if type(entry) == "string" else entry["level"] for name, entry in lints["rust"].items()}
    check_cfg = {}
    for entry in lints["rust"]["unexpected_cfgs"]["check-cfg"]:
        if not entry.startswith("cfg(") or not entry.endswith(")"):
            fail("Original wasm-bindgen CLI lint cfg syntax is not represented")
        name = entry[4:-1]
        if any([character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" for character in name.elems()]):
            fail("Original wasm-bindgen CLI lint cfg requires its actual structured representation")
        check_cfg[name] = []
    source = 'load("@rules_rust//rust:defs.bzl", "rust_lint_config")\n'
    source += 'package(default_visibility = ["//visibility:public"])\n'
    source += "exports_files(" + repr(files) + ")\n"
    source += 'filegroup(name = "rust_sources", srcs = ' + repr([name for name in files if name.endswith(".rs")]) + ")\n"
    source += 'filegroup(name = "package_data", srcs = ' + repr(files) + ")\n"
    source += 'rust_lint_config(name = "manifest_lints", rustc = ' + repr(rustc) + ", rustc_check_cfg = " + repr(check_cfg) + ", clippy = " + repr(lints["clippy"]) + ")\n"
    ctx.file("source/BUILD.bazel", source)
    archives = [archive]
    crate_build = ctx.read(ctx.attr.crate_build)
    for package in value["registry"]:
        basename = package["name"] + "-" + package["version"]
        archive = "archives/" + basename + ".crate"
        ctx.download("https://static.crates.io/crates/" + package["name"] + "/" + basename + ".crate", output = archive, sha256 = package["sha256"])
        ctx.extract(ctx.path(archive), output = "registry/" + basename, strip_prefix = basename, type = "tar.gz")
        if package["name"] == "wasm-bindgen-shared":
            revision = json.decode(ctx.read("registry/" + basename + "/.cargo_vcs_info.json"))
            if package["version"] != "0.2.127" or revision != {"git": {"sha1": value["publisher_revision"]}, "path_in_vcs": "crates/shared"}:
                fail("Original wasm-bindgen shared source revision differs from the pinned CLI publisher")
            ctx.patch(ctx.attr.declared_revision, strip = 1)
        ctx.file("registry/" + basename + "/BUILD.bazel", crate_build)
        archives.append(archive)
    publishers = json.decode(ctx.read(ctx.attr.publisher_licenses))
    for name, source in publishers["sources"].items():
        archive = "publisher-archives/" + name + ".tar.gz"
        ctx.download(source["url"], output = archive, sha256 = source["sha256"])
        ctx.extract(ctx.path(archive), output = "publisher/" + name, strip_prefix = source["prefix"], type = "tar.gz")
        ctx.file("publisher/" + name + "/BUILD.bazel", 'package(default_visibility = ["//visibility:public"])\nexports_files(' + repr(sorted(source["members"])) + ")\n")
        archives.append(archive)
    ctx.file("BUILD.bazel", 'package(default_visibility = ["//visibility:public"])\nexports_files(' + repr(archives) + ")\n")

wasm_bindgen_original = repository_rule(
    implementation = _original_impl,
    attrs = {
        "inventory": attr.label(default = "//tools/bazel/wasm/bindgen_source:original.json", allow_single_file = True),
        "publisher_licenses": attr.label(default = "//tools/bazel/wasm/bindgen_source:publisher-licenses.json", allow_single_file = True),
        "crate_build": attr.label(default = "//tools/bazel/rust:crate_sources.BUILD.bazel", allow_single_file = True),
        "declared_revision": attr.label(default = "//tools/bazel/wasm/bindgen_source:declared-revision.patch", allow_single_file = True),
    },
)
