"""Emit deterministic original edge/STUN images from declared immutable inputs."""
import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load('native-release')
pack, deployment, notices = native.pack, native.deployment, native.notices
BASE_INDEX = 'sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171'
MEDIA_CONFIG = 'application/vnd.oci.image.config.v1+json'
MEDIA_LAYER = 'application/vnd.oci.image.layer.v1.tar'
MEDIA_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
MEDIA_INDEX = 'application/vnd.oci.image.index.v1+json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def captured(value, owned):
    return native.capture(value, owned)


def descriptor(data, media):
    return {'mediaType': media, 'size': len(data), 'digest': 'sha256:' + sha(data)}


def member_name(value):
    while value.startswith('./'):
        value = value[2:]
    return notices.closure.inputs.relative(value.rstrip('/'))


def rootfs_accounts(pinned, require_certificates=False):
    accounts = {}
    certificate_bundle = False
    with pinned.open('rb') as stream, tarfile.open(fileobj=stream, mode='r:') as rootfs:
        seen = set()
        for member in rootfs:
            if member.name in ('.', './') and member.isdir():
                continue
            name = member_name(member.name)
            if name in seen:
                raise ValueError('Composed rootfs has repeated ordinary paths')
            seen.add(name)
            if name in ('etc/passwd', 'etc/group', 'etc/shadow', 'etc/gshadow'):
                if not member.isfile():
                    raise ValueError('Original rootfs account files must be ordinary files')
                accounts[name] = (rootfs.extractfile(member).read(), member.mode, member.uid, member.gid)
            if name == 'etc/ssl/certs/ca-certificates.crt':
                if not member.isfile():
                    raise ValueError('Declared TLS trust bundle must be an ordinary file')
                certificate_bundle = b'-----BEGIN CERTIFICATE-----' in rootfs.extractfile(member).read()
    if require_certificates and not certificate_bundle:
        raise ValueError('Edge runtime lacks the original configured certificate bundle')
    if set(accounts) != {'etc/passwd', 'etc/group', 'etc/shadow', 'etc/gshadow'}:
        raise ValueError('Original rootfs lacks exact account database inputs')
    for name, (content, _mode, _uid, _gid) in accounts.items():
        rows = [row.split(':') for row in content.decode('utf8').splitlines()]
        if any(row[0] == 'merkur' or (name in ('etc/passwd', 'etc/group') and len(row) > 2 and row[2] == '10001') for row in rows):
            raise ValueError('Original rootfs already owns the required service identity')
    additions = {'etc/passwd': 'merkur:x:10001:10001::/nonexistent:/usr/sbin/nologin\n',
                 'etc/group': 'merkur:x:10001:\n', 'etc/shadow': 'merkur:!:0:0:99999:7:::\n',
                 'etc/gshadow': 'merkur:!::\n'}
    return {name: (content.rstrip(b'\n') + b'\n' + additions[name].encode(), mode, uid, gid)
            for name, (content, mode, uid, gid) in accounts.items()}


def runtime(value, owned):
    keys = {'rootfs', 'base_config', 'base_index', 'base_manifest', 'attribution', 'licenses', 'inventory', 'context'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('Exact immutable Debian rootfs provider inputs required')
    blobs = {name: captured(value[name], owned)[0] for name in keys - {'rootfs', 'licenses'}}
    index = pack.load_json(blobs['base_index'])
    manifest = pack.load_json(blobs['base_manifest'])
    config = pack.load_json(blobs['base_config'])
    if 'sha256:' + sha(blobs['base_index']) != BASE_INDEX:
        raise ValueError('Container base differs from original pinned Bookworm index')
    candidates = [item for item in index.get('manifests', [])
                  if item.get('platform', {}).get('os') == 'linux' and item.get('platform', {}).get('architecture') == 'amd64']
    if len(candidates) != 1 or candidates[0].get('digest') != 'sha256:' + sha(blobs['base_manifest']) or candidates[0].get('size') != len(blobs['base_manifest']):
        raise ValueError('Container base lacks its exact original Linux amd64 manifest')
    if manifest.get('config', {}).get('digest') != 'sha256:' + sha(blobs['base_config']) or manifest['config'].get('size') != len(blobs['base_config']) or config.get('os') != 'linux' or config.get('architecture') != 'amd64':
        raise ValueError('Container base configuration has foreign identity or architecture')
    evidence = pack.load_json(blobs['attribution'])
    pinned, size, digest = owned.file(owned.presentation(deployment.descriptor(value['rootfs'])['input']))
    if evidence.get('rootfs') != {'sha256': digest, 'size': size} or evidence.get('inventorySha256') != sha(blobs['inventory']) or evidence.get('contextSha256') != sha(blobs['context']):
        raise ValueError('Debian attribution differs from composed rootfs or original inputs')
    base = evidence.get('base', {})
    if base.get('indexDigest') != BASE_INDEX or base.get('manifestDigest') != 'sha256:' + sha(blobs['base_manifest']) or base.get('configDigest') != 'sha256:' + sha(blobs['base_config']):
        raise ValueError('Debian attribution differs from original pinned base bytes')
    if len(manifest.get('layers', [])) != 1 or base.get('layerDigest') != manifest['layers'][0].get('digest'):
        raise ValueError('Debian attribution differs from original base layer identity')
    original_inputs = pack.load_json(blobs['inventory'])
    if not isinstance(original_inputs, list):
        raise ValueError('Debian runtime lacks original archive File inventory')
    licenses = owned.tree(value['licenses'], 'licenses', path_validator=notices.closure.inputs.relative)
    components, packages = [], set()
    for item in evidence.get('packages', []):
        if not isinstance(item, dict) or any(not isinstance(item.get(key), str) or not item[key] for key in ('package', 'version', 'architecture')):
            raise ValueError('Debian attribution lacks actual package identities')
        identity = item['package'], item['version'], item['architecture']
        if identity in packages or item['architecture'] not in ('amd64', 'all'):
            raise ValueError('Debian runtime has repeated or foreign package identity')
        packages.add(identity)
        license_input = item.get('license', {})
        original_archive = item.get('archive')
        if not isinstance(original_archive, dict) or original_archive not in original_inputs or license_input.get('originArchive') != original_archive.get('logical'):
            raise ValueError('Debian copyright belongs to another original input archive')
        notices.closure.inputs.relative(license_input.get('originMember'))
        path = notices.closure.inputs.relative(license_input.get('path'))
        if path != item['package'] + '/copyright' or 'licenses/' + path not in licenses:
            raise ValueError('Debian runtime lacks original package copyright bytes')
        text = owned.read(licenses['licenses/' + path][1])
        if license_input.get('sha256') != sha(text) or license_input.get('size') != len(text) or not license_input.get('originArchive') or not license_input.get('originMember'):
            raise ValueError('Debian runtime license differs from original archive member')
        components.append({'id': 'debian:bookworm/' + '/'.join(identity), 'name': item['package'],
                           'version': item['version'], 'source': item.get('source'), 'repository': None,
                           'license': None, 'license_file': path, 'source_label': value['rootfs']['label'],
                           'texts': [{'path': path, 'size': len(text), 'sha256': sha(text), 'text': text.decode('utf8')}]})
    if not components or {path for path in licenses} != {'licenses/' + component['license_file'] for component in components}:
        raise ValueError('Debian attribution is missing or adds unrelated copyright inputs')
    return pinned, size, digest, config, components, {item[0] for item in packages}, blobs


def layer(kind, executable, entrypoint, accounts, output):
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        entries = dict(accounts)
        entries['usr/local/bin/merkur-' + kind] = (executable, 0o555, 0, 0)
        entries['usr/local/bin/merkur-' + kind + '-entrypoint'] = (entrypoint, 0o555, 0, 0)
        for name, (data, mode, uid, gid) in sorted(entries.items()):
            header = tarfile.TarInfo(name)
            header.mode, header.uid, header.gid, header.mtime = mode, uid, gid, 0
            header.size = len(data)
            archive.addfile(header, io.BytesIO(data))
        if kind == 'edge':
            header = tarfile.TarInfo('data')
            header.type, header.mode, header.uid, header.gid, header.mtime = tarfile.DIRTYPE, 0o700, 10001, 10001, 0
            archive.addfile(header)
    output.flush()
    output.seek(0)


def image_configuration(base, kind, diff_ids):
    settings = dict(base.get('config', {}))
    environment = {}
    for value in settings.get('Env', []):
        key, separator, item = value.partition('=')
        if not separator or key in environment:
            raise ValueError('Original base has ambiguous environment settings')
        environment[key] = item
    environment['HOME'] = '/nonexistent'
    if kind == 'edge':
        environment.update(MERKUR_EDGE_PORT='4433', MERKUR_EDGE_IDENTITY_DIR='/data/identity', RUST_LOG='info',
                           SSL_CERT_FILE='/etc/ssl/certs/ca-certificates.crt')
        settings['ExposedPorts'] = {'4433/udp': {}}
    settings.update(User='', Env=[key + '=' + item for key, item in sorted(environment.items())],
                    Entrypoint=['/usr/local/bin/merkur-' + kind + '-entrypoint'], Cmd=['/usr/local/bin/merkur-' + kind])
    return {'architecture': 'amd64', 'os': 'linux', 'config': settings,
            'rootfs': {'type': 'layers', 'diff_ids': diff_ids}}


def produce(value, spec_bytes, artifact, signing, attribution_path, notice_path):
    if not isinstance(value, dict) or set(value) != {'kind', 'producer', 'runtime', 'executable', 'entrypoint', 'rust'} or value['kind'] not in ('edge', 'stun'):
        raise ValueError('Exact original unsigned image contract required')
    kind = value['kind']
    owned = deployment.DeclaredInputs()
    try:
        rootfs, rootfs_size, rootfs_digest, base, components, packages, runtime_blobs = runtime(value['runtime'], owned)
        context = pack.load_json(runtime_blobs['context'])
        if context.get('consumer') != kind or context.get('distribution') != 'bookworm' or context.get('target') != 'linux-amd64' or context.get('baseIndexDigest') != BASE_INDEX or context.get('inventorySha256') != sha(runtime_blobs['inventory']):
            raise ValueError('Image rootfs belongs to another original runtime profile')
        required = {'util-linux', 'iproute2'} | ({'ca-certificates'} if kind == 'edge' else set())
        if not required <= packages:
            raise ValueError('Original requested Debian runtime package closure is missing')
        executable, executable_fact = captured(value['executable'], owned)
        native.native(executable[:64], 'linux-x64')
        member = {'path': Path(value['executable']['input']).name, 'label': value['executable']['label'],
                  'mode': '0555', **{key: executable_fact[key] for key in ('size', 'sha256')}}
        selected = native.attribution({'platform': 'linux-x64', 'attributions': [value['rust']]}, {kind: member}, owned)
        components += selected[0]['components']
        entrypoint, _ = captured(value['entrypoint'], owned)
        if not entrypoint.startswith(b'#!/bin/sh\n'):
            raise ValueError('Original image entrypoint must be its declared shell script')
        accounts = rootfs_accounts(rootfs, require_certificates=kind == 'edge')
        with tempfile.TemporaryFile() as app_layer:
            layer(kind, executable, entrypoint, accounts, app_layer)
            app_digest = hashlib.file_digest(app_layer, 'sha256').hexdigest()
            app_layer.seek(0)
            app_size = app_layer.seek(0, 2)
            app_layer.seek(0)
            config = pack.canonical(image_configuration(base, kind, ['sha256:' + rootfs_digest, 'sha256:' + app_digest]))
            manifest = pack.canonical({'schemaVersion': 2, 'mediaType': MEDIA_MANIFEST,
                'config': descriptor(config, MEDIA_CONFIG),
                'layers': [{'mediaType': MEDIA_LAYER, 'size': rootfs_size, 'digest': 'sha256:' + rootfs_digest},
                           {'mediaType': MEDIA_LAYER, 'size': app_size, 'digest': 'sha256:' + app_digest}]})
            manifest_descriptor = descriptor(manifest, MEDIA_MANIFEST)
            manifest_descriptor['platform'] = {'os': 'linux', 'architecture': 'amd64'}
            manifest_descriptor['annotations'] = {'org.opencontainers.image.ref.name': 'merkur-' + kind + ':release'}
            index = pack.canonical({'schemaVersion': 2, 'mediaType': MEDIA_INDEX, 'manifests': [manifest_descriptor]})
            config_path = 'blobs/sha256/' + sha(config)
            layers = ['blobs/sha256/' + rootfs_digest, 'blobs/sha256/' + app_digest]
            blobs = {'oci-layout': pack.canonical({'imageLayoutVersion': '1.0.0'}), 'index.json': index,
                     'manifest.json': pack.canonical([{'Config': config_path, 'RepoTags': ['merkur-' + kind + ':release'], 'Layers': layers}]),
                     config_path: config, 'blobs/sha256/' + sha(manifest): manifest}
            with pack.ArchiveOutputs(artifact, signing) as outputs, pack.ArchiveOutputs(attribution_path, notice_path) as notice_outputs:
                with outputs.open(0) as output:
                    with gzip.GzipFile(filename='', mode='wb', fileobj=output, compresslevel=9, mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                        for name in sorted([*blobs, *layers]):
                            header = tarfile.TarInfo(name)
                            header.mode, header.uid, header.gid, header.mtime = 0o444, 0, 0, 0
                            if name in blobs:
                                header.size = len(blobs[name])
                                archive.addfile(header, io.BytesIO(blobs[name]))
                            elif name == layers[0]:
                                header.size = rootfs_size
                                with rootfs.open('rb') as stream:
                                    archive.addfile(header, stream)
                            else:
                                header.size = app_size
                                app_layer.seek(0)
                                archive.addfile(header, app_layer)
                    output.flush()
                    image_size = output.seek(0, 2)
                    output.seek(0)
                    image_sha256 = hashlib.file_digest(output, 'sha256').hexdigest()
                    output.seek(0)
                    image_sha512 = hashlib.file_digest(output, 'sha512').hexdigest()
                inventory = {'kind': 'selected-container-image-attribution', 'producer': value['producer'],
                    'configuration': sha(runtime_blobs['context']), 'source_digest': sha(spec_bytes),
                    'pending_scopes': [], 'components': sorted(components, key=lambda item: item['id']),
                    'artifacts': [{'path': Path(artifact).name, 'label': value['producer'], 'mode': '0444', 'size': image_size, 'sha256': image_sha256}],
                    'base_index': BASE_INDEX, 'image_manifest': descriptor(manifest, MEDIA_MANIFEST)}
                notices.components(inventory)
                with notice_outputs.open(0) as output:
                    output.write(pack.canonical(inventory))
                with notice_outputs.open(1) as output:
                    output.write(notices.closure.render(inventory))
                with outputs.open(1) as output:
                    output.write(pack.canonical({'artifact': {'size': image_size, 'sha512': image_sha512},
                        'manifest': descriptor(manifest, MEDIA_MANIFEST), 'config': descriptor(config, MEDIA_CONFIG),
                        'platform': 'linux-x64', 'base_index': BASE_INDEX,
                        'attribution': {'sha256': sha(pack.canonical(inventory)), 'size': len(pack.canonical(inventory))}}))
                owned.verify()
                outputs.verify()
                notice_outputs.verify()
    finally:
        owned.close()


if __name__ == '__main__':
    if len(sys.argv) != 6:
        raise ValueError('Expected image spec, archive, signing inputs, attribution and notices')
    source = Path(sys.argv[1]).read_bytes()
    produce(pack.load_json(source), source, *sys.argv[2:])
