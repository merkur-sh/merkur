"""Original native SDK File identity controls; no runtime qualification claim."""

load("@bazel_skylib//lib:unittest.bzl", "TOOLCHAIN_TYPE", "analysistest", "asserts", "unittest")
load(":providers.bzl", "NativeSdkInfo")
load(":sdk.bzl", "sdk_executable")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "test_nonce_file")

def _positive_impl(ctx):
    env = unittest.begin(ctx)
    original = ctx.file.binary
    actual = ctx.attr.subject[NativeSdkInfo]
    runfile = original.short_path[3:] if original.short_path.startswith("../") else "_main/" + original.short_path
    asserts.equals(env, original, actual.binary)
    asserts.equals(env, runfile.rsplit("/bin/", 1)[0], actual.prefix_runfile)
    asserts.true(env, original in ctx.attr.subject[DefaultInfo].default_runfiles.files.to_list())
    original = unittest.end(env)[0]
    # Skylib's raw DefaultInfo is not finalized yet. Select its already-written
    # runner from the same configured toolchain, retaining both original runfiles sets.
    runner = ctx.actions.declare_file(ctx.label.name + ctx.toolchains[TOOLCHAIN_TYPE].unittest_toolchain_info.file_ext)
    runner_files = ctx.runfiles(files = [runner])
    runtime = (original.default_runfiles or ctx.runfiles()).merge(runner_files)
    data = (original.data_runfiles or ctx.runfiles()).merge(runner_files)
    return [DefaultInfo(
        files = original.files,
        executable = runner,
        default_runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)])),
        data_runfiles = data,
    )]

_positive_test = unittest.make(_positive_impl, attrs = {
    "binary": attr.label(allow_single_file = True, mandatory = True),
    "subject": attr.label(providers = [NativeSdkInfo], mandatory = True),
    "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
})

def _failure_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, "SDK executable must be the exact original File in its declared SDK closure")
    return analysistest.end(env) + [
        DefaultInfo(runfiles = ctx.runfiles(files = [test_nonce_file(ctx)])),
    ]

_failure_test = analysistest.make(_failure_impl, expect_failure = True, attrs = {"_revocation_epochs": TEST_EPOCH_ATTRIBUTE})

def _foreign_impl(ctx):
    alias = ctx.actions.declare_file(ctx.label.name + "/bin/" + ctx.file.binary.basename)
    ctx.actions.symlink(output = alias, target_file = ctx.file.binary, is_executable = True)
    return [DefaultInfo(files = depset([alias]))]

_foreign_file = rule(implementation = _foreign_impl, attrs = {
    "binary": attr.label(allow_single_file = True, mandatory = True),
})

def _runfiles_impl(ctx):
    original = ctx.attr.sdk[DefaultInfo]
    return [DefaultInfo(files = depset(), runfiles = ctx.runfiles(transitive_files = original.files).merge(original.default_runfiles))]

_runfiles_only = rule(implementation = _runfiles_impl, attrs = {"sdk": attr.label(mandatory = True)})

def native_sdk_member_controls(name, binary, sdk):
    """Caller supplies genuine original binary and complete original SDK labels."""
    sdk_executable(name = name + "_original", binary = binary, sdk = sdk, testonly = True, tags = ["manual"])
    _positive_test(name = name + "_original_test", binary = binary, subject = ":" + name + "_original", tags = ["manual"])
    _runfiles_only(name = name + "_runfiles", sdk = sdk, testonly = True, tags = ["manual"])
    sdk_executable(name = name + "_runfiles_original", binary = binary, sdk = ":" + name + "_runfiles", testonly = True, tags = ["manual"])
    _positive_test(name = name + "_runfiles_test", binary = binary, subject = ":" + name + "_runfiles_original", tags = ["manual"])
    _foreign_file(name = name + "_foreign_file", binary = binary, testonly = True, tags = ["manual"])
    sdk_executable(name = name + "_foreign", binary = ":" + name + "_foreign_file", sdk = sdk, testonly = True, tags = ["manual"])
    _failure_test(name = name + "_foreign_test", target_under_test = ":" + name + "_foreign", tags = ["manual"])
    native.filegroup(name = name + "_empty", srcs = [], testonly = True, tags = ["manual"])
    sdk_executable(name = name + "_missing", binary = binary, sdk = ":" + name + "_empty", testonly = True, tags = ["manual"])
    _failure_test(name = name + "_missing_test", target_under_test = ":" + name + "_missing", tags = ["manual"])
    native.test_suite(name = name, tests = [":" + name + suffix for suffix in ["_original_test", "_runfiles_test", "_foreign_test", "_missing_test"]], tags = ["manual"])
