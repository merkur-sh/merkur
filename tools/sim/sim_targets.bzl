"""Original captured simulator roots; callers integrate only qualified native contexts."""

load("//tools/bazel/bun:rules.bzl", "bun_command_test")
load("//tools/bazel/rust:units.bzl", "configured_public_rust_test")

_HOSTS = {
    "aarch64-apple-darwin": ["@platforms//os:osx", "@platforms//cpu:aarch64"],
    "x86_64-apple-darwin": ["@platforms//os:osx", "@platforms//cpu:x86_64"],
    "aarch64-unknown-linux-gnu": ["@platforms//os:linux", "@platforms//cpu:aarch64"],
    "x86_64-unknown-linux-gnu": ["@platforms//os:linux", "@platforms//cpu:x86_64"],
}

def declare_simulator_targets(bindings):
    harnesses = [path[:-3] for path in native.glob(["tests/*.rs"])]
    harnesses = [path[len("tests/"):] for path in harnesses]
    if not bindings or not harnesses or "lib" in harnesses or "doctest" in harnesses:
        fail("Simulator requires original captured native bindings and authored harnesses")
    builds = {}
    scenarios = {}
    sweeps = {}
    for host, binding in bindings.items():
        if host not in _HOSTS or sorted(binding.keys()) != ["build", "doctest", "tests"]:
            fail("Simulator requires one original native library, harness inventory and rustdoc root")
        if sorted(binding["tests"].keys()) != sorted(["lib"] + harnesses):
            fail("Simulator must retain its library and every original authored harness")
        roots = [binding["build"], binding["doctest"]] + list(binding["tests"].values())
        if len(roots) != len({root: True for root in roots}):
            fail("Simulator captured root identities must be distinct")
        prefix = "//tools/bazel/rust/simulator/" + host + ":u_"
        for root in roots:
            if not root.startswith(prefix) or root.endswith("_binary"):
                fail("Simulator requires the original configured unit wrappers and rustdoc root")
        suffix = host.replace("-", "_")
        tests = []
        for role, binary in sorted(binding["tests"].items()):
            name = "simulator_test__" + suffix + "__" + role
            bun_command_test(
                name = name,
                entry_point = "//tools/bazel/rust:sim_runner.ts",
                tools = {binary: "merkur-sim"},
                tool_environment = {"merkur-sim": "MERKUR_SIM_BINARY"},
                data = [":sources"],
                fixed_args = ["test"],
                bun_config = "//tools/bazel/bun:empty-bunfig.toml",
                target_compatible_with = _HOSTS[host],
                exec_compatible_with = _HOSTS[host],
                tags = ["manual", "unqualified-simulator-runtime"],
                timeout = "long",
            )
            tests.append(":" + name)
        name = "simulator_test__" + suffix + "__doctest"
        configured_public_rust_test(
            name = name,
            binary = binding["doctest"],
            target_compatible_with = _HOSTS[host],
            exec_compatible_with = _HOSTS[host],
            tags = ["manual", "unqualified-simulator-runtime"],
            timeout = "long",
        )
        tests.append(":" + name)
        sweep = "configured_sweep__" + suffix
        bun_command_test(
            name = sweep,
            entry_point = "//tools/bazel/rust:sim_runner.ts",
            tools = {binding["tests"]["sweep"]: "merkur-sim"},
            tool_environment = {"merkur-sim": "MERKUR_SIM_BINARY"},
            data = [":sources"],
            fixed_args = ["sweep"],
            bun_config = "//tools/bazel/bun:empty-bunfig.toml",
            target_compatible_with = _HOSTS[host],
            exec_compatible_with = _HOSTS[host],
            tags = ["manual", "external", "no-cache", "unqualified-simulator-runtime"],
            timeout = "long",
        )
        selector = "//tools/bazel/rust/acquire:workspace_sdk_host_" + {
            "aarch64-apple-darwin": "darwin_arm64",
            "x86_64-apple-darwin": "darwin_x64",
            "aarch64-unknown-linux-gnu": "linux_arm64",
            "x86_64-unknown-linux-gnu": "linux_x64",
        }[host]
        builds[selector] = binding["build"]
        for role, test in zip(sorted(binding["tests"].keys()) + ["doctest"], tests):
            if role not in scenarios:
                scenarios[role] = {}
            scenarios[role][selector] = test
        sweeps[selector] = ":" + sweep
    native.alias(name = "simulator", actual = select(builds, no_match_error = "Simulator has no captured native release library for this host"), testonly = True, tags = ["manual"])
    scenario_tests = []
    for role, captured_tests in sorted(scenarios.items()):
        name = "scenario__" + role
        native.alias(
            name = name,
            actual = select(captured_tests, no_match_error = "Simulator has no captured native release harnesses for this host"),
            testonly = True,
            tags = ["manual"],
        )
        scenario_tests.append(":" + name)
    native.test_suite(name = "scenarios", tests = scenario_tests, tags = ["manual"])
    native.alias(name = "configured_sweep", actual = select(sweeps, no_match_error = "Simulator has no captured native sweep harness for this host"), testonly = True, tags = ["manual"])
