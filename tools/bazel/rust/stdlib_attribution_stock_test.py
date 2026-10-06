"""Manual original-stock regression using only generated declared File carriers."""
import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
import types
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def native(target):
    machine = os.uname().machine
    expected = {("darwin", "arm64"): "aarch64-apple-darwin", ("darwin", "x86_64"): "x86_64-apple-darwin",
                ("linux", "aarch64"): "aarch64-unknown-linux-gnu", ("linux", "x86_64"): "x86_64-unknown-linux-gnu"}.get((sys.platform, machine))
    if expected is None or target != expected:
        raise ValueError("Stock test must match the actual native execution host")


def install(request, runfiles, root):
    if set(request) != {'request', 'carriers'}:
        raise ValueError('Exact generated stock test request required')
    seen = set()
    for row in request['carriers']:
        if set(row) != {'input', 'runfile'}:
            raise ValueError('Exact declared File carrier required')
        for field in row.values():
            if not isinstance(field, str) or field.startswith('/') or any(part in ('', '.', '..') for part in field.split('/')):
                raise ValueError('Portable declared File carrier required')
        if row['input'] in seen:
            raise ValueError('Duplicate declared File input')
        seen.add(row['input'])
        leaf = root / row['input']
        leaf.parent.mkdir(parents=True, exist_ok=True)
        leaf.symlink_to(runfiles / row['runfile'])
    return request['request']


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--runfiles', required=True)
    args = parser.parse_args()
    runfiles = Path(args.runfiles)
    if not runfiles.is_absolute():
        raise ValueError('Absolute engine runfiles namespace required')
    request = json.loads(Path(args.request).read_bytes())
    lexical = Path(__file__).parent
    controls = load('stdlib_original_controls', lexical / 'stdlib_attribution_test.py')
    controls.collector = load('stdlib_mapper', lexical / 'stdlib_attribution.py')
    controls.deployment = load('stdlib_custody', lexical.parent / 'packaging/deployment-pack.py')
    controls.outputs = load('stdlib_outputs', lexical / 'acquire/sdk_producer.py')
    controls.graph_module = load('stdlib_graph', lexical.parent / 'packaging/stdlib-native-graph.py')
    with tempfile.TemporaryDirectory(prefix='stdlib-stock-declared-') as directory:
        root = Path(directory)
        spec = install(request, runfiles, root)
        native(spec['target'])
        provider = {'stdlib': [{'input': row['path'], 'label': row['label']} for row in spec['stdlib']]}
        (root / 'provider.json').write_text(json.dumps(provider))
        selected = next(row for row in spec['stdlib'] if Path(row['path']).name.startswith('libstd-') and Path(row['path']).suffix == '.rlib')
        controls.args = types.SimpleNamespace(
            rustc=str(root / spec['rustc']['path']),
            stdlib=str(root / selected['path']), execroot=str(root), stdlib_files=str(root / 'provider.json'),
            source_archive=str(root / spec['source']['path']), stdlib_archive=str(root / spec['stdlib_archive']['path']),
            rustc_archive=str(root / spec['rustc_archive']['path']), graph=str(root / spec['graph']['path']),
        )
        class DeclaredStockControls(controls.AttributionTests):
            def test_original_metadata_identity_custody_and_exact_coverage_are_mandatory(self):
                self.changed_graph(lambda g: g['metadata'].pop(), 'metadata omitted')
                self.changed_graph(lambda g: g['metadata'].append(g['metadata'][0]), 'Duplicate or malformed')
                original = self.graph['stock_association']['members'][0]['metadata_input']
                Path('foreign.rmeta').write_bytes(Path(original).read_bytes())
                self.changed_graph(lambda g: g['stock_association']['members'][0].update(metadata_input='foreign.rmeta'), 'no exact original distribution File')
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(DeclaredStockControls))
        raise SystemExit(not result.wasSuccessful())
