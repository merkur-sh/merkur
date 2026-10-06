"""Acquisition of the pinned Apple compiler/SDK export from a machine-local store.

Apple's licence forbids publishing the export, so no origin is declared. The
specification pins the export's SHA256 and size and names the Xcode release it is
taken from; `darwin-export.py` regenerates the same bytes from that release. The
store is the one directory named by MERKUR_DARWIN_COMPILER_STORE and holds the
export as `<sha256>.tar.gz`. A missing store, missing archive or differing digest
refuses the repository; no developer directory, PATH or xcrun is consulted.
"""

STORE = "MERKUR_DARWIN_COMPILER_STORE"

def _refusal(request, problem):
    source = request["source"]
    return "\n".join([
        "Darwin compiler/SDK acquisition refused: " + problem,
        "Export it from an Apple-signature-verified " + source["product"] + " " + source["version"] + " (" + source["build"] + ") bundle:",
        "  python3 -I -B tools/bazel/tools/native/darwin-export.py --source-bundle <Xcode.app> --execution-cpu " + request["execution_cpu"] +
        " --archive \"$" + STORE + "/" + request["archive"]["sha256"] + ".tar.gz\"" +
        " --compiler-extractor tools/bazel/tools/native/darwin-compiler.py --output <result.json>",
        "and give Bazel the absolute store directory in " + STORE + ".",
    ])

def _impl(ctx):
    if not ctx.attr.executor_constraints or len(ctx.attr.executor_constraints) != len({value: True for value in ctx.attr.executor_constraints}):
        fail("Darwin compiler requires explicit qualified OS/executor constraints")
    request = json.decode(ctx.attr.specification)
    store = ctx.getenv(STORE)
    if not store or not store.startswith("/"):
        fail(_refusal(request, STORE + " does not name an absolute store directory"))
    archive = ctx.path(store + "/" + request["archive"]["sha256"] + ".tar.gz")
    if not archive.exists:
        fail(_refusal(request, str(archive) + " is absent"))

    # The extractor below checks the digest and size; a later change refetches.
    ctx.watch(archive)
    ctx.symlink(archive, ".acquisition/original.tar")
    ctx.download_and_extract(
        url = ctx.attr.python_url,
        sha256 = ctx.attr.python_sha256,
        output = ".acquisition/python",
        stripPrefix = "python",
    )
    ctx.file(".acquisition/request.json", json.encode(request))
    result = ctx.execute(
        [str(ctx.path(".acquisition/python/bin/python3")), "-I", "-B", str(ctx.path(ctx.attr.extractor)),
         str(ctx.path(".acquisition/request.json")), str(ctx.path(".acquisition/original.tar")),
         str(ctx.path("payload")), str(ctx.path(ctx.attr.image_loader)), str(ctx.path(".acquisition/members.json"))],
        environment = {"PATH": "", "PYTHONHOME": "", "PYTHONPATH": ""},
        timeout = 600,
    )
    if result.return_code != 0:
        fail(_refusal(request, "the stored archive did not extract as pinned: " + result.stderr))
    members = json.decode(ctx.read(".acquisition/members.json"))
    ctx.delete("payload")
    tools = request["tools"]
    selectors = ["darwin_compiler_member(name = " + repr(name) + ', sdk = ":sdk", member = ' + repr(value) + ")" for name, value in tools.items()]
    config = ["    " + name + " = " + repr(":" + name) + "," for name in tools]
    ctx.file("BUILD.bazel", "\n".join([
        'load("@rules_cc//cc:defs.bzl", "cc_toolchain")',
        'load("@merkur//tools/bazel/tools/native:darwin-config.bzl", "darwin_config")',
        'load("@merkur//tools/bazel/tools/native:darwin-artifacts.bzl", "darwin_compiler_member", "darwin_compiler_sdk")',
        'load("@merkur//tools/bazel/tools/native:darwin-swift.bzl", "darwin_swift_sdk", "darwin_swift_compiler")',
        'package(default_visibility = ["//visibility:public"])',
        'exports_files([".acquisition/original.tar"])',
        'darwin_compiler_sdk(name = "sdk", archive = ".acquisition/original.tar",',
        "    specification = " + repr(json.encode(request)) + ", members = " + repr(json.encode(members)) + ",",
        '    python = "@merkur//tools/bazel/tools/native:python3")',
    ] + selectors + [
        'darwin_swift_sdk(name = "swift_sdk", sdk = ":sdk")',
        'darwin_swift_compiler(name = "swiftc", sdk = ":swift_sdk")',
        "darwin_config(",
        '    name = "config", sdk = ":sdk",',
        "    cpu = " + repr(request["execution_cpu"]) + ",",
        "    deployment_target = " + repr(ctx.attr.deployment_target) + ",",
    ] + config + [
        ")",
        'cc_toolchain(name = "cc", toolchain_identifier = ' + repr(ctx.attr.name) + ', toolchain_config = ":config",',
        '    all_files = ":sdk", ar_files = ":sdk", as_files = ":sdk",',
        '    compiler_files = ":sdk", dwp_files = ":sdk", linker_files = ":sdk",',
        '    objcopy_files = ":sdk", strip_files = ":sdk", supports_param_files = 1)',
        'toolchain(name = "native_toolchain", toolchain = ":cc", toolchain_type = "@bazel_tools//tools/cpp:toolchain_type",',
        '    exec_compatible_with = ["@platforms//os:osx", "@platforms//cpu:' + request["execution_cpu"] + '"] + ' + repr(ctx.attr.executor_constraints) + ",",
        '    target_compatible_with = ["@platforms//os:osx", "@platforms//cpu:' + request["execution_cpu"] + '"])',
        "",
    ]))

darwin_compiler_archive = repository_rule(
    implementation = _impl,
    attrs = {
        "specification": attr.string(mandatory = True),
        "deployment_target": attr.string(mandatory = True),
        "executor_constraints": attr.string_list(mandatory = True),
        "python_url": attr.string(mandatory = True),
        "python_sha256": attr.string(mandatory = True),
        "extractor": attr.label(default = "//tools/bazel/tools/native:darwin-compiler.py", allow_single_file = True),
        "image_loader": attr.label(default = "//tools/bazel/tools/native:extract-sdk.py", allow_single_file = True),
    },
)
