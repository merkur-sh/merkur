"""Exact owned operation bindings; declarations do not assert qualification."""

BunOperationBindingsInfo = provider(fields = {
    "descriptor": "Operation/check and browser-owner facts bound to configured Target labels.",
    "manifest": "Serialized descriptor File for the independent registry consumer.",
})

_BUILD_OPERATIONS = {
    "build:wasm": "wasm",
    "sync:wasm": "terminal_projection",
    "build:e2e-wasm": "e2e",
    "build:graphics-wasm": "graphics",
    "build:graphics-codec-probe": "graphics_probe",
}

# The extended suites (long graphics, edge topology) belong to the integration owner in
# //tools/bazel/verification:operations.bzl; an operation has exactly one owner.
_LIVE_PENDING = {
    "test:wasm-cipher": "Exact scoped merkur-e2e wasm32 release Rust test compiler and declared WASM runner context are not ported; native and Bun conformance tests do not cover this obligation.",
    "test:e2e": "Declared authenticated server, Redis, browser, fixture lifecycle and complete runtime oracle are not qualified.",
    "test:e2e:email": "Declared email server, captured mail fixture and browser lifecycle oracle are not qualified.",
    "test:e2e:site": "Declared site build, static server, upstream stand-in and browser lifecycle oracle are not qualified.",
    "test:e2e:burst": "Pinned browser exists; this Playwright scheduling suite has no complete declared engine runner.",
    "test:e2e:transport": "Complete declared authenticated daemon/edge/server/browser splice and runtime oracle are not qualified.",
    "test:e2e:rebind": "Complete declared authenticated carrier-rebind lifecycle and calibrated network oracle are not qualified.",
    "test:e2e:transport:reorder": "Complete declared handshake-split network scenario and authenticated transport oracle are not qualified.",
    "test:e2e:latency": "Hardware GPU, real authenticated splice and measurement oracle are not qualified; software rendering is not acceptance.",
    "test:e2e:cloud": "Live cloud credentials, native daemon lifecycle and authenticated runtime oracle are not engine-owned.",
    "test:e2e:edge-probe": "Complete declared native edge and browser WebTransport probe lifecycle is not qualified.",
}

# Exact literal testMatch ownership from the existing Playwright configurations,
# including the selector's explicit rebind/reorder owners and cloud exclusion.
# The registry independently checks this against its captured config authority.
_BROWSER_OWNERS = [
    {
        "pattern": "playwright.burst.config.mjs",
        "operations": [
            "test:e2e:burst"
        ]
    },
    {
        "pattern": "playwright.config.mjs",
        "operations": [
            "test:e2e"
        ]
    },
    {
        "pattern": "playwright.edge-cloud.config.mjs",
        "operations": [
            "test:e2e:cloud"
        ]
    },
    {
        "pattern": "playwright.edge-probe.config.mjs",
        "operations": [
            "test:e2e:edge-probe"
        ]
    },
    {
        "pattern": "playwright.edge-topology.config.mjs",
        "operations": [
            "test:e2e:edge-topology"
        ]
    },
    {
        "pattern": "playwright.edge.config.mjs",
        "operations": [
            "test:e2e:transport",
            "test:e2e:rebind",
            "test:e2e:transport:reorder"
        ]
    },
    {
        "pattern": "playwright.email.config.mjs",
        "operations": [
            "test:e2e:email"
        ]
    },
    {
        "pattern": "playwright.site.config.mjs",
        "operations": [
            "test:e2e:site"
        ]
    },
    {
        "pattern": "tests/e2e/**/app.e2e.ts",
        "operations": [
            "test:e2e"
        ]
    },
    {
        "pattern": "tests/e2e/**/auth-cross-tab.e2e.ts",
        "operations": [
            "test:e2e"
        ]
    },
    {
        "pattern": "tests/e2e/**/auth-email.e2e.ts",
        "operations": [
            "test:e2e:email"
        ]
    },
    {
        "pattern": "tests/e2e/**/auth-resilience.e2e.ts",
        "operations": [
            "test:e2e"
        ]
    },
    {
        "pattern": "tests/e2e/**/carrier-rebind.e2e.ts",
        "operations": [
            "test:e2e:rebind"
        ]
    },
    {
        "pattern": "tests/e2e/**/client-idle-work.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/device-list-updates.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/display-burst-paint.e2e.ts",
        "operations": [
            "test:e2e",
            "test:e2e:burst"
        ]
    },
    {
        "pattern": "tests/e2e/**/display-resync-recovery.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/edge-handshake-reorder.e2e.ts",
        "operations": [
            "test:e2e:transport:reorder"
        ]
    },
    {
        "pattern": "tests/e2e/**/edge-sweep.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/edge-topology.e2e.ts",
        "operations": [
            "test:e2e:edge-topology"
        ]
    },
    {
        "pattern": "tests/e2e/**/edge-wt-probe.e2e.ts",
        "operations": [
            "test:e2e:edge-probe"
        ]
    },
    {
        "pattern": "tests/e2e/**/fence-poll-cadence.e2e.ts",
        "operations": [
            "test:e2e:burst"
        ]
    },
    {
        "pattern": "tests/e2e/**/ios-webkit-startup.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/keyboard-navigation.e2e.ts",
        "operations": [
            "test:e2e"
        ]
    },
    {
        "pattern": "tests/e2e/**/network-handover.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/relay-keystroke-packets.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/site.e2e.ts",
        "operations": [
            "test:e2e:site"
        ]
    },
    {
        "pattern": "tests/e2e/**/startup-latency.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-cursor-motion.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-direct-latency.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-geometry-matrix.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-graphics.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-input-matrix.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-links.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-performance-matrix.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-redraw-reference.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-selection.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-touch-matrix.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal-touch.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/terminal.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/transport-latency.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/tui-direct.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/tui-headless.e2e.ts",
        "operations": [
            "test:e2e:transport"
        ]
    },
    {
        "pattern": "tests/e2e/**/tui-rebind.e2e.ts",
        "operations": [
            "test:e2e:rebind"
        ]
    }
]


def _label(target):
    value = str(target.label)
    return value[2:] if value.startswith("@@//") else value


def _bindings(ctx, builds, pending, browser_owners):
    operations = []
    for name, attribute in builds.items():
        targets = getattr(ctx.attr, attribute)
        if not targets:
            fail("Owned build operation must bind configured producers: " + name)
        checks = []
        for target in targets:
            if not target[DefaultInfo].files.to_list():
                fail("Configured build producer exposes no outputs: " + _label(target))
            checks.append({"label": _label(target), "kind": "build", "fresh": False})
        operations.append({"name": name, "checks": checks, "pending": []})
    if hasattr(ctx.attr, "type_checks"):
        if not ctx.attr.type_checks:
            fail("check:types requires the generated configured project inventory")
        operations.append({
            "name": "check:types",
            "checks": [{"label": _label(target), "kind": "test", "fresh": False} for target in ctx.attr.type_checks],
            "pending": [],
        })
    for name, reason in pending.items():
        operations.append({"name": name, "checks": [], "pending": [reason]})
    descriptor = {
        "operations": operations,
        "crates": [],
        "browserOwners": browser_owners,
    }
    manifest = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(manifest, json.encode(descriptor) + "\n")
    return [
        DefaultInfo(files = depset([manifest])),
        OutputGroupInfo(descriptor = depset([manifest])),
        BunOperationBindingsInfo(descriptor = descriptor, manifest = manifest),
    ]

def _operation_bindings_impl(ctx):
    return _bindings(ctx, _BUILD_OPERATIONS, _LIVE_PENDING, _BROWSER_OWNERS)


def _shipping_operation_bindings_impl(ctx):
    return _bindings(ctx, {"build:web": "frontend", "build:server": "server", "build:daemon": "daemon"}, {}, [])


bun_operation_bindings = rule(
    implementation = _operation_bindings_impl,
    attrs = {
        "type_checks": attr.label_list(mandatory = True),
        "wasm": attr.label_list(default = ["//packages/term-wasm:wasm_artifacts", "//packages/e2e-wasm:wasm_artifacts", "//packages/graphics-wasm:wasm_artifacts"]),
        "terminal_projection": attr.label_list(default = ["//apps/web:term_wasm_runtime"]),
        "e2e": attr.label_list(default = ["//packages/e2e-wasm:wasm_artifacts"]),
        "graphics": attr.label_list(default = ["//packages/graphics-wasm:wasm_artifacts"]),
        "graphics_probe": attr.label_list(default = ["//packages/graphics-codec-probe:wasm_artifacts"]),
    },
)

# Production analysis intentionally requires one coherent immutable release context.
bun_shipping_operation_bindings = rule(
    implementation = _shipping_operation_bindings_impl,
    attrs = {
        "frontend": attr.label_list(default = ["//apps/web:frontend"]),
        "server": attr.label_list(default = ["//apps/server:server"]),
        "daemon": attr.label_list(default = ["//apps/daemon:daemon"]),
    },
)
