"""Use the production runtime-only nonce boundary in a small cache qualifier."""
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "test_nonce_file")

def _runfile(file):
    return file.short_path[3:] if file.short_path.startswith("../") else "_main/" + file.short_path

def _probe_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".test")
    # Deliberately fixed runfile name: only its bytes vary across reservations.
    # Loading the owning epoch does not make that File a compiler input.
    nonce = test_nonce_file(ctx)
    ctx.actions.run(
        executable = ctx.file.python,
        arguments = ["-I", "-B", ctx.file.generator.path, ctx.file.source.path, output.path,
                     ctx.attr.python_absolute, _runfile(nonce), ctx.attr.barriers],
        inputs = depset([ctx.file.generator, ctx.file.source], transitive = [ctx.attr.python_sdk[DefaultInfo].files]),
        outputs = [output],
        env = {"PATH": "/__no_ambient_cache_qualification_tools__"},
        use_default_shell_env = False,
        mnemonic = "CacheQualificationBinary",
    )
    runfiles = ctx.runfiles(files = [nonce], transitive_files = depset(transitive = [ctx.attr.python_sdk[DefaultInfo].files, ctx.attr.shell_sdk[DefaultInfo].files, ctx.attr.tool_namespace[DefaultInfo].files] + [sdk[DefaultInfo].files for sdk in ctx.attr.utility_sdks]))
    return [DefaultInfo(executable = output, runfiles = runfiles)]

cache_probe_test = rule(
    implementation = _probe_impl,
    test = True,
    attrs = {
        "python": attr.label(mandatory = True, allow_single_file = True, cfg = "exec"),
        "python_sdk": attr.label(mandatory = True, cfg = "exec"),
        "shell_sdk": attr.label(mandatory = True, cfg = "exec"),
        "utility_sdks": attr.label_list(mandatory = True, cfg = "exec"),
        "tool_namespace": attr.label(mandatory = True, cfg = "exec"),
        "python_absolute": attr.string(mandatory = True),
        "barriers": attr.string(mandatory = True),
        "source": attr.label(default = ":probe.py", allow_single_file = True),
        "generator": attr.label(default = ":generate.py", allow_single_file = True),
        "_revocation_epochs": TEST_EPOCH_ATTRIBUTE,
    },
)
