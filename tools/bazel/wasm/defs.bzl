"""The browser's WebAssembly modules: compiled, profile-guided and packaged as wasm-pack did.

A `wasm_module` compiles a `rust_shared_library` for the browser in Cargo's release profile,
with the flags the crate's own `.cargo/config.toml` gave Cargo (`simd128`). A profile-guided
module trains an instrumented build of the same targets (`wasm_profile`), so every crate keeps
its symbol names between the two builds and the whole profile applies. A `wasm_package` runs
wasm-bindgen and `wasm-opt -O` over it and writes the package wasm-pack wrote; `wasm_sync`
copies packages into the checkout, where Vite and Bun import them. A `wasm_bindgen_test` runs a
test harness compiled the same way under wasm-bindgen's test runner.
"""

_PLATFORMS = "//command_line_option:platforms"
_COMPILATION_MODE = "//command_line_option:compilation_mode"
_RUSTC_FLAGS = str(Label("@rules_rust//rust/settings:extra_rustc_flags"))
_RUSTC_ENV = str(Label("@rules_rust//rust/settings:extra_rustc_env"))
_PROFILE_USE = str(Label("@rules_rust//rust/settings:profile_use"))
_NO_PROFILE = str(Label("@rules_rust//rust/settings:no_profile"))
_INSTRUMENTED = str(Label("//tools/bazel/wasm:instrumented"))

def _module_transition_impl(_settings, attr):
    instrumented = getattr(attr, "instrumented", False)
    profile = getattr(attr, "profile", None)
    flags = ["-Ctarget-feature=+simd128"] if attr.simd128 else []
    if instrumented:
        # wasm32 has no profiler runtime; the training module links minicov's in its place,
        # whose bare-metal runtime cannot allocate value-profile nodes. `-Zno-profiler-runtime`
        # is unstable, so this one build lets the release compiler accept it.
        flags += ["-Cprofile-generate=pgo", "-Zno-profiler-runtime", "-Cllvm-args=-disable-vp=true"]
    return {
        _COMPILATION_MODE: "opt",
        _INSTRUMENTED: instrumented,
        _PLATFORMS: str(Label("//tools/bazel/platforms:wasm32")),
        _PROFILE_USE: str(profile) if profile else _NO_PROFILE,
        _RUSTC_ENV: ["RUSTC_BOOTSTRAP=1"] if instrumented else [],
        _RUSTC_FLAGS: flags,
    }

_module_transition = transition(
    implementation = _module_transition_impl,
    inputs = [],
    outputs = [_COMPILATION_MODE, _INSTRUMENTED, _PLATFORMS, _PROFILE_USE, _RUSTC_ENV, _RUSTC_FLAGS],
)

def _wasm_module_impl(ctx):
    return [DefaultInfo(files = depset(ctx.files.crate))]

wasm_module = rule(
    implementation = _wasm_module_impl,
    doc = "A `rust_shared_library` compiled for the browser in the release profile.",
    attrs = {
        "crate": attr.label(cfg = _module_transition, mandatory = True),
        "instrumented": attr.bool(doc = "Build the profile-generating training module."),
        "profile": attr.label(doc = "The `wasm_profile` every crate optimizes with."),
        "simd128": attr.bool(doc = "Compile every crate with WebAssembly SIMD."),
    },
)

# The profile and its training run build with no profile: every target that compiles with one
# depends on the profile, so the profile must not depend on itself through its own tools.
def _no_profile_transition_impl(_settings, _attr):
    return {_PROFILE_USE: _NO_PROFILE}

_no_profile_transition = transition(
    implementation = _no_profile_transition_impl,
    inputs = [],
    outputs = [_PROFILE_USE],
)

def _wasm_profile_impl(ctx):
    toolchain = ctx.toolchains["@rules_rust//rust:toolchain_type"]
    raw = ctx.actions.declare_file(ctx.label.name + ".profraw")
    ctx.actions.run_shell(
        command = '"{trainer}" "$PWD/{module}" "$PWD/{fixture}" "$PWD/{font}" "$PWD/{raw}"'.format(
            trainer = ctx.executable.trainer.path,
            module = ctx.file.instrumented.path,
            fixture = ctx.executable.zstd_fixture.path,
            font = ctx.file.font.path,
            raw = raw.path,
        ),
        inputs = [ctx.file.instrumented, ctx.file.font],
        outputs = [raw],
        tools = [ctx.attr.trainer[DefaultInfo].files_to_run, ctx.attr.zstd_fixture[DefaultInfo].files_to_run],
        mnemonic = "WasmProfileTrain",
        progress_message = "Training %{label}",
    )
    profile = ctx.actions.declare_file(ctx.label.name + ".profdata")
    ctx.actions.run(
        executable = toolchain.llvm_profdata,
        arguments = ["merge", "-o", profile.path, raw.path],
        inputs = [raw],
        outputs = [profile],
        tools = toolchain.llvm_lib,
        mnemonic = "WasmProfileMerge",
        progress_message = "Merging %{label}",
    )
    return [DefaultInfo(files = depset([profile]))]

wasm_profile = rule(
    implementation = _wasm_profile_impl,
    doc = "The merged LLVM profile of a training run over an instrumented `wasm_module`.",
    cfg = _no_profile_transition,
    attrs = {
        "font": attr.label(allow_single_file = True, mandatory = True),
        "instrumented": attr.label(allow_single_file = [".wasm"], mandatory = True),
        "trainer": attr.label(cfg = "exec", executable = True, mandatory = True),
        "zstd_fixture": attr.label(cfg = "exec", executable = True, mandatory = True),
    },
    toolchains = ["@rules_rust//rust:toolchain_type"],
)

def _wasm_package_impl(ctx):
    name = ctx.attr.out_name
    staged = ctx.label.name + "_bindgen/"
    js, dts, wasm, wasm_dts = [
        ctx.actions.declare_file(staged + name + suffix)
        for suffix in [".js", ".d.ts", "_bg.wasm", "_bg.wasm.d.ts"]
    ]

    # wasm-pack's release build: web glue with declarations, then `wasm-opt -O` over the module.
    # A file wasm-bindgen writes beyond these four (inline JavaScript snippets) fails the build
    # rather than shipping without its package entry.
    ctx.actions.run_shell(
        command = """set -euo pipefail
out="$(mktemp -d)"
"{bindgen}" "{module}" --out-dir "$out" --typescript --target web --out-name {name}
written="$(cd "$out" && ls -A | tr '\\n' ' ')"
if [ "$written" != "{name}.d.ts {name}.js {name}_bg.wasm {name}_bg.wasm.d.ts " ]; then
  echo "wasm-bindgen wrote: $written" >&2
  exit 1
fi
"{opt}" "$out/{name}_bg.wasm" -o "{wasm}" -O
cp "$out/{name}.js" "{js}"
cp "$out/{name}.d.ts" "{dts}"
cp "$out/{name}_bg.wasm.d.ts" "{wasm_dts}"
""".format(
            bindgen = ctx.executable._wasm_bindgen.path,
            dts = dts.path,
            js = js.path,
            module = ctx.file.module.path,
            name = name,
            opt = ctx.files._wasm_opt[0].path,
            wasm = wasm.path,
            wasm_dts = wasm_dts.path,
        ),
        inputs = [ctx.file.module],
        outputs = [js, dts, wasm, wasm_dts],
        tools = ctx.files._wasm_bindgen + ctx.files._wasm_opt,
        mnemonic = "WasmBindgen",
        progress_message = "Packaging %{label}",
    )

    package = ctx.label.name + "/"
    files = {}
    for source in [wasm, wasm_dts]:
        files[source.basename] = source
    if ctx.attr.glue:
        current_js = ctx.actions.declare_file(package + js.basename)
        current_dts = ctx.actions.declare_file(package + dts.basename)
        ctx.actions.run_shell(
            command = '"{glue}" "$PWD/{js}" "$PWD/{dts}" "$PWD/{current_js}" "$PWD/{current_dts}"'.format(
                glue = ctx.executable.glue.path,
                current_dts = current_dts.path,
                current_js = current_js.path,
                dts = dts.path,
                js = js.path,
            ),
            inputs = [js, dts],
            outputs = [current_js, current_dts],
            tools = [ctx.attr.glue[DefaultInfo].files_to_run],
            mnemonic = "WasmGlue",
            progress_message = "Rewriting the glue of %{label}",
        )
        files[js.basename] = current_js
        files[dts.basename] = current_dts
    else:
        files[js.basename] = js
        files[dts.basename] = dts

    outputs = []
    for basename, source in files.items():
        if source.dirname.endswith("/" + ctx.label.name):
            outputs.append(source)
            continue
        linked = ctx.actions.declare_file(package + basename)
        ctx.actions.symlink(output = linked, target_file = source)
        outputs.append(linked)

    manifest = ctx.actions.declare_file(package + "package.json")
    ctx.actions.write(manifest, json.encode_indent({
        "name": ctx.attr.package_name,
        "type": "module",
        "version": ctx.attr.version,
        "license": ctx.attr.license,
        "files": [wasm.basename, js.basename, dts.basename],
        "main": js.basename,
        "types": dts.basename,
        "sideEffects": ["./snippets/*"],
    }, indent = "  ") + "\n")
    outputs.append(manifest)
    return [DefaultInfo(files = depset(outputs))]

wasm_package = rule(
    implementation = _wasm_package_impl,
    doc = "The npm package wasm-pack wrote for a `wasm_module`: web glue, declarations, module.",
    attrs = {
        "glue": attr.label(
            cfg = "exec",
            executable = True,
            doc = "Rewrites the glue: argv is the JavaScript and declarations in, then out.",
        ),
        "license": attr.string(mandatory = True),
        "module": attr.label(allow_single_file = [".wasm"], mandatory = True),
        "out_name": attr.string(mandatory = True),
        "package_name": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
        "_wasm_bindgen": attr.label(
            cfg = "exec",
            default = "//tools/bazel/wasm:wasm-bindgen",
            executable = True,
            allow_single_file = True,
        ),
        "_wasm_opt": attr.label(cfg = "exec", default = "//tools/bazel/wasm:wasm-opt"),
    },
)

def _wasm_sync_impl(ctx):
    lines = []
    files = []
    for target, destinations in ctx.attr.packages.items():
        sources = target[DefaultInfo].files.to_list()
        files.extend(sources)
        for destination in destinations.split(" "):
            lines.append("sync {} {}".format(destination, " ".join([source.short_path for source in sources])))
    launcher = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.write(
        output = launcher,
        content = """#!/usr/bin/env bash
# Each destination becomes exactly its package; one already equal is left untouched, so a dev
# server watching it does not reload.
set -euo pipefail
runfiles="$(cd "${{RUNFILES_DIR:-$0.runfiles}}" && pwd)/_main"
cd "$BUILD_WORKSPACE_DIRECTORY"
sync() {{
  local destination="$1"
  shift
  local staged
  staged="$(mktemp -d)"
  for file in "$@"; do
    cp "$runfiles/$file" "$staged/"
  done
  chmod 0644 "$staged"/*
  if ! diff -r "$staged" "$destination" >/dev/null 2>&1; then
    rm -rf "$destination"
    mkdir -p "$destination"
    cp "$staged"/* "$destination/"
    echo "synced $destination"
  fi
  rm -rf "$staged"
}}
{lines}
""".format(lines = "\n".join(lines)),
        is_executable = True,
    )
    return [DefaultInfo(executable = launcher, runfiles = ctx.runfiles(files = files))]

wasm_sync = rule(
    implementation = _wasm_sync_impl,
    doc = "`bazel run` copies each package into its space-separated checkout destinations.",
    attrs = {
        "packages": attr.label_keyed_string_dict(mandatory = True),
    },
    executable = True,
)

def _wasm_bindgen_test_impl(ctx):
    module = ctx.files.test[0]
    node = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"].nodeinfo
    launcher = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.write(
        output = launcher,
        content = """#!/usr/bin/env bash
# wasm-bindgen's runner drives the module with the `node` on its PATH.
set -euo pipefail
runfiles="$(cd "${{RUNFILES_DIR:-$0.runfiles}}" && pwd)/_main"
PATH="$(dirname "$runfiles/{node}"):$PATH" exec "$runfiles/{runner}" "$runfiles/{module}" "$@"
""".format(
            module = module.short_path,
            node = node.node.short_path,
            runner = ctx.file._runner.short_path,
        ),
        is_executable = True,
    )
    runfiles = ctx.runfiles(files = [ctx.file._runner, module, node.node] + node.tool_files)
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

wasm_bindgen_test = rule(
    implementation = _wasm_bindgen_test_impl,
    doc = "A wasm32 test harness run under wasm-bindgen's test runner in Node.",
    attrs = {
        "simd128": attr.bool(doc = "Compile every crate with WebAssembly SIMD."),
        "test": attr.label(cfg = _module_transition, mandatory = True),
        "_runner": attr.label(
            default = "//tools/bazel/wasm:wasm-bindgen-test-runner",
            allow_single_file = True,
        ),
    },
    test = True,
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
