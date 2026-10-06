"""Declared Dragonfly backend and all original live-service integration suites."""

load("//tools/bazel/bun:rules.bzl", "bun_command_test")

_SUITES = [
    "services/redis-service",
    "services/browser-session-presence",
    "services/realtime-coordination-service",
    "services/auth-flow-store",
    "services/rate-limit-service",
    "services/edge-registry-service",
    "services/daemon-control-service",
    "http/daemon-request-auth",
    "services/session-issuance-service",
    "services/notification-outbox-service",
]

def dragonfly_test(name, backend, backend_loader, backend_runtime = [], tags = [], **kwargs):
    """Use a declared native Dragonfly v2.0.0 executable, never a Docker/Redis fallback.

    backend must expose its executable and default runfiles, including its native
    loader closure. backend_runtime supplies any separately declared runtime Files.
    The caller keeps operation admission pending until genuine backend qualification.
    """
    bun_command_test(
        name = name,
        entry_point = "//tools/bazel/verification:dragonfly-run.ts",
        fixed_args = ["apps/server/src/" + suite + ".dragonfly.test.ts" for suite in _SUITES],
        data = [
            "//tools/bazel/verification:dragonfly-runtime.ts",
            "//scripts:junit_validator",
            "//scripts:test_preload",
            "//packages/e2e-wasm:wasm_artifacts",
            "//apps/server:runtime_assets",
        ] + ["//apps/server:inputs__src__" + suite.replace("/", "__") + ".dragonfly.test.ts" for suite in _SUITES] + backend_runtime,
        tools = {backend: "dragonfly", backend_loader: "dragonfly_loader"},
        tool_environment = {"dragonfly": "MERKUR_DRAGONFLY_BIN", "dragonfly_loader": "MERKUR_DRAGONFLY_LOADER"},
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        tags = ["dragonfly"] + tags,
        **kwargs
    )
