"""Reconcile typed configured npm sources and collect their published notice text."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


closure = load('license-closure')
inputs = closure.inputs
publication = load('rust-notices')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def label(value):
    normalized = value[2:] if isinstance(value, str) and value.startswith('@@//') else value
    if not closure.label(normalized):
        raise ValueError('Invalid typed npm source label')
    return normalized


def read_declared(filename):
    physical = Path(filename).resolve(strict=True)
    return inputs.read_regular(physical.parent, physical.name, require_text=False)


def member(root, filename):
    try:
        value = filename.relative_to(root)
    except ValueError:
        return None
    return value if value.parts else None


def package_origin(filename):
    """Validate a complete engine tree presentation against ordinary original members."""
    presentation = Path(filename).resolve(strict=True)
    manifest = (presentation / 'package.json').resolve(strict=True)
    if manifest.name != 'package.json':
        raise ValueError('Typed npm source has no exact original package.json member')
    origin = manifest.parent

    def inspect(logical, original):
        logical_names = {entry.name for entry in logical.iterdir()}
        original_names = {entry.name for entry in original.iterdir()}
        if logical_names != original_names:
            raise ValueError('Typed npm source presentation omits original members')
        for name in sorted(original_names):
            source, expected = logical / name, original / name
            if expected.is_symlink():
                raise ValueError('Original npm package contains an aliased member')
            if source.resolve(strict=True) != expected:
                # Sandbox directories may be ordinary directories whose children
                # individually point to the corresponding declared tree members.
                if not source.is_symlink() and source.is_dir() and expected.is_dir():
                    inspect(source, expected)
                    continue
                raise ValueError('Typed npm source member belongs to another origin')
            if expected.is_dir():
                inspect(source, expected)
            elif not expected.is_file():
                raise ValueError('Original npm package member is not regular')
    inspect(presentation, origin)
    return origin


def frontend_inventory(compiler):
    if not isinstance(compiler, dict) or set(compiler) != {'inputs', 'outputs', 'artifacts', 'unmatched_generated_modules', 'unmatched_generated_assets'} or any(not isinstance(compiler[name], list) for name in ['unmatched_generated_modules', 'unmatched_generated_assets']):
        raise ValueError('Frontend npm requires its original complete selection schema')
    if compiler['unmatched_generated_modules'] or compiler['unmatched_generated_assets']:
        raise ValueError('Frontend npm has unresolved generated source custody')
    return compiler


def frontend_bytes(value):
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise ValueError('Frontend selection has invalid byte facts')


def frontend_inputs(value):
    if not isinstance(value, dict) or not value:
        raise ValueError('Frontend selection requires its actual selected sources')
    for name, fact in value.items():
        inputs.relative(name)
        if not isinstance(fact, dict) or set(fact) != {'bytes', 'sha256', 'owner', 'imports'} or not isinstance(fact['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', fact['sha256']) or not isinstance(fact['imports'], list):
            raise ValueError('Frontend selection has invalid original input facts')
        frontend_bytes(fact['bytes'])
        label(fact['owner'])
        for imported in fact['imports']:
            if not isinstance(imported, dict) or set(imported) != {'path', 'kind'} or not isinstance(imported['path'], str) or imported['path'] not in value or not isinstance(imported['kind'], str) or imported['kind'] not in ['import-statement', 'dynamic-import']:
                raise ValueError('Frontend import has unresolved original source custody')


def frontend_output(value, selected):
    if not isinstance(value, dict) or 'bytes' not in value or set(value) - {'bytes', 'observations', 'public_input', 'compressed_from'} or ('observations' in value) == ('public_input' in value):
        raise ValueError('Frontend output requires one genuine selection boundary')
    frontend_bytes(value['bytes'])
    if 'public_input' in value:
        if not isinstance(value['public_input'], str) or value['public_input'] not in selected:
            raise ValueError('Frontend public output has an unowned source')
    else:
        if not isinstance(value['observations'], list) or not value['observations']:
            raise ValueError('Frontend output has no compiler observations')
        for observation in value['observations']:
            if not isinstance(observation, dict) or set(observation) != {'environment', 'type', 'selected'} or not isinstance(observation['environment'], str) or observation['environment'] not in ['client', 'worker'] or not isinstance(observation['type'], str) or observation['type'] not in ['chunk', 'asset'] or not isinstance(observation['selected'], list) or not observation['selected']:
                raise ValueError('Frontend output has invalid compiler observations')
            for item in observation['selected']:
                if not isinstance(item, dict) or set(item) != {'id', 'source'} or not isinstance(item['id'], str) or not isinstance(item['source'], str) or item['source'] not in selected:
                    raise ValueError('Frontend output has unresolved original source custody')
    return value


def frontend_outputs(compiler):
    frontend_inventory(compiler)
    frontend_inputs(compiler['inputs'])
    outputs, artifacts = compiler['outputs'], compiler['artifacts']
    if not isinstance(outputs, dict) or not outputs or not isinstance(artifacts, dict) or set(outputs) != set(artifacts):
        raise ValueError('Frontend artifact membership differs from original outputs')
    for name, value in outputs.items():
        inputs.relative(name)
        output = frontend_output(value, compiler['inputs'])
        fact = artifacts[name]
        if not isinstance(fact, dict) or set(fact) != {'bytes', 'sha256'} or output['bytes'] != fact['bytes']:
            raise ValueError('Frontend emitted output differs from its artifact facts')
        if name.endswith('.br'):
            original_name = name[:-3]
            original = frontend_output(outputs.get(original_name), compiler['inputs'])
            if output.get('compressed_from') != original_name or 'compressed_from' in original or {key: value for key, value in output.items() if key not in ['bytes', 'compressed_from']} != {key: value for key, value in original.items() if key != 'bytes'}:
                raise ValueError('Frontend precompression differs from original selected output')
        elif 'compressed_from' in output or name + '.br' not in outputs:
            raise ValueError('Frontend output has an incomplete precompression pair')
        if 'public_input' in output and not name.endswith('.br'):
            source = compiler['inputs'][output['public_input']]
            if source['bytes'] != fact['bytes'] or source['sha256'] != fact['sha256']:
                raise ValueError('Frontend public bytes differ from original source facts')


def select(compiler, declarations, sources):
    fields = {'inputs', 'outputs', 'artifacts'}
    if isinstance(compiler, dict) and set(compiler) == fields | {'unmatched_generated_modules', 'unmatched_generated_assets'}:
        frontend_inventory(compiler)
    elif not isinstance(compiler, dict) or set(compiler) != fields:
        raise ValueError('Invalid compiler source inventory')
    if not isinstance(compiler, dict) or not isinstance(compiler['inputs'], dict) or not compiler['inputs'] or not isinstance(compiler['outputs'], dict) or not isinstance(compiler['artifacts'], dict):
        raise ValueError('Invalid compiler source inventory')
    if not isinstance(declarations, dict) or not declarations:
        raise ValueError('Invalid original source declarations')
    logical_inputs = []
    for name, declaration in declarations.items():
        inputs.relative(name)
        if not isinstance(declaration, dict) or set(declaration) != {'input', 'link', 'owner', 'canonical'} or type(declaration['link']) is not bool:
            raise ValueError('Invalid original source declaration')
        inputs.relative(declaration['input'])
        inputs.relative(declaration['canonical'])
        label(declaration['owner'])
        logical_inputs.append((Path(name), declaration))
    logical_inputs.sort(key=lambda item: len(item[0].parts), reverse=True)
    roots = {source['input']: Path(source['input']).resolve(strict=True) for source in sources}
    members = {}

    def visit(source, filename, ancestors):
        physical = filename.resolve(strict=True)
        if physical.is_dir():
            if physical in ancestors:
                raise ValueError('Cyclic typed npm source tree')
            for child in sorted(filename.iterdir()):
                visit(source, child, ancestors | {physical})
        elif physical.is_file():
            members.setdefault(physical, {})[source['input']] = source
        else:
            raise ValueError('Non-regular typed npm source member')

    for source in sources:
        if not source['workspace']:
            visit(source, roots[source['input']], set())
    selected = {}
    compiler_facts = []
    for filename, fact in compiler['inputs'].items():
        inputs.relative(filename)
        if not isinstance(fact, dict) or type(fact.get('bytes')) is not int or fact['bytes'] < 0 or not isinstance(fact.get('sha256'), str) or len(fact['sha256']) != 64:
            raise ValueError('Invalid compiler input fact')
        label(fact.get('owner'))
        physical, declared_root, linked = None, None, None
        for logical, declaration in logical_inputs:
            suffix = member(logical, Path(filename))
            original = Path(declaration['input'])
            if logical == Path(filename):
                physical = original.resolve(strict=True)
            elif suffix is not None and original.is_dir():
                declared_root = original.resolve(strict=True)
                physical = (original / suffix).resolve(strict=True)
            else:
                continue
            if label(declaration['owner']) != label(fact['owner']):
                raise ValueError('Compiler npm owner differs from its original declaration')
            linked = declaration['link']
            break
        if physical is None:
            raise ValueError('Compiler input has no declared materialization')
        data = read_declared(physical)
        if len(data) != fact['bytes'] or sha256(data) != fact['sha256']:
            raise ValueError('Compiler input differs from declared source bytes')
        compiler_facts.append((physical, data))
        candidates = list(members.get(physical, {}).values())
        chosen = candidates[0] if len(candidates) == 1 else next((item for item in candidates if roots[item['input']] == declared_root), None)
        if len(candidates) > 1 and chosen is None:
            raise ValueError('Ambiguous typed npm resolution context')
        if chosen is not None:
            selected[chosen['input']] = chosen
        elif linked:
            raise ValueError('Compiler dependency has no typed source owner')
    return [selected[key] for key in sorted(selected)], compiler_facts



def compiler_tooling(value):
    if not isinstance(value, list):
        raise ValueError('Npm frontend requires its original compiler tooling')
    manifests = set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {'manifest_label', 'native'} or not isinstance(item['native'], dict) or set(item['native']) != {'input', 'label'}:
            raise ValueError('Invalid frontend compiler-tooling File join')
        manifest = label(item['manifest_label'])
        label(item['native']['label'])
        if not re.fullmatch(r'@@?[A-Za-z0-9_.+~-]+//[A-Za-z0-9_./+~@-]*:Cargo.toml', manifest) or manifest in manifests:
            raise ValueError('Frontend compiler tooling lacks a distinct upstream manifest')
        inputs.relative(item['native']['input'])
        manifests.add(manifest)
    return value


def frontend_context(configuration):
    fields = {'producer', 'project', 'frontend_build_id', 'backend_origin', 'opaque_public_key', 'build_commit', 'release_public_key', 'public_release', 'precompression', 'compiler_tooling'}
    release = configuration.get('public_release')
    if set(configuration) != fields or configuration['project'] != 'apps/web' or configuration['precompression'] is not True or not isinstance(configuration['frontend_build_id'], str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', configuration['frontend_build_id']) or any(not isinstance(configuration[key], str) for key in ['backend_origin', 'opaque_public_key', 'build_commit', 'release_public_key']) or not isinstance(release, dict) or set(release) != {'version', 'sequence', 'releasePublicKey', 'origin', 'opaquePublicKey'} or type(release['sequence']) is not int or not 0 <= release['sequence'] <= 9007199254740991 or any(not isinstance(release[key], str) for key in ['version', 'releasePublicKey', 'origin', 'opaquePublicKey']):
        raise ValueError('Npm requires the exact supported precompressed frontend context')
    return compiler_tooling(configuration['compiler_tooling'])


def pending_scopes(producer, configuration):
    if label(producer) == '//apps/web:frontend_precompressed':
        tooling = frontend_context(configuration)
        return ['first-party', 'wasm'] + (['compiler-tooling'] if tooling else [])
    if configuration.get('compiler_tooling') != []:
        raise ValueError('Native and migration npm require explicit empty compiler tooling')
    if label(producer) == '//apps/server:migrations':
        if configuration.get('target') != 'bun' or not isinstance(configuration.get('entry_points'), list) or not configuration['entry_points'] or not closure.nonempty(configuration.get('root')):
            raise ValueError('Migration npm requires its original bundle configuration')
        return ['first-party']
    if not closure.nonempty(configuration.get('compile_target')):
        raise ValueError('Standalone npm requires its original compile configuration')
    return ['first-party', 'wasm', 'embedded-runtime']


def artifact_facts(spec, compiler, owned, configuration):
    selected = load('deployment-pack')
    descriptor = selected.descriptor(spec['artifact'])
    producer = label(spec['producer'])
    if label(descriptor['label']) != producer:
        raise ValueError('Npm artifact belongs to another configured producer')
    namespace = selected.original_namespace(spec['configuration'], owned)
    if producer in ['//apps/server:migrations', '//apps/web:frontend_precompressed']:
        role = 'web' if producer == '//apps/web:frontend_precompressed' else 'migrations'
        entries = selected.declared_tree(descriptor, role, namespace, owned)
        if role == 'web':
            frontend_outputs(compiler)
            selected.validate_frontend(entries, configuration['frontend_build_id'], owned)
        facts = [{'path': name, 'label': item['label'], 'mode': item['mode'], 'size': size,
                  'sha256': sha256(owned.read(pinned))}
                 for name, (item, pinned, size) in sorted(entries.items())]
        selected.reconcile_outputs(compiler, facts, role)
    else:
        physical = owned.presentation(descriptor['input'])
        captured, size, digest = owned.file(physical, executable=True)
        basename = Path(descriptor['input']).name
        member = 'server/server' if producer == '//apps/server:server' else basename
        facts = [{'path': member, 'label': descriptor['label'], 'mode': '0555', 'size': size, 'sha256': digest}]
        selected.reconcile_outputs(compiler, facts, None, basename)
    return facts


def render(inventory):
    pending = ', '.join(inventory['pending_scopes'])
    return ('PARTIAL NPM ATTRIBUTION; PENDING: ' + pending + '\n\n').encode('utf8') + closure.render(inventory)


def collect(spec):
    fields = {'producer', 'artifact', 'manifest', 'compiler_inventory', 'declarations', 'configuration', 'npm_source_inventory', 'registry', 'sources'}
    if not isinstance(spec, dict) or set(spec) != fields or not isinstance(spec['sources'], list):
        raise ValueError('Invalid configured npm attribution authority')
    captures = {key: read_declared(spec[key]) for key in fields - {'producer', 'sources', 'artifact'}}
    manifest, compiler, declarations, configuration, source_inventory, registry = [json.loads(captures[key]) for key in ['manifest', 'compiler_inventory', 'declarations', 'configuration', 'npm_source_inventory', 'registry']]
    if not isinstance(manifest, dict) or set(manifest) != {'kind', 'expected', 'configuration_authority', 'compiler_inventory_sha256', 'registry_inventory_sha256', 'authorities', 'materializations', 'pending_scopes', 'selected_workspace_sources'} or manifest['kind'] != 'compiler-selected-npm-attribution':
        raise ValueError('Invalid selected npm attribution manifest')
    components = closure.validate(manifest['expected'])
    pending = pending_scopes(spec['producer'], configuration)
    if manifest['pending_scopes'] != pending:
        raise ValueError('Npm intermediate hides incomplete attribution scopes')
    sources = spec['sources']
    for source in sources:
        if not isinstance(source, dict) or set(source) != {'input', 'package', 'version', 'source_label', 'workspace'} or type(source['workspace']) is not bool or not closure.nonempty(source['package']) or not closure.nonempty(source['version']):
            raise ValueError('Invalid typed npm package provider')
        inputs.relative(source['input'])
        label(source['source_label'])
    if len({source['input'] for source in sources}) != len(sources) or not isinstance(source_inventory, list) or sorted(sources, key=lambda x: x['input']) != sorted(source_inventory, key=lambda x: x['input']):
        raise ValueError('Npm source inventory differs from original typed providers')
    authority = {'settings_sha256': sha256(captures['configuration']), 'npm_sources_sha256': sha256(captures['npm_source_inventory'])}
    configuration_digest = sha256(json.dumps(authority, separators=(',', ':')).encode('utf8'))
    if manifest['configuration_authority'] != authority or manifest['expected']['configuration'] != configuration_digest or manifest['expected']['producer'] != label(spec['producer']) or label(configuration.get('producer')) != label(spec['producer']):
        raise ValueError('Npm attribution belongs to another configured producer')
    if manifest['compiler_inventory_sha256'] != sha256(captures['compiler_inventory']) or manifest['expected']['source_digest'] != sha256(captures['compiler_inventory']) or manifest['registry_inventory_sha256'] != sha256(captures['registry']):
        raise ValueError('Npm attribution input digest mismatch')
    if label(spec['producer']) == '//apps/web:frontend_precompressed':
        frontend_outputs(compiler)
    elif set(compiler) != {'inputs', 'outputs', 'artifacts'}:
        raise ValueError('Invalid compiler source inventory')
    selected, compiler_facts = select(compiler, declarations, sources)
    expected_components, expected_authorities, expected_roots, workspace = [], [], {}, []
    materializations, package_facts = {}, []
    for source in selected:
        root = package_origin(source['input'])
        # Resolve only engine presentation. Original package members retain their
        # logical identity; aliases inside the package are never license inputs.
        package_bytes = inputs.read_regular(root, 'package.json')
        package = json.loads(package_bytes)
        version = package.get('version')
        if package.get('name') != source['package'] or not isinstance(version, str) or not (source['version'] == version or source['version'].startswith(version + '(')):
            raise ValueError('Typed npm provider differs from package metadata')
        lock = registry.get(source['package'] + '@' + version)
        if lock is None:
            if not source['workspace'] or source['version'] != '0.0.0':
                raise ValueError('Selected npm package is missing from registry authority')
            workspace.append(source)
            continue
        integrity, tarball = lock.get('integrity'), lock.get('tarball')
        if not isinstance(integrity, str) or not integrity.startswith('sha512-') or not isinstance(tarball, str) or not tarball.startswith('https://registry.npmjs.org/'):
            raise ValueError('Invalid locked npm source authority')
        digest = base64.b64decode(integrity[7:], validate=True)
        if len(digest) != 64 or base64.b64encode(digest).decode('ascii') != integrity[7:]:
            raise ValueError('Noncanonical locked npm integrity')
        expression = package.get('license')
        if not closure.nonempty(expression):
            raise ValueError('Npm package has no effective license')
        license_file = inputs.relative(expression[15:]) if expression.startswith('SEE LICENSE IN ') else None
        repository = package.get('repository')
        if isinstance(repository, dict):
            repository = repository.get('url')
        if not isinstance(repository, str) or not repository:
            repository = None
        identity = source['package'] + '@' + version + '#' + sha256(source['source_label'].encode('utf8'))
        source_label = label(source['source_label'])
        component = {'id': identity, 'name': source['package'], 'version': version, 'source': tarball + ' ' + integrity, 'license': expression, 'repository': repository, 'license_file': license_file, 'source_label': source_label}
        expected_components.append(component)
        expected_authorities.append({'id': identity, 'resolver_version': source['version'], 'package_json_sha256': sha256(package_bytes), 'registry_integrity': integrity, 'registry_tarball': tarball})
        expected_roots[identity] = {'root': source['input'], 'label': source_label}
        materializations[identity] = {'root': str(root), 'label': source_label}
        identity = root.stat()
        package_facts.append((source['input'], root, (identity.st_dev, identity.st_ino), package_bytes))
    if components != expected_components or manifest['authorities'] != expected_authorities or manifest['materializations'] != expected_roots or manifest['selected_workspace_sources'] != workspace:
        raise ValueError('Selected npm attribution differs from compiler and typed package closure')
    inventory = closure.collect(manifest['expected'], materializations)
    # Cross-package capture is coherent with the same configured source bytes,
    # not only each individual file read. No silent retries on changing inputs.
    after_selected, after_compiler_facts = select(compiler, declarations, sources)
    if after_selected != selected or after_compiler_facts != compiler_facts:
        raise ValueError('Compiler source ownership changed during notice collection')
    for filename, root, identity, data in package_facts:
        current = package_origin(filename)
        fact = current.stat()
        if current != root or (fact.st_dev, fact.st_ino) != identity or inputs.read_regular(root, 'package.json') != data:
            raise ValueError('Package metadata changed during notice collection')
    for component in inventory['components']:
        if inputs.collect(materializations[component['id']]['root'], component['license_file']) != component['texts']:
            raise ValueError('Published npm license inputs changed during collection')
    with_artifact = load('deployment-pack').DeclaredInputs()
    try:
        artifacts = artifact_facts(spec, compiler, with_artifact, configuration)
        with_artifact.verify()
    finally:
        with_artifact.close()
    for key, data in captures.items():
        if read_declared(spec[key]) != data:
            raise ValueError('Configured attribution authority changed during collection')
    return {'kind': 'npm-attribution-intermediate', **inventory, 'configuration_authority': authority, 'authorities': expected_authorities, 'pending_scopes': manifest['pending_scopes'], 'selected_workspace_sources': workspace, 'artifacts': artifacts}


if __name__ == '__main__':
    inventory = collect(json.loads(Path(sys.argv[1]).read_bytes()))
    publication.publish_bytes([(Path(sys.argv[2]), closure.canonical(inventory)), (Path(sys.argv[3]), render(inventory))])
