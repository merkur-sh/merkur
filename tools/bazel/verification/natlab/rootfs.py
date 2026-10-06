"""Compose an immutable runtime from original OCI and Debian archive payloads."""

import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile


def digest(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def paragraphs(data):
    result = []
    for block in data.decode().split("\n\n"):
        fields = {}
        key = None
        for line in block.splitlines():
            if line.startswith((" ", "\t")) and key:
                fields[key] += "\n" + line[1:]
            elif ":" in line:
                key, value = line.split(":", 1)
                fields[key] = value.lstrip(" ")
        if fields:
            result.append(fields)
    return result


def ar_members(data):
    if not data.startswith(b"!<arch>\n"):
        raise ValueError("original Debian archive has no ar envelope")
    cursor = 8
    members = {}
    while cursor < len(data):
        header = data[cursor:cursor + 60]
        if len(header) != 60 or header[58:] != b"`\n":
            raise ValueError("truncated original Debian archive header")
        name = header[:16].decode().strip().rstrip("/")
        size = int(header[48:58])
        start = cursor + 60
        if start + size > len(data) or name in members:
            raise ValueError("ambiguous or truncated original Debian member")
        members[name] = data[start:start + size]
        cursor = start + size + size % 2
    if members.get("debian-binary") != b"2.0\n":
        raise ValueError("unsupported original Debian archive format")
    return members


def name_of(raw):
    path = PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("original archive member escapes container root")
    return str(path)


def read_tar(data, origin):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        for member in archive:
            name = name_of(member.name)
            if name in result or member.isdev() or member.isfifo():
                raise ValueError("ambiguous or special original rootfs member")
            member.name = name
            payload = archive.extractfile(member).read() if member.isfile() else None
            result[name] = (member, payload, origin, name)
    return result


def resolve(entries, name, seen=()):
    if name in seen:
        raise ValueError("original rootfs alias cycle: " + name)
    parts = PurePosixPath(name).parts
    for index in range(1, len(parts) + 1):
        prefix = str(PurePosixPath(*parts[:index]))
        record = entries.get(prefix)
        if record is None:
            continue
        member = record[0]
        if member.issym():
            target = PurePosixPath(member.linkname)
            substituted = [] if target.is_absolute() else list(parts[:index - 1])
            for part in target.parts:
                if part in ("/", "."):
                    continue
                if part == "..":
                    if not substituted:
                        raise ValueError("original rootfs alias escapes root")
                    substituted.pop()
                else:
                    substituted.append(part)
            substituted.extend(parts[index:])
            return resolve(entries, str(PurePosixPath(*substituted)), seen + (name,))
    record = entries.get(name)
    if record is None:
        raise ValueError("missing original rootfs member: " + name)
    if record[0].islnk():
        return resolve(entries, name_of(record[0].linkname), seen + (name,))
    return record


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def add_regular(entries, name, data):
    member = tarfile.TarInfo(name)
    member.mode = 0o644
    member.size = len(data)
    entries[name] = (member, data, "generated", name)


def version_compare(left, right):
    # Debian Policy5.6.12: epoch, alternating nonnumeric/numeric runs, then
    # revision. Tilde precedes the empty string; letters precede punctuation.
    def split(value):
        epoch, separator, remainder = value.partition(":")
        epoch, value = (int(epoch), remainder) if separator else (0, value)
        upstream, separator, revision = value.rpartition("-")
        return epoch, upstream if separator else value, revision if separator else "0"
    def order(char):
        if char == "~":
            return -1
        if not char or char.isdigit():
            return 0
        return ord(char) if char.isascii() and char.isalpha() else ord(char) + 256
    def compare(a, b):
        while a or b:
            while (a and not a[0].isdigit()) or (b and not b[0].isdigit()):
                aa = a[0] if a else ""
                bb = b[0] if b else ""
                difference = order(aa) - order(bb)
                if difference:
                    return difference
                a, b = a[1:] if a else a, b[1:] if b else b
            a, b = a.lstrip("0"), b.lstrip("0")
            aa = re.match(r"[0-9]*", a).group(0)
            bb = re.match(r"[0-9]*", b).group(0)
            if len(aa) != len(bb):
                return len(aa) - len(bb)
            if aa != bb:
                return 1 if aa > bb else -1
            a, b = a[len(aa):], b[len(bb):]
        return 0
    aa, bb = split(left), split(right)
    return aa[0] - bb[0] or compare(aa[1], bb[1]) or compare(aa[2], bb[2])


def validate_dependencies(facts, selected, choices):
    for name in selected:
        fact = facts[name]
        for field in ("Pre-Depends", "Depends"):
            for clause in fact.get(field, "").replace("\n", " ").split(","):
                if not clause.strip():
                    continue
                alternatives = []
                for value in clause.split("|"):
                    parsed = re.fullmatch(r"\s*([a-z0-9][a-z0-9+.-]*)(?::(?:any|native))?(?:\s+\((<<|<=|=|>=|>>)\s+([^\s()]+)\))?\s*", value)
                    if parsed is None:
                        raise ValueError("unsupported original binary dependency syntax: " + value)
                    alternatives.append(parsed.groups())
                choice = choices[" | ".join(item[0] for item in alternatives)] if len(alternatives) > 1 else alternatives[0][0]
                selected_dependency = next(item for item in alternatives if item[0] == choice)
                dependency, relationship, version = selected_dependency
                if dependency not in facts:
                    raise ValueError("original runtime dependency is absent: " + dependency)
                if relationship:
                    comparison = version_compare(facts[dependency]["Version"], version)
                    valid = {"<<": comparison < 0, "<=": comparison <= 0, "=": comparison == 0, ">=": comparison >= 0, ">>": comparison > 0}
                    if not valid[relationship]:
                        raise ValueError("original runtime dependency version does not satisfy " + clause)


def compose(request):
    lock = json.loads(Path(request["lock"]).read_text())
    consumer = lock["consumers"][request["consumer"]]
    distribution = consumer["distribution"]
    platform = lock["distributions"][distribution]["platforms"][request["architecture"]]
    base = platform["base"]
    if distribution != request["distribution"] or base["index"]["sha256"] != request["base_index_digest"].removeprefix("sha256:"):
        raise ValueError("configured Debian source facts differ from immutable lock")
    selected = consumer["packages"][request["architecture"]]
    if set(request["packages"]) != set(selected):
        raise ValueError("declared Debian package File inventory is incomplete")
    inventory = []
    for logical, path, expected in [(name, request[name], base["rootfs" if name == "base" else name]["sha256"]) for name in ("base", "config", "index", "manifest")]:
        actual = digest(path)
        if actual != expected:
            raise ValueError("original Debian base bytes changed: " + logical)
        inventory.append({"logical": logical, "sha256": actual, "size": Path(path).stat().st_size, "mode": Path(path).stat().st_mode & 0o777})
    index = json.loads(Path(request["index"]).read_text())
    manifest = json.loads(Path(request["manifest"]).read_text())
    config = json.loads(Path(request["config"]).read_text())
    if config["os"] != "linux" or config["architecture"] != request["architecture"]:
        raise ValueError("original Debian OCI configuration has wrong native platform")
    if not any(item["digest"] == "sha256:" + base["manifest"]["sha256"] and item["platform"]["architecture"] == request["architecture"] for item in index["manifests"]):
        raise ValueError("original OCI index does not select the configured native manifest")
    if manifest["config"]["digest"] != "sha256:" + base["config"]["sha256"] or [item["digest"] for item in manifest["layers"]] != ["sha256:" + base["rootfs"]["sha256"]]:
        raise ValueError("original OCI manifest does not bind selected config and rootfs")
    entries = read_tar(Path(request["base"]).read_bytes(), "base")
    statuses = paragraphs(resolve(entries, "var/lib/dpkg/status")[1])
    facts = {item["Package"]: item for item in statuses if item.get("Status") == "install ok installed"}
    for name, expected in platform["base_packages"].items():
        if name not in facts or facts[name]["Version"] != expected:
            raise ValueError("original base package inventory differs from lock: " + name)
    for name in selected:
        specification = platform["packages"][name]
        path = Path(request["packages"][name])
        if digest(path) != specification["SHA256"]:
            raise ValueError("original Debian package archive bytes changed: " + name)
        members = ar_members(path.read_bytes())
        control_names = [key for key in members if key.startswith("control.tar.")]
        data_names = [key for key in members if key.startswith("data.tar.")]
        if len(control_names) != 1 or len(data_names) != 1:
            raise ValueError("original Debian archive requires exact control/data payloads")
        controls = read_tar(members[control_names[0]], name + ":control")
        control = paragraphs(resolve(controls, "control")[1])[0]
        for field in ("Package", "Version", "Architecture"):
            if control[field] != specification[field]:
                raise ValueError("original Debian package metadata differs from lock: " + name)
        if control["Architecture"] not in (request["architecture"], "all"):
            raise ValueError("original Debian package has wrong native architecture")
        entries.update(read_tar(members[data_names[0]], name + ".deb"))
        facts[name] = control
        inventory.append({"logical": name + ".deb", "sha256": specification["SHA256"], "size": path.stat().st_size, "mode": path.stat().st_mode & 0o777})
    validate_dependencies(facts, selected, lock["dependency_choices"])
    # Only the network lab owns these private mount points.
    for name in (("target", "target/debug", "merkur-lab") if request["consumer"] == "natlab" else ()):
        if name not in entries:
            member = tarfile.TarInfo(name)
            member.type = tarfile.DIRTYPE
            member.mode = 0o755
            entries[name] = (member, None, "generated", name)
    if request["consumer"] == "edge":
        certificates = [record[1] for name, record in sorted(entries.items()) if name.startswith("usr/share/ca-certificates/") and name.endswith(".crt") and record[0].isfile()]
        if not certificates:
            raise ValueError("original ca-certificates payload supplies no declared certificates")
        add_regular(entries, "etc/ssl/certs/ca-certificates.crt", b"".join(data if data.endswith(b"\n") else data + b"\n" for data in certificates))
    notices = Path(request["licenses"])
    notices.mkdir(parents=True, exist_ok=True)
    if any(notices.iterdir()):
        raise ValueError("declared copyright output directory must be empty")
    packages = []
    for name, fact in sorted(facts.items()):
        if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", name):
            raise ValueError("invalid original Debian package name")
        record = resolve(entries, "usr/share/doc/" + name + "/copyright")
        if not record[0].isfile() or not record[1]:
            raise ValueError("original Debian copyright is not a regular nonempty File")
        output = notices / name / "copyright"
        output.parent.mkdir()
        output.write_bytes(record[1])
        output.chmod(0o644)
        packages.append({"package": name, "version": fact["Version"], "architecture": fact.get("Architecture", request["architecture"]), "source": fact.get("Source", name), "archive": next((row for row in inventory if row["logical"] == name + ".deb"), inventory[0]), "license": {"path": name + "/copyright", "sha256": hashlib.sha256(record[1]).hexdigest(), "size": len(record[1]), "originArchive": record[2], "originMember": record[3]}})
    with tarfile.open(request["rootfs"], "w", format=tarfile.PAX_FORMAT) as archive:
        for member, payload, _, _ in entries.values():
            archive.addfile(member, io.BytesIO(payload) if member.isfile() else None)
    inventory_bytes = json_bytes(inventory)
    Path(request["inventory"]).write_bytes(inventory_bytes)
    context = {"consumer": request["consumer"], "target": "linux-" + request["architecture"], "distribution": distribution, "baseIndexDigest": request["base_index_digest"], "inventorySha256": hashlib.sha256(inventory_bytes).hexdigest()}
    context_bytes = json_bytes(context)
    Path(request["context"]).write_bytes(context_bytes)
    attribution = {"rootfs": {"sha256": digest(request["rootfs"]), "size": Path(request["rootfs"]).stat().st_size}, "base": {"indexDigest": "sha256:" + base["index"]["sha256"], "manifestDigest": "sha256:" + base["manifest"]["sha256"], "configDigest": "sha256:" + base["config"]["sha256"], "layerDigest": "sha256:" + base["rootfs"]["sha256"], "source": base["rootfs"]["url"]}, "packages": packages, "inventorySha256": context["inventorySha256"], "contextSha256": hashlib.sha256(context_bytes).hexdigest()}
    Path(request["attribution"]).write_bytes(json_bytes(attribution))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: rootfs.py REQUEST")
    compose(json.loads(Path(sys.argv[1]).read_text()))
