"""The original long graphics lane, including every default Cargo libtest root."""

load("//tools/bazel/bun:rules.bzl", "bun_command_test")
load(":real-helper.bzl", "native_graphics_inputs")

def graphics_long_tests(name, dataplane_lib, dataplane_bin, image_worker, **kwargs):
    """Bind matching native Lib+Bin tests and the original dev-profile worker.

    All three are genuine configured Rust Targets; no unpublished unit labels or
    missing native receipts are replaced by an older executable. The caller binds
    both emitted test labels to test:graphics:long and retains qualification pending.
    """
    if not dataplane_lib or not dataplane_bin or not image_worker:
        fail("Long graphics requires both original dataplane harnesses and image worker")
    if dataplane_lib == dataplane_bin:
        fail("Long graphics requires distinct original Lib and Bin harnesses")
    for role, harness, root in [
        ("lib", dataplane_lib, "apps/daemon/dataplane/src/lib.rs"),
        ("bin", dataplane_bin, "apps/daemon/dataplane/src/main.rs"),
    ]:
        inputs = name + "_" + role + "_inputs"
        native_graphics_inputs(
            name = inputs,
            dataplane_test = harness,
            dataplane_root = root,
            image_worker = image_worker,
            testonly = True,
            visibility = ["//visibility:private"],
        )
        bun_command_test(
            name = name + "_" + role,
            entry_point = "//tools/bazel/verification:graphics-long.ts",
            fixed_args = [role],
            data = [
                "//tools/bazel/verification:graphics-long.ts",
                "//tools/bazel/verification:real-helper.ts",
                "//tools/bazel/bun:owned-files.ts",
                ":" + inputs,
            ],
            environment_files = {":" + inputs: "MERKUR_REAL_HELPER_INPUTS"},
            bun_config = "//tools/bazel/bun:empty-bunfig.toml",
            **kwargs
        )
