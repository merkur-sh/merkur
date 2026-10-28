"""The daemon release: the profile-guided dataplane, the compiled CLI, and the archive.

A `release_binary` builds a Rust executable in Cargo's release profile, instrumented for
profiling or optimized with a profile, whatever the command line's configuration. A
`native_profile` trains an instrumented test executable on the dataplane's workloads and
merges what it wrote. `bun_compile` compiles a script with `bun build --compile` over a checkout
of the repository, and `daemon_archive` packs the executables an install unpacks.
"""

load("@bazel_skylib//rules:common_settings.bzl", "BuildSettingInfo")

_COMPILATION_MODE = "//command_line_option:compilation_mode"
_RUSTC_FLAGS = str(Label("@rules_rust//rust/settings:extra_rustc_flags"))
_PROFILE_USE = str(Label("@rules_rust//rust/settings:profile_use"))
_NO_PROFILE = str(Label("@rules_rust//rust/settings:no_profile"))
_PER_CRATE_FLAGS = str(Label("@rules_rust//rust/settings:per_crate_rustc_flag"))

def _release_transition_impl(settings, attr):
    profile = getattr(attr, "profile", None)
    return {
        _COMPILATION_MODE: "opt",
        # The x86_64 SSSE3 floor is a per-triple flag, which this list leaves in place.
        _RUSTC_FLAGS: ["-Cprofile-generate"] if attr.instrumented else [],
        _PROFILE_USE: str(profile) if profile else _NO_PROFILE,
        # Cargo's release profile keeps no incremental state, which a workstation's
        # `--config=incremental` gives the workspace's crates.
        _PER_CRATE_FLAGS: [
            flag
            for flag in settings[_PER_CRATE_FLAGS]
            if "@-Cincremental=" not in flag
        ],
    }

_release_transition = transition(
    implementation = _release_transition_impl,
    inputs = [_PER_CRATE_FLAGS],
    outputs = [_COMPILATION_MODE, _PER_CRATE_FLAGS, _PROFILE_USE, _RUSTC_FLAGS],
)

def _release_binary_impl(ctx):
    target = ctx.attr.binary[0]
    executable = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.symlink(output = executable, target_file = target[DefaultInfo].files_to_run.executable)
    return [DefaultInfo(
        executable = executable,
        files = depset([executable]),
        runfiles = target[DefaultInfo].default_runfiles,
    )]

release_binary = rule(
    implementation = _release_binary_impl,
    doc = "A Rust executable in Cargo's release profile, with its runfiles.",
    attrs = {
        "binary": attr.label(cfg = _release_transition, executable = True, mandatory = True),
        "instrumented": attr.bool(doc = "Instrument every crate to write an LLVM profile."),
        "profile": attr.label(doc = "The merged profile every crate optimizes with."),
    },
    executable = True,
)

# The profile is trained without one: every crate that compiles with a profile depends on it.
def _no_profile_transition_impl(_settings, _attr):
    return {_PROFILE_USE: _NO_PROFILE}

_no_profile_transition = transition(
    implementation = _no_profile_transition_impl,
    inputs = [],
    outputs = [_PROFILE_USE],
)

def _native_profile_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    trainer = ctx.attr.instrumented[DefaultInfo].files_to_run
    profile = ctx.actions.declare_file(ctx.label.name + ".profdata")
    runs = []
    for name, args in ctx.attr.workloads.items():
        arguments = " ".join(['"%s"' % arg for arg in args])
        runs.append("""# {name}
"$trainer" {arguments} --list > "$raw/{name}.list"
grep -q ': test$' "$raw/{name}.list" || {{ echo "PGO workload {name} selects no test" >&2; exit 1; }}
LLVM_PROFILE_FILE="$raw/{name}-%p-%m.profraw" "$trainer" {arguments} {tolerate}
ls "$raw"/{name}-*.profraw > /dev/null || {{ echo "PGO workload {name} wrote no profile" >&2; exit 1; }}
""".format(
            arguments = arguments,
            name = name,
            tolerate = "|| true" if name in ctx.attr.breadth else "",
        ))
    ctx.actions.run_shell(
        command = """set -euo pipefail
trainer="$PWD/{trainer}"
profdata="$PWD/{profdata}"
out="$PWD/{out}"
raw="$(mktemp -d)"
# The workloads read their fixtures and the image helper at runfiles paths.
cd "$trainer.runfiles/_main"
{runs}
"$profdata" merge -o "$out" "$raw"/*.profraw
""".format(
            out = profile.path,
            profdata = toolchain.llvm_profdata.path,
            runs = "\n".join(runs),
            trainer = trainer.executable.path,
        ),
        outputs = [profile],
        tools = [trainer, toolchain.llvm_profdata] + toolchain.llvm_lib,
        # The image helper confines itself with the operating system's sandbox, which macOS
        # refuses to nest inside Bazel's.
        execution_requirements = {"no-sandbox": "1"},
        mnemonic = "NativeProfileTrain",
        progress_message = "Training %{label}",
    )
    return [DefaultInfo(files = depset([profile]))]

native_profile = rule(
    implementation = _native_profile_impl,
    doc = """The merged LLVM profile of an instrumented test executable's workloads.

`workloads` are libtest arguments by name, run in order. A `breadth` workload trains code the
weight sources never enter, and its verdicts belong to the tests; any other is a weight source
and must pass.""",
    cfg = _no_profile_transition,
    attrs = {
        "breadth": attr.string_list(doc = "Workloads whose failures do not fail the training."),
        "instrumented": attr.label(executable = True, cfg = "target", mandatory = True),
        "workloads": attr.string_list_dict(mandatory = True),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

_PROFILED = str(Label("//tools/bazel/wasm:profiled"))

# What ships bundles the profile-guided terminal module, whatever the command line's configuration.
def _profiled_transition_impl(_settings, _attr):
    return {_PROFILED: True}

_profiled_transition = transition(
    implementation = _profiled_transition_impl,
    inputs = [],
    outputs = [_PROFILED],
)

def _bun_compile_impl(ctx):
    output = ctx.actions.declare_directory(ctx.attr.out) if ctx.attr.directory else ctx.actions.declare_file(ctx.attr.out)
    tool = ctx.attr._checkout[0][DefaultInfo].files_to_run
    ctx.actions.run_shell(
        command = 'TEST_TMPDIR="$(mktemp -d)" "$PWD/{tool}" {arguments} "$PWD/{out}"'.format(
            arguments = " ".join(['"%s"' % arg for arg in (
                ["run", "--no-env-file", ctx.file.entry.short_path] if ctx.file.entry else []
            ) + ctx.attr.arguments]),
            out = output.path,
            tool = tool.executable.path,
        ),
        env = {
            name: setting[BuildSettingInfo].value
            for setting, name in ctx.attr.settings.items()
        },
        outputs = [output],
        tools = [tool],
        mnemonic = "BunCompile",
        progress_message = "Compiling %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

bun_compile = rule(
    implementation = _bun_compile_impl,
    doc = """`bun <arguments> <out>` over a checkout of the repository, writing one file or directory.

With an `entry`, the arguments follow `bun run <entry>`.""",
    attrs = {
        "arguments": attr.string_list(),
        "entry": attr.label(allow_single_file = [".ts"], doc = "The script Bun runs."),
        "directory": attr.bool(doc = "The output is a directory."),
        "out": attr.string(mandatory = True),
        "settings": attr.label_keyed_string_dict(
            doc = "String settings, by the environment variable the compile reads each from.",
        ),
        "_checkout": attr.label(default = "//tools/bazel/release:checkout", executable = True, cfg = _profiled_transition),
    },
)

def _daemon_archive_impl(ctx):
    archive = ctx.actions.declare_file("merkur-daemon-%s.tar.gz" % ctx.attr.platform)
    entries = {name: target.files.to_list()[0] for target, name in ctx.attr.executables.items()}
    ctx.actions.run_shell(
        command = """python3 - "$@" <<'EOF'
import gzip, io, sys, tarfile
out, *pairs = sys.argv[1:]
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
    for name, path in sorted(zip(pairs[0::2], pairs[1::2])):
        with open(path, 'rb') as source:
            body = source.read()
        info = tarfile.TarInfo(name)
        info.size = len(body)
        info.mode = 0o755
        archive.addfile(info, io.BytesIO(body))
with open(out, 'wb') as target, gzip.GzipFile(fileobj=target, mode='wb', mtime=0) as packed:
    packed.write(buffer.getvalue())
EOF
""",
        arguments = [archive.path] + [part for name, file in sorted(entries.items()) for part in [name, file.path]],
        inputs = entries.values(),
        outputs = [archive],
        mnemonic = "DaemonArchive",
        progress_message = "Packing %{label}",
    )
    return [DefaultInfo(files = depset([archive]))]

daemon_archive = rule(
    implementation = _daemon_archive_impl,
    doc = "The release archive: each executable by its name, owner root, mode 0755, no dates.",
    attrs = {
        "executables": attr.label_keyed_string_dict(mandatory = True),
        "platform": attr.string(mandatory = True),
    },
)

def _identity_env_impl(ctx):
    env = ctx.actions.declare_file(ctx.label.name + ".env")
    lines = [
        "%s=%s" % (name, setting[BuildSettingInfo].value)
        for setting, name in sorted(ctx.attr.settings.items(), key = lambda item: item[1])
        if setting[BuildSettingInfo].value != ""
    ]
    ctx.actions.write(env, "".join([line + "\n" for line in lines]))
    return [DefaultInfo(files = depset([env]))]

identity_env = rule(
    implementation = _identity_env_impl,
    doc = """A `rustc_env_files` file of the release identity: each setting that has a value.

An unset setting names no variable, so a crate's `option_env!` reads it as absent.""",
    attrs = {
        "settings": attr.label_keyed_string_dict(mandatory = True),
    },
)

def _directory_archive_impl(ctx):
    archive = ctx.actions.declare_file(ctx.attr.out)
    ctx.actions.run_shell(
        command = """python3 - "$@" <<'PY'
import gzip, io, os, sys, tarfile
root, out, *executables = sys.argv[1:]
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as archive:
    for directory, names, files in os.walk(root):
        names.sort()
        for name in sorted(files):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root)
            with open(path, 'rb') as source:
                body = source.read()
            info = tarfile.TarInfo('./' + relative)
            info.size = len(body)
            info.mode = 0o755 if relative in executables else 0o644
            archive.addfile(info, io.BytesIO(body))
with open(out, 'wb') as target, gzip.GzipFile(fileobj=target, mode='wb', mtime=0) as packed:
    packed.write(buffer.getvalue())
PY
""",
        arguments = [ctx.file.directory.path, archive.path] + ctx.attr.executables,
        inputs = [ctx.file.directory],
        outputs = [archive],
        mnemonic = "DirectoryArchive",
        progress_message = "Packing %{label}",
    )
    return [DefaultInfo(files = depset([archive]))]

directory_archive = rule(
    implementation = _directory_archive_impl,
    doc = "A directory as a `.tar.gz` of `./` paths: owner root, no dates, 0644 but `executables`.",
    attrs = {
        "directory": attr.label(allow_single_file = True, mandatory = True),
        "executables": attr.string_list(doc = "Paths in the directory installed 0755."),
        "out": attr.string(mandatory = True),
    },
)
