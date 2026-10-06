"""Analysis-only typed Swift boundary controls; never execute structural fixtures."""
load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load(":darwin-artifacts.bzl", "DarwinCompilerSdkInfo")
load(":darwin-swift.bzl", "DarwinSwiftSdkInfo", "darwin_swift_build_environment")

_ROOT = "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr"

def _fixture_impl(ctx):
    members = {}
    for name in ["swiftc", "swift-frontend", "swift-plugin-server", "swift-driver"]:
        logical = _ROOT + "/bin/" + name
        if logical != ctx.attr.omit:
            members[logical] = ctx.file.source
    for directory in ["lib/swift/macosx", "lib/swift/host", "lib/swift/clang", "lib/swift/apinotes", "lib/swift/_InternalSwiftScan", "lib/swift/swiftToCxx", "share/swift"]:
        if directory != ctx.attr.omit:
            if directory == "lib/swift/clang":
                members[_ROOT + "/" + directory] = ctx.file.source
            else:
                members[_ROOT + "/" + directory + "/fixture"] = ctx.file.source
    members["SDK/usr/lib/swift/fixture"] = ctx.file.source
    files = depset([] if ctx.attr.missing_closure else [ctx.file.source])
    return [DefaultInfo(files = files), DarwinCompilerSdkInfo(root = "structural/sdk", files = files, members = members,
             sysroot = "SDK", resource_dir = _ROOT + "/lib/clang/21", cxx_headers = "SDK/usr/include/c++/v1", execution_cpu = "aarch64", tools = {})]

darwin_swift_fixture = rule(implementation = _fixture_impl, attrs = {"source": attr.label(allow_single_file = True, mandatory = True), "omit": attr.string(), "missing_closure": attr.bool()})

def _positive_impl(ctx):
    env = analysistest.begin(ctx)
    info = analysistest.target_under_test(env)[DarwinSwiftSdkInfo]
    values = darwin_swift_build_environment()
    variables = analysistest.target_under_test(env)[platform_common.TemplateVariableInfo].variables
    asserts.equals(env, "aarch64", info.execution_cpu)
    asserts.equals(env, "structural/sdk/SDK", info.sysroot)
    asserts.equals(env, "structural/sdk/" + _ROOT, info.toolchain)
    for file in [info.swiftc, info.frontend, info.plugin_server, info.driver]:
        asserts.true(env, file in info.files.to_list())
    asserts.equals(env, info.swiftc.path, variables["MERKUR_SWIFTC"])
    asserts.equals(env, "$${pwd}/$(MERKUR_SWIFTC)", values["MERKUR_SWIFTC"])
    asserts.equals(env, info.sysroot, variables["MERKUR_SWIFT_SDK"])
    asserts.equals(env, "$${pwd}/$(MERKUR_SWIFT_SDK)", values["MERKUR_SWIFT_SDK"])
    asserts.equals(env, info.toolchain, variables["MERKUR_SWIFT_TOOLCHAIN"])
    asserts.equals(env, "$${pwd}/$(MERKUR_SWIFT_TOOLCHAIN)", values["MERKUR_SWIFT_TOOLCHAIN"])
    asserts.equals(env, info.frontend.path, variables["SWIFT_DRIVER_SWIFT_FRONTEND_EXEC"])
    asserts.equals(env, "$${pwd}/$(SWIFT_DRIVER_SWIFT_FRONTEND_EXEC)", values["SWIFT_DRIVER_SWIFT_FRONTEND_EXEC"])
    return analysistest.end(env)

darwin_swift_provider_test = analysistest.make(_positive_impl)

def _missing_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, ctx.attr.expected)
    return analysistest.end(env)

darwin_swift_missing_test = analysistest.make(_missing_impl, expect_failure = True, attrs = {"expected": attr.string(mandatory = True)})
