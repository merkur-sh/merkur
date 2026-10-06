"""Exercise the existing publisher on genuine Rust-emitted NAPI JSONL and mutations."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile


def publisher(path):
    spec = importlib.util.spec_from_file_location("original_rolldown_publisher", path)
    if spec is None or spec.loader is None:
        raise ValueError("Missing declared Rolldown publisher File")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.publish_metadata


def controls(tree, publish):
    with tempfile.TemporaryDirectory(dir=os.environ.get("TEST_TMPDIR")) as temporary:
        root = Path(temporary)
        # This sole positive comes directly from the original Rustc output group.
        retained = root / "original.jsonl"
        publish(tree, retained)
        data = retained.read_bytes()
        records = data.splitlines()
        changes = [
            ("empty-tree", None),
            ("empty-member", b""),
            ("truncated-json", data[:-2]),
            ("non-object-record", b"[]\n" + b"\n".join(records[1:])),
            ("extra-member", data),
            ("member-alias", data),
        ]
        for name, contents in changes:
            mutated = root / name
            mutated.mkdir()
            member = mutated / "rolldown_binding"
            if contents is not None:
                member.write_bytes(contents)
            if name == "extra-member":
                (mutated / "unexpected").write_bytes(b"undeclared member")
            if name == "member-alias":
                member.unlink()
                member.symlink_to(retained)
            destination = root / (name + ".jsonl")
            try:
                publish(mutated, destination)
            except (OSError, ValueError):
                if destination.exists():
                    raise AssertionError("Refused metadata was published: " + name)
                continue
            raise AssertionError("Mutated compiler metadata was accepted: " + name)
    return len(records), len(changes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--publisher", required=True, type=Path)
    arguments = parser.parse_args()
    definitions, rejected = controls(arguments.directory, publisher(arguments.publisher))
    print(json.dumps({"compiler_definitions": definitions, "rejected_mutations": rejected}))


if __name__ == "__main__":
    main()
