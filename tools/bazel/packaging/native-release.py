"""Package exact native consumer bytes with original selected attribution inputs."""
import hashlib
import importlib.util
import os
from pathlib import Path
import struct
import sys


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pack = load('pack')
deployment = load('deployment-pack')
notices = load('deployment-notices')

PLATFORMS = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
}
DAEMON_MEMBERS = {'merkur', 'merkur-dataplane', 'merkur-image-worker', 'merkur-tui'}


def native(header, platform):
    if platform not in PLATFORMS:
        raise ValueError('Unsupported native release platform')
    if platform.startswith('linux-'):
        machine = 62 if platform == 'linux-x64' else 183
        if (len(header) < 64 or header[:7] != b'\x7fELF\x02\x01\x01'
                or struct.unpack_from('<H', header, 18)[0] != machine
                or struct.unpack_from('<H', header, 16)[0] not in (2, 3)
                or struct.unpack_from('<I', header, 20)[0] != 1
                or struct.unpack_from('<H', header, 52)[0] != 64):
            raise ValueError('Native release executable has foreign ELF architecture')
    else:
        machine = 0x01000007 if platform == 'darwin-x64' else 0x0100000c
        if (len(header) < 32 or header[:4] != b'\xcf\xfa\xed\xfe'
                or struct.unpack_from('<I', header, 4)[0] != machine
                or struct.unpack_from('<I', header, 12)[0] != 2):
            raise ValueError('Native release executable has foreign Mach-O architecture')


def capture(value, owned):
    value = deployment.descriptor(value)
    pinned, size, digest = owned.file(owned.presentation(value['input']))
    return owned.read(pinned), {'label': value['label'], 'size': size, 'sha256': digest}


def files(value, owned):
    expected = DAEMON_MEMBERS if value['kind'] == 'daemon' else {value['kind']}
    if (value['kind'] not in {'daemon', 'verify'}
            or any(not isinstance(item, str) for item in value['expected'])
            or len(set(value['expected'])) != len(value['expected'])
            or set(value['expected']) != expected):
        raise ValueError('Native release consumer inventory differs')
    if value['kind'] != 'daemon' and not value['platform'].startswith('linux-'):
        raise ValueError('Raw release executable requires native Linux')
    entries = {}
    for item in value['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'artifact_path', 'input', 'label', 'mode'}:
            raise ValueError('Exact native declared member required')
        name = pack.destination(item['path'])
        deployment.descriptor({'input': item['input'], 'label': item['label']})
        artifact_path = pack.destination(item['artifact_path'])
        if '/' in artifact_path or artifact_path != Path(item['input']).name:
            raise ValueError('Native attribution requires the original executable basename')
        if name not in expected or name in entries or item['mode'] != '0555':
            raise ValueError('Native release members require exact normalized executable modes')
        pinned, size, _ = owned.file(owned.presentation(item['input']), executable=True)
        native(owned.read(pinned, 64), value['platform'])
        entries[name] = ({'mode': '0555', 'label': item['label'], 'artifact_path': artifact_path}, pinned, size)
    if set(entries) != expected:
        raise ValueError('Native release is missing original executable members')
    return entries


def facts(entries):
    result = {}
    for name, (item, pinned, size) in sorted(entries.items()):
        with pinned.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        result[name] = {'path': item['artifact_path'], 'label': item['label'], 'mode': '0555',
                        'size': size, 'sha256': digest}
    return result


def attribution(value, members, owned):
    required = {(role, scope) for role in members
                for scope in (('first-party', 'npm', 'wasm', 'embedded-runtime')
                              if role in {'merkur', 'verify'} else ('rust',))}
    selected = {}
    for provider in value['attributions']:
        if not isinstance(provider, dict) or set(provider) != {
            'role', 'scope', 'producer', 'configuration', 'source_inventory', 'inventory', 'notices',
        }:
            raise ValueError('Exact original selected native attribution inputs required')
        pair = provider['role'], provider['scope']
        if pair not in required or pair in selected:
            raise ValueError('Native attribution has missing, duplicate or unsupported scope')
        member = members[pair[0]]
        if notices.producer_label(provider['producer']) != notices.producer_label(member['label']):
            raise ValueError('Native attribution belongs to another executable producer')
        configuration, configuration_fact = capture(provider['configuration'], owned)
        source, source_fact = capture(provider['source_inventory'], owned)
        inventory_bytes, inventory_fact = capture(provider['inventory'], owned)
        text, text_fact = capture(provider['notices'], owned)
        inventory = pack.load_json(inventory_bytes)
        artifacts = [member]
        if pair[1] == 'rust':
            # Descriptor-only intermediates do not establish compiled File custody.
            # The selected publisher must provide the same ordinary artifact facts
            # used by the authored/native attribution consumers.
            if (inventory.get('kind') != 'selected-native-rust-attribution'
                    or notices.producer_label(inventory.get('producer')) != notices.producer_label(provider['producer'])
                    or inventory.get('configuration') != hashlib.sha256(configuration).hexdigest()
                    or inventory.get('source_digest') != hashlib.sha256(source).hexdigest()
                    or inventory.get('target') != PLATFORMS[value['platform']]
                    or inventory.get('profile') != 'release'
                    or inventory.get('pending_scopes') != []
                    or pack.canonical(inventory.get('artifacts')) != pack.canonical(artifacts)):
                raise ValueError('Native Rust attribution lacks original compiled release custody')
            if text != notices.closure.render(inventory):
                raise ValueError('Native Rust notice text differs from its selected inventory')
            pending = []
        else:
            pending = notices.validate_scope(pair[1], provider['producer'], inventory,
                                             configuration, source, text, artifacts)
        notices.components(inventory)
        selected[pair] = {'role': pair[0], 'scope': pair[1], 'producer': provider['producer'],
                          'pending_scopes': pending, 'components': inventory['components'],
                          'inputs': {'configuration': configuration_fact, 'source_inventory': source_fact,
                                     'inventory': inventory_fact, 'notices': text_fact}}
    if set(selected) != required:
        raise ValueError('Native release attribution is missing exact original selected providers')
    for (role, scope), provider in selected.items():
        for pending in provider['pending_scopes']:
            if (role, pending) not in required or (role, pending) not in selected or pending == scope:
                raise ValueError('Native release attribution retains an unresolved original scope: ' + pending)
    return [selected[pair] for pair in sorted(selected)]


def produce(value, artifact, signing):
    if not isinstance(value, dict) or set(value) != {
        'platform', 'kind', 'files', 'expected', 'licenses', 'attributions',
    } or not isinstance(value['files'], list) or not isinstance(value['expected'], list) or not isinstance(value['attributions'], list) or value['platform'] not in PLATFORMS:
        raise ValueError('Exact native unsigned action inputs required')
    owned = deployment.DeclaredInputs()
    try:
        entries = files(value, owned)
        members = facts(entries)
        providers = attribution(value, members, owned)
        if not isinstance(value['licenses'], list) or not value['licenses']:
            raise ValueError('Native release requires original external license Files')
        licenses = []
        labels = set()
        for license_input in value['licenses']:
            text, fact = capture(license_input, owned)
            if fact['label'] in labels or not text.decode('utf8').strip():
                raise ValueError('Native external license evidence is empty or repeated')
            labels.add(fact['label'])
            licenses.append(fact)
        fields = {'platform': value['platform'], 'profile': 'release',
                  'licenses': sorted(licenses, key=lambda item: item['label']), 'attributions': providers}
        owned.verify()
        if value['kind'] == 'daemon':
            pack.stream_archive(entries, artifact, signing, fields, owned.verify)
        else:
            pinned = entries[value['kind']][1]
            with pack.ArchiveOutputs(artifact, signing) as outputs:
                digest = hashlib.sha512()
                with pinned.open('rb') as source, outputs.open(0) as destination:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        destination.write(chunk)
                        digest.update(chunk)
                    os.fchmod(destination.fileno(), 0o555)
                with outputs.open(1) as destination:
                    destination.write(pack.canonical({'artifact': {'sha512': digest.hexdigest(), 'size': entries[value['kind']][2]},
                                                       'files': [members[value['kind']]], **fields}))
                owned.verify()
                outputs.verify()
    finally:
        owned.close()


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise ValueError('Expected declared native specification, artifact and signing inputs')
    produce(pack.load_json(Path(sys.argv[1]).read_bytes()), sys.argv[2], sys.argv[3])
