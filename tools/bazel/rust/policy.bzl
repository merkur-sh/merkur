"""Pinned, offline policy controls consume declared native tools and snapshots."""

load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

def _control_impl(ctx):
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    tools = [ctx.executable.runner, ctx.executable.deny, ctx.executable.vet]
    inputs = [ctx.file.policy, ctx.file.snapshot]
    paths = [file.short_path for file in tools + inputs]
    ctx.actions.write(script, """#!/bin/bash
set -euo pipefail
root="${RUNFILES_DIR:-$0.runfiles}/_main"
exec "$root/%s" '%s' "$root/%s" "$root/%s" "$root/%s" "$root/%s"
""" % (paths[0], ctx.attr.control, paths[1], paths[2], paths[3], paths[4]), is_executable = True)
    runfiles = ctx.runfiles(files = tools + inputs)
    for dependency in [ctx.attr.runner, ctx.attr.deny, ctx.attr.vet]:
        runfiles = runfiles.merge(dependency[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = script, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

dependency_policy_control_test = rule(
    implementation = _control_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "runner": attr.label(default = "//tools/bazel/rust:check_policy_controls", executable = True, cfg = "exec"),
        "deny": attr.label(default = "//tools/bazel/rust/policy_tools:cargo_deny", executable = True, cfg = "exec"),
        "vet": attr.label(default = "//tools/bazel/rust/policy_tools:cargo_vet", executable = True, cfg = "exec"),
        "policy": attr.label(default = "//:deny.toml", allow_single_file = True),
        "snapshot": attr.label(default = "//tools/bazel/rust:policy_snapshots/production.json", allow_single_file = True),
        "control": attr.string(mandatory = True),
    },
)

def declare_policy_controls():
    names = ["current_policy", "license", "tls_backend", "wildcard", "git_source", "registry_source", "patches_first_party", "exact_exemption", "other_version"]
    for name in names:
        dependency_policy_control_test(name = "policy_control__" + name, control = name, tags = ["manual", "external", "no-cache", "no-remote"])
    native.test_suite(name = "dependency_policy_controls", tests = [":policy_control__" + name for name in names], tags = ["manual"])

def _graph_impl(ctx):
    mapping = []
    files = []
    for source in ctx.attr.local_sources:
        for file in source[DefaultInfo].files.to_list():
            mapping.append({"source": file.short_path, "dest": "workspace/" + file.short_path})
            files.append(file)
    for index, source in enumerate(ctx.attr.registry_sources):
        for file in source[DefaultInfo].files.to_list():
            if not file.short_path.startswith("../"):
                fail("registry source is not an acquired external archive")
            relative = "/".join(file.short_path.split("/")[2:])
            mapping.append({"source": file.short_path, "dest": "registry/" + ctx.attr.registry_names[index] + "/" + relative})
            files.append(file)
    manifest = ctx.actions.declare_file(ctx.label.name + ".sources.json")
    ctx.actions.write(manifest, json.encode(mapping))
    script = ctx.actions.declare_file(ctx.label.name + ".sh")
    tools = [ctx.executable.runner, ctx.executable.deny, ctx.executable.vet]
    paths = [file.short_path for file in tools + [ctx.file.snapshot, manifest]]
    ctx.actions.write(script, """#!/bin/bash
set -euo pipefail
root="${RUNFILES_DIR:-$0.runfiles}/_main"
export MERKUR_POLICY_RUNFILES_ROOT="$root"
exec "$root/%s" --graph '%s' "$root/%s" "$root/%s" "$root/%s" "$root/%s"
""" % (paths[0], ctx.attr.graph, paths[1], paths[2], paths[3], paths[4]), is_executable = True)
    runfiles = ctx.runfiles(files = files + tools + [ctx.file.snapshot, manifest])
    for dependency in [ctx.attr.runner, ctx.attr.deny, ctx.attr.vet]:
        runfiles = runfiles.merge(dependency[DefaultInfo].default_runfiles)
    return [TestRuntimeInfo(runfiles = runfiles), DefaultInfo(executable = script, runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)])))]

dependency_policy_graph_test = rule(
    implementation = _graph_impl,
    test = True,
    attrs = {
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
        "runner": attr.label(default = "//tools/bazel/rust:check_policy_controls", executable = True, cfg = "exec"),
        "deny": attr.label(default = "//tools/bazel/rust/policy_tools:cargo_deny", executable = True, cfg = "exec"),
        "vet": attr.label(default = "//tools/bazel/rust/policy_tools:cargo_vet", executable = True, cfg = "exec"),
        "snapshot": attr.label(mandatory = True, allow_single_file = True),
        "local_sources": attr.label_list(allow_files = True),
        "registry_sources": attr.label_list(),
        "registry_names": attr.string_list(),
        "graph": attr.string(mandatory = True),
    },
)
