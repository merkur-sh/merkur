"""Exercise original host-dependent bootstrap declarations without acquisitions."""
import ast
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

EXTENSION = Path(sys.argv[1])
PINS = {name: json.loads(Path(path).read_text()) for name, path in zip(
    ["darwin-pins.json", "linux-redis-pins.json", "linux-tools-pins.json", "git-build-pins.json"],
    sys.argv[2:6], strict=True,
)}
sys.argv = [sys.argv[0]]


def implementation():
    tree = ast.parse(EXTENSION.read_text())
    selected = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_native_tools_impl":
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in ["_PYTHON", "native_tools"]
            for target in node.targets
        ):
            selected.append(node)
    calls = []
    def declaration(kind):
        return lambda **kwargs: calls.append({"kind": kind, **kwargs})
    def fail(message):
        raise ValueError(message)
    namespace = {
        "json": SimpleNamespace(decode=json.loads, encode=json.dumps),
        "Label": str,
        "http_archive": declaration("python"),
        "_darwin_sdk": declaration("sdk"),
        "git_source_distribution": declaration("git_source"),
        "module_extension": lambda **kwargs: kwargs,
        "fail": fail,
    }
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(EXTENSION), "exec"), namespace)
    return namespace, calls


def capture(os_name, architecture):
    namespace, calls = implementation()
    context = SimpleNamespace(
        os=SimpleNamespace(name=os_name, arch=architecture),
        read=lambda label: json.dumps(PINS[label.rsplit(":", 1)[1]]),
        extension_metadata=lambda **kwargs: kwargs,
    )
    metadata = namespace["_native_tools_impl"](context)
    return namespace, calls, metadata


class NativeBootstrapHost(unittest.TestCase):
    def test_original_definition_records_both_host_dependencies(self):
        namespace, _ = implementation()
        self.assertIs(namespace["native_tools"].get("os_dependent"), True)
        self.assertIs(namespace["native_tools"].get("arch_dependent"), True)
        self.assertIs(namespace["native_tools"]["implementation"], namespace["_native_tools_impl"])

    def test_four_hosts_use_the_exact_original_python_pin_for_every_sdk(self):
        for os_name, architecture, platform in [
            ("mac os x", "aarch64", "darwin_arm64"),
            ("mac os x", "x86_64", "darwin_x64"),
            ("linux", "aarch64", "linux_arm64"),
            ("linux", "x86_64", "linux_x64"),
        ]:
            with self.subTest(platform=platform):
                namespace, calls, metadata = capture(os_name, architecture)
                original = namespace["_PYTHON"][platform]
                sdk_calls = [call for call in calls if call["kind"] == "sdk"]
                self.assertEqual(len(sdk_calls), 8)
                self.assertEqual({(call["python_url"], call["python_sha256"]) for call in sdk_calls}, {original})
                self.assertEqual(metadata, {"reproducible": True})
                self.assertEqual([call for call in calls if call["kind"] == "git_source"], [{"kind": "git_source", "name": "git_declared_shell_source"}])
                python = {call["name"]: (call["urls"][0], call["sha256"]) for call in calls if call["kind"] == "python"}
                self.assertEqual(python, {"python_" + name: pin for name, pin in namespace["_PYTHON"].items()})

    def test_every_sdk_keeps_original_package_pins_and_native_cpu(self):
        _, calls, _ = capture("mac os x", "arm64")
        actual = {call["name"]: call for call in calls if call["kind"] == "sdk"}
        for filename, prefix, cpus in [
            ("darwin-pins.json", "tools_", {"darwin_arm64": 16777228, "darwin_x64": 16777223}),
            ("linux-redis-pins.json", "redis_", {"linux_arm64": 183, "linux_x64": 62}),
            ("linux-tools-pins.json", "tools_", {"linux_arm64": 183, "linux_x64": 62}),
            ("git-build-pins.json", "build_tools_", {"darwin_arm64": 16777228, "darwin_x64": 16777223}),
        ]:
            for platform, cpu in cpus.items():
                call = actual[prefix + platform]
                self.assertEqual(json.loads(call["packages"]), PINS[filename]["platforms"][platform])
                self.assertEqual(call["cpu"], cpu)

    def test_supported_architecture_aliases_preserve_exact_declarations(self):
        for os_name in ["mac os x", "linux"]:
            for first, second in [("arm64", "aarch64"), ("amd64", "x86_64")]:
                self.assertEqual(capture(os_name, first)[1:], capture(os_name, second)[1:])

    def test_unsupported_acquisition_hosts_refuse(self):
        for os_name, architecture in [("windows", "x86_64"), ("linux", "riscv64"), ("mac os x", "i386")]:
            with self.subTest(os=os_name, architecture=architecture):
                with self.assertRaisesRegex(ValueError, "Native SDK acquisition requires Darwin/Linux ARM64/x64"):
                    capture(os_name, architecture)


if __name__ == "__main__":
    unittest.main()
