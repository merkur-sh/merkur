"""Swift selections from the same declared original Apple compiler SDK Files."""
load(":darwin-artifacts.bzl", "DarwinCompilerSdkInfo")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")

_TOOLCHAIN = "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr"
_TOOLS = {"swiftc": "swiftc", "frontend": "swift-frontend", "plugin_server": "swift-plugin-server", "driver": "swift-driver"}
_RESOURCES = ["lib/swift/macosx", "lib/swift/host", "lib/swift/clang", "lib/swift/apinotes", "lib/swift/_InternalSwiftScan", "lib/swift/swiftToCxx", "share/swift"]

DarwinSwiftSdkInfo = provider(fields = ["swiftc", "frontend", "plugin_server", "driver", "sysroot", "toolchain", "resource_dir", "execution_cpu", "files"])

def _swift_sdk_values(ctx, sdk):
    tools = {}
    files = {file: True for file in sdk.files.to_list()}
    for role, name in _TOOLS.items():
        member = _TOOLCHAIN + "/bin/" + name
        if member not in sdk.members:
            fail("Declared original Apple SDK lacks Swift tool File: " + member)
        tools[role] = sdk.members[member]
        if tools[role] not in files:
            fail("Declared original Swift tool is outside its complete SDK File closure: " + member)
    for directory in _RESOURCES + [sdk.sysroot + "/usr/lib/swift"]:
        prefix = directory + "/" if directory.startswith(sdk.sysroot + "/") else _TOOLCHAIN + "/" + directory + "/"
        selected = [file for name, file in sdk.members.items() if name.startswith(prefix)]
        # Original directory aliases are declared unresolved symlink Files. Their
        # exact archive pins and extraction preserve the target File closure.
        directory_member = prefix.removesuffix("/")
        if directory_member in sdk.members:
            selected.append(sdk.members[directory_member])
        if not selected:
            fail("Declared original Apple SDK lacks Swift resource Files: " + prefix)
        if any([file not in files for file in selected]):
            fail("Declared original Swift resources are outside their complete SDK File closure: " + prefix)
    variables = {"MERKUR_SWIFTC": tools["swiftc"].path, "MERKUR_SWIFT_SDK": sdk.root + "/" + sdk.sysroot,
                 "MERKUR_SWIFT_TOOLCHAIN": sdk.root + "/" + _TOOLCHAIN, "SWIFT_DRIVER_SWIFT_FRONTEND_EXEC": tools["frontend"].path}
    return [platform_common.TemplateVariableInfo(variables), DefaultInfo(files = sdk.files, runfiles = ctx.runfiles(transitive_files = sdk.files)),
            DarwinSwiftSdkInfo(swiftc = tools["swiftc"], frontend = tools["frontend"], plugin_server = tools["plugin_server"], driver = tools["driver"],
                               sysroot = sdk.root + "/" + sdk.sysroot, toolchain = sdk.root + "/" + _TOOLCHAIN,
                               resource_dir = sdk.root + "/" + _TOOLCHAIN + "/lib/swift", execution_cpu = sdk.execution_cpu, files = sdk.files)]

def _swift_impl(ctx):
    return _swift_sdk_values(ctx, ctx.attr.sdk[DarwinCompilerSdkInfo])

darwin_swift_sdk = rule(implementation = _swift_impl, attrs = {"sdk": attr.label(providers = [DarwinCompilerSdkInfo], mandatory = True)})

def darwin_swift_build_environment():
    """Pinned cargo_build_script expands SDK TemplateVariableInfo via toolchains."""
    return {name: "$${pwd}/$(" + name + ")" for name in ["MERKUR_SWIFTC", "MERKUR_SWIFT_SDK", "MERKUR_SWIFT_TOOLCHAIN", "SWIFT_DRIVER_SWIFT_FRONTEND_EXEC"]}

def _swiftc_impl(ctx):
    info = ctx.attr.sdk[DarwinSwiftSdkInfo]
    return [DefaultInfo(files = depset([info.swiftc]), runfiles = ctx.runfiles(transitive_files = info.files))]

darwin_swift_compiler = rule(implementation = _swiftc_impl, attrs = {"sdk": attr.label(providers = [DarwinSwiftSdkInfo], mandatory = True)})

_SDK = "Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"

def _configured_swift_values(ctx, cc):
    suffix = "/" + _SDK
    if not cc.sysroot or not cc.sysroot.endswith(suffix):
        fail("Identity build script requires its configured original Apple SDK sysroot")
    root = cc.sysroot.removesuffix(suffix)
    if root.startswith("/") or any([part in ["", ".", ".."] for part in root.split("/")]) or not any([root.startswith(prefix) for prefix in ["external/", "bazel-out/"]]):
        fail("Identity build script requires a declared execution-root-relative Apple SDK")
    if cc.cpu not in ["aarch64", "x86_64"]:
        fail("Identity build script requires its configured native Apple SDK CPU")
    files = cc.all_files
    members = {file.path.removeprefix(root + "/"): file for file in files.to_list() if file.path.startswith(root + "/")}
    return _swift_sdk_values(ctx, struct(root = root, sysroot = _SDK, members = members, files = files, execution_cpu = cc.cpu))

def _build_script_sdk_impl(ctx):
    cc = find_cc_toolchain(ctx)
    selected = _configured_swift_values(ctx, cc)
    cc_files = {file.path: file for file in cc.all_files.to_list()}
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    archiver = cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_static_library)
    if archiver not in cc_files:
        fail("Identity build script requires its configured Cc archiver File")
    variables = dict(selected[0].variables, MERKUR_SWIFT_AR = archiver)
    return [platform_common.TemplateVariableInfo(variables), selected[1], selected[2]]

darwin_swift_build_script_sdk = rule(
    implementation = _build_script_sdk_impl,
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)

def darwin_identity_build_script_kwargs(pkg_name, platform, swift_sdk):
    """Only the original native Apple identity build script consumes Swift."""
    if pkg_name != "merkur-identity-seal" or platform not in ["aarch64-apple-darwin", "x86_64-apple-darwin"]:
        return {"data": [], "toolchains": [], "environment": {}}
    if not swift_sdk:
        fail("Native Apple identity build script requires its declared configured Swift SDK")
    environment = dict(darwin_swift_build_environment(), AR = "$(MERKUR_SWIFT_AR)")
    return {"data": [swift_sdk], "toolchains": [swift_sdk], "environment": environment}
