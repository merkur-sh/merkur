"""Compile original Binaryen with existing declared compiler and native SDKs."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")

_PLATFORMS = {
    "darwin_arm64": ["@platforms//os:macos", "@platforms//cpu:aarch64"],
    "darwin_x64": ["@platforms//os:macos", "@platforms//cpu:x86_64"],
    "linux_arm64": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
    "linux_x64": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
}

def _sdk(target):
    files = target[DefaultInfo].files.to_list()
    roots = [file for file in files if file.is_directory]
    if len(roots) != 1 or target[NativeSdkInfo].binary not in files:
        fail("Binaryen requires an actual source-built native SDK root and executable")
    return roots[0]

def _flags(flags, output):
    result = []
    skip = False
    for flag in flags:
        if skip:
            skip = False
        elif flag == "-o":
            skip = True
        elif flag not in [output, "__BINARYEN_SOURCE__", "-c"]:
            result.append(flag)
    return result

def _impl(ctx):
    cc = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = cc, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = cc, source_file = "__BINARYEN_SOURCE__", output_file = "__BINARYEN_OBJECT__")
    link_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__BINARYEN_EXECUTABLE__", is_using_linker = True)
    shared_variables = cc_common.create_link_variables(feature_configuration = features, cc_toolchain = cc, output_file = "__BINARYEN_LIBRARY__", is_using_linker = True, is_linking_dynamic_library = True)
    tools = {name: cc_common.get_tool_for_action(feature_configuration = features, action_name = action) for name, action in {"cc": ACTION_NAMES.c_compile, "cxx": ACTION_NAMES.cpp_compile, "ar": ACTION_NAMES.cpp_link_static_library}.items()}
    # Original CMake links C++ targets through CMAKE_CXX_COMPILER. Require that
    # driver to be the configured link driver, rather than guessing an adapter.
    for action in [ACTION_NAMES.cpp_link_executable, ACTION_NAMES.cpp_link_dynamic_library]:
        if cc_common.get_tool_for_action(feature_configuration = features, action_name = action) != tools["cxx"]:
            fail("Binaryen requires its configured C++ compile and link driver to be the same declared File")
    tools["ranlib"] = ctx.file.ranlib.path
    compiler_files = cc.all_files.to_list()
    if any([tool not in [file.path for file in compiler_files] for tool in tools.values()]):
        fail("Binaryen compiler, archiver and ranlib must be actual CcToolchain Files")
    environment = {}
    for action, value in [(ACTION_NAMES.c_compile, variables), (ACTION_NAMES.cpp_compile, variables), (ACTION_NAMES.cpp_link_executable, link_variables), (ACTION_NAMES.cpp_link_dynamic_library, shared_variables)]:
        environment.update(cc_common.get_environment_variables(feature_configuration = features, action_name = action, variables = value))
    sdk_targets = {"shell": ctx.attr.sdk, "make": ctx.attr.make, "cmake": ctx.attr.cmake}
    sdk_roots = {name: _sdk(target) for name, target in sdk_targets.items()}
    tools.update({name: target[NativeSdkInfo].binary.path for name, target in sdk_targets.items()})
    tools["make_driver"] = ctx.executable.make_driver.path
    unicode_inputs = []
    for target, role in ctx.attr.unicode_inputs.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or not files[0].is_source:
            fail("Unicode input must be one original publisher source File")
        unicode_inputs.append({"role": role, "path": files[0].path, "label": str(files[0].owner)})
    if sorted([entry["role"] for entry in unicode_inputs]) != sorted(["generator", "data", "readme", "original_cpp", "terms", "license"]):
        fail("Binaryen requires all original Unicode generator/data/terms/license inputs")
    unicode_files = [file for target in ctx.attr.unicode_inputs.keys() for file in target[DefaultInfo].files.to_list()]
    selection_helpers = {"linked": ctx.file._linked, "sections": ctx.file._sections, "mapper": ctx.file._mapper, "licenses": ctx.file._licenses}
    if OutputGroupInfo not in ctx.attr.cmake:
        fail("Binaryen CMake generator requires its actual source producer grouped Files")
    cmake_groups = ctx.attr.cmake[OutputGroupInfo]
    cmake_configurations = cmake_groups.compiler_configuration.to_list()
    cmake_notices = cmake_groups.original_notices.to_list()
    if (len(cmake_configurations) != 1 or len(cmake_notices) != 1 or
        cmake_configurations[0].is_directory or not cmake_notices[0].is_directory or
        cmake_configurations[0].owner != ctx.attr.cmake.label or cmake_notices[0].owner != ctx.attr.cmake.label):
        fail("Binaryen CMake generator requires one original source producer and notice closure")
    cmake_originals = cmake_groups.original_sources.to_list()
    cmake_files = cmake_configurations + cmake_notices + cmake_originals
    inputs = depset(ctx.files.source + unicode_files + selection_helpers.values() + [ctx.file.unicode_helper, ctx.file.archive, ctx.file.googletest, ctx.file.builder, ctx.file.helper, ctx.file.pins, ctx.executable.make_driver, ctx.file.cmake_source_join] + cmake_files, transitive = [cc.all_files] + [target[DefaultInfo].files for target in sdk_targets.values()] + [target[DefaultInfo].default_runfiles.files for target in sdk_targets.values()])
    prefix = ctx.attr.source.label.workspace_root + "/source/"
    source = []
    renamed = ["third_party/googletest/BUILD.bazel", "third_party/googletest/googlemock/test/BUILD.bazel", "third_party/googletest/googletest/test/BUILD.bazel"]
    for file in ctx.files.source:
        if file.is_directory or not file.is_source or not file.path.startswith(prefix):
            fail("Binaryen source must be its exact original repository File closure")
        member = file.path.removeprefix(prefix)
        if member.endswith(".publisher") and member.removesuffix(".publisher") in renamed:
            member = member.removesuffix(".publisher")
        source.append({"path": file.path, "member": member, "label": str(file.owner)})
    runtime = ctx.actions.declare_directory(ctx.label.name + ".sdk")
    binary = ctx.actions.declare_file(ctx.label.name + ".tools/wasm-opt")
    commands = ctx.actions.declare_file(ctx.label.name + ".compile_commands.json")
    dependencies = ctx.actions.declare_directory(ctx.label.name + ".dependencies")
    maps = ctx.actions.declare_directory(ctx.label.name + ".link_maps")
    objects = ctx.actions.declare_directory(ctx.label.name + ".compiler_objects")
    archives = ctx.actions.declare_directory(ctx.label.name + ".compiler_archives")
    notices = ctx.actions.declare_directory(ctx.label.name + ".original_notices")
    configuration = ctx.actions.declare_file(ctx.label.name + ".build.json")
    specification = ctx.actions.declare_file(ctx.label.name + ".request.json")
    ctx.actions.write(specification, json.encode({
        "producer": str(ctx.label),
        "cmake_source_join": ctx.file.cmake_source_join.path,
        "cmake_producer": {
            "producer": str(ctx.attr.cmake.label),
            "executable": ctx.attr.cmake[NativeSdkInfo].binary.path,
            "configuration": cmake_configurations[0].path,
            "notices": cmake_notices[0].path,
            "original_sources": [file.path for file in cmake_originals],
        },
        "platform": ctx.attr.platform,
        "selection_helpers": {name: file.path for name, file in selection_helpers.items()},
        "archive": ctx.file.archive.path,
        "googletest": ctx.file.googletest.path,
        "pins": ctx.file.pins.path,
        "source": source,
        "unicode_inputs": unicode_inputs,
        "unicode_helper": ctx.file.unicode_helper.path,
        "tools": tools,
        "sdk_roots": {name: file.path for name, file in sdk_roots.items()},
        "declared_files": [file.path for file in inputs.to_list()],
        "helper": ctx.file.helper.path,
        "sysroot": cc.sysroot or "",
        "environment": environment,
        "compile_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables), "__BINARYEN_OBJECT__"),
        "cxx_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_compile, variables = variables), "__BINARYEN_OBJECT__"),
        "link_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_executable, variables = link_variables), "__BINARYEN_EXECUTABLE__"),
        "shared_flags": _flags(cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_dynamic_library, variables = shared_variables), "__BINARYEN_LIBRARY__"),
        "outputs": {"runtime": runtime.path, "binary": binary.path, "commands": commands.path, "dependencies": dependencies.path, "maps": maps.path, "objects": objects.path, "archives": archives.path, "notices": notices.path, "configuration": configuration.path},
    }))
    ctx.actions.run(
        executable = ctx.executable.python,
        arguments = ["-B", "-I", ctx.file.builder.path, specification.path],
        inputs = depset([specification], transitive = [inputs]),
        tools = [ctx.attr.python[DefaultInfo].files_to_run, ctx.attr.make_driver[DefaultInfo].files_to_run] + [target[DefaultInfo].files_to_run for target in sdk_targets.values()],
        outputs = [runtime, binary, commands, dependencies, maps, objects, archives, notices, configuration],
        mnemonic = "DeclaredBinaryenSdk",
        use_default_shell_env = False,
    )
    return [DefaultInfo(executable = binary, files = depset([runtime, binary]), runfiles = ctx.runfiles(files = [runtime, binary])), NativeSdkInfo(prefix_runfile = "_main/" + runtime.short_path, binary = binary), OutputGroupInfo(compiler_commands = depset([commands]), compiler_dependencies = depset([dependencies]), compiler_objects = depset([objects]), compiler_archives = depset([archives]), native_link_maps = depset([maps]), compiler_configuration = depset([configuration]), original_notices = depset([notices]), original_sources = depset(ctx.files.source + unicode_files + [ctx.file.archive, ctx.file.googletest]))]

_binaryen_sdk = rule(
    implementation = _impl,
    executable = True,
    attrs = {
        "platform": attr.string(mandatory = True, values = _PLATFORMS.keys()),
        "source": attr.label(default = "@merkur_binaryen_original//:source_files"),
        "archive": attr.label(default = "@merkur_binaryen_original//:source.tar.gz", allow_single_file = True),
        "googletest": attr.label(default = "@merkur_binaryen_original//:googletest.tar.gz", allow_single_file = True),
        "sdk": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "make": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "cmake": attr.label(mandatory = True, cfg = "exec", providers = [NativeSdkInfo]),
        "make_driver": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "ranlib": attr.label(mandatory = True, allow_single_file = True, cfg = "exec"),
        "python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
        "builder": attr.label(default = ":build.py", allow_single_file = True),
        "cmake_source_join": attr.label(default = "//tools/bazel/tools/native:cmake-selected-source.py", allow_single_file = True),
        "helper": attr.label(default = "//tools/bazel/tools/native:cmake_source_build.py", allow_single_file = True),
        "unicode_helper": attr.label(default = ":unicode-source.py", allow_single_file = True),
        "unicode_inputs": attr.label_keyed_string_dict(default = {"@merkur_binaryen_original//:unicode-" + role: role for role in ["generator", "data", "readme", "original_cpp", "terms", "license"]}),
        "_linked": attr.label(default = "//tools/bazel/bun:bun-runtime-linked-sources.py", allow_single_file = True),
        "_sections": attr.label(default = "//tools/bazel/bun:runtime-sections.py", allow_single_file = True),
        "_mapper": attr.label(default = "//tools/bazel/rust:stdlib_attribution.py", allow_single_file = True),
        "_licenses": attr.label(default = "//tools/bazel/packaging:license-inputs.py", allow_single_file = True),
        "pins": attr.label(default = ":original.json", allow_single_file = True),
    },
    toolchains = use_cc_toolchain(),
    fragments = ["cpp"],
)

def declared_binaryen_sdk(name, platform, sdk, make, cmake, make_driver, ranlib):
    """Explicit manual factory; absent genuine platform inputs have no default."""
    _binaryen_sdk(name = name, platform = platform, sdk = sdk, make = make, cmake = cmake, make_driver = make_driver, ranlib = ranlib, target_compatible_with = _PLATFORMS[platform], exec_compatible_with = _PLATFORMS[platform], tags = ["manual"])
