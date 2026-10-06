"""Public simulator targets over genuine captured release Cargo unit roots."""

load("//tools/bazel/bun:rules.bzl", "bun_command_test")

def declare_simulator_targets(build, tests, doctest):
    """Caller supplies actual configured release roots, selected by native platform."""
    if native.package_name() != "tools/sim":
        fail("Simulator targets require their original tools/sim source package")
    # Match the same original SourceFiles as contexts.simulator_manifests and
    # tools/sim:sources; a new harness cannot disappear behind a second list.
    harness_names = [
        source[len("tests/"):-len(".rs")]
        for source in native.glob(["tests/*.rs"], allow_empty = False)
    ]
    if sorted(tests.keys()) != sorted(["lib"] + harness_names):
        fail("Simulator configured roots must include its library and every original integration harness")
    if not build or not doctest:
        fail("Simulator needs genuine configured release build and original rustdoc roots")
    native.alias(name = "simulator", actual = build, tags = ["manual"])
    labels = []
    for name, harness in sorted(tests.items()):
        label = "test_" + name
        configured = "configured_" + name
        native.alias(name = configured, actual = harness, tags = ["manual"])
        bun_command_test(
            name = label,
            entry_point = "//tools/bazel/rust:sim_runner.ts",
            fixed_args = ["test"],
            data = ["//tools/bazel/rust:sim_runner.ts", "//tools/sim:regressions.json"],
            tools = {":" + configured: "simulator"},
            tool_environment = {"simulator": "MERKUR_SIM_BINARY"},
            bun_config = "//tools/bazel/bun:empty-bunfig.toml",
            size = "large",
            timeout = "long",
            tags = ["manual"],
        )
        labels.append(":" + label)
    # The captured rustdoc runner already retains original rustdoc arguments.
    native.alias(name = "test_doc", actual = doctest, tags = ["manual"])
    native.test_suite(name = "tests", tests = labels + [":test_doc"], tags = ["manual"])
    bun_command_test(
        name = "seed_sweep",
        entry_point = "//tools/bazel/rust:sim_runner.ts",
        fixed_args = ["sweep"],
        data = ["//tools/bazel/rust:sim_runner.ts", "//tools/sim:regressions.json"],
        tools = {":configured_sweep": "simulator"},
        tool_environment = {"simulator": "MERKUR_SIM_BINARY"},
        bun_config = "//tools/bazel/bun:empty-bunfig.toml",
        size = "large",
        timeout = "long",
        # Preserve original scheduled random campaigns as fresh executions.
        tags = ["manual", "external", "no-cache"],
    )
