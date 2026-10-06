"""Original bootstrap distributions for the existing matched compiler sources."""

load(":prepare_compiler.bzl", "PreparedCompilerSourceInfo")

CompilerBootstrapInputsInfo = provider(fields = ["sources", "stage0", "llvm", "configuration", "input_files", "host", "build_selectors"])

def _bootstrap_inputs_impl(ctx):
    source = ctx.attr.sources[PreparedCompilerSourceInfo]
    python = ctx.attr._python[DefaultInfo].files_to_run
    files = depset([python.executable], transitive = [source.git_sdk_files, ctx.attr._python[DefaultInfo].default_runfiles.files])
    request = ctx.actions.declare_file(ctx.label.name + ".request.json")
    configuration = ctx.actions.declare_file(ctx.label.name + ".json")
    stage0 = ctx.actions.declare_directory(ctx.label.name + ".stage0")
    llvm = ctx.actions.declare_directory(ctx.label.name + ".llvm")
    ctx.actions.write(request, json.encode({
        "producer": str(ctx.label),
        "sources": source.source_tree.path + "/" + source.source_subdirectory,
        "source_archive": source.archive.path,
        "compiler_pins": source.pins.path,
        "patch": source.patch.path,
        "bootstrap_pins": ctx.file.pins.path,
        "archives": {
            "rustc": ctx.file.rustc.path,
            "cargo": ctx.file.cargo.path,
            "rust-std": ctx.file.rust_std.path,
            "llvm": ctx.file.llvm.path,
        },
        "python": python.executable.path,
        "git": source.git.path,
        "sdk_files": sorted([file.path for file in files.to_list()]),
    }))
    inputs = depset([request, source.source_tree, source.archive, source.pins, source.patch, ctx.file.pins, ctx.file.rustc, ctx.file.cargo, ctx.file.rust_std, ctx.file.llvm, ctx.file._materialize], transitive = [files])
    ctx.actions.run(
        executable = python,
        tools = [python],
        inputs = inputs,
        outputs = [configuration, stage0, llvm],
        arguments = ["-B", "-I", ctx.file._materialize.path, "--request", request.path, "--configuration", configuration.path, "--stage0", stage0.path, "--llvm", llvm.path],
        env = {},
        use_default_shell_env = False,
        mnemonic = "MerkurCompilerBootstrapInputs",
    )
    return [DefaultInfo(files = depset([configuration, stage0, llvm])), CompilerBootstrapInputsInfo(
        sources = source.source_tree,
        stage0 = stage0,
        llvm = llvm,
        configuration = configuration,
        input_files = inputs,
        host = "aarch64-apple-darwin",
        build_selectors = ["compiler/rustc", "library", "src/tools/rustdoc"],
    ), OutputGroupInfo(configuration = depset([configuration]))]

compiler_bootstrap_inputs = rule(
    implementation = _bootstrap_inputs_impl,
    attrs = {
        "sources": attr.label(providers = [PreparedCompilerSourceInfo], mandatory = True),
        "pins": attr.label(allow_single_file = True, mandatory = True),
        "rustc": attr.label(allow_single_file = True, mandatory = True),
        "cargo": attr.label(allow_single_file = True, mandatory = True),
        "rust_std": attr.label(allow_single_file = True, mandatory = True),
        "llvm": attr.label(allow_single_file = True, mandatory = True),
        "_materialize": attr.label(default = ":bootstrap-inputs.py", allow_single_file = True),
        "_python": attr.label(default = "//tools/bazel/tools/native:python3", executable = True, cfg = "exec"),
    },
)
