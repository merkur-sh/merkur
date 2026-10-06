"""Selected original Vite source importers for the original upstream lock graph."""

load(":rules.bzl", "bun_build_inputs")

VITE_SOURCE_NAMESPACE = "upstream/" + Label("@vite_original_source//:pnpm-lock.yaml").repo_name
VITE_SOURCE_IMPORTERS = ["", "packages/vite"]

def vite_source_npm_inputs(name, **kwargs):
    """Keep original source Files and actual generated npm/peer store relationships."""
    bun_build_inputs(
        name = name,
        external_namespace = "upstream",
        data = [
            "@vite_original_source//:source",
            "@vite_original_source//:node_modules",
            "@vite_original_source//packages/vite:node_modules",
        ],
        **kwargs
    )

def vite_source_npm_build_files():
    """Repository BUILD additions, evaluated against the original translated lock."""
    return {
        "": """load("@vite_source_npm//:defs.bzl", "npm_link_all_packages")
npm_link_all_packages(name = "node_modules")
""",
        "packages/vite": """load("@vite_source_npm//:defs.bzl", "npm_link_all_packages")
load("@aspect_rules_js//npm:defs.bzl", "npm_package")
package(default_visibility = ["//visibility:public"])
npm_link_all_packages(name = "node_modules")
filegroup(name = "source_files", srcs = glob(["**"], exclude = ["BUILD.bazel", "REPO.bazel", "node_modules/**"], allow_empty = False))
npm_package(name = "npm_package", srcs = [":source_files"])
exports_files(["package.json", "rolldown.config.ts", "rolldown.dts.config.ts", "src/node/plugins/importAnalysisBuild.ts"])
""",
    }
