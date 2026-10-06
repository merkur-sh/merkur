"""Pair fresh audit acquisition with its nonce-bound declared snapshot consumer."""

load("//tools/bazel/tools:sdk_git.bzl", "declared_git_sdk")

load(":dependency-audit.bzl", "dependency_audit_capture", "dependency_audit_test")

def declared_dependency_audit(name, inputs, configured_inputs, bun, git_source, git_bootstrap_sdk, git_make, request = "@verification_audit//:request", snapshot = "@verification_audit//:snapshot", tags = []):
    """Use the genuine configured cargo-audit build; acquisition runs via bazel run."""
    git_sdk = name + "_git_sdk"
    declared_git_sdk(
        name = git_sdk,
        source = git_source,
        sdk = git_bootstrap_sdk,
        make = git_make,
        tags = tags,
    )
    arguments = {
        "inputs": inputs,
        "configured_inputs": configured_inputs,
        "bun": bun,
        "sdk": ":" + git_sdk,
        "cargo_audit": "//tools/bazel/rust/audit_tool:cargo_audit",
    }
    dependency_audit_capture(name = name + "_capture", tags = tags, **arguments)
    dependency_audit_test(name = name, request = request, snapshot = snapshot,
                          tags = tags, **arguments)
