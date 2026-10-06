"""Fresh native advisory acquisition and its configured immutable snapshot consumer."""

load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load(":test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

_AUDIT_LOCKS = ['Cargo.lock', 'tools/bolero/Cargo.lock', 'tools/ownership-proofs/Cargo.lock', 'tools/edge-kernel-profile/Cargo.lock', 'tools/sim/Cargo.lock']

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _impl(ctx):
    inputs = {}
    files = []
    for target, logical in ctx.attr.inputs.items():
        candidates = target[DefaultInfo].files.to_list()
        if len(candidates) != 1:
            fail("Audit source members require exactly one declared File")
        if logical in _AUDIT_LOCKS:
            parts = logical.split("/")
            original_owner = Label("//" + "/".join(parts[:-1]) + ":" + parts[-1])
            if not candidates[0].is_source or candidates[0].short_path != logical or candidates[0].owner != original_owner:
                fail("Audit locks require exact original SourceFiles: " + logical)
        if logical in inputs:
            fail("Duplicate audit source member: " + logical)
        inputs[logical] = _runfile(candidates[0])
        files.append(candidates[0])
    for required in ["package.json", "bun.lock"] + _AUDIT_LOCKS:
        if required not in inputs:
            fail("Audit requires original source member: " + required)
    if not ctx.attr.configured_inputs:
        fail("Audit must bind the complete configured dependency input closure")
    tools = {"bun": _runfile(ctx.executable.bun), "cargo_audit": _runfile(ctx.executable.cargo_audit)}
    targets = [ctx.attr.bun, ctx.attr.cargo_audit, ctx.attr.sdk] + ctx.attr.configured_inputs
    runtime = depset([ctx.executable.bun, ctx.executable.cargo_audit], transitive = [target[DefaultInfo].files for target in targets] + [target[DefaultInfo].default_runfiles.files for target in targets])
    configuration = ctx.actions.declare_file(ctx.label.name + ".configuration.json")
    ctx.actions.write(configuration, json.encode({
        "inputs": inputs,
        "tools": tools,
        "runtime": sorted([_runfile(file) for file in runtime.to_list()]),
        "sdk": ctx.attr.sdk[NativeSdkInfo].prefix_runfile,
    }) + "\n")
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    arguments = 'acquire "$@"' if ctx.attr._capture else 'check --request "$runfiles/%s" --snapshot "$runfiles/%s"' % (_runfile(ctx.file.request), _runfile(ctx.file.snapshot))
    ctx.actions.write(executable, """#!/bin/sh
set -eu
runfiles=${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}
exec "$runfiles/%s" -B -I "$runfiles/%s" %s --runfiles "$runfiles" --configuration "$runfiles/%s"
""" % (_runfile(ctx.executable._python), _runfile(ctx.file._runner), arguments, _runfile(configuration)), is_executable = True)
    runfiles = ctx.runfiles(files = files + [configuration, ctx.file._runner, ctx.executable._python], transitive_files = runtime)
    for target in targets + [ctx.attr._python]:
        runfiles = runfiles.merge(target[DefaultInfo].default_runfiles)
    if not ctx.attr._capture:
        runfiles = runfiles.merge(ctx.runfiles(files = [ctx.file.request, ctx.file.snapshot]))
    runtime_info = TestRuntimeInfo(runfiles = runfiles)
    if not ctx.attr._capture:
        runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [DefaultInfo(executable = executable, runfiles = runfiles), runtime_info]

def _attributes():
    return {
        "inputs": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "configured_inputs": attr.label_list(mandatory = True),
        "bun": attr.label(executable = True, cfg = "exec", allow_single_file = True, mandatory = True),
        "cargo_audit": attr.label(executable = True, cfg = "exec", mandatory = True),
        "sdk": attr.label(executable = True, cfg = "exec", providers = [NativeSdkInfo], mandatory = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/verification:dependency-audit.py", allow_single_file = True),
    }

_CAPTURE_ATTRIBUTES = _attributes()
_CAPTURE_ATTRIBUTES["_capture"] = attr.bool(default = True)

dependency_audit_capture = rule(implementation = _impl, executable = True, attrs = _CAPTURE_ATTRIBUTES)

_TEST_ATTRIBUTES = _attributes()
_TEST_ATTRIBUTES.update({
    "request": attr.label(allow_single_file = True, mandatory = True),
    "snapshot": attr.label(allow_single_file = True, mandatory = True),
    "_capture": attr.bool(default = False),
    "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
})

dependency_audit_test = rule(implementation = _impl, test = True, attrs = _TEST_ATTRIBUTES)
