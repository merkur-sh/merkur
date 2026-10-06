"""Build Docker's load format from one declared, complete Linux rootfs archive."""

import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile


REQUIRED = (
    "bin/bash", "bin/sh", "usr/bin/python3", "usr/sbin/ip",
    "usr/sbin/nft", "usr/sbin/conntrack", "usr/sbin/miniupnpd",
    "usr/sbin/sysctl", "usr/bin/pkill", "usr/bin/ss", "usr/bin/seq",
    "usr/bin/tail", "usr/bin/grep", "usr/bin/cat", "usr/bin/rm",
    "usr/bin/touch", "usr/bin/sleep", "etc/miniupnpd/nft_init.sh",
)


def clean_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("rootfs member escapes the container root: " + name)
    return str(path)


def validate_rootfs(source, consumer="natlab"):
    if consumer == "natlab":
        required, directories = REQUIRED, ("target", "target/debug", "merkur-lab")
    elif consumer == "tpm":
        required, directories = ("usr/bin/swtpm",), ("tmp",)
    else:
        raise ValueError("unknown declared runtime image consumer")
    with tarfile.open(source, "r:*") as archive:
        members = {}
        for member in archive:
            name = clean_name(member.name)
            if name in members:
                raise ValueError("duplicate rootfs member: " + name)
            if member.isdev() or member.isfifo():
                raise ValueError("rootfs devices are created only by the container engine")
            members[name] = member

        def resolve(name, seen=()):
            if name in seen:
                raise ValueError("rootfs symlink cycle: " + name)
            path = PurePosixPath(name)
            for index in range(1, len(path.parts) + 1):
                prefix = str(PurePosixPath(*path.parts[:index]))
                member = members.get(prefix)
                if member is None:
                    continue
                if member.issym():
                    target = PurePosixPath(member.linkname)
                    parts = [] if target.is_absolute() else list(path.parts[:index - 1])
                    for part in target.parts:
                        if part in ("/", "."):
                            continue
                        if part == "..":
                            if not parts:
                                raise ValueError("rootfs alias escapes root")
                            parts.pop()
                        else:
                            parts.append(part)
                    parts.extend(path.parts[index:])
                    return resolve(str(PurePosixPath(*parts)), seen + (name,))
            member = members.get(name)
            if member is None:
                raise ValueError("missing rootfs member: " + name)
            if member.islnk():
                return resolve(clean_name(member.linkname), seen + (name,))
            return member

        for name in required:
            member = resolve(name)
            if not member.isfile() or not member.mode & 0o111:
                raise ValueError("required rootfs utility is not executable: " + name)
        for name in directories:
            if not resolve(name).isdir():
                raise ValueError("runtime mount point must be a directory: " + name)


def add_bytes(archive, name, data):
    member = tarfile.TarInfo(name)
    member.mode = 0o644
    member.size = len(data)
    archive.addfile(member, io.BytesIO(data))


def build(source, destination, identity, architecture, runtime="natlab"):
    if architecture not in ("amd64", "arm64"):
        raise ValueError("only native Linux x64 and ARM64 images are supported")
    validate_rootfs(source, runtime)
    # A layer is an uncompressed tar; retain all original package bytes, links,
    # ownership and modes, without host extraction or a mutable package solver.
    with tarfile.open(source, "r:*") as incoming:
        layer = io.BytesIO()
        with tarfile.open(fileobj=layer, mode="w", format=tarfile.PAX_FORMAT) as outgoing:
            for member in incoming:
                outgoing.addfile(member, incoming.extractfile(member) if member.isfile() else None)
    layer_bytes = layer.getvalue()
    layer_digest = hashlib.sha256(layer_bytes).hexdigest()
    config = json.dumps({
        "architecture": architecture,
        "os": "linux",
        "config": {"Env": ["PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"], "WorkingDir": "/"},
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + layer_digest]},
        "history": [{"created_by": "declared original " + runtime + " rootfs"}],
    }, sort_keys=True, separators=(",", ":")).encode()
    config_digest = hashlib.sha256(config).hexdigest()
    manifest = json.dumps([{"Config": config_digest + ".json", "RepoTags": [], "Layers": [layer_digest + "/layer.tar"]}], separators=(",", ":")).encode()
    with tarfile.open(destination, "w", format=tarfile.USTAR_FORMAT) as archive:
        add_bytes(archive, config_digest + ".json", config)
        add_bytes(archive, layer_digest + "/layer.tar", layer_bytes)
        add_bytes(archive, "manifest.json", manifest)
    Path(identity).write_text("sha256:" + config_digest + "\n")


if __name__ == "__main__":
    if len(sys.argv) not in (5, 6):
        raise SystemExit("usage: image.py ROOTFS IMAGE_ARCHIVE IMAGE_ID amd64|arm64 [natlab|tpm]")
    build(*sys.argv[1:])
