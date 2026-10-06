"""The exact six native release declarations and owning test-only nonce."""

load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")
load(":native-release.bzl", "NATIVE_RELEASE_PLATFORMS", "NATIVE_RELEASE_TARGETS", "native_release_layout")
load(":release-notices.bzl", "unsigned_release_projection", "unsigned_release_projection_error")

def _layout_impl(ctx):
    env = unittest.begin(ctx)
    artifacts = []
    for platform, constraints in NATIVE_RELEASE_PLATFORMS.items():
        daemon = native_release_layout("daemon", platform)
        asserts.equals(env, "merkur-daemon-" + platform, daemon.name)
        asserts.equals(env, daemon.name + ".tar.gz", daemon.artifact)
        asserts.equals(env, ["merkur", "merkur-dataplane", "merkur-image-worker", "merkur-tui"], sorted(daemon.files.values()))
        asserts.equals(env, "merkur-dataplane", daemon.files["//tools/bazel/rust/release_pgo/" + NATIVE_RELEASE_TARGETS[platform] + ":dataplane_release"])
        asserts.equals(env, 2, len(constraints))
        artifacts.append(daemon.artifact)
        if platform.startswith("linux-"):
            raw = native_release_layout("verify", platform)
            asserts.equals(env, "verify-" + platform, raw.name)
            asserts.equals(env, raw.name, raw.artifact)
            asserts.equals(env, {"//scripts:release_verifier": "verify"}, raw.files)
            artifacts.append(raw.artifact)
    asserts.equals(env, 6, len(artifacts))
    asserts.equals(env, 6, len({name: True for name in artifacts}))
    members = artifacts + ["deployment.tar.gz", "edge-image.tar.gz", "stun-image.tar.gz", "NOTICES.txt"]
    files = []
    for member in members:
        file = ctx.actions.declare_file(ctx.label.name + "/" + member)
        ctx.actions.write(file, "Analysis-only structural File fixture, not a qualified release artifact\n")
        files.append(file)
    asserts.equals(env, None, unsigned_release_projection_error(files))
    asserts.equals(env, sorted(members), sorted([file.basename for file in unsigned_release_projection(files).to_list()]))
    for index in range(len(files)):
        asserts.equals(env, "Unsigned release requires exactly the ten original platform artifact Files", unsigned_release_projection_error(files[:index] + files[index + 1:]))
    asserts.equals(env, "Unsigned release requires distinct ordinary original artifact Files", unsigned_release_projection_error(files + [files[0]]))
    foreign = ctx.actions.declare_file(ctx.label.name + "/merkur-daemon-darwin-riscv64.tar.gz")
    ctx.actions.write(foreign, "Wrong-platform structural fixture\n")
    asserts.equals(env, "Unsigned release requires exactly the ten original platform artifact Files", unsigned_release_projection_error(files[1:] + [foreign]))
    signing = ctx.actions.declare_file(ctx.label.name + "/daemon.signing-inputs.json")
    ctx.actions.write(signing, "{}\n")
    asserts.equals(env, "Unsigned release requires exactly the ten original platform artifact Files", unsigned_release_projection_error(files + [signing]))
    unittest.end(env)
    toolchain = ctx.toolchains["@bazel_skylib//toolchains/unittest:toolchain_type"].unittest_toolchain_info
    executable = ctx.actions.declare_file(ctx.label.name + toolchain.file_ext)
    runtime = ctx.runfiles(files = [executable])
    return [
        DefaultInfo(files = depset([executable]), executable = executable, runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)]))),
        TestRuntimeInfo(runfiles = runtime),
    ]

_layout_test = unittest.make(_layout_impl, attrs = {"_revocation_epochs": TEST_EPOCH_ATTRIBUTE})

def native_release_test_suite(name):
    unittest.suite(name, _layout_test)
