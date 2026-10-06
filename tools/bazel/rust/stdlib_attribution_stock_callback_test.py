"""Manual callback on the genuine same-action compiler artifact and producer outputs."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import os


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--runfiles', required=True)
    args = parser.parse_args()
    runfiles = Path(args.runfiles)
    if not runfiles.is_absolute():
        raise ValueError('Absolute engine runfiles namespace required')
    lexical = Path(__file__).parent
    carriers = load('stdlib_declared_test_carriers', lexical / 'stdlib_attribution_stock_test.py')
    mapper = load('stdlib_mapper', lexical / 'stdlib_attribution.py')
    inputs = load('stdlib_inputs', lexical.parent / 'packaging/license-inputs.py')
    original = Path.cwd()
    with tempfile.TemporaryDirectory(prefix='stdlib-stock-callback-') as directory:
        root = Path(directory)
        spec = carriers.install(json.loads(Path(args.request).read_bytes()), runfiles, root)
        carriers.native(spec['target'])
        os.chdir(root)
        try:
            if set(spec) != {'value', 'artifact', 'link_map', 'rustc', 'stdlib', 'target', 'compiler'} or spec['compiler'] != '1.97.1':
                raise ValueError('Original pinned compiler callback request required')
            inventory = mapper.parse_json(Path(spec['value']['input']).read_bytes())
            if inventory['rustc'] != {'path': spec['rustc']['path'], 'label': spec['rustc']['label'], **mapper.fact(Path(spec['rustc']['path']).read_bytes())}:
                raise ValueError('Stock notice inventory belongs to another actual action compiler File')
            artifact = {'path': spec['artifact']['path'], 'label': spec['artifact']['label'], **mapper.fact(Path(spec['artifact']['path']).read_bytes())}
            if inventory['link_map'] != {'path': spec['link_map']['path'], 'label': spec['link_map']['label'], **mapper.fact(Path(spec['link_map']['path']).read_bytes())}:
                raise ValueError('Stock notice inventory belongs to another same-action link map')
            records = {'actual_compiler_target': {'stdlib': [{'input': row['path'], 'label': row['label']} for row in spec['stdlib']]}}
            result = mapper.collect_compiled_stdlib(spec['value'], artifact, spec['target'], records, inputs)
            if not result['sources'] or not result['components'] or not inventory['selected_stdlib']:
                raise ValueError('Genuine selected stdlib callback output required')
            print('Same-action original stock stdlib callback PASS')
        finally:
            os.chdir(original)
