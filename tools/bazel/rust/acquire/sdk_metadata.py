"""Consume a typed original-archive SDK for Cargo introspection only."""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import subprocess
import tempfile


def materialize(tree, facts, destination, capture):
    """Copy the producer's exact File inventory, including engine presentations.

    Input TreeArtifact members may be sandbox symlinks. Only the typed producer's
    full byte-bound inventory is consumed; the isolated Cargo source is ordinary.
    """
    expected = {}
    root = tree.absolute()
    for fact in facts:
        if not isinstance(fact, dict) or set(fact) != {"path", "size", "sha256"}:
            raise ValueError("invalid producer File fact")
        relative = Path(fact["path"]).absolute().relative_to(root)
        if not relative.parts or any(p in {".", ".."} for p in relative.parts) or relative in expected:
            raise ValueError("producer File lies outside its typed TreeArtifact or is duplicated")
        expected[relative] = fact
    actual = set()
    for path in tree.rglob("*"):
        if path.is_dir():
            if path.is_symlink():
                raise ValueError("input TreeArtifact contains an aliased directory")
        elif path.is_file():
            actual.add(path.absolute().relative_to(root))
        else:
            raise ValueError("input TreeArtifact has an unsupported entry")
    if actual != set(expected):
        raise ValueError("producer File inventory differs from its typed TreeArtifact")
    rewritten = []
    for relative, fact in sorted(expected.items()):
        data, mode, observed = capture.read_regular(tree / relative)
        if observed != fact:
            raise ValueError("producer File bytes changed in engine presentation")
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(data)
        output.chmod(mode)
        rewritten.append({**fact, "path": str(output)})
    return rewritten


@contextmanager
def materialized_sdk(descriptor_path, provenance_path, source_root, registry_root, producer, capture, resolver, *, private_parent):
    """Consume the genuine producer's typed Trees before the strict SDK loader."""
    descriptor = json.loads(descriptor_path.read_text())
    provenance = json.loads(provenance_path.read_text())
    if provenance["producer"] != producer or provenance["execution_host"] != descriptor["execution_host"] or capture.bytes_fact(descriptor_path) != provenance["descriptor"]:
        raise ValueError("typed producer/provenance/descriptor binding differs")
    private_parent = Path(private_parent).resolve(strict=True)
    if not private_parent.is_dir():
        raise ValueError("SDK materialization requires its declared output/work directory")
    with tempfile.TemporaryDirectory(prefix="merkur-acquisition-presentation-", dir=private_parent) as temporary:
        private_root = Path(temporary)
        copied_source = private_root / "sources"
        copied_source.mkdir()
        materialize(source_root, provenance["source_files"], copied_source, capture)
        copied_registry = private_root / "registry"
        copied_registry.mkdir()
        descriptor["registry"]["files"] = materialize(registry_root, descriptor["registry"]["files"], copied_registry, capture)
        descriptor["registry"]["directory"] = str(copied_registry)
        descriptor["locks"] = [{**fact, "path": str(copied_source / Path(fact["path"]).absolute().relative_to(source_root.absolute()))} for fact in descriptor["locks"]]
        sdk = resolver.NativeCargoSdk(descriptor)
        try:
            yield sdk, copied_source
        finally:
            sdk.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["descriptor", "source-root", "registry", "provenance", "sdk-resolver", "capture", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--producer", required=True)
    args = parser.parse_args()
    relative = PurePosixPath(args.manifest)
    if relative.is_absolute() or str(relative) != args.manifest or "\\" in args.manifest or any(p in {"", ".", ".."} for p in args.manifest.split("/")):
        raise ValueError("manifest must be an exact source snapshot member")
    spec = importlib.util.spec_from_file_location("declared_sdk", args.sdk_resolver)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared SDK resolver File")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    capture_spec = importlib.util.spec_from_file_location("declared_capture", args.capture)
    if capture_spec is None or capture_spec.loader is None:
        raise ValueError("missing declared File capture implementation")
    capture = importlib.util.module_from_spec(capture_spec)
    capture_spec.loader.exec_module(capture)
    with materialized_sdk(args.descriptor, args.provenance, args.source_root, args.registry,
                          args.producer, capture, module,
                          private_parent=args.output.absolute().parent) as (sdk, source):
        manifest = source / relative
        sdk.require_locks([manifest.parent / "Cargo.lock"])
        def acquire(arguments, bootstrap=False):
            result = subprocess.run(sdk.command("cargo", "1.97.1") + arguments,
                                    cwd=source, env=sdk.environment(bootstrap),
                                    capture_output=True, text=True)
            if result.returncode:
                raise ValueError(result.stderr)
            return json.loads(result.stdout)
        metadata = acquire(["metadata", "--locked", "--offline", "--format-version", "1", "--manifest-path", str(manifest)])
        graph = acquire(["build", "--unit-graph", "-Z", "unstable-options", "--offline", "--locked", "--manifest-path", str(manifest)], True)
        artifacts = [str(p) for extension in ["*.rlib", "*.rmeta", "*.o"] for p in sdk.home.rglob(extension)]
        if artifacts:
            raise ValueError("introspection unexpectedly produced compiler artifacts")
        receipt = {"execution_host": sdk.host, "sdk_files": len(sdk.descriptor["sdk"]),
                   "descriptor_sha256": hashlib.sha256(args.descriptor.read_bytes()).hexdigest(),
                   "packages": sorted([{key: p.get(key) for key in ["name", "version", "source"]} for p in metadata["packages"]], key=lambda p: (p["name"], p["version"])),
                   "units": len(graph["units"]), "roots": graph["roots"],
                   "compiler_artifacts": artifacts,
                   "scope": "Declared Cargo metadata and unit graph only; product/native-pool admission remains independent."}
        args.output.write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
