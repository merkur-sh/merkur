"""Aggregate exact configured shipping closure; never treat partial text as admission."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tarfile


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load('native-release')
pack, deployment, notices = native.pack, native.deployment, native.notices


def artifact(value, owned):
    value = deployment.descriptor(value)
    pinned, size, sha256 = owned.file(owned.presentation(value['input']))
    with pinned.open('rb') as stream:
        sha512 = hashlib.file_digest(stream, 'sha512').hexdigest()
    return pinned, {'size': size, 'sha256': sha256, 'sha512': sha512, 'label': value['label']}


def packages(values, owned):
    expected = {'merkur-daemon-' + platform for platform in native.PLATFORMS}
    expected |= {'verify-' + platform for platform in ('linux-arm64', 'linux-x64')}
    selected, seen = [], set()
    for value in values:
        if not isinstance(value, dict) or set(value) != {'platform', 'name', 'artifact', 'inventory'} or value['name'] not in expected or value['name'] in seen or value['platform'] not in native.PLATFORMS or not value['name'].endswith(value['platform']):
            raise ValueError('Global notices require the exact six configured native producers')
        seen.add(value['name'])
        expected_label = '//tools/bazel/packaging:' + value['name']
        if any(notices.producer_label(value[key]['label']) != expected_label for key in ('artifact', 'inventory')):
            raise ValueError('Global native notices have foreign package action custody')
        pinned, facts = artifact(value['artifact'], owned)
        inventory_bytes, _ = native.capture(value['inventory'], owned)
        inventory = pack.load_json(inventory_bytes)
        kind = 'daemon' if value['name'].startswith('merkur-daemon-') else value['name'].split('-', 1)[0]
        roles = native.DAEMON_MEMBERS if kind == 'daemon' else {kind}
        key = 'archive' if kind == 'daemon' else 'artifact'
        if set(inventory) != {key, 'files', 'platform', 'profile', 'licenses', 'attributions'} or inventory[key] != {'size': facts['size'], 'sha512': facts['sha512']} or inventory['platform'] != value['platform'] or inventory['profile'] != 'release' or not inventory['licenses']:
            raise ValueError('Native package inventory differs from actual release artifact bytes')
        files = inventory['files']
        if not isinstance(files, list) or len(files) != len(roles) or {item.get('path') for item in files} != roles:
            # Raw file facts intentionally retain the original executable basename.
            if kind == 'daemon' or len(files) != 1 or files[0].get('path') != kind + '.bin':
                raise ValueError('Native package inventory differs from original executable layout')
        by_name = {item['path']: item for item in files}
        if kind == 'daemon':
            with pinned.open('rb') as source, tarfile.open(fileobj=source, mode='r:gz') as archive:
                members = archive.getmembers()
                if len(members) != len(roles) or {member.name for member in members} != roles:
                    raise ValueError('Native daemon archive differs from original four-member layout')
                for member in members:
                    if not member.isfile() or member.mode != 0o555:
                        raise ValueError('Native daemon contains foreign member types or modes')
                    with archive.extractfile(member) as stream:
                        header = stream.read(64)
                        native.native(header, value['platform'])
                        digest = hashlib.sha512(header)
                        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                            digest.update(chunk)
                    record = by_name[member.name]
                    if record.get('size') != member.size or record.get('sha512') != digest.hexdigest() or record.get('mode') != '0555':
                        raise ValueError('Native daemon member differs from original signing bytes')
        else:
            native.native(owned.read(pinned, 64), value['platform'])
            record = files[0]
            if record.get('size') != facts['size'] or record.get('sha256') != facts['sha256'] or record.get('mode') != '0555':
                raise ValueError('Raw native inventory differs from its original executable bytes')
        required = {(role, scope) for role in roles for scope in
                    (('first-party', 'npm', 'wasm', 'embedded-runtime') if role in {'merkur', 'verify'} else ('rust',))}
        providers = inventory['attributions']
        if not isinstance(providers, list) or len(providers) != len(required) or {(item.get('role'), item.get('scope')) for item in providers} != required:
            raise ValueError('Native package omitted original selected attribution scopes')
        for item in providers:
            original = by_name[item['role']] if kind == 'daemon' else files[0]
            if notices.producer_label(item['producer']) != notices.producer_label(original.get('label')):
                raise ValueError('Native attribution differs from its original executable producer')
            if any((item['role'], scope) not in required or scope == item['scope'] for scope in item['pending_scopes']):
                raise ValueError('Global native attribution retains unresolved scopes')
            notices.components(item)
            selected.append({**item, 'platform': value['platform'], 'release_artifact': value['name']})
    if seen != expected:
        raise ValueError('Global notices omit one or more exact native platforms')
    return selected


def service(value, owned):
    if not isinstance(value, dict) or set(value) != {'inventory', 'notices', 'producers'} or set(value['producers']) != set(notices.REQUIRED):
        raise ValueError('Global notices require original typed deployment producers')
    inventory_bytes, _ = native.capture(value['inventory'], owned)
    inventory = pack.load_json(inventory_bytes)
    producers = value['producers']
    pinned, size, _ = owned.file(owned.presentation(deployment.descriptor(producers['server'])['input']), executable=True)
    entries = {'server/server': ({'mode': '0555', 'label': producers['server']['label']}, pinned, size)}
    entries.update(owned.tree(producers['migrations'], 'migrations'))
    entries.update(owned.tree(producers['web'], 'web'))
    build_id = inventory.get('build_id')
    deployment.validate_service(entries, build_id, owned)
    server = next((item for item in inventory.get('providers', []) if item.get('role') == 'server'), None)
    if server is None:
        raise ValueError('Global deployment notices omit selected server configuration')
    notices.bind({key: value[key] for key in ('inventory', 'notices')}, entries, build_id, server['inputs']['configuration']['sha256'], owned)
    return [{**item, 'platform': 'linux-x64', 'release_artifact': 'deployment'} for item in inventory['providers']]


def images(values, owned):
    selected, seen = [], set()
    for item in values:
        if not isinstance(item, dict) or set(item) != {'artifact', 'producer', 'configuration', 'source_inventory', 'inventory', 'notices'}:
            raise ValueError('Global image attribution requires original selected File inputs')
        name = Path(item['artifact']['input']).name
        if name not in ('edge-image.tar.gz', 'stun-image.tar.gz') or name in seen or notices.producer_label(item['producer']) != notices.producer_label(item['artifact']['label']):
            raise ValueError('Global images omit, duplicate or replace original image custody')
        seen.add(name)
        _, facts = artifact(item['artifact'], owned)
        captures = {key: native.capture(item[key], owned) for key in ('configuration', 'source_inventory', 'inventory', 'notices')}
        inventory = pack.load_json(captures['inventory'][0])
        expected = [{'path': name, 'label': item['producer'], 'mode': '0444', 'size': facts['size'], 'sha256': facts['sha256']}]
        if inventory.get('kind') != 'selected-container-image-attribution' or notices.producer_label(inventory.get('producer')) != notices.producer_label(item['producer']) or inventory.get('configuration') != hashlib.sha256(captures['configuration'][0]).hexdigest() or inventory.get('source_digest') != hashlib.sha256(captures['source_inventory'][0]).hexdigest() or inventory.get('pending_scopes') != [] or pack.canonical(inventory.get('artifacts')) != pack.canonical(expected):
            raise ValueError('Global image notices differ from actual configured image bytes')
        notices.components(inventory)
        if notices.closure.render(inventory) != captures['notices'][0]:
            raise ValueError('Global image notices differ from actual selected component text')
        selected.append({'role': name.split('-', 1)[0], 'scope': 'container-image', 'producer': item['producer'],
                         'components': inventory['components'], 'pending_scopes': [], 'platform': 'linux-x64',
                         'release_artifact': name, 'inputs': {key: fact for key, (_, fact) in captures.items()}})
    if seen != {'edge-image.tar.gz', 'stun-image.tar.gz'}:
        raise ValueError('Global notices require both original configured service images')
    return selected


def render(providers):
    sections = []
    for item in sorted(providers, key=lambda item: (item['release_artifact'], item['platform'], item['role'], item['scope'])):
        identity = '/'.join(item[key] for key in ('release_artifact', 'platform', 'role', 'scope'))
        original = {'producer': item['producer'], 'configuration': item['inputs']['configuration']['sha256'],
                    'source_digest': item['inputs']['source_inventory']['sha256'], 'components': item['components']}
        sections.append((identity + '\n').encode() + notices.closure.render(original) + b'\n')
    return b'MERKUR RELEASE LICENSES AND NOTICES\n\n' + b''.join(sections)


def produce(value, inventory_path, text_path):
    if not isinstance(value, dict) or set(value) != {'packages', 'deployment', 'images'} or not isinstance(value['packages'], list) or not isinstance(value['images'], list):
        raise ValueError('Global notices require exact configured release closure')
    owned = deployment.DeclaredInputs()
    try:
        providers = packages(value['packages'], owned) + service(value['deployment'], owned) + images(value['images'], owned)
        providers.sort(key=lambda item: (item['release_artifact'], item['platform'], item['role'], item['scope']))
        text = render(providers)
        inventory = {'kind': 'complete-release-selected-attribution', 'providers': providers,
                     'notices': {'name': 'NOTICES.txt', 'sha256': hashlib.sha256(text).hexdigest(), 'size': len(text)}}
        with pack.ArchiveOutputs(inventory_path, text_path) as outputs:
            for index, content in enumerate((pack.canonical(inventory), text)):
                with outputs.open(index) as stream:
                    stream.write(content)
            owned.verify()
            outputs.verify()
    finally:
        owned.close()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('Expected global notice source, inventory and NOTICES.txt')
    produce(pack.load_json(Path(sys.argv[1]).read_bytes()), *sys.argv[2:])
