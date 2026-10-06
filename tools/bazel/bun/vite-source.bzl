"""Original source acquisition for the published, pinned Vite compiler.

The npm release omits gitHead. Its published SLSA source commit and original
annotated release tag agree; this pin names that immutable upstream archive.
Source Files remain original, separate from installed published dist chunks.
"""

load(":vite-source-npm.bzl", "vite_source_npm_build_files")

def _vite_source_impl(ctx):
    pin = json.decode(ctx.read(ctx.attr.pin))
    published = pin["published"]
    archive = pin["source"]
    commit = published["git_commit"]
    if (pin["package"] != "vite" or pin["version"] != "8.2.2" or
        pin["repository"] != {
            "type": "git",
            "url": "git+https://github.com/vitejs/vite.git",
            "directory": "packages/vite",
        } or published["git_head"] != None or
        published["source_ref"] != "refs/tags/v" + pin["version"] or
        len(commit) != 40 or commit.strip("0123456789abcdef") or
        archive["url"] != "https://codeload.github.com/vitejs/vite/tar.gz/" + commit or
        archive["strip_prefix"] != "vite-" + commit):
        fail("Vite source acquisition requires its original published release identity")
    ctx.download_and_extract(
        url = archive["url"],
        sha256 = archive["sha256"],
        type = "tar.gz",
        stripPrefix = archive["strip_prefix"],
        canonical_id = "vite-" + pin["version"] + "-" + archive["sha256"],
    )
    package = json.decode(ctx.read("packages/vite/package.json"))
    original = "packages/vite/src/node/plugins/importAnalysisBuild.ts"
    if (package.get("name") != pin["package"] or package.get("version") != pin["version"] or
        package.get("repository") != pin["repository"] or
        pin["import_analysis_build"]["path"] != original or not ctx.path(original).exists):
        fail("Original Vite archive does not contain the pinned compiler source")
    build_files = vite_source_npm_build_files()
    ctx.file("packages/vite/BUILD.bazel", build_files["packages/vite"] + """
exports_files(glob(["**/package.json"], exclude = ["package.json"]))
filegroup(name = "vite_node_sources", srcs = glob(["src/node/**", "src/shared/**"], allow_empty = False))
""")
    root_build = build_files[""].replace('npm_link_all_packages(name = "node_modules")', 'package(default_visibility = ["//visibility:public"])\nnpm_link_all_packages(name = "node_modules")')
    ctx.file("BUILD.bazel", root_build + """
exports_files(["LICENSE", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"] + glob(["**/package.json", "patches/*.patch"], exclude = ["package.json"]))
alias(name = "import_analysis_build", actual = "//packages/vite:src/node/plugins/importAnalysisBuild.ts")
alias(name = "vite_node_sources", actual = "//packages/vite:vite_node_sources")
filegroup(name = "source", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel"], allow_empty = False) + ["//packages/vite:source_files"])
""")

_vite_source = repository_rule(
    implementation = _vite_source_impl,
    attrs = {"pin": attr.label(default = Label("//tools/bazel/bun:vite-source.json"), allow_single_file = True)},
)

def _vite_impl(module_ctx):
    _vite_source(name = "vite_original_source")
    return module_ctx.extension_metadata(reproducible = True)

vite_source = module_extension(implementation = _vite_impl)
