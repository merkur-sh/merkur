"""Original archive Files and their extracted compiler sources share one pin."""

def _original_impl(ctx):
    document = json.decode(ctx.read(ctx.attr.inventory))
    if document["archive_sha256"] != "700c2b240f7fd330c24b675fe429f73a5b676531fcc6300400b2b67f155ba12a" or document["name"] != "cargo-audit" or document["version"] != "0.22.2":
        fail("cargo-audit source inventory differs from the original published pin")
    original = "original/cargo-audit-0.22.2.crate"
    ctx.download("https://static.crates.io/crates/cargo-audit/cargo-audit-0.22.2.crate", output = original, sha256 = document["archive_sha256"])
    ctx.extract(ctx.path(original), output = "source", strip_prefix = "cargo-audit-0.22.2", type = "tar.gz")
    files = sorted(document["source_files"].keys())
    source_build = 'load("@rules_rust//rust:defs.bzl", "rust_lint_config")\n'
    source_build += 'package(default_visibility = ["//visibility:public"])\n'
    source_build += "exports_files(" + repr(files) + ")\n"
    source_build += 'filegroup(name = "rust_sources", srcs = ' + repr([path for path in files if path.endswith(".rs")]) + ")\n"
    source_build += 'filegroup(name = "package_data", srcs = ' + repr(files) + ")\n"
    source_build += 'rust_lint_config(name = "manifest_lints")\n'
    ctx.file("source/BUILD.bazel", source_build)
    archives = [original]
    crate_build = ctx.read(ctx.attr.crate_build)
    for package in document["registry"]:
        basename = package["name"] + "-" + package["version"]
        archive = "archives/" + basename + ".crate"
        ctx.download("https://static.crates.io/crates/" + package["name"] + "/" + basename + ".crate", output = archive, sha256 = package["sha256"])
        ctx.extract(ctx.path(archive), output = "registry/" + basename, strip_prefix = basename, type = "tar.gz")
        ctx.file("registry/" + basename + "/BUILD.bazel", crate_build)
        archives.append(archive)
    ctx.file("BUILD.bazel", 'package(default_visibility = ["//visibility:public"])\nexports_files(' + repr(archives) + ")\n")

cargo_audit_original = repository_rule(
    implementation = _original_impl,
    attrs = {
        "inventory": attr.label(default = "//tools/bazel/rust/audit_tool:original.json", allow_single_file = True),
        "crate_build": attr.label(default = "//tools/bazel/rust:crate_sources.BUILD.bazel", allow_single_file = True),
    },
)
