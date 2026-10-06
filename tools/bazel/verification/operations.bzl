"""Configured static policy ownership; this declaration is not a verdict."""

StaticOperationBindingsInfo = provider(fields = {
    "descriptor": "Static operation checks bound to configured Target dependencies.",
    "manifest": "The complete serialized descriptor File.",
})

_OPERATIONS = {
    "check:lint": ["lint"],
    "check:latency-boundaries": ["latency_boundaries"],
    "check:span-lifetimes": ["span_lifetimes"],
    "check:span-attributes": ["span_attributes"],
    "check:dead": ["dead_files", "dead_exports"],
    "check:ratchet": ["ratchet"],
    "check:docs": ["docs"],
}

def _impl(ctx):
    operations = []
    for name, attributes in _OPERATIONS.items():
        checks = []
        for attribute in attributes:
            target = getattr(ctx.attr, attribute)
            if not target[DefaultInfo].files.to_list():
                fail("Configured static test exposes no engine outputs: " + str(target.label))
            label = str(target.label)
            if label.startswith("@@//"):
                label = label[2:]

            # A policy reads only its captured tree and Git facts, so its pass is reusable
            # for the same inputs and epoch.
            checks.append({"label": label, "kind": "test", "fresh": False})
        operations.append({"name": name, "checks": checks, "pending": []})
    descriptor = {"operations": operations, "crates": [], "browserOwners": []}
    manifest = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(manifest, json.encode(descriptor) + "\n")
    return [
        DefaultInfo(files = depset([manifest])),
        StaticOperationBindingsInfo(descriptor = descriptor, manifest = manifest),
        OutputGroupInfo(descriptor = depset([manifest])),
    ]

static_operation_bindings = rule(
    implementation = _impl,
    attrs = {
        "lint": attr.label(default = "//tools/bazel/verification:lint"),
        "latency_boundaries": attr.label(default = "//tools/bazel/verification:latency_boundaries"),
        "span_lifetimes": attr.label(default = "//tools/bazel/verification:span_lifetimes"),
        "span_attributes": attr.label(default = "//tools/bazel/verification:span_attributes"),
        "dead_files": attr.label(default = "//tools/bazel/verification:dead_files"),
        "dead_exports": attr.label(default = "//tools/bazel/verification:dead_exports"),
        "ratchet": attr.label(default = "//tools/bazel/verification:ratchet"),
        "docs": attr.label(default = "//tools/bazel/verification:docs"),
    },
)

_INTEGRATION_PENDING = {
    "check:audit": "Fresh Bun and Cargo advisory/yanked acquisition and the complete configured dependency audit action are not implemented.",
    "test:dragonfly": "The declared Dragonfly native runtime and complete authenticated service fixture lifecycle are not qualified.",
    "test:natlab": "The immutable Linux natlab rootfs/Docker CLI acquisition and privileged authenticated Linux network backend are not qualified.",
    "test:tpm-sim": "The declared TPM simulator runtime and complete original fixture lifecycle are not qualified.",
    "test:graphics:long": "The original long graphics test runtime/browser dependency closure is not qualified.",
    "test:e2e:transport:impaired:functional": "The original impaired transport test browser/runtime and network fixture closure are not qualified.",
    "test:e2e:edge-topology": "The original edge topology test browser/runtime and service fixture closure are not qualified.",
}

def _integration_impl(ctx):
    helper = ctx.attr.real_helper
    checks = []
    pending = ["Original 24-test real helper fixture, worker confinement and authenticated broker require native four-platform runtime qualification."]
    if helper:
        if not helper[DefaultInfo].files_to_run.executable:
            fail("Real helper operation requires the actual declared runtime test executable")
        label = str(helper.label)
        if label.startswith("@@//"):
            label = label[2:]
        checks.append({"label": label, "kind": "test", "fresh": True})
    else:
        pending.append("Exact native real-helper compiler/runtime context is missing for this platform; only the matching Darwin ARM capture is bound.")
    protocol = ctx.attr.protocol[StaticOperationBindingsInfo].descriptor
    if [operation["name"] for operation in protocol["operations"]] != ["check:protocol"] or protocol["crates"] or protocol["browserOwners"]:
        fail("Integration protocol owner must expose exactly the original protocol operation")
    descriptor = {
        "operations": protocol["operations"] + [{"name": name, "checks": [], "pending": [reason]} for name, reason in _INTEGRATION_PENDING.items()] + [{
            "name": "test:real-helper",
            "checks": checks,
            "pending": pending,
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

integration_operation_bindings = rule(
    implementation = _integration_impl,
    attrs = {"real_helper": attr.label(), "protocol": attr.label(mandatory = True, providers = [StaticOperationBindingsInfo])},
)

# Original Cargo/Kani applications; a configured declaration is not a verdict.
_BOUNDED_PROOF_ATTRIBUTES = [
    "proof_proto_frame",
    "proof_data_handshake",
    "proof_frame_header",
    "proof_input_mapping",
    "proof_input_serial_order",
    "proof_rebind_keeper_chain",
]

def _bounded_proof_impl(ctx):
    checks = []
    for name in _BOUNDED_PROOF_ATTRIBUTES:
        target = getattr(ctx.attr, name)
        if target:
            if target.label.name != "kani__" + name:
                fail("Bounded proof operation selected another application: " + name)
            if not target[DefaultInfo].files_to_run.executable:
                fail("Bounded proof operation requires the original engine test executable: " + name)
            label = str(target.label)
            if label.startswith("@@//"):
                label = label[2:]
            checks.append({"label": label, "kind": "test", "fresh": True})
    if checks and len(checks) != len(_BOUNDED_PROOF_ATTRIBUTES):
        fail("Bounded proof operation must bind every original application together")
    pending = ["Original bounded Kani applications require native solver/runtime qualification on this platform."]
    if not checks:
        pending.append("The exact native bounded proof execution context is not bound for this platform.")
    descriptor = {
        "operations": [{"name": name, "checks": checks, "pending": pending} for name in ["check:proofs", "test:fuzz:kani"]],
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

bounded_proof_operation_bindings = rule(
    implementation = _bounded_proof_impl,
    attrs = {name: attr.label() for name in _BOUNDED_PROOF_ATTRIBUTES},
)

# Emitting test wrappers are explicit: the original rustdoc alias has no runner log.
def _simulator_label(target):
    if not target[DefaultInfo].files_to_run.executable:
        fail("Simulator operation requires the actual configured test executable: " + str(target.label))
    label = str(target.label)
    return label[2:] if label.startswith("@@//") else label

def _simulator_impl(ctx):
    replay = [_simulator_label(target) for target in ctx.attr.replay]
    emitters = [_simulator_label(target) for target in ctx.attr.replay_emitters]
    if len(replay) != len({label: True for label in replay}) or len(emitters) != len({label: True for label in emitters}):
        fail("Simulator operation repeats a configured replay test or emitter")
    if any([label not in replay for label in emitters]):
        fail("Simulator diagnostic emitters must be a subset of the original replay tests")
    sweep = [_simulator_label(ctx.attr.sweep)] if ctx.attr.sweep else []
    replay_pending = ["The original simulator release/library/harness context and native entropy-hook execution are not captured and qualified."]
    sweep_pending = ["The original simulator release context, native entropy-hook execution and fresh random-seed sweep are not captured and qualified."]
    if not replay:
        replay_pending.append("The exact configured simulator replay/library/rustdoc test roots are not bound for this platform.")
    if not sweep:
        sweep_pending.append("The exact configured simulator random-seed sweep wrapper is not bound for this platform.")
    # The generated Rust operation catalog owns the captured replay roots. This owner
    # claims replay only when its own roots are bound; two owners refuse the catalog.
    descriptor = {
        "operations": ([{
            "name": "test:sim",
            "checks": [{"label": label, "kind": "test", "fresh": True} for label in replay],
            "simulationOutputs": [{"label": label, "mode": "replay"} for label in emitters],
            "pending": replay_pending,
        }] if replay else []) + [{
            "name": "test:sim:sweep",
            "checks": [{"label": label, "kind": "test", "fresh": True} for label in sweep],
            "simulationOutputs": [{"label": label, "mode": "sweep"} for label in sweep],
            "pending": sweep_pending,
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

simulator_operation_bindings = rule(
    implementation = _simulator_impl,
    attrs = {
        "replay": attr.label_list(),
        "replay_emitters": attr.label_list(),
        "sweep": attr.label(),
    },
)
