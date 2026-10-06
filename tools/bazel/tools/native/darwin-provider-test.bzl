"""Configured CcToolchain boundary controls; never execute structural tool fixtures."""
load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")

def _snapshot(ctx, compiler):
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = compiler)
    compile_variables = cc_common.create_compile_variables(cc_toolchain = compiler, feature_configuration = features, source_file = "unit.cc", output_file = "unit.o")
    link_variables = cc_common.create_link_variables(cc_toolchain = compiler, feature_configuration = features, output_file = "unit", is_using_linker = True)
    archive_variables = cc_common.create_link_variables(cc_toolchain = compiler, feature_configuration = features, output_file = "unit.a", is_using_linker = False)
    return {
        "sysroot": compiler.sysroot,
        "all_files": sorted([file.path for file in compiler.all_files.to_list()]),
        "tools": {action: cc_common.get_tool_for_action(feature_configuration = features, action_name = action) for action in [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile, ACTION_NAMES.cpp_link_executable, ACTION_NAMES.cpp_link_static_library]},
        "compile_flags": cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile, variables = compile_variables),
        "link_flags": cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables),
        "archive_flags": cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_static_library, variables = archive_variables),
        "environment": cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile, variables = compile_variables),
    }

def _positive_impl(ctx):
    env = analysistest.begin(ctx)
    result = _snapshot(ctx, analysistest.target_under_test(env)[cc_common.CcToolchainInfo])
    for action, file in [(ACTION_NAMES.c_compile, ctx.file.compiler), (ACTION_NAMES.cpp_compile, ctx.file.cxx), (ACTION_NAMES.cpp_link_executable, ctx.file.linker_driver), (ACTION_NAMES.cpp_link_static_library, ctx.file.archiver)]:
        asserts.equals(env, file.path, result["tools"][action], "Configured Darwin action selects its exact declared tool")
        asserts.true(env, result["tools"][action] in result["all_files"], "Configured Darwin tool belongs to the original File closure")
    asserts.true(env, "--target=" + ctx.attr.target in result["compile_flags"])
    asserts.true(env, "--target=" + ctx.attr.target in result["link_flags"])
    asserts.true(env, "-nostdinc" in result["compile_flags"] and "-nostdinc++" in result["compile_flags"])
    asserts.true(env, "--ld-path=" + ctx.file.linker.path in result["link_flags"])
    asserts.equals(env, ["rcs", "unit.a"], result["archive_flags"])
    asserts.equals(env, result["sysroot"], result["environment"]["SDKROOT"])
    asserts.equals(env, "1", result["environment"]["ZERO_AR_DATE"])
    return analysistest.end(env)

darwin_provider_test = analysistest.make(_positive_impl, attrs = dict({key: attr.label(allow_single_file = True, mandatory = True) for key in ["compiler", "cxx", "linker_driver", "archiver", "linker"]}, target = attr.string(mandatory = True)), fragments = ["cpp"])

def _missing_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, "Darwin compiler tool is absent from its complete original File closure")
    return analysistest.end(env)

darwin_missing_closure_test = analysistest.make(_missing_impl, expect_failure = True, fragments = ["cpp"])

def _snapshot_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(output, json.encode(_snapshot(ctx, ctx.attr.sdk[cc_common.CcToolchainInfo])))
    return [DefaultInfo(files = depset([output]))]

darwin_provider_snapshot = rule(implementation = _snapshot_impl, attrs = {"sdk": attr.label(providers = [cc_common.CcToolchainInfo], mandatory = True)}, fragments = ["cpp"])
