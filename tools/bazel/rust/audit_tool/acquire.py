"""Acquire cargo-audit's locked native compiler graph through declared SDK Files."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("Missing declared cargo-audit acquisition implementation")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def acquire(args):
    original = load("audit_original", args.original)
    originals, _ = original.original(args.source_archive)
    capture = load("audit_capture", args.capture)
    materializer = load("audit_materializer", args.materializer)
    resolver = load("audit_sdk", args.sdk_resolver)
    contexts = load("audit_contexts", args.contexts)
    parity = load("audit_parity", args.parity)
    descriptor = json.loads(args.descriptor.read_text())
    provenance = json.loads(args.provenance.read_text())
    if provenance["producer"] != args.producer or provenance["execution_host"] != descriptor["execution_host"] or capture.bytes_fact(args.descriptor) != provenance["descriptor"]:
        raise ValueError("cargo-audit context is not bound to its declared SDK producer")
    with tempfile.TemporaryDirectory(prefix="merkur-cargo-audit-context-") as temporary:
        root = Path(temporary).resolve(strict=True)
        source, registry = root / "source", root / "registry"
        source.mkdir()
        registry.mkdir()
        facts = materializer.materialize(args.source_root, provenance["source_files"], source, capture)
        membership = {str(Path(fact["path"]).relative_to(source)) for fact in facts}
        if membership != originals.keys() or any((source / path).read_bytes() != data for path, data in originals.items()):
            raise ValueError("cargo-audit source closure differs from its original archive")
        descriptor["registry"]["files"] = materializer.materialize(args.registry, descriptor["registry"]["files"], registry, capture)
        descriptor["registry"]["directory"] = str(registry)
        descriptor["locks"] = [{**fact, "path": str(source / Path(fact["path"]).absolute().relative_to(args.source_root.absolute()))} for fact in descriptor["locks"]]
        sdk = resolver.NativeCargoSdk(descriptor)
        try:
            manifest = source / "Cargo.toml"
            sdk.require_locks([source / "Cargo.lock"])
            contexts.ROOT = source
            raw = contexts.resolve(manifest, sdk.host, "1.97.1", False, sdk=sdk)
            normalized = contexts.normalize(raw, manifest, manifest)
            graph = contexts.unit_graph(manifest, sdk.host, "1.97.1", "release", raw, normalized, source, sdk=sdk)
            selected = [graph["units"][index] for index in graph["roots"]]
            original.native_binary(selected)
            if any(next(sdk.home.rglob(suffix), None) is not None for suffix in ["*.rlib", "*.rmeta", "*.o"]):
                raise ValueError("cargo-audit acquisition unexpectedly compiled an artifact")
            document = {
                "package": original.NAME, "mode": "release", "platform": "native",
                "inputs": {str(Path(fact["path"]).relative_to(source)): fact["sha256"] for fact in facts},
                "contexts": {sdk.host: normalized}, "unit_graphs": {sdk.host: {"release": graph}},
                "original_source": {"name": original.NAME, "version": original.VERSION, "archive_sha256": original.SHA256,
                                    "cargo_lock_sha256": hashlib.sha256(originals["Cargo.lock"]).hexdigest()},
            }
            parity.validate_document(document)
            with args.output.open("x") as output:
                output.write(json.dumps(document, indent=2, sort_keys=True) + "\n")
        finally:
            sdk.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["source-archive", "descriptor", "provenance", "source-root", "registry", "original", "capture", "materializer", "sdk-resolver", "contexts", "parity", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--producer", required=True)
    acquire(parser.parse_args())


if __name__ == "__main__":
    main()
