"""Check actual original native utilities without executing foreign Linux code."""

from pathlib import PurePosixPath
import struct
import sys
import tarfile


UTILITIES = (
    "bin/bash", "bin/sh", "usr/bin/python3", "usr/sbin/ip",
    "usr/sbin/nft", "usr/sbin/conntrack", "usr/sbin/miniupnpd",
    "usr/sbin/sysctl", "usr/bin/pkill", "usr/bin/ss", "usr/bin/seq",
    "usr/bin/tail", "usr/bin/grep", "usr/bin/cat", "usr/bin/rm",
    "usr/bin/touch", "usr/bin/sleep", "etc/miniupnpd/nft_init.sh",
)


def verify(rootfs, architecture):
    machine = {"amd64": 62, "arm64": 183}[architecture]
    with tarfile.open(rootfs, "r:") as archive:
        members = {member.name: member for member in archive}

        def resolve(path, seen=()):
            if path in seen:
                raise ValueError("utility alias cycle: " + path)
            parts = list(PurePosixPath(path).parts)
            if ".." in parts or PurePosixPath(path).is_absolute():
                raise ValueError("utility path escapes runtime: " + path)
            for index in range(1, len(parts) + 1):
                prefix = str(PurePosixPath(*parts[:index]))
                entry = members.get(prefix)
                if entry is None or not entry.issym():
                    continue
                link = PurePosixPath(entry.linkname)
                target = [] if link.is_absolute() else parts[:index - 1]
                for part in link.parts:
                    if part in ("/", "."):
                        continue
                    if part == "..":
                        if not target:
                            raise ValueError("utility alias escapes runtime: " + path)
                        target.pop()
                    else:
                        target.append(part)
                target.extend(parts[index:])
                return resolve(str(PurePosixPath(*target)), seen + (path,))
            entry = members[path]
            return resolve(entry.linkname, seen + (path,)) if entry.islnk() else entry

        checked = set()

        def executable(path):
            entry = resolve(path)
            if entry.name in checked:
                return
            checked.add(entry.name)
            if not entry.isfile() or not entry.mode & 0o111:
                raise ValueError("utility is not an executable regular file: " + path)
            data = archive.extractfile(entry).read()
            if data.startswith(b"#!"):
                interpreter = data.split(b"\n", 1)[0][2:].strip().split()[0].decode()
                if not interpreter.startswith("/"):
                    raise ValueError("utility interpreter must name the declared runtime: " + path)
                executable(interpreter[1:])
                return
            if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01":
                raise ValueError("utility is not the original native ELF64 executable: " + path)
            if struct.unpack_from("<H", data, 18)[0] != machine:
                raise ValueError("utility native architecture mismatch: " + path)
            offset = struct.unpack_from("<Q", data, 32)[0]
            size, count = struct.unpack_from("<HH", data, 54)
            if size != 56 or offset + count * size > len(data):
                raise ValueError("invalid original ELF program headers: " + path)
            for index in range(count):
                kind, _, start, _, _, length, _, _ = struct.unpack_from("<IIQQQQQQ", data, offset + index * size)
                if kind == 3:
                    payload = data[start:start + length]
                    if len(payload) != length or not payload.endswith(b"\0"):
                        raise ValueError("invalid original ELF loader: " + path)
                    loader = payload[:-1].decode()
                    if not loader.startswith("/"):
                        raise ValueError("ELF loader must name the declared runtime: " + path)
                    executable(loader[1:])

        for utility in UTILITIES:
            executable(utility)
        print("original " + architecture + " utility ELF/shebang/loader source controls passed: " + str(len(UTILITIES)))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: source-controls.py ROOTFS amd64|arm64")
    verify(*sys.argv[1:])
