"""Bind the real Rust compiler graph and release output to selected notices."""

load(":notices.bzl", "PackageSourceInfo", "SelectedAttributionInfo")
load(":rust-link-map.bzl", "RustLinkMapInfo")
load("@rules_rust//rust:rust_common.bzl", "BuildInfo", "TestCrateInfo", "rust_common")

_CompilerGraphInfo = provider(fields = ["root", "units", "inputs"])
RustCompilerGraphInfo = _CompilerGraphInfo

def _unit_id(label, rule_kind):
    name = label.name
    # _unit_declarations places the original cdylib in its unit-ID package,
    # since rules_rust emits an unmangled output filename for each cdylib.
    if name == "cdylib":
        prefix = "tools/bazel/rust/units/"
        if rule_kind != "rust_cdylib_library" or label.repo_name != Label("//tools/bazel/rust/units:BUILD.bazel").repo_name or not label.package.startswith(prefix):
            fail("Selected Rust attribution requires its original configured cdylib compiler unit: " + str(label))
        identity = label.package[len(prefix):]
        if len(identity) != 64 or any([character not in "0123456789abcdef" for character in identity.elems()]):
            fail("Selected Rust attribution requires a maintained configured compiler unit: " + str(label))
        return identity
    if not name.startswith("u_") or len(name) != 66 or any([character not in "0123456789abcdef" for character in name[2:].elems()]):
        fail("Selected Rust attribution requires a maintained configured compiler unit: " + str(label))
    return name[2:]

def _compiler_graph_impl(target, ctx):
    if ctx.rule.kind == "wasm_artifact":
        children = ctx.rule.attr.target
        if type(children) != "list" or len(children) != 1:
            fail("WASM compiler facade requires its exact single transitioned child")
        original = children[0]
        if _CompilerGraphInfo not in original or rust_common.crate_info not in target or RustLinkMapInfo not in target:
            fail("WASM compiler facade omits original configured compiler providers")
        if TestCrateInfo not in original:
            fail("WASM compiler facade lacks its actual cdylib TestCrateInfo")
        crate = original[TestCrateInfo].crate
        if target[rust_common.crate_info] != crate or target[RustLinkMapInfo] != original[RustLinkMapInfo] or target[DefaultInfo].files != original[DefaultInfo].files:
            fail("WASM compiler facade differs from its original transitioned output")
        return [original[_CompilerGraphInfo]]
    # This is an ordinary File projection, not an additional Cargo compiler unit.
    # Preserve the child's actual run-custom-build identity and graph verbatim.
    if ctx.rule.kind == "build_script_metadata":
        child = ctx.rule.attr.build_script
        if BuildInfo not in child or _CompilerGraphInfo not in child:
            fail("Linked build-script projection lacks its actual BuildInfo/compiler graph")
        build = child[BuildInfo]
        if target[DefaultInfo].files.to_list() != [build.dep_env]:
            fail("Linked build-script projection differs from its actual metadata File")
        required = depset([build.out_dir], transitive = [build.compile_data]).to_list()
        retained = target[DefaultInfo].default_runfiles.files.to_list()
        if any([file not in retained for file in required]):
            fail("Linked build-script projection omits its actual declared output Files")
        return [child[_CompilerGraphInfo]]
    units = []
    inputs = []
    dependencies = []
    aliases = {}
    declared_aliases = {}
    for attribute in ["aliases", "proc_macro_aliases"]:
        for dependency, name in getattr(ctx.rule.attr, attribute, {}).items():
            declared_aliases[str(dependency.label)] = name
    for attribute in ["deps", "proc_macro_deps", "script", "link_deps", "build_script_env_files"]:
        value = getattr(ctx.rule.attr, attribute, [])
        children = value if type(value) == "list" else [value] if value else []
        for child in children:
            if _CompilerGraphInfo not in child:
                # Ordinary environment Files carry inputs, not a Cargo unit edge.
                if attribute == "build_script_env_files":
                    continue
                fail("Compiler dependency does not expose its configured Rust graph")
            graph = child[_CompilerGraphInfo]
            dependencies.append(graph.root)
            units.append(graph.units)
            inputs.append(graph.inputs)
            alias = declared_aliases.get(str(child.label))
            if alias != None:
                aliases[graph.root] = alias
    record = {
        "unit": _unit_id(ctx.label, ctx.rule.kind),
        "rule": ctx.rule.kind,
        "dependencies": sorted(dependencies),
        "aliases": aliases,
        "features": sorted(getattr(ctx.rule.attr, "crate_features", [])),
        "rustc_flags": list(getattr(ctx.rule.attr, "rustc_flags", [])),
        "version": getattr(ctx.rule.attr, "version", ""),
        "lint_config": str(ctx.rule.attr.lint_config.label) if getattr(ctx.rule.attr, "lint_config", None) else None,
    }
    files = []
    if rust_common.crate_info in target or TestCrateInfo in target:
        crate = target[rust_common.crate_info] if rust_common.crate_info in target else target[TestCrateInfo].crate
        if crate.owner != ctx.label or crate.is_test:
            fail("Selected Rust source graph requires the original non-test compiler producer")
        record.update({"crate_name": crate.name, "crate_type": crate.type, "edition": crate.edition,
                       "root": crate.root.path, "environment": dict(getattr(ctx.rule.attr, "rustc_env", {}))})
        files = crate.srcs.to_list() + crate.compile_data.to_list() + crate.rustc_env_files
        if crate.type == "proc-macro":
            record["artifact"] = {"input": crate.output.path, "label": str(crate.output.owner)}
            files.append(crate.output)
    elif ctx.rule.kind == "cargo_build_script":
        record.update({"package_name": ctx.rule.attr.pkg_name,
                       "environment": dict(ctx.rule.attr.build_script_env),
                       "rundir": ctx.rule.attr.rundir})
        files = list(ctx.rule.files.data) + list(ctx.rule.files.build_script_env_files)
    else:
        fail("Unsupported rule in the configured Rust compiler graph: " + ctx.rule.kind)
    if BuildInfo in target:
        build = target[BuildInfo]
        files += build.compile_data.to_list()
        for name in ["dep_env", "flags", "link_search_paths", "linker_flags", "out_dir", "rustc_env"]:
            file = getattr(build, name)
            if file:
                files.append(file)
    record["inputs"] = [{"input": file.path, "label": str(file.owner), "tree": file.is_directory} for file in files]
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    record["compiler"] = {"version": toolchain.version, "target": toolchain.target_triple.str}
    files += toolchain.rust_std.to_list()
    if RustLinkMapInfo in target:
        linked = target[RustLinkMapInfo]
        if linked.artifact != crate.output:
            fail("Original linker map differs from its configured compiler output")
        files.append(linked.link_map)
    record["stdlib"] = [{"input": file.path, "label": str(file.owner)} for file in toolchain.rust_std.to_list()]
    return [_CompilerGraphInfo(root = record["unit"], units = depset([json.encode(record)], transitive = units),
                              inputs = depset(files, transitive = inputs))]

configured_rust_graph = aspect(implementation = _compiler_graph_impl,
                         attr_aspects = ["deps", "proc_macro_deps", "script", "link_deps", "build_script_env_files", "build_script", "target"],
                         toolchains = ["@rules_rust//rust:toolchain_type"])

def _compiled_attribution_impl(ctx):
    graph = ctx.attr.producer[_CompilerGraphInfo]
    crate = ctx.attr.producer[rust_common.crate_info] if rust_common.crate_info in ctx.attr.producer else ctx.attr.producer[TestCrateInfo].crate
    wasm = ctx.attr.target_triple == "wasm32-unknown-unknown"
    if crate.type not in (["cdylib"] if wasm else ["bin", "proc-macro"]) or _unit_id(crate.owner, "rust_cdylib_library" if wasm else "") != graph.root:
        fail("Rust attribution requires the exact maintained release compiler producer")
    artifact = crate.output
    linked = ctx.attr.producer[RustLinkMapInfo]
    if linked.artifact != artifact or linked.target != ctx.attr.target_triple:
        fail("Attribution requires its original compiler action's target and linker output")
    outputs = ctx.attr.attribution[OutputGroupInfo]
    inventories = outputs.attribution.to_list()
    notices = outputs.notices.to_list()
    if len(inventories) != 1 or len(notices) != 1:
        fail("Rust attribution requires exactly one original dependency notice inventory")
    standard = ctx.attr.stdlib_notices[OutputGroupInfo]
    standard_native_inputs = standard.native_inputs
    standard_inventories = standard.inventory.to_list()
    standard_notices = standard.source_notices.to_list()
    if len(standard_inventories) != 1 or len(standard_notices) != 1 or standard_inventories[0].is_directory or not standard_notices[0].is_directory:
        fail("Compiled stdlib attribution requires one original inventory File and source notice Tree")
    standard_inventory = standard_inventories[0]
    standard_notice_tree = standard_notices[0]
    proc_macro_notices = []
    proc_macro_inputs = []
    for target in ctx.attr.proc_macro_notices:
        selected = target[SelectedAttributionInfo]
        artifacts = selected.artifacts.to_list()
        if selected.scope != "rust" or len(artifacts) != 1 or artifacts[0].is_directory:
            fail("Host proc-macro attribution requires its original compiled artifact File")
        files = [selected.configuration, selected.source_inventory, selected.inventory, selected.notices]
        if any([file.is_directory for file in files]):
            fail("Host proc-macro attribution requires original ordinary notice output Files")
        proc_macro_notices.append({
            "producer": selected.producer,
            "artifact": {"input": artifacts[0].path, "label": str(artifacts[0].owner)},
            "configuration": {"input": selected.configuration.path, "label": str(selected.configuration.owner)},
            "source_inventory": {"input": selected.source_inventory.path, "label": str(selected.source_inventory.owner)},
            "inventory": {"input": selected.inventory.path, "label": str(selected.inventory.owner)},
            "notices": {"input": selected.notices.path, "label": str(selected.notices.owner)},
        })
        proc_macro_inputs.append(depset(artifacts + files, transitive = [target[OutputGroupInfo].source_inputs]))
    if not wasm and proc_macro_notices:
        fail("Separate host proc-macro attribution is an original WASM compiler obligation")
    packages = {}
    source_files = []
    for target, identity in ctx.attr.packages.items():
        if identity in packages:
            fail("Duplicate selected Cargo package source")
        source = target[PackageSourceInfo]
        members = source.files.to_list()
        manifests = [file for file in members if file.owner == Label(source.manifest_label)]
        if len(manifests) != 1:
            fail("Selected Rust source lacks its original manifest File")
        packages[identity] = {"source_label": source.source_label, "manifest_label": source.manifest_label,
                              "root": source.root.path, "manifest": manifests[0].path, "files": [{"input": file.path, "label": str(file.owner)} for file in members]}
        if source.publisher_sources:
            packages[identity]["publisher_sources"] = source.publisher_sources
        if source.source_patches:
            packages[identity]["source_patches"] = source.source_patches
        source_files.append(depset([source.root], transitive = [source.files, source.publisher_files, source.patch_files]))
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    configuration = ctx.actions.declare_file(ctx.label.name + ".configuration.json")
    sources = ctx.actions.declare_file(ctx.label.name + ".sources.json")
    inventory = ctx.actions.declare_file(ctx.label.name + ".attribution.json")
    text = ctx.actions.declare_file(ctx.label.name + ".txt")
    specification = {
        "producer": str(artifact.owner), "artifact": {"input": artifact.path, "label": str(artifact.owner)},
        "descriptor": ctx.file.descriptor.path, "intermediate": inventories[0].path,
        "compiler_root": graph.root, "target": ctx.attr.target_triple,
        "units": graph.units.to_list(), "packages": packages,
        "stdlib_notices": {"input": standard_inventory.path, "label": str(standard_inventory.owner),
                           "notices": {"input": standard_notice_tree.path, "label": str(standard_notice_tree.owner)}},
        "workspace_manifest": ctx.file._workspace_manifest.path, "workspace_license": ctx.file._workspace_license.path,
    }
    if wasm:
        specification["proc_macro_notices"] = proc_macro_notices
    ctx.actions.write(spec, json.encode(specification))
    declared_inputs = depset([spec, artifact, ctx.file.descriptor, inventories[0], standard_inventory, standard_notice_tree, ctx.file._workspace_manifest, ctx.file._workspace_license, ctx.file._runner] + ctx.files._modules,
                             transitive = [graph.inputs, standard_native_inputs] + source_files + proc_macro_inputs)
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-B", "-I", ctx.file._runner.path, "--compiled", spec.path,
                     configuration.path, sources.path, inventory.path, text.path],
        inputs = declared_inputs,
        outputs = [configuration, sources, inventory, text],
        mnemonic = "SelectedWasmRustAttribution" if wasm else "SelectedNativeRustAttribution",
        env = {},
        use_default_shell_env = False,
    )
    return [DefaultInfo(files = depset([inventory, text])),
            OutputGroupInfo(attribution = depset([inventory]), notices = depset([text]), source_inputs = declared_inputs),
            SelectedAttributionInfo(inventory = inventory, notices = text, scope = "rust",
                                    producer = str(artifact.owner), artifacts = depset([artifact]),
                                    configuration = configuration, source_inventory = sources)]

compiled_rust_attribution = rule(
    implementation = _compiled_attribution_impl,
    attrs = {
        "producer": attr.label(mandatory = True, aspects = [configured_rust_graph], providers = [RustLinkMapInfo]),
        "descriptor": attr.label(allow_single_file = True, mandatory = True),
        "attribution": attr.label(mandatory = True),
        "target_triple": attr.string(mandatory = True),
        "packages": attr.label_keyed_string_dict(providers = [PackageSourceInfo], mandatory = True),
        "stdlib_notices": attr.label(providers = [OutputGroupInfo], mandatory = True),
        "proc_macro_notices": attr.label_list(providers = [SelectedAttributionInfo, OutputGroupInfo], cfg = "exec"),
        "_workspace_manifest": attr.label(default = "//:Cargo.toml", allow_single_file = True),
        "_workspace_license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/packaging:rust-license-metadata.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:rust-notices.py", "//tools/bazel/packaging:license-inputs.py", "//tools/bazel/packaging:license-closure.py", "//tools/bazel/rust:units.py", "//tools/bazel/rust:configured_parity.py", "//tools/bazel/rust:license_metadata.py", "//tools/bazel/rust:native_receipts.py", "//tools/bazel/rust:stdlib_attribution.py", "//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:pack.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
