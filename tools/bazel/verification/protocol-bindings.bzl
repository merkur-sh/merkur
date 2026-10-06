"""Original protocol selection bound to actual configured Bazel producers."""

load(":operations.bzl", "StaticOperationBindingsInfo")
load("//tools/bazel/rust:units.bzl", "configured_public_rust_test")
load(":test-nonce.bzl", "TestRuntimeInfo")

_SCAN = "scripts/current-protocol-hard-cut.test.ts"
_BUN_TESTS = [
    "scripts/term-wasm-current-glue.test.ts",
    "scripts/term-wasm-provenance.test.ts",
    "packages/protocol/src/wire-conformance.test.ts",
    "packages/auth/src/session-authorization.test.ts",
    "packages/daemon-control-protocol/src/index.test.ts",
    "packages/shared/src/display-stream.test.ts",
    "packages/shared/src/edge-webtransport.test.ts",
    "packages/shared/src/ipc-wire-conformance.test.ts",
    "packages/shared/src/transport.test.ts",
    "packages/config/src/reconnect-policy.test.ts",
    "packages/e2e-wasm/conformance.test.ts",
    "apps/server/src/http/routes/edge-routes.test.ts",
    "apps/server/src/http/routes/session-routes.test.ts",
    "apps/server/src/services/edge-registry-service.test.ts",
    "apps/web/src/transport/client-carrier.test.ts",
    "scripts/perf/client-session-fixture.test.ts",
    "apps/web/src/terminal-worker-display-owner.test.ts",
    "apps/web/src/session/session-response.test.ts",
    "packages/shared/src/terminal.test.ts",
]
_DATAPLANE_FILTERS = [
    "auth::tests",
    "identity_seal::",
    "ipc::commands::",
    "args_tests::",
    "session::rebind_flow::tests",
    "network::protocol::tests",
    "network::peer::tests",
    "edge_tunnel::tests",
    "session::auth_flow::tests",
    "wt_upgrade::tests",
    "e2e_dispatch_tests",
    "auth_on_signaling_tests",
]
_DATAPLANE_SKIPS = ["live_edge_roundtrip"]
_CRATES = ["merkur-e2e", "merkur-edge", "merkur-client", "merkur-client-native", "merkur-wire"]

def _bun_label(file):
    parts = file.split("/")
    count = 1 if parts[0] == "scripts" else 2
    return "//" + "/".join(parts[:count]) + ":test__" + "__".join(parts[count:])

def _native_roles(roots, expected):
    if not expected or len(expected) != len({role: True for role in expected}):
        fail("Protocol native roots require a nonempty unique original compiler inventory")
    if roots and sorted(roots.keys()) != sorted(expected):
        fail("Protocol native roots differ from the original complete test/doctest selection")
    crates = {}
    for role in expected:
        parts = role.split("/")
        if len(parts) != 2 or parts[0] not in _CRATES or not parts[1] or (roots and not roots[role]):
            fail("Missing or foreign configured protocol native producer: " + role)
        mode = parts[1].split(":")
        if len(mode) != 2 or mode[0] not in ["test", "doctest", "build"] or not mode[1]:
            fail("Protocol native role must retain its original Cargo compiler mode: " + role)
        crates[parts[0]] = True
    if sorted(crates.keys()) != sorted(_CRATES):
        fail("Protocol must bind every original whole-crate test/doctest context")

def _native_capture(roots, expected, dataplane_lib, dataplane_bin):
    _native_roles(roots, expected)
    if bool(roots) != bool(dataplane_lib) or bool(roots) != bool(dataplane_bin):
        fail("Protocol native compiler selection must be entirely bound or explicitly missing")
    return bool(roots)

def _check(target, kind):
    if kind == "test" and not target[DefaultInfo].files_to_run.executable:
        fail("Protocol requires the actual configured executable: " + str(target.label))
    if kind == "build" and not target[DefaultInfo].files.to_list():
        fail("Protocol requires the actual configured build outputs: " + str(target.label))
    if kind == "test" and TestRuntimeInfo not in target:
        fail("Protocol test lacks its declared nonce-independent runtime: " + str(target.label))
    label = str(target.label)
    return {"label": label[2:] if label.startswith("@@//") else label, "kind": kind, "fresh": kind == "test"}

def _impl(ctx):
    bound_native = _native_capture(ctx.attr.native_roots, ctx.attr.expected_native_roles, ctx.attr.dataplane, ctx.attr.dataplane_bin)
    expected_bun = [_bun_label(file) for file in [_SCAN] + _BUN_TESTS]
    actual_bun = [_check(target, "test") for target in ctx.attr.bun_tests]
    if [check["label"] for check in actual_bun] != expected_bun:
        fail("Protocol Bun producers differ from the exact original source selection")
    checks = actual_bun[:1]
    missing = []
    for role, target, kind in [("terminal WASM artifact provenance preflight", ctx.attr.wasm_provenance, "test"), ("authenticated client-session oracle preflight build", ctx.attr.client_oracle, "build")]:
        if target:
            checks.append(_check(target, kind))
        else:
            missing.append("Original protocol " + role + " has no matched declared producer.")
    if bound_native:
        checks += [_check(ctx.attr.native_roots[role], "build" if role.split("/")[1].startswith("build:") else "test") for role in sorted(ctx.attr.expected_native_roles)]
        checks += [_check(ctx.attr.dataplane, "test"), _check(ctx.attr.dataplane_bin, "test")]
    else:
        missing += ["Original protocol native root " + role + ": the selected platform has no matching original native compiler capture." for role in sorted(ctx.attr.expected_native_roles)]
        missing += ["Original protocol dataplane library and binary filtered harnesses: the selected platform has no matching original native compiler capture."]
    if ctx.attr.wasm_cipher:
        checks.append(_check(ctx.attr.wasm_cipher, "test"))
    else:
        missing.append("Original release wasm32 cipher library harness and declared wasm-bindgen/Node runtime are not bound on this platform.")
    checks += actual_bun[1:]
    labels = [check["label"] for check in checks]
    if len(labels) != len({label: True for label in labels}):
        fail("Protocol producer roles must not alias another selected check")
    descriptor = {
        "operations": [{
            "name": "check:protocol",
            "checks": checks,
            "pending": [
                "Original protocol native compiler, SDK and runtime contexts require four-platform qualification.",
                "Original release wasm32 cipher with wasm feature, SIMD flags, wasm-bindgen test runner and Node requires runtime qualification.",
                "Protocol Bun generated-artifact and authenticated client-oracle dependency closure requires runtime qualification.",
            ] + missing,
        }],
        "crates": [],
        "browserOwners": [],
    }
    manifest = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(manifest, json.encode(descriptor) + "\n")
    return [
        DefaultInfo(files = depset([manifest])),
        StaticOperationBindingsInfo(descriptor = descriptor, manifest = manifest),
        OutputGroupInfo(descriptor = depset([manifest])),
    ]

_protocol_bindings = rule(
    implementation = _impl,
    attrs = {
        "native_roots": attr.string_keyed_label_dict(mandatory = True),
        "expected_native_roles": attr.string_list(mandatory = True),
        "bun_tests": attr.label_list(mandatory = True),
        "dataplane": attr.label(),
        "dataplane_bin": attr.label(),
        "wasm_cipher": attr.label(),
        "wasm_provenance": attr.label(),
        "client_oracle": attr.label(),
    },
)

def declare_protocol_bindings(name, native_configuration, native_constraints, native_roots, expected_native_roles, dataplane_lib, dataplane_bin, wasm_cipher, wasm_provenance, client_oracle):
    """Bind the complete original inventory or name its missing captures explicitly.

    The capture is selected only in its original native configuration. Foreign
    platforms retain explicit missing captures instead of consuming cross-host roots.
    Native roots include every original default-profile compiler root Cargo
    selects, including build-only example helpers. Roles are crate/mode:target.
    dataplane_lib and dataplane_bin are the current library and binary harnesses,
    both selected by the original filtered Cargo invocation. wasm_cipher is the
    original merkur-e2e release wasm32 library
    test: no defaults, feature wasm, original e2e-wasm SIMD/configured flags.
    Missing captures keep the caller's integration operation pending; this macro
    never supplies an ambient Cargo build, substitute root or synthetic verdict.
    """
    bound_native = _native_capture(native_roots, expected_native_roles, dataplane_lib, dataplane_bin)
    if bound_native and (not native_configuration or not native_constraints):
        fail("Protocol native compiler capture requires its original configuration and execution constraints")
    if bound_native:
        for suffix, binary in {"dataplane": dataplane_lib, "dataplane_bin": dataplane_bin}.items():
            configured_public_rust_test(
                name = name + "_" + suffix,
                binary = binary,
                args = _DATAPLANE_FILTERS + [argument for test in _DATAPLANE_SKIPS for argument in ["--skip", test]],
                target_compatible_with = native_constraints,
                exec_compatible_with = native_constraints,
                tags = ["manual"],
            )
    _protocol_bindings(
        name = name,
        native_roots = select({native_configuration: native_roots, "//conditions:default": {}}) if bound_native else {},
        expected_native_roles = expected_native_roles,
        bun_tests = [_bun_label(file) for file in [_SCAN] + _BUN_TESTS],
        dataplane = select({native_configuration: ":" + name + "_dataplane", "//conditions:default": None}) if bound_native else None,
        dataplane_bin = select({native_configuration: ":" + name + "_dataplane_bin", "//conditions:default": None}) if bound_native else None,
        wasm_cipher = wasm_cipher,
        wasm_provenance = wasm_provenance,
        client_oracle = client_oracle,
        testonly = True,
        tags = ["manual"],
    )
