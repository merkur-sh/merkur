"""Constructor/retirement controls; these do not qualify the privileged lab."""

import ast
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
import sys


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


image = load("image")
runner = load("runner")
rootfs_builder = load("rootfs")


def rootfs(path, omit=None, additional=()):
    with tarfile.open(path, "w") as archive:
        for name in ("target", "target/debug", "merkur-lab"):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)
        for name in image.REQUIRED:
            if name == omit:
                continue
            entry = tarfile.TarInfo(name)
            entry.mode = 0o755
            payload = b"fixture bytes, not an executable runtime\n"
            entry.size = len(payload)
            archive.addfile(entry, io.BytesIO(payload))
        for entry in additional:
            archive.addfile(entry)


class HarnessBoundaryReached(Exception):
    pass


class NatlabHarnessControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.declaration = ast.parse(rule_source.read_text())
        implementation = next(node for node in cls.declaration.body if isinstance(node, ast.FunctionDef) and node.name == "_test_impl")
        cls.crate_info = object()
        cls.runtime_info = object()
        cls.image_info = object()
        def fail(message):
            raise ValueError(message)
        namespace = {"rust_common": SimpleNamespace(crate_info=cls.crate_info), "NatlabImageInfo": cls.image_info, "fail": fail}
        exec(compile(ast.Module(body=[implementation], type_ignores=[]), str(rule_source), "exec"), namespace)
        cls.implementation = staticmethod(namespace["_test_impl"])

    def invoke(self, *, is_test=True, name="merkur_dataplane", source="apps/daemon/dataplane/src/lib.rs", same_output=True):
        binary = object()
        crate = SimpleNamespace(is_test=is_test, name=name, root=SimpleNamespace(short_path=source), output=binary if same_output else object())
        def declared_file(_name):
            raise HarnessBoundaryReached("validated before descriptor creation")
        ctx = SimpleNamespace(
            attr=SimpleNamespace(dataplane={self.crate_info: crate}, runtime_image={self.image_info: object()}),
            executable=SimpleNamespace(dataplane=binary),
            file=SimpleNamespace(lab=object(), discovery=object(), portmap=object()),
            actions=SimpleNamespace(declare_file=declared_file),
            label=SimpleNamespace(name="original_natlab"),
        )
        self.implementation(ctx)

    def test_original_library_harness_reaches_descriptor_creation(self):
        with self.assertRaises(HarnessBoundaryReached):
            self.invoke()

    def test_zero_case_binary_harness_is_refused_before_actions(self):
        with self.assertRaisesRegex(ValueError, "library test binary"):
            self.invoke(name="merkur-dataplane", source="apps/daemon/dataplane/src/main.rs")

    def test_binary_source_cannot_claim_library_crate_name(self):
        with self.assertRaisesRegex(ValueError, "library test binary"):
            self.invoke(source="apps/daemon/dataplane/src/main.rs")

    def test_non_test_library_is_refused_before_actions(self):
        with self.assertRaisesRegex(ValueError, "library test binary"):
            self.invoke(is_test=False)

    def test_other_crate_library_is_refused_before_actions(self):
        with self.assertRaisesRegex(ValueError, "library test binary"):
            self.invoke(name="other_crate")

    def test_foreign_executable_cannot_substitute_for_library_output(self):
        with self.assertRaisesRegex(ValueError, "library test binary"):
            self.invoke(same_output=False)

    def test_native_attr_requires_actual_test_and_crate_providers(self):
        declaration = next(node for node in self.declaration.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "_natlab_test" for target in node.targets))
        attributes = next(keyword.value for keyword in declaration.value.keywords if keyword.arg == "attrs")
        attribute = next(value for key, value in zip(attributes.keys, attributes.values) if key.value == "dataplane")
        namespace = {"TestRuntimeInfo": self.runtime_info, "rust_common": SimpleNamespace(crate_info=self.crate_info)}
        providers = next(keyword.value for keyword in attribute.keywords if keyword.arg == "providers")
        self.assertEqual(eval(compile(ast.Expression(providers), str(rule_source), "eval"), namespace), [self.runtime_info, self.crate_info])
        self.assertTrue(next(keyword.value.value for keyword in attribute.keywords if keyword.arg == "mandatory"))
        self.assertEqual(next(keyword.value.value for keyword in attribute.keywords if keyword.arg == "cfg"), "target")


class NatlabCallerControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        declaration = ast.parse(caller_source.read_text())
        implementation = next(node for node in declaration.body if isinstance(node, ast.FunctionDef) and node.name == "natlab_qualified_targets")
        roots = ast.parse(bindings_source.read_text())
        binding_definition = next(node for node in roots.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "NATIVE_PROTOCOL_BINDINGS" for target in node.targets))
        cls.bindings = ast.literal_eval(binding_definition.value)
        cls.declaration = declaration
        cls.calls = []
        cls.producer_calls = []
        def fail(message):
            raise ValueError(message)
        namespace = {
            "fail": fail,
            "NATIVE_PROTOCOL_BINDINGS": cls.bindings,
            "natlab_test": lambda **args: cls.calls.append(args),
            "natlab_runtime_targets": lambda **args: cls.producer_calls.append(args),
        }
        exec(compile(ast.Module(body=[implementation], type_ignores=[]), str(caller_source), "exec"), namespace)
        cls.implementation = staticmethod(namespace["natlab_qualified_targets"])

    def setUp(self):
        self.calls.clear()
        self.producer_calls.clear()

    def invoke(self, docker_host="unix:///var/run/docker.sock", **overrides):
        self.implementation(
            name="natlab_live", runtime_images="natlab", stun="//apps/stun:merkur_stun",
            docker_host=docker_host, **overrides,
        )

    def test_both_native_labs_select_captured_library_role(self):
        self.invoke()
        self.assertEqual([call["name"] for call in self.calls], ["natlab_live_amd64", "natlab_live_arm64"])
        self.assertEqual([call["dataplane"] for call in self.calls], [self.bindings["dataplane_lib"]] * 2)
        self.assertEqual([call["stun"] for call in self.calls], ["//apps/stun:merkur_stun"] * 2)

    def test_existing_images_are_used_without_duplicate_producers(self):
        self.invoke()
        self.assertEqual([call["runtime_image"] for call in self.calls], [":natlab_image_amd64", ":natlab_image_arm64"])
        self.assertEqual(self.producer_calls, [])

    def test_original_scripts_cannot_be_replaced_by_caller(self):
        self.invoke()
        for call in self.calls:
            self.assertEqual(call["lab"], "//scripts:natlab/lab.sh")
            self.assertEqual(call["discovery"], "//scripts:natlab/discovery.sh")
            self.assertEqual(call["portmap"], "//scripts:natlab/portmap.sh")

    def test_native_docker_sdk_and_linux_constraints_are_exact(self):
        self.invoke()
        for call, architecture, cpu in zip(self.calls, ["amd64", "arm64"], ["x86_64", "aarch64"]):
            self.assertEqual(call["docker"], "@docker_cli_" + architecture + "//:docker")
            self.assertEqual(call["target_compatible_with"], ["@platforms//os:linux", "@platforms//cpu:" + cpu])
            self.assertEqual(call["docker_host"], "unix:///var/run/docker.sock")

    def test_actual_binary_harness_cannot_replace_generated_library_role(self):
        with self.assertRaisesRegex(TypeError, "native_bindings"):
            self.invoke(native_bindings={"dataplane_lib": self.bindings["dataplane_bin"]})
        self.assertEqual(self.calls, [])

    def test_foreign_library_cannot_replace_generated_role(self):
        with self.assertRaisesRegex(TypeError, "native_bindings"):
            self.invoke(native_bindings={"dataplane_lib": "//foreign:library"})
        self.assertEqual(self.calls, [])

    def test_generated_root_binding_is_loaded_as_sole_role_authority(self):
        binding_loads = [node.value for node in self.declaration.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == "load" and any(isinstance(argument, ast.Constant) and argument.value == "NATIVE_PROTOCOL_BINDINGS" for argument in node.value.args)]
        self.assertEqual(len(binding_loads), 1)
        self.assertEqual([argument.value for argument in binding_loads[0].args], ["//tools/bazel/rust/native_protocol:roots.bzl", "NATIVE_PROTOCOL_BINDINGS"])

    def test_ambient_or_remote_docker_backend_is_refused_before_registration(self):
        for backend in ["", "tcp://localhost:2375", "unix://relative"]:
            with self.subTest(backend=backend), self.assertRaisesRegex(ValueError, "Unix socket"):
                self.invoke(docker_host=backend)
            self.assertEqual(self.calls, [])


class NatlabControls(unittest.TestCase):
    def test_empty_conffiles_header_does_not_corrupt_version(self):
        record = rootfs_builder.paragraphs(b"Package: debian-archive-keyring\nVersion: 2025.1\nConffiles:\n /etc/keyring.asc aabb\nDescription: original package\n continuation\n")[0]
        self.assertEqual(record["Version"], "2025.1")
        self.assertEqual(record["Conffiles"], "\n/etc/keyring.asc aabb")

    def test_original_deb_envelope_is_required(self):
        for data in (b"", b"!<arch>\ntruncated", b"not a Debian archive"):
            with self.subTest(data=data), self.assertRaises(ValueError):
                rootfs_builder.ar_members(data)

    def test_original_doc_alias_resolves_actual_license_bytes(self):
        source = tarfile.TarInfo("usr/share/doc/original-source/copyright")
        source.size = 16
        alias = tarfile.TarInfo("usr/share/doc/binary-package")
        alias.type = tarfile.SYMTYPE
        alias.linkname = "original-source"
        entries = {source.name: (source, b"original license", "original.deb", source.name), alias.name: (alias, None, "alias.deb", alias.name)}
        self.assertEqual(rootfs_builder.resolve(entries, alias.name + "/copyright")[1:], (b"original license", "original.deb", source.name))

    def test_debian_version_relationships(self):
        pairs = [("1", "2"), ("1.9", "1.10"), ("1.0~rc1", "1.0"), ("1.0~~", "1.0~"), ("1.0a", "1.0+"), ("1.0-1", "1.0-2"), ("1.0-2", "1.0-2+b1"), ("1.0", "1:0"), ("2.41-12", "2.41-12+deb13u4")]
        for before, after in pairs:
            with self.subTest(before=before, after=after):
                self.assertLess(rootfs_builder.version_compare(before, after), 0)
                self.assertGreater(rootfs_builder.version_compare(after, before), 0)
        for left, right in [("1.01", "1.1"), ("0:1.0", "1.0"), ("1.0", "1.0-0")]:
            self.assertEqual(rootfs_builder.version_compare(left, right), 0)

    def test_missing_and_incompatible_dependencies_refused(self):
        facts = {"program": {"Version": "1", "Depends": "library (>= 2.0)"}}
        with self.assertRaisesRegex(ValueError, "absent"):
            rootfs_builder.validate_dependencies(facts, ["program"], {})
        facts["library"] = {"Version": "1.0"}
        with self.assertRaisesRegex(ValueError, "does not satisfy"):
            rootfs_builder.validate_dependencies(facts, ["program"], {})
        facts["library"]["Version"] = "2.0"
        rootfs_builder.validate_dependencies(facts, ["program"], {})

    def test_dependency_alternative_has_one_explicit_choice(self):
        facts = {"program": {"Version": "1", "Depends": "chosen | unused"}, "chosen": {"Version": "1"}}
        with self.assertRaises(KeyError):
            rootfs_builder.validate_dependencies(facts, ["program"], {})
        rootfs_builder.validate_dependencies(facts, ["program"], {"chosen | unused": "chosen"})

    def test_complete_archive_is_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "rootfs.tar"
            rootfs(source)
            image.build(source, directory / "a.tar", directory / "a.id", "arm64")
            image.build(source, directory / "b.tar", directory / "b.id", "arm64")
            self.assertEqual((directory / "a.tar").read_bytes(), (directory / "b.tar").read_bytes())
            self.assertEqual((directory / "a.id").read_bytes(), (directory / "b.id").read_bytes())
            self.assertEqual(runner.verify_image(directory / "a.tar", directory / "a.id"), (directory / "a.id").read_text().strip())

    def test_every_original_utility_is_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "rootfs.tar"
            for name in image.REQUIRED:
                with self.subTest(name=name):
                    rootfs(path, omit=name)
                    with self.assertRaisesRegex(ValueError, "missing rootfs member"):
                        image.validate_rootfs(path)

    def test_rootfs_path_escape_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "rootfs.tar"
            rootfs(path, additional=[tarfile.TarInfo("../outside")])
            with self.assertRaisesRegex(ValueError, "escapes"):
                image.validate_rootfs(path)

    def test_required_symlink_cycle_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "rootfs.tar"
            alias = tarfile.TarInfo("bin/bash")
            alias.type = tarfile.SYMTYPE
            alias.linkname = "bash"
            rootfs(path, omit="bin/bash", additional=[alias])
            with self.assertRaisesRegex(ValueError, "cycle"):
                image.validate_rootfs(path)

    def test_wrong_identity_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "rootfs.tar"
            rootfs(source)
            image.build(source, directory / "image.tar", directory / "image.id", "amd64")
            (directory / "image.id").write_text("sha256:" + "0" * 64)
            with self.assertRaisesRegex(ValueError, "digest"):
                runner.verify_image(directory / "image.tar", directory / "image.id")

    def test_lab_fail_with_exit_zero_is_failure(self):
        with self.assertRaises(RuntimeError):
            runner.assert_markers("RESULTS addr_punch=BLOCKED\nLAB=FAIL\n", ["LAB=PASS"])

    def test_missing_and_duplicated_success_are_failures(self):
        for output in ("", "LAB=PASS\nLAB=PASS\n", "LAB=PASS\nLAB=FAIL\n"):
            with self.subTest(output=output), self.assertRaises(RuntimeError):
                runner.assert_markers(output, ["LAB=PASS"])

    def test_original_two_phases_required(self):
        runner.assert_markers("DISCOVERY_LAB=PASS\nPORTMAP_LAB=PASS\n", ["DISCOVERY_LAB=PASS", "PORTMAP_LAB=PASS"])
        with self.assertRaises(RuntimeError):
            runner.assert_markers("DISCOVERY_LAB=PASS\n", ["DISCOVERY_LAB=PASS", "PORTMAP_LAB=PASS"])

    def test_owned_container_retired_after_failed_assertions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            executable = directory / "docker"
            log = directory / "commands"
            executable.write_text("#!" + sys.executable + "\nimport json,sys\nwith open(" + repr(str(log)) + ", 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\nif sys.argv[1:3]==['container','create']: print('1'*64)\nif sys.argv[1:3]==['container','start']: print('LAB=FAIL')\nif sys.argv[1:3]==['container','inspect']: print('0 false')\n")
            executable.chmod(0o755)
            with self.assertRaises(RuntimeError):
                runner.run_fixture(str(executable), {}, "sha256:" + "a" * 64, [], "original command", ["LAB=PASS"])
            commands = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(commands[-1][:3], ["container", "rm", "--force"])
            self.assertEqual(commands[-1][3], commands[0][commands[0].index("--name") + 1])
            self.assertIn("--network=none", commands[0])
            self.assertIn("--pull=never", commands[0])
            self.assertIn("--read-only", commands[0])
            self.assertFalse(any("apt" in argument or "cargo" in argument for command in commands for argument in command))

    def test_success_marker_cannot_hide_unsuccessful_container(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "docker"
            executable.write_text("#!" + sys.executable + "\nimport sys\nif sys.argv[1:3]==['container','create']: print('1'*64)\nif sys.argv[1:3]==['container','start']: print('LAB=PASS')\nif sys.argv[1:3]==['container','inspect']: print('17 false')\n")
            executable.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, "did not finish"):
                runner.run_fixture(str(executable), {}, "sha256:" + "a" * 64, [], "original command", ["LAB=PASS"])

    def test_success_marker_cannot_hide_retirement_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            executable = Path(temporary) / "docker"
            executable.write_text("#!" + sys.executable + "\nimport sys\nif sys.argv[1:3]==['container','create']: print('1'*64)\nif sys.argv[1:3]==['container','start']: print('LAB=PASS')\nif sys.argv[1:3]==['container','inspect']: print('0 false')\nif sys.argv[1:3]==['container','rm']: raise SystemExit(17)\n")
            executable.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, "exit 17"):
                runner.run_fixture(str(executable), {}, "sha256:" + "a" * 64, [], "original command", ["LAB=PASS"])

    def test_mount_keeps_declared_input_readonly(self):
        self.assertEqual(runner.mount(Path("/declared/input"), "/target/debug/merkur-stun"), ["--mount", "type=bind,src=/declared/input,dst=/target/debug/merkur-stun,readonly"])


if __name__ == "__main__":
    if len(sys.argv) < 4:
        raise ValueError("Natlab controls require the declared rule, caller and generated binding source Files")
    rule_source = Path(sys.argv.pop(1))
    caller_source = Path(sys.argv.pop(1))
    bindings_source = Path(sys.argv.pop(1))
    unittest.main()
