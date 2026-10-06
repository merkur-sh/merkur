"""Materialize the original isolated Bolero/Kani workspace from a declared SDK."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tempfile
import tomllib


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("Missing declared bounded-workspace implementation")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def member(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Bounded source path must be a canonical declared member")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in {".", ".."} for part in value.split("/")):
        raise ValueError("Bounded source path must be a canonical declared member")
    return path


def cargo_paths(value, original, destination, source_root):
    """Original absoluteCargoPaths semantics, expressed within a movable Tree."""
    if isinstance(value, list):
        return [cargo_paths(entry, original, destination, source_root) for entry in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, entry in value.items():
        if key == "path" and isinstance(entry, str):
            path = (original / entry).resolve(strict=True)
            if not path.is_relative_to(source_root.resolve(strict=True)):
                raise ValueError("Cargo path escaped the declared original source Tree")
            result[key] = os.path.relpath(path, destination.resolve(strict=False))
        else:
            result[key] = cargo_paths(entry, original, destination, source_root)
    return result


def prepare(source, workspace, toml_text):
    production = tomllib.loads((source / "Cargo.toml").read_text())
    for path in production["workspace"]["members"]:
        path = member(path)
        if not (source / path / "Cargo.toml").is_file():
            raise ValueError("Bounded closure omitted a production workspace member manifest")
    targets = json.loads((source / "tools/bolero/targets.json").read_text())
    if not isinstance(targets, list) or not targets:
        raise ValueError("Bounded workspace requires its original target inventory")
    names = [str(member(target["crate"])) for target in targets]
    if len(set(names)) != len(names) or any("/" in name for name in names):
        raise ValueError("Bounded target package names must be unique ordinary members")
    root_manifest = {
        "workspace": {"resolver": "3", "members": names, "lints": copy.deepcopy(production["workspace"]["lints"])},
        "patch": cargo_paths(production["patch"], source, workspace, source),
        "profile": {"fuzz": {"inherits": "dev", "opt-level": 3, "codegen-units": 1,
                             "debug-assertions": True, "overflow-checks": True}},
    }
    rendered = {"Cargo.toml": toml_text(root_manifest) + "\n"}
    copies = []
    for target in targets:
        original = source / "packages" / target["crate"]
        destination = workspace / target["crate"]
        generated = cargo_paths(tomllib.loads((original / "Cargo.toml").read_text()), original, destination, source)
        generated["package"] = {**generated["package"], "name": target["crate"] + "-fuzz", "autotests": False}
        root = original / "src/lib.rs"
        if not root.is_file():
            raise ValueError("Bounded target omitted its production library source")
        generated["lib"] = {**generated.get("lib", {}), "name": target["crate"].replace("-", "_"), "path": os.path.relpath(root, destination)}
        generated["dev-dependencies"] = {**generated.get("dev-dependencies", {}), "bolero": "=0.13.6"}
        if isinstance(target.get("source"), str):
            adapter = source / "tools/bolero" / member(target["source"])
            if not adapter.is_file():
                raise ValueError("Bounded closure omitted an original adapter")
            generated["test"] = [{"name": "fuzz", "path": os.path.relpath(adapter, destination)}]
        rendered[target["crate"] + "/Cargo.toml"] = toml_text(generated) + "\n"
        # The original preparer exposes each manifest-relative asset directory.
        # Copies preserve that namespace without aliases outside the output Tree.
        copies += [(entry, destination / entry.name) for entry in original.iterdir()
                   if entry.name not in {"Cargo.toml", "Cargo.lock", "target"}]
    lock = (source / "tools/bolero/Cargo.lock").read_bytes()
    for text in rendered.values():
        tomllib.loads(text)
    workspace.mkdir(exist_ok=True)
    for original, destination in copies:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if original.is_dir():
            shutil.copytree(original, destination)
        else:
            shutil.copyfile(original, destination)
    for path, text in rendered.items():
        destination = workspace / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)
    (workspace / "Cargo.lock").write_bytes(lock)
    return lock


def build(args):
    capture = load("bounded_capture", args.capture)
    materializer = load("bounded_materializer", args.materializer)
    resolver = load("bounded_sdk", args.sdk_resolver)
    contexts = load("bounded_contexts", args.contexts)
    descriptor = json.loads(args.descriptor.read_text())
    provenance = json.loads(args.provenance.read_text())
    if descriptor["execution_host"] != args.execution_host:
        raise ValueError("Bounded flags require the actual declared SDK execution host")
    if provenance["producer"] != args.producer or provenance["execution_host"] != descriptor["execution_host"] or capture.bytes_fact(args.descriptor) != provenance["descriptor"]:
        raise ValueError("Bounded workspace requires its actual typed SDK producer")
    with tempfile.TemporaryDirectory(prefix="merkur-bounded-workspace-") as temporary:
        tree = Path(temporary).resolve(strict=True) / "tree"
        source, registry, workspace = tree / "original", tree / "vendor", tree
        source.mkdir(parents=True)
        registry.mkdir()
        materializer.materialize(args.source_root, provenance["source_files"], source, capture)
        descriptor["registry"]["files"] = materializer.materialize(args.registry, descriptor["registry"]["files"], registry, capture)
        descriptor["registry"]["directory"] = str(registry)
        descriptor["locks"] = [{**fact, "path": str(source / Path(fact["path"]).absolute().relative_to(args.source_root.absolute()))} for fact in descriptor["locks"]]
        sdk = resolver.NativeCargoSdk(descriptor)
        try:
            sdk.require_locks([source / "Cargo.lock", source / "tools/bolero/Cargo.lock"])
            lock = prepare(source, workspace, contexts.toml_text)
            # Consumers copy this File to the copied Tree's .cargo/config.toml.
            # Cargo resolves that file's paths from its .cargo directory parent.
            configuration = '[source.crates-io]\nreplace-with="merkur-bounded"\n[source.merkur-bounded]\ndirectory="vendor"\n[net]\noffline=true\n'
            (tree / ".cargo").mkdir()
            (tree / ".cargo/config.toml").write_text(configuration)
            if args.tree.exists():
                if args.tree.is_symlink() or not args.tree.is_dir() or any(args.tree.iterdir()):
                    raise ValueError("Bounded output must be absent or empty ordinary TreeArtifact")
                args.tree.rmdir()
            shutil.copytree(tree, args.tree)
            args.lock.write_bytes(lock)
            args.manifest.write_bytes((tree / "Cargo.toml").read_bytes())
            args.vendor_config.write_text(configuration)
        finally:
            sdk.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["descriptor", "provenance", "source-root", "registry", "capture", "materializer", "sdk-resolver", "contexts", "tree", "manifest", "lock", "vendor-config"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--producer", required=True)
    parser.add_argument("--execution-host", required=True)
    build(parser.parse_args())
