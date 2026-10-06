"""Bind native shell tests to one original SDK and the source-built tmux engine."""
load("//tools/bazel/tools/native:native.bzl", "native_executable")
load("//tools/bazel/tools/native:sdk.bzl", "sdk_executable")
load(":tmux.bzl", "declared_tmux_sdk")

_PLATFORMS = {
    "darwin_arm64": ["@platforms//os:osx", "@platforms//cpu:aarch64"],
    "darwin_x64": ["@platforms//os:osx", "@platforms//cpu:x86_64"],
    "linux_arm64": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
    "linux_x64": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
}

def shell_runtime_targets():
    for platform, constraints in _PLATFORMS.items():
        for tool in ["bash", "zsh", "sh", "env", "cat", "touch"]:
            sdk_executable(name = tool + "_" + platform, binary = "@shell_runtime_" + platform + "//:bin/" + tool, sdk = "@shell_runtime_" + platform + "//:runtime", target_compatible_with = constraints)
        native_executable(name = "fish_" + platform, binary = "@shell_fish_" + platform + "//:" + ("bin/fish" if platform.startswith("darwin_") else "fish"), runtime = "@shell_fish_" + platform + "//:runtime", target_compatible_with = constraints)
    for tool in ["bash", "zsh", "sh", "env", "cat", "touch", "fish"]:
        native.alias(name = tool, actual = select({"//tools/bazel/tools/native:" + platform: ":" + tool + "_" + platform for platform in _PLATFORMS}, no_match_error = "Native shell utility requires one declared Darwin/Linux ARM64/x64 SDK"))
    declared_tmux_sdk(name = "tmux", source = "@shell_tmux_source//:source", shell = ":bash")
