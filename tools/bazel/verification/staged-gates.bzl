"""Declared index/HEAD gates; capture producers are owned by the verification controller."""

load("//tools/bazel/bun:rules.bzl", "bun_command_test")
load("//tools/bazel/verification:operations.bzl", "StaticOperationBindingsInfo")

def _inputs_impl(ctx):
    index = ctx.file.index_tree
    if not index.is_directory:
        fail("Staged gates require an exact declared index TreeArtifact")
    files = [index, ctx.file.index_manifest, ctx.file.context, ctx.file.objects, ctx.file.object_pack]
    values = {
        "index_tree": index.short_path,
        "index_manifest": ctx.file.index_manifest.short_path,
        "context": ctx.file.context.short_path,
        "objects": ctx.file.objects.short_path,
        "object_pack": ctx.file.object_pack.short_path,
        "projections": None,
    }
    if ctx.attr.projections:
        descriptors = ctx.attr.projections[OutputGroupInfo].descriptor.to_list()
        if len(descriptors) != 1:
            fail("Staged ratchet requires one complete configured projection descriptor")
        values["projections"] = descriptors[0].short_path
        files.extend(ctx.attr.projections[DefaultInfo].files.to_list())
        files.extend(descriptors)
    manifest = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(manifest, json.encode(values) + "\n")
    return [DefaultInfo(files = depset([manifest] + files))]

_staged_inputs = rule(
    implementation = _inputs_impl,
    attrs = {
        "index_tree": attr.label(allow_single_file = True, mandatory = True),
        "index_manifest": attr.label(allow_single_file = True, mandatory = True),
        "context": attr.label(allow_single_file = True, mandatory = True),
        "objects": attr.label(allow_single_file = True, mandatory = True),
        "object_pack": attr.label(allow_single_file = True, mandatory = True),
        "projections": attr.label(),
    },
)

def staged_gate_test(name, operation, index_tree, index_manifest, context, objects, object_pack, git, native_tool, projections = None, data = [], **kwargs):
    if operation not in ["secrets", "ratchet"] or (operation == "ratchet") != (projections != None):
        fail("Staged ratchet requires its complete configured projections; secrets do not")
    inputs = name + "_inputs"
    _staged_inputs(
        name = inputs,
        index_tree = index_tree,
        index_manifest = index_manifest,
        context = context,
        objects = objects,
        object_pack = object_pack,
        projections = projections,
    )
    bun_command_test(
        name = name,
        fixed_args = ["run", "tools/bazel/verification/staged-gates.ts", operation, native.package_name() + "/" + inputs + ".json"],
        data = [":" + inputs] + data,
        tools = {git: "git", native_tool: "staged-native"},
        tool_environment = {"git": "MERKUR_VERIFICATION_GIT", "staged-native": "MERKUR_VERIFICATION_TRUFFLEHOG" if operation == "secrets" else "MERKUR_VERIFICATION_FALLOW"},
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        **kwargs
    )

def _bindings_impl(ctx):
    operations = []
    for name, target in [("staged:secrets", ctx.attr.secrets), ("staged:ratchet", ctx.attr.ratchet)]:
        if not target[DefaultInfo].files.to_list():
            fail("Configured staged gate has no engine output")
        label = str(target.label)
        if label.startswith("@@//"):
            label = label[2:]
        operations.append({"name": name, "checks": [{"label": label, "kind": "test", "fresh": True}], "pending": []})
    descriptor = {"operations": operations, "crates": [], "browserOwners": []}
    manifest = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(manifest, json.encode(descriptor) + "\n")
    return [DefaultInfo(files = depset([manifest])), StaticOperationBindingsInfo(descriptor = descriptor, manifest = manifest), OutputGroupInfo(descriptor = depset([manifest]))]

staged_gate_bindings = rule(
    implementation = _bindings_impl,
    attrs = {"secrets": attr.label(default = "//tools/bazel/verification:staged_secrets"), "ratchet": attr.label(default = "//tools/bazel/verification:staged_ratchet")},
)

def _scanner_repository_impl(ctx):
    pins = json.decode(ctx.read(ctx.attr.pins))
    key = ctx.attr.platform + "-" + ctx.attr.architecture
    filename = "trufflehog_" + pins["version"] + "_" + key.replace("-", "_") + ".tar.gz"
    ctx.download(
        url = "https://github.com/trufflesecurity/trufflehog/releases/download/v" + pins["version"] + "/" + filename,
        output = "original.tar.gz",
        sha256 = pins["checksums"][key],
    )
    ctx.extract("original.tar.gz")
    ctx.file("BUILD.bazel", """load("@merkur//tools/bazel/tools/native:native.bzl", "native_executable")
package(default_visibility = ["//visibility:public"])
filegroup(name = "runtime", srcs = glob(["**"], exclude = ["BUILD.bazel"]))
native_executable(name = "scanner", binary = "trufflehog", runtime = ":runtime")
""")

_scanner_repository = repository_rule(
    implementation = _scanner_repository_impl,
    attrs = {"platform": attr.string(mandatory = True), "architecture": attr.string(mandatory = True), "pins": attr.label(default = "//scripts:trufflehog.json")},
)

def _scanners_impl(_ctx):
    for platform in ["darwin", "linux"]:
        for architecture in ["arm64", "amd64"]:
            _scanner_repository(name = "trufflehog_" + platform + "_" + architecture, platform = platform, architecture = architecture)

staged_scanners = module_extension(implementation = _scanners_impl)
