"""Join the exact configured deployment notice scopes; never resolve packages."""
import hashlib
import importlib.util
from pathlib import Path
import re
import sys


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deployment = load('deployment-pack')
closure = load('license-closure')
pack = deployment.pack
REQUIRED = {'server': ['embedded-runtime', 'first-party', 'npm', 'wasm'],
            'migrations': ['first-party', 'npm'], 'web': ['first-party', 'npm', 'wasm']}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def producer_label(value):
    # Canonical-main spelling and apparent-main spelling identify the same Bazel
    # label; named external repositories are never collapsed.
    return value[2:] if isinstance(value, str) and value.startswith('@@//') else value


def capture(value, inputs):
    descriptor = deployment.descriptor(value)
    pinned, size, sha = inputs.file(inputs.presentation(descriptor['input']))
    return inputs.read(pinned), {'label': descriptor['label'], 'size': size, 'sha256': sha}


def artifact_facts(entries):
    result = {role: [] for role in REQUIRED}
    for path, (item, pinned, size) in sorted(entries.items()):
        role = path.split('/', 1)[0]
        if role not in result:
            raise ValueError('Unexpected deployment artifact role')
        with pinned.open('rb') as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        result[role].append({'path': path, 'label': item['label'], 'mode': item['mode'],
                             'size': size, 'sha256': sha})
    if any(not facts for facts in result.values()):
        raise ValueError('Deployment attribution requires every artifact producer')
    return result


def render(providers):
    sections = []
    for item in sorted(providers, key=lambda value: (value['role'], value['scope'])):
        normalized = {'producer': item['producer'],
                      'configuration': item['inputs']['configuration']['sha256'],
                      'source_digest': item['inputs']['source_inventory']['sha256'],
                      'components': item['components'] + item['compiler_tooling']}
        sections.append((item['role'] + '/' + item['scope'] + '\n').encode('utf8') + closure.render(normalized) + b'\n')
    return b'MERKUR DEPLOYMENT LICENSES AND NOTICES\n\n' + b''.join(sections)


def components(inventory):
    values = inventory.get('components')
    if not isinstance(values, list) or not values:
        raise ValueError('Selected notice scope has no component inventory')
    seen = set()
    for item in values:
        if not isinstance(item, dict) or any(not closure.nonempty(item.get(key)) for key in ('id', 'name')) or not closure.label(item.get('source_label')) or item['id'] in seen:
            raise ValueError('Invalid or duplicate selected notice component')
        seen.add(item['id'])
        texts = item.get('texts')
        if not isinstance(texts, list) or not texts:
            raise ValueError('Selected component has no published notice text')
        paths = set()
        for text in texts:
            if not isinstance(text, dict) or set(text) not in ({'path', 'size', 'sha256', 'text'}, {'path', 'size', 'sha256', 'text', 'label'}):
                raise ValueError('Invalid published notice input')
            path = closure.inputs.relative(text['path'])
            if path in paths or not isinstance(text['text'], str) or not text['text'].strip():
                raise ValueError('Missing or repeated published notice text')
            paths.add(path)
            data = text['text'].encode('utf8')
            if type(text['size']) is not int or text['size'] != len(data) or text['sha256'] != digest(data):
                raise ValueError('Published notice text differs from selected component bytes')
            if 'label' in text and not closure.label(text['label']):
                raise ValueError('Published notice belongs to an invalid source label')
        normalized = {key: item.get(key) for key in closure.component_fields(item)}
        closure.validate({'producer': '//validation:scope', 'configuration': 'schema-only',
                          'source_digest': '0' * 64, 'components': [normalized]})
    return values



def compiler_tooling(inventory):
    values = inventory.get('compiler_tooling')
    if not isinstance(values, list):
        raise ValueError('First-party notices require their original compiler-tooling partition')
    if not values:
        return values
    components({'components': values})
    pending = inventory.get('pending_scopes')
    if not isinstance(pending, list) or pending.count('compiler-tooling') != 1:
        raise ValueError('Compiler-tooling source notices erased their incomplete native scope')
    authored_ids = {item['id'] for item in inventory['components']}
    for item in values:
        if item['id'] in authored_ids:
            raise ValueError('Compiler-tooling notices duplicate authored source components')
        if set(item) != closure.FIELDS | {'texts', 'manifest', 'source_members', 'native'}:
            raise ValueError('Compiler-tooling notices have invalid original source facts')
        manifest, native, members = item['manifest'], item['native'], item['source_members']
        if (not isinstance(manifest, dict) or set(manifest) != {'label', 'sha256'} or
                not closure.label(manifest['label']) or not manifest['label'].endswith(':Cargo.toml') or
                not isinstance(manifest['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', manifest['sha256'])):
            raise ValueError('Compiler-tooling notices lack original Cargo manifest facts')
        if (not isinstance(native, dict) or set(native) != {'label', 'size', 'sha256'} or
                not closure.label(native['label']) or type(native['size']) is not int or native['size'] <= 0 or
                not isinstance(native['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', native['sha256'])):
            raise ValueError('Compiler-tooling notices lack original native artifact facts')
        if not isinstance(members, list) or not members:
            raise ValueError('Compiler-tooling notices lack selected original source members')
        paths = set()
        for member in members:
            if (not isinstance(member, dict) or set(member) != {'path', 'label', 'size', 'sha256', 'compiler_owner'} or
                    not closure.label(member['label']) or member['compiler_owner'] != member['label'] or
                    type(member['size']) is not int or member['size'] < 0 or
                    not isinstance(member['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', member['sha256'])):
                raise ValueError('Compiler-tooling notices have invalid selected source File facts')
            path = closure.inputs.relative(member['path'])
            if path in paths:
                raise ValueError('Compiler-tooling notices repeat selected source members')
            paths.add(path)
    return values


def validate_scope(scope, producer, inventory, context, source, notices, artifacts):
    kind = inventory.get('kind')
    if kind == 'npm-attribution-intermediate' and scope == 'npm':
        if producer_label(inventory.get('producer')) != producer_label(producer) or inventory.get('configuration_authority', {}).get('settings_sha256') != digest(context) or inventory.get('source_digest') != digest(source):
            raise ValueError('Npm notice scope belongs to another configured compiler')
        pending = inventory.get('pending_scopes')
        expected_pending = ['first-party'] if producer_label(producer) == '//apps/server:migrations' else ['first-party', 'wasm', 'embedded-runtime']
        if pending != expected_pending:
            raise ValueError('Npm intermediate erased its original pending scope inventory')
        if pack.canonical(inventory.get('artifacts')) != pack.canonical(artifacts):
            raise ValueError('Npm notices differ from the actual selected artifact bytes')
        expected = ('PARTIAL NPM ATTRIBUTION; PENDING: ' + ', '.join(pending) + '\n\n').encode('utf8') + closure.render(inventory)
    elif kind == 'rust-attribution-intermediate' and scope == 'wasm':
        descriptor = pack.load_json(source)
        if inventory.get('descriptor_sha256') != digest(source) or inventory.get('configuration') != descriptor.get('configuration') or inventory['configuration'].get('target') != 'wasm32-unknown-unknown':
            raise ValueError('Rust notices are not the selected WASM compiler closure')
        pending = inventory.get('pending')
        lines = ['DECLARED RUST ATTRIBUTION', 'Compiler root: ' + inventory['configuration']['compiler_root'], '']
        for item in inventory['components']:
            lines += ['-' * 78, closure.component_title(item), 'Package identity: ' + item['id'], '']
            for text in item['texts']:
                lines += [text['path'] + ' SHA-256 ' + text['sha256'], text['text'], '']
        expected = '\n'.join(lines).encode('utf8')
    elif kind in ('selected-first-party-attribution', 'selected-embedded-runtime-attribution', 'selected-npm-attribution') and scope == {'selected-first-party-attribution': 'first-party', 'selected-embedded-runtime-attribution': 'embedded-runtime', 'selected-npm-attribution': 'npm'}[kind]:
        if producer_label(inventory.get('producer')) != producer_label(producer) or inventory.get('configuration') != digest(context) or inventory.get('source_digest') != digest(source):
            raise ValueError('Notice scope belongs to another configured source inventory')
        pending = inventory.get('pending_scopes')
        if scope == 'first-party' and pack.canonical(inventory.get('artifacts')) != pack.canonical(artifacts):
            raise ValueError('First-party notices differ from the actual selected artifact bytes')
        tooling = compiler_tooling(inventory) if scope == 'first-party' else []
        joins = pack.load_json(context).get('compiler_tooling')
        if scope == 'first-party' and isinstance(joins, list) and joins:
            if not isinstance(pending, list) or pending.count('compiler-tooling') != 1:
                raise ValueError('Configured compiler tooling erased its incomplete native scope')
        if tooling:
            for item in tooling:
                if (not isinstance(joins, list) or len([join for join in joins
                        if isinstance(join, dict) and set(join) == {'manifest_label', 'native'} and
                        join['manifest_label'] == item['manifest']['label'] and
                        isinstance(join['native'], dict) and set(join['native']) == {'input', 'label'} and
                        join['native']['label'] == item['native']['label']]) != 1):
                    raise ValueError('Compiler-tooling notices differ from their original configured native supplier')
        expected = closure.render({**inventory, 'components': inventory['components'] + tooling})
    else:
        raise ValueError('Unsupported or incomplete selected notice provider')
    if not isinstance(pending, list) or any(not isinstance(value, str) for value in pending) or len(set(pending)) != len(pending):
        raise ValueError('Invalid notice provider pending inventory')
    if notices != expected:
        raise ValueError('Notice output differs from its original selected inventory')
    return pending


def assemble(value, inputs):
    if not isinstance(value, dict) or set(value) != {'server', 'server_context', 'migrations', 'web', 'build_id', 'attributions'} or not isinstance(value['attributions'], list):
        raise ValueError('Exact declared deployment attribution inputs required')
    roots = {role: deployment.descriptor(value[role]) for role in REQUIRED}
    root_paths = {role: inputs.presentation(root['input']) for role, root in roots.items()}
    server, size, _ = inputs.file(inputs.presentation(roots['server']['input']), executable=True)
    entries = {'server/server': ({'mode': '0555', 'label': roots['server']['label']}, server, size)}
    entries.update(inputs.tree(roots['migrations'], 'migrations'))
    entries.update(inputs.tree(roots['web'], 'web'))
    deployment.validate_service(entries, value['build_id'], inputs)
    artifacts = artifact_facts(entries)
    context, _ = capture(value['server_context'], inputs)
    settings = pack.load_json(context)
    if value['server_context']['label'] != roots['server']['label'] or settings.get('producer') != roots['server']['label'] or settings.get('frontend_build_id') != value['build_id']:
        raise ValueError('Deployment notices differ from server configuration')
    expected_pairs = {(role, scope) for role, scopes in REQUIRED.items() for scope in scopes}
    providers, seen = [], set()
    for item in value['attributions']:
        if not isinstance(item, dict) or set(item) != {'scope', 'producer', 'artifact', 'configuration', 'source_inventory', 'inventory', 'notices'}:
            raise ValueError('Invalid declared selected notice provider')
        artifact = deployment.descriptor(item['artifact'])
        artifact_path = inputs.presentation(artifact['input'])
        roles = [role for role, root in roots.items() if artifact['label'] == root['label'] and artifact_path == root_paths[role]]
        if len(roles) != 1 or item['producer'] != roots[roles[0]]['label']:
            raise ValueError('Selected notice provider belongs to another artifact producer')
        role, scope = roles[0], item['scope']
        pair = (role, scope)
        if pair not in expected_pairs or pair in seen:
            raise ValueError('Missing, duplicate or extra configured notice scope')
        seen.add(pair)
        captures = {name: capture(item[name], inputs) for name in ('configuration', 'source_inventory', 'inventory', 'notices')}
        compiler_context = captures['configuration'][0]
        compiler_settings = pack.load_json(compiler_context)
        if compiler_settings.get('producer') != item['producer'] or compiler_settings.get('frontend_build_id') != value['build_id'] or (role == 'server' and compiler_context != context):
            raise ValueError('Notice provider differs from the configured deployment context')
        inventory = pack.load_json(captures['inventory'][0])
        selected = components(inventory)
        pending = validate_scope(scope, item['producer'], inventory, compiler_context, captures['source_inventory'][0], captures['notices'][0], artifacts[role])
        if any(gap not in REQUIRED[role] or gap == scope for gap in pending):
            raise ValueError('Notice provider retains an unresolved attribution obligation')
        providers.append({'role': role, 'scope': scope, 'producer': item['producer'],
                          'inputs': {name: fact for name, (_, fact) in captures.items()},
                          'pending_scopes': pending, 'components': selected,
                          'compiler_tooling': compiler_tooling(inventory) if scope == 'first-party' else []})
    if seen != expected_pairs:
        raise ValueError('Deployment requires its complete selected notice scope inventory')
    # Every retained pending scope resolves to another exact provider, never to a boolean.
    text = render(providers)
    inputs.verify()
    inventory = {'kind': 'deployment-selected-attribution', 'build_id': value['build_id'],
                 'required_scopes': REQUIRED, 'artifacts': artifacts,
                 'providers': sorted(providers, key=lambda item: (item['role'], item['scope'])),
                 'notices': {'name': 'NOTICES.txt', 'size': len(text), 'sha256': digest(text)}}
    return inventory, text


def bind(value, entries, build_id, context_digest, inputs):
    if not isinstance(value, dict) or set(value) != {'inventory', 'notices'}:
        raise ValueError('Deployment requires typed complete external NOTICES')
    captured, facts = {}, {}
    for name in ('inventory', 'notices'):
        captured[name], facts[name] = capture(value[name], inputs)
    inventory = pack.load_json(captured['inventory'])
    if not isinstance(inventory, dict) or set(inventory) != {'kind', 'build_id', 'required_scopes', 'artifacts', 'providers', 'notices'} or inventory['kind'] != 'deployment-selected-attribution' or inventory['build_id'] != build_id or inventory['required_scopes'] != REQUIRED or pack.canonical(inventory['artifacts']) != pack.canonical(artifact_facts(entries)):
        raise ValueError('External NOTICES belongs to another deployment artifact inventory')
    pairs = []
    if not isinstance(inventory['providers'], list):
        raise ValueError('Invalid external notice provider inventory')
    for item in inventory['providers']:
        if not isinstance(item, dict) or set(item) != {'role', 'scope', 'producer', 'inputs', 'pending_scopes', 'components', 'compiler_tooling'}:
            raise ValueError('Invalid external notice provider inventory')
        role, scope = item['role'], item['scope']
        pairs.append((role, scope))
        if role not in REQUIRED or scope not in REQUIRED[role] or not isinstance(item['pending_scopes'], list) or any(not isinstance(gap, str) or gap not in REQUIRED[role] or gap == scope for gap in item['pending_scopes']) or len(set(item['pending_scopes'])) != len(item['pending_scopes']) or item['producer'] != inventory['artifacts'][role][0]['label']:
            raise ValueError('Incomplete or foreign external notice provider')
        components(item)
        compiler_tooling(item)
        if scope != 'first-party' and item['compiler_tooling']:
            raise ValueError('Compiler-tooling components have a foreign source partition')
        if set(item['inputs']) != {'configuration', 'source_inventory', 'inventory', 'notices'}:
            raise ValueError('Incomplete external notice context evidence')
        for fact in item['inputs'].values():
            if not isinstance(fact, dict) or set(fact) != {'label', 'size', 'sha256'} or not closure.label(producer_label(fact['label'])) or type(fact['size']) is not int or fact['size'] <= 0 or not isinstance(fact['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', fact['sha256']):
                raise ValueError('Invalid external notice input evidence')
        if role == 'server' and item['inputs']['configuration']['sha256'] != context_digest:
            raise ValueError('External notice configuration differs from deployed server')
    if sorted(pairs) != sorted((role, scope) for role, scopes in REQUIRED.items() for scope in scopes):
        raise ValueError('External NOTICES omits, duplicates or adds a required scope')
    notice = inventory['notices']
    if pack.canonical(notice) != pack.canonical({'name': 'NOTICES.txt', 'size': len(captured['notices']), 'sha256': digest(captured['notices'])}) or render(inventory['providers']) != captured['notices']:
        raise ValueError('External NOTICES bytes differ from selected attribution')
    return {'required_name': 'NOTICES.txt', 'scope': 'complete deployment attribution',
            'inventory': facts['inventory'], 'text': facts['notices'],
            'providers': [{'role': item['role'], 'scope': item['scope'], 'producer': item['producer'], 'inputs': item['inputs']}
                          for item in inventory['providers']]}


def produce(value, inventory_path, notices_path):
    owned = deployment.DeclaredInputs()
    try:
        inventory, text = assemble(value, owned)
        with pack.ArchiveOutputs(inventory_path, notices_path) as outputs:
            owned.verify()
            for index, data in enumerate((pack.canonical(inventory), text)):
                with outputs.open(index) as stream:
                    stream.write(data)
                outputs.verify()
            owned.verify()
            outputs.verify()
    finally:
        owned.close()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('Expected configured notice inputs, inventory and NOTICES.txt')
    produce(pack.load_json(Path(sys.argv[1]).read_bytes()), sys.argv[2], sys.argv[3])
