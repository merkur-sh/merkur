"""Original identity build-script controls with the declared public Swift SDK."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")
load(":darwin-swift.bzl", "DarwinSwiftSdkInfo")

_TOOLCHAIN = "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr"

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _flags(flags, output):
    result = []
    skip = False
    for flag in flags:
        if skip:
            skip = False
        elif flag == "-o":
            skip = True
        elif flag not in [output, "__MERKUR_SOURCE__", "-c"]:
            result.append(flag)
    return result

def _impl(ctx):
    swift = ctx.attr.swift_sdk[DarwinSwiftSdkInfo]
    cc = find_cc_toolchain(ctx)
    if cc.sysroot != swift.sysroot:
        fail("Swift identity controls require the same original Cc and Swift SDK")
    cc_files = {file.path: file for file in cc.all_files.to_list()}
    if any([file.path not in cc_files for file in swift.files.to_list()]):
        fail("Swift identity controls require the complete Swift Files in the Cc SDK")
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__MERKUR_SOURCE__", output_file = "__MERKUR_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__MERKUR_EXECUTABLE__", is_using_linker = True)
    tools = {}
    for name, action in [("compiler", ACTION_NAMES.c_compile), ("archiver", ACTION_NAMES.cpp_link_static_library)]:
        path = cc_common.get_tool_for_action(feature_configuration = features, action_name = action)
        if path not in cc_files:
            fail("Swift identity controls require each configured Cc tool File")
        tools[name] = _runfile(cc_files[path])
    sdk_exec_root = swift.toolchain.removesuffix("/" + _TOOLCHAIN)
    sdk_runfile_root = _runfile(swift.swiftc).removesuffix("/" + _TOOLCHAIN + "/bin/swiftc")
    configuration = ctx.actions.declare_file(ctx.label.name + ".configuration.json")
    ctx.actions.write(configuration, json.encode({
        "build_script": _runfile(ctx.executable.build_script),
        "source": _runfile(ctx.file.source),
        "fixture": _runfile(ctx.file.fixture),
        "sdk_exec_root": sdk_exec_root,
        "sdk_runfile_root": sdk_runfile_root,
        "swiftc": _runfile(swift.swiftc),
        "frontend": _runfile(swift.frontend),
        "sysroot": swift.sysroot.removeprefix(sdk_exec_root + "/"),
        "toolchain": swift.toolchain.removeprefix(sdk_exec_root + "/"),
        "execution_cpu": swift.execution_cpu,
        "tools": tools,
        "compile_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables), "__MERKUR_OBJECT__"),
        "link_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables), "__MERKUR_EXECUTABLE__"),
    }) + "\n")
    targets = [ctx.attr.build_script, ctx.attr._python, ctx.attr.swift_sdk]
    runtime = depset([ctx.executable.build_script, ctx.executable._python], transitive = [cc.all_files, swift.files] + [target[DefaultInfo].default_runfiles.files for target in targets])
    executable = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(executable, """#!/bin/sh
set -eu
runfiles=${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}
exec "$runfiles/%s" -B -I "$runfiles/%s" "$runfiles/%s" "$runfiles"
""" % (_runfile(ctx.executable._python), _runfile(ctx.file.runner), _runfile(configuration)), is_executable = True)
    runfiles = ctx.runfiles(files = [configuration, ctx.file.runner, ctx.file.fixture, ctx.file.source], transitive_files = runtime)
    for target in targets:
        runfiles = runfiles.merge(target[DefaultInfo].default_runfiles)
    original_runtime = runfiles
    runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    return [DefaultInfo(executable = executable, runfiles = runfiles), TestRuntimeInfo(runfiles = original_runtime)]

darwin_swift_identity_control_test = rule(
    implementation = _impl,
    test = True,
    attrs = {
        "build_script": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "swift_sdk": attr.label(mandatory = True, providers = [DarwinSwiftSdkInfo]),
        "source": attr.label(mandatory = True, allow_single_file = [".swift"]),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "runner": attr.label(default = "//tools/bazel/tools/native:darwin-swift-identity-control.py", allow_single_file = True),
        "fixture": attr.label(default = "//tools/bazel/tools/native:darwin-swift-identity-control.fixture.swift", allow_single_file = True),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)
