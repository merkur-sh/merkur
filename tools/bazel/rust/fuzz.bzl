"""Immutable corpus replay and fresh native campaigns over instrumented Cargo units."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _fuzz_impl(ctx, replay):
    snapshot = ctx.actions.declare_file(ctx.label.name + ".corpus.json")
    members = []
    for file in ctx.files.corpus:
        # Retain repository/namespace segments for external and workspace Files.
        path = file.short_path[3:] if file.short_path.startswith("../") else file.short_path
        members.append({"source": file.short_path, "path": path})
    if replay and not members:
        fail("immutable fuzz replay requires at least one declared corpus File")
    ctx.actions.write(snapshot, json.encode({"mode": "replay" if replay else "campaign", "selector": ctx.attr.selector, "runs": 1 if replay else 10000, "max_length": ctx.attr.max_length, "corpus": members}))
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(script, """#!/bin/bash
set -euo pipefail
root="${RUNFILES_DIR:-$0.runfiles}/_main"
exec "$root/%s" "$root/%s" "$root/%s" "$root"
""" % (ctx.executable.runner.short_path, ctx.executable.harness.short_path, snapshot.short_path), is_executable = True)
    runfiles = ctx.runfiles(files = [ctx.executable.runner, ctx.executable.harness, snapshot] + ctx.files.corpus)
    runfiles = runfiles.merge(ctx.attr.runner[DefaultInfo].default_runfiles).merge(ctx.attr.harness[TestRuntimeInfo].runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = script, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

def _campaign_impl(ctx):
    return _fuzz_impl(ctx, replay = False)

def _replay_impl(ctx):
    return _fuzz_impl(ctx, replay = True)

native_fuzz_campaign_test = rule(
    implementation = _campaign_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "runner": attr.label(default = "//tools/bazel/rust:check_fuzz", executable = True, cfg = "exec"),
        "harness": attr.label(providers = [TestRuntimeInfo], executable = True, cfg = "target", mandatory = True),
        "selector": attr.string(mandatory = True),
        "max_length": attr.int(default = 4096),
        "corpus": attr.label_list(allow_files = True),
    },
)

# Corpus replay runs the same specialized, instrumented production harness.
# Cache eligibility requires qualification of the specialized tools and corpus inputs.
native_fuzz_replay_test = rule(
    implementation = _replay_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "runner": attr.label(default = "//tools/bazel/rust:check_fuzz", executable = True, cfg = "exec"),
        "harness": attr.label(providers = [TestRuntimeInfo], executable = True, cfg = "target", mandatory = True),
        "selector": attr.string(mandatory = True),
        "max_length": attr.int(default = 4096),
        "corpus": attr.label_list(allow_files = True, mandatory = True),
    },
)

def _sentinel_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    source = ctx.actions.declare_file(ctx.label.name + ".rs")
    ctx.actions.expand_template(template = ctx.file.src, output = source, substitutions = {})
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    flags = " ".join(["'%s'" % flag for flag in ctx.attr.rust_flags])
    sysroot = "/".join(toolchain.rustc.short_path.split("/")[:-2])
    ctx.actions.write(script, """#!/bin/bash
set -euo pipefail
root="${RUNFILES_DIR:-$0.runfiles}/_main"
exec "$root/%s" "$root/%s" "$root/%s" "$root/%s" %s
""" % (ctx.executable.checker.short_path, toolchain.rustc.short_path, sysroot, source.short_path, flags), is_executable = True)
    runfiles = ctx.runfiles(files = [source, ctx.executable.checker], transitive_files = toolchain.all_files)
    runfiles = runfiles.merge(ctx.attr.checker[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = script, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

instrumentation_sentinel_test = rule(
    implementation = _sentinel_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "src": attr.label(allow_single_file = [".rs"], default = "//tools/bolero:seeds.rs"),
        "checker": attr.label(default = "//tools/bazel/rust:check_fuzz_sentinel", executable = True, cfg = "exec"),
        "rust_flags": attr.string_list(mandatory = True),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

# Exact runtime selectors from tools/bolero/targets.json. Proof-only roots remain
# compiled members of the same five-root workspace without invented campaigns.
_CAMPAIGN_SELECTORS = {
    "merkur-wire": ["fuzz_wire"],
    "merkur-stun-protocol": ["fuzz_stun"],
    "merkur-codec": [],
    "merkur-client": [],
    "term-wasm": ["tests::fuzz::fuzz_display_ingress", "tests::fuzz::fuzz_display_zstd", "tests::fuzz::fuzz_display_roundtrip"],
}

def declare_fuzz_campaigns(harnesses, rust_flags):
    if sorted(harnesses.keys()) != sorted(_CAMPAIGN_SELECTORS.keys()):
        fail("native fuzz harnesses must preserve all five original owning packages")
    tests = []
    replays = []
    for name, harness in sorted(harnesses.items()):
        selectors = _CAMPAIGN_SELECTORS[name]
        for selector in selectors:
            label = "campaign__" + name + "__" + selector.replace("::", "__")
            native_fuzz_campaign_test(
                name = label,
                harness = harness,
                selector = selector,
                # Preserve sequential campaigns and the full 2GiB engine RSS cap.
                # The current native SDK is qualified only for local execution.
                size = "large",
                timeout = "long",
                tags = ["manual", "exclusive", "external", "no-cache", "no-remote"],
                target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"],
            )
            tests.append(":" + label)
            replay_label = "replay__" + name + "__" + selector.replace("::", "__")
            native_fuzz_replay_test(
                name = replay_label,
                harness = harness,
                selector = selector,
                corpus = ["//tools/bolero:corpus__" + selector.replace("::", "__")],
                size = "large",
                timeout = "long",
                tags = ["manual", "external", "no-cache", "no-remote"],
                target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"],
            )
            replays.append(":" + replay_label)
    if len(tests) != 5:
        fail("the complete current campaign inventory has exactly five targets")
    native.test_suite(name = "fuzz_campaigns", tests = tests, tags = ["manual"])
    native.test_suite(name = "fuzz_replays", tests = replays, tags = ["manual"])
    instrumentation_sentinel_test(name = "fuzz_instrumentation_sentinel", rust_flags = rust_flags, tags = ["manual"], target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"])
