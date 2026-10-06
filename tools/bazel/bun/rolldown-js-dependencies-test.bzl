"""Controls for source/lock repository boundaries, using the existing parser."""

load("@aspect_rules_js//npm/private:pnpm.bzl", "pnpm")
load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load("//tools/bazel/verification:test-nonce.bzl", "TEST_EPOCH_ATTRIBUTE", "TestRuntimeInfo", "test_nonce_file")
load(":rolldown-js-dependencies.bzl", "rolldown_js_build_appendices", "rolldown_yq_platform", "select_rolldown_yq")

def _importers_impl(ctx):
    env = unittest.begin(ctx)
    # Two importers share the same original peer snapshot. The adapter creates
    # boundaries without rewriting that graph or substituting project versions.
    lock = {
        "lockfileVersion": "9.0",
        "settings": {"autoInstallPeers": True, "excludeLinksFromLockfile": False},
        "importers": {
            ".": {"devDependencies": {"fixture": {"specifier": "1.0.0", "version": "1.0.0(peer@2.0.0)"}}},
            "packages/rolldown": {"dependencies": {"fixture": {"specifier": "1.0.0", "version": "1.0.0(peer@2.0.0)"}}},
        },
        "packages": {
            "fixture@1.0.0": {"resolution": {"integrity": "sha512-Zml4dHVyZQ=="}, "peerDependencies": {"peer": "2.0.0"}},
            "peer@2.0.0": {"resolution": {"integrity": "sha512-cGVlcg=="}},
        },
        "snapshots": {"fixture@1.0.0(peer@2.0.0)": {"dependencies": {"peer": "2.0.0"}}, "peer@2.0.0": {}},
    }
    importers, packages, _patches, error = pnpm.parse_pnpm_lock_json(json.encode(lock), no_dev = False, no_optional = False)
    asserts.equals(env, None, error)
    before = json.encode([importers, packages])
    appendices = rolldown_js_build_appendices(importers)
    asserts.equals(env, ["", "packages/rolldown"], sorted(appendices))
    asserts.equals(env, before, json.encode([importers, packages]))
    asserts.true(env, "@merkur_rolldown_npm//:defs.bzl" in appendices["packages/rolldown"].preamble)
    asserts.true(env, 'srcs = [":package_data"]' in appendices["packages/rolldown"].body)
    asserts.true(env, "npm_link_all_packages()" in appendices[""].body)
    files = {"declared-darwin-arm64": "darwin_arm64", "declared-darwin-x64": "darwin_x64", "declared-linux-arm64": "linux_arm64", "declared-linux-x64": "linux_x64"}
    for os, arch, expected in [
        ("mac os x", "aarch64", "darwin_arm64"),
        ("mac os x", "arm64", "darwin_arm64"),
        ("mac os x", "x86_64", "darwin_x64"),
        ("mac os x", "amd64", "darwin_x64"),
        ("linux", "aarch64", "linux_arm64"),
        ("linux", "arm64", "linux_arm64"),
        ("linux", "x86_64", "linux_x64"),
        ("linux", "amd64", "linux_x64"),
    ]:
        asserts.equals(env, expected, rolldown_yq_platform(os, arch))
        asserts.equals(env, "declared-" + expected.replace("_", "-"), select_rolldown_yq(os, arch, files))
    asserts.equals(env, None, rolldown_yq_platform("windows", "amd64"))
    asserts.equals(env, None, rolldown_yq_platform("linux", "riscv64"))
    unittest.end(env)
    # Skylib emits this declared executable; include the owning nonce only in
    # TestRunner runfiles, never in the generated unit-test shell action.
    toolchain = ctx.toolchains["@bazel_skylib//toolchains/unittest:toolchain_type"].unittest_toolchain_info
    executable = ctx.actions.declare_file(ctx.label.name + toolchain.file_ext)
    runtime = ctx.runfiles(files = [executable])
    return [
        DefaultInfo(
            files = depset([executable]),
            executable = executable,
            runfiles = runtime.merge(ctx.runfiles(files = [test_nonce_file(ctx)])),
        ),
        TestRuntimeInfo(runfiles = runtime),
    ]

_importers_test = unittest.make(_importers_impl, attrs = {"_revocation_epochs": TEST_EPOCH_ATTRIBUTE})

def rolldown_js_dependencies_test_suite(name):
    unittest.suite(name, _importers_test)
