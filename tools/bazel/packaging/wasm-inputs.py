"""Original typed WASM package member custody shared by selected consumers."""
import hashlib
import importlib.util
from pathlib import Path


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deployment = load('deployment-pack')
npm = load('npm-notices')
closure = npm.closure
pack = deployment.pack


def wasm_inputs(records, namespace, owned):
    """Capture original typed generated members; this is not a Rust/license closure."""
    if not isinstance(records, list):
        raise ValueError('Invalid typed WASM package inventory')
    packages = []
    roots = set()
    for record in records:
        if not isinstance(record, dict) or set(record) != {'producer', 'tree', 'inventory'}:
            raise ValueError('Invalid original typed WASM package descriptor')
        producer = npm.label(record['producer'])
        tree = deployment.descriptor(record['tree'])
        inventory = deployment.descriptor(record['inventory'])
        tree_label = npm.label(tree['label'])
        if npm.label(inventory['label']) != producer:
            raise ValueError('WASM member inventory belongs to another original producer')
        pinned, _, _ = owned.file(owned.presentation(inventory['input']))
        captured = pack.load_json(owned.read(pinned))
        if (not isinstance(captured, dict) or set(captured) != {'producer', 'module', 'members'}
                or npm.label(captured['producer']) != producer
                or not closure.nonempty(captured['module'])
                or not isinstance(captured['members'], list) or not captured['members']):
            raise ValueError('Invalid original WASM producer member inventory')
        expected = {}
        for fact in captured['members']:
            if not isinstance(fact, dict) or set(fact) != {'member', 'size', 'sha256'}:
                raise ValueError('Invalid original WASM package member fact')
            member = closure.inputs.relative(fact['member'])
            if (member in expected or type(fact['size']) is not int or fact['size'] <= 0
                    or not isinstance(fact['sha256'], str) or len(fact['sha256']) != 64
                    or any(character not in '0123456789abcdef' for character in fact['sha256'])):
                raise ValueError('Invalid or duplicate original WASM package member fact')
            expected[member] = fact
        entries = deployment.declared_tree(tree, 'wasm', namespace, owned)
        entries = {name[len('wasm/'):]: entry for name, entry in entries.items()}
        if set(entries) != set(expected):
            raise ValueError('WASM package differs from its complete original member inventory')
        root = owned.presentation(tree['input'])
        if root in roots:
            raise ValueError('Duplicate original typed WASM package root')
        roots.add(root)
        for member, (_, pinned, size) in entries.items():
            if size != expected[member]['size'] or hashlib.sha256(owned.read(pinned)).hexdigest() != expected[member]['sha256']:
                raise ValueError('WASM member bytes differ from original producer inventory')
        packages.append({'root': root, 'entries': entries, 'producer': producer,
                         'tree_label': tree_label, 'module': captured['module']})
    return packages


