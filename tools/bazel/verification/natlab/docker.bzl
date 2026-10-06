"""Original static Docker CLI; daemon access is a separate explicit fixture."""

def _cli_impl(ctx):
    executable = ctx.actions.declare_file(ctx.label.name + ".bin")
    ctx.actions.symlink(output = executable, target_file = ctx.file.binary, is_executable = True)
    return [DefaultInfo(executable = executable, files = depset([executable]), runfiles = ctx.runfiles(files = [ctx.file.binary, ctx.file.license, ctx.file.archive, ctx.file.lock]))]

declared_docker_cli = rule(
    implementation = _cli_impl,
    executable = True,
    attrs = {
        "binary": attr.label(allow_single_file = True, mandatory = True),
        "license": attr.label(allow_single_file = True, mandatory = True),
        "archive": attr.label(allow_single_file = True, mandatory = True),
        "lock": attr.label(allow_single_file = True, mandatory = True),
    },
)

def _repository_impl(ctx):
    lock = json.decode(ctx.read(ctx.attr.lock))
    architecture = "x86_64" if ctx.attr.architecture == "amd64" else "aarch64"
    platform = lock["platforms"][architecture]
    ctx.download(url = platform["url"], sha256 = platform["sha256"], canonical_id = platform["url"], output = "archive.tgz")
    ctx.extract("archive.tgz", output = "original")
    ctx.download(url = lock["license"]["url"], sha256 = lock["license"]["sha256"], canonical_id = lock["license"]["url"], output = "LICENSE")
    ctx.file("BUILD.bazel", '\n'.join([
        'load("@@//tools/bazel/verification:natlab/docker.bzl", "declared_docker_cli")',
        'package(default_visibility = ["//visibility:public"])',
        'exports_files(["original/docker/docker", "archive.tgz", "LICENSE"])',
        'declared_docker_cli(',
        '    name = "docker", binary = "original/docker/docker", license = "LICENSE", archive = "archive.tgz",',
        '    lock = ' + repr(str(ctx.attr.lock)) + ',',
        '    target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:' + ("x86_64" if ctx.attr.architecture == "amd64" else "aarch64") + '"],',
        ')',
        '',
    ]))

docker_cli_repository = repository_rule(
    implementation = _repository_impl,
    attrs = {"lock": attr.label(allow_single_file = True, mandatory = True), "architecture": attr.string(values = ["amd64", "arm64"], mandatory = True)},
)
