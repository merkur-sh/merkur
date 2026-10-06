#!/usr/bin/env python3
"""Refresh declared Rust macro inputs with the pinned native parser."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
HERE = ROOT / "tools/bazel/rust"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bazel", type=Path, required=True)
    args = parser.parse_args()
    metadata = HERE / "metadata.json"
    before = hashlib.sha256(metadata.read_bytes()).hexdigest()
    environment = {name: os.environ[name] for name in ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR"] if name in os.environ}
    result = subprocess.run([str(args.bazel.resolve()), "run", "//tools/bazel/rust:source_inputs", "--", str(ROOT), str(metadata)], cwd=ROOT, env=environment, check=True, text=True, stdout=subprocess.PIPE)
    document = json.loads(result.stdout)
    if document["metadata_sha256"] != before or hashlib.sha256(metadata.read_bytes()).hexdigest() != before:
        raise ValueError("Rust metadata changed during macro discovery")
    for path, expected in {**document["sources"], **document["included_sources"]}.items():
        if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != expected:
            raise ValueError("Rust source changed during macro discovery: " + path)
    (HERE / "source_inputs.json").write_text(json.dumps(document, sort_keys=True, indent=2) + "\n")
    print(f"Declared Rust macro inputs: {len(document['sources'])} source files, {sum(len(inputs) for inputs in document['macros'].values())} includes")


if __name__ == "__main__":
    main()
