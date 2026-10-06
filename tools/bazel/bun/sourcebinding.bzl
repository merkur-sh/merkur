"""Manual original-source Bun graph; no native qualification or shipping admission."""

load("//tools/bazel/bun:bun-runtime-build-native.bzl", "bun_runtime_build_native")
load("//tools/bazel/bun:bun-runtime-selected.bzl", "bun_runtime_selected_inputs")
load("//tools/bazel/bun:rules.bzl", "bun_source_runtime_compile")
load("//tools/bazel/bun:runtime-archives.bzl", "runtime_webkit_pin")
load("//tools/bazel/rust:cmake-driver.bzl", "declared_cmake_driver")
load("//tools/bazel/tools/bun_build_utilities:source.bzl", "declared_bun_build_utility")
load("//tools/bazel/tools/llvm_sdk:rules.bzl", "llvm_sdk")
load("//tools/bazel/tools/native:cmake-source.bzl", "declared_cmake_sdk")
load("//tools/bazel/tools/ninja_sdk:rules.bzl", "declared_ninja_sdk")
load("@bun_npm_publisher_notice_inputs//:defs.bzl", "PUBLISHER_NOTICE_INPUTS")

_PLATFORMS = {
    "darwin_arm64": ("macos", "aarch64", "darwin_aarch64", "bun-darwin-arm64"),
    "darwin_x64": ("macos", "x86_64", "darwin_x64", "bun-darwin-x64"),
    "linux_arm64": ("linux", "aarch64", "linux_aarch64", "bun-linux-arm64"),
    "linux_x64": ("linux", "x86_64", "linux_x64", "bun-linux-x64"),
}
_DEPENDENCIES = [
    "picohttpparser", "nodejs", "zlib", "zstd", "brotli", "libdeflate", "libarchive",
    "libjpeg-turbo", "libspng", "libwebp", "cares", "hdrhistogram", "highway",
    "lolhtml", "rust-argon2", "lshpack", "lsqpack", "mimalloc", "tinycc", "boringssl", "lsquic",
]

def bun_native_runtime_targets(name, sdk_bindings):
    """Bind explicitly supplied native SDKs without inventing other platforms.

    Each binding supplies actual sysroot and CcToolchain RANLIB File labels,
    plus genuine NativeSdkInfo shell/Make/Git/uname and utility targets. Linux
    additionally requires its original strip and compiler execution constraint.
    Darwin sysroots must expose DarwinCompilerSdkInfo; Linux supplies its
    original sysroot Tree. Register those same original native CcToolchains
    before analyzing this graph. Existing source SDK factories check actual
    tool File membership. These manual calls do not register or replace
    production Bun toolchains; complete acceptance still needs four platforms.
    """
    if not sdk_bindings or any([platform not in _PLATFORMS for platform in sdk_bindings]):
        fail("Original Bun native graph requires nonempty known native SDK bindings")
    for platform, binding in sdk_bindings.items():
        os, cpu, archive_platform, compile_target = _PLATFORMS[platform]
        required = ["sysroot", "ranlib", "git", "uname", "shell", "make", "tools"] + (["strip", "compiler_constraint"] if os == "linux" else [])
        if sorted(binding.keys()) != sorted(required) or any([not binding[key] for key in required]):
            fail("Original Bun SDK File bindings are absent/foreign for " + platform)
        utility_names = ["tar", "touch", "mkdir", "cp", "rm", "cat", "env"]
        if sorted(binding["tools"].keys()) != sorted(utility_names) or any([not binding["tools"][tool] for tool in utility_names]):
            fail("Original Bun utility SDK targets are absent/foreign for " + platform)
        constraints = ["@platforms//os:" + os, "@platforms//cpu:" + cpu]
        execution = constraints + ([binding["compiler_constraint"]] if os == "linux" else [])
        prefix = name + "_" + platform
        bootstrap_shell = binding["shell"]
        bootstrap_make = binding["make"]
        native_tools = {binding["tools"][tool]: tool for tool in utility_names}
        if len(native_tools) != len(utility_names):
            fail("Original Bun utility SDK target has multiple tool identities")
        declared_cmake_driver(name = prefix + "_cmake_driver")
        declared_cmake_sdk(
            name = prefix + "_cmake", source = "@cmake_source//:source",
            target = {
                "darwin_arm64": "aarch64-apple-darwin",
                "darwin_x64": "x86_64-apple-darwin",
                "linux_arm64": "aarch64-unknown-linux-gnu",
                "linux_x64": "x86_64-unknown-linux-gnu",
            }[platform],
            sdk = bootstrap_shell, make = bootstrap_make,
            make_driver = ":" + prefix + "_cmake_driver_make",
            git = binding["git"], target_compatible_with = constraints,
            exec_compatible_with = execution, tags = ["manual"],
        )
        for kind in ["bash", "perl", "nasm"]:
            additional = {}
            if kind == "bash":
                additional = {
                    "readline_archive": "@bun_build_readline_source//file",
                    "ncurses_archive": "@bun_build_ncurses_source//file",
                }
            elif kind == "nasm":
                additional = {"perl": ":" + prefix + "_perl"}
            declared_bun_build_utility(
                name = prefix + "_" + kind, kind = kind,
                archive = "@bun_build_" + kind + "_source//file",
                patch = "//tools/bazel/tools/bun_build_utilities:" +
                        ("bash-runtime-resources.patch" if kind == "bash" else kind + "-declared-tools.patch"),
                shell = bootstrap_shell, make = bootstrap_make, git = binding["git"],
                ranlib = binding["ranlib"], target_compatible_with = constraints,
                exec_compatible_with = execution, tags = ["manual"], **additional
            )
            native_tools[":" + prefix + "_" + kind] = kind
        declared_ninja_sdk(
            name = prefix + "_ninja", source = "@ninja_declared_shell_source//:source",
            shell = bootstrap_shell, target_compatible_with = constraints,
            exec_compatible_with = execution, tags = ["manual"],
        )
        native_tools[":" + prefix + "_ninja"] = "ninja"
        native_tools[binding["git"]] = "git"
        native_tools[binding["uname"]] = "uname"
        if os == "linux":
            native_tools[binding["strip"]] = "strip"
        llvm_sdk(
            name = prefix + "_llvm", source_archive = "@merkur_llvm_21_1_8_source//file",
            platform = platform, sdk = bootstrap_shell, make = bootstrap_make,
            make_driver = ":" + prefix + "_cmake_driver_make", cmake = ":" + prefix + "_cmake",
            ranlib = binding["ranlib"], git = binding["git"], uname = binding["uname"],
            python = "//tools/bazel/tools/native:python3", target_compatible_with = constraints,
            exec_compatible_with = execution, tags = ["manual"],
        )
        webkit = runtime_webkit_pin(archive_platform)
        bun_runtime_build_native(
            name = prefix, llvm_sdk = ":" + prefix + "_llvm", dsym_jobs = 4,
            bun = "@bun_" + archive_platform + "//:bun", cmake = ":" + prefix + "_cmake",
            nightly = "@bun_nightly_sdk_" + platform + "//:payload",
            nightly_archives = "@bun_nightly_sdk_" + platform + "//:original_archives",
            registry = "@bun_build_registry_inputs//:sources", npm_cache = "@bun_build_npm_inputs//:cache",
            npm_publisher_metadata = {item["metadata"]: identity for identity, item in PUBLISHER_NOTICE_INPUTS.items()},
            npm_publisher_sources = {item["source"]: identity for identity, item in PUBLISHER_NOTICE_INPUTS.items()},
            sysroot = binding["sysroot"], tools = native_tools,
            runtime_library_roots = [bootstrap_shell, binding["git"], binding["tools"]["env"], ":" + prefix + "_bash"],
            dependencies = {"@bun_build_dep_" + dependency.replace("-", "_") + "//file": dependency
                            for dependency in _DEPENDENCIES},
            webkit_archive = "@bun_webkit_" + archive_platform + "//file",
            webkit_pin = {"url": webkit.url, "sha256": webkit.sha256},
            target_compatible_with = constraints, exec_compatible_with = execution,
            tags = ["manual"],
        )
        native.filegroup(name = prefix + "_configuration", srcs = [":" + prefix],
                         output_group = "native_configuration", tags = ["manual"])
        native.filegroup(name = prefix + "_original_build", srcs = [":" + prefix],
                         output_group = "original_build", tags = ["manual"])
        bun_source_runtime_compile(
            name = prefix + "_compile_probe", entry_point = "//tools/bazel/bun:compile-platform-probe.ts",
            target_runtime = ":" + prefix, compile_target = compile_target,
            out = prefix + ".compile-platform-probe", target_compatible_with = constraints,
            exec_compatible_with = execution, tags = ["manual"],
        )
        bun_runtime_selected_inputs(
            name = prefix + "_selected_inputs", source_runtime = ":" + prefix,
            producer = ":" + prefix + "_compile_probe", target_compatible_with = constraints,
            exec_compatible_with = execution, tags = ["manual"],
        )
