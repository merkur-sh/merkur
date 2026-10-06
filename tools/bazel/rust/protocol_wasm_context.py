"""Capture the original WASM cipher test context from its current declared source SDK."""
import argparse
import importlib.util
import json
from pathlib import Path


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise ValueError("Missing declared WASM context helper File")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def capture(sdk, root, provenance, descriptor, producer, source_helper, generator):
    # Reuse the original full source inventory authorizer; the golden context is
    # an ordinary captured source input, never the destination of this action.
    inputs = source_helper.sources(sdk, root, provenance, descriptor, producer)
    normalized, graph = generator.capture_original_graph(sdk, root)
    return {
        "mode": "test",
        "platform": "wasm",
        "package": "merkur-e2e",
        "inputs": inputs,
        "generated_inputs": {},
        "contexts": {"wasm32-unknown-unknown": normalized},
        "unit_graphs": {"wasm32-unknown-unknown": {"test-release": graph}},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["sdk-descriptor", "sdk-provenance", "sdk-resolver", "source-root",
                 "source-helper", "protocol-generator", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--producer", required=True)
    args = parser.parse_args()
    resolver = load("declared_wasm_context_sdk", args.sdk_resolver)
    source_helper = load("declared_wasm_context_sources", args.source_helper)
    generator = load("declared_wasm_context_recipe", args.protocol_generator)
    sdk = resolver.NativeCargoSdk.load(args.sdk_descriptor)
    try:
        root = sdk.original_tree(args.source_root)
        document = capture(sdk, root, json.loads(args.sdk_provenance.read_bytes()),
                           args.sdk_descriptor, args.producer, source_helper, generator)
        body = json.dumps(document, indent=2, sort_keys=True) + "\n"
        # Bazel declares one new File, rather than an engine-precreated Tree.
        # Exclusive creation also refuses an occupied path or source-file alias.
        with args.output.open("x", encoding="utf-8") as output:
            output.write(body)
    finally:
        sdk.close()


if __name__ == "__main__":
    main()
