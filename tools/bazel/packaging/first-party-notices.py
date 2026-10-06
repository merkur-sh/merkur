"""Collect authored workspace notices from actual configured compiler inputs."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tomllib


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deployment = load('deployment-pack')
npm = load('npm-notices')
wasm = load('wasm-inputs')
closure = npm.closure
pack = deployment.pack
ROLES = {'//apps/server:server': ('server', ['npm', 'wasm', 'embedded-runtime']),
         '//apps/server:migrations': ('migrations', ['npm']),
         '//apps/web:frontend_precompressed': ('web', ['npm', 'wasm']),
         '//apps/daemon:daemon': ('merkur', ['npm', 'wasm', 'embedded-runtime']),
         '//scripts:release_verifier': ('verify', ['npm', 'wasm', 'embedded-runtime'])}
STANDALONE_ROLES = {'server', 'merkur', 'verify'}
NATIVE_COMPILE_TARGETS = {'bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64'}


def capture(filename, owned):
    pinned, size, digest = owned.file(owned.presentation(filename))
    return owned.read(pinned), {'size': size, 'sha256': digest}


def manifest_prefix(value):
    label = npm.label(value)
    if not label.startswith('//') or not label.endswith(':package.json'):
        raise ValueError('Authored package requires its original workspace manifest label')
    return label[2:].split(':', 1)[0]



def package_inputs(record, owned, namespace, context):
    if not isinstance(record, dict) or set(record) != {'root', 'source_label', 'manifest_label', 'files'} or not isinstance(record['files'], list):
        raise ValueError('Invalid authored package source provider')
    if any(not isinstance(item, dict) or set(item) != {'path', 'input', 'label'} for item in record['files']):
        raise ValueError('Invalid authored source File descriptor')
    prefix = manifest_prefix(record['manifest_label'])
    root = namespace / closure.inputs.relative(record['root'])
    entries = deployment.declared_tree({'input': record['root'], 'label': record['source_label']}, prefix or 'workspace', namespace, owned)
    if not prefix:
        entries = {name[len('workspace/'):]: entry for name, entry in entries.items()}
    manifests = [item for item in record['files'] if item.get('path') == 'package.json']
    if len(manifests) != 1:
        raise ValueError('Authored package requires exactly one original manifest File')
    original_root = owned.presentation(manifests[0]['input']).parent
    sources = {}
    for item in record['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'input', 'label'}:
            raise ValueError('Invalid authored source File descriptor')
        relative = closure.inputs.relative(item['path'])
        logical = prefix + '/' + relative if prefix else relative
        owner = npm.label(item['label'])
        owner_matches = owner.startswith('//' + prefix + ':') if prefix else (
            owner.startswith('//') and owner[2:].replace(':', '/', 1).lstrip('/') == relative)
        if logical in sources or logical not in entries or not owner_matches:
            raise ValueError('Authored source membership differs from original package')
        physical = owned.presentation(item['input'])
        if physical != original_root / relative:
            raise ValueError('Authored member belongs to another original package')
        closure.inputs.read_regular(original_root, relative, require_text=False)
        pinned, _, _ = owned.file(physical)
        if owned.read(pinned) != owned.read(entries[logical][1]):
            raise ValueError('Authored tree differs from original declared source File')
        sources[logical] = (physical, entries[logical], item['label'])
    if set(sources) != set(entries):
        raise ValueError('Authored source provider omits a declared package member')
    manifest = prefix + '/package.json' if prefix else 'package.json'
    if manifest not in entries:
        raise ValueError('Authored package has no declared manifest member')
    metadata = pack.load_json(owned.read(entries[manifest][1]))
    if not prefix:
        release = context.get('public_release')
        if not isinstance(release, dict) or not closure.nonempty(release.get('version')):
            raise ValueError('Root authored package requires its original declared build version')
        metadata = {**metadata, 'version': release['version']}
    if any(not closure.nonempty(metadata.get(key)) for key in ('name', 'version', 'license')):
        raise ValueError('Authored package has no explicit name, version and license')
    return {'record': record, 'root': root, 'entries': entries, 'sources': sources,
            'metadata': metadata, 'manifest_file': entries[manifest][1]}


def tooling_package_inputs(record, namespace, context, owned):
    fields = {'root', 'source_label', 'manifest_label', 'files', 'workspace_manifest',
              'workspace_license', 'native'}
    if not isinstance(record, dict) or set(record) != fields or not isinstance(record['files'], list):
        raise ValueError('Invalid original compiler-tooling source provider')
    manifest_label = npm.label(record['manifest_label'])
    repository, separator, package = manifest_label.partition('//')
    if not separator or not repository.startswith('@') or not package.endswith(':Cargo.toml'):
        raise ValueError('Compiler tooling requires its original upstream Cargo manifest')
    package = package.removesuffix(':Cargo.toml')
    closure.inputs.relative(package)
    workspace = deployment.descriptor(record['workspace_manifest'])
    license_input = deployment.descriptor(record['workspace_license'])
    native = deployment.descriptor(record['native'])
    if (npm.label(workspace['label']) != repository + '//:Cargo.toml' or
            npm.label(license_input['label']) != repository + '//:LICENSE'):
        raise ValueError('Compiler-tooling workspace notice has foreign ownership')
    relation = {'manifest_label': manifest_label, 'native': native}
    joins = context.get('compiler_tooling')
    if not isinstance(joins, list) or joins.count(relation) != 1:
        raise ValueError('Compiler tooling differs from its actual native supplier configuration')
    workspace_file = owned.presentation(workspace['input'])
    license_file = owned.presentation(license_input['input'])
    if workspace_file.name != 'Cargo.toml' or license_file != workspace_file.parent / 'LICENSE':
        raise ValueError('Compiler-tooling workspace notice belongs to another original tree')
    workspace_bytes, _ = capture(workspace['input'], owned)
    notice_bytes, notice_fact = capture(license_input['input'], owned)
    closure.inputs.read_regular(workspace_file.parent, 'Cargo.toml')
    closure.inputs.read_regular(workspace_file.parent, 'LICENSE')
    entries = deployment.declared_tree({'input': record['root'], 'label': record['source_label']},
                                       'compiler-tooling', namespace, owned)
    entries = {name.removeprefix('compiler-tooling/'): entry for name, entry in entries.items()}
    sources = {}
    for item in record['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'input', 'label'}:
            raise ValueError('Invalid original compiler-tooling source File')
        member = closure.inputs.relative(item['path'])
        source_label = npm.label(item['label'])
        if (member in sources or member not in entries or
                source_label != repository + '//' + package + ':' + member):
            raise ValueError('Compiler-tooling member differs from its original File ownership')
        physical = owned.presentation(item['input'])
        if physical != workspace_file.parent / package / member:
            raise ValueError('Compiler-tooling member belongs to another original package')
        closure.inputs.read_regular(workspace_file.parent, package + '/' + member, require_text=False)
        pinned, _, _ = owned.file(physical)
        if owned.read(pinned) != owned.read(entries[member][1]):
            raise ValueError('Compiler-tooling source tree differs from original File bytes')
        sources[member] = (physical, entries[member], source_label)
    if set(sources) != set(entries) or 'Cargo.toml' not in sources:
        raise ValueError('Compiler-tooling source inventory omits original package members')
    metadata, _ = npm.publication.metadata.effective(owned.read(entries['Cargo.toml'][1]), workspace_bytes)
    workspace_table = tomllib.loads(workspace_bytes.decode('utf8')).get('workspace')
    workspace_metadata = workspace_table.get('package') if isinstance(workspace_table, dict) else None
    if not isinstance(workspace_metadata, dict):
        raise ValueError('Compiler tooling has no original Cargo workspace package metadata')
    texts = closure.inputs.collect(workspace_file.parent / package, metadata['license_file']) if (
        any(Path(name).name.lower().startswith(('license', 'copying', 'notice', 'unlicense'))
            for name in entries) or metadata['license_file']) else []
    if metadata['license'] == workspace_metadata.get('license'):
        if not notice_bytes.decode('utf8').strip():
            raise ValueError('Compiler-tooling original workspace notice is empty')
        texts.append({'path': 'LICENSE', **notice_fact, 'text': notice_bytes.decode('utf8'),
                      'label': npm.label(license_input['label'])})
    if not texts:
        raise ValueError('Compiler tooling lacks its complete original license text')
    native_physical = owned.presentation(native['input'])
    _, size, digest = owned.file(native_physical, executable=True)
    return {'record': record, 'sources': sources, 'metadata': metadata, 'texts': texts,
            'manifest_sha256': hashlib.sha256(owned.read(entries['Cargo.toml'][1])).hexdigest(),
            'native': {'label': npm.label(native['label']), 'size': size, 'sha256': digest}}


def selected_sources(compiler, declarations, registry_sources, packages, generated, tooling, owned):
    selected_registry, facts = npm.select(compiler, declarations, registry_sources)
    registry_roots = [npm.package_origin(item['input']) for item in selected_registry]
    selected = {}
    selected_tooling = {}
    for (logical, fact), (physical, data) in zip(compiler['inputs'].items(), facts, strict=True):
        declared = sorted((name for name, item in declarations.items() if name == logical or
                           (logical.startswith(name + '/') and Path(item['input']).is_dir())),
                          key=len, reverse=True)
        if not declared or npm.label(declarations[declared[0]]['owner']) != npm.label(fact['owner']):
            raise ValueError('Compiler owner differs from original source declaration')
        pinned, _, _ = owned.file(physical)
        if owned.read(pinned) != data:
            raise ValueError('Compiler input changed before authored source capture')
        matches = []
        for package in packages:
            for member, (source, entry, source_label) in package['sources'].items():
                if source == physical:
                    authored = owned.read(entry[1])
                    if authored != data:
                        raise ValueError('Compiler input differs from original authored source')
                    matches.append((package, member, entry, source_label))
        if len(matches) > 1:
            raise ValueError('Compiler input has ambiguous authored package custody')
        tooling_matches = [(package, member, entry, source_label)
                           for package in tooling
                           for member, (source, entry, source_label) in package['sources'].items()
                           if source == physical]
        if len(tooling_matches) > 1 or (tooling_matches and (matches or
                any(physical.is_relative_to(root) for root in registry_roots) or
                any(physical.is_relative_to(package['root']) for package in generated))):
            raise ValueError('Selected compiler-tooling input has ambiguous original source custody')
        if tooling_matches:
            package, member, entry, source_label = tooling_matches[0]
            if npm.label(fact['owner']) != source_label or owned.read(entry[1]) != data:
                raise ValueError('Selected compiler tooling differs from original File bytes or owner')
            identity = package['record']['manifest_label']
            selected_tooling.setdefault(identity, (package, []))[1].append({
                'path': member, 'label': source_label, 'size': len(data),
                'sha256': hashlib.sha256(data).hexdigest(), 'compiler_owner': fact['owner']})
            continue
        if matches:
            package, member, entry, source_label = matches[0]
            identity = package['record']['manifest_label']
            selected.setdefault(identity, (package, []))[1].append({
                'path': member, 'label': source_label, 'size': len(data),
                'sha256': hashlib.sha256(data).hexdigest(), 'compiler_owner': fact['owner']})
        else:
            generated_matches = []
            for package in generated:
                if physical.is_relative_to(package['root']):
                    member = physical.relative_to(package['root']).as_posix()
                    entry = package['entries'].get(member)
                    if entry is None or npm.label(fact['owner']) != package['tree_label']:
                        raise ValueError('Selected WASM member lacks original declared producer custody')
                    if owned.read(entry[1]) != data:
                        raise ValueError('Selected WASM input differs from original generated member bytes')
                    generated_matches.append(package)
            if len(generated_matches) > 1 or (generated_matches and any(physical.is_relative_to(root) for root in registry_roots)):
                raise ValueError('Selected input has ambiguous typed WASM/npm custody')
            if not generated_matches and not any(physical.is_relative_to(root) for root in registry_roots):
                raise ValueError('Selected input lacks authored, typed npm or typed WASM custody; generated scopes remain pending')
    if not selected:
        raise ValueError('Compiler selected no authored workspace source')
    return ([selected[key] for key in sorted(selected)],
            [selected_tooling[key] for key in sorted(selected_tooling)])


def tooling_component(package, members):
    metadata, record = package['metadata'], package['record']
    result = {'id': metadata['name'] + '@' + metadata['version'] + '#' + record['manifest_label'],
              'name': metadata['name'], 'version': metadata['version'], 'license': metadata['license'],
              'source': None, 'repository': metadata['repository'], 'license_file': metadata['license_file'],
              'source_label': npm.label(record['source_label']), 'texts': package['texts'],
              'manifest': {'label': npm.label(record['manifest_label']), 'sha256': package['manifest_sha256']},
              'source_members': sorted(members, key=lambda value: value['path']),
              'native': package['native']}
    closure.validate({'producer': '//validation:compiler-tooling', 'configuration': 'schema-only',
                      'source_digest': '0' * 64,
                      'components': [{key: result[key] for key in closure.FIELDS}]})
    return result


def component(package, members, workspace, owned):
    metadata = package['metadata']
    expression = metadata['license']
    license_file = closure.inputs.relative(expression[15:]) if expression.startswith('SEE LICENSE IN ') else None
    texts = closure.inputs.collect(package['root'], license_file) if any(Path(name).name.lower().startswith(('license', 'copying', 'notice', 'unlicense')) for name in package['entries']) or license_file else []
    if expression == workspace['metadata'].get('license'):
        texts.append({**workspace['text'], 'label': npm.label(workspace['license']['label'])})
    if not texts:
        raise ValueError('Authored package lacks its own complete published license text')
    repository = metadata.get('repository')
    if isinstance(repository, dict):
        repository = repository.get('url')
    repository = repository if closure.nonempty(repository) else None
    manifest_label = npm.label(package['record']['manifest_label'])
    manifest_bytes = owned.read(package['manifest_file'])
    result = {'id': metadata['name'] + '@' + metadata['version'] + '#' + manifest_label,
              'name': metadata['name'], 'version': metadata['version'], 'license': expression,
              'source': None, 'repository': repository, 'license_file': license_file,
              'source_label': npm.label(package['record']['source_label']), 'texts': texts,
              'manifest': {'label': manifest_label, 'sha256': hashlib.sha256(manifest_bytes).hexdigest()},
              'source_members': sorted(members, key=lambda value: value['path'])}
    closure.validate({'producer': '//validation:authored', 'configuration': 'schema-only',
                      'source_digest': '0' * 64, 'components': [{key: result[key] for key in closure.FIELDS}]})
    return result


def artifact(value, role, owned, namespace, build_id):
    descriptor = deployment.descriptor(value)
    physical = owned.presentation(descriptor['input'])
    if role in STANDALONE_ROLES:
        pinned, size, sha = owned.file(physical, executable=True)
        member = 'server/server' if role == 'server' else Path(descriptor['input']).name
        entries = {member: ({'label': descriptor['label'], 'mode': '0555'}, pinned, size)}
    else:
        entries = deployment.declared_tree(descriptor, role, namespace, owned)
    if role == 'web':
        deployment.validate_frontend(entries, build_id, owned)
    facts = []
    for member, (item, pinned, size) in sorted(entries.items()):
        facts.append({'path': member, 'label': item['label'], 'mode': item['mode'], 'size': size,
                      'sha256': hashlib.sha256(owned.read(pinned)).hexdigest()})
    return facts



def collect(spec, owned):
    if not isinstance(spec, dict) or set(spec) != {'producer', 'artifact', 'configuration', 'compiler_inventory', 'declarations', 'npm_sources', 'npm_source_inventory', 'wasm_packages', 'compiler_tooling', 'packages', 'workspace_manifest', 'workspace_license'} or not isinstance(spec['packages'], list) or not isinstance(spec['npm_sources'], list) or not isinstance(spec['compiler_tooling'], list):
        raise ValueError('Invalid configured first-party attribution authority')
    producer = npm.label(spec['producer'])
    if producer not in ROLES or npm.label(spec['artifact']['label']) != producer:
        raise ValueError('First-party notices require the exact deployment producer')
    role, pending = ROLES[producer]
    captures = {key: capture(spec[key], owned)[0] for key in ('configuration', 'compiler_inventory', 'declarations', 'npm_source_inventory')}
    context, compiler, declarations = [pack.load_json(captures[key]) for key in ('configuration', 'compiler_inventory', 'declarations')]
    if npm.label(context.get('producer')) != producer:
        raise ValueError('First-party notices differ from original compiler configuration')
    if role in {'merkur', 'verify'} and context.get('compile_target') not in NATIVE_COMPILE_TARGETS:
        raise ValueError('Native first-party notices require original standalone compile configuration')
    for source in spec['npm_sources']:
        if not isinstance(source, dict) or set(source) != {'input', 'package', 'version', 'source_label', 'workspace'} or type(source['workspace']) is not bool or any(not closure.nonempty(source[key]) for key in ('package', 'version')):
            raise ValueError('Invalid original typed npm source descriptor')
        closure.inputs.relative(source['input'])
        npm.label(source['source_label'])
    if pack.canonical(spec['npm_sources']) != pack.canonical(pack.load_json(captures['npm_source_inventory'])) or len({source['input'] for source in spec['npm_sources']}) != len(spec['npm_sources']):
        raise ValueError('First-party partition differs from original typed npm source inventory')
    namespace = deployment.original_namespace(spec['configuration'], owned)
    packages = [package_inputs(record, owned, namespace, context) for record in spec['packages']]
    if len({npm.label(item['record']['manifest_label']) for item in packages}) != len(packages):
        raise ValueError('Duplicate authored package manifest')
    generated = wasm.wasm_inputs(spec['wasm_packages'], namespace, owned)
    tooling = [tooling_package_inputs(record, namespace, context, owned) for record in spec['compiler_tooling']]
    selected, selected_tooling = selected_sources(compiler, declarations, spec['npm_sources'], packages, generated, tooling, owned)
    manifest = deployment.descriptor(spec['workspace_manifest'])
    license_input = deployment.descriptor(spec['workspace_license'])
    if npm.label(manifest['label']) != '//:package.json' or npm.label(license_input['label']) != '//:LICENSE':
        raise ValueError('Repository license has no exact workspace ownership')
    metadata = pack.load_json(capture(manifest['input'], owned)[0])
    original_manifest = owned.presentation(manifest['input'])
    if owned.presentation(license_input['input']) != original_manifest.parent / 'LICENSE':
        raise ValueError('Repository license belongs to another declared workspace')
    closure.inputs.read_regular(original_manifest.parent, 'LICENSE')
    text, fact = capture(license_input['input'], owned)
    if not text.decode('utf8').strip():
        raise ValueError('Repository license text is empty')
    workspace = {'metadata': metadata, 'license': license_input,
                 'text': {'path': 'LICENSE', **fact, 'text': text.decode('utf8')}}
    components = [component(package, members, workspace, owned) for package, members in selected]
    tooling_components = [tooling_component(package, members) for package, members in selected_tooling]
    artifacts = artifact(spec['artifact'], role, owned, namespace, context.get('frontend_build_id'))
    deployment.reconcile_outputs(compiler, artifacts, role, Path(spec['artifact']['input']).name if role in STANDALONE_ROLES else None)
    result = {'kind': 'selected-first-party-attribution', 'producer': producer,
              'configuration': hashlib.sha256(captures['configuration']).hexdigest(),
              'source_digest': hashlib.sha256(captures['compiler_inventory']).hexdigest(),
              'components': components, 'compiler_tooling': tooling_components,
              'pending_scopes': pending + (['compiler-tooling'] if context.get('compiler_tooling') else []),
              'artifacts': artifacts}
    owned.verify()
    return result


def produce(spec, inventory, notices):
    owned = deployment.DeclaredInputs()
    try:
        result = collect(spec, owned)
        with pack.ArchiveOutputs(inventory, notices) as outputs:
            for index, data in enumerate((closure.canonical(result), closure.render({**result, 'components': result['components'] + result['compiler_tooling']}))):
                with outputs.open(index) as stream:
                    stream.write(data)
                owned.verify()
                outputs.verify()
    finally:
        owned.close()


if __name__ == '__main__':
    produce(pack.load_json(Path(sys.argv[1]).read_bytes()), sys.argv[2], sys.argv[3])
