"""Configured identity Swift binding controls; structural cases never execute tools."""
load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load(":darwin-swift.bzl", "DarwinSwiftSdkInfo", "darwin_identity_build_script_kwargs")

_BindingInfo = provider(fields = ["values"])

def _probe_impl(ctx):
    return [_BindingInfo(values = darwin_identity_build_script_kwargs(ctx.attr.pkg_name, ctx.attr.platform, ctx.attr.swift_sdk))]

identity_swift_binding_probe = rule(implementation = _probe_impl, attrs = {"pkg_name": attr.string(mandatory = True), "platform": attr.string(mandatory = True), "swift_sdk": attr.string()})

def _binding_impl(ctx):
    env = analysistest.begin(ctx)
    values = analysistest.target_under_test(env)[_BindingInfo].values
    if ctx.attr.expected_sdk:
        asserts.equals(env, [ctx.attr.expected_sdk], values["data"])
        asserts.equals(env, [ctx.attr.expected_sdk], values["toolchains"])
        asserts.equals(env, "$(MERKUR_SWIFT_AR)", values["environment"]["AR"])
        asserts.equals(env, "$${pwd}/$(MERKUR_SWIFTC)", values["environment"]["MERKUR_SWIFTC"])
        asserts.equals(env, "$${pwd}/$(MERKUR_SWIFT_SDK)", values["environment"]["MERKUR_SWIFT_SDK"])
        asserts.equals(env, "$${pwd}/$(MERKUR_SWIFT_TOOLCHAIN)", values["environment"]["MERKUR_SWIFT_TOOLCHAIN"])
    else:
        asserts.equals(env, {"data": [], "toolchains": [], "environment": {}}, values)
    return analysistest.end(env)

identity_swift_binding_test = analysistest.make(_binding_impl, attrs = {"expected_sdk": attr.string()})

def _sdk_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    swift = target[DarwinSwiftSdkInfo]
    variables = target[platform_common.TemplateVariableInfo].variables
    files = target[DefaultInfo].files.to_list()
    asserts.equals(env, ctx.file.archiver.path, variables["MERKUR_SWIFT_AR"])
    asserts.true(env, ctx.file.archiver in files)
    asserts.equals(env, swift.swiftc.path, variables["MERKUR_SWIFTC"])
    asserts.equals(env, swift.sysroot, variables["MERKUR_SWIFT_SDK"])
    asserts.equals(env, swift.toolchain, variables["MERKUR_SWIFT_TOOLCHAIN"])
    asserts.true(env, all([file in files for file in swift.files.to_list()]))
    return analysistest.end(env)

identity_swift_sdk_test = analysistest.make(_sdk_impl, attrs = {"archiver": attr.label(allow_single_file = True, mandatory = True)})

def _failure_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, ctx.attr.expected)
    return analysistest.end(env)

identity_swift_binding_failure_test = analysistest.make(_failure_impl, expect_failure = True, attrs = {"expected": attr.string(mandatory = True)})


def _cc_files_impl(ctx):
    files = ctx.attr.sdk[DefaultInfo].files.to_list()
    selected = [file for file in files if not file.path.endswith(ctx.attr.omit_suffix)]
    if len(selected) != len(files) - 1:
        fail("Negative Cc fixture must omit exactly one original File")
    return [DefaultInfo(files = depset(selected))]

identity_swift_cc_files = rule(implementation = _cc_files_impl, attrs = {"sdk": attr.label(mandatory = True), "omit_suffix": attr.string(mandatory = True)})
