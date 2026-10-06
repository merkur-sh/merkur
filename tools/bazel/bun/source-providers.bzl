"""Existing original source-built Vite provider shared without an execution-rule cycle."""

ViteSourceBuildInfo = provider(fields = {
    "tree": "Declared source-built tool workspace, including its closed dependency graph.",
    "package_directory": "Exact original package path inside the tool workspace.",
    "inputs": "Original source, lock, dependency, compiler and generator Files.",
    "native": "Actual rebuilt native binding File.",
    "preload": "Actual prepared original generator script File.",
    "source_manifest": "Original compiler-selected native package manifest File.",
    "source_manifests": "Original native workspace manifests from the actual compiler dependency closure.",
    "workspace_manifest": "Original native source workspace Cargo manifest File.",
    "workspace_license": "Original native source workspace license File.",
})
