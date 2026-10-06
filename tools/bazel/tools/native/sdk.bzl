"""Expose original signed SDK executables and their typed environment authority."""
load(":providers.bzl", "NativeSdkInfo")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")

def _sdk_executable_impl(ctx):
    binary = ctx.file.binary
    sdk = ctx.attr.sdk[DefaultInfo]
    if binary not in depset(transitive = [sdk.files, sdk.default_runfiles.files]).to_list():
        fail("SDK executable must be the exact original File in its declared SDK closure")
    runfile = binary.short_path[3:] if binary.short_path.startswith("../") else "_main/" + binary.short_path
    if "/bin/" not in runfile:
        fail("SDK executable must be a declared bin member")
    prefix = runfile.rsplit("/bin/", 1)[0]
    output = ctx.actions.declare_file(ctx.label.name + ".bin")
    ctx.actions.symlink(output = output, target_file = binary, is_executable = True)
    runfiles = ctx.runfiles(files = [binary], transitive_files = ctx.attr.sdk[DefaultInfo].files).merge(ctx.attr.sdk[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = output, runfiles = runfiles), NativeSdkInfo(prefix_runfile = prefix, binary = binary)]

sdk_executable = rule(
    implementation = _sdk_executable_impl,
    executable = True,
    attrs = {"binary": attr.label(allow_single_file = True, mandatory = True), "sdk": attr.label(mandatory = True)},
)

def configured_ranlib(cc, selected):
    """Select the original archiver indexer from this exact configured compiler."""
    if selected[cc_common.CcToolchainInfo] != cc:
        fail("Native source build RANLIB must use the same configured CcToolchain")
    path = selected[platform_common.TemplateVariableInfo].variables.get("RANLIB")
    files = [file for file in cc.all_files.to_list() if file.path == path]
    # Apple ships ranlib as an alias of libtool; the toolchain's closure declares both.
    if not path or len(files) != 1 or files[0].is_directory:
        fail("Native source build requires one original RANLIB File in its configured CcToolchain")
    return files[0]
