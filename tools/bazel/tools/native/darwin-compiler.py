"""Materialize a pinned Apple compiler/SDK export; never discover Xcode.

The checked-in pin names the export by SHA256, size and the Xcode release it was
taken from. This extractor checks the pinned archive, members and native closure;
it does not create Apple signature authority or read an installed developer directory.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import struct
import sys
import tarfile

TOOLS = {"clang", "clangxx", "ld", "ar", "ranlib", "nm", "strip", "objdump"}
CPUS = {"aarch64": 16777228, "x86_64": 16777223}


def logical(value):
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value:
        raise ValueError("Compiler input must be a relative POSIX member")
    path = PurePosixPath(value)
    if str(path) != value or any(part in (".", "..") for part in path.parts):
        raise ValueError("Compiler input must be an exact relative member")
    return value


def validate_request(request):
    if not isinstance(request, dict) or set(request) != {"archive", "source", "execution_cpu", "strip_prefix", "tools", "sysroot", "resource_dir", "cxx_headers", "licenses"}:
        raise ValueError("Incomplete original compiler archive declaration")
    archive = request["archive"]
    # Apple's licence forbids publishing the export, so the pin carries no origin:
    # the bytes are regenerated from the named release and matched by digest.
    if not isinstance(archive, dict) or set(archive) != {"sha256", "size"}:
        raise ValueError("Compiler archive requires exactly its digest and size")
    source = request["source"]
    if not isinstance(source, dict) or set(source) != {"product", "version", "build"} or source["product"] != "Xcode" or not all(isinstance(source[key], str) and source[key] and source[key].isascii() and source[key].isprintable() and " " not in source[key] for key in ("version", "build")):
        raise ValueError("Compiler archive requires the exact Xcode release it was exported from")
    digest = archive["sha256"]
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest) or type(archive["size"]) is not int or archive["size"] <= 0:
        raise ValueError("Compiler archive requires exact original SHA256 and size")
    if not isinstance(request["execution_cpu"], str) or request["execution_cpu"] not in CPUS:
        raise ValueError("Compiler archive requires an exact native Darwin CPU")
    if not isinstance(request["tools"], dict) or set(request["tools"]) != TOOLS:
        raise ValueError("Compiler archive requires compiler, linker, archiver and utility tools")
    for value in list(request["tools"].values()) + [request[key] for key in ("strip_prefix", "sysroot", "resource_dir", "cxx_headers")]:
        logical(value)
    if not isinstance(request["licenses"], list) or not request["licenses"] or not all(isinstance(value, str) for value in request["licenses"]) or len(set(request["licenses"])) != len(request["licenses"]):
        raise ValueError("Compiler archive requires its original license members")
    for value in request["licenses"]:
        logical(value)


def member(root, path):
    file = root / logical(path)
    if not file.resolve(strict=True).is_relative_to(root.resolve(strict=True)):
        raise ValueError("Compiler archive member escapes its original closure")
    return file


def image_loads(image):
    count, command_bytes = struct.unpack_from("<II", image, 16)
    end = 32 + command_bytes
    if end > len(image) or count > command_bytes // 8:
        raise ValueError("Invalid compiler Mach-O command inventory")
    offset, dependencies, rpaths = 32, [], []
    for _ in range(count):
        if offset + 8 > end:
            raise ValueError("Truncated compiler Mach-O command")
        kind, size = struct.unpack_from("<II", image, offset)
        if size < 8 or size % 4 or offset + size > end:
            raise ValueError("Invalid compiler Mach-O load command")
        if kind in (0xC, 0x80000018, 0x8000001F, 0x20, 0x80000023, 0x8000001C):
            base = 12 if kind == 0x8000001C else 24
            if size < base:
                raise ValueError("Truncated compiler Mach-O load string")
            at = struct.unpack_from("<I", image, offset + 8)[0]
            if at < base or at >= size:
                raise ValueError("Invalid compiler Mach-O load string")
            raw = image[offset + at:offset + size]
            if b"\0" not in raw:
                raise ValueError("Unterminated compiler Mach-O load string")
            value = raw.split(b"\0", 1)[0].decode()
            (rpaths if kind == 0x8000001C else dependencies).append(value)
        offset += size
    if offset != end:
        raise ValueError("Compiler Mach-O command inventory differs")
    return dependencies, rpaths


def system_library_path(value):
    if not value.startswith(("/usr/lib/", "/System/Library/")) and value not in ("/usr/lib", "/System/Library"):
        return False
    logical(value.rstrip("/")[1:])
    return True


def load_root(root, file, value, executable):
    if system_library_path(value):
        return Path(value)
    if value == "@loader_path":
        candidate = file.parent
    elif value.startswith("@loader_path/"):
        candidate = file.parent / value.removeprefix("@loader_path/")
    elif value == "@executable_path":
        candidate = executable.parent
    elif value.startswith("@executable_path/"):
        candidate = executable.parent / value.removeprefix("@executable_path/")
    else:
        raise ValueError("Compiler runtime search requires declared loader-relative paths")
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError("Compiler runtime search escapes its original closure")
    return candidate


def resolve_runtime(root, dependency, candidates):
    system_candidate = False
    for candidate in candidates:
        path = Path(os.path.normpath(candidate))
        if system_library_path(str(path)):
            # An OS rpath may miss this library and continue into the original
            # bundle. Capture that original closure before accepting OS-only use.
            system_candidate = True
            continue
        if path.resolve().is_relative_to(root.resolve()) and path.is_file():
            return path
    if system_candidate:
        # Shared-cache membership still belongs to the qualified native OS image.
        return None
    raise ValueError("Unresolved original compiler runtime: " + dependency)


def validate_closure(root, request, loader):
    cpu = CPUS[request["execution_cpu"]]
    tools = [member(root, name) for name in request["tools"].values()]
    for file in tools:
        image = loader.macho_image(file.read_bytes(), cpu)
        if image is None or struct.unpack_from("<I", image, 12)[0] != 2 or not file.stat().st_mode & 0o111:
            raise ValueError("Compiler tool requires the declared native Mach-O executable: " + str(file.relative_to(root)))
    for path in (request["sysroot"], request["resource_dir"], request["cxx_headers"]):
        directory = member(root, path)
        if not directory.is_dir() or not any(item.is_file() for item in directory.rglob("*")):
            raise ValueError("Compiler archive lacks declared SDK/resource/C++ headers")
    for path in request["licenses"]:
        if not member(root, path).is_file():
            raise ValueError("Compiler archive lacks its original license File")
    # Resolve each executable independently: @executable_path and inherited rpaths
    # are per-process values, not interchangeable aliases for a common lib directory.
    for executable in tools:
        pending = [(executable, ())]
        seen = set()
        while pending:
            file, inherited = pending.pop()
            identity = (file.resolve(), inherited)
            if identity in seen:
                continue
            seen.add(identity)
            image = loader.macho_image(file.read_bytes(), cpu)
            if image is None:
                raise ValueError("Compiler runtime dependency is not a native Mach-O image")
            dependencies, rpaths = image_loads(image)
            search = tuple(dict.fromkeys([str(load_root(root, file, path, executable)) for path in rpaths] + list(inherited)))
            for dependency in dependencies:
                if system_library_path(dependency):
                    continue
                if dependency.startswith("@rpath/"):
                    suffix = dependency.removeprefix("@rpath/")
                    candidates = [Path(directory) / suffix for directory in search]
                else:
                    candidates = [load_root(root, file, dependency, executable)]
                resolved = resolve_runtime(root, dependency, candidates)
                if resolved is None:
                    continue
                loader.require_native_library(resolved, cpu)
                pending.append((resolved, search))


def archive_members(archive, strip_prefix):
    members = []
    prefix = logical(strip_prefix) + "/"
    with tarfile.open(archive, stream=True) as source:
        for member in source:
            if member.isdir():
                continue
            if not member.name.startswith(prefix) or not (member.isfile() or member.issym()):
                raise ValueError("Unsupported original compiler archive member")
            members.append({"path": logical(member.name.removeprefix(prefix)), "kind": "symlink" if member.issym() else "file"})
    if len({member["path"] for member in members}) != len(members):
        raise ValueError("Duplicate original compiler archive member")
    return sorted(members, key=lambda member: member["path"])


def file_inventory(root):
    files = []
    def inventory(directory, ancestors):
        physical = directory.resolve(strict=True)
        if physical in ancestors:
            # Original SDK framework aliases can be recursive. Preserve the
            # alias on disk and bind topology through the original archive File;
            # a finite File inventory cannot expand a directory cycle forever.
            return
        for entry in sorted(os.scandir(directory), key=lambda entry: entry.name):
            file = Path(entry.path)
            member(root, str(file.relative_to(root)))
            if file.is_dir():
                inventory(file, ancestors | {physical})
            elif file.is_file():
                files.append(str(file.relative_to(root)))
            else:
                raise ValueError("Unsupported compiler archive inventory member")
    inventory(root, set())
    return sorted(files)


def extract(archive, root, request, loader):
    validate_request(request)
    archive, root = Path(archive), Path(root)
    with archive.open("rb") as original:
        archive_digest = hashlib.file_digest(original, "sha256").hexdigest()
    if archive.stat().st_size != request["archive"]["size"] or archive_digest != request["archive"]["sha256"]:
        raise ValueError("Original compiler archive digest or size differs")
    return extract_members(archive, root, request, loader)


def extract_members(archive, root, request, loader):
    """Restore validated archive bytes; authority and pins are caller obligations."""
    archive, root = Path(archive), Path(root)
    if root.exists() and (root.is_symlink() or any(root.iterdir())):
        raise ValueError("Compiler extraction requires an empty ordinary destination")
    root.mkdir(parents=True, exist_ok=True)
    prefix = request["strip_prefix"] + "/"
    with tarfile.open(archive, stream=True) as source:
        names = set()
        for original in source:
            if original.name == request["strip_prefix"] and original.isdir():
                continue
            if not original.name.startswith(prefix):
                raise ValueError("Compiler archive contains an undeclared top-level member")
            name = logical(original.name.removeprefix(prefix).rstrip("/"))
            if name in names or not (original.isfile() or original.isdir() or original.issym()):
                raise ValueError("Compiler archive contains a duplicate or unsupported member")
            names.add(name)
            if original.issym():
                if original.linkname.startswith("/") or "\\" in original.linkname:
                    raise ValueError("Compiler archive alias must remain relative")
            original.name = name
            source.extract(original, root, filter="data")
    for file in root.rglob("*"):
        if file.is_symlink():
            member(root, str(file.relative_to(root)))
        elif not (file.is_file() or file.is_dir()):
            raise ValueError("Unsupported compiler archive member")
    validate_closure(root, request, loader)
    return file_inventory(root)


def load_loader(path):
    specification = importlib.util.spec_from_file_location("native_image", path)
    loader = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(loader)
    return loader


if __name__ == "__main__":
    request = json.loads(Path(sys.argv[1]).read_text())
    extract(sys.argv[2], sys.argv[3], request, load_loader(sys.argv[4]))
    Path(sys.argv[5]).write_text(json.dumps(archive_members(sys.argv[2], request["strip_prefix"])) + "\n")
