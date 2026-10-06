"""Execute policy refresh/controls against the genuine acquisition SDK outputs."""

import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile


def load(path):
    spec = importlib.util.spec_from_file_location("declared_policy_boundary", path)
    if spec is None or spec.loader is None:
        raise ValueError("missing declared policy acquisition implementation File")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def relative(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("policy input requires a declared relative File path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("policy input requires a declared relative File path")
    return path


def request(value):
    if not isinstance(value, dict) or set(value) != {"descriptor", "registry", "sources", "provenance", "producer", "declarations"}:
        raise ValueError("policy acquisition requires its exact typed SDK inputs")
    declarations = value["declarations"]
    if not isinstance(declarations, dict):
        raise ValueError("policy acquisition requires declared File presentations")
    for original, runfile in declarations.items():
        relative(original)
        relative(runfile)
    for role in ["descriptor", "registry", "sources", "provenance"]:
        if value[role] not in declarations:
            raise ValueError("policy SDK role is absent from its declared File closure")
    if not isinstance(value["producer"], str) or not value["producer"].startswith(("//", "@@//")):
        raise ValueError("policy acquisition requires its configured SDK producer")
    return value


@contextmanager
def execution_paths(specification, runfiles_root):
    """Present exact File execpaths, then reuse the existing strict Tree consumer.

    No facts are rewritten or paths inferred from physical parents. The original
    producer descriptor/provenance stays intact in the TestRunner presentation.
    """
    if runfiles_root is None:
        yield
        return
    runfiles_root = Path(runfiles_root).resolve(strict=True)
    declarations = specification["declarations"]
    original_descriptor = runfiles_root / declarations[specification["descriptor"]]
    descriptor = json.loads(original_descriptor.read_bytes())
    needed = [specification[role] for role in ["descriptor", "registry", "sources", "provenance"]]
    needed += [descriptor["cargo"]["path"], descriptor["rustc"]["path"]]
    needed += [fact["path"] for fact in descriptor["sdk"]]
    if any(path not in declarations for path in needed):
        raise ValueError("policy SDK runtime File is absent from its declared closure")
    with tempfile.TemporaryDirectory(prefix="merkur-policy-execpaths-") as temporary:
        root = Path(temporary)
        for original in sorted(set(needed)):
            destination = root / relative(original)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.symlink_to(runfiles_root / declarations[original], target_is_directory=original in {specification["registry"], specification["sources"]})
        previous = Path.cwd()
        os.chdir(root)
        try:
            yield
        finally:
            os.chdir(previous)


def command(mode, policy, controls, descriptor, resolver, source):
    if mode == "refresh":
        return [sys.executable, "-I", "-B", str(policy), "--refresh", "--sdk-descriptor", str(descriptor),
                "--sdk-resolver", str(resolver), "--source-root", str(source)]
    if mode == "controls":
        return [sys.executable, "-I", "-B", str(controls), "--policy", str(policy), "--sdk-descriptor", str(descriptor),
                "--sdk-resolver", str(resolver), "--source-root", str(source)]
    raise ValueError("unsupported policy acquisition operation")


def execute(args):
    specification = request(json.loads(args.request.read_bytes()))
    policy, controls, resolver_path = [path.resolve(strict=True) for path in [args.policy, args.controls, args.sdk_resolver]]
    presentation, capture, resolver = [load(path.resolve(strict=True)) for path in [args.presentation, args.capture, args.sdk_resolver]]
    if args.mode == "refresh" and args.output is None:
        raise ValueError("policy refresh requires its declared output Tree")
    if args.mode == "controls" and args.output is not None:
        raise ValueError("policy controls cannot publish policy snapshots")
    output = args.output.absolute() if args.output is not None else None
    private_parent = args.private_parent.resolve(strict=True)
    with execution_paths(specification, args.runfiles_root):
        with presentation.materialized_sdk(Path(specification["descriptor"]), Path(specification["provenance"]),
                Path(specification["sources"]), Path(specification["registry"]), specification["producer"], capture, resolver,
                private_parent=private_parent) as (sdk, source):
            with tempfile.TemporaryDirectory(prefix="merkur-policy-command-") as temporary:
                descriptor = Path(temporary) / "descriptor.json"
                descriptor.write_text(json.dumps(sdk.descriptor))
                subprocess.run(command(args.mode, policy, controls, descriptor, resolver_path, source),
                    check=True, env={"PATH": "", "HOME": temporary, "TMPDIR": temporary})
            if args.mode == "refresh":
                owned = capture.OwnedOutputs([output], [output] if args.engine_precreated_tree_root else [])
                try:
                    owned.tree(output)
                    for name in ["production", "bolero", "ownership", "aya"]:
                        member = "policy_snapshots/" + name + ".json"
                        owned.write(member, (source / "tools/bazel/rust" / member).read_bytes(), root=output)
                    owned.write("policy_graphs.bzl", (source / "tools/bazel/rust/policy_graphs.bzl").read_bytes(), root=output)
                    owned.verify()
                except BaseException:
                    owned.cleanup()
                    raise
                finally:
                    owned.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["refresh", "controls"], required=True)
    for name in ["request", "policy", "controls", "sdk-resolver", "presentation", "capture"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--private-parent", type=Path, required=True)
    parser.add_argument("--runfiles-root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--engine-precreated-tree-root", action="store_true")
    execute(parser.parse_args())


if __name__ == "__main__":
    main()
