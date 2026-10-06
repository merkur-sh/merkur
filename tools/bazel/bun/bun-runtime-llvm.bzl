"""Bind the original LLVM SDK to the same native Bun source-build action."""

load("//tools/bazel/tools/llvm_sdk:rules.bzl", "LlvmSdkInfo")

def bun_runtime_llvm_sdk_attr():
    """The native Bun producer requires the actual SDK action's typed output."""
    return attr.label(mandatory = True, cfg = "exec", providers = [LlvmSdkInfo])

def bun_runtime_llvm_inputs(ctx):
    """Return original File custody and the upstream Bun LLVM root variable.

    The consumer adds inputs to its same compile action, and passes the exact
    tool Files to its original configure step for identity revalidation.
    Runtime source selection and native execution qualification remain duties
    of that compile action; this binding creates no selected attribution scope.
    """
    sdk = ctx.attr.llvm_sdk[LlvmSdkInfo]
    return struct(
        environment = {"BUN_TOOLCHAIN_LLVM": sdk.root.path},
        tools = sdk.tools,
        manifest = sdk.manifest,
        source_archive = sdk.source_archive,
        inputs = depset(
            [sdk.root, sdk.manifest, sdk.source_archive] + sdk.tools.values(),
            transitive = [sdk.inputs],
        ),
    )
