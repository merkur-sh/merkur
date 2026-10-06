"""Strict producer-bound attribution from declared package trees and graph metadata."""
import importlib.util
import json
from pathlib import Path
import re

module = importlib.util.spec_from_file_location('license_inputs', Path(__file__).with_name('license-inputs.py'))
inputs = importlib.util.module_from_spec(module)
module.loader.exec_module(inputs)

FIELDS = {'id', 'name', 'version', 'source', 'license', 'repository', 'license_file', 'source_label'}


def nonempty(value):
    return isinstance(value, str) and value.strip() == value and bool(value) and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def label(value):
    return nonempty(value) and re.fullmatch(r'(?:@@|@@?[A-Za-z0-9_.+~-]+)?//[A-Za-z0-9_./+~@-]*:[A-Za-z0-9_./+~@-]+', value) is not None


def component_fields(item):
    return FIELDS | {'private'} if 'private' in item else FIELDS


def validate_private_manifest(component, data):
    """Validate metadata bytes; original File custody remains the caller's obligation."""
    metadata = json.loads(data)
    if not isinstance(metadata, dict) or metadata.get('private') is not True or metadata.get('name') != component['name'] or metadata.get('license') != component['license'] or 'version' in metadata:
        raise ValueError('Private component differs from original workspace manifest')


def component_title(component):
    return component['name'] if 'private' in component else component['name'] + ' ' + component['version']


def validate(expected):
    if not isinstance(expected, dict) or set(expected) != {'producer', 'configuration', 'source_digest', 'components'}:
        raise ValueError('Invalid attribution closure schema')
    if not label(expected['producer']) or not nonempty(expected['configuration']):
        raise ValueError('Invalid attribution producer context')
    if not isinstance(expected['source_digest'], str) or not re.fullmatch('[a-f0-9]{64}', expected['source_digest']):
        raise ValueError('Invalid attribution source context')
    components = expected['components']
    if not isinstance(components, list) or not components:
        raise ValueError('Empty attribution graph')
    seen = set()
    for item in components:
        if not isinstance(item, dict) or set(item) != component_fields(item):
            raise ValueError('Invalid attribution component schema')
        if any(not nonempty(item[key]) for key in ['id', 'name']):
            raise ValueError('Incomplete attribution component metadata')
        if 'private' in item:
            if item['private'] is not True or item['version'] is not None or item['source'] is not None or not label(item['source_label']) or item['source_label'] not in {'//:package.json', '@@//:package.json'} or item['id'] != item['name'] + '#' + item['source_label'] or not nonempty(item['license']):
                raise ValueError('Invalid private unversioned workspace component')
        elif not nonempty(item['version']):
            raise ValueError('Incomplete attribution component metadata')
        if item['license'] in ['UNSTATED', 'unknown', 'see license file'] or not label(item['source_label']):
            raise ValueError('Unresolved attribution component metadata')
        for key in ['source', 'repository']:
            if item[key] is not None and not nonempty(item[key]):
                raise ValueError('Invalid attribution component origin')
        if item['license_file'] is not None:
            inputs.relative(item['license_file'])
        if item['license'] is not None and not nonempty(item['license']):
            raise ValueError('Invalid attribution license expression')
        if item['license'] is None and item['license_file'] is None:
            raise ValueError('Missing attribution license declaration')
        if item['id'] in seen:
            raise ValueError('Duplicate attribution component identity')
        seen.add(item['id'])
    return components


def collect(expected, materializations):
    """The caller supplies graph authority; materializations supply only declared paths."""
    components = validate(expected)
    if not isinstance(materializations, dict) or set(materializations) != {x['id'] for x in components}:
        raise ValueError('Incomplete declared package source inventory')
    result = []
    for component in sorted(components, key=lambda item: item['id']):
        supplied = materializations[component['id']]
        if not isinstance(supplied, dict) or set(supplied) != {'root', 'label'}:
            raise ValueError('Invalid declared package source shape')
        if supplied['label'] != component['source_label'] or not nonempty(supplied['root']):
            raise ValueError('Declared package source belongs to another producer')
        manifest = None
        if 'private' in component:
            manifest = inputs.read_regular(Path(supplied['root']), 'package.json')
            validate_private_manifest(component, manifest)
        texts = inputs.collect(supplied['root'], component['license_file'])
        if manifest is not None and inputs.read_regular(Path(supplied['root']), 'package.json') != manifest:
            raise ValueError('Private workspace manifest changed during collection')
        result.append({**component, 'texts': texts})
    return {key: expected[key] for key in ['producer', 'configuration', 'source_digest']} | {'components': result}


def render(inventory):
    """Render exact source text; preserve separate identities even when texts coincide."""
    lines = ['MERKUR LICENSES AND NOTICES', '',
             'Declared producer: ' + inventory['producer'],
             'Compiler configuration: ' + inventory['configuration'],
             'Source inventory SHA-256: ' + inventory['source_digest'], '']
    for component in inventory['components']:
        lines += ['-' * 78, component_title(component),
                  'Package identity: ' + component['id']]
        if component['license'] is not None:
            lines.append('License: ' + component['license'])
        else:
            lines.append('Declared license file: ' + component['license_file'])
        for key in ['source', 'repository']:
            if component[key] is not None:
                lines.append(key.capitalize() + ': ' + component[key])
        for text in component['texts']:
            lines += ['', 'Published input: ' + text['path'], 'SHA-256: ' + text['sha256'], '', text['text']]
        lines.append('')
    return '\n'.join(lines).encode('utf8')


def canonical(inventory):
    return (json.dumps(inventory, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf8')
