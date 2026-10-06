"""Bun execution with explicitly declared sources, npm closure and pinned runtime."""

load("@aspect_rules_js//js:providers.bzl", "JsInfo")
load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo", "NpmPackageStoreInfo")
load("@aspect_rules_js//npm/private:utils.bzl", "utils")
load("@tar.bzl//tar:tar.bzl", "tar_lib")
load("//tools/bazel/tools/native:providers.bzl", "NativeSdkInfo")
load("//tools/bazel/wasm:providers.bzl", "WasmPackageInfo")
load("//tools/bazel/bun:source-providers.bzl", "ViteSourceBuildInfo")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")

BunInfo = provider(fields = {"runtime": "Pinned executable File."})
BunConfigurationInfo = provider(fields = {"value": "Declared scalar configuration value."})

BunBuildInfo = provider(fields = {
    "artifact": "The actual compiler output File or TreeArtifact.",
    "producer": "Configured producer label spelling.",
    "configuration": "Original producer settings and flags File.",
    "declarations": "Original declared logical-to-physical input manifest File.",
    "compiler_inventory": "Actual compiler-selected source and output facts File.",
    "inputs": "Original declared compiler input depset.",
    "npm_sources": "Typed rules_js package/version/original package tree File/owner descriptors.",
    "npm_source_inventory": "All typed npm source descriptors File.",
    "wasm_packages": "Actual reachable configured WASM package tree/inventory/original producer identities.",
})

BunCompileInfo = provider(fields = {
    "executable": "The actual standalone compiler output File.",
    "runtime": "The exact pinned Bun executable embedded by the standalone compiler.",
    "compile_target": "The explicit standalone compiler target.",
    "compiler_inventory": "Actual compiler-selected source facts File.",
    "declarations": "The original declared logical-to-physical input manifest File.",
    "configuration": "Exact public compile settings, flags, target and runtime identity File.",
    "npm_sources": "Typed rules_js package/version/original package tree File/owner descriptors.",
    "npm_source_inventory": "All typed npm source descriptors File.",
    "wasm_packages": "Actual reachable configured WASM package tree/inventory/original producer identities.",
    "inputs": "Complete original action input depset for downstream declared attribution.",
    "producer": "Configured producer label spelling.",
})



BunNpmSourcesInfo = provider(fields = {
    "stores": "All typed npm stores reachable through actual dependency edges.",
    "original_sources": "Actual direct srcs/types SourceFiles from reachable js_library rules.",
    "copied_sources": "Actual JsInfo source/type Files copied by those same js_library rules.",
    "materialization_links": "Pinned npm rules' actual alias File to package File/authored namespace relationships.",
    "package_extractions": "Original tar extraction File, tool and arguments for actual configured package directories.",
    "workspace_packages": "Actual pinned authored npm_package source Files and their configured store copies.",
    "wasm_packages": "Actual configured WASM package identities reachable through the same dependency graph.",
})

_NPM_GRAPH_ATTRIBUTES = ["deps", "data", "src", "srcs", "types", "entry_point", "entry_points", "actual"]

def _files_by_short_path(files):
    result = {}
    for file in files:
        previous = result.get(file.short_path)
        if previous != None and previous != file:
            fail("Ambiguous File identity in js_library source namespace")
        result[file.short_path] = file
    return result

def _js_library_source_files(target, ctx):
    if ctx.rule == None or ctx.rule.kind != "js_library" or JsInfo not in target:
        return [], []
    info = target[JsInfo]
    if info.target != ctx.label:
        fail("js_library source provider belongs to a different configured target")
    originals = _files_by_short_path([file for file in ctx.rule.files.srcs + ctx.rule.files.types if file.is_source])
    copies = _files_by_short_path([file for file in depset(transitive = [info.sources, info.types]).to_list() if not file.is_source and file.owner == ctx.label])
    # Pinned rules_js calls copy_file_to_bin_action on these direct SourceFiles:
    # declare_file(file.basename, sibling = file), in the owning rule's bin root.
    for logical, original in originals.items():
        copied = copies.get(logical)
        if original.owner.repo_name != ctx.label.repo_name or original.owner.package != ctx.label.package or copied == None or copied.root.path != ctx.bin_dir.path:
            fail("js_library original/copy File identity violates its pinned source contract")
    if len(copies) != len(originals):
        fail("js_library copied source inventory differs from its direct original SourceFiles")
    return originals.values(), copies.values()

def _npm_alias_link(files, prefix, key, alias, source):
    logical = prefix + utils.package_store_name(key) + "/node_modules/" + alias
    file = files.get(logical)
    if file == None or source == None:
        fail("Pinned npm_package_store dependency alias has no declared target File")
    return struct(alias = file, source = source, namespace = None)

def _repository_short_path(label, path):
    return "../" + label.repo_name + "/" + path if label.repo_name else path


def _npm_materialization_links(target, ctx):
    if ctx.rule == None or ctx.rule.kind == "alias":
        return []
    links = []
    files = {}
    if ctx.rule.kind == "npm_link_package_store":
        source = ctx.rule.attr.src[NpmPackageStoreInfo]
        package = ctx.rule.attr.package or source.package
        logical = _repository_short_path(ctx.label, (ctx.label.package + "/" if ctx.label.package else "") + "node_modules/" + package)
        for file in target[DefaultInfo].files.to_list():
            if file.owner == ctx.label and file.short_path == logical:
                links.append(struct(alias = file, source = source.package_store_directory, namespace = None))
        if len(links) != 1:
            fail("Pinned npm_link_package_store alias File is missing or ambiguous")
        return links
    if NpmPackageStoreInfo not in target:
        return links
    info = target[NpmPackageStoreInfo]
    for file in info.files.to_list():
        if file.owner == ctx.label:
            files[file.short_path] = file
    prefix = _repository_short_path(ctx.label, (ctx.label.package + "/" if ctx.label.package else "") + "node_modules/" + utils.package_store_root + "/")
    if ctx.rule.attr.src:
        linked = {}
        for dependency, names in ctx.rule.attr.deps.items():
            source = dependency[NpmPackageStoreInfo]
            if source.package_store_directory != None:
                linked[source.package_store_directory] = True
                for alias in names.split(",") if names else [source.package]:
                    links.append(_npm_alias_link(files, prefix, info.key, alias, source.package_store_directory))
        if NpmPackageInfo in ctx.rule.attr.src:
            for source in ctx.rule.attr.src[NpmPackageInfo].npm_package_store_infos.to_list():
                if source.package_store_directory not in linked:
                    links.append(_npm_alias_link(files, prefix, info.key, source.package, source.package_store_directory))
        elif JsInfo in ctx.rule.attr.src:
            source = ctx.rule.attr.src[JsInfo]
            links.append(struct(alias = info.package_store_directory, source = None, namespace = _repository_short_path(source.target, source.target.package)))
        else:
            fail("Pinned npm_package_store source lacks its original typed package provider")
    else:
        sources = [dependency[NpmPackageStoreInfo] for dependency in ctx.rule.attr.deps]
        resolved = {source.key: source for source in sources if source.package_store_directory != None}
        for source in sources:
            for dependency, aliases in source.ref_deps.items():
                target_info = resolved.get(dependency[NpmPackageStoreInfo].key)
                # The pinned rule emits no alias for an unresolved lifecycle
                # self-reference. The complete actual File check below still
                # refuses any emitted alias without a typed target.
                if target_info == None:
                    continue
                for alias in aliases:
                    links.append(_npm_alias_link(files, prefix, source.key, alias, target_info.package_store_directory))
    covered = {link.alias: True for link in links}
    for file in files.values():
        if file != info.package_store_directory and not file.is_directory and file not in covered:
            fail("Unmodelled npm_package_store alias File in declared compilation closure")
    return links

def _npm_package_extractions(target, ctx):
    if ctx.rule == None or ctx.rule.kind not in ["npm_package_store", "npm_package_store_internal"] or NpmPackageStoreInfo not in target or not ctx.rule.attr.src or NpmPackageInfo not in ctx.rule.attr.src:
        return []
    info = target[NpmPackageStoreInfo]
    source = ctx.rule.attr.src[NpmPackageInfo].src
    directory = info.package_store_directory
    # Only the pinned rule's original tar extraction branch is shared. A
    # lifecycle output, copied directory or authored namespace remains its
    # exact original File; none is inferred equivalent to another producer.
    if source.is_directory or source.is_symlink or not utils.is_tarball_extension(source.extension):
        return []
    expected = _repository_short_path(ctx.label, (ctx.label.package + "/" if ctx.label.package else "") + "node_modules/" + utils.package_store_root + "/" + utils.package_store_name(info.key) + "/node_modules/" + info.package)
    if directory == None or not directory.is_directory or directory.owner != ctx.label or directory.short_path != expected or directory.root.path != ctx.bin_dir.path:
        fail("Pinned npm tar extraction lacks its actual configured directory File")
    toolchain = ctx.toolchains[tar_lib.toolchain_type]
    tar = toolchain.tarinfo
    runfiles = toolchain.default.default_runfiles
    return [struct(directory = directory, operation = struct(
        source = source,
        output = expected,
        bin_root = ctx.bin_dir.path,
        package = info.package,
        version = info.version,
        key = info.key,
        exclusions = tuple(ctx.rule.attr.exclude_package_contents),
        tar = tar.binary,
        tool_files = tuple(toolchain.default.files.to_list()),
        runfile_files = tuple(runfiles.files.to_list()) if runfiles != None else (),
        runfile_symlinks = tuple([(link.path, link.target_file) for link in runfiles.symlinks.to_list()]) if runfiles != None else (),
        runfile_root_symlinks = tuple([(link.path, link.target_file) for link in runfiles.root_symlinks.to_list()]) if runfiles != None else (),
        environment = tuple(sorted(getattr(tar, "default_env", {}).items())),
    ))]

def _npm_workspace_packages(target, ctx):
    if ctx.rule == None:
        return []
    if ctx.rule.kind == "_npm_package" and NpmPackageInfo in target:
        source = target[NpmPackageInfo].src
        if not source.is_directory or source.is_symlink or source.owner != ctx.label or source.root.path != ctx.bin_dir.path:
            fail("Authored npm package lacks its original configured source TreeArtifact")
        # The namespace is bound to the actual producing package and original
        # direct SourceFiles, never to a package.json name or copied bytes.
        if not ctx.rule.files.srcs or any([not file.is_source or file.owner.repo_name != ctx.label.repo_name or file.owner.package != ctx.label.package for file in ctx.rule.files.srcs]):
            return []
        return [struct(source = source, owner = ctx.label, namespace = _repository_short_path(ctx.label, ctx.label.package), store = None)]
    if ctx.rule.kind not in ["npm_package_store", "npm_package_store_internal"] or NpmPackageStoreInfo not in target or not ctx.rule.attr.src or NpmPackageInfo not in ctx.rule.attr.src or BunNpmSourcesInfo not in ctx.rule.attr.src:
        return []
    source = ctx.rule.attr.src[NpmPackageInfo].src
    store = target[NpmPackageStoreInfo].package_store_directory
    result = []
    for package in ctx.rule.attr.src[BunNpmSourcesInfo].workspace_packages.to_list():
        if package.store == None and package.source == source and package.owner == ctx.rule.attr.src.label:
            if store == None or not store.is_directory or store.is_symlink or store.owner != ctx.label or store.root.path != ctx.bin_dir.path:
                fail("Workspace npm store lacks its actual configured copied directory File")
            result.append(struct(source = source, owner = package.owner, namespace = package.namespace, store = store))
    return result

def _npm_sources_aspect_impl(target, ctx):
    direct = [target[NpmPackageStoreInfo]] if NpmPackageStoreInfo in target else []
    direct_wasm = [struct(tree = target[WasmPackageInfo].tree, inventory = target[WasmPackageInfo].inventory, producer = target[WasmPackageInfo].producer, original_wasm = target[WasmPackageInfo].original_wasm, generator_inputs = target[WasmPackageInfo].generator_inputs, generator_configurations = target[WasmPackageInfo].generator_configurations, crate_manifest = target[WasmPackageInfo].crate_manifest)] if WasmPackageInfo in target else []
    wasm_sets = []
    transitive = []
    originals, copies = _js_library_source_files(target, ctx)
    original_sets = []
    copy_sets = []
    link_sets = []
    extraction_sets = []
    workspace_sets = []
    if JsInfo in target:
        transitive.append(target[JsInfo].npm_package_store_infos)
    if ctx.rule != None:
        for name in _NPM_GRAPH_ATTRIBUTES:
            if hasattr(ctx.rule.attr, name):
                value = getattr(ctx.rule.attr, name)
                dependencies = value.keys() if type(value) == "dict" else value if type(value) == "list" else [value]
                for dependency in dependencies:
                    if type(dependency) == "Target" and BunNpmSourcesInfo in dependency:
                        source = dependency[BunNpmSourcesInfo]
                        transitive.append(source.stores)
                        original_sets.append(source.original_sources)
                        copy_sets.append(source.copied_sources)
                        link_sets.append(source.materialization_links)
                        extraction_sets.append(source.package_extractions)
                        workspace_sets.append(source.workspace_packages)
                        wasm_sets.append(source.wasm_packages)
    return [BunNpmSourcesInfo(
        stores = depset(direct, transitive = transitive),
        wasm_packages = depset(direct_wasm, transitive = wasm_sets),
        original_sources = depset(originals, transitive = original_sets),
        copied_sources = depset(copies, transitive = copy_sets),
        materialization_links = depset(_npm_materialization_links(target, ctx), transitive = link_sets),
        package_extractions = depset(_npm_package_extractions(target, ctx), transitive = extraction_sets),
        workspace_packages = depset(_npm_workspace_packages(target, ctx), transitive = workspace_sets),
    )]

_npm_sources_aspect = aspect(
    implementation = _npm_sources_aspect_impl,
    attr_aspects = _NPM_GRAPH_ATTRIBUTES,
    toolchains = [tar_lib.toolchain_type],
)

bun_npm_sources_aspect = _npm_sources_aspect

def _configuration_impl(ctx):
    return [BunConfigurationInfo(value = ctx.build_setting_value)]

bun_string_setting = rule(implementation = _configuration_impl, build_setting = config.string(flag = True))
bun_int_setting = rule(implementation = _configuration_impl, build_setting = config.int(flag = True))

PublicReleaseContextInfo = provider(fields = {
    "env_file": "Validated public native rustc environment File.",
    "values": "Same immutable scalar release settings consumed by all producers.",
})

def _public_release_context_impl(ctx):
    values = {
        "version": ctx.attr.version[BunConfigurationInfo].value,
        "sequence": ctx.attr.sequence[BunConfigurationInfo].value,
        "releasePublicKey": ctx.attr.release_public_key[BunConfigurationInfo].value,
        "origin": ctx.attr.origin[BunConfigurationInfo].value,
        "opaquePublicKey": ctx.attr.opaque_public_key[BunConfigurationInfo].value,
    }
    settings = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    environment = ctx.actions.declare_file(ctx.label.name + ".env")
    ctx.actions.write(settings, json.encode(values))
    ctx.actions.run(
        executable = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._validator.path, settings.path, environment.path],
        inputs = [settings, ctx.file._validator, ctx.file._config],
        outputs = [environment],
        mnemonic = "PublicReleaseContext",
    )
    return [
        DefaultInfo(files = depset([environment])),
        PublicReleaseContextInfo(env_file = environment, values = values),
        OutputGroupInfo(native_env = depset([environment])),
    ]

public_release_context = rule(
    implementation = _public_release_context_impl,
    attrs = {
        "version": attr.label(default = "//tools/bazel/bun:build_version", providers = [BunConfigurationInfo]),
        "sequence": attr.label(default = "//tools/bazel/bun:release_sequence", providers = [BunConfigurationInfo]),
        "release_public_key": attr.label(default = "//tools/bazel/bun:release_mldsa87_public_key", providers = [BunConfigurationInfo]),
        "origin": attr.label(default = "//tools/bazel/bun:frontend_backend_origin", providers = [BunConfigurationInfo]),
        "opaque_public_key": attr.label(default = "//tools/bazel/bun:frontend_opaque_public_key", providers = [BunConfigurationInfo]),
        "_validator": attr.label(default = "//tools/bazel/bun:public_release_validator", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def _toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(bun = BunInfo(runtime = ctx.file.runtime))]

bun_toolchain = rule(
    implementation = _toolchain_impl,
    attrs = {"runtime": attr.label(allow_single_file = True, mandatory = True)},
)

def _quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _absolute_runfile(file):
    return '"${runfiles}/"' + _quote(_runfile(file))

def bun_inputs(targets):
    sets = []
    for target in targets:
        sets.append(target[DefaultInfo].files)
        if JsInfo in target:
            info = target[JsInfo]
            sets.extend([info.transitive_sources, info.transitive_types, info.npm_sources])
    return depset(transitive = sets)

def _dependency_runfiles(target):
    return target[TestRuntimeInfo].runfiles if TestRuntimeInfo in target else target[DefaultInfo].default_runfiles

def bun_runtime_input_files(targets, files):
    """Actual configured Files addressed by the shared runtime namespace."""
    inputs = {_runfile(file): file for file in files.to_list()}
    for target in targets:
        runtime = _dependency_runfiles(target)
        for file in runtime.files.to_list():
            inputs[_runfile(file)] = file
        for link in runtime.symlinks.to_list():
            inputs[_runfile(link.target_file)] = link.target_file
    return inputs

def bun_runtime_manifest_entries(targets, files):
    """The declared File/Tree namespace shared by tests and developer entrypoints."""
    entries = {}
    for file in files:
        if not file.short_path.startswith("../"):
            entries[file.short_path] = {"runfile": _runfile(file), "link": "node_modules" in file.short_path.split("/") or file.short_path.startswith(".aspect_rules_js/")}
    for target in targets:
        for link in _dependency_runfiles(target).symlinks.to_list():
            entries[link.path] = {"runfile": _runfile(link.target_file), "link": "node_modules" in link.path.split("/") or link.path.startswith(".aspect_rules_js/")}
    return entries

def _launcher_impl(ctx):
    if ctx.attr.chdir.startswith("/") or ".." in ctx.attr.chdir.split("/"):
        fail("Bun working directory must stay inside declared repository runfiles")
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    targets = ctx.attr.data + [ctx.attr._configuration]
    if hasattr(ctx.attr, "_test_deps"):
        targets = targets + ctx.attr._test_deps
    files = bun_inputs(targets)
    tool_files = []
    tool_names = []
    sdk_prefixes = []
    for target, name in ctx.attr.tools.items():
        if NativeSdkInfo in target:
            prefix = target[NativeSdkInfo].prefix_runfile
            if prefix not in sdk_prefixes:
                sdk_prefixes.append(prefix)
        if not name or name in [".", "..", "bun"] or "/" in name or ":" in name:
            fail("Declared Bun tool requires a unique executable basename, other than bun: " + name)
        if name in tool_names:
            fail("Duplicate declared Bun executable basename: " + name)
        executable = target[DefaultInfo].files_to_run.executable
        if executable == None:
            fail("Declared Bun tool is not executable: " + str(target.label))
        if executable.is_symlink:
            # An alias into a generated SDK tree stays an alias, so the tool resolves to its SDK
            # member. Runfiles recreate it verbatim, so its target is relative within that tree.
            link = ctx.actions.declare_symlink(ctx.label.name + ".tools/" + name)
            ctx.actions.symlink(output = link, target_path = "../" * link.short_path.count("/") + executable.short_path)
        else:
            link = ctx.actions.declare_file(ctx.label.name + ".tools/" + name)
            ctx.actions.symlink(output = link, target_file = executable, is_executable = True)
        tool_files.extend([link, executable])
        tool_names.append(name)
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    arguments = [_quote("--no-install"), _quote("--no-env-file"), '"--config=${runfiles}/"' + _quote(_runfile(ctx.file.bun_config))]
    if hasattr(ctx.attr, "_test_runner"):
        if hasattr(ctx.attr, "test_files") and not ctx.attr.test_files:
            fail("bun_test requires its complete explicit test_files inventory")
        arguments.append(_absolute_runfile(ctx.file._test_runner))
        manifest = ctx.actions.declare_file(ctx.label.name + ".runtime-inputs.json")
        entry_inputs = [ctx.file.entry_point] if ctx.attr.entry_point else []
        entries = bun_runtime_manifest_entries(targets, files.to_list() + [ctx.file.bun_config] + entry_inputs)
        ctx.actions.write(manifest, json.encode({"files": entries, "cwd": ctx.attr.chdir, "config": ctx.file.bun_config.short_path}))
        arguments.extend([_absolute_runfile(manifest), '"${runfiles}"'])
        if hasattr(ctx.attr, "test_files"):
            arguments.extend([_quote(file[2:] if file.startswith("./") else file) for file in ctx.attr.test_files])
        else:
            command = ["run", ctx.file.entry_point.short_path] + ctx.attr.fixed_args if ctx.attr.entry_point else ctx.attr.fixed_args
            if len(command) < 2 or command[0] != "run":
                fail("Bun command tests require a declared script and explicit run argv")
            arguments.extend([_quote("--command")] + [_quote(arg) for arg in command])
    else:
        arguments.extend([_quote(arg) for arg in ctx.attr.fixed_args])
        if ctx.attr.entry_point:
            arguments.append(_absolute_runfile(ctx.file.entry_point))
    tool_directory = '"${runfiles}/_main/"' + _quote(ctx.label.package + "/" + ctx.label.name + ".tools")
    isolation = ""
    if ctx.attr._is_test:
        path = tool_directory + ':' if tool_files else ''
        isolation = 'export HOME="${TEST_TMPDIR:-${TMPDIR:-/tmp}}"\nexport PATH=' + path + '"${runtime%%/bun}"'
    elif tool_files:
        isolation = 'export PATH=' + tool_directory + ':"${PATH:-}"'
    if len(sdk_prefixes) > 1:
        fail("One Bun process cannot mix distinct native SDK payloads")
    if sdk_prefixes:
        prefix = '"${runfiles}/"' + _quote(sdk_prefixes[0])
        isolation += "\nexport MERKUR_BAZEL_NATIVE_SDK_PREFIX=" + prefix
        isolation += '\nunset DYLD_LIBRARY_PATH'
        isolation += '\nexport DYLD_FALLBACK_LIBRARY_PATH="$MERKUR_BAZEL_NATIVE_SDK_PREFIX/lib"'
        isolation += '\nexport GIT_EXEC_PATH="$MERKUR_BAZEL_NATIVE_SDK_PREFIX/libexec/git-core"'
        isolation += '\nexport GIT_TEMPLATE_DIR="$MERKUR_BAZEL_NATIVE_SDK_PREFIX/share/git-core/templates"'
        isolation += '\nexport GIT_CONFIG_NOSYSTEM=1\nexport GIT_CONFIG_GLOBAL=/dev/null'
        isolation += '\nexport OPENSSL_CONF="$MERKUR_BAZEL_NATIVE_SDK_PREFIX/ssl/openssl.cnf"'
        isolation += '\nexport OPENSSL_MODULES="$MERKUR_BAZEL_NATIVE_SDK_PREFIX/lib/ossl-modules"'
        isolation += '\nexport PATH=' + tool_directory + ':"${runtime%%/bun}:$MERKUR_BAZEL_NATIVE_SDK_PREFIX/bin"'
    tool_environment = []
    for name, variable in ctx.attr.tool_environment.items():
        if name not in tool_names or not variable or variable[0] in "0123456789" or any([character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789" for character in variable.elems()]):
            fail("Tool environment must name a declared executable and valid uppercase variable")
        tool_environment.append("export " + variable + "=" + tool_directory + "/" + _quote(name))
    environment_files = []
    reserved = ["PATH", "HOME", "TMPDIR", "NODE_PATH", "BUN_INSTALL", "RUNFILES_DIR", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "OPENSSL_CONF", "OPENSSL_MODULES"]
    if ctx.attr.environment_files:
        entries = {}
        for target, variable in ctx.attr.environment_files.items():
            if not variable or variable[0] in "0123456789" or any([character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789" for character in variable.elems()]) or variable in reserved or variable.startswith("TEST_") or variable.startswith("XML_") or variable.startswith("MERKUR_BAZEL_"):
                fail("Declared environment File requires a valid nonreserved uppercase variable")
            if variable in entries or variable in ctx.attr.tool_environment.values():
                fail("Duplicate declared environment variable: " + variable)
            selected = target[DefaultInfo].files.to_list()
            if len(selected) != 1 or selected[0].is_directory:
                fail("Environment mapping requires exactly one declared regular File: " + str(target.label))
            entries[variable] = _runfile(selected[0])
            environment_files.append(selected[0])
        environment_manifest = ctx.actions.declare_file(ctx.label.name + ".environment-files.json")
        ctx.actions.write(environment_manifest, json.encode(entries))
        environment_files.extend([environment_manifest, ctx.file._environment_loader])
        isolation += "\nexport MERKUR_BAZEL_ENVIRONMENT_FILE_MANIFEST=" + _absolute_runfile(environment_manifest)
        arguments.insert(3, '"--preload=${runfiles}/"' + _quote(_runfile(ctx.file._environment_loader)))
    environment_tree_files = []
    environment_tree_exports = []
    tree_variables = {}
    for target, variable in ctx.attr.environment_trees.items():
        if not variable or variable[0] in "0123456789" or any([character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789" for character in variable.elems()]) or variable in reserved or variable.startswith("TEST_") or variable.startswith("XML_") or variable.startswith("MERKUR_BAZEL_"):
            fail("Declared environment Tree requires a valid nonreserved uppercase variable")
        if variable in tree_variables or variable in ctx.attr.environment_files.values() or variable in ctx.attr.tool_environment.values():
            fail("Duplicate declared environment variable: " + variable)
        selected = target[DefaultInfo].files.to_list()
        if len(selected) != 1 or not selected[0].is_directory:
            fail("Environment Tree mapping requires exactly one declared Directory File: " + str(target.label))
        tree_variables[variable] = True
        environment_tree_files.append(selected[0])
        environment_tree_exports.append("export " + variable + "=" + _absolute_runfile(selected[0]))
    isolation = isolation + "\n" + "\n".join(tool_environment + environment_tree_exports)
    script = """#!/bin/sh
set -eu
runfiles=${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}
runtime="$runfiles/%s"
cd "$runfiles/_main/"%s
%s
export MERKUR_BAZEL_RUNFILES_ROOT="$runfiles"
export MERKUR_BUN_TEST_CONFIG=%s
unset BUN_OPTIONS NODE_PATH BUN_INSTALL BUN_CONFIG_VERBOSE_FETCH BUN_CONFIG_NO_CLEAR_TERMINAL
exec "$runtime" %s "$@"
""" % (_runfile(runtime), _quote(ctx.attr.chdir), isolation, _absolute_runfile(ctx.file.bun_config), " ".join(arguments))
    ctx.actions.write(launcher, script, is_executable = True)
    direct = [runtime, ctx.file.bun_config] + tool_files + environment_files + environment_tree_files + ([ctx.file.entry_point] if ctx.attr.entry_point else [])
    if hasattr(ctx.attr, "_test_runner"):
        direct.extend([ctx.file._test_runner, manifest])
    runfiles = ctx.runfiles(files = direct, transitive_files = files)
    for target in targets:
        runfiles = runfiles.merge(_dependency_runfiles(target))
    for target in ctx.attr.tools:
        runfiles = runfiles.merge(_dependency_runfiles(target))
    runtime_runfiles = runfiles
    if ctx.attr._is_test:
        # The epoch is a TestRunner input only. In particular it is absent from
        # source trees, generated runtime manifests and launcher write actions.
        runfiles = runfiles.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))
    providers = [DefaultInfo(executable = launcher, runfiles = runfiles)]
    if ctx.attr._is_test:
        providers.append(TestRuntimeInfo(runfiles = runtime_runfiles))
    return providers

_ATTRS = {
    "entry_point": attr.label(allow_single_file = True),
    "data": attr.label_list(allow_files = True),
    "tools": attr.label_keyed_string_dict(cfg = "exec"),
    "tool_environment": attr.string_dict(),
    "environment_files": attr.label_keyed_string_dict(allow_files = True),
    "environment_trees": attr.label_keyed_string_dict(allow_files = True),
    "_environment_loader": attr.label(default = "//tools/bazel/bun:environment_file_loader", allow_single_file = True),
    "fixed_args": attr.string_list(),
    "chdir": attr.string(default = ""),
    "bun_config": attr.label(default = "//:bunfig.toml", allow_single_file = True),
    "_is_test": attr.bool(default = False),
    "_configuration": attr.label(default = "//:js_configuration"),
}

bun_binary = rule(implementation = _launcher_impl, attrs = _ATTRS, executable = True, toolchains = ["//tools/bazel/bun:toolchain_type"])
bun_test = rule(implementation = _launcher_impl, attrs = dict(_ATTRS, _is_test = attr.bool(default = True), _revocation_epochs = TEST_EPOCH_ATTRIBUTE, test_files = attr.string_list(), _test_runner = attr.label(default = "//tools/bazel/bun:test_runner", allow_single_file = True), _test_deps = attr.label_list(default = ["//scripts:junit_validator", "//scripts:test_preload", "//:js_configuration", "//tools/bazel/bun:runtime_materializer_sources"])), test = True, toolchains = ["//tools/bazel/bun:toolchain_type"])
bun_command_test = rule(implementation = _launcher_impl, attrs = dict(_ATTRS, _is_test = attr.bool(default = True), _revocation_epochs = TEST_EPOCH_ATTRIBUTE, _test_runner = attr.label(default = "//tools/bazel/bun:test_runner", allow_single_file = True), _test_deps = attr.label_list(default = ["//scripts:junit_validator", "//scripts:test_preload", "//:js_configuration", "//tools/bazel/bun:runtime_materializer_sources"])), test = True, toolchains = ["//tools/bazel/bun:toolchain_type"])

def _canonical_input(file, links):
    visited = {}
    for _ in range(len(links) + 1):
        if file in visited:
            fail("Cyclic declared npm compilation aliases")
        visited[file] = True
        link = links.get(file)
        if link == None:
            return struct(path = file.short_path, file = file)
        if link.source == None:
            return struct(path = link.namespace, file = None)
        file = link.source
    fail("Declared npm alias graph did not resolve")

def _build_placement(logical, external_namespace):
    if logical.startswith("../"):
        return external_namespace + "/" + logical[3:] if external_namespace else None
    return logical


def _same_original_input(left, right, links, extractions):
    left = _canonical_input(left, links)
    right = _canonical_input(right, links)
    if left.file == None or right.file == None:
        return False
    if left.file == right.file:
        return True
    original = extractions.get(left.file)
    return original != None and original == extractions.get(right.file)

bun_same_original_input = _same_original_input

def _build_manifest(ctx, targets, extra, runfile_inputs = False, external_namespace = "", declared_aliases = [], vite_tooling = None):
    if external_namespace and (external_namespace.startswith("/") or "\\" in external_namespace or any([part in ["", ".", ".."] for part in external_namespace.split("/")])):
        fail("External Bun inputs require an explicit closed relative namespace")
    files = bun_inputs(targets)
    originals = {}
    copies = {}
    links = {}
    canonical_files = []
    extractions = {}
    for target in targets:
        if BunNpmSourcesInfo in target:
            info = target[BunNpmSourcesInfo]
            for extraction in info.package_extractions.to_list():
                previous = extractions.get(extraction.directory)
                if previous != None and previous != extraction.operation:
                    fail("One npm directory File has conflicting original tar extraction inputs")
                extractions[extraction.directory] = extraction.operation
            for link in info.materialization_links.to_list():
                previous = links.get(link.alias)
                if previous != None and (previous.source != link.source or previous.namespace != link.namespace):
                    fail("Conflicting typed npm compilation alias targets")
                links[link.alias] = link
                if link.source != None:
                    canonical_files.append(link.source)
            for file in info.original_sources.to_list():
                previous = originals.get(file.short_path)
                if previous != None and previous != file:
                    fail("Ambiguous original SourceFiles in Bun source namespace")
                originals[file.short_path] = file
            for file in info.copied_sources.to_list():
                original = originals.get(file.short_path)
                if original == None:
                    fail("Bun copied source has no direct original SourceFile")
                previous = copies.get(file)
                if previous != None and previous != original:
                    fail("One Bun copied File has conflicting original SourceFiles")
                copies[file] = original
    entries = {}
    consumed = []
    identities = {}
    for file in files.to_list() + extra + canonical_files:
        file = copies.get(file, file)
        consumed.append(file)
        logical = _build_placement(file.short_path, external_namespace)
        if logical != None:
            resolved = _canonical_input(file, links)
            current = identities.get(logical)
            if current != None and current != file:
                # Both aliases and terminal directories may be emitted by a
                # direct store and a cycle-resolution store. Require their
                # complete typed chains to end at one original File or the
                # same original configured tar extraction operation.
                if (current not in links and current not in extractions) or (file not in links and file not in extractions) or not _same_original_input(current, file, links, extractions):
                    fail("Conflicting declared Files in Bun source namespace: %s; %s (%s) != %s (%s)" % (logical, current.path, current.owner, file.path, file.owner))
                continue
            canonical = _build_placement(resolved.path, external_namespace)
            if canonical == None:
                fail("Bun compilation alias has no declared placement namespace")
            identities[logical] = file
            entries[logical] = {"input": _runfile(file) if runfile_inputs else file.path, "owner": str(file.owner), "link": "node_modules" in file.short_path.split("/") or file.short_path.startswith(".aspect_rules_js/"), "canonical": canonical}
    for target in targets:
        for link in target[DefaultInfo].default_runfiles.symlinks.to_list():
            file = copies.get(link.target_file, link.target_file)
            logical = _build_placement(_repository_short_path(target.label, link.path), external_namespace)
            if logical == None:
                continue
            current = identities.get(logical)
            if current != None and current != file:
                fail("Conflicting declared runfile Files in Bun source namespace")
            canonical = _build_placement(_canonical_input(file, links).path, external_namespace)
            if canonical == None:
                fail("Bun runfile alias has no declared placement namespace")
            identities[logical] = file
            consumed.append(file)
            entries[logical] = {"input": _runfile(file) if runfile_inputs else file.path, "owner": str(file.owner), "link": "node_modules" in link.path.split("/") or link.path.startswith(".aspect_rules_js/"), "canonical": canonical}
    for file, logical in declared_aliases:
        if file.is_directory or file.owner == None:
            fail("Explicit Bun alias requires its original regular producer File")
        if not logical or logical.startswith("/") or "\\" in logical or ":" in logical or "\0" in logical or any([part in ["", ".", ".."] for part in logical.split("/")]):
            fail("Explicit Bun alias requires a portable relative destination")
        current = identities.get(logical)
        if current != None and current != file:
            fail("Explicit Bun alias conflicts with an existing original File")
        identities[logical] = file
        consumed.append(file)
        entries[logical] = {"input": _runfile(file) if runfile_inputs else file.path, "owner": str(file.owner), "link": False, "canonical": logical}
    if vite_tooling != None:
        if runfile_inputs or external_namespace or not vite_tooling.tree.is_directory or vite_tooling.tree.is_symlink:
            fail("Frontend execution requires its original source-built Vite TreeArtifact")
        runtime_root = "tools/bazel/bun/vite-source-runtime"
        package = vite_tooling.package_directory
        if not package or package.startswith("/") or "\\" in package or any([part in ["", ".", ".."] for part in package.split("/")]):
            fail("Source-built Vite package location must be its exact contained original member")
        if runtime_root in identities:
            fail("Source-built Vite runtime conflicts with an existing declared input")
        originals = []
        for target in targets:
            if BunNpmSourcesInfo in target:
                for store in target[BunNpmSourcesInfo].stores.to_list():
                    if store.package == "vite":
                        if store.version != "8.2.2(@types/node@25.6.0)(jiti@2.6.1)":
                            fail("Frontend source execution requires the exact original locked Vite8.2.2 package identity")
                        if store.package_store_directory != None:
                            originals.append(store.package_store_directory)
        selected = 0
        for logical, file in identities.items():
            if any([_same_original_input(file, original, links, extractions) for original in originals]):
                entries[logical] = {"input": vite_tooling.tree.path, "owner": str(vite_tooling.tree.owner), "link": True, "canonical": runtime_root + "/" + package}
                selected += 1
        if not selected:
            fail("Frontend source-built Vite has no exact original locked package aliases")
        entries[runtime_root] = {"input": vite_tooling.tree.path, "owner": str(vite_tooling.tree.owner), "link": False, "canonical": runtime_root}
        consumed.append(vite_tooling.tree)
    manifest = ctx.actions.declare_file(ctx.label.name + ".build-inputs.json")
    ctx.actions.write(manifest, json.encode(entries))
    return manifest, depset(consumed + [manifest])

def _build_inputs_impl(ctx):
    manifest, inputs = _build_manifest(ctx, ctx.attr.data, [], runfile_inputs = True, external_namespace = ctx.attr.external_namespace)
    sources = [target[BunNpmSourcesInfo] for target in ctx.attr.data if BunNpmSourcesInfo in target]
    return [
        DefaultInfo(files = depset([manifest]), runfiles = ctx.runfiles(transitive_files = inputs)),
        BunNpmSourcesInfo(
            stores = depset(transitive = [source.stores for source in sources]),
            original_sources = depset(transitive = [source.original_sources for source in sources]),
            copied_sources = depset(transitive = [source.copied_sources for source in sources]),
            materialization_links = depset(transitive = [source.materialization_links for source in sources]),
            package_extractions = depset(transitive = [source.package_extractions for source in sources]),
            workspace_packages = depset(transitive = [source.workspace_packages for source in sources]),
            wasm_packages = depset(transitive = [source.wasm_packages for source in sources]),
        ),
    ]

bun_build_inputs = rule(
    implementation = _build_inputs_impl,
    attrs = {
        "data": attr.label_list(allow_files = True, aspects = [_npm_sources_aspect]),
        "external_namespace": attr.string(),
    },
)

def _npm_inventory(ctx, targets):
    source_inventory = ctx.actions.declare_file(ctx.label.name + ".npm-source-inventory.json")
    npm_sources = {}
    for target in targets:
        if BunNpmSourcesInfo in target:
            for info in target[BunNpmSourcesInfo].stores.to_list():
                source = info.package_store_directory
                if source != None:
                    previous = npm_sources.get(source.path)
                    if previous != None and (previous.package != info.package or previous.version != info.version):
                        fail("One declared npm tree has conflicting typed package identity")
                    npm_sources[source.path] = struct(
                        package = info.package,
                        version = info.version,
                        source = source,
                        source_label = str(source.owner),
                        workspace = not source.is_directory,
                    )
    sources = [npm_sources[key] for key in sorted(npm_sources)]
    ctx.actions.write(source_inventory, json.encode([
        {"package": item.package, "version": item.version, "input": item.source.path, "source_label": item.source_label, "workspace": item.workspace}
        for item in sources
    ]))
    return sources, source_inventory

def _wasm_packages(targets):
    return depset(transitive = [target[BunNpmSourcesInfo].wasm_packages for target in targets if BunNpmSourcesInfo in target]).to_list()

def _wasm_inputs(packages):
    return [file for package in packages for file in [package.tree, package.inventory]]

def _compile_impl(ctx):
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_file(ctx.attr.out or ctx.label.name)
    compiler_inventory = ctx.actions.declare_file(ctx.label.name + ".compiler-inventory.json")
    configuration = ctx.actions.declare_file(ctx.label.name + ".compile-context.json")
    sources, source_inventory = _npm_inventory(ctx, ctx.attr.data + [ctx.attr.entry_point])
    ctx.actions.write(configuration, json.encode({
        "producer": str(ctx.label),
        "compile_target": ctx.attr.compile_target,
        "file_loaders": {".wasm": "file"},
        "runtime": str(ctx.file.target_runtime.owner),
        "flags": ctx.attr.flags,
        "defines": {name: target[BunConfigurationInfo].value for target, name in ctx.attr.defines.items()},
        "daemon_identity": ctx.attr.daemon_identity,
        "server_identity": ctx.attr.server_identity,
        "require_release_key": ctx.attr.require_release_key,
        "public_release": ctx.attr._public_context[PublicReleaseContextInfo].values,
        "frontend_build_id": ctx.attr._frontend_id[BunConfigurationInfo].value,
        "build_commit": ctx.attr._commit[BunConfigurationInfo].value,
        "compiler_tooling": [],
    }))
    manifest, inputs = _build_manifest(ctx, ctx.attr.data + [ctx.attr.entry_point, ctx.attr._configuration, ctx.attr._runner_sources], [ctx.file.entry_point, ctx.file._config, ctx.file._runner, ctx.file.target_runtime, ctx.attr._public_context[PublicReleaseContextInfo].env_file])
    args = ctx.actions.args()
    args.add_all(["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, manifest.path, "compile", ctx.file.entry_point.short_path, output.path, ctx.file._config.short_path])
    if ctx.attr.require_release_key:
        public_key = ctx.attr._release_public_key[BunConfigurationInfo].value
        if len(public_key) != 3456 or any([character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for character in public_key.elems()]):
            fail("The signed-runtime producer requires its declared canonical2592-byte ML-DSA-87 public key")
    if ctx.attr.daemon_identity:
        version = ctx.attr._version[BunConfigurationInfo].value
        sequence = ctx.attr._release_sequence[BunConfigurationInfo].value
        public_key = ctx.attr._release_public_key[BunConfigurationInfo].value
        release_parts = version[1:].split(".") if version.startswith("v") else []
        release = len(release_parts) == 3 and all([part and all([digit in "0123456789" for digit in part.elems()]) and (len(part) == 1 or not part.startswith("0")) for part in release_parts])
        if not version or sequence < 0 or sequence > 9007199254740991:
            fail("Daemon identity requires a nonempty version and safe nonnegative release sequence")
        if release and (sequence == 0 or len(public_key) != 3456 or any([character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for character in public_key.elems()])):
            fail("A release daemon requires its positive release sequence and canonical2592-byte public signing key")
        if not release and (sequence != 0 or public_key):
            fail("Development daemon identity cannot carry release trust")
        for name, value in {"MERKUR_VERSION": version, "MERKUR_RELEASE_SEQUENCE": str(sequence), "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY": public_key}.items():
            args.add_all(["--define", "process.env." + name + "=" + json.encode(value)])
    if ctx.attr.server_identity:
        for name, value in {
            "MERKUR_BUILD_ID": ctx.attr._frontend_id[BunConfigurationInfo].value,
            "MERKUR_VERSION": ctx.attr._commit[BunConfigurationInfo].value,
            "MERKUR_RELEASE_MLDSA87_PUBLIC_KEY": ctx.attr._release_public_key[BunConfigurationInfo].value,
            "MERKUR_OPAQUE_WEB_BUILD_PUBLIC_KEY": ctx.attr._frontend_opaque[BunConfigurationInfo].value,
        }.items():
            args.add_all(["--define", "process.env." + name + "=" + json.encode(value)])
    for target, name in ctx.attr.defines.items():
        args.add_all(["--define", "process.env." + name + "=" + json.encode(target[BunConfigurationInfo].value)])
    for flag in ctx.attr.flags:
        if flag == "--target" or flag.startswith("--target=") or flag == "--compile-executable-path" or flag.startswith("--compile-executable-path=") or flag == "--metafile" or flag.startswith("--metafile="):
            fail("Compiled runtime architecture is selected solely by the declared target platform")
    args.add_all(["--target=" + ctx.attr.compile_target, "--compile-executable-path=" + ctx.file.target_runtime.path])
    args.add_all(ctx.attr.flags)
    args.add("--metafile=" + compiler_inventory.path)
    ctx.actions.run(
        executable = runtime,
        arguments = [args],
        inputs = inputs,
        outputs = [output, compiler_inventory],
        env = {"NODE_ENV": "production"},
        mnemonic = "BunCompile",
    )
    return [
        DefaultInfo(files = depset([output]), executable = output),
        BunBuildInfo(
            artifact = output,
            producer = str(ctx.label),
            configuration = configuration,
            declarations = manifest,
            compiler_inventory = compiler_inventory,
            inputs = depset([item.source for item in sources] + _wasm_inputs(_wasm_packages(ctx.attr.data + [ctx.attr.entry_point])), transitive = [inputs]),
            npm_sources = sources,
            npm_source_inventory = source_inventory,
            wasm_packages = _wasm_packages(ctx.attr.data + [ctx.attr.entry_point]),
        ),
        BunCompileInfo(
            executable = output,
            runtime = ctx.file.target_runtime,
            compile_target = ctx.attr.compile_target,
            compiler_inventory = compiler_inventory,
            declarations = manifest,
            configuration = configuration,
            npm_sources = sources,
            npm_source_inventory = source_inventory,
            wasm_packages = _wasm_packages(ctx.attr.data + [ctx.attr.entry_point]),
            inputs = depset([item.source for item in sources] + _wasm_inputs(_wasm_packages(ctx.attr.data + [ctx.attr.entry_point])), transitive = [inputs]),
            producer = str(ctx.label),
        ),
        OutputGroupInfo(
            compiler_inventory = depset([compiler_inventory]),
            npm_source_inventory = depset([source_inventory]),
            compile_context = depset([configuration]),
        ),
    ]


BunNpmAttributionInfo = provider(fields = {
    "manifest": "Actual compiler-selected locked npm metadata intermediate File.",
    "compiler": "Configured BunBuildInfo authority, including the actual artifact and original package source Files.",
    "source_files": "Declared original typed npm store File depset (superset of selected sources).",
})

def _npm_attribution_impl(ctx):
    compiler = ctx.attr.compiler[BunBuildInfo]
    runner_files = ctx.attr._runner_sources[JsInfo].sources.to_list()
    if len(runner_files) != 1:
        fail("Npm attribution requires exactly one declared copied runner module")
    runner = runner_files[0]
    output = ctx.actions.declare_file(ctx.label.name + ".npm-attribution.json")
    ctx.actions.run(
        executable = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, runner.path,
                     compiler.compiler_inventory.path, compiler.declarations.path,
                     compiler.npm_source_inventory.path, compiler.configuration.path,
                     ctx.file._registry.path, output.path, compiler.producer,
                     "bundle" if compiler.artifact.is_directory else "standalone", compiler.artifact.path],
        inputs = depset([compiler.compiler_inventory, compiler.declarations,
                         compiler.npm_source_inventory, compiler.configuration,
                         compiler.artifact, ctx.file._registry, ctx.file._config],
                        transitive = [compiler.inputs, bun_inputs([ctx.attr._runner_sources])]),
        outputs = [output],
        mnemonic = "BunNpmAttribution",
    )
    return [DefaultInfo(files = depset([output])), BunNpmAttributionInfo(manifest = output, compiler = compiler, source_files = depset([item.source for item in compiler.npm_sources]))]

bun_npm_attribution = rule(
    implementation = _npm_attribution_impl,
    attrs = {
        "compiler": attr.label(providers = [BunBuildInfo], mandatory = True),
        "_runner_sources": attr.label(default = "//tools/bazel/bun:npm_attribution_sources"),
        "_registry": attr.label(default = "//tools/bazel/bun:npm-inventory.json", allow_single_file = True),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

_bun_compile = rule(
    implementation = _compile_impl,
    executable = True,
    attrs = {
        "_public_context": attr.label(default = "//tools/bazel/bun:public_release_context", providers = [PublicReleaseContextInfo]),
        "target_runtime": attr.label(allow_single_file = True, mandatory = True),
        "compile_target": attr.string(mandatory = True),
        "entry_point": attr.label(allow_single_file = True, mandatory = True, aspects = [_npm_sources_aspect]),
        "data": attr.label_list(allow_files = True, aspects = [_npm_sources_aspect]),
        "flags": attr.string_list(),
        "defines": attr.label_keyed_string_dict(),
        "daemon_identity": attr.bool(),
        "server_identity": attr.bool(),
        "require_release_key": attr.bool(),
        "_frontend_id": attr.label(default = "//tools/bazel/bun:frontend_build_id", providers = [BunConfigurationInfo]),
        "_frontend_opaque": attr.label(default = "//tools/bazel/bun:frontend_opaque_public_key", providers = [BunConfigurationInfo]),
        "_version": attr.label(default = "//tools/bazel/bun:build_version", providers = [BunConfigurationInfo]),
        "_commit": attr.label(default = "//tools/bazel/bun:build_commit", providers = [BunConfigurationInfo]),
        "_release_sequence": attr.label(default = "//tools/bazel/bun:release_sequence", providers = [BunConfigurationInfo]),
        "_release_public_key": attr.label(default = "//tools/bazel/bun:release_mldsa87_public_key", providers = [BunConfigurationInfo]),
        "out": attr.string(),
        "_configuration": attr.label(default = "//:js_configuration", aspects = [_npm_sources_aspect]),
        "_runner": attr.label(default = "//tools/bazel/bun:build.ts", allow_single_file = True),
        "_runner_sources": attr.label(default = "//tools/bazel/bun:build_runner", aspects = [_npm_sources_aspect]),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

# Explicit same-rule source runtime binding for manual native qualification.
bun_source_runtime_compile = _bun_compile

def bun_compile(name, **kwargs):
    """Compile using the checksum-pinned runtime for the requested target CPU/OS."""
    if "target_runtime" in kwargs or "compile_target" in kwargs:
        fail("bun_compile target runtime is an immutable platform-selected tool")
    _bun_compile(
        name = name,
        target_runtime = select({
            "//tools/bazel/bun:compile_darwin_arm64": "@bun_darwin_aarch64//:bun",
            "//tools/bazel/bun:compile_darwin_x64": "@bun_darwin_x64//:bun",
            "//tools/bazel/bun:compile_linux_arm64": "@bun_linux_aarch64//:bun",
            "//tools/bazel/bun:compile_linux_x64": "@bun_linux_x64//:bun",
        }),
        compile_target = select({
            "//tools/bazel/bun:compile_darwin_arm64": "bun-darwin-arm64",
            "//tools/bazel/bun:compile_darwin_x64": "bun-darwin-x64",
            "//tools/bazel/bun:compile_linux_arm64": "bun-linux-arm64",
            "//tools/bazel/bun:compile_linux_x64": "bun-linux-x64",
        }),
        **kwargs
    )


def _vite_build_impl(ctx):
    tooling = ctx.attr._compiler_tooling[ViteSourceBuildInfo]
    build_id = ctx.attr.build_id[BunConfigurationInfo].value
    parts = build_id.split("-")
    compact = build_id.replace("-", "")
    if len(parts) != 5 or [len(part) for part in parts] != [8, 4, 4, 4, 12] or any([compact[index] not in "0123456789abcdef" for index in range(len(compact))]):
        fail("Frontend requires its declared UUID: --//tools/bazel/bun:frontend_build_id=<uuid>")
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_directory(ctx.attr.out or ctx.label.name)
    declared_aliases = []
    for target, logical in ctx.attr._native_generator_sources.items():
        original = target[DefaultInfo].files.to_list()
        if len(original) != 1 or original[0].owner != target.label:
            fail("Frontend native generator alias differs from its original producer File")
        declared_aliases.append((original[0], logical))
    manifest, inputs = _build_manifest(ctx, ctx.attr.data + [ctx.attr._runner_sources, ctx.attr._materializer_sources], [ctx.file._runner, ctx.file._config, ctx.file._materializer, ctx.attr._public_context[PublicReleaseContextInfo].env_file], declared_aliases = declared_aliases, vite_tooling = tooling)
    inputs = depset([tooling.tree, tooling.native], transitive = [inputs, tooling.inputs])
    selection = ctx.actions.declare_file(ctx.label.name + ".frontend-selection.json")
    configuration = ctx.actions.declare_file(ctx.label.name + ".frontend-context.json")
    sources, source_inventory = _npm_inventory(ctx, ctx.attr.data)
    wasm_packages = _wasm_packages(ctx.attr.data)
    ctx.actions.write(configuration, json.encode({
        "producer": str(ctx.label),
        "project": ctx.attr.project,
        "frontend_build_id": build_id,
        "backend_origin": ctx.attr.backend_origin[BunConfigurationInfo].value,
        "opaque_public_key": ctx.attr.opaque_public_key[BunConfigurationInfo].value,
        "build_commit": ctx.attr.commit[BunConfigurationInfo].value,
        "release_public_key": ctx.attr.release_public_key[BunConfigurationInfo].value,
        "public_release": ctx.attr._public_context[PublicReleaseContextInfo].values,
        "precompression": False,
        "compiler_tooling": [{"manifest_label": str(manifest.owner), "native": {"input": tooling.native.path, "label": str(tooling.native.owner)}} for manifest in tooling.source_manifests.to_list()],
    }))
    ctx.actions.run(
        executable = runtime,
        arguments = [
            "--no-install", "--no-env-file",
            "--config=" + ctx.file._config.path,
            ctx.file._materializer.path,
            manifest.path,
            "vite",
            ctx.file._runner.short_path,
            output.path,
            ctx.file._config.short_path,
            ctx.attr.project,
            build_id,
            ctx.attr.backend_origin[BunConfigurationInfo].value,
            ctx.attr.opaque_public_key[BunConfigurationInfo].value,
            ctx.attr.commit[BunConfigurationInfo].value,
            ctx.attr.release_public_key[BunConfigurationInfo].value,
            selection.path,
            "tools/bazel/bun/vite-source-runtime/" + tooling.package_directory,
        ],
        inputs = inputs,
        outputs = [output, selection],
        env = {"NODE_ENV": "production"},
        mnemonic = "ViteBuild",
        progress_message = "Build declared frontend %{label}",
    )
    return [
        DefaultInfo(files = depset([output])),
        BunBuildInfo(artifact = output, producer = str(ctx.label), configuration = configuration, declarations = manifest, compiler_inventory = selection, inputs = depset([item.source for item in sources] + _wasm_inputs(wasm_packages), transitive = [inputs]), npm_sources = sources, npm_source_inventory = source_inventory, wasm_packages = wasm_packages),
        OutputGroupInfo(frontend_selection = depset([selection]), frontend_declarations = depset([manifest]), compiler_inventory = depset([selection]), build_context = depset([configuration]), npm_source_inventory = depset([source_inventory])),
    ]

vite_build = rule(
    implementation = _vite_build_impl,
    attrs = {
        "_compiler_tooling": attr.label(default = "//tools/bazel/bun:vite_original_source_build", providers = [ViteSourceBuildInfo], cfg = "exec"),
        "_native_generator_sources": attr.label_keyed_string_dict(default = {
            Label("@merkur_vite_rolldown_source//crates/rolldown_plugin_vite_module_preload_polyfill:src/module-preload-polyfill.js"): "crates/rolldown_plugin_vite_module_preload_polyfill/src/module-preload-polyfill.js",
            Label("@merkur_vite_rolldown_source//crates/rolldown_plugin_vite_module_preload_polyfill:src/lib.rs"): "crates/rolldown_plugin_vite_module_preload_polyfill/src/lib.rs",
            Label("@merkur_vite_rolldown_source//crates/rolldown_binding:src/options/plugin/config/binding_vite_build_import_analysis_plugin_config.rs"): "crates/rolldown_binding/src/options/plugin/config/binding_vite_build_import_analysis_plugin_config.rs",
            Label("@merkur_vite_rolldown_source//crates/rolldown_plugin_vite_build_import_analysis:src/lib.rs"): "crates/rolldown_plugin_vite_build_import_analysis/src/lib.rs",
            Label("@merkur_vite_rolldown_source//crates/rolldown_plugin_vite_build_import_analysis:src/ast_visit.rs"): "crates/rolldown_plugin_vite_build_import_analysis/src/ast_visit.rs",
            Label("@merkur_vite_rolldown_source//crates/rolldown_plugin_vite_build_import_analysis:src/ast_utils.rs"): "crates/rolldown_plugin_vite_build_import_analysis/src/ast_utils.rs",
            Label("//tools/bazel/bun:vite_published_preload_source"): "tools/bazel/bun/vite_published_preload_source.js",
            Label("//tools/bazel/bun:vite-preload-generator.ts"): "tools/bazel/bun/vite-preload-generator.ts",
            Label("//tools/bazel/bun:vite_preload_script"): "tools/bazel/bun/vite_preload_script.js",
        }, allow_files = True),
        "_public_context": attr.label(default = "//tools/bazel/bun:public_release_context", providers = [PublicReleaseContextInfo]),
        "project": attr.string(mandatory = True),
        "data": attr.label_list(allow_files = True, aspects = [_npm_sources_aspect]),
        "build_id": attr.label(default = "//tools/bazel/bun:frontend_build_id", providers = [BunConfigurationInfo]),
        "backend_origin": attr.label(default = "//tools/bazel/bun:frontend_backend_origin", providers = [BunConfigurationInfo]),
        "opaque_public_key": attr.label(default = "//tools/bazel/bun:frontend_opaque_public_key", providers = [BunConfigurationInfo]),
        "commit": attr.label(default = "//tools/bazel/bun:build_commit", providers = [BunConfigurationInfo]),
        "release_public_key": attr.label(default = "//tools/bazel/bun:release_mldsa87_public_key", providers = [BunConfigurationInfo]),
        "out": attr.string(),
        "_runner": attr.label(default = "//tools/bazel/bun:vite-build.ts", allow_single_file = True),
        "_runner_sources": attr.label(default = "//tools/bazel/bun:vite_runner", aspects = [_npm_sources_aspect]),
        "_materializer": attr.label(default = "//tools/bazel/bun:build.ts", allow_single_file = True),
        "_materializer_sources": attr.label(default = "//tools/bazel/bun:build_runner", aspects = [_npm_sources_aspect]),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)


def _bundle_impl(ctx):
    if not ctx.files.entry_points:
        fail("Bun bundle requires its complete declared entry-point inventory")
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_directory(ctx.attr.out or ctx.label.name)
    compiler_inventory = ctx.actions.declare_file(ctx.label.name + ".compiler-inventory.json")
    configuration = ctx.actions.declare_file(ctx.label.name + ".bundle-context.json")
    sources, source_inventory = _npm_inventory(ctx, ctx.attr.data + ctx.attr.entry_points)
    ctx.actions.write(configuration, json.encode({
        "producer": str(ctx.label),
        "entry_points": [file.short_path for file in ctx.files.entry_points],
        "root": ctx.attr.root,
        "target": "bun",
        "file_loaders": {".wasm": "file"},
        "runtime": str(runtime.owner),
        "public_release": ctx.attr._public_context[PublicReleaseContextInfo].values,
        "frontend_build_id": ctx.attr._frontend_id[BunConfigurationInfo].value,
        "build_commit": ctx.attr._commit[BunConfigurationInfo].value,
        "compiler_tooling": [],
    }))
    manifest, inputs = _build_manifest(ctx, ctx.attr.data + [ctx.attr._configuration, ctx.attr._runner_sources], ctx.files.entry_points + [ctx.file._config, ctx.file._runner, configuration, ctx.attr._public_context[PublicReleaseContextInfo].env_file])
    args = ctx.actions.args()
    args.add_all(["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, manifest.path, "bundle", ctx.files.entry_points[0].short_path, output.path, ctx.file._config.short_path])
    args.add_all([file.short_path for file in ctx.files.entry_points[1:]])
    args.add("--root=" + ctx.attr.root)
    args.add("--metafile=" + compiler_inventory.path)
    ctx.actions.run(executable = runtime, arguments = [args], inputs = inputs, outputs = [output, compiler_inventory], env = {"NODE_ENV": "production"}, mnemonic = "BunBundle")
    return [
        DefaultInfo(files = depset([output])),
        BunBuildInfo(artifact = output, producer = str(ctx.label), configuration = configuration, declarations = manifest, compiler_inventory = compiler_inventory, inputs = depset([item.source for item in sources] + _wasm_inputs(_wasm_packages(ctx.attr.data + ctx.attr.entry_points)), transitive = [inputs]), npm_sources = sources, npm_source_inventory = source_inventory, wasm_packages = _wasm_packages(ctx.attr.data + ctx.attr.entry_points)),
        OutputGroupInfo(compiler_inventory = depset([compiler_inventory]), build_context = depset([configuration]), npm_source_inventory = depset([source_inventory])),
    ]

bun_bundle = rule(
    implementation = _bundle_impl,
    attrs = {
        "entry_points": attr.label_list(allow_files = True, mandatory = True, aspects = [_npm_sources_aspect]),
        "data": attr.label_list(allow_files = True, aspects = [_npm_sources_aspect]),
        "root": attr.string(mandatory = True),
        "out": attr.string(),
        "_public_context": attr.label(default = "//tools/bazel/bun:public_release_context", providers = [PublicReleaseContextInfo]),
        "_frontend_id": attr.label(default = "//tools/bazel/bun:frontend_build_id", providers = [BunConfigurationInfo]),
        "_commit": attr.label(default = "//tools/bazel/bun:build_commit", providers = [BunConfigurationInfo]),
        "_configuration": attr.label(default = "//:js_configuration", aspects = [_npm_sources_aspect]),
        "_runner": attr.label(default = "//tools/bazel/bun:build.ts", allow_single_file = True),
        "_runner_sources": attr.label(default = "//tools/bazel/bun:build_runner", aspects = [_npm_sources_aspect]),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)

def _brotli_impl(ctx):
    original = ctx.attr.src[BunBuildInfo]
    if original.artifact != ctx.file.src or not original.artifact.is_directory:
        fail("Frontend precompression requires its actual typed frontend TreeArtifact")
    runtime = ctx.toolchains["//tools/bazel/bun:toolchain_type"].bun.runtime
    output = ctx.actions.declare_directory(ctx.attr.out or ctx.label.name)
    selection = ctx.actions.declare_file(ctx.label.name + ".frontend-selection.json")
    configuration = ctx.actions.declare_file(ctx.label.name + ".frontend-context.json")
    ctx.actions.run(
        executable = runtime,
        arguments = ["--no-install", "--no-env-file", "--config=" + ctx.file._config.path, ctx.file._runner.path, original.artifact.path, output.path, original.compiler_inventory.path, selection.path, original.configuration.path, configuration.path, str(ctx.label)],
        inputs = depset([original.artifact, original.compiler_inventory, original.configuration, ctx.file._runner, ctx.file._config], transitive = [ctx.attr._runner_sources[DefaultInfo].files]),
        outputs = [output, selection, configuration],
        mnemonic = "BrotliPrecompress",
    )
    return [
        DefaultInfo(files = depset([output])),
        BunBuildInfo(artifact = output, producer = str(ctx.label), configuration = configuration, declarations = original.declarations, compiler_inventory = selection, inputs = original.inputs, npm_sources = original.npm_sources, npm_source_inventory = original.npm_source_inventory, wasm_packages = original.wasm_packages),
        OutputGroupInfo(frontend_selection = depset([selection]), frontend_declarations = depset([original.declarations]), compiler_inventory = depset([selection]), build_context = depset([configuration]), npm_source_inventory = depset([original.npm_source_inventory])),
    ]


brotli_precompress = rule(
    implementation = _brotli_impl,
    attrs = {
        "src": attr.label(allow_single_file = True, mandatory = True, providers = [BunBuildInfo]),
        "out": attr.string(),
        "_runner": attr.label(default = "//tools/bazel/bun:brotli-build.ts", allow_single_file = True),
        "_runner_sources": attr.label(default = "//tools/bazel/bun:brotli_runner_sources"),
        "_config": attr.label(default = "//tools/bazel/bun:empty-bunfig.toml", allow_single_file = True),
    },
    toolchains = ["//tools/bazel/bun:toolchain_type"],
)
