"""Original Bun Cargo.lock registry inputs; no compiler-selected source claim."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_file")

def _registry_impl(ctx):
    pins = json.decode(ctx.read(Label("//tools/bazel/bun:bun-runtime-build-registry.json")))
    names = {}
    for package in pins["packages"]:
        name = "bun_build_crate_" + package["name"].replace("-", "_") + "_" + package["version"].replace(".", "_").replace("-", "_").replace("+", "_plus_")
        if name in names:
            fail("Original Bun Cargo registry archive names collide")
        names[name] = True
        http_file(
            name = name,
            urls = [package["url"]],
            sha256 = package["sha256"],
            downloaded_file_path = package["name"] + "-" + package["version"] + ".crate",
        )
    _inputs_repository(name = "bun_build_registry_inputs", packages = json.encode(pins["packages"]))
    return ctx.extension_metadata(reproducible = True)

bun_runtime_build_registry = module_extension(implementation = _registry_impl)

def _inputs_repository_impl(ctx):
    archives = {}
    for package in json.decode(ctx.attr.packages):
        name = "bun_build_crate_" + package["name"].replace("-", "_") + "_" + package["version"].replace(".", "_").replace("-", "_").replace("+", "_plus_")
        archives["@" + name + "//file"] = package["name"] + "@" + package["version"]
    ctx.file("BUILD.bazel", "\n".join([
        "load(" + json.encode(str(ctx.attr.rule)) + ', "bun_runtime_build_registry_sources")',
        'bun_runtime_build_registry_sources(name = "sources", archives = ' + json.encode(archives) + ', visibility = ["//visibility:public"])',
        "",
    ]))

_inputs_repository = repository_rule(
    implementation = _inputs_repository_impl,
    attrs = {
        "packages": attr.string(mandatory = True),
        "rule": attr.label(default = "//tools/bazel/bun:bun-runtime-build-registry.bzl", allow_single_file = True),
    },
)

def _directory_sources_impl(ctx):
    archives = {}
    inputs = []
    for target, identity in ctx.attr.archives.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or identity in archives:
            fail("Original registry directory source requires one unique declared archive File")
        archives[identity] = files[0].path
        inputs.append(files[0])
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    output = ctx.actions.declare_directory(ctx.label.name + ".sources")
    ctx.actions.write(specification, json.encode({
        "source_archive": ctx.file.source_archive.path,
        "archives": archives,
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, specification.path, ctx.file._pins.path,
                     ctx.file._source_pins.path, output.path, ctx.file._custody.path,
                     ctx.file._deployment.path, ctx.file._output_tree.path, ctx.file._builder.path],
        inputs = depset(inputs + [specification, ctx.file.source_archive, ctx.file._runner,
                                 ctx.file._pins, ctx.file._source_pins, ctx.file._custody,
                                 ctx.file._deployment, ctx.file._output_tree,
                                 ctx.file._builder] + ctx.files._modules),
        outputs = [output],
        mnemonic = "OriginalBunCargoDirectorySources",
        progress_message = "Prepare original Bun offline registry sources %{label}",
        execution_requirements = {"block-network": "1"},
    )
    return [DefaultInfo(files = depset([output]))]

bun_runtime_build_registry_sources = rule(
    implementation = _directory_sources_impl,
    attrs = {
        "archives": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "source_archive": attr.label(default = "@bun_runtime_source_archive//file", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/bun:bun-runtime-build-registry.py", allow_single_file = True),
        "_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-build-registry.json", allow_single_file = True),
        "_source_pins": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution-pins.json", allow_single_file = True),
        "_custody": attr.label(default = "//tools/bazel/bun:bun-runtime-attribution.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_deployment": attr.label(default = "//tools/bazel/packaging:deployment-pack.py", allow_single_file = True),
        "_output_tree": attr.label(default = "//tools/bazel/packaging:output-tree.py", allow_single_file = True),
        "_builder": attr.label(default = "//tools/bazel/bun:bun-runtime-build.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
    },
)
