"""Copy exactly declared package files into a regular, isolated attribution tree."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('license_inputs', Path(__file__).with_name('license-inputs.py'))
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)
spec = importlib.util.spec_from_file_location('output_tree', Path(__file__).with_name('output-tree.py'))
outputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(outputs)


def produce(value, output):
    if not isinstance(value, dict) or set(value) != {'manifest', 'files'}:
        raise ValueError('Invalid declared package tree schema')
    manifest = Path(value['manifest'])
    # Bazel materializes each declared input as a file alias in the action sandbox.
    # The exact declared manifest identifies the physical package origin; every
    # resolved source must stay beneath that same origin and preserve its member path.
    root = manifest.resolve(strict=True).parent
    files = value['files']
    if not isinstance(files, list) or not files:
        raise ValueError('Empty declared package source inventory')
    names = set()
    entries = []
    for item in files:
        if not isinstance(item, dict) or set(item) != {'path', 'input'}:
            raise ValueError('Invalid declared package file')
        name = inputs.relative(item['path'])
        source = Path(item['input'])
        try:
            physical = source.resolve(strict=True)
            expected = root.joinpath(name).resolve(strict=True)
        except FileNotFoundError as error:
            raise ValueError('Declared package member is missing') from error
        if name in names or physical != expected:
            raise ValueError('Duplicated or redirected declared package file')
        if root not in physical.parents:
            raise ValueError('Declared package input escapes its source root')
        names.add(name)
        entries.append(name)
    manifest_name = manifest.name
    if manifest_name not in ('Cargo.toml', 'package.json') or manifest_name not in names or manifest.resolve(strict=True) != root / manifest_name:
        raise ValueError('Exact declared package manifest is missing')
    tree = outputs.OutputTree(output)
    try:
        for name in sorted(entries):
            # Presentation aliases are allowed only in the engine sandbox. Read
            # the logical member in the actual package through no-follow FDs:
            # resolving it here would erase an original file or directory alias.
            data = inputs.read_regular(root, name, require_text=False)
            tree.write(name, data)
        tree.verify()
    except BaseException as primary:
        try:
            tree.cleanup()
        except BaseException as cleanup:
            raise BaseExceptionGroup('Package copy and cleanup failed', [primary, cleanup])
        raise
    finally:
        tree.close()


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf8') as source:
        produce(json.load(source), Path(sys.argv[2]))
