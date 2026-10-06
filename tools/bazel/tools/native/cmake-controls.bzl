"""Original CMake controls with caller-declared genuine source Git Files."""

load("//tools/bazel/packaging:rules.bzl", "package_controls_test")

def cmake_source_controls_test(name, git, git_runtime, **kwargs):
    """Consume one original Git executable File and its original SDK Tree File.

    Callers select those exact action outputs from the existing source-built
    Git SDK git/runtime output groups. Absent genuine producer outputs are
    errors, not prebuilt/native-tool substitutions.
    """
    files = {
        "archive": "@cmake_source_archive//file",
        "pins": "//tools/bazel/tools/native:cmake-pins.json",
        "join": "//tools/bazel/tools/native:cmake-selected-source.py",
        "builder": "//tools/bazel/tools/native:cmake_source_build.py",
        "git": git,
        "git-runtime": git_runtime,
        "linked": "//tools/bazel/bun:bun-runtime-linked-sources.py",
        "licenses": "//tools/bazel/packaging:license-inputs.py",
        "workspace-license": "//:LICENSE",
    }
    patches = [
        "//tools/bazel/tools/native:cmake-darwin-native-memory.patch",
        "//tools/bazel/tools/native:cmake-darwin-native-runtime.patch",
    ]
    arguments = []
    for flag, label in files.items():
        arguments.extend(["--" + flag, "$(rootpath " + str(label) + ")"])
    for label in patches:
        arguments.extend(["--patch", "$(rootpath " + label + ")"])
    package_controls_test(
        name = name,
        src = "//tools/bazel/tools/native:cmake-selected-source-test.py",
        data = files.values() + patches,
        args = arguments,
        **kwargs
    )
