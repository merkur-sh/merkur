"""Attribute original selected WASM members in declared Bun and frontend outputs."""

load("//tools/bazel/bun:rules.bzl", "BunBuildInfo")
load("//tools/bazel/packaging:rust-compiled.bzl", "RustCompilerGraphInfo", "configured_rust_graph")
load("//tools/bazel/packaging:notices.bzl", "PackageSourceInfo", "SelectedAttributionInfo")
load("@rules_rust//rust:rust_common.bzl", "rust_common")

def _file(file):
    return {"input": file.path, "label": str(file.owner), "tree": file.is_directory}

def _selected_impl(ctx):
    compiler = ctx.attr.compiler[BunBuildInfo]
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    output = ctx.actions.declare_file(ctx.label.name + ".wasm-inputs.json")
    text = ctx.actions.declare_file(ctx.label.name + ".NOTICES.txt")
    packages = compiler.wasm_packages
    zero = len(packages) == 0
    if zero and (ctx.attr.rust_producers or ctx.attr.rust_attributions or ctx.attr.rust_packages or ctx.attr.generator_attributions):
        fail("Zero application WASM requires every original typed attribution mapping to be empty")
    package_files = [file for info in packages for file in [info.tree, info.inventory]]
    original_packages = {str(info.producer): info for info in packages}
    compiler_origins = {}
    original_inputs = []
    source_packages = {}
    for target, identity in ctx.attr.rust_packages.items():
        if identity in source_packages:
            fail("Duplicate original Rust source package identity")
        source = target[PackageSourceInfo]
        files = source.files.to_list()
        manifests = [file for file in files if file.owner == Label(source.manifest_label)]
        if len(manifests) != 1:
            fail("Original WASM dependency package lacks its original manifest File")
        source_packages[identity] = {"root": _file(source.root), "manifest": _file(manifests[0]),
                                      "files": [_file(file) for file in files],
                                      "authored": manifests[0].is_source and manifests[0].owner.repo_name == ctx.label.repo_name}
        original_inputs += [source.files]
        package_files.append(source.root)
    if not zero and not source_packages:
        fail("Selected WASM custody requires original typed Rust source/license inputs")
    for target, package_producer in ctx.attr.rust_producers.items():
        producer = str(Label(package_producer))
        if producer not in original_packages or producer in compiler_origins:
            fail("Original Rust producer mapping differs from actual WASM packages")
        info = original_packages[producer]
        crate = target[rust_common.crate_info]
        graph = target[RustCompilerGraphInfo]
        if crate.output != info.original_wasm or crate.type != "cdylib" or crate.is_test:
            fail("WASM package does not originate from this exact configured Rust cdylib File")
        if any([not file.is_source or file.is_directory for file in info.generator_sources.to_list()]):
            fail("Generator authored source attribution requires its exact original SourceFiles")
        compiler_origins[producer] = {"root": graph.root, "units": graph.units.to_list(),
                                      "artifact": _file(crate.output),
                                      "inputs": [_file(file) for file in graph.inputs.to_list()],
                                      "generator_inputs": [_file(file) for file in info.generator_inputs.to_list()],
                                      "generator_sources": [_file(file) for file in info.generator_sources.to_list()],
                                      "generator_configurations": [_file(file) for file in info.generator_configurations.to_list()],
                                      "crate_manifest": _file(info.crate_manifest)}
        original_inputs += [graph.inputs, info.generator_inputs, info.generator_configurations]
        package_files += [crate.output, info.crate_manifest]
    if sorted(compiler_origins.keys()) != sorted(original_packages.keys()):
        fail("Every declared WASM package requires its exact original Rust compiler producer")
    generator_attributions = []
    for target in ctx.attr.generator_attributions:
        attribution = target[SelectedAttributionInfo]
        artifacts = attribution.artifacts.to_list()
        if not artifacts or any([file.is_directory for file in artifacts]):
            fail("Executed generator attribution requires original ordinary artifact Files")
        files = [attribution.configuration, attribution.source_inventory,
                 attribution.inventory, attribution.notices]
        if any([file.is_directory for file in files]):
            fail("Generator attribution must preserve original ordinary output Files")
        generator_attributions.append({
            "scope": attribution.scope, "producer": attribution.producer,
            "artifacts": [{"input": file.path, "label": str(file.owner)} for file in artifacts],
            "configuration": {"input": attribution.configuration.path, "label": str(attribution.configuration.owner)},
            "source_inventory": {"input": attribution.source_inventory.path, "label": str(attribution.source_inventory.owner)},
            "inventory": {"input": attribution.inventory.path, "label": str(attribution.inventory.owner)},
            "notices": {"input": attribution.notices.path, "label": str(attribution.notices.owner)},
        })
        package_files += artifacts + files
    if not zero and not generator_attributions:
        fail("Executed WASM generators require their original complete source/license producers")
    rust_attributions = {}
    rust_attribution_inputs = {}
    for target, package_producer in ctx.attr.rust_attributions.items():
        producer = str(Label(package_producer))
        if producer not in original_packages or producer in rust_attributions:
            fail("WASM Rust attribution mapping differs from exact original package producers")
        attribution = target[SelectedAttributionInfo]
        artifacts = attribution.artifacts.to_list()
        info = original_packages[producer]
        if attribution.scope != "rust" or artifacts != [info.original_wasm] or attribution.producer != str(info.original_wasm.owner):
            fail("WASM attribution must select this exact original Rust compiled File")
        files = [attribution.configuration, attribution.source_inventory,
                 attribution.inventory, attribution.notices]
        if any([file.is_directory for file in files]):
            fail("WASM Rust attribution requires original ordinary output Files")
        groups = target[OutputGroupInfo]
        if not hasattr(groups, "source_inputs") or not groups.source_inputs.to_list():
            fail("WASM Rust attribution must retain its exact original compiled action input Files")
        original_inputs.append(groups.source_inputs)
        rust_attribution_inputs[producer] = [_file(file) for file in groups.source_inputs.to_list()]
        rust_attributions[producer] = {
            "scope": attribution.scope, "producer": attribution.producer,
            "artifacts": [{"input": file.path, "label": str(file.owner)} for file in artifacts],
            "configuration": {"input": attribution.configuration.path, "label": str(attribution.configuration.owner)},
            "source_inventory": {"input": attribution.source_inventory.path, "label": str(attribution.source_inventory.owner)},
            "inventory": {"input": attribution.inventory.path, "label": str(attribution.inventory.owner)},
            "notices": {"input": attribution.notices.path, "label": str(attribution.notices.owner)},
        }
        package_files += artifacts + files
    if sorted(rust_attributions.keys()) != sorted(original_packages.keys()):
        fail("Every original WASM package requires actual compiled Rust attribution")
    frontend_checker = None
    frontend_inputs = []
    action_tools = []
    if zero or Label(compiler.producer) == Label("//apps/web:frontend_precompressed"):
        frontend_checker = {"bun": _file(ctx.executable._bun), "runner": _file(ctx.file._frontend_checker), "config": _file(ctx.file._bun_config),
                            "modules": [_file(file) for file in ctx.files._frontend_modules]}
        frontend_inputs = [ctx.file._frontend_checker, ctx.file._bun_config] + ctx.files._frontend_modules
        action_tools = [ctx.attr._bun[DefaultInfo].files_to_run]
    ctx.actions.write(specification, json.encode({
        "producer": compiler.producer,
        "zero_source_inputs": [{"input": file.path, "label": str(file.owner), "tree": False,
                                "authored": file.is_source and file.owner.repo_name == ctx.label.repo_name}
                               for file in compiler.inputs.to_list() if not file.is_directory] if zero else None,
        "frontend_checker": frontend_checker,
        "artifact": {"input": compiler.artifact.path, "label": str(compiler.artifact.owner)},
        "configuration": compiler.configuration.path,
        "compiler_inventory": compiler.compiler_inventory.path,
        "declarations": compiler.declarations.path,
        "npm_source_inventory": compiler.npm_source_inventory.path,
        "npm_sources": [{"package": item.package, "version": item.version,
                         "input": item.source.path, "source_label": item.source_label,
                         "workspace": item.workspace} for item in compiler.npm_sources],
        "wasm_packages": [{"producer": str(info.producer),
                           "tree": {"input": info.tree.path, "label": str(info.tree.owner)},
                           "inventory": {"input": info.inventory.path, "label": str(info.inventory.owner)}}
                          for info in packages],
        "compiler_origins": compiler_origins,
        "generator_attributions": generator_attributions,
        "rust_attributions": rust_attributions,
        "rust_attribution_inputs": rust_attribution_inputs,
        "rust_packages": source_packages,
        "workspace_manifest": _file(ctx.file._workspace_manifest),
        "workspace_license": _file(ctx.file._workspace_license),
        "workspace_package": _file(ctx.file._workspace_package),
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, specification.path,
                     output.path, text.path, ctx.file._wasm_inputs.path],
        inputs = depset([specification, compiler.artifact, compiler.configuration,
                         compiler.compiler_inventory, compiler.declarations,
                         compiler.npm_source_inventory, ctx.file._runner,
                         ctx.file._wasm_inputs, ctx.file._workspace_manifest,
                         ctx.file._workspace_license, ctx.file._workspace_package] + package_files + ctx.files._modules + frontend_inputs,
                        transitive = [compiler.inputs] + original_inputs),
        tools = action_tools,
        outputs = [output, text],
        mnemonic = "SelectedWasmInputCustody",
        env = {},
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset([output, text])),
            OutputGroupInfo(selected_wasm_inputs = depset([output])),
            SelectedAttributionInfo(inventory = output, notices = text, scope = "wasm",
                                    producer = compiler.producer,
                                    artifacts = depset([compiler.artifact]),
                                    configuration = compiler.configuration,
                                    source_inventory = compiler.compiler_inventory)]

selected_wasm_input_custody = rule(
    implementation = _selected_impl,
    attrs = {
        "compiler": attr.label(providers = [BunBuildInfo], mandatory = True),
        "rust_producers": attr.label_keyed_string_dict(providers = [rust_common.crate_info],
                              aspects = [configured_rust_graph], mandatory = True),
        "rust_attributions": attr.label_keyed_string_dict(providers = [SelectedAttributionInfo, OutputGroupInfo], mandatory = True),
        "rust_packages": attr.label_keyed_string_dict(providers = [PackageSourceInfo], mandatory = True),
        "generator_attributions": attr.label_list(providers = [SelectedAttributionInfo], cfg = "exec", mandatory = True),
        "_frontend_checker": attr.label(default = "//tools/bazel/wasm:frontend-check.ts", allow_single_file = True),
        "_frontend_modules": attr.label_list(default = ["//tools/bazel/bun:npm-attribution.ts",
                             "//tools/bazel/bun:compiler-inventory.ts", "//tools/bazel/bun:owned-files.ts",
                             "//tools/bazel/bun:portable-path.ts"], allow_files = True),
        "_bun_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
        "_bun": attr.label(default = "//tools/bazel/tools/native:bun", executable = True, cfg = "exec"),
        "_workspace_package": attr.label(default = "//:package.json", allow_single_file = True),
        "_workspace_manifest": attr.label(default = "//:Cargo.toml", allow_single_file = True),
        "_workspace_license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/wasm:selected-attribution.py", allow_single_file = True),
        "_wasm_inputs": attr.label(default = "//tools/bazel/packaging:wasm-inputs.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:deployment-notices.py",
                     "//tools/bazel/packaging:npm-notices.py", "//tools/bazel/packaging:pack.py",
                     "//tools/bazel/packaging:license-inputs.py", "//tools/bazel/packaging:license-closure.py",
                     "//tools/bazel/packaging:rust-notices.py", "//tools/bazel/packaging:rust-license-metadata.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
