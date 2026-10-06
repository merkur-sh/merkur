"""Bind actual native Bun-selected generated members to original WASM producers.

Publish shipping NOTICES only after original selected members, configured Rust
module linkage, host proc-macros and executed generator licenses all agree.
"""
import importlib.util
import hashlib
import json
from pathlib import Path
import sys
import os
import subprocess
import tempfile


def load(path):
    specification = importlib.util.spec_from_file_location('wasm_inputs', path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


NATIVE_COMPILE_TARGETS = {"bun-darwin-arm64", "bun-darwin-x64",
                          "bun-linux-arm64", "bun-linux-x64"}


def capture(filename, owned):
    pinned, _, _ = owned.file(owned.presentation(filename))
    return owned.read(pinned)


def original_input(value, module, namespace, owned):
    if not isinstance(value, dict) or set(value) != {'input', 'label', 'tree'} or type(value['tree']) is not bool:
        raise ValueError('Exact original configured compiler/generator File required')
    descriptor = module.deployment.descriptor({name: value[name] for name in ('input', 'label')})
    if value['tree']:
        entries = module.deployment.declared_tree(descriptor, 'input', namespace, owned)
        return [{'input': value['input'] + '/' + member[len('input/'):], 'label': value['label'],
                 'size': size, 'sha256': module.npm.sha256(owned.read(pinned))}
                for member, (_, pinned, size) in sorted(entries.items())]
    pinned, size, sha = owned.file(owned.presentation(value['input']))
    return [{'input': value['input'], 'label': value['label'], 'size': size, 'sha256': sha}]


def compiler_origin(value, module, namespace, owned):
    fields = {'root', 'units', 'artifact', 'inputs', 'generator_inputs',
              'generator_configurations', 'generator_sources', 'crate_manifest'}
    if not isinstance(value, dict) or set(value) != fields or not isinstance(value['units'], list):
        raise ValueError('Original configured Rust/WASM producer chain required')
    units = [module.pack.load_json(record) for record in value['units']]
    records = {}
    for record in units:
        if not isinstance(record, dict) or not isinstance(record.get('unit'), str) or record['unit'] in records:
            raise ValueError('Original configured Rust compiler graph is ambiguous')
        records[record['unit']] = record
    if value['root'] not in records or records[value['root']].get('crate_type') != 'cdylib' or records[value['root']].get('compiler', {}).get('target') != 'wasm32-unknown-unknown':
        raise ValueError('Original Rust root is not the actual configured WASM cdylib')
    visited = set()
    def visit(identity, ancestors):
        if identity not in records or identity in ancestors:
            raise ValueError('Original Rust compiler graph has missing or cyclic dependencies')
        dependencies = records[identity].get('dependencies')
        if not isinstance(dependencies, list) or any(not isinstance(child, str) for child in dependencies) or len(set(dependencies)) != len(dependencies):
            raise ValueError('Original Rust compiler dependency edges are invalid')
        if identity in visited:
            return
        visited.add(identity)
        for child in dependencies:
            visit(child, ancestors | {identity})
    visit(value['root'], set())
    if visited != set(records):
        raise ValueError('Original Rust graph contains units outside its configured dependency closure')
    artifact = original_input(value['artifact'], module, namespace, owned)
    if value['artifact']['tree'] or capture(value['artifact']['input'], owned)[:8] != b'\0asm\x01\0\0\0':
        raise ValueError('Original Rust WASM producer output is not a compiled WASM File')
    inputs = value['inputs']
    if not isinstance(inputs, list) or not inputs:
        raise ValueError('Original configured Rust input closure is empty')
    indexed = {(item['input'], item['label'], item['tree']) for item in inputs}
    if len(indexed) != len(inputs):
        raise ValueError('Original configured Rust input closure is duplicated')
    for record in records.values():
        if not isinstance(record.get('inputs'), list):
            raise ValueError('Original Rust unit has no configured input closure')
        for item in record['inputs']:
            if (item['input'], item['label'], item['tree']) not in indexed:
                raise ValueError('Original Rust unit input is outside its configured File closure')
    source_files = [fact for item in inputs for fact in original_input(item, module, namespace, owned)]
    manifest = original_input(value['crate_manifest'], module, namespace, owned)
    generator_files = [fact for item in value['generator_inputs'] for fact in original_input(item, module, namespace, owned)]
    generator_sources = value['generator_sources']
    if not isinstance(generator_sources, list) or any(not isinstance(item, dict) or item.get('tree') is not False for item in generator_sources):
        raise ValueError('Original generator authored SourceFiles are required')
    authored = [fact for item in generator_sources for fact in original_input(item, module, namespace, owned)]
    if any(fact not in generator_files for fact in authored):
        raise ValueError('Generator authored SourceFile is outside its original action input closure')
    stages = []
    for descriptor in value['generator_configurations']:
        original_input(descriptor, module, namespace, owned)
        stage = module.pack.load_json(capture(descriptor['input'], owned))
        if not isinstance(stage, dict) or set(stage) != {'producer', 'stage', 'inputs', 'tools', 'executable', 'arguments', 'output'}:
            raise ValueError('Original WASM generation action configuration is incomplete')
        module.npm.label(stage['producer'])
        module.deployment.descriptor(stage['output'])
        if not isinstance(stage['inputs'], list) or not stage['inputs'] or not isinstance(stage['tools'], list) or not stage['tools']:
            raise ValueError('Original WASM generation tool/input closure is empty')
        if not isinstance(stage['arguments'], list) or any(not isinstance(argument, str) for argument in stage['arguments']):
            raise ValueError('Original WASM generation action arguments are invalid')
        available = {(fact['input'], fact['label']) for fact in generator_files}
        for item in stage['inputs'] + stage['tools']:
            facts = original_input(item, module, namespace, owned)
            if any((fact['input'], fact['label']) not in available for fact in facts):
                raise ValueError('WASM action input is outside its original generator File closure')
        executable = stage['executable']
        if executable not in stage['tools'] or executable.get('tree') is not False:
            raise ValueError('WASM generation executable is not its exact original declared tool File')
        stages.append(stage)
    if sorted(stage['stage'] for stage in stages) != ['bindings', 'optimizer', 'package']:
        raise ValueError('Original WASM bindings/optimizer/package action chain is incomplete')
    stages = {stage['stage']: stage for stage in stages}
    binding, optimizer, package = [stages[name] for name in ('bindings', 'optimizer', 'package')]
    def contains(stage, descriptor):
        return any({name: item[name] for name in ('input', 'label')} == descriptor for item in stage['inputs'])
    if (not contains(binding, {name: value['artifact'][name] for name in ('input', 'label')})
            or not contains(optimizer, binding['output']) or not contains(package, optimizer['output'])
            or not contains(package, {name: value['crate_manifest'][name] for name in ('input', 'label')})):
        raise ValueError('Original WASM generator chain is disconnected from its compiler or manifest')
    return {'root': value['root'], 'units': [records[key] for key in sorted(records)],
            'artifact': artifact[0], 'compiler_inputs': source_files,
            'crate_manifest': manifest[0], 'generator_inputs': generator_files,
            'generator_sources': authored,
            'generator_configurations': [stages[name] for name in ('bindings', 'optimizer', 'package')]}


def rust_source_packages(specification, origins, module, namespace, owned):
    packages = specification['rust_packages']
    if not isinstance(packages, dict) or not packages:
        raise ValueError('Original typed Rust source/license packages required')
    metadata = load(Path(module.__file__).with_name('rust-license-metadata.py'))
    workspace = specification['workspace_manifest']
    license_file = specification['workspace_license']
    if module.npm.label(workspace['label']) != '//:Cargo.toml' or module.npm.label(license_file['label']) != '//:LICENSE':
        raise ValueError('Original Rust workspace manifest/license ownership required')
    original_input(workspace, module, namespace, owned)
    workspace_bytes = capture(workspace['input'], owned)
    original_input(license_file, module, namespace, owned)
    workspace_license = capture(license_file['input'], owned)
    if owned.presentation(license_file['input']).parent != owned.presentation(workspace['input']).parent:
        raise ValueError('Rust workspace license belongs to another original source workspace')
    workspace_root = owned.presentation(workspace['input']).parent
    package_manifest = specification['workspace_package']
    if module.npm.label(package_manifest['label']) != '//:package.json' or package_manifest['tree']:
        raise ValueError('Original authored Rust workspace package manifest required')
    original_input(package_manifest, module, namespace, owned)
    if owned.presentation(package_manifest['input']).parent != workspace_root:
        raise ValueError('Rust root package manifest belongs to another original workspace')
    workspace_metadata = module.pack.load_json(capture(package_manifest['input'], owned))
    admitted = {}
    for identity, package in packages.items():
        if not isinstance(package, dict) or set(package) != {'root', 'manifest', 'files', 'authored'} or not isinstance(package['files'], list) or type(package['authored']) is not bool:
            raise ValueError('Invalid original typed Rust source package')
        manifest = owned.presentation(package['manifest']['input'])
        root = manifest.parent
        if package['authored'] and (not module.npm.label(package['manifest']['label']).startswith('//')
                                    or not manifest.is_relative_to(workspace_root)):
            raise ValueError('Authored Rust manifest is outside its exact original workspace SourceFiles')
        original_input(package['manifest'], module, namespace, owned)
        entries = module.deployment.declared_tree({key: package['root'][key] for key in ('input', 'label')}, 'source', namespace, owned)
        sources = {}
        for item in package['files']:
            if item['tree']:
                raise ValueError('Original Cargo package sources must be individual regular Files')
            physical = owned.presentation(item['input'])
            if not physical.is_relative_to(root):
                raise ValueError('Rust original source File belongs to another package')
            member = physical.relative_to(root).as_posix()
            entry = entries.get('source/' + member)
            if entry is None or physical in sources:
                raise ValueError('Rust source package has missing or duplicate original File custody')
            facts = original_input(item, module, namespace, owned)
            if capture(item['input'], owned) != owned.read(entry[1]):
                raise ValueError('Rust source tree differs from original package File bytes')
            sources[physical] = facts[0]
        if len(sources) != len(entries) or manifest not in sources:
            raise ValueError('Rust source package does not declare its complete original File tree')
        effective, inherited = metadata.effective(capture(package['manifest']['input'], owned), workspace_bytes)
        if 'license' in inherited and not package['authored']:
            raise ValueError('External Cargo manifest cannot inherit authored workspace license')
        repository_license = (package['authored'] and effective['license'] == workspace_metadata.get('license')
                              and effective['license'] is not None)
        texts = module.closure.inputs.collect(root, effective['license_file'])
        if repository_license:
            texts = [text for text in texts if root / text['path'] != owned.presentation(license_file['input'])]
        for text in texts:
            physical = root / text['path']
            if physical not in sources:
                raise ValueError('Rust license text is outside its original declared source Files')
            if capture(physical, owned).decode('utf8') != text['text']:
                raise ValueError('Rust license text differs from its original declared File bytes')
        if 'license' in inherited or repository_license:
            text = workspace_license.decode('utf8')
            if not text.strip():
                raise ValueError('Original Rust workspace license text is empty')
            texts.append({'path': 'LICENSE', 'label': license_file['label'],
                          'sha256': module.npm.sha256(workspace_license), 'text': text})
        if not texts:
            raise ValueError('Original selected Cargo package has no published license text')
        admitted[identity] = {'metadata': effective, 'files': sources, 'texts': texts}
    selected = set()
    for origin in origins.values():
        for unit in origin['units']:
            if isinstance(unit.get('root'), str):
                root = owned.presentation(unit['root'])
                matches = [identity for identity, package in admitted.items() if root in package['files']]
            else:
                manifests = {owned.presentation(item['input']) for item in unit['inputs'] if not item['tree']}
                matches = [identity for identity, package in admitted.items()
                           if owned.presentation(packages[identity]['manifest']['input']) in manifests]
            if len(matches) != 1:
                raise ValueError('Configured Rust unit has no exact original source/license package')
            selected.add(matches[0])
    return [{'identity': identity, 'metadata': admitted[identity]['metadata'],
             'files': sorted(admitted[identity]['files'].values(), key=lambda item: item['input']),
             'texts': admitted[identity]['texts']} for identity in sorted(selected)]


def original_generator_license_files(producer, components, metadata, inputs):
    """Require published package texts to be actual original PackageSourceInfo Files."""
    result = []
    for component in components:
        package = producer['packages'].get(component['id'])
        if package is None:
            # The mandatory stdlib collector owns publisher distribution notices.
            continue
        original_root = Path(package['manifest']).resolve(strict=True).parent
        originals = {Path(value['input']).resolve(strict=True): value for value in package['files']}
        for text in component['texts']:
            if text.get('label') == '//:LICENSE':
                descriptor = {'input': producer['workspace_license'], 'label': '//:LICENSE'}
            else:
                physical = original_root / inputs.relative(text['path'])
                if physical not in originals:
                    raise ValueError('Generator notice lacks its original declared package license File')
                descriptor = originals[physical]
                if 'label' in text and text['label'] != descriptor['label']:
                    raise ValueError('Generator notice belongs to another original license File')
            fact = metadata.file_fact(descriptor, inputs)
            raw = metadata.declared_bytes(descriptor['input'], inputs)
            if raw != text['text'].encode('utf8') or fact['size'] != text['size'] or fact['sha256'] != text['sha256']:
                raise ValueError('Generator notice differs from original declared license bytes')
            result.append(fact)
    if not result:
        raise ValueError('Compiled generator lacks original package license Files')
    return sorted(result, key=lambda value: (value['path'], value['label']))


def generator_licenses(tool_files, producers, metadata, units, notices, closure, stdlib):
    """Aggregate original compiled generator closures for exact selected action Files.

    Producers are the existing collect_compiled inputs, not license-name claims.
    The caller supplies the declared standard-library collector; its absence or an
    incomplete generator producer must remain an unresolved WASM obligation.
    """
    if not isinstance(tool_files, list) or not tool_files or not isinstance(producers, list) or not producers:
        raise ValueError('Original WASM generator source/license producers are required')
    selected = {}
    for fact in tool_files:
        if not isinstance(fact, dict) or set(fact) != {'input', 'label', 'size', 'sha256'}:
            raise ValueError('Original generator File byte custody is required')
        if not closure.label(fact['label']) or type(fact['size']) is not int or fact['size'] <= 0:
            raise ValueError('Original generator File identity is invalid')
        actual = metadata.file_fact({'input': fact['input'], 'label': fact['label']}, notices.license_inputs)
        if actual['size'] != fact['size'] or actual['sha256'] != fact['sha256']:
            raise ValueError('Original WASM generator File changed after action capture')
        key = (fact['input'], fact['label'])
        if key in selected and selected[key] != fact:
            raise ValueError('Conflicting original generator File custody')
        selected[key] = fact
    indexed = {}
    for producer in producers:
        if not isinstance(producer, dict) or not isinstance(producer.get('artifact'), dict):
            raise ValueError('Original compiled generator producer is incomplete')
        artifact = producer['artifact']
        if set(artifact) != {'input', 'label'}:
            raise ValueError('Original compiled generator artifact File is required')
        key = (artifact['input'], artifact['label'])
        if key in indexed:
            raise ValueError('Duplicate original compiled generator producer')
        indexed[key] = producer
    if set(selected) != set(indexed):
        raise ValueError('Original generator source/license closure does not cover selected action Files')
    if not callable(stdlib):
        raise ValueError('Original linked standard-library license collector is required')
    origins, components = [], {}
    for key in sorted(selected):
        configuration, source, inventory, rendered = metadata.collect_compiled(
            indexed[key], units, notices, closure, stdlib)
        result = json.loads(inventory)
        expected = selected[key]
        artifact = result.get('artifacts')
        if (result.get('kind') != 'selected-native-rust-attribution'
                or result.get('pending_scopes') != [] or not isinstance(artifact, list)
                or len(artifact) != 1 or artifact[0]['label'] != expected['label']
                or artifact[0]['size'] != expected['size'] or artifact[0]['sha256'] != expected['sha256']
                or rendered != closure.render(result)):
            raise ValueError('Compiled generator attribution differs from its original action File')
        origins.append({'artifact': expected, 'configuration': hashlib.sha256(configuration).hexdigest(),
                        'source_digest': hashlib.sha256(source).hexdigest(),
                        'sources': json.loads(source),
                        'license_files': original_generator_license_files(
                            indexed[key], result['components'], metadata, notices.license_inputs)})
        if not result.get('components'):
            raise ValueError('Original compiled generator license component closure is empty')
        for component in result['components']:
            identity = component['id']
            if identity in components and closure.canonical(components[identity]) != closure.canonical(component):
                raise ValueError('Conflicting original generator source/license component')
            components[identity] = component
    return {'origins': origins, 'components': [components[key] for key in sorted(components)]}


def selected_generator_licenses(providers, origins, module, namespace, owned):
    """Join existing complete attribution actions to the original executed Files.

    Resource Files remain in the original action closure. They are not guessed to
    be executable producers from their names, extensions, or position in a list.
    """
    selected, available = {}, {}
    for origin in origins.values():
        for fact in origin['generator_inputs']:
            key = (fact['input'], module.npm.label(fact['label']))
            if key in available and available[key] != fact:
                raise ValueError('Conflicting original generator action File facts')
            available[key] = fact
        for stage in origin['generator_configurations']:
            executed = [stage['executable']]
            if stage['stage'] == 'optimizer':
                if len(stage['arguments']) < 8:
                    raise ValueError('Original optimizer invocation is incomplete')
                tools = [item for item in stage['tools']
                         if item['input'] == stage['arguments'][7] and not item['tree']]
                if len(tools) != 1:
                    raise ValueError('Invoked optimizer has no exact original declared executable File')
                executed += tools
            for descriptor in executed:
                owned.file(owned.presentation(descriptor['input']), executable=True)
                for fact in original_input(descriptor, module, namespace, owned):
                    key = (fact['input'], module.npm.label(fact['label']))
                    if key not in available or available[key] != fact:
                        raise ValueError('Executed generator differs from its captured original action File')
                    selected[key] = fact
    if not selected or not isinstance(providers, list) or not providers:
        raise ValueError('Every executed WASM generator requires original complete source/license attribution')
    covered, result, components = set(), [], {}
    fields = {'scope', 'producer', 'artifacts', 'configuration', 'source_inventory', 'inventory', 'notices'}
    kinds = {'rust': 'selected-native-rust-attribution',
             'embedded-runtime': 'selected-embedded-runtime-attribution',
             'first-party': 'selected-first-party-attribution'}
    for provider in providers:
        if not isinstance(provider, dict) or set(provider) != fields or provider['scope'] not in kinds:
            raise ValueError('Original typed generator attribution provider is incomplete')
        producer = module.npm.label(provider['producer'])
        descriptors = provider['artifacts']
        if not isinstance(descriptors, list) or not descriptors:
            raise ValueError('Generator attribution has no original compiled artifacts')
        facts = []
        for descriptor in descriptors:
            module.deployment.descriptor(descriptor)
            fact = original_input({**descriptor, 'tree': False}, module, namespace, owned)[0]
            key = (fact['input'], module.npm.label(fact['label']))
            if key not in available or available[key] != fact or any(
                    item['input'] == fact['input'] and item['label'] == fact['label'] for item in facts):
                raise ValueError('Generator attribution contains a foreign or duplicate action artifact')
            facts.append(fact)
        keys = {(fact['input'], module.npm.label(fact['label'])) for fact in facts} & set(selected)
        if not keys or keys & covered:
            raise ValueError('Generator attribution is unused or repeats an original executed artifact')
        captures = {}
        for name in ('configuration', 'source_inventory', 'inventory', 'notices'):
            descriptor = module.deployment.descriptor(provider[name])
            captures[name] = capture(descriptor['input'], owned)
        owners = {module.npm.label(provider[name]['label']) for name in captures}
        if len(owners) != 1:
            raise ValueError('Generator attribution output Files belong to different original actions')
        inventory = module.pack.load_json(captures['inventory'])
        if (inventory.get('kind') != kinds[provider['scope']]
                or module.npm.label(inventory.get('producer')) != producer
                or inventory.get('pending_scopes') != []
                or inventory.get('configuration') != module.npm.sha256(captures['configuration'])
                or inventory.get('source_digest') != module.npm.sha256(captures['source_inventory'])):
            raise ValueError('Generator attribution is pending or belongs to another original compilation')
        artifacts = inventory.get('artifacts')
        if not isinstance(artifacts, list) or len(artifacts) != len(facts):
            raise ValueError('Generator inventory omits its original compiled artifact File')
        for fact in facts:
            matches = [item for item in artifacts if isinstance(item, dict)
                       and module.npm.label(item.get('label')) == module.npm.label(fact['label'])
                       and item.get('size') == fact['size'] and item.get('sha256') == fact['sha256']]
            if len(matches) != 1:
                raise ValueError('Generator notices differ from exact original executed artifact bytes')
        selected_components = inventory.get('components')
        if not isinstance(selected_components, list) or not selected_components:
            raise ValueError('Generator original source/license component closure is empty')
        # Reuse the existing selected notice component validator. The Rust
        # publisher callback preserves raw HTML notices without a stored size;
        # the size here is a byte fact derived from that exact retained text.
        normalized = []
        for component in selected_components:
            if not isinstance(component, dict) or not isinstance(component.get('texts'), list):
                raise ValueError('Original generator published notice component is invalid')
            texts = []
            for text in component['texts']:
                if not isinstance(text, dict) or not isinstance(text.get('text'), str):
                    raise ValueError('Original generator published notice text is invalid')
                texts.append({'size': len(text['text'].encode('utf8')), **text})
            normalized.append({**component, 'texts': texts})
        notice_components = load(Path(module.__file__).with_name('deployment-notices.py'))
        notice_components.components({'components': normalized})
        for component in selected_components:
            identity = component['id']
            if identity in components and module.pack.canonical(components[identity]) != module.pack.canonical(component):
                raise ValueError('Conflicting original generator source/license component')
            components[identity] = component
        if captures['notices'] != module.closure.render(inventory):
            raise ValueError('Generator notices differ from original complete selected attribution')
        covered.update(keys)
        result.append({'producer': producer, 'scope': provider['scope'], 'artifacts': facts,
                       'configuration': inventory['configuration'], 'source_digest': inventory['source_digest'],
                       'source_inventory': module.pack.load_json(captures['source_inventory'])})
    if covered != set(selected):
        raise ValueError('Original generator source/license attribution omits an executed tool')
    return {'origins': result, 'components': [components[key] for key in sorted(components)]}


def publisher_file(value, originals):
    fields = {'path', 'label', 'size', 'sha256'}
    if not isinstance(value, dict) or not fields.issubset(value) or type(value['size']) is not int:
        raise ValueError('Original compiled publisher File custody required')
    actual = originals.get((value['path'], value['label']))
    if actual is None or any(value[key] != actual[key] for key in ('label', 'size', 'sha256')):
        raise ValueError('Compiled publisher fact differs from original action input File bytes')
    return actual


def selected_module_linkage(source, origin, originals, module, owned):
    linkage = source.get('module_linkage')
    raw = origin['artifact']
    if (not isinstance(linkage, dict) or linkage.get('kind') != 'linked-stdlib-source-attribution'
            or linkage.get('target') != 'wasm32-unknown-unknown'
            or linkage.get('compiler') != '1.97.1' or linkage.get('pending_scopes') != []
            or linkage.get('artifact') != {'path': raw['input'], 'label': raw['label'],
                                         'size': raw['size'], 'sha256': raw['sha256']}):
        raise ValueError('WASM Rust attribution lacks actual matching module linkage')
    for name in ('rustc', 'link_map', 'source_archive', 'stdlib_archive', 'rustc_archive', 'graph'):
        publisher_file(linkage.get(name), originals)
    selected = linkage.get('selected_stdlib')
    if not isinstance(selected, list) or not selected:
        raise ValueError('WASM Rust attribution omits actual selected linked stdlib Files')
    declared = {(row['input'], row['label']) for unit in origin['units']
                if unit['compiler']['target'] == 'wasm32-unknown-unknown'
                for row in unit.get('stdlib', [])}
    admitted = set()
    for row in selected:
        fact = publisher_file(row, originals)
        key = (fact['input'], fact['label'])
        if key not in declared or key in admitted or not isinstance(row.get('members'), dict) or not row['members']:
            raise ValueError('WASM linkage selected stdlib differs from actual configured compiler Files')
        admitted.add(key)
    standard = source.get('standard_library')
    if not isinstance(standard, list) or not standard:
        raise ValueError('WASM Rust attribution omits selected linked standard-library source/license closure')
    for row in standard:
        publisher_file(row, originals)
    host = source.get('host_proc_macros')
    if not isinstance(host, list):
        raise ValueError('WASM Rust attribution omits actual host proc-macro linkage closure')
    units = {unit['unit']: unit for unit in origin['units']}
    expected = {unit['unit'] for unit in origin['units'] if unit.get('crate_type') == 'proc-macro'}
    matched, host_components = set(), []
    for row in host:
        if not isinstance(row, dict) or set(row) != {'artifact', 'configuration', 'source_inventory', 'inventory', 'notices'}:
            raise ValueError('Exact original host proc-macro attribution Files required')
        artifact = publisher_file(row['artifact'], originals)
        for name in ('inventory', 'notices'):
            publisher_file(row[name], originals)
        context, sources = row['configuration'], row['source_inventory']
        inventory = module.pack.load_json(capture(row['inventory']['path'], owned))
        identity = context.get('root')
        if identity not in expected or identity in matched:
            raise ValueError('Host proc-macro attribution differs from actual configured units')
        if (context.get('kind') != 'configured-native-rust-release'
                or inventory.get('kind') != 'selected-native-rust-attribution'
                or context.get('target') != units[identity]['compiler']['target']
                or context.get('producer') != artifact['label']
                or context.get('profile') != 'release'
                or inventory.get('pending_scopes') != []
                or inventory.get('producer') != artifact['label']
                or inventory.get('configuration') != module.npm.sha256(module.pack.canonical(context))
                or inventory.get('source_digest') != module.npm.sha256(module.pack.canonical(sources))):
            raise ValueError('Host proc-macro attribution is pending or differs from original compilation')
        wanted, active = set(), [identity]
        while active:
            current = active.pop()
            if current not in wanted:
                wanted.add(current)
                active.extend(units[current]['dependencies'])
        if module.pack.canonical(context.get('units')) != module.pack.canonical([units[key] for key in sorted(wanted)]):
            raise ValueError('Host proc-macro attribution differs from actual original compiler graph')
        records = inventory.get('artifacts')
        if not isinstance(records, list) or len(records) != 1 or any(records[0].get(key) != row['artifact'][key]
                                                                  for key in ('label', 'size', 'sha256')):
            raise ValueError('Host proc-macro attribution differs from actual module bytes')
        host_linkage = sources.get('module_linkage')
        if (not isinstance(host_linkage, dict)
                or host_linkage.get('kind') != 'linked-stdlib-source-attribution'
                or host_linkage.get('compiler') != '1.97.1'
                or host_linkage.get('pending_scopes') != []
                or host_linkage.get('artifact') != row['artifact']
                or host_linkage.get('target') != context['target']):
            raise ValueError('Host proc-macro linked runtime is incomplete')
        for name in ('rustc', 'link_map', 'source_archive', 'stdlib_archive', 'rustc_archive', 'graph'):
            publisher_file(host_linkage.get(name), originals)
        host_declared = {(value['input'], value['label']) for key in wanted
                         if units[key]['compiler']['target'] == context['target']
                         for value in units[key].get('stdlib', [])}
        selected_host = host_linkage.get('selected_stdlib')
        if not isinstance(selected_host, list) or not selected_host:
            raise ValueError('Host proc-macro selected linked stdlib is incomplete')
        host_admitted = set()
        for value in selected_host:
            fact = publisher_file(value, originals)
            key = (fact['input'], fact['label'])
            if key not in host_declared or key in host_admitted or not value.get('members'):
                raise ValueError('Host proc-macro stdlib differs from configured compiler Files')
            host_admitted.add(key)
        if not isinstance(sources.get('standard_library'), list) or not sources['standard_library']:
            raise ValueError('Host proc-macro original stdlib source/license Files are missing')
        for fact in sources['standard_library']:
            publisher_file(fact, originals)
        if capture(row['notices']['path'], owned) != module.closure.render(inventory):
            raise ValueError('Host proc-macro notices differ from original selected attribution')
        components = inventory.get('components')
        if not isinstance(components, list) or not components:
            raise ValueError('Host proc-macro original source/license component closure is empty')
        notice_components = load(Path(module.__file__).with_name('deployment-notices.py'))
        normalized = [{**component, 'texts': [{'size': len(text['text'].encode('utf8')), **text}
                                            for text in component['texts']]}
                      for component in components]
        notice_components.components({'components': normalized})
        host_components.extend(components)
        matched.add(identity)
    if matched != expected:
        raise ValueError('WASM Rust attribution omits an actual executed host proc-macro')
    return host_components


def selected_rust_licenses(providers, publisher_inputs, origins, source_packages, module, namespace, owned):
    """Bind complete executed WASM Rust publishers to the selected raw outputs."""
    if not isinstance(providers, dict) or not providers or not set(origins).issubset(providers):
        raise ValueError('Every selected WASM package requires original compiled Rust attribution')
    if not isinstance(publisher_inputs, dict) or set(publisher_inputs) != set(providers):
        raise ValueError('Every compiled WASM publisher requires its original action input Files')
    fields = {'scope', 'producer', 'artifacts', 'configuration', 'source_inventory', 'inventory', 'notices'}
    results, components = [], {}
    for package in sorted(origins):
        origin, provider = origins[package], providers[package]
        originals = {}
        if not isinstance(publisher_inputs[package], list) or not publisher_inputs[package]:
            raise ValueError('Original WASM publisher action input File closure is empty')
        for descriptor in publisher_inputs[package]:
            for fact in original_input(descriptor, module, namespace, owned):
                originals[(fact['input'], fact['label'])] = fact
        if not isinstance(provider, dict) or set(provider) != fields or provider['scope'] != 'rust':
            raise ValueError('Original typed WASM Rust attribution provider is incomplete')
        raw = origin['artifact']
        expected = {'input': raw['input'], 'label': raw['label']}
        if provider['artifacts'] != [expected] or module.npm.label(provider['producer']) != module.npm.label(raw['label']):
            raise ValueError('WASM Rust attribution differs from exact original compiled File')
        captures = {}
        for name in ('configuration', 'source_inventory', 'inventory', 'notices'):
            descriptor = module.deployment.descriptor(provider[name])
            captures[name] = capture(descriptor['input'], owned)
        if len({module.npm.label(provider[name]['label']) for name in captures}) != 1:
            raise ValueError('WASM Rust attribution output Files belong to different original actions')
        inventory = module.pack.load_json(captures['inventory'])
        configuration = module.pack.load_json(captures['configuration'])
        source = module.pack.load_json(captures['source_inventory'])
        if (inventory.get('kind') != 'selected-wasm-rust-attribution'
                or inventory.get('producer') != provider['producer']
                or inventory.get('pending_scopes') != []
                or inventory.get('target') != 'wasm32-unknown-unknown'
                or inventory.get('profile') != 'release'
                or inventory.get('configuration') != module.npm.sha256(captures['configuration'])
                or inventory.get('source_digest') != module.npm.sha256(captures['source_inventory'])):
            raise ValueError('WASM Rust attribution is pending or belongs to another original compilation')
        if (configuration.get('kind') != 'configured-wasm-rust-release'
                or configuration.get('producer') != provider['producer']
                or configuration.get('target') != 'wasm32-unknown-unknown'
                or configuration.get('profile') != 'release'
                or configuration.get('root') != origin['root']
                or module.pack.canonical(configuration.get('units')) != module.pack.canonical(origin['units'])):
            raise ValueError('WASM Rust attribution differs from the original configured compiler graph')
        artifacts = inventory.get('artifacts')
        if (not isinstance(artifacts, list) or len(artifacts) != 1
                or artifacts[0].get('path') != Path(raw['input']).name
                or artifacts[0].get('label') != raw['label']
                or artifacts[0].get('size') != raw['size']
                or artifacts[0].get('sha256') != raw['sha256']):
            raise ValueError('WASM Rust notices differ from exact original compiled output bytes')
        compiler_inputs = source.get('compiler_inputs')
        if not isinstance(compiler_inputs, list):
            raise ValueError('WASM Rust attribution omits original configured compiler inputs')
        admitted = {}
        for unit in origin['units']:
            for descriptor in unit['inputs']:
                for fact in original_input(descriptor, module, namespace, owned):
                    admitted[(fact['input'], fact['label'])] = {'path': fact['input'],
                        'label': fact['label'], 'size': fact['size'], 'sha256': fact['sha256']}
        actual_inputs = list(admitted.values())
        if (module.pack.canonical(sorted(compiler_inputs, key=lambda fact: (fact['path'], fact['label'])))
                != module.pack.canonical(sorted(actual_inputs, key=lambda fact: (fact['path'], fact['label'])))):
            raise ValueError('WASM Rust attribution has foreign or changed compiler source Files')
        host_components = selected_module_linkage(source, origin, originals, module, owned)
        selected_components = inventory.get('components')
        if not isinstance(selected_components, list) or not selected_components:
            raise ValueError('WASM Rust original source/license component closure is empty')
        notice_components = load(Path(module.__file__).with_name('deployment-notices.py'))
        normalized = [{**component, 'texts': [{'size': len(text['text'].encode('utf8')), **text}
                                            for text in component['texts']]}
                      for component in selected_components]
        notice_components.components({'components': normalized})
        selected_roots = {unit.get('root') for unit in origin['units'] if isinstance(unit.get('root'), str)}
        for package_source in source_packages:
            if not any(fact['input'] in selected_roots for fact in package_source['files']):
                continue
            matches = [component for component in selected_components
                       if component.get('id') == package_source['identity']]
            if len(matches) != 1 or any(matches[0].get(field) != package_source['metadata'][field]
                                       for field in ('name', 'version', 'license', 'license_file', 'repository')):
                raise ValueError('WASM Rust notices omit an original configured source package')
            for text in package_source['texts']:
                if not any(candidate.get('path') == text['path']
                           and candidate.get('sha256') == text['sha256']
                           and candidate.get('text') == text['text']
                           for candidate in matches[0]['texts']):
                    raise ValueError('WASM Rust notice differs from original selected package license File')
        if captures['notices'] != module.closure.render(inventory):
            raise ValueError('WASM Rust notices differ from original complete selected attribution')
        for component in selected_components + host_components:
            identity = component['id']
            if identity in components and module.pack.canonical(components[identity]) != module.pack.canonical(component):
                raise ValueError('Conflicting original WASM Rust source/license component')
            components[identity] = component
        results.append({'package': package, 'producer': provider['producer'], 'artifact': raw,
                        'configuration': inventory['configuration'], 'source_digest': inventory['source_digest'],
                        'source_inventory': source})
    return {'origins': results, 'components': [components[key] for key in sorted(components)]}


def validated_compiler_artifacts(specification, compiler, module, namespace, owned, frontend):
    checker = specification['frontend_checker']
    if not isinstance(checker, dict) or set(checker) != {'bun', 'runner', 'config', 'modules'}:
        raise ValueError('Frontend WASM attribution requires its declared Bun validator')
    expected_modules = {'//tools/bazel/bun:' + name for name in
                        ('npm-attribution.ts', 'compiler-inventory.ts', 'owned-files.ts', 'portable-path.ts')}
    if (not isinstance(checker['modules'], list) or len(checker['modules']) != len(expected_modules)
            or {module.npm.label(value.get('label')) for value in checker['modules']
                if isinstance(value, dict)} != expected_modules
            or module.npm.label(checker['runner'].get('label')) != '//tools/bazel/wasm:frontend-check.ts'
            or module.npm.label(checker['config'].get('label')) != '//tools/bazel/bun:empty-bunfig.toml'):
        raise ValueError('Frontend validator requires its exact original helper/imported SourceFiles')
    for value in [checker[name] for name in ('bun', 'runner', 'config')] + checker['modules']:
        original_input(value, module, namespace, owned)
        if value['tree']:
            raise ValueError('Frontend validator requires original ordinary executable/source Files')
    bun = owned.presentation(checker['bun']['input'])
    owned.file(bun, executable=True)
    artifact = module.deployment.descriptor(specification['artifact'])
    if frontend:
        if module.npm.label(artifact['label']) != '//apps/web:frontend_precompressed':
            raise ValueError('Frontend WASM attribution belongs to another actual artifact Tree')
        entries = module.deployment.declared_tree(artifact, 'web', namespace, owned)
        facts = [{'path': name, 'label': item['label'], 'mode': item['mode'], 'size': size,
                  'sha256': module.npm.sha256(owned.read(pinned))}
                 for name, (item, pinned, size) in sorted(entries.items())]
    else:
        facts = module.npm.artifact_facts(specification, compiler, owned)
    with tempfile.TemporaryDirectory() as temporary:
        environment = {'PATH': '', 'HOME': temporary, 'TMPDIR': temporary,
                       'BUN_RUNTIME_TRANSPILER_CACHE_PATH': temporary,
                       'BUN_INSTALL_CACHE_DIR': temporary}
        command = [str(bun), '--no-install', '--no-env-file',
                   '--config=' + str(owned.presentation(checker['config']['input'])),
                   str(owned.presentation(checker['runner']['input'])),
                   str(owned.presentation(specification['configuration'])),
                   str(owned.presentation(specification['compiler_inventory'])),
                   str(owned.presentation(artifact['input']))]
        result = subprocess.run(command, env=environment, capture_output=True)
    owned.verify()
    if result.returncode != 0:
        role = 'frontend' if frontend else 'native compiler'
        raise ValueError('Original ' + role + ' attribution validator refused: ' + result.stderr.decode('utf8', errors='replace'))
    return facts


def zero_application_wasm(specification, compiler, declarations, sources, module, namespace, owned, captures, frontend):
    empty = {'compiler_origins': {}, 'rust_packages': {}, 'rust_attributions': {},
             'rust_attribution_inputs': {}, 'generator_attributions': []}
    if any(specification[name] != value for name, value in empty.items()):
        raise ValueError('Zero application WASM requires exact empty typed producer mappings')
    artifacts = validated_compiler_artifacts(specification, compiler, module, namespace, owned, frontend)
    selection = {name: compiler[name] for name in ('inputs', 'outputs', 'artifacts')} if frontend else compiler
    selected_npm, originals = module.npm.select(selection, declarations, sources)
    source_inputs = specification['zero_source_inputs']
    if not isinstance(source_inputs, list):
        raise ValueError('Zero WASM needs original configured compiler SourceFile properties')
    authored = {}
    for value in source_inputs:
        if (not isinstance(value, dict) or set(value) != {'input', 'label', 'tree', 'authored'}
                or value['tree'] is not False or type(value['authored']) is not bool):
            raise ValueError('Zero WASM needs exact original compiler SourceFile properties')
        if value['authored']:
            if not module.npm.label(value['label']).startswith('//'):
                raise ValueError('Zero WASM authored SourceFile belongs to another workspace')
            descriptor = {key: value[key] for key in ('input', 'label', 'tree')}
            original_input(descriptor, module, namespace, owned)
            key = (owned.presentation(value['input']), module.npm.label(value['label']))
            if key in authored:
                raise ValueError('Zero WASM original authored SourceFile identity is duplicated')
            authored[key] = value
    npm_roots = [module.npm.package_origin(source['input']) for source in selected_npm
                 if source['workspace'] is False]
    imports = []
    for (logical, fact), (physical, original) in zip(compiler['inputs'].items(), originals, strict=True):
        pinned, _, _ = owned.file(physical)
        data = owned.read(pinned)
        if ((physical, module.npm.label(fact['owner'])) not in authored
                and not any(physical.is_relative_to(root) for root in npm_roots)):
            raise ValueError('Zero WASM selected a derived non-npm source without actual generator custody')
        if data != original:
            raise ValueError('Zero WASM compiler selected source changed during validation')
        # The actual compiler's sole declared file-loader handles WASM. Raw magic
        # independently rejects a binary hidden behind a different filename.
        if (fact.get('loader') == 'file' or data.startswith(b'\0asm')
                or Path(logical.split('?', 1)[0].split('#', 1)[0]).suffix == '.wasm'):
            raise ValueError('Zero application WASM contradicts an actual selected WASM input')
        imports.extend(fact['imports'])
    if not frontend:
        imports.extend(item for output in compiler['outputs'].values() for item in output['imports'])
    for imported in imports:
        name = imported['path']
        if Path(name.split('?', 1)[0].split('#', 1)[0]).suffix == '.wasm':
            raise ValueError('Zero application WASM contradicts an original WASM import observation')
        if imported.get('external') is not True and name not in compiler['inputs']:
            raise ValueError('Zero application WASM has an unresolved original compiler import')
    if any(Path(name).suffix == '.wasm' for name in compiler['outputs']):
        raise ValueError('Zero application WASM contradicts an original emitted WASM output')
    result = {'kind': 'selected-wasm-attribution', 'producer': module.npm.label(specification['producer']),
              'configuration': module.npm.sha256(captures['configuration']),
              'source_digest': module.npm.sha256(captures['compiler_inventory']),
              'artifacts': artifacts, 'packages': [], 'pending_scopes': [], 'components': [],
              'rust_attributions': [], 'rust_source_packages': [], 'generator_licenses': {}}
    owned.verify()
    return result


def collect(specification, wasm_inputs, owned):
    fields = {'producer', 'artifact', 'configuration', 'compiler_inventory',
              'declarations', 'npm_sources', 'npm_source_inventory', 'wasm_packages', 'compiler_origins',
              'rust_packages', 'workspace_manifest', 'workspace_license', 'generator_attributions',
              'rust_attributions', 'rust_attribution_inputs', 'workspace_package', 'frontend_checker', 'zero_source_inputs'}
    if not isinstance(specification, dict) or set(specification) != fields:
        raise ValueError('Exact original native compiler/WASM input authority required')
    npm, deployment, pack = wasm_inputs.npm, wasm_inputs.deployment, wasm_inputs.pack
    producer = npm.label(specification['producer'])
    captures = {name: capture(specification[name], owned)
                for name in ('configuration', 'compiler_inventory', 'declarations',
                             'npm_source_inventory')}
    context, compiler, declarations, sources = [pack.load_json(captures[name]) for name in
                                               ('configuration', 'compiler_inventory',
                                                'declarations', 'npm_source_inventory')]
    frontend = producer == '//apps/web:frontend_precompressed'
    zero = specification['wasm_packages'] == []
    if npm.label(context.get('producer')) != producer:
        raise ValueError('Selected WASM custody requires its original compiler context')
    if not frontend and (context.get('compile_target') not in NATIVE_COMPILE_TARGETS
                         or (not zero and specification['frontend_checker'] is not None)):
        raise ValueError('Selected WASM custody requires its original native compiler context')
    if not isinstance(specification['npm_sources'], list) or pack.canonical(sources) != pack.canonical(specification['npm_sources']):
        raise ValueError('Selected WASM partition differs from original typed npm sources')
    namespace = deployment.original_namespace(specification['configuration'], owned)
    if not zero and specification['zero_source_inputs'] is not None:
        raise ValueError('Nonzero WASM requires its original configured producer chain')
    if zero:
        return zero_application_wasm(specification, compiler, declarations, sources, wasm_inputs, namespace, owned, captures, frontend)
    packages = wasm_inputs.wasm_inputs(specification['wasm_packages'], namespace, owned)
    if not packages:
        raise ValueError('Selected WASM custody requires actual original package producers')
    origins = specification['compiler_origins']
    if not isinstance(origins, dict) or set(origins) != {package['producer'] for package in packages}:
        raise ValueError('Every WASM package requires its original configured compiler chain')
    captured_origins = {producer: compiler_origin(value, wasm_inputs, namespace, owned)
                        for producer, value in origins.items()}
    rust_sources = rust_source_packages(specification, captured_origins, wasm_inputs, namespace, owned)
    for package in packages:
        origin = captured_origins[package['producer']]
        binding, optimizer, chain = origin['generator_configurations']
        if npm.label(chain['producer']) != package['producer']:
            raise ValueError('WASM package differs from its original generator action producer')
        if binding['arguments'] != [origin['artifact']['input'], '--target', 'web', '--out-name',
                                    package['module'], '--out-dir', binding['output']['input']]:
            raise ValueError('Original WASM binding arguments differ from the packaged module')
        if (len(optimizer['arguments']) < 8 or optimizer['arguments'][:2] != ['--no-install', '--no-env-file']
                or optimizer['arguments'][4:7] != [binding['output']['input'], optimizer['output']['input'], package['module']]
                or optimizer['arguments'][7] not in {item['input'] for item in optimizer['tools']}):
            raise ValueError('Original WASM optimizer arguments differ from its declared module/tool')
    generators = selected_generator_licenses(specification['generator_attributions'],
                                             captured_origins, wasm_inputs, namespace, owned)
    authored = {}
    for origin in captured_origins.values():
        for fact in origin['generator_sources']:
            if not npm.label(fact['label']).startswith('//'):
                raise ValueError('External authored generator SourceFile needs its original source/license producer')
            authored[(fact['input'], fact['label'])] = fact
    if not authored:
        raise ValueError('Original authored generator SourceFiles cannot be replaced with an empty declaration')
    workspace_license = original_input(specification['workspace_license'], wasm_inputs, namespace, owned)[0]
    generators['authored_sources'] = [authored[key] for key in sorted(authored)]
    generators['workspace_license'] = {**workspace_license,
        'text': capture(specification['workspace_license']['input'], owned).decode('utf8')}
    manifest_descriptor = wasm_inputs.deployment.descriptor({name: specification['workspace_package'][name]
                                                       for name in ('input', 'label')})
    if specification['workspace_package'].get('tree') is not False or npm.label(manifest_descriptor['label']) != '//:package.json':
        raise ValueError('Authored WASM generators require their original private workspace manifest File')
    manifest_bytes = capture(manifest_descriptor['input'], owned)
    manifest_fact = original_input(specification['workspace_package'], wasm_inputs, namespace, owned)[0]
    if (owned.presentation(manifest_descriptor['input']).parent
            != owned.presentation(specification['workspace_license']['input']).parent):
        raise ValueError('Authored WASM generator license belongs to another original workspace')
    metadata = pack.load_json(manifest_bytes)
    component = {'id': metadata.get('name', '') + '#' + manifest_descriptor['label'],
                 'name': metadata.get('name'), 'version': None, 'private': True,
                 'source': None, 'repository': None, 'license': metadata.get('license'),
                 'license_file': None, 'source_label': manifest_descriptor['label']}
    wasm_inputs.closure.validate_private_manifest(component, manifest_bytes)
    component['texts'] = [{'path': 'LICENSE', 'label': workspace_license['label'],
                           'size': workspace_license['size'], 'sha256': workspace_license['sha256'],
                           'text': generators['workspace_license']['text']}]
    component['manifest'] = manifest_fact
    component['source_members'] = generators['authored_sources']
    generators['components'].append(component)

    frontend_facts = validated_compiler_artifacts(specification, compiler, wasm_inputs, namespace, owned, True) if frontend else None
    # Project original frontend fields solely for the common source resolver;
    # the unchanged frontend validator owns the complete five-field inventory.
    selection = {key: compiler[key] for key in ('inputs', 'outputs', 'artifacts')} if frontend else compiler
    _, physical_sources = npm.select(selection, declarations, sources)
    selected = {}
    for (logical, fact), (physical, data) in zip(compiler['inputs'].items(), physical_sources, strict=True):
        matches = []
        for index, package in enumerate(packages):
            for member, entry in package['entries'].items():
                if physical == package['root'] / member:
                    if npm.label(fact['owner']) != package['tree_label']:
                        raise ValueError('Selected WASM compiler owner differs from actual tree File owner')
                    pinned, _, _ = owned.file(physical)
                    original = owned.read(entry[1])
                    if owned.read(pinned) != data or original != data:
                        raise ValueError('Selected WASM input differs from original producer bytes')
                    matches.append((index, member))
        if len(matches) > 1:
            raise ValueError('Selected WASM input has ambiguous original producer custody')
        if not matches:
            if (physical.suffix == '.wasm'
                    or any(physical.is_relative_to(package['root'])
                           or npm.label(fact['owner']) == package['tree_label'] for package in packages)):
                raise ValueError('Selected generated WASM input has no original typed member custody')
            continue
        index, member = matches[0]
        selected.setdefault(index, []).append({'input': logical, 'member': member,
                                             'compiler_owner': fact['owner'],
                                             'size': fact['bytes'], 'sha256': fact['sha256']})
    if not selected:
        raise ValueError('Native compiler selected no original WASM package member')
    artifacts = frontend_facts if frontend else npm.artifact_facts(specification, compiler, owned)
    if (not isinstance(specification['rust_attributions'], dict)
            or set(specification['rust_attributions']) != set(captured_origins)):
        raise ValueError('Every selected WASM package requires original compiled Rust attribution and no foreign package mapping')
    rust = selected_rust_licenses(specification['rust_attributions'], specification['rust_attribution_inputs'],
                                  {packages[index]['producer']: captured_origins[packages[index]['producer']]
                                   for index in selected}, rust_sources, wasm_inputs, namespace, owned)
    components = {}
    for component in rust['components'] + generators['components']:
        identity = component['id']
        if identity in components and pack.canonical(components[identity]) != pack.canonical(component):
            raise ValueError('Conflicting selected WASM source/license component')
        components[identity] = component
    result = {'kind': 'selected-wasm-attribution', 'producer': producer,
              'configuration': npm.sha256(captures['configuration']),
              'source_digest': npm.sha256(captures['compiler_inventory']),
              'artifacts': artifacts,
              'packages': [{'producer': packages[index]['producer'],
                            'tree_label': packages[index]['tree_label'],
                            'module': packages[index]['module'],
                            'original_compiler': captured_origins[packages[index]['producer']],
                            'members': sorted(members, key=lambda item: item['input'])}
                           for index, members in sorted(selected.items())],
              'pending_scopes': [],
              'components': [components[key] for key in sorted(components)],
              'rust_attributions': rust['origins'],
              'rust_source_packages': rust_sources,
              'generator_licenses': generators}
    owned.verify()
    return result


def produce(specification, output, text, wasm_inputs):
    owned = wasm_inputs.deployment.DeclaredInputs()
    try:
        result = collect(specification, wasm_inputs, owned)
        explanation = wasm_inputs.closure.render(result)
        with wasm_inputs.pack.ArchiveOutputs(output, text) as outputs:
            for index, data in enumerate((wasm_inputs.pack.canonical(result), explanation)):
                with outputs.open(index) as stream:
                    stream.write(data)
                owned.verify()
                outputs.verify()
    finally:
        owned.close()


if __name__ == '__main__':
    specification, output, text, wasm_inputs = sys.argv[1:]
    module = load(wasm_inputs)
    produce(module.pack.load_json(Path(specification).read_bytes()), output, text, module)
