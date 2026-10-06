"""Declared development runtime; every npm/WASM/tool member is a configured input."""

load("//tools/bazel/bun:rules.bzl", "BunNpmSourcesInfo", "bun_inputs", "bun_npm_sources_aspect", "bun_runtime_manifest_entries", "bun_runtime_input_files", "bun_same_original_input")
load("//tools/bazel/bun:source-providers.bzl", "ViteSourceBuildInfo")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _runtime_impl(ctx):
    vite = ctx.attr.vite[ViteSourceBuildInfo]
    if not vite.tree.is_directory or not vite.package_directory or vite.package_directory.startswith("/") or ".." in vite.package_directory.split("/"):
        fail("Development requires the actual source-built Vite package tree")
    files = bun_inputs(ctx.attr.data)
    all_files = depset([ctx.file.config] + ctx.files.workspace_sources, transitive = [files])
    entries = bun_runtime_manifest_entries(ctx.attr.data, all_files.to_list())
    actual = bun_runtime_input_files(ctx.attr.data, all_files)
    actual[_runfile(vite.tree)] = vite.tree
    actual[_runfile(vite.preload)] = vite.preload
    workspace = []
    original_sets = [target[BunNpmSourcesInfo].original_sources for target in ctx.attr.data if BunNpmSourcesInfo in target]
    source_files = {}
    copied_sources = {}
    for target in ctx.attr.data:
        for original in target[BunNpmSourcesInfo].original_sources.to_list():
            previous = source_files.get(original.short_path)
            if previous != None and previous != original:
                fail("Development watch source has conflicting original File identities")
            source_files[original.short_path] = original
        for copied in target[BunNpmSourcesInfo].copied_sources.to_list():
            original = source_files.get(copied.short_path)
            if original == None:
                fail("Development copied source lacks its declared original SourceFile")
            copied_sources[copied] = original
    originals = depset([copied_sources.get(file, file) for file in ctx.files.workspace_sources], transitive = original_sets).to_list()
    workspace_packages = {}
    for target in ctx.attr.data:
        if BunNpmSourcesInfo not in target:
            fail("Development runtime requires the actual typed npm source graph")
        for package in target[BunNpmSourcesInfo].workspace_packages.to_list():
            if package.namespace.startswith("../"):
                fail("Development source packages must belong to this workspace")
            workspace_packages[_runfile(package.source)] = package.namespace
            if package.store != None:
                workspace_packages[_runfile(package.store)] = package.namespace
    vite_packages = []
    links = {}
    extractions = {}
    for target in ctx.attr.data:
        source = target[BunNpmSourcesInfo]
        for link in source.materialization_links.to_list():
            previous = links.get(link.alias)
            if previous != None and (previous.source != link.source or previous.namespace != link.namespace):
                fail("Development Vite aliases have conflicting original File targets")
            links[link.alias] = link
        for extraction in source.package_extractions.to_list():
            previous = extractions.get(extraction.directory)
            if previous != None and previous != extraction.operation:
                fail("Development Vite package has conflicting original archive inputs")
            extractions[extraction.directory] = extraction.operation
        for store in source.stores.to_list():
            if store.package == "vite":
                if store.version != "8.2.2(@types/node@25.6.0)(jiti@2.6.1)":
                    fail("Development requires its exact original locked Vite8.2.2 identity")
                if store.package_store_directory != None:
                    vite_packages.append(store.package_store_directory)
    vite_aliases = 0
    for entry in entries.values():
        original = actual.get(entry["runfile"])
        if original != None and any([bun_same_original_input(original, package, links, extractions) for package in vite_packages]):
            if entry["runfile"] in workspace_packages and workspace_packages[entry["runfile"]] != ".merkur-dev/vite/" + vite.package_directory:
                fail("Development source-built Vite conflicts with an authored package alias")
            workspace_packages[entry["runfile"]] = ".merkur-dev/vite/" + vite.package_directory
            vite_aliases += 1
    if not vite_aliases:
        fail("Development source-built Vite has no exact original npm File aliases")
    for file in originals:
        if file.short_path.startswith("../"):
            continue
        if not file.is_source or "node_modules" in file.short_path.split("/"):
            fail("Development watch mapping requires original authored workspace SourceFiles")
        actual[_runfile(file)] = file
        entries[file.short_path] = {"runfile": _runfile(file), "link": False}
        if file.short_path not in workspace:
            workspace.append(file.short_path)
    entries[".merkur-dev/vite"] = {"runfile": _runfile(vite.tree), "link": False}
    entries[".merkur-dev/vite-preload.ts"] = {"runfile": _runfile(vite.preload), "link": False}
    manifest = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(manifest, json.encode({
        "files": entries,
        "cwd": "",
        "config": ctx.file.config.short_path,
        "workspace": sorted(workspace),
        "workspacePackages": workspace_packages,
        "execFiles": {name: file.path for name, file in actual.items()},
        "vite": ".merkur-dev/vite/" + vite.package_directory + "/bin/vite.js",
        "preload": ".merkur-dev/vite-preload.ts",
    }))
    runfiles = ctx.runfiles(files = [manifest, ctx.file.config, vite.tree, vite.preload] + originals, transitive_files = files)
    for target in ctx.attr.data:
        runfiles = runfiles.merge(target[DefaultInfo].default_runfiles)
    return [DefaultInfo(files = depset([manifest]), runfiles = runfiles), OutputGroupInfo(development_runtime = depset(actual.values()))]

development_runtime = rule(
    implementation = _runtime_impl,
    attrs = {
        "data": attr.label_list(allow_files = True, aspects = [bun_npm_sources_aspect]),
        "workspace_sources": attr.label_list(allow_files = True),
        "vite": attr.label(providers = [ViteSourceBuildInfo], mandatory = True),
        "config": attr.label(allow_single_file = True, mandatory = True),
    },
)
