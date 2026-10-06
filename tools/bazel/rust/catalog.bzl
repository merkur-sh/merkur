"""Configured, generated Rust operation catalog; qualification stays explicit."""
load(":operation_bindings.bzl", "NATIVE_OPERATION_BINDINGS", "NATIVE_OPERATION_TARGETS", "NATIVE_OPERATION_CANONICAL_TARGETS")
load("//tools/bazel/rust/simulator/aarch64-apple-darwin:operations.bzl", "SIMULATOR_OPERATION_BINDINGS", "SIMULATOR_OPERATION_TARGETS", "SIMULATOR_OPERATION_CANONICAL_TARGETS")

RustOperationCatalogInfo = provider(fields = ["file", "execution_host", "configured_targets"])

def _operation_inventory():
    bindings = dict(NATIVE_OPERATION_BINDINGS)
    targets = {host: list(labels) for host, labels in NATIVE_OPERATION_TARGETS.items()}
    canonical = {host: dict(labels) for host, labels in NATIVE_OPERATION_CANONICAL_TARGETS.items()}
    for host, simulator in SIMULATOR_OPERATION_BINDINGS.items():
        if host not in bindings:
            fail("Simulator operation has no original native catalog: " + host)
        original = bindings[host]
        existing_names = [row["name"] for row in original["operations"]]
        for row in simulator["operations"]:
            if row["name"] in existing_names:
                fail("Simulator operation duplicates an original native operation: " + row["name"])
            existing_names.append(row["name"])
        for label in SIMULATOR_OPERATION_TARGETS[host]:
            if label in canonical[host]:
                fail("Simulator check duplicates an original native target: " + label)
        merged = dict(original)
        merged["operations"] = original["operations"] + simulator["operations"]
        bindings[host] = merged
        targets[host] = targets[host] + SIMULATOR_OPERATION_TARGETS[host]
        canonical[host].update(SIMULATOR_OPERATION_CANONICAL_TARGETS[host])
    return struct(bindings = bindings, targets = targets, canonical = canonical)

_OPERATIONS = _operation_inventory()

def _catalog_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    host = toolchain.exec_triple.str
    if toolchain.version != "1.97.1" or toolchain.target_triple.str != host:
        fail("Rust operation catalog requires the pinned native host/target configuration")
    if host not in _OPERATIONS.bindings:
        fail("Rust operation catalog has no captured configuration for " + host)
    labels = _OPERATIONS.targets[host]
    if len(ctx.attr.check_targets) != len(labels):
        fail("Rust catalog configured target inventory differs from the selected native host")
    targets = {Label(label): target for label, target in zip(labels, ctx.attr.check_targets)}
    inventory = []
    for label in _OPERATIONS.targets[host]:
        target = targets[Label(label)]
        if target.label != Label(_OPERATIONS.canonical[host][label]):
            fail("Rust catalog target resolves to an unexpected compiler unit: " + label)
        files = target[DefaultInfo].files.to_list()
        if not files:
            fail("Rust catalog check has no declared outputs: " + label)
        inventory.append(struct(label = target.label, outputs = files, executable = target[DefaultInfo].files_to_run.executable))
    for category in ["operations", "crates"]:
        for row in _OPERATIONS.bindings[host][category]:
            for check in row["checks"]:
                if check["kind"] == "test" and not targets[Label(check["label"])][DefaultInfo].files_to_run.executable:
                    fail("Rust catalog test has no declared executable: " + check["label"])
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(_OPERATIONS.bindings[host]))
    return [DefaultInfo(files = depset([output])), OutputGroupInfo(descriptor = depset([output])), RustOperationCatalogInfo(file = output, execution_host = host, configured_targets = inventory)]

_rust_operation_catalog = rule(
    implementation = _catalog_impl,
    attrs = {"check_targets": attr.label_list()},
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def rust_operation_catalog(name):
    _rust_operation_catalog(
        name = name,
        testonly = True,
        check_targets = select({
            "//tools/bazel/bun:compile_darwin_arm64": _OPERATIONS.targets["aarch64-apple-darwin"],
            "//tools/bazel/bun:compile_darwin_x64": _OPERATIONS.targets["x86_64-apple-darwin"],
            "//tools/bazel/bun:compile_linux_arm64": _OPERATIONS.targets["aarch64-unknown-linux-gnu"],
            "//tools/bazel/bun:compile_linux_x64": _OPERATIONS.targets["x86_64-unknown-linux-gnu"],
            "//conditions:default": [],
        }),
    )
