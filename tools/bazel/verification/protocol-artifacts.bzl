"""The original protocol WASM provenance preflight through the declared Bun runtime."""

load("//tools/bazel/bun:rules.bzl", "bun_command_test")


def declare_protocol_artifacts(name):
    """Instantiate only after the original Term and Graphics package producers exist."""
    bun_command_test(
        name = name,
        entry_point = "//scripts:check-wasm-artifacts.ts",
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        data = [
            "//tools/bazel/verification:production_acquisition_sources",
            "//packages/term-wasm:wasm_artifacts",
            "//apps/web:term_wasm_runtime",
            "//packages/graphics-wasm:wasm_artifacts",
            "//apps/web:graphics_wasm_runtime",
        ],
        fixed_args = [],
        tags = ["manual", "unqualified-wasm-runtime"],
    )
