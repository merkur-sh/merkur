"""Run the original SIMD cipher Rust test harness through its source-built CLI."""

load("@rules_rust//rust:rust_common.bzl", "CrateInfo")
load("//tools/bazel/bun:rules.bzl", "bun_command_test")
load("//tools/bazel/verification:test-nonce.bzl", "TestRuntimeInfo")

def _wasm_transition_impl(_settings, _attr):
    return {"//command_line_option:platforms": ["//tools/bazel/platforms:wasm32"]}

_wasm_transition = transition(
    implementation = _wasm_transition_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms"],
)

def _codegen_contract(flags):
    options = {}
    simd = False
    for i in range(len(flags)):
        flag = flags[i]
        if flag in ["-C", "--codegen"]:
            if i + 1 == len(flags):
                fail("Incomplete original Rust codegen option")
            option = flags[i + 1]
        elif flag.startswith("-C"):
            option = flag[2:]
        elif flag.startswith("--codegen="):
            option = flag[len("--codegen="):]
        else:
            continue
        parts = option.split("=", 1)
        key = parts[0].replace("_", "-")
        value = parts[1] if len(parts) == 2 else "yes"
        options[key] = value
        if key == "target-feature":
            for feature in value.split(","):
                if feature == "+simd128":
                    simd = True
                elif feature == "-simd128":
                    simd = False
    return options.get("opt-level") == "3" and options.get("debug-assertions") == "no" and simd

def _cipher_contract_impl(target, ctx):
    # These are the producing rust_test's actual attributes, not caller-supplied
    # claims on a filegroup or an rlib with a renamed extension.
    if ctx.rule.kind != "rust_test" or CrateInfo not in target:
        fail("WASM cipher requires an actual configured rust_test producer")
    crate = target[CrateInfo]
    if not crate.is_test or crate.type != "bin" or crate.name != "merkur_e2e":
        fail("WASM cipher requires the merkur-e2e --lib test harness")
    if crate.root.short_path != "packages/merkur-e2e/src/lib.rs":
        fail("WASM cipher test root differs from the original library")
    if ctx.rule.attr.crate_features != ["wasm"]:
        fail("WASM cipher requires the original no-default-features wasm selection")
    if not _codegen_contract(ctx.rule.attr.rustc_flags):
        fail("WASM cipher requires effective original release and e2e-wasm SIMD compiler flags")
    return []

_cipher_contract = aspect(implementation = _cipher_contract_impl)

def _harness_impl(ctx):
    target = ctx.attr.harness[0]
    crate = target[CrateInfo]
    if not crate.is_test or crate.type != "bin" or crate.output.extension != "wasm" or crate.output.is_directory:
        fail("WASM execution requires an actual compiled WASM test harness; rlib is not executable")
    runtime = target[TestRuntimeInfo].runfiles
    return [DefaultInfo(files = depset([crate.output]), runfiles = runtime)]

wasm_cipher_harness = rule(
    implementation = _harness_impl,
    attrs = {
        "harness": attr.label(mandatory = True, providers = [CrateInfo, TestRuntimeInfo], cfg = _wasm_transition, aspects = [_cipher_contract]),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def wasm_cipher_test(name, harness, data = [], tags = [], **kwargs):
    wasm_cipher_harness(name = name + "_harness", harness = harness, testonly = True, tags = ["manual"])
    # Existing Bun command tests provide the TestRunner report and merge only
    # this target's epoch. No epoch enters either compiler or runtime adapter.
    bun_command_test(
        name = name,
        entry_point = "//tools/bazel/wasm:wasm-test.ts",
        data = data + [":" + name + "_harness", "//packages/e2e-wasm:Cargo.toml"],
        environment_files = {":" + name + "_harness": "MERKUR_WASM_TEST_HARNESS"},
        tools = {
            "//tools/bazel/wasm/bindgen_source:wasm_bindgen_test_runner": "wasm-bindgen-test-runner",
            "//tools/bazel/tools:node": "node",
        },
        tool_environment = {"wasm-bindgen-test-runner": "MERKUR_WASM_TEST_RUNNER", "node": "MERKUR_WASM_TEST_NODE"},
        chdir = "packages/e2e-wasm",
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        tags = tags,
        **kwargs
    )
