"""Materialize original Dragonfly and its exact declared Linux loader closure."""
import hashlib
import importlib.util
import io
import json
import posixpath
from pathlib import Path, PurePosixPath
import sys
import tarfile


def safe(name):
    while name.startswith("./"):
        name = name[2:]
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or str(path) != name.rstrip("/"):
        raise ValueError("noncanonical archive member")
    return str(path)


def tar_members(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for entry in archive:
            name = safe(entry.name)
            if name == "." or entry.isdir():
                continue
            if name in result:
                raise ValueError("duplicate archive member")
            if entry.isfile():
                result[name] = (archive.extractfile(entry).read(), entry.mode & 0o777)
            elif entry.issym() or entry.islnk():
                target = entry.linkname if entry.islnk() else posixpath.join(posixpath.dirname(name), entry.linkname)
                result[name] = safe(posixpath.normpath(target))
            else:
                raise ValueError("unsupported original archive member")
    return result


def deb_members(data):
    if not data.startswith(b"!<arch>\n"):
        raise ValueError("original runtime archive is not Debian ar")
    offset, payload = 8, None
    names = set()
    while offset < len(data):
        header = data[offset:offset + 60]
        if len(header) != 60 or header[58:] != b"`\n":
            raise ValueError("invalid Debian archive header")
        name = header[:16].decode("ascii").strip().rstrip("/")
        size = int(header[48:58].decode("ascii").strip())
        if name in names or size < 0 or offset + 60 + size > len(data):
            raise ValueError("duplicate or truncated Debian archive member")
        names.add(name)
        if name.startswith("data.tar."):
            if payload is not None:
                raise ValueError("duplicate Debian payload")
            payload = data[offset + 60:offset + 60 + size]
        offset += 60 + size + size % 2
    if offset != len(data) or payload is None:
        raise ValueError("missing or truncated Debian payload")
    return tar_members(payload)


def original(members, name):
    seen = set()
    while isinstance(members.get(name), str):
        if name in seen:
            raise ValueError("cyclic original archive link")
        seen.add(name)
        name = members[name]
    value = members.get(name)
    if not isinstance(value, tuple):
        raise ValueError("original archive link or member is absent")
    return value


def acquire(specification, destination, elf_loads):
    cpu = specification["cpu"]
    archives = {}
    for package in specification["archives"]:
        data = Path(package["path"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != package["sha256"]:
            raise ValueError("original publisher archive digest mismatch")
        if package["name"] in archives:
            raise ValueError("duplicate declared archive")
        archives[package["name"]] = tar_members(data) if package["name"] == "dragonfly" else deb_members(data)
    if set(archives) != {"dragonfly", "libc6", "zlib1g", "libgcc-s1", "gcc-14-base"}:
        raise ValueError("complete declared Dragonfly and Linux runtime archives required")
    binary, mode = original(archives["dragonfly"], specification["binary"])
    if not mode & 0o111:
        raise ValueError("original Dragonfly member is not executable")
    image = elf_loads(binary, cpu)
    if image["interpreter"] != specification["interpreter"] or image["rpaths"]:
        raise ValueError("original Dragonfly interpreter or search path changed")
    libraries = {}
    for package in ("libc6", "zlib1g", "libgcc-s1"):
        for name in archives[package]:
            if not name.startswith("usr/lib/") or ".so" not in PurePosixPath(name).name:
                continue
            data, member_mode = original(archives[package], name)
            if not data.startswith(b"\x7fELF"):
                continue
            elf_loads(data, cpu)
            basename = PurePosixPath(name).name
            if basename in libraries and libraries[basename][0] != data:
                raise ValueError("ambiguous declared native library")
            libraries[basename] = (data, member_mode)
    loader = PurePosixPath(image["interpreter"]).name
    if loader not in libraries:
        raise ValueError("declared original ELF loader is absent")
    selected = {}
    pending = set(image["dependencies"]) | {loader, "libgcc_s.so.1"}
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        if name not in libraries:
            raise ValueError("native dependency would escape the declared runtime")
        selected[name] = libraries[name]
        parsed = elf_loads(libraries[name][0], cpu)
        if parsed["rpaths"] or parsed["interpreter"] not in (None, image["interpreter"]):
            raise ValueError("native dependency would escape the declared runtime")
        pending.update(parsed["dependencies"])
    output = Path(destination)
    members = {"bin/dragonfly": (binary, mode), "bin/" + loader: libraries[loader]}
    members.update({"lib/" + name: value for name, value in selected.items()})
    members["licenses/dragonfly/LICENSE.md"] = original(archives["dragonfly"], "LICENSE.md")
    for package in ("libc6", "zlib1g", "gcc-14-base"):
        members["licenses/" + package + "/copyright"] = original(archives[package], "usr/share/doc/" + package + "/copyright")
    for name, (data, mode) in members.items():
        file = output / name
        file.parent.mkdir(parents=True, exist_ok=True)
        if file.exists() or file.is_symlink():
            raise ValueError("runtime destination member already exists")
        file.write_bytes(data)
        file.chmod(mode)
    return sorted(members)


def main():
    specification, destination, parser = sys.argv[1:]
    module = importlib.util.spec_from_file_location("declared_native_elf", parser)
    elf = importlib.util.module_from_spec(module)
    module.loader.exec_module(elf)
    members = acquire(json.loads(Path(specification).read_text()), destination, elf.elf_loads)
    Path(destination, ".dragonfly-members.json").write_text(json.dumps(members))


if __name__ == "__main__":
    main()
