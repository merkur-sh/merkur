"""Actual archive/extraction controls; structural images are never executed as compilers."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("compiler", Path(__file__).with_name("darwin-compiler.py"))
compiler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compiler)
loader = compiler.load_loader(Path(__file__).with_name("extract-sdk.py"))


def command(kind, value, base):
    string = value.encode() + b"\0"
    size = (base + len(string) + 7) // 8 * 8
    return struct.pack("<III", kind, size, base) + bytes(base - 12) + string + bytes(size - base - len(string))


def image(cpu, role=2, dependencies=(), rpaths=()):
    commands = [command(0xC, value, 24) for value in dependencies] + [command(0x8000001C, value, 12) for value in rpaths]
    body = b"".join(commands)
    return struct.pack("<IIIIIIII", 0xFEEDFACF, cpu, 0, role, len(commands), len(body), 0, 0) + body


def write_archive(root, members, aliases=None):
    archive = root / "original.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        for name, content in members.items():
            entry = tarfile.TarInfo("original/" + name)
            entry.mode = 0o755 if name.startswith("bin/") else 0o644
            entry.size = len(content)
            output.addfile(entry, io.BytesIO(content))
        for name, target in (aliases or {}).items():
            entry = tarfile.TarInfo("original/" + name)
            entry.type = tarfile.SYMTYPE
            entry.linkname = target
            output.addfile(entry)
    return archive


RELEASE = {"product": "Xcode", "version": "0.0", "build": "0STRUCTURAL0"}


def request(archive, cpu="aarch64"):
    return {"archive": {"sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "size": archive.stat().st_size},
            "source": dict(RELEASE),
            "execution_cpu": cpu, "strip_prefix": "original",
            "tools": {name: "bin/" + name for name in compiler.TOOLS},
            "sysroot": "sdk", "resource_dir": "resource", "cxx_headers": "cxx",
            "licenses": ["LICENSE"]}


def members(cpu=16777228, dependencies=(), rpaths=()):
    return dict({"bin/" + name: image(cpu, dependencies=dependencies, rpaths=rpaths) for name in compiler.TOOLS},
                **{"sdk/usr/include/stdio.h": b"structural sdk header", "resource/include/stddef.h": b"structural resource header", "cxx/vector": b"structural cxx header", "LICENSE": b"structural fixture license"})


class CompilerControls(unittest.TestCase):
    def materialize(self, entries=None, mutate=None, aliases=None, cpu="aarch64"):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = write_archive(root, members(compiler.CPUS[cpu]) if entries is None else entries, aliases)
            declaration = request(archive, cpu)
            if mutate:
                mutate(declaration)
            return compiler.extract(archive, root / "result", declaration, loader)

    def test_real_tar_inventory_preserves_each_native_cpu_without_claiming_compilation(self):
        for cpu in compiler.CPUS:
            result = self.materialize(cpu=cpu)
            self.assertEqual(set(result), set(members()))

    def test_original_archive_digest_and_size_both_required(self):
        for key, value in (("sha256", "0" * 64), ("size", 1)):
            with self.assertRaisesRegex(ValueError, "digest or size"):
                self.materialize(mutate=lambda declaration: declaration["archive"].update({key: value}))

    def test_exact_complete_native_tools_and_directories_required(self):
        for name in compiler.TOOLS:
            broken = members()
            del broken["bin/" + name]
            with self.assertRaises(FileNotFoundError):
                self.materialize(broken)
        for name in ("sdk/usr/include/stdio.h", "resource/include/stddef.h", "cxx/vector", "LICENSE"):
            broken = members()
            del broken[name]
            with self.assertRaises((ValueError, FileNotFoundError)):
                self.materialize(broken)

    def test_wrong_native_cpu_and_script_tools_refuse(self):
        for content in (image(16777223), b"#!/bin/sh\necho ambient tool\n", image(16777228, role=6)):
            broken = members()
            broken["bin/clang"] = content
            with self.assertRaises(ValueError):
                self.materialize(broken)

    def test_declared_relative_runtime_and_inherited_rpath_resolve(self):
        entries = members(dependencies=["@rpath/libclang.dylib"], rpaths=["@loader_path/../lib"])
        entries["lib/libclang.dylib"] = image(16777228, role=6, dependencies=["@rpath/libhelper.dylib"])
        entries["lib/libhelper.dylib"] = image(16777228, role=6)
        self.assertIn("lib/libhelper.dylib", self.materialize(entries))

    def test_absent_and_wrong_role_runtime_do_not_use_basename_fallback(self):
        for dependency, payload in (("@rpath/libclang.dylib", None), ("/ambient/libclang.dylib", image(16777228, role=6)), ("@rpath/libclang.dylib", image(16777228, role=2))):
            entries = members(dependencies=[dependency], rpaths=["@loader_path/../lib"])
            if payload is not None:
                entries["lib/libclang.dylib"] = payload
            with self.assertRaises(ValueError):
                self.materialize(entries)

    def test_escaping_runtime_search_refuses_even_when_unused(self):
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.materialize(members(rpaths=["@loader_path/../../../ambient"]))

    def test_qualified_os_libraries_are_explicit_process_dependencies(self):
        self.assertTrue(self.materialize(members(dependencies=["/usr/lib/libSystem.B.dylib"], rpaths=["/usr/lib/swift"])))
        self.assertTrue(self.materialize(members(dependencies=["@rpath/libswiftCore.dylib"], rpaths=["/usr/lib/swift"])))
        with self.assertRaises(ValueError):
            self.materialize(members(rpaths=["/usr/lib/../../ambient"]))

    def test_internal_alias_keeps_original_topology_and_external_alias_refuses(self):
        result = self.materialize(aliases={"sdk/current.h": "usr/include/stdio.h"})
        self.assertIn("sdk/current.h", result)
        for target in ("/usr/include/stdio.h", "../../../ambient", "absent"):
            with self.assertRaises((ValueError, FileNotFoundError, tarfile.FilterError)):
                self.materialize(aliases={"sdk/current.h": target})

    def test_sdk_directory_alias_exposes_finite_files_and_preserves_original_cycles(self):
        result = self.materialize(aliases={"sdk/headers": "usr/include"})
        self.assertIn("sdk/headers/stdio.h", result)
        self.assertNotIn("sdk/headers", result)
        cycle = self.materialize(aliases={"sdk/cycle": "."})
        self.assertEqual(set(cycle), set(members()))

    def test_malformed_native_load_table_refuses(self):
        broken = members()
        binary = bytearray(broken["bin/clang"])
        struct.pack_into("<I", binary, 20, 8)
        broken["bin/clang"] = bytes(binary)
        with self.assertRaisesRegex(ValueError, "command inventory"):
            self.materialize(broken)

    def test_exact_original_member_paths_and_native_selection_required(self):
        for change in (lambda value: value.update(execution_cpu="wasm32"), lambda value: value.update(sysroot="../installed"), lambda value: value["tools"].pop("ranlib"), lambda value: value.update(licenses=[])):
            with self.assertRaises(ValueError):
                self.materialize(mutate=change)

    def test_conflicting_tar_member_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "original.tar"
            with tarfile.open(archive, "w") as output:
                for _ in range(2):
                    entry = tarfile.TarInfo("original/member")
                    entry.size = 1
                    output.addfile(entry, io.BytesIO(b"x"))
            with self.assertRaisesRegex(ValueError, "duplicate"):
                compiler.extract(archive, root / "result", request(archive), loader)

    def test_artifact_inventory_preserves_colon_files_and_recursive_aliases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = members()
            entries["sdk/manual/Module::Name.3"] = b"original colon filename"
            archive = write_archive(root, entries, {"sdk/cycle": "."})
            compiler.extract(archive, root / "result", request(archive), loader)
            inventory = compiler.archive_members(archive, "original")
            self.assertIn({"path": "sdk/manual/Module::Name.3", "kind": "file"}, inventory)
            self.assertIn({"path": "sdk/cycle", "kind": "symlink"}, inventory)
            self.assertEqual(os.readlink(root / "result/sdk/cycle"), ".")
            self.assertEqual(len(inventory), len(entries) + 1)

    def export_fixture(self, source, cpu=16777228):
        specification = importlib.util.spec_from_file_location("exporter", Path(__file__).with_name("darwin-export.py"))
        exporter = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(exporter)
        toolchain = source / exporter.TOOLCHAIN
        for name in set(exporter.TOOLS.values()) | set(exporter.HELPERS) | set(exporter.SWIFT_TOOLS.values()):
            file = toolchain / "bin" / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(image(cpu, dependencies=["@loader_path/../lib/original.dylib"]))
            file.chmod(0o755)
        library = toolchain / "lib/original.dylib"
        library.parent.mkdir(parents=True, exist_ok=True)
        library.write_bytes(image(cpu, role=6))
        resource = toolchain / "lib/clang/21.0.0/include/stddef.h"
        resource.parent.mkdir(parents=True)
        resource.write_bytes(b"structural original resource header")
        (toolchain / "lib/clang/21").symlink_to("21.0.0")
        for resource in exporter.SWIFT_RESOURCES:
            file = toolchain / resource / "original-public-resource"
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"structural original Swift resource")
        for name in [exporter.SDK + "/usr/include/c++/v1/vector", exporter.SDK + "/usr/include/stdio.h", exporter.SDK + "/manual/Module::Name.3"] + exporter.LICENSES:
            file = source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"structural original member")
        (source / exporter.SDK / "cycle").symlink_to(".")
        return exporter

    def test_signed_source_export_is_deterministic_and_normalizes_loader_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "bundle"
            exporter = self.export_fixture(source)
            forbidden = source / "developer-account-settings"
            forbidden.write_bytes(b"synthetic private content must never be copied")
            first = exporter.export(source, root / "first.tar.gz", compiler, execution_cpu="aarch64")
            second = exporter.export(source, root / "second.tar.gz", compiler, execution_cpu="aarch64")
            self.assertEqual(first["archive"]["sha256"], second["archive"]["sha256"])
            inventory = compiler.archive_members(root / "first.tar.gz", "original")
            self.assertNotIn("developer-account-settings", [entry["path"] for entry in inventory])
            self.assertIn({"path": exporter.TOOLCHAIN + "/lib/original.dylib", "kind": "file"}, inventory)
            self.assertIn({"path": exporter.SDK + "/cycle", "kind": "symlink"}, inventory)

    def test_signed_source_export_rejects_alias_outside_explicit_apple_whitelist(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "bundle"
            exporter = self.export_fixture(source)
            outside = source / "developer-account-settings"
            outside.write_bytes(b"synthetic excluded content")
            (source / exporter.SDK / "outside").symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "whitelist"):
                exporter.export(source, root / "refused.tar.gz", compiler, execution_cpu="aarch64")

    def test_original_runtime_after_os_rpath_is_captured_before_os_only_membership(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "lib/original.dylib"
            original.parent.mkdir()
            original.write_bytes(image(16777228, role=6))
            system = Path("/usr/lib/swift/XcodeDefault/../libNeverInstalledStructuralFixture.dylib")
            self.assertEqual(compiler.resolve_runtime(root, "@rpath/original.dylib", [system, original]), original)
            original.unlink()
            self.assertIsNone(compiler.resolve_runtime(root, "@rpath/original.dylib", [system, original]))

    def test_swift_export_retains_public_original_tools_modules_and_not_account_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exporter = self.export_fixture(root / "bundle")
            result = exporter.export(root / "bundle", root / "archive.tar.gz", compiler, execution_cpu="aarch64")
            members = {item["path"] for item in compiler.archive_members(root / "archive.tar.gz", "original")}
            self.assertEqual(set(result["swift"]["tools"]), {"swiftc", "frontend", "plugin_server", "driver"})
            for name in list(result["swift"]["tools"].values()) + [exporter.TOOLCHAIN + "/" + value + "/original-public-resource" for value in exporter.SWIFT_RESOURCES]:
                self.assertIn(name, members)

    def test_swift_export_refuses_missing_original_driver_and_wrong_native_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exporter = self.export_fixture(root / "bundle")
            frontend = root / "bundle" / exporter.TOOLCHAIN / "bin/swift-frontend"
            frontend.unlink()
            with self.assertRaises(FileNotFoundError):
                exporter.export(root / "bundle", root / "absent.tar.gz", compiler, execution_cpu="aarch64")
            frontend.write_bytes(image(16777223))
            frontend.chmod(0o755)
            with self.assertRaisesRegex(ValueError, "CPU disagrees"):
                exporter.export(root / "bundle", root / "wrong-cpu.tar.gz", compiler, execution_cpu="aarch64")

    def test_export_requires_explicit_cpu_and_rejects_unsupported_cpu_before_source_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exporter = self.export_fixture(root / "bundle")
            with self.assertRaises(TypeError):
                exporter.export(root / "bundle", root / "missing.tar.gz", compiler)
            for cpu in ("arm64", "amd64", "wasm32", None):
                with self.assertRaisesRegex(ValueError, "explicit native Darwin execution CPU"):
                    exporter.export(root / "absent-source", root / "unsupported.tar.gz", compiler, execution_cpu=cpu)
            self.assertFalse((root / "missing.tar.gz").exists())
            self.assertFalse((root / "unsupported.tar.gz").exists())

    def test_export_cli_requires_cpu_and_uses_same_original_native_member_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exporter = self.export_fixture(root / "bundle", cpu=compiler.CPUS["x86_64"])
            args = [sys.executable, "-B", "-I", exporter.__file__,
                    "--source-bundle", str(root / "bundle"),
                    "--archive", str(root / "original.tar.gz"),
                    "--compiler-extractor", compiler.__file__, "--output", str(root / "result.json")]
            for extra in ([], ["--execution-cpu", "arm64"]):
                refused = subprocess.run(args + extra, env={"PATH": ""}, capture_output=True)
                self.assertEqual(refused.returncode, 2)
                self.assertIn(b"--execution-cpu", refused.stderr)
                self.assertFalse((root / "original.tar.gz").exists())
                self.assertFalse((root / "result.json").exists())
            result = subprocess.run(args + ["--execution-cpu", "x86_64"], env={"PATH": ""}, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            original = json.loads((root / "result.json").read_bytes())
            self.assertEqual(original["execution_cpu"], "x86_64")
            self.assertEqual(original["archive"]["sha256"], hashlib.sha256((root / "original.tar.gz").read_bytes()).hexdigest())

    def test_explicit_native_exports_preserve_original_archive_and_public_swift_closure(self):
        for execution_cpu, cpu in compiler.CPUS.items():
            with self.subTest(execution_cpu=execution_cpu), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                exporter = self.export_fixture(root / "bundle", cpu=cpu)
                result = exporter.export(root / "bundle", root / "first.tar.gz", compiler, execution_cpu=execution_cpu)
                repeated = exporter.export(root / "bundle", root / "second.tar.gz", compiler, execution_cpu=execution_cpu)
                self.assertEqual(result["execution_cpu"], execution_cpu)
                self.assertEqual(result["archive"]["sha256"], repeated["archive"]["sha256"])
                request = exporter.specification(result, dict(RELEASE), compiler)
                output = root / "extracted"
                compiler.extract(root / "first.tar.gz", output, request, loader)
                for name in list(result["tools"].values()) + list(result["swift"]["tools"].values()):
                    self.assertEqual((output / name).read_bytes(), (root / "bundle" / name).read_bytes())
                    self.assertIsNotNone(loader.macho_image((output / name).read_bytes(), cpu))
                for name in exporter.SWIFT_RESOURCES:
                    member = exporter.TOOLCHAIN + "/" + name + "/original-public-resource"
                    self.assertEqual((output / member).read_bytes(), (root / "bundle" / member).read_bytes())
                self.assertTrue((output / exporter.SDK / "cycle").is_symlink())

    def test_explicit_cpu_refuses_wrong_original_executable_and_loader_library_without_archive(self):
        for execution_cpu, cpu in compiler.CPUS.items():
            for tool in ("clang", "swift-frontend", "original.dylib"):
                with self.subTest(execution_cpu=execution_cpu, tool=tool), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    exporter = self.export_fixture(root / "bundle", cpu=cpu)
                    member = exporter.TOOLCHAIN + ("/lib/" if tool.endswith(".dylib") else "/bin/") + tool
                    file = root / "bundle" / member
                    other_cpu = next(value for value in compiler.CPUS.values() if value != cpu)
                    file.write_bytes(image(other_cpu, role=6 if tool.endswith(".dylib") else 2))
                    with self.assertRaisesRegex(ValueError, "CPU disagrees"):
                        exporter.export(root / "bundle", root / "refused.tar.gz", compiler, execution_cpu=execution_cpu)
                    self.assertFalse((root / "refused.tar.gz").exists())

    def test_export_pin_names_digest_size_and_release_without_origin_or_local_source_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "bundle"
            exporter = self.export_fixture(source)
            version = source / exporter.VERSION
            version.write_bytes(plistlib.dumps({"CFBundleShortVersionString": RELEASE["version"], "ProductBuildVersion": RELEASE["build"]}))
            result = exporter.export(source, root / "original.tar.gz", compiler, execution_cpu="aarch64")
            self.assertNotIn(exporter.VERSION, [entry["path"] for entry in compiler.archive_members(root / "original.tar.gz", "original")])
            self.assertEqual(exporter.source_release(source), RELEASE)
            request = exporter.specification(result, exporter.source_release(source), compiler)
            compiler.validate_request(request)
            self.assertEqual(request["archive"], {"sha256": result["archive"]["sha256"], "size": result["archive"]["size"]})
            self.assertEqual(request["source"], RELEASE)
            self.assertEqual(request["strip_prefix"], "original")
            self.assertNotIn("source_bundle", request)
            for release in (None, {}, dict(RELEASE, product="CommandLineTools"), dict(RELEASE, build=""), dict(RELEASE, url="https://example.invalid/a")):
                with self.assertRaises(ValueError):
                    exporter.specification(result, release, compiler)
            with self.assertRaisesRegex(ValueError, "digest and size"):
                compiler.validate_request(dict(request, archive=dict(request["archive"], url="https://example.invalid/published.tar.gz")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
