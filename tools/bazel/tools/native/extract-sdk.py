"""Extract verified conda payloads without executing package installers or activation scripts."""
import compression.zstd
import hashlib
import io
import json
from pathlib import Path
import sys
import struct
import tarfile
import zipfile

def digest(data):
    return hashlib.sha256(data).hexdigest()

def elf_loads(data, expected_cpu):
    if expected_cpu not in (62, 183):
        raise ValueError("Native ELF requires a declared Linux CPU family")
    if len(data) < 64 or data[:6] != b'\x7fELF\x02\x01':
        raise ValueError("Native ELF requires a complete64-bit little-endian header")
    cpu = struct.unpack_from("<H", data, 18)[0]
    if cpu != expected_cpu:
        raise ValueError("Native SDK ELF CPU disagrees with declared platform")
    offset = struct.unpack_from("<Q", data, 32)[0]
    width, count = struct.unpack_from("<HH", data, 54)
    if width != 56 or offset + width * count > len(data):
        raise ValueError("Invalid native ELF program header inventory")
    segments, dynamic, interpreter = [], [], None
    for index in range(count):
        kind, _, file_offset, address, _, size, _, _ = struct.unpack_from("<IIQQQQQQ", data, offset + index * width)
        if file_offset + size > len(data):
            raise ValueError("Invalid native ELF segment range")
        segments.append((kind, file_offset, address, size))
        if kind == 3:
            if not size or data[file_offset + size - 1] != 0:
                raise ValueError("Invalid native ELF interpreter")
            interpreter = data[file_offset:file_offset + size - 1].decode()
        if kind == 2:
            if size % 16:
                raise ValueError("Invalid native ELF dynamic table")
            terminated = False
            for at in range(file_offset, file_offset + size, 16):
                tag, value = struct.unpack_from("<qQ", data, at)
                if tag == 0:
                    terminated = True
                    break
                dynamic.append((tag, value))
            if not terminated:
                raise ValueError("Unterminated native ELF dynamic table")
    strings = [value for tag, value in dynamic if tag == 5]
    lengths = [value for tag, value in dynamic if tag == 10]
    if dynamic and (len(strings) != 1 or len(lengths) != 1):
        raise ValueError("Invalid native ELF dynamic string authority")
    string_offset = None
    if strings:
        for kind, file_offset, address, size in segments:
            if kind == 1 and address <= strings[0] and strings[0] + lengths[0] <= address + size:
                string_offset = file_offset + strings[0] - address
                break
        if string_offset is None:
            raise ValueError("Native ELF string table is not mapped")
    def name(value):
        if string_offset is None or value >= lengths[0]:
            raise ValueError("Native ELF string exceeds declared table")
        content = data[string_offset + value:string_offset + lengths[0]]
        if b'\0' not in content:
            raise ValueError("Unterminated native ELF dynamic string")
        return content.split(b'\0', 1)[0].decode()
    return {"cpu": cpu, "interpreter": interpreter,
            "dependencies": [name(value) for tag, value in dynamic if tag == 1],
            "rpaths": [name(value) for tag, value in dynamic if tag in (15, 29)]}

def macho_image(data, expected_cpu):
    if data[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf", b"\xcf\xfa\xed\xfe") and expected_cpu not in (16777223, 16777228):
        raise ValueError("Native Mach-O requires a declared Darwin CPU family")
    if data[:4] in [b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"]:
        if len(data) < 8:
            raise ValueError("Truncated native universal Mach-O")
        count = struct.unpack_from(">I", data, 4)[0]
        width = 32 if data[:4] == b"\xca\xfe\xba\xbf" else 20
        if count > (len(data) - 8) // width:
            raise ValueError("Invalid native universal Mach-O inventory")
        slices = []
        for index in range(count):
            base = 8 + index * width
            cpu = struct.unpack_from(">I", data, base)[0]
            offset, size = struct.unpack_from(">QQ" if width == 32 else ">II", data, base + 8)
            if offset + size > len(data):
                raise ValueError("Invalid native universal Mach-O slice")
            if cpu == expected_cpu:
                slices.append(data[offset:offset + size])
        if len(slices) != 1:
            raise ValueError("Native SDK lacks its exact universal CPU slice")
        data = slices[0]
    if data[:4] != b"\xcf\xfa\xed\xfe":
        return None
    if len(data) < 32:
        raise ValueError("Truncated native Mach-O")
    if struct.unpack_from("<I", data, 4)[0] != expected_cpu:
        raise ValueError("Native SDK Mach-O CPU disagrees with declared platform")
    return data

def require_native_library(file, expected_cpu):
    data = file.read_bytes()
    if data[:4] == b"\x7fELF":
        elf_loads(data, expected_cpu)
        if struct.unpack_from("<H", data, 16)[0] != 3:
            raise ValueError("Native SDK dependency requires an ELF shared object")
        return
    image = macho_image(data, expected_cpu)
    if image is None or struct.unpack_from("<I", image, 12)[0] != 6:
        raise ValueError("Native SDK dependency requires a Mach-O dynamic library")

def require_native_executable(file, expected_cpu):
    if not file.is_file() or not file.stat().st_mode & 0o111:
        raise ValueError("Native SDK executable requires an executable regular member")
    data = file.read_bytes()
    if data[:4] == b"\x7fELF":
        elf_loads(data, expected_cpu)
        if struct.unpack_from("<H", data, 16)[0] not in (2, 3):
            raise ValueError("Native SDK executable requires an ELF executable image")
        return
    image = macho_image(data, expected_cpu)
    if image is None or struct.unpack_from("<I", image, 12)[0] != 2:
        raise ValueError("Native SDK executable requires a Mach-O executable image")

def extract(specification, destination, expected_cpu, required_binaries=()):
    prefix = Path(destination)
    for item in specification:
        archive = Path(item["path"])
        if digest(archive.read_bytes()) != item["sha256"]:
            raise ValueError("Native package digest mismatch")
        with zipfile.ZipFile(archive) as package:
            names = package.namelist()
            payloads = [name for name in names if name.startswith("pkg-") and name.endswith(".tar.zst")]
            metadata = [name for name in names if name.startswith("info-") and name.endswith(".tar.zst")]
            if len(payloads) != 1 or len(metadata) != 1:
                raise ValueError("Invalid native package inventory")
            for name, output in [(payloads[0], prefix), (metadata[0], prefix / ".package-metadata" / item["name"])]:
                with tarfile.open(fileobj=io.BytesIO(compression.zstd.decompress(package.read(name)))) as source:
                    for member in source.getmembers():
                        parts = Path(member.name).parts
                        if not parts or Path(member.name).is_absolute() or ".." in parts or parts[0] in [".bootstrap", ".archives", ".package-metadata"]:
                            raise ValueError("Unsafe native package path")
                    for member in source.getmembers():
                        member_output = prefix / ".package-metadata" / item["name"] / "payload" if output == prefix and Path(member.name).parts[0] == "info" else output
                        target = member_output / member.name
                        if target.exists() or target.is_symlink():
                            if member.isdir() and target.is_dir() and not target.is_symlink():
                                continue
                            if member.issym() and target.is_symlink() and str(target.readlink()) == member.linkname:
                                continue
                            if member.isfile() and target.is_file() and not target.is_symlink():
                                incoming = source.extractfile(member)
                                if incoming is not None and incoming.read() == target.read_bytes():
                                    continue
                            raise ValueError("Conflicting native package ownership: " + item["name"] + ":" + member.name)
                        source.extract(member, member_output, filter="data")
    shell = prefix / "bin" / "sh"
    if (prefix / "bin" / "bash").exists() and not shell.exists():
        shell.symlink_to("bash")
    for member in required_binaries:
        relative = Path(member)
        if relative.is_absolute() or len(relative.parts) != 2 or relative.parts[0] != "bin":
            raise ValueError("Native SDK executable must be an exact bin member")
        executable = prefix / relative
        if not executable.resolve().is_relative_to(prefix.resolve()):
            raise ValueError("Native SDK executable escapes its declared SDK")
        require_native_executable(executable, expected_cpu)
    loads = []
    for file in sorted((prefix / "bin").glob("*")) + sorted((prefix / "lib").rglob("*")) + sorted((prefix / "libexec").rglob("*")):
        if not file.is_file() or file.is_symlink():
            continue
        data = file.read_bytes()
        if data[:4] == b"\x7fELF":
            facts = elf_loads(data, expected_cpu)
            expected_interpreter = "/lib/ld-linux-aarch64.so.1" if expected_cpu == 183 else "/lib64/ld-linux-x86-64.so.2" if expected_cpu == 62 else None
            if expected_interpreter is None or facts["interpreter"] not in (None, expected_interpreter):
                raise ValueError("Native ELF interpreter disagrees with qualified GNU SDK")
            search_directories = [prefix / "lib"]
            for search in facts["rpaths"]:
                for entry in search.split(":"):
                    if entry == "$ORIGIN":
                        directory = file.parent
                    elif entry.startswith("$ORIGIN/"):
                        directory = file.parent / entry.removeprefix("$ORIGIN/")
                    else:
                        raise ValueError("Native ELF runtime search escapes declared SDK")
                    if not directory.resolve().is_relative_to(prefix.resolve()):
                        raise ValueError("Native ELF runtime search escapes declared SDK")
                    search_directories.append(directory)
            # GNU ABI supplied by the constrained gcc_14_3_bookworm executor
            # image, whose original-image/native qualification remains required.
            system = {"libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1", "libresolv.so.2", Path(expected_interpreter).name}
            for dependency in facts["dependencies"]:
                if dependency in system:
                    continue
                if "/" in dependency:
                    raise ValueError("Native ELF dependency must be a declared loader name")
                library = next((directory / dependency for directory in search_directories if (directory / dependency).is_file() and (directory / dependency).resolve().is_relative_to(prefix.resolve())), None)
                if library is None:
                    raise ValueError("Unresolved declared native ELF SDK library: " + dependency)
                require_native_library(library, expected_cpu)
            loads.append(dict(path = str(file.relative_to(prefix)), **facts))
            continue
        data = macho_image(data, expected_cpu)
        if data is None:
            continue
        count = struct.unpack_from("<I", data, 16)[0]
        if count > (len(data) - 32) // 8:
            raise ValueError("Invalid native Mach-O inventory")
        offset = 32
        dependencies = []
        rpaths = []
        for _ in range(count):
            kind, size = struct.unpack_from("<II", data, offset)
            if size < 8 or offset + size > len(data):
                raise ValueError("Invalid native Mach-O command")
            if kind in [0xC, 0x80000018, 0x8000001F, 0x20, 0x80000023, 0x8000001C]:
                string = struct.unpack_from("<I", data, offset + 8)[0]
                if string >= size:
                    raise ValueError("Invalid native Mach-O string")
                name = data[offset + string:offset + size].split(b"\0", 1)[0].decode()
                if kind == 0x8000001C:
                    rpaths.append(name)
                else:
                    dependencies.append(name)
            offset += size
        for name in dependencies:
            if name.startswith("/usr/lib/") or name.startswith("/System/Library/"):
                continue
            candidates = [prefix / "lib" / Path(name).name]
            if name.startswith("@loader_path/"):
                candidates.append(file.parent / name.removeprefix("@loader_path/"))
            if name.startswith("@rpath/"):
                suffix = name.removeprefix("@rpath/")
                for rpath in rpaths:
                    if rpath == "@loader_path":
                        candidates.append(file.parent / suffix)
                    elif rpath.startswith("@loader_path/"):
                        candidates.append(file.parent / rpath.removeprefix("@loader_path/") / suffix)
                    elif rpath == "@executable_path":
                        candidates.append(prefix / "bin" / suffix)
                    elif rpath.startswith("@executable_path/"):
                        candidates.append(prefix / "bin" / rpath.removeprefix("@executable_path/") / suffix)
            resolved = next((candidate for candidate in candidates if candidate.is_file() and candidate.resolve().is_relative_to(prefix.resolve())), None)
            if resolved is None:
                raise ValueError("Unresolved declared native SDK library: " + name)
            require_native_library(resolved, expected_cpu)
        loads.append({"path": str(file.relative_to(prefix)), "cpu": struct.unpack_from("<I", data, 4)[0], "dependencies": dependencies, "rpaths": rpaths})
    files = []
    for file in sorted(prefix.rglob("*")):
        relative = file.relative_to(prefix)
        if relative.parts[0] in [".bootstrap", ".archives"] or str(relative) == "sdk-manifest.json":
            continue
        if file.is_symlink():
            target = file.readlink()
            if not file.resolve().is_relative_to(prefix.resolve()):
                raise ValueError("Native package symlink escapes SDK")
            files.append({"path": str(file.relative_to(prefix)), "kind": "symlink", "target": str(target)})
        elif file.is_file():
            files.append({"path": str(file.relative_to(prefix)), "kind": "file", "mode": file.stat().st_mode & 0o777, "sha256": digest(file.read_bytes())})
    return {"native_loads": loads, "packages": [{key: item[key] for key in ["name", "sha256", "url"]} for item in specification], "files": files, "digest": digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode())}

if __name__ == "__main__":
    specification = json.loads(Path(sys.argv[1]).read_text())
    manifest = extract(specification, sys.argv[2], int(sys.argv[4]), json.loads(sys.argv[5]))
    Path(sys.argv[3]).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
