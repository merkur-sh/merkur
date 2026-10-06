"""Declared source-tree and attribution actions; no package resolver execution."""

load("//tools/bazel/bun:rules.bzl", "BunBuildInfo", "BunCompileInfo", "BunConfigurationInfo", "BunNpmAttributionInfo")
load("//tools/bazel/rust:rolldown.bzl", "RolldownNativeBindingInfo")

PackageSourceInfo = provider(fields = ["root", "source_label", "manifest_label", "files", "publisher_sources", "publisher_files", "source_patches", "patch_files"])
SelectedAttributionInfo = provider(fields = ["inventory", "notices", "scope", "producer", "artifacts", "configuration", "source_inventory"])
DeploymentNoticesInfo = provider(fields = ["inventory", "notices", "producers"])

_DEPLOYMENT_SCOPES = {"server": ["embedded-runtime", "first-party", "npm", "wasm"], "migrations": ["first-party", "npm"], "web": ["first-party", "npm", "wasm"]}

def _package_tree_impl(ctx):
    if ctx.attr.sources.label != Label(ctx.attr.source_label) or ctx.attr.manifest.label != Label(ctx.attr.manifest_label):
        fail("Package provider labels differ from their captured graph")
    manifest = ctx.file.manifest
    source_patches = {}
    patch_files = []
    for target, role in ctx.attr.source_patches.items():
        original = target[DefaultInfo].files.to_list()
        if role in source_patches or role not in ctx.attr.source_patch_labels or len(original) != 1:
            fail("Maintained patch inputs require unique original File roles")
        file = original[0]
        expected = Label(ctx.attr.source_patch_labels[role])
        if file.is_directory or not file.is_source or target.label != expected or file.owner != expected:
            fail("Maintained patch role differs from its exact original File")
        source_patches[role] = {"input": file.path, "label": ctx.attr.source_patch_labels[role]}
        patch_files.append(file)
    if sorted(source_patches) != sorted(ctx.attr.source_patch_labels):
        fail("Maintained patch File label inventory differs")
    if source_patches:
        if sorted(source_patches) != ["archive", "patch", "source", "vcs"]:
            fail("Maintained build.rs patch requires original archive, patch, source and VCS Files")
        if source_patches["source"]["input"] != manifest.dirname + "/build.rs" or source_patches["vcs"]["input"] != manifest.dirname + "/.cargo_vcs_info.json":
            fail("Maintained patch must belong to its selected package's build.rs")
        if Label(source_patches["patch"]["label"]).workspace_root:
            fail("Maintained patch must be an authored workspace File")
    publisher_sources = {}
    publisher_files = []
    for target, role in ctx.attr.publisher_sources.items():
        original = target[DefaultInfo].files.to_list()
        if role in publisher_sources or role not in ctx.attr.publisher_source_labels or len(original) != 1:
            fail("Publisher license inputs require unique original File roles")
        file = original[0]
        expected = Label(ctx.attr.publisher_source_labels[role])
        if file.is_directory or not file.is_source or target.label != expected or file.owner != expected:
            fail("Publisher license role differs from its exact original File")
        publisher_sources[role] = {"input": file.path, "label": ctx.attr.publisher_source_labels[role]}
        publisher_files.append(file)
    if sorted(publisher_sources) != sorted(ctx.attr.publisher_source_labels):
        fail("Publisher license File label inventory differs")
    if publisher_sources:
        required = ["archive", "catalog", "manifest", "vcs", "workspace_manifest"]
        if any([role not in publisher_sources for role in required]) or not any([role.startswith("license:") for role in publisher_sources]):
            fail("Publisher licenses require original archive, catalog, VCS, manifests and texts")
        if any([role not in required and not role.startswith("license:") for role in publisher_sources]):
            fail("Unknown original publisher license File role")
        publisher_sources["package_manifest"] = {"input": manifest.path, "label": ctx.attr.manifest_label}
        publisher_files.append(manifest)
    prefix = manifest.dirname + "/" if manifest.dirname else ""
    files = ctx.attr.sources[DefaultInfo].files.to_list()
    if source_patches and not any([file.path == source_patches["source"]["input"] for file in files]):
        fail("Maintained patched source is absent from its original package File inventory")
    entries = []
    for file in files:
        if file.is_directory or not file.path.startswith(prefix):
            fail("Package source must be exact declared regular files below its manifest")
        entries.append({"path": file.path[len(prefix):], "input": file.path})
    tree = ctx.actions.declare_directory(ctx.label.name)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"manifest": manifest.path, "files": entries}))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", ctx.file._copy.path, spec.path, tree.path],
        inputs = depset(files + [manifest, spec, ctx.file._copy, ctx.file._inputs, ctx.file._outputs]),
        outputs = [tree],
        mnemonic = "DeclaredLicenseSourceTree",
        progress_message = "Copy declared attribution inputs %{label}",
    )
    return [DefaultInfo(files = depset([tree])), PackageSourceInfo(root = tree, source_label = ctx.attr.source_label, manifest_label = ctx.attr.manifest_label, files = depset(files + [manifest]), publisher_sources = publisher_sources, publisher_files = depset(publisher_files), source_patches = source_patches, patch_files = depset(patch_files))]

declared_package_tree = rule(
    implementation = _package_tree_impl,
    attrs = {
        "sources": attr.label(mandatory = True),
        "manifest": attr.label(allow_single_file = True, mandatory = True),
        "source_label": attr.string(mandatory = True),
        "manifest_label": attr.string(mandatory = True),
        "publisher_sources": attr.label_keyed_string_dict(allow_files = True),
        "publisher_source_labels": attr.string_dict(),
        "source_patches": attr.label_keyed_string_dict(allow_files = True),
        "source_patch_labels": attr.string_dict(),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_copy": attr.label(default = "//tools/bazel/packaging:package-tree.py", allow_single_file = True),
        "_inputs": attr.label(default = "//tools/bazel/packaging:license-inputs.py", allow_single_file = True),
        "_outputs": attr.label(default = "//tools/bazel/packaging:output-tree.py", allow_single_file = True),
    },
)

def _rust_attribution_impl(ctx):
    packages = {}
    trees = []
    publisher_files = []
    for target, package_id in ctx.attr.packages.items():
        if package_id in packages:
            fail("Duplicate selected Rust package identity")
        source = target[PackageSourceInfo]
        packages[package_id] = {"root": source.root.path, "source_label": source.source_label, "manifest_label": source.manifest_label}
        if source.publisher_sources:
            packages[package_id]["publisher_sources"] = source.publisher_sources
        if source.source_patches:
            packages[package_id]["source_patches"] = source.source_patches
        publisher_files.append(source.publisher_files)
        publisher_files.append(source.patch_files)
        trees.append(source.root)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    inventory = ctx.actions.declare_file(ctx.label.name + ".attribution.json")
    notices = ctx.actions.declare_file(ctx.label.name + ".txt")
    ctx.actions.write(spec, json.encode({"descriptor": ctx.file.descriptor.path, "compiler_root": ctx.attr.compiler_root, "target": ctx.attr.target_triple, "packages": packages, "workspace_manifest": ctx.file._workspace_manifest.path, "workspace_license": ctx.file._workspace_license.path}))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", ctx.file._runner.path, spec.path, inventory.path, notices.path],
        inputs = depset(trees + [spec, ctx.file.descriptor, ctx.file._workspace_manifest, ctx.file._workspace_license, ctx.file._runner, ctx.file._inputs, ctx.file._metadata], transitive = publisher_files),
        outputs = [inventory, notices],
        mnemonic = "DeclaredRustAttribution",
        progress_message = "Validate selected Rust attribution %{label}",
    )
    # Generic native/WASM descriptors remain intermediates. A descriptor alone
    # cannot supply custody of a compiled shipping artifact or a shipping scope.
    return [DefaultInfo(files = depset([inventory, notices])), OutputGroupInfo(attribution = depset([inventory]), notices = depset([notices]))]

rust_attribution = rule(
    implementation = _rust_attribution_impl,
    attrs = {
        "descriptor": attr.label(allow_single_file = True, mandatory = True),
        "compiler_root": attr.string(mandatory = True),
        "target_triple": attr.string(mandatory = True),
        "packages": attr.label_keyed_string_dict(providers = [PackageSourceInfo], mandatory = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/packaging:rust-notices.py", allow_single_file = True),
        "_inputs": attr.label(default = "//tools/bazel/packaging:license-inputs.py", allow_single_file = True),
        "_metadata": attr.label(default = "//tools/bazel/packaging:rust-license-metadata.py", allow_single_file = True),
        "_workspace_manifest": attr.label(default = "//:Cargo.toml", allow_single_file = True),
        "_workspace_license": attr.label(default = "//:LICENSE", allow_single_file = True),
    },
)

def _npm_attribution_impl(ctx):
    provider = ctx.attr.producer[BunNpmAttributionInfo]
    compiler = provider.compiler
    sources = [{"input": item.source.path, "package": item.package, "version": item.version, "source_label": item.source_label, "workspace": item.workspace} for item in compiler.npm_sources]
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    inventory = ctx.actions.declare_file(ctx.label.name + ".attribution.json")
    notices = ctx.actions.declare_file(ctx.label.name + ".txt")
    ctx.actions.write(spec, json.encode({
        "producer": compiler.producer,
        "artifact": {"input": compiler.artifact.path, "label": str(compiler.artifact.owner)},
        "manifest": provider.manifest.path,
        "compiler_inventory": compiler.compiler_inventory.path,
        "declarations": compiler.declarations.path,
        "configuration": compiler.configuration.path,
        "npm_source_inventory": compiler.npm_source_inventory.path,
        "registry": ctx.file.registry.path,
        "sources": sources,
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", ctx.file._runner.path, spec.path, inventory.path, notices.path],
        inputs = depset([spec, compiler.artifact, provider.manifest, compiler.compiler_inventory, compiler.declarations, compiler.configuration, compiler.npm_source_inventory, ctx.file.registry, ctx.file._runner, ctx.file._closure, ctx.file._inputs, ctx.file._publisher, ctx.file._metadata] + ctx.files._artifact_modules, transitive = [provider.source_files, compiler.inputs]),
        outputs = [inventory, notices],
        mnemonic = "DeclaredNpmAttribution",
        progress_message = "Reconcile compiler-selected npm notices %{label}",
    )
    return [DefaultInfo(files = depset([inventory, notices])), OutputGroupInfo(attribution = depset([inventory]), notices = depset([notices])), SelectedAttributionInfo(inventory = inventory, notices = notices, scope = "npm", producer = compiler.producer, artifacts = depset([compiler.artifact]), configuration = compiler.configuration, source_inventory = compiler.compiler_inventory)]

npm_attribution = rule(
    implementation = _npm_attribution_impl,
    attrs = {
        "producer": attr.label(providers = [BunNpmAttributionInfo], mandatory = True),
        "registry": attr.label(default = "//tools/bazel/bun:npm-inventory.json", allow_single_file = True),
        "_artifact_modules": attr.label_list(default = ["//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:pack.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//tools/bazel/packaging:npm-notices.py", allow_single_file = True),
        "_closure": attr.label(default = "//tools/bazel/packaging:license-closure.py", allow_single_file = True),
        "_inputs": attr.label(default = "//tools/bazel/packaging:license-inputs.py", allow_single_file = True),
        "_publisher": attr.label(default = "//tools/bazel/packaging:rust-notices.py", allow_single_file = True),
        "_metadata": attr.label(default = "//tools/bazel/packaging:rust-license-metadata.py", allow_single_file = True),
    },
)

def _compiler_tooling(ctx):
    bindings = {}
    native_bindings = {}
    used = {}
    for target in ctx.attr.compiler_tooling_bindings:
        binding = target[RolldownNativeBindingInfo]
        if binding.native in native_bindings or binding.native.is_directory or binding.native.is_symlink:
            fail("Compiler tooling requires unique original native package bindings")
        native_bindings[binding.native] = True
        for manifest in binding.source_manifests.to_list():
            label = manifest.owner
            if label in bindings:
                fail("Compiler tooling source manifest has ambiguous original native bindings")
            bindings[label] = (binding, manifest)
    records = []
    files = []
    closures = []
    for target in ctx.attr.compiler_tooling_packages:
        source = target[PackageSourceInfo]
        label = Label(source.manifest_label)
        original = bindings.pop(label, None)
        if original == None or not label.workspace_root:
            fail("Compiler tooling package has no matching original native source binding")
        binding, source_manifest = original
        used[binding.native] = True
        prefix = source_manifest.dirname + "/"
        members = []
        for file in source.files.to_list():
            if file.is_directory or not file.is_source or file.is_symlink or not file.path.startswith(prefix) or file.owner.repo_name != label.repo_name:
                fail("Compiler tooling requires original upstream package SourceFiles")
            members.append({"path": file.path[len(prefix):], "input": file.path, "label": str(file.owner)})
        if source_manifest not in source.files.to_list():
            fail("Compiler tooling package lacks the native compiler's identical original manifest File")
        records.append({
            "root": source.root.path,
            "source_label": str(Label(source.source_label)),
            "manifest_label": str(label),
            "files": members,
            "workspace_manifest": {"input": binding.workspace_manifest.path, "label": str(binding.workspace_manifest.owner)},
            "workspace_license": {"input": binding.workspace_license.path, "label": str(binding.workspace_license.owner)},
            "native": {"input": binding.native.path, "label": str(binding.native.owner)},
        })
        files += [source.root, binding.native, source_manifest, binding.workspace_manifest, binding.workspace_license]
        closures += [source.files, binding.inputs]
    if len(used) != len(native_bindings):
        fail("Compiler tooling native binding has no original package source inventory")
    return records, files, closures

def _first_party_attribution_impl(ctx):
    compiler = ctx.attr.producer[BunBuildInfo]
    compiler_tooling, tooling_files, tooling_closures = _compiler_tooling(ctx)
    artifact = compiler.artifact
    packages = []
    package_files = []
    trees = []
    for target in ctx.attr.packages:
        source = target[PackageSourceInfo]
        package = Label(source.manifest_label).package
        prefix = package + "/" if package else ""
        members = []
        for file in source.files.to_list():
            if file.is_directory or not file.is_source or not file.short_path.startswith(prefix):
                fail("First-party package requires exact authored source Files")
            members.append({"path": file.short_path[len(prefix):], "input": file.path, "label": str(file.owner)})
        packages.append({"root": source.root.path, "source_label": source.source_label, "manifest_label": source.manifest_label, "files": members})
        package_files.append(source.files)
        trees.append(source.root)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    inventory = ctx.actions.declare_file(ctx.label.name + ".attribution.json")
    notices = ctx.actions.declare_file(ctx.label.name + ".txt")
    ctx.actions.write(spec, json.encode({
        "producer": compiler.producer,
        "artifact": {"input": artifact.path, "label": str(artifact.owner)},
        "configuration": compiler.configuration.path,
        "compiler_inventory": compiler.compiler_inventory.path,
        "declarations": compiler.declarations.path,
        "npm_source_inventory": compiler.npm_source_inventory.path,
        "npm_sources": [{"input": item.source.path, "package": item.package, "version": item.version, "source_label": item.source_label, "workspace": item.workspace} for item in compiler.npm_sources],
        "wasm_packages": [{"producer": str(item.producer), "tree": {"input": item.tree.path, "label": str(item.tree.owner)}, "inventory": {"input": item.inventory.path, "label": str(item.inventory.owner)}} for item in compiler.wasm_packages],
        "packages": packages,
        "compiler_tooling": compiler_tooling,
        "workspace_manifest": {"input": ctx.file._workspace_manifest.path, "label": str(ctx.file._workspace_manifest.owner)},
        "workspace_license": {"input": ctx.file._workspace_license.path, "label": str(ctx.file._workspace_license.owner)},
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", ctx.file._runner.path, spec.path, inventory.path, notices.path],
        inputs = depset([spec, artifact, compiler.configuration, compiler.compiler_inventory, compiler.declarations, compiler.npm_source_inventory, ctx.file._workspace_manifest, ctx.file._workspace_license, ctx.file._runner] + trees + tooling_files + ctx.files._modules + [file for item in compiler.wasm_packages for file in [item.tree, item.inventory]], transitive = [compiler.inputs] + package_files + tooling_closures),
        outputs = [inventory, notices],
        mnemonic = "SelectedFirstPartyAttribution",
    )
    return [DefaultInfo(files = depset([inventory, notices])),
            OutputGroupInfo(attribution = depset([inventory]), notices = depset([notices])),
            SelectedAttributionInfo(inventory = inventory, notices = notices, scope = "first-party", producer = compiler.producer, artifacts = depset([artifact]), configuration = compiler.configuration, source_inventory = compiler.compiler_inventory)]

first_party_attribution = rule(
    implementation = _first_party_attribution_impl,
    attrs = {
        "producer": attr.label(providers = [BunBuildInfo], mandatory = True),
        "packages": attr.label_list(providers = [PackageSourceInfo], mandatory = True),
        "compiler_tooling_packages": attr.label_list(providers = [PackageSourceInfo], cfg = "exec"),
        "compiler_tooling_bindings": attr.label_list(providers = [RolldownNativeBindingInfo], cfg = "exec"),
        "_workspace_manifest": attr.label(default = "//:package.json", allow_single_file = True),
        "_workspace_license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "_runner": attr.label(default = "//tools/bazel/packaging:first-party-notices.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:wasm-inputs.py", "//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:npm-notices.py", "//tools/bazel/packaging:license-closure.py", "//tools/bazel/packaging:license-inputs.py", "//tools/bazel/packaging:rust-notices.py", "//tools/bazel/packaging:rust-license-metadata.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    },
)

def _deployment_notices_impl(ctx):
    producers = {}
    for role, target in {"server": ctx.attr._server, "migrations": ctx.attr._migrations, "web": ctx.attr._frontend}.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory != (role != "server"):
            fail("Deployment notice authority requires one exact producer output: " + role)
        producers[role] = files[0]
    server = ctx.attr._server[BunCompileInfo]
    if producers["server"] != server.executable:
        fail("Deployment notices require the original typed server compiler output")
    selected = {}
    attributions = []
    files = [server.configuration]
    for target in ctx.attr.attributions:
        source = target[SelectedAttributionInfo]
        artifacts = source.artifacts.to_list()
        roles = [role for role, artifact in producers.items() if artifacts == [artifact]]
        if len(roles) != 1:
            fail("Selected notice provider has no exact deployment artifact custody: " + str(target.label))
        role = roles[0]
        pair = role + "/" + source.scope
        if source.scope not in _DEPLOYMENT_SCOPES[role] or pair in selected:
            fail("Duplicate or unsupported deployment notice scope: " + pair)
        owner = producers[role].owner
        if source.producer != str(owner) or (role == "server" and source.configuration != server.configuration):
            fail("Notice provider differs from its original configured producer: " + pair)
        selected[pair] = True
        attributions.append({
            "scope": source.scope,
            "producer": source.producer,
            "artifact": {"input": producers[role].path, "label": str(owner)},
            "configuration": {"input": source.configuration.path, "label": str(source.configuration.owner)},
            "source_inventory": {"input": source.source_inventory.path, "label": str(source.source_inventory.owner)},
            "inventory": {"input": source.inventory.path, "label": str(source.inventory.owner)},
            "notices": {"input": source.notices.path, "label": str(source.notices.owner)},
        })
        files += [source.configuration, source.source_inventory, source.inventory, source.notices]
    required = [role + "/" + scope for role, scopes in _DEPLOYMENT_SCOPES.items() for scope in scopes]
    missing = sorted([pair for pair in required if pair not in selected])
    if missing:
        fail("Deployment attribution lacks selected providers: " + ", ".join(missing))
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    inventory = ctx.actions.declare_file(ctx.label.name + "/deployment.notices.json")
    notices = ctx.actions.declare_file(ctx.label.name + "/NOTICES.txt")
    ctx.actions.write(spec, json.encode({
        "server": {"input": producers["server"].path, "label": str(producers["server"].owner)},
        "server_context": {"input": server.configuration.path, "label": str(producers["server"].owner)},
        "migrations": {"input": producers["migrations"].path, "label": str(producers["migrations"].owner)},
        "web": {"input": producers["web"].path, "label": str(producers["web"].owner)},
        "build_id": ctx.attr._frontend_id[BunConfigurationInfo].value,
        "attributions": attributions,
    }))
    ctx.actions.run(
        executable = ctx.attr._python[DefaultInfo].files_to_run,
        arguments = ["-I", ctx.file._runner.path, spec.path, inventory.path, notices.path],
        inputs = depset([spec] + producers.values() + files + ctx.files._modules + [ctx.file._runner]),
        outputs = [inventory, notices],
        mnemonic = "DeploymentNotices",
        env = {"PYTHONHASHSEED": "0"},
    )
    return [DefaultInfo(files = depset([inventory, notices])),
            OutputGroupInfo(attribution = depset([inventory]), notices = depset([notices])),
            DeploymentNoticesInfo(inventory = inventory, notices = notices, producers = producers)]

deployment_notices = rule(
    implementation = _deployment_notices_impl,
    attrs = {
        "attributions": attr.label_list(providers = [SelectedAttributionInfo], mandatory = True),
        "_server": attr.label(default = "//apps/server:server", providers = [BunCompileInfo]),
        "_migrations": attr.label(default = "//apps/server:migrations"),
        "_frontend": attr.label(default = "//apps/web:frontend_precompressed"),
        "_frontend_id": attr.label(default = "//tools/bazel/bun:frontend_build_id", providers = [BunConfigurationInfo]),
        "_runner": attr.label(default = "//tools/bazel/packaging:deployment-notices.py", allow_single_file = True),
        "_modules": attr.label_list(default = ["//tools/bazel/packaging:deployment-pack.py", "//tools/bazel/packaging:pack.py", "//tools/bazel/packaging:license-closure.py", "//tools/bazel/packaging:license-inputs.py"], allow_files = True),
        "_python": attr.label(default = "//tools/bazel/tools:python3", executable = True, cfg = "exec"),
    },
)
