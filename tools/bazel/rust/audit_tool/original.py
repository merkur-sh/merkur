"""Retain cargo-audit's published source and exact original locked archive catalog."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import tomllib

NAME = "cargo-audit"
VERSION = "0.22.2"
SHA256 = "700c2b240f7fd330c24b675fe429f73a5b676531fcc6300400b2b67f155ba12a"
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
REPOSITORY = "merkur_cargo_audit_original"


def native_binary(roots):
    """Cargo builds this published package's library and binary together."""
    expected = {
        ("cargo_audit", ("lib",), ("lib",), "src/lib.rs"),
        (NAME, ("bin",), ("bin",), "src/bin/cargo-audit/main.rs"),
    }
    actual = set()
    binary = None
    for unit in roots:
        target = unit["target"]
        identity = (target["name"], tuple(target["kind"]), tuple(target["crate_types"]), target["src_path"])
        if unit["pkg_id"] != "workspace:." or unit["mode"] != "build" or identity not in expected or identity in actual:
            raise ValueError("cargo-audit compiler roots differ from its original library and binary")
        if unit["features"] != ["binary-scanning", "default"]:
            raise ValueError("cargo-audit captured features differ from its defaults")
        actual.add(identity)
        if target["kind"] == ["bin"]:
            binary = unit
    if actual != expected:
        raise ValueError("cargo-audit compiler roots omit its original library or binary")
    return binary


def original(archive):
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("cargo-audit requires its original published 0.22.2 archive")
    prefix = NAME + "-" + VERSION + "/"
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
        for member in source.getmembers():
            if not member.isfile() or not member.name.startswith(prefix):
                raise ValueError("Unexpected original cargo-audit archive member")
            logical = member.name[len(prefix):]
            path = PurePosixPath(logical)
            if not logical or path.is_absolute() or ".." in path.parts or str(path) != logical or logical in files:
                raise ValueError("Invalid or duplicated original cargo-audit member")
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError("Missing original cargo-audit File")
            files[logical] = stream.read()
    manifest = tomllib.loads(files["Cargo.toml"].decode())
    if (manifest["package"]["name"], manifest["package"]["version"]) != (NAME, VERSION):
        raise ValueError("Published cargo-audit package identity differs")
    if manifest.get("bin") != [{"name": NAME, "path": "src/bin/cargo-audit/main.rs"}]:
        raise ValueError("Published cargo-audit binary selection differs")
    lock = tomllib.loads(files["Cargo.lock"].decode())
    catalog = []
    identities = set()
    for package in lock["package"]:
        if "source" not in package:
            if (package["name"], package["version"]) != (NAME, VERSION):
                raise ValueError("Unexpected cargo-audit path dependency")
            continue
        identity = (package["name"], package["version"])
        checksum = package["checksum"]
        if package["source"] != REGISTRY or identity in identities or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
            raise ValueError("Unexpected or incomplete original cargo-audit registry lock")
        identities.add(identity)
        catalog.append({"name": identity[0], "version": identity[1], "sha256": checksum})
    return files, sorted(catalog, key=lambda item: (item["name"], item["version"]))


def document(archive):
    files, catalog = original(archive)
    return {
        "name": NAME,
        "version": VERSION,
        "archive_sha256": SHA256,
        "archive_url": "https://static.crates.io/crates/cargo-audit/cargo-audit-0.22.2.crate",
        "source_files": {name: {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)} for name, data in sorted(files.items())},
        "registry": catalog,
    }


def declarations(value):
    source = {"@" + REPOSITORY + "//source:" + path: path for path in value["source_files"]}
    archives = {"@" + REPOSITORY + "//:archives/" + item["name"] + "-" + item["version"] + ".crate": item["name"] + "@" + item["version"] for item in value["registry"]}
    return ("# Generated from cargo-audit's exact original Cargo.lock and archive.\n"
            + "AUDIT_SOURCE_FILES = " + json.dumps(source, indent=4) + "\n"
            + "AUDIT_REGISTRY_ARCHIVES = " + json.dumps(archives, indent=4) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    value = document(args.archive)
    outputs = {"original.json": json.dumps(value, indent=2) + "\n", "data.bzl": declarations(value)}
    for name, contents in outputs.items():
        path = args.directory / name
        if args.check:
            if path.read_text() != contents:
                raise ValueError("Stale cargo-audit original declaration: " + name)
        else:
            path.write_text(contents)


if __name__ == "__main__":
    main()
