#!/usr/bin/env python3
"""Acquire Rolldown's locked compiler context; never build with Cargo.

Compilation consumes the resulting retained graph through native Rust actions.
The SDK/source/registry inventories come from the existing acquisition producer.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import struct
import tarfile
import tempfile
import tomllib

BINDING_MANIFEST = "crates/rolldown_binding/Cargo.toml"
PLATFORMS = {
    "aarch64-apple-darwin": ("mach-o", 0x0100000C),
    "x86_64-apple-darwin": ("mach-o", 0x01000007),
    "aarch64-unknown-linux-gnu": ("elf", 183),
    "x86_64-unknown-linux-gnu": ("elf", 62),
}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared Rolldown acquisition implementation File")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def original_configuration(archive, identity):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != identity["archive_sha256"]:
        raise ValueError("Rolldown original commit archive digest differs")
    prefix = "rolldown-" + identity["commit"] + "/"
    names = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", BINDING_MANIFEST, "packages/rolldown/package.json"]
    result = {}
    with tarfile.open(archive, "r:gz") as source:
        for name in names:
            member = source.getmember(prefix + name)
            if not member.isfile():
                raise ValueError("Rolldown original configuration member is not a File")
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError("Rolldown original configuration File is absent")
            result[name] = stream.read()
    if tomllib.loads(result["rust-toolchain.toml"].decode())["toolchain"]["channel"] != identity["compiler_version"] or json.loads(result["packages/rolldown/package.json"])["version"] != identity["package_version"]:
        raise ValueError("Rolldown source compiler or published package identity differs")
    return result


def acquire(args):
    identity = json.loads(args.source_instances.read_text())[args.source_instance]
    original = original_configuration(args.source_archive, identity)
    materializer = load_module("declared_rolldown_materializer", args.materializer)
    capture = load_module("declared_rolldown_capture", args.capture)
    resolver = load_module("declared_rolldown_sdk", args.sdk_resolver)
    contexts = load_module("declared_rolldown_contexts", args.contexts)
    parity = load_module("declared_rolldown_parity", args.parity)
    descriptor = json.loads(args.descriptor.read_text())
    provenance = json.loads(args.provenance.read_text())
    if provenance["producer"] != args.producer or provenance["execution_host"] != descriptor["execution_host"] or capture.bytes_fact(args.descriptor) != provenance["descriptor"]:
        raise ValueError("Rolldown acquisition does not belong to its declared SDK producer")
    with tempfile.TemporaryDirectory(prefix="merkur-rolldown-context-") as temporary:
        root = Path(temporary).resolve(strict=True)
        source, registry = root / "source", root / "registry"
        source.mkdir()
        registry.mkdir()
        source_facts = materializer.materialize(args.source_root, provenance["source_files"], source, capture)
        descriptor["registry"]["files"] = materializer.materialize(args.registry, descriptor["registry"]["files"], registry, capture)
        descriptor["registry"]["directory"] = str(registry)
        descriptor["locks"] = [{**fact, "path": str(source / Path(fact["path"]).absolute().relative_to(args.source_root.absolute()))} for fact in descriptor["locks"]]
        for name, expected in original.items():
            if (source / name).read_bytes() != expected:
                raise ValueError("Prepared Rolldown configuration differs from the original File: " + name)
        sdk = resolver.NativeCargoSdk(descriptor)
        try:
            sdk.require_locks([source / "Cargo.lock"])
            contexts.ROOT = source
            manifest = source / BINDING_MANIFEST
            raw = contexts.resolve(manifest, sdk.host, identity["compiler_version"], False, sdk=sdk)
            normalized = contexts.normalize(raw, manifest, manifest)
            graph = contexts.unit_graph(manifest, sdk.host, identity["compiler_version"], "release", raw, normalized, source, library=True, sdk=sdk)
            roots = [graph["units"][index] for index in graph["roots"]]
            if len(roots) != 1 or roots[0]["pkg_id"] != "workspace:crates/rolldown_binding" or roots[0]["mode"] != "build" or "cdylib" not in roots[0]["target"]["crate_types"]:
                raise ValueError("Rolldown capture did not select its exact native binding library")
            if any(next(sdk.home.rglob(extension), None) is not None for extension in ["*.rlib", "*.rmeta", "*.o", "*.node"]):
                raise ValueError("Rolldown context acquisition unexpectedly compiled an artifact")
            document = {
                "package": "rolldown-binding", "mode": "release", "platform": "native",
                "inputs": {str(Path(fact["path"]).relative_to(source)): fact["sha256"] for fact in source_facts},
                "contexts": {sdk.host: normalized}, "unit_graphs": {sdk.host: {"release": graph}},
                "original_source": {key: identity[key] for key in ["commit", "archive_sha256", "package_version"]},
            }
            parity.validate_document(document)
            with args.output.open("x") as output:
                output.write(json.dumps(document, indent=2, sort_keys=True) + "\n")
        finally:
            sdk.close()


def publish_binding(source, output, platform):
    kind, cpu = PLATFORMS[platform]
    with source.open("rb") as file:
        header = file.read(64)
    if kind == "elf":
        valid = len(header) == 64 and header[:7] == b"\x7fELF\x02\x01\x01" and struct.unpack_from("<H", header, 16)[0] == 3 and struct.unpack_from("<H", header, 18)[0] == cpu
    else:
        valid = len(header) >= 32 and header[:4] == b"\xcf\xfa\xed\xfe" and struct.unpack_from("<I", header, 4)[0] == cpu and struct.unpack_from("<I", header, 12)[0] == 6
    if not valid:
        raise ValueError("Rolldown binding is not the selected native shared-library ABI")
    with source.open("rb") as original, output.open("xb") as destination:
        shutil.copyfileobj(original, destination)
    output.chmod(0o555)


def publish_metadata(tree, output):
    members = list(tree.resolve(strict=True).iterdir())
    if len(members) != 1 or members[0].name != "rolldown_binding" or not stat.S_ISREG(members[0].lstat().st_mode):
        raise ValueError("Rolldown compiler did not emit its exact NAPI metadata File")
    _publish_metadata_bytes(members[0].read_bytes(), output)


def publish_metadata_file(metadata, output):
    # This ordinary File is emitted by the same Rust compiler action. Bazel may
    # present a File input through an engine symlink; the original Tree publisher
    # continues to reject authored member aliases.
    original = metadata.resolve(strict=True)
    if not stat.S_ISREG(original.lstat().st_mode):
        raise ValueError("Rolldown compiler NAPI output is not an ordinary File")
    _publish_metadata_bytes(original.read_bytes(), output)


def _publish_metadata_bytes(contents, output):
    lines = contents.splitlines()
    if not lines or any(not isinstance(json.loads(line), dict) for line in lines):
        raise ValueError("Rolldown NAPI compiler metadata is absent or invalid")
    with output.open("xb") as destination:
        destination.write(contents)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    context = commands.add_parser("acquire")
    for name in ["descriptor", "source-root", "registry", "provenance", "sdk-resolver", "contexts", "parity", "materializer", "capture", "source-archive", "output"]:
        context.add_argument("--" + name, type=Path, required=True)
    context.add_argument("--producer", required=True)
    context.add_argument("--source-instances", type=Path, required=True)
    context.add_argument("--source-instance", required=True)
    binding = commands.add_parser("publish-binding")
    binding.add_argument("--input", type=Path, required=True)
    binding.add_argument("--output", type=Path, required=True)
    binding.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    binding.add_argument("--type-defs-file", type=Path, required=True)
    binding.add_argument("--metadata-output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "acquire":
        acquire(args)
    else:
        publish_binding(args.input, args.output, args.platform)
        publish_metadata_file(args.type_defs_file, args.metadata_output)


if __name__ == "__main__":
    main()
