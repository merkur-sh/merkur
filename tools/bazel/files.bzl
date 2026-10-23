"""Every package's source files, for the tests that read the checkout as a whole."""

load("//tools/bazel:modules.bzl", "MODULES", "TYPE_INPUTS")
load("//tools/bazel/rust:clippy.bzl", "lint_targets")

# What `.gitignore` keeps out of the checkout: installed dependencies, build outputs, local
# state and credentials. A glob sees untracked files too, so these never become inputs.
IGNORED = [
    "**/.DS_Store",
    # A linked worktree's `.git` file, which names the main repository.
    "**/.git",
    "**/.git/**",
    "**/.e2e-home*/**",
    "**/.env",
    "**/.env.*",
    "**/*.log",
    "**/*.tsbuildinfo",
    "**/__pycache__/**",
    "**/build/**",
    "**/coverage/**",
    "**/data/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/pkg/**",
    "**/playwright-report/**",
    "**/target/**",
    "**/test-results/**",
]

# A tracked file the patterns above would otherwise drop.
_KEPT = ["**/.env.example"]

def module_targets():
    """`<path>.module` for each file of the package a Bun test loads: the file and what it loads.

    And `type_inputs/<project>`, the package's files a TypeScript project's `tsc` reads.
    `tools/bazel/modules.bzl` lists both, which `scripts/bazel-modules.ts` generates.
    """
    package = native.package_name()
    for file, loads in MODULES.get(package, {}).items():
        native.filegroup(
            name = file + ".module",
            srcs = [file] + loads,
            visibility = ["//visibility:public"],
        )
    for project, files in TYPE_INPUTS.get(package, {}).items():
        native.filegroup(
            name = "type_inputs/" + project,
            srcs = files,
            visibility = ["//visibility:public"],
        )

def package_files(name = "files"):
    """The package's own source files, as `//:sources` gathers them, its module targets and its
    Clippy report.

    Args:
      name: the filegroup's name.
    """
    native.filegroup(
        name = name,
        srcs = native.glob(["**"], exclude = IGNORED, allow_empty = True) +
               native.glob(_KEPT, allow_empty = True),
        visibility = ["//visibility:public"],
    )
    module_targets()
    lint_targets(name = "clippy_diagnostics")
