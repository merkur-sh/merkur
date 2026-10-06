"""Original Rolldown importer boundaries for rules_js npm_translate_lock.

The source repository calls this after extracting its pinned original archive.
Generated BUILD files load the translated npm repository only during analysis;
acquisition never loads that repository, which itself consumes this source lock.
"""

load("@aspect_rules_js//npm/private:pnpm.bzl", "pnpm")

def rolldown_yq_platform(os_name, arch):
    """Normalize only the native extension's four supported acquisition hosts."""
    os = "darwin" if os_name == "mac os x" else "linux" if os_name == "linux" else None
    cpu = "arm64" if arch in ["aarch64", "arm64"] else "x64" if arch in ["x86_64", "amd64"] else None
    return os + "_" + cpu if os != None and cpu != None else None

def select_rolldown_yq(os_name, arch, files):
    """Select one declared original File; missing or ambiguous mappings refuse."""
    expected = ["darwin_arm64", "darwin_x64", "linux_arm64", "linux_x64"]
    if type(files) != "dict" or sorted(files.values()) != expected:
        fail("Rolldown acquisition requires exactly one declared yq File for each native host")
    platform = rolldown_yq_platform(os_name, arch)
    if platform == None:
        fail("Rolldown acquisition host has no declared native yq")
    for file, identity in files.items():
        if identity == platform:
            return file
    fail("Rolldown acquisition host has no declared native yq")

def rolldown_js_build_appendices(importers, npm_repository = "merkur_rolldown_npm"):
    """Generate existing provider/link declarations at exact importer paths."""
    if type(importers) != "dict" or "." not in importers:
        fail("Original Rolldown lock must contain its root importer")
    if npm_repository not in ["merkur_rolldown_npm", "merkur_vite_rolldown_npm"]:
        fail("Rolldown JS dependencies require an original selected npm repository")
    result = {}
    for importer in sorted(importers):
        if type(importer) != "string" or not importer or "\\" in importer or importer.startswith("/"):
            fail("Original Rolldown importer has an invalid package path")
        package = "" if importer == "." else importer
        if package and any([part in ["", ".", ".."] for part in package.split("/")]):
            fail("Original Rolldown importer escapes or aliases its source package")
        result[package] = struct(
            preamble = 'load("@' + npm_repository + '//:defs.bzl", "npm_link_all_packages")\n' +
                       'load("@aspect_rules_js//npm:defs.bzl", "npm_package")\n',
            # package_data retains the original upstream Files after the source
            # repository partitions its Cargo and JS importer boundaries.
            body = 'npm_package(name = "npm_package", srcs = [":package_data"])\n' +
                   'npm_link_all_packages()\n',
        )
    return result

def rolldown_js_dependencies(ctx):
    """Use the declared rules_js conversion/parser, preserving the full graph."""
    yq = ctx.path(select_rolldown_yq(ctx.os.name, ctx.os.arch, ctx.attr.yq))
    lock = ctx.path("pnpm-lock.yaml")
    result = ctx.execute(
        [yq, "eval-all", ". as $d ireduce (null; $d)", lock, "-o=json"],
        environment = {"PATH": "", "HOME": str(ctx.path(".acquisition-home"))},
    )
    if result.return_code:
        fail("Declared yq could not parse original Rolldown lock: " + result.stderr)
    importers, _packages, _patches, error = pnpm.parse_pnpm_lock_json(
        result.stdout,
        no_dev = False,
        no_optional = False,
    )
    if error != None:
        fail("rules_js could not parse original Rolldown lock: " + error)
    appendices = rolldown_js_build_appendices(importers, ctx.attr.npm_repository)
    for package in appendices:
        manifest = ctx.path((package + "/" if package else "") + "package.json")
        if not manifest.exists:
            fail("Original Rolldown importer package.json File is absent: " + package)
        parsed = json.decode(ctx.read(manifest))
        if type(parsed) != "dict" or not parsed.get("name"):
            fail("Original Rolldown importer has no package name: " + package)
    if not ctx.path("pnpm-workspace.yaml").exists:
        fail("Original Rolldown pnpm workspace File is absent")
    return appendices
