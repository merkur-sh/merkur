"""Structural native loader controls never execute the constructed foreign images."""
import compression.zstd
import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("native_sdk", Path(__file__).with_name("extract-sdk.py"))
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)
ARM64 = 16777228
X64 = 16777223


def command(kind, name, base):
    value = name.encode() + b"\0"
    size = (base + len(value) + 7) // 8 * 8
    return struct.pack("<III", kind, size, base) + b"\0" * (base - 12) + value + b"\0" * (size - base - len(value))


def macho(cpu=ARM64, file_type=6, dependency=None):
    commands = b"" if dependency is None else command(0xC, dependency, 24) + command(0x8000001C, "@loader_path/../lib", 12)
    return struct.pack("<IIIIIIII", 0xFEEDFACF, cpu, 0, file_type, 0 if dependency is None else 2, len(commands), 0, 0) + commands


def elf(cpu, file_type=3):
    data = bytearray(64)
    data[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<HH", data, 16, file_type, cpu)
    struct.pack_into("<H", data, 54, 56)
    return bytes(data)


def elf_dynamic(cpu, dependency, rpath):
    strings = b"\0" + dependency.encode() + b"\0" + rpath.encode() + b"\0"
    dynamic_offset = 64 + 2 * 56
    strings_offset = dynamic_offset + 5 * 16
    dynamic = b"".join(struct.pack("<qQ", tag, value) for tag, value in [
        (5, 0x400000 + strings_offset), (10, len(strings)),
        (1, 1), (29, len(dependency) + 2), (0, 0),
    ])
    data = bytearray(elf(cpu))
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<H", data, 56, 2)
    size = strings_offset + len(strings)
    return bytes(data) + struct.pack("<IIQQQQQQ", 1, 5, 0, 0x400000, 0, size, size, 4096) + struct.pack("<IIQQQQQQ", 2, 6, dynamic_offset, 0x400000 + dynamic_offset, 0, len(dynamic), len(dynamic), 8) + dynamic + strings


def archive(root, members):
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w") as source:
        for name, data in members.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o755
            source.addfile(member, io.BytesIO(data))
    metadata = io.BytesIO()
    with tarfile.open(fileobj=metadata, mode="w"):
        pass
    file = root / "fixture.conda"
    with zipfile.ZipFile(file, "w") as package:
        package.writestr("pkg-fixture.tar.zst", compression.zstd.compress(payload.getvalue()))
        package.writestr("info-fixture.tar.zst", compression.zstd.compress(metadata.getvalue()))
    return [{"name": "structural-fixture", "path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "url": "https://example.invalid/never-executed-fixture"}]


class LoaderControls(unittest.TestCase):
    def linux_closure(self, dependency, rpath, library_path="lib/nested/libfixture.so"):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            specification = archive(root, {"bin/tool": elf_dynamic(62, dependency, rpath), library_path: elf(62)})
            output = root / "output"
            output.mkdir()
            return sdk.extract(specification, output, 62, ["bin/tool"])

    def test_linux_nested_loader_path_resolves_original_library(self):
        result = self.linux_closure("libfixture.so", "$ORIGIN/../lib/nested")
        self.assertEqual(result["native_loads"][0]["dependencies"], ["libfixture.so"])

    def test_linux_origin_itself_resolves_original_library(self):
        result = self.linux_closure("libfixture.so", "$ORIGIN", "bin/libfixture.so")
        self.assertEqual(result["native_loads"][1]["rpaths"], ["$ORIGIN"])

    def test_linux_loader_escape_refuses(self):
        with self.assertRaisesRegex(ValueError, "runtime search escapes"):
            self.linux_closure("libfixture.so", "$ORIGIN/../../outside")

    def test_linux_ambient_loader_search_refuses(self):
        with self.assertRaisesRegex(ValueError, "runtime search escapes"):
            self.linux_closure("libfixture.so", "/usr/local/lib")

    def test_linux_dependency_path_refuses(self):
        with self.assertRaisesRegex(ValueError, "declared loader name"):
            self.linux_closure("nested/libfixture.so", "$ORIGIN/../lib")

    def test_script_cannot_satisfy_required_native_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            specification = archive(root, {"bin/tool": b"#!/bin/sh\necho ambient\n"})
            output = root / "output"
            output.mkdir()
            with self.assertRaisesRegex(ValueError, "Mach-O executable image"):
                sdk.extract(specification, output, ARM64, ["bin/tool"])

    def test_native_executable_cannot_be_dynamic_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "tool"
            file.write_bytes(macho(file_type=6))
            file.chmod(0o755)
            with self.assertRaisesRegex(ValueError, "Mach-O executable image"):
                sdk.require_native_executable(file, ARM64)

    def test_required_native_executable_preserves_original_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = macho(file_type=2)
            specification = archive(root, {"bin/tool": original})
            output = root / "output"
            output.mkdir()
            sdk.extract(specification, output, ARM64, ["bin/tool"])
            self.assertEqual((output / "bin/tool").read_bytes(), original)

    def test_linux_native_executable_requires_declared_cpu_and_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "tool"
            file.write_bytes(elf(62, file_type=2))
            file.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "executable regular member"):
                sdk.require_native_executable(file, 62)
            file.chmod(0o755)
            sdk.require_native_executable(file, 62)
            with self.assertRaisesRegex(ValueError, "CPU disagrees"):
                sdk.require_native_executable(file, 183)

    def extract(self, library):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            members = {"bin/tool": macho(file_type=2, dependency="@rpath/libfixture.dylib")}
            if library is not None:
                members["lib/libfixture.dylib"] = library
            specification = archive(root, members)
            output = root / "output"
            output.mkdir()
            return sdk.extract(specification, output, ARM64)

    def test_exact_native_dynamic_library_is_preserved(self):
        result = self.extract(macho())
        self.assertEqual([item["path"] for item in result["native_loads"]], ["bin/tool", "lib/libfixture.dylib"])
        self.assertEqual(result["native_loads"][0]["dependencies"], ["@rpath/libfixture.dylib"])

    def test_text_cannot_satisfy_native_dependency(self):
        with self.assertRaisesRegex(ValueError, "Mach-O dynamic library"):
            self.extract(b"ordinary non-native library bytes")

    def test_executable_cannot_satisfy_dynamic_library(self):
        with self.assertRaisesRegex(ValueError, "Mach-O dynamic library"):
            self.extract(macho(file_type=2))

    def test_wrong_native_cpu_refuses(self):
        with self.assertRaisesRegex(ValueError, "CPU disagrees"):
            self.extract(macho(cpu=X64))

    def test_missing_native_library_refuses(self):
        with self.assertRaisesRegex(ValueError, "Unresolved declared native SDK library"):
            self.extract(None)

    def test_truncated_native_library_refuses(self):
        with self.assertRaisesRegex(ValueError, "Truncated native Mach-O"):
            self.extract(b"\xcf\xfa\xed\xfe")

    def test_universal_slice_checks_inner_native_cpu(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "library"
            image = macho(cpu=X64)
            file.write_bytes(struct.pack(">II", 0xCAFEBABE, 1) + struct.pack(">IIIII", ARM64, 0, 28, len(image), 0) + image)
            with self.assertRaisesRegex(ValueError, "CPU disagrees"):
                sdk.require_native_library(file, ARM64)

    def test_elf_dependency_requires_same_cpu_shared_object(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "library"
            for cpu in (62, 183):
                file.write_bytes(elf(cpu))
                sdk.require_native_library(file, cpu)
                file.write_bytes(elf(cpu, file_type=2))
                with self.assertRaisesRegex(ValueError, "ELF shared object"):
                    sdk.require_native_library(file, cpu)
                file.write_bytes(elf(183 if cpu == 62 else 62))
                with self.assertRaisesRegex(ValueError, "ELF CPU disagrees"):
                    sdk.require_native_library(file, cpu)

    def test_macho_machine_number_cannot_spoof_linux_family(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "library"
            file.write_bytes(macho(cpu=62))
            with self.assertRaisesRegex(ValueError, "declared Darwin CPU family"):
                sdk.require_native_library(file, 62)

    def test_elf_image_cannot_satisfy_darwin_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "library"
            file.write_bytes(elf(62))
            with self.assertRaisesRegex(ValueError, "declared Linux CPU family"):
                sdk.require_native_library(file, ARM64)


if __name__ == "__main__":
    unittest.main(verbosity=2)
