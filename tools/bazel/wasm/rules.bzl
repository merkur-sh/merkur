"""Declared WASM binding generation from a native rules_rust cdylib artifact."""

load("//tools/bazel/bun:rules.bzl", "bun_inputs")
load(":providers.bzl", "WasmPackageInfo")

def _generator_configuration(ctx, stage, inputs, tools, arguments, output, executable):
    configuration = ctx.actions.declare_file(ctx.label.name + ".generation.json")
    ctx.actions.write(configuration, json.encode({
        "producer": str(ctx.label),
        "stage": stage,
        "inputs": [{"input": file.path, "label": str(file.owner), "tree": file.is_directory} for file in inputs],
        "tools": [{"input": file.path, "label": str(file.owner), "tree": file.is_directory} for file in tools],
        "executable": {"input": executable.path, "label": str(executable.owner), "tree": executable.is_directory},
        "arguments": arguments,
        "output": {"input": output.path, "label": str(output.owner)},
    }))
    return configuration

def _toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(bindgen = ctx.file.bindgen, test_runner = ctx.file.test_runner, optimizer = ctx.file.optimizer, optimizer_files = ctx.attr.optimizer_files[DefaultInfo].files)]

wasm_bindgen_toolchain = rule(
    implementation = _toolchain_impl,
    attrs = {
        "bindgen": attr.label(allow_single_file = True, mandatory = True),
        "test_runner": attr.label(allow_single_file = True, mandatory = True),
        "optimizer": attr.label(allow_single_file = True, mandatory = True),
        "optimizer_files": attr.label(mandatory = True),
    },
)

def _bindings_impl(ctx):
    toolchain = ctx.toolchains["//tools/bazel/wasm:toolchain_type"]
    directory = ctx.actions.declare_directory(ctx.attr.out or ctx.label.name)
    args = ctx.actions.args()
    args.add(ctx.file.wasm)
    args.add_all(["--target", "web", "--out-name", ctx.attr.module_name, "--out-dir"])
    args.add(directory.path)
    configuration = _generator_configuration(ctx, "bindings", [ctx.file.wasm], [toolchain.bindgen],
                                             [ctx.file.wasm.path, "--target", "web", "--out-name", ctx.attr.module_name, "--out-dir", directory.path], directory, toolchain.bindgen)
    ctx.actions.run(
        executable = toolchain.bindgen,
        arguments = [args],
        inputs = [ctx.file.wasm, configuration],
        outputs = [directory],
        mnemonic = "WasmBindgen",
        progress_message = "Generate matching WASM bindings %{label}",
    )
    return [DefaultInfo(files = depset([directory]), runfiles = ctx.runfiles(files = [directory])), OutputGroupInfo(original_wasm = depset([ctx.file.wasm]), generator_inputs = depset([ctx.file.wasm, toolchain.bindgen]), generator_sources = depset([]), generator_configurations = depset([configuration]))]

wasm_bindings = rule(
    implementation = _bindings_impl,
    attrs = {
        "wasm": attr.label(allow_single_file = [".wasm"], mandatory = True),
        "module_name": attr.string(mandatory = True),
        "out": attr.string(),
    },
    toolchains = ["//tools/bazel/wasm:toolchain_type"],
)

def _optimize_impl(ctx):
    toolchain = ctx.toolchains["//tools/bazel/wasm:toolchain_type"]
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_directory(ctx.attr.out or ctx.label.name)
    arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, ctx.file.bindings.path, output.path, ctx.attr.module_name, toolchain.optimizer.path] + ctx.attr.flags
    files = [ctx.file.bindings, ctx.file._runner, ctx.file._config]
    tools = depset([runtime, toolchain.optimizer], transitive = [toolchain.optimizer_files])
    configuration = _generator_configuration(ctx, "optimizer", files, tools.to_list(), arguments, output, runtime)
    ctx.actions.run(
        executable = runtime,
        arguments = arguments,
        inputs = files + [configuration],
        tools = depset([toolchain.optimizer], transitive = [toolchain.optimizer_files]),
        outputs = [output],
        mnemonic = "OptimizeWasm",
        progress_message = "Preserve release WASM optimization %{label}",
    )
    return [DefaultInfo(files = depset([output]), runfiles = ctx.runfiles(files = [output])), OutputGroupInfo(original_wasm = ctx.attr.bindings[OutputGroupInfo].original_wasm, generator_inputs = depset(files, transitive = [tools, ctx.attr.bindings[OutputGroupInfo].generator_inputs]), generator_sources = depset([file for file in files if file.is_source], transitive = [ctx.attr.bindings[OutputGroupInfo].generator_sources]), generator_configurations = depset([configuration], transitive = [ctx.attr.bindings[OutputGroupInfo].generator_configurations]))]

wasm_optimized_bindings = rule(
    implementation = _optimize_impl,
    attrs = {
        "bindings": attr.label(allow_single_file = True, mandatory = True, providers = [OutputGroupInfo]),
        "module_name": attr.string(mandatory = True),
        "flags": attr.string_list(mandatory = True),
        "out": attr.string(),
        "_runner": attr.label(default = "//tools/bazel/wasm:optimize.ts", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type", "//tools/bazel/wasm:toolchain_type"],
)

def _input_tree_impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    inputs = depset(transitive = [target[DefaultInfo].files for target in ctx.attr.srcs])
    by_path = {}
    for file in inputs.to_list():
        if file.short_path.startswith("../") or file.is_directory:
            fail("Repository provenance requires explicit first-party files: " + file.short_path)
        if file.short_path in by_path and by_path[file.short_path] != file.path:
            fail("Ambiguous repository provenance input: " + file.short_path)
        by_path[file.short_path] = file.path
    manifest = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(manifest, json.encode(by_path))
    output = ctx.actions.declare_directory(ctx.attr.out or ctx.label.name)
    ctx.actions.run(
        executable = runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, manifest.path, output.path],
        inputs = depset([manifest, ctx.file._runner, ctx.file._config], transitive = [inputs]),
        outputs = [output],
        mnemonic = "WasmProvenanceInputs",
    )
    return [DefaultInfo(files = depset([output]))]

repository_input_tree = rule(
    implementation = _input_tree_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True, mandatory = True),
        "out": attr.string(),
        "_runner": attr.label(default = "//tools/bazel/wasm:input-tree.ts", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def _profile_impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    raw = ctx.actions.declare_file(ctx.label.name + ".profraw")
    merged = ctx.actions.declare_file(ctx.label.name + ".profdata")
    ctx.actions.run(
        executable = runtime,
        arguments = [
            "--no-install", "--no-env-file",
            "--config=" + ctx.file._config.path,
            ctx.file._trainer.path,
            ctx.file.driver.path,
            ctx.file.font.path,
            ctx.executable.zstd_fixture.path,
            raw.path,
        ],
        inputs = depset([ctx.file.driver, ctx.file.font, ctx.file._config, ctx.file._trainer], transitive = [bun_inputs(ctx.attr.data + [ctx.attr._trainer])]),
        tools = [ctx.attr.zstd_fixture[DefaultInfo].files_to_run],
        outputs = [raw],
        mnemonic = "TrainTerminalWasmPgo",
        progress_message = "Train production terminal staging/apply WASM profile %{label}",
    )
    ctx.actions.run(
        executable = ctx.executable.profdata_tool,
        arguments = ["merge", "-o", merged.path, raw.path],
        inputs = [raw],
        outputs = [merged],
        mnemonic = "MergeTerminalWasmPgo",
    )
    return [DefaultInfo(files = depset([merged])), OutputGroupInfo(raw_profile = depset([raw]))]

terminal_wasm_profile = rule(
    implementation = _profile_impl,
    attrs = {
        "driver": attr.label(allow_single_file = [".wasm"], mandatory = True),
        "font": attr.label(allow_single_file = [".ttf"], mandatory = True),
        "zstd_fixture": attr.label(executable = True, cfg = "exec", mandatory = True),
        "profdata_tool": attr.label(executable = True, cfg = "exec", mandatory = True),
        "data": attr.label_list(allow_files = True),
        "_trainer": attr.label(default = "//tools/bazel/wasm:profile_trainer", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)



def _original_wasm(target):
    files = target[OutputGroupInfo].original_wasm.to_list()
    if len(files) != 1 or files[0].is_directory or not files[0].basename.endswith(".wasm"):
        fail("WASM package requires its exact original compiled Rust File")
    return files[0]

def _package_impl(ctx):
    if ctx.attr.terminal and not ctx.file.source_tree:
        fail("Terminal packaging requires its declared compiler/source provenance tree")
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_directory(ctx.attr.out or ctx.label.name)
    inventory = ctx.actions.declare_file(ctx.label.name + ".inventory.json")
    arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path,
                 ctx.file._runner.path, ctx.file.bindings.path, ctx.file.crate_manifest.path,
                 output.path, ctx.file.source_tree.path if ctx.attr.terminal else ctx.bin_dir.path,
                 ctx.attr.module_name, "terminal" if ctx.attr.terminal else "ordinary",
                 inventory.path, str(ctx.label)]
    files = depset([ctx.file.bindings, ctx.file.crate_manifest, ctx.file._config, ctx.file._runner] + ([ctx.file.source_tree] if ctx.attr.terminal else []), transitive = [bun_inputs(ctx.attr.data + [ctx.attr._runner])])
    configuration = _generator_configuration(ctx, "package", files.to_list(), [runtime], arguments, output, runtime)
    generator_inputs = depset([runtime], transitive = [files, ctx.attr.bindings[OutputGroupInfo].generator_inputs])
    generator_sources = depset([file for file in files.to_list() if file.is_source], transitive = [ctx.attr.bindings[OutputGroupInfo].generator_sources])
    generator_configurations = depset([configuration], transitive = [ctx.attr.bindings[OutputGroupInfo].generator_configurations])
    ctx.actions.run(
        executable = runtime,
        arguments = arguments,
        inputs = depset([configuration], transitive = [files]),
        outputs = [output, inventory],
        mnemonic = "PackageTerminalWasm" if ctx.attr.terminal else "PackageWasm",
        progress_message = "Validate declared WASM package %{label}",
    )
    return [DefaultInfo(files = depset([output]), runfiles = ctx.runfiles(files = [output])), OutputGroupInfo(package_inventory = depset([inventory]), original_wasm = ctx.attr.bindings[OutputGroupInfo].original_wasm, generator_inputs = generator_inputs, generator_sources = generator_sources, generator_configurations = generator_configurations), WasmPackageInfo(tree = output, inventory = inventory, producer = ctx.label, original_wasm = _original_wasm(ctx.attr.bindings), generator_inputs = generator_inputs, generator_sources = generator_sources, generator_configurations = generator_configurations, crate_manifest = ctx.file.crate_manifest)]

wasm_package = rule(
    implementation = _package_impl,
    attrs = {
        "bindings": attr.label(allow_single_file = True, mandatory = True, providers = [OutputGroupInfo]),
        "crate_manifest": attr.label(allow_single_file = [".toml"], mandatory = True),
        "module_name": attr.string(mandatory = True),
        "terminal": attr.bool(),
        "source_tree": attr.label(allow_single_file = True),
        "data": attr.label_list(allow_files = True),
        "out": attr.string(),
        "_runner": attr.label(default = "//tools/bazel/wasm:package_runner", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def _project_impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_directory(ctx.attr.out)
    ctx.actions.run(
        executable = runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, ctx.file.package_tree.path, output.path],
        inputs = [ctx.file.package_tree, ctx.file._runner, ctx.file._config],
        outputs = [output],
        mnemonic = "ProjectWasmPackage",
    )
    return [DefaultInfo(files = depset([output]), runfiles = ctx.runfiles(files = [output])), WasmPackageInfo(tree = output, inventory = ctx.attr.package_tree[WasmPackageInfo].inventory, producer = ctx.attr.package_tree[WasmPackageInfo].producer, original_wasm = ctx.attr.package_tree[WasmPackageInfo].original_wasm, generator_inputs = ctx.attr.package_tree[WasmPackageInfo].generator_inputs, generator_sources = ctx.attr.package_tree[WasmPackageInfo].generator_sources, generator_configurations = ctx.attr.package_tree[WasmPackageInfo].generator_configurations, crate_manifest = ctx.attr.package_tree[WasmPackageInfo].crate_manifest)]

project_wasm_package = rule(
    implementation = _project_impl,
    attrs = {
        "package_tree": attr.label(allow_single_file = True, mandatory = True, providers = [WasmPackageInfo]),
        "out": attr.string(mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/wasm:project.ts", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

WasmStaticProjectionInfo = provider(fields = {"manifest": "Exact generated source facts", "files": "Projected standalone source Files", "producer": "Configured original package producer", "destinations": "Logical source destinations keyed by File"})

def _static_projection_impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    manifest = ctx.actions.declare_file(ctx.label.name + ".sources.json")
    specification = ctx.actions.declare_file(ctx.label.name + ".projection.json")
    files = []
    descriptions = []
    destinations = {}
    for extension in [".js", ".d.ts", "_bg.wasm", "_bg.wasm.d.ts"]:
        member = ctx.attr.module + extension
        output = ctx.actions.declare_file(ctx.label.name + "/" + member)
        destination = ctx.attr.logical_directory + "/" + member
        files.append(output)
        destinations[output] = destination
        descriptions.append({"member": member, "output": output.path, "artifact": output.short_path, "destination": destination})
    ctx.actions.write(specification, json.encode({"producer": str(ctx.attr.package_tree.label), "projection": str(ctx.label), "packageProducer": str(ctx.attr.package_tree[WasmPackageInfo].producer), "files": descriptions}))
    ctx.actions.run(
        executable = runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, ctx.file.package_tree.path, specification.path, manifest.path, ctx.attr.package_tree[WasmPackageInfo].inventory.path],
        inputs = depset([ctx.file.package_tree, ctx.attr.package_tree[WasmPackageInfo].inventory, specification, ctx.file._runner, ctx.file._config], transitive = [bun_inputs([ctx.attr._runner_sources])]),
        outputs = files + [manifest],
        mnemonic = "ProjectWasmStaticSources",
    )
    return [
        DefaultInfo(files = depset(files), runfiles = ctx.runfiles(files = files + [manifest])),
        OutputGroupInfo(projection_manifest = depset([manifest]), static_sources = depset(files)),
        WasmStaticProjectionInfo(manifest = manifest, files = depset(files), producer = ctx.attr.package_tree.label, destinations = destinations),
    ]

wasm_static_projection = rule(
    implementation = _static_projection_impl,
    attrs = {
        "package_tree": attr.label(allow_single_file = True, mandatory = True, providers = [WasmPackageInfo]),
        "module": attr.string(mandatory = True),
        "logical_directory": attr.string(mandatory = True),
        "_runner": attr.label(default = "//tools/bazel/wasm:project-sources.ts", allow_single_file = True),
        "_runner_sources": attr.label(default = "//tools/bazel/wasm:input_tree_runner"),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)
