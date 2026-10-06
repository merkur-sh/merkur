"""Original base metadata with synthetic rootfs/header controls, not native image qualification."""
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


oci = load('oci-release')
fixture = load('native-release-test')


def descriptor(path, label='//fixture:runtime'):
    return {'input': str(path), 'label': label}


def prepare(root, kind='edge', runtime_root=None):
    root.mkdir(exist_ok=True)
    inputs = root / (kind + '-inputs')
    inputs.mkdir()
    case = fixture.NativeReleaseControls()
    case.setUp()
    try:
        native = case.fixture()
        selected = next(item for item in native['attributions'] if item['scope'] == 'rust')
        executable = inputs / ('merkur-' + kind)
        executable.write_bytes(fixture.header('linux-x64') + b'explicit synthetic executable')
        executable.chmod(0o755)
        compiled_label = '//apps/' + kind + ':merkur_' + kind
        configuration = inputs / 'rust.context'
        source = inputs / 'rust.source'
        inventory = inputs / 'rust.inventory'
        text = inputs / 'rust.notices'
        configuration.write_bytes(Path(selected['configuration']['input']).read_bytes())
        source.write_bytes(Path(selected['source_inventory']['input']).read_bytes())
        body = oci.pack.load_json(Path(selected['inventory']['input']).read_bytes())
        body.update(producer=compiled_label, artifacts=[{'path': executable.name, 'label': compiled_label,
            'mode': '0555', 'size': executable.stat().st_size, 'sha256': oci.sha(executable.read_bytes())}])
        inventory.write_bytes(oci.pack.canonical(body))
        text.write_bytes(oci.notices.closure.render(body))
        selected = {'role': kind, 'scope': 'rust', 'producer': compiled_label,
                    **{name: descriptor(path, compiled_label) for name, path in
                       [('configuration', configuration), ('source_inventory', source), ('inventory', inventory), ('notices', text)]}}
    finally:
        case.doCleanups()
    entrypoint = inputs / 'entrypoint.sh'
    entrypoint.write_bytes(b'#!/bin/sh\nexec setpriv --reuid=10001 --regid=10001 --clear-groups "$@"\n')
    base = Path(__file__).with_name('fixtures')
    runtime = {name: descriptor(base / ('bookworm-' + suffix + '.oci'))
               for name, suffix in [('base_index', 'index'), ('base_manifest', 'manifest'), ('base_config', 'config')]}
    if runtime_root is None:
        runtime_root = inputs / 'runtime'
        runtime_root.mkdir()
        rootfs = runtime_root / 'rootfs.tar'
        licenses = runtime_root / 'licenses'
        licenses.mkdir()
        account_files = {'etc/passwd': b'root:x:0:0:root:/root:/bin/bash\n', 'etc/group': b'root:x:0:\n',
                         'etc/shadow': b'root:*:0:0:99999:7:::\n', 'etc/gshadow': b'root:*::\n',
                         'etc/ssl/certs/ca-certificates.crt': b'-----BEGIN CERTIFICATE-----\nexplicit fixture\n-----END CERTIFICATE-----\n'}
        with tarfile.open(rootfs, 'w', format=tarfile.USTAR_FORMAT) as archive:
            for name, content in sorted(account_files.items()):
                member = tarfile.TarInfo(name)
                member.mode, member.size = (0o640 if name in ('etc/shadow', 'etc/gshadow') else 0o644), len(content)
                member.gid = 42 if name in ('etc/shadow', 'etc/gshadow') else 0
                archive.addfile(member, io.BytesIO(content))
        inventory_path, context = runtime_root / 'inventory.json', runtime_root / 'context.json'
        archive_fact = {'logical': 'explicit-fixture', 'mode': 0o644, 'sha256': '0' * 64, 'size': 1}
        inventory_path.write_bytes(oci.pack.canonical([archive_fact]))
        context.write_bytes(oci.pack.canonical({'consumer': kind, 'target': 'linux-amd64', 'distribution': 'bookworm',
            'baseIndexDigest': oci.BASE_INDEX, 'inventorySha256': oci.sha(inventory_path.read_bytes())}))
        packages = []
        for name in ('ca-certificates', 'util-linux', 'iproute2', 'libstdc++6'):
            directory = licenses / name
            directory.mkdir()
            content = ('Original synthetic copyright for ' + name + '\n').encode()
            (directory / 'copyright').write_bytes(content)
            packages.append({'package': name, 'version': '1.0-fixture', 'architecture': 'amd64', 'source': name,
                'archive': archive_fact,
                'license': {'path': name + '/copyright', 'sha256': oci.sha(content), 'size': len(content),
                            'originArchive': 'explicit-fixture', 'originMember': 'usr/share/doc/' + name + '/copyright'}})
        attribution = {'rootfs': {'sha256': oci.sha(rootfs.read_bytes()), 'size': rootfs.stat().st_size},
            'inventorySha256': oci.sha(inventory_path.read_bytes()), 'contextSha256': oci.sha(context.read_bytes()),
            'base': {'indexDigest': oci.BASE_INDEX, 'manifestDigest': 'sha256:' + oci.sha(Path(runtime['base_manifest']['input']).read_bytes()),
                     'configDigest': 'sha256:' + oci.sha(Path(runtime['base_config']['input']).read_bytes()),
                     'layerDigest': oci.pack.load_json(Path(runtime['base_manifest']['input']).read_bytes())['layers'][0]['digest']}, 'packages': packages}
        (runtime_root / 'attribution.json').write_bytes(oci.pack.canonical(attribution))
    for name, filename in [('rootfs', 'rootfs.tar'), ('inventory', 'inventory.json'), ('context', 'context.json'),
                           ('attribution', 'attribution.json'), ('licenses', 'licenses')]:
        runtime[name] = descriptor(runtime_root / filename)
    return {'kind': kind, 'producer': '//tools/bazel/packaging:' + kind + '_image_unsigned',
            'runtime': runtime, 'executable': descriptor(executable, compiled_label),
            'entrypoint': descriptor(entrypoint, '//apps/' + kind + ':entrypoint.sh'), 'rust': selected}


class ImageControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def produce(self, value, suffix=''):
        outputs = [self.root / (value['kind'] + '-image' + suffix + extension)
                   for extension in ('.tar.gz', '.signing.json', '.attribution.json', '.NOTICES.txt')]
        oci.produce(value, oci.pack.canonical(value), *outputs)
        return outputs

    def refused(self, value, message):
        with self.assertRaisesRegex(ValueError, message):
            self.produce(value)
        for extension in ('.tar.gz', '.signing.json', '.attribution.json', '.NOTICES.txt'):
            self.assertFalse((self.root / (value['kind'] + '-image' + extension)).exists())

    def test_original_base_metadata_oci_and_docker_reference_identical_layer_bytes(self):
        for kind in ('edge', 'stun'):
            value = prepare(self.root / kind, kind)
            outputs = self.produce(value)
            with tarfile.open(outputs[0]) as archive:
                blobs = {member.name: archive.extractfile(member).read() for member in archive.getmembers()}
            index = oci.pack.load_json(blobs['index.json'])
            manifest = oci.pack.load_json(blobs['blobs/sha256/' + index['manifests'][0]['digest'][7:]])
            config = oci.pack.load_json(blobs['blobs/sha256/' + manifest['config']['digest'][7:]])
            docker = oci.pack.load_json(blobs['manifest.json'])[0]
            self.assertEqual(docker['RepoTags'], ['merkur-' + kind + ':release'])
            self.assertEqual(docker['Layers'], ['blobs/sha256/' + layer['digest'][7:] for layer in manifest['layers']])
            self.assertEqual(config['rootfs']['diff_ids'], [layer['digest'] for layer in manifest['layers']])
            self.assertEqual(config['config']['Entrypoint'], ['/usr/local/bin/merkur-' + kind + '-entrypoint'])
            self.assertEqual(config['config']['Cmd'], ['/usr/local/bin/merkur-' + kind])
            self.assertEqual(config['config']['User'], '')
            with tarfile.open(fileobj=io.BytesIO(blobs[docker['Layers'][1]])) as overlay:
                passwd = overlay.extractfile('etc/passwd').read()
                self.assertIn(b'merkur:x:10001:10001::/nonexistent:/usr/sbin/nologin\n', passwd)
                self.assertEqual((overlay.getmember('etc/shadow').mode, overlay.getmember('etc/shadow').gid), (0o640, 42))
                self.assertEqual(overlay.getmember('usr/local/bin/merkur-' + kind).mode, 0o555)
                if kind == 'edge':
                    data = overlay.getmember('data')
                    self.assertEqual((data.mode, data.uid, data.gid), (0o700, 10001, 10001))
                    self.assertIn('SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt', config['config']['Env'])
            repeated = self.produce(value, '-again')
            for before, after in zip(outputs, repeated):
                if before.suffix == '.gz':
                    self.assertEqual(before.read_bytes(), after.read_bytes())
            signing = oci.pack.load_json(outputs[1].read_bytes())
            self.assertEqual(signing['artifact']['sha512'], hashlib.sha512(outputs[0].read_bytes()).hexdigest())

    def test_changed_rootfs_context_licenses_partial_rust_and_foreign_base_refuse(self):
        value = prepare(self.root / 'input')
        for name in ('context', 'licenses', 'rust', 'base'):
            with self.subTest(name=name):
                if name == 'context':
                    path = Path(value['runtime']['context']['input']); before = path.read_bytes(); path.write_bytes(before + b' ')
                    message = 'original inputs'
                elif name == 'licenses':
                    path = Path(value['runtime']['licenses']['input']) / 'util-linux/copyright'; before = path.read_bytes(); path.write_bytes(b'foreign')
                    message = 'original archive member'
                elif name == 'rust':
                    path = Path(value['rust']['inventory']['input']); before = path.read_bytes(); body = oci.pack.load_json(before)
                    body['pending_scopes'] = ['stdlib']; path.write_bytes(oci.pack.canonical(body))
                    message = 'compiled release custody'
                else:
                    path = self.root / 'foreign-index'; path.write_bytes(b'{}'); before = None
                    value['runtime']['base_index']['input'] = str(path); message = 'original pinned Bookworm'
                self.refused(value, message)
                if before is not None:
                    path.write_bytes(before)

    def test_declared_input_change_during_publication_removes_every_owned_output(self):
        value = prepare(self.root / 'input')
        verify = oci.deployment.DeclaredInputs.verify
        def changed(owned):
            Path(value['entrypoint']['input']).write_bytes(b'changed original source')
            verify(owned)
        with patch.object(oci.deployment.DeclaredInputs, 'verify', changed):
            self.refused(value, 'changed')

    def test_original_debian_copyright_names_use_license_paths_only(self):
        value = prepare(self.root / 'input')
        owned = oci.deployment.DeclaredInputs()
        try:
            with self.assertRaisesRegex(ValueError, 'portable relative file path'):
                owned.tree(value['runtime']['licenses'], 'licenses')
        finally:
            owned.close()
        owned = oci.deployment.DeclaredInputs()
        try:
            files = owned.tree(value['runtime']['licenses'], 'licenses', path_validator=oci.notices.closure.inputs.relative)
            self.assertIn('licenses/libstdc++6/copyright', files)
            owned.verify()
        finally:
            owned.close()
        copyright = Path(value['runtime']['licenses']['input']) / 'libstdc++6/copyright'
        copyright.unlink()
        copyright.symlink_to('../util-linux/copyright')
        self.refused(value, 'link or special member')


if __name__ == '__main__':
    unittest.main()
