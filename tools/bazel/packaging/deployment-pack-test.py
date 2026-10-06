"""Native declared deployment tree/stream controls, not a shipping/runtime qualification."""
import copy
import gzip
import hashlib
import importlib.util
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('deployment-pack.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
spec = importlib.util.spec_from_file_location('layout', Path(__file__).with_name('release-layout.py'))
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)
spec = importlib.util.spec_from_file_location('notices', Path(__file__).with_name('deployment-notices.py'))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


def prepare_notices(value, root):
    """Synthetic complete typed-scope fixture, never a production provider receipt."""
    declared = {key: value[key] for key in ('server', 'server_context', 'migrations', 'web', 'build_id')}
    declared['attributions'] = []
    with_inputs = deployment.DeclaredInputs()
    try:
        server, size, _ = with_inputs.file(with_inputs.presentation(value['server']['input']), executable=True)
        entries = {'server/server': ({'label': value['server']['label'], 'mode': '0555'}, server, size)}
        entries.update(with_inputs.tree(value['migrations'], 'migrations'))
        entries.update(with_inputs.tree(value['web'], 'web'))
        artifact_inventory = notices.artifact_facts(entries)
    finally:
        with_inputs.close()
    for role, scopes in notices.REQUIRED.items():
        for scope in scopes:
            prefix = root / (role + '-' + scope)
            context = value['server_context']['input'] if role == 'server' else str(prefix) + '.context.json'
            if role != 'server':
                Path(context).write_bytes(deployment.pack.canonical({'producer': value[role]['label'], 'frontend_build_id': value['build_id']}))
            component = {'id': role + '/' + scope, 'name': role + '-' + scope, 'version': '1.0.0',
                         'source': None, 'license': 'MIT', 'repository': None, 'license_file': None,
                         'source_label': '//synthetic:' + role + '_' + scope,
                         'texts': [{'path': 'LICENSE', 'text': 'Exact synthetic published text\n',
                                    'size': len(b'Exact synthetic published text\n'),
                                    'sha256': notices.digest(b'Exact synthetic published text\n')}]}
            source_path, inventory_path, text_path = [str(prefix) + suffix for suffix in ('.source.json', '.inventory.json', '.txt')]
            source = {'inputs': {}, 'outputs': {}}
            if scope == 'wasm':
                source = {'configuration': {'compiler_root': '//synthetic:wasm', 'target': 'wasm32-unknown-unknown'}}
            Path(source_path).write_bytes(deployment.pack.canonical(source))
            inventory = {'producer': value[role]['label'], 'configuration': notices.digest(Path(context).read_bytes()),
                         'source_digest': notices.digest(Path(source_path).read_bytes()), 'components': [component], 'pending_scopes': []}
            if scope == 'npm':
                inventory['kind'] = 'selected-npm-attribution'
                if role in ('server', 'migrations'):
                    inventory.update(kind='npm-attribution-intermediate', configuration_authority={'settings_sha256': notices.digest(Path(context).read_bytes())})
                    inventory['pending_scopes'] = ['first-party'] if role == 'migrations' else ['first-party', 'wasm', 'embedded-runtime']
                    inventory['artifacts'] = artifact_inventory[role]
                    text = ('PARTIAL NPM ATTRIBUTION; PENDING: ' + ', '.join(inventory['pending_scopes']) + '\n\n').encode() + notices.closure.render(inventory)
                else:
                    text = notices.closure.render(inventory)
            elif scope == 'wasm':
                inventory.update(kind='rust-attribution-intermediate', configuration=source['configuration'], descriptor_sha256=notices.digest(Path(source_path).read_bytes()), pending=[])
                text = ('DECLARED RUST ATTRIBUTION\nCompiler root: //synthetic:wasm\n\n' + '-' * 78 + '\n' + component['name'] + ' 1.0.0\nPackage identity: ' + component['id'] + '\n\nLICENSE SHA-256 ' + component['texts'][0]['sha256'] + '\n' + component['texts'][0]['text'] + '\n').encode()
            else:
                inventory['kind'] = 'selected-' + scope + '-attribution'
                if scope == 'first-party':
                    inventory['compiler_tooling'] = []
                    inventory['artifacts'] = artifact_inventory[role]
                text = notices.closure.render(inventory)
            Path(inventory_path).write_bytes(deployment.pack.canonical(inventory))
            Path(text_path).write_bytes(text)
            descriptor = lambda path: {'input': str(path), 'label': '//synthetic:' + role + '_' + scope}
            declared['attributions'].append({'scope': scope, 'producer': value[role]['label'], 'artifact': dict(value[role]),
                                             'configuration': descriptor(context), 'source_inventory': descriptor(source_path),
                                             'inventory': descriptor(inventory_path), 'notices': descriptor(text_path)})
    inventory, text = root / 'complete.notices.json', root / 'NOTICES.txt'
    notices.produce(declared, inventory, text)
    return declared, {'inventory': {'input': str(inventory), 'label': '//synthetic:deployment_notices'},
                      'notices': {'input': str(text), 'label': '//synthetic:deployment_notices'}}


class DeploymentControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.server = self.root / 'server.bin'
        header = bytearray(64)
        header[:7] = b'\x7fELF\x02\x01\x01'
        struct.pack_into('<HHI', header, 16, 3, 62, 1)
        struct.pack_into('<H', header, 52, 64)
        self.server.write_bytes(header)
        self.server.chmod(0o755)
        self.migrations = self.root / 'migrations'
        self.migrations.mkdir()
        for name in deployment.MIGRATIONS:
            (self.migrations / name).write_bytes(b'export default {};\n')
        self.web = self.root / 'web'
        self.web.mkdir()
        self.build_id = '11111111-1111-4111-8111-111111111111'
        (self.web / 'assets').mkdir()
        for name, content in [('index.html', b'<html></html>'),
                              ('merkur-build.json', deployment.pack.canonical({'buildId': self.build_id})),
                              ('assets/app.js', b'export const ready=true;')]:
            (self.web / name).write_bytes(content)
            # Structural scope only: actual Brotli roundtrip is producer qualification.
            (self.web / (name + '.br')).write_bytes(b'nonempty compressed fixture')
        self.context = self.root / 'server.context.json'
        self.context.write_bytes(deployment.pack.canonical({'producer': '//apps/server:server', 'frontend_build_id': self.build_id}))
        self.license = self.root / 'LICENSE'
        self.license.write_bytes(b'Actual declared source license evidence fixture\n')
        self.value = {
            'server': {'input': str(self.server), 'label': '//apps/server:server'},
            'server_context': {'input': str(self.context), 'label': '//apps/server:server'},
            'migrations': {'input': str(self.migrations), 'label': '//apps/server:migrations'},
            'web': {'input': str(self.web), 'label': '//apps/web:frontend_precompressed'},
            'build_id': self.build_id,
            'license_evidence': [{'input': str(self.license), 'label': '//:LICENSE'}],
        }
        self.notice_value, self.value['notices'] = prepare_notices(self.value, self.root)

    def produce(self, name='a'):
        archive, manifest = self.root / (name + '.tar.gz'), self.root / (name + '.json')
        deployment.produce(self.value, archive, manifest)
        return archive, manifest

    def refused(self):
        with self.assertRaises((ValueError, OSError)):
            self.produce()
        self.assertFalse((self.root / 'a.tar.gz').exists())
        self.assertFalse((self.root / 'a.json').exists())

    def test_exact_service_consumer_canonical_stream_and_external_evidence(self):
        archive, manifest = self.produce()
        self.assertEqual(archive.read_bytes()[:10], b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff')
        data = deployment.pack.load_json(manifest.read_bytes())
        self.assertEqual(data['archive'], {'size': archive.stat().st_size, 'sha512': hashlib.sha512(archive.read_bytes()).hexdigest()})
        self.assertEqual(set(data), {'archive', 'files', 'build_id', 'server_context', 'source_evidence', 'notices'})
        self.assertEqual(data['source_evidence'], [{'label': '//:LICENSE', 'size': self.license.stat().st_size, 'sha256': hashlib.sha256(self.license.read_bytes()).hexdigest()}])
        self.assertEqual(data['notices']['required_name'], 'NOTICES.txt')
        self.assertEqual(data['notices']['scope'], 'complete deployment attribution')
        self.assertEqual(data['notices']['text']['sha256'], hashlib.sha256((self.root / 'NOTICES.txt').read_bytes()).hexdigest())
        self.assertEqual(len(data['notices']['providers']), 9)
        self.assertEqual(data['server_context']['sha256'], hashlib.sha256(self.context.read_bytes()).hexdigest())
        output = self.root / 'consumer'
        output.mkdir()
        with tarfile.open(archive) as package:
            names = package.getnames()
            self.assertEqual(names, sorted(item['path'] for item in data['files']))
            self.assertNotIn('LICENSE', names)
            self.assertNotIn('NOTICES.txt', names)
            for member in package.getmembers():
                item = next(item for item in data['files'] if item['path'] == member.name)
                content = package.extractfile(member).read()
                self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
                self.assertEqual(member.mode, 0o555 if member.name == 'server/server' else 0o444)
                self.assertEqual(hashlib.sha512(content).hexdigest(), item['sha512'])
                self.assertEqual(member.size, item['size'])
                target = output / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(member.mode)
        layout.service(output, self.build_id, list(deployment.MIGRATIONS))
        self.assertEqual(gzip.decompress(archive.read_bytes())[257:263], b'ustar\0')

    def test_same_declared_bytes_ignore_source_timestamps_and_carrier_spelling(self):
        archive, manifest = self.produce()
        self.server.touch()
        (self.web / 'assets/app.js').touch()
        carrier = self.root / 'declared-tree-carrier'
        carrier.symlink_to(self.web, target_is_directory=True)
        self.value['web']['input'] = str(carrier)
        second, second_manifest = self.produce('b')
        self.assertEqual(archive.read_bytes(), second.read_bytes())
        self.assertEqual(manifest.read_bytes(), second_manifest.read_bytes())

    def test_missing_extra_migration_and_brotli_inventory_refuse(self):
        for operation in ('missing-migration', 'extra-migration', 'missing-br', 'extra-br'):
            with self.subTest(operation=operation):
                if operation == 'missing-migration':
                    target = self.migrations / deployment.MIGRATIONS[0]
                    before = target.read_bytes()
                    target.unlink()
                elif operation == 'extra-migration':
                    target = self.migrations / 'extra.js'
                    target.write_bytes(b'undeclared migration')
                elif operation == 'missing-br':
                    target = self.web / 'index.html.br'
                    before = target.read_bytes()
                    target.unlink()
                else:
                    target = self.web / 'missing.js.br'
                    target.write_bytes(b'orphan precompressed copy')
                self.refused()
                if operation.startswith('missing'):
                    target.write_bytes(before)
                else:
                    target.unlink()

    def test_foreign_identity_context_native_architecture_and_permissions_refuse(self):
        original = copy.deepcopy(self.value)
        for mutation in ({'build_id': '22222222-2222-4222-8222-222222222222'}, {'license_evidence': []}, {'unexpected': True}):
            self.value.update(mutation)
            self.refused()
            self.value = copy.deepcopy(original)
        for key in ('server', 'migrations', 'web', 'server_context'):
            self.value[key]['label'] = 'not-a-producer-label'
            self.refused()
            self.value = copy.deepcopy(original)
        self.value['server_context']['label'] = '//foreign:compiler'
        self.refused()
        self.value = original
        self.context.write_bytes(deployment.pack.canonical({'producer': '//foreign:compiler', 'frontend_build_id': self.build_id}))
        self.refused()
        self.context.write_bytes(deployment.pack.canonical({'producer': '//apps/server:server', 'frontend_build_id': self.build_id}))
        header = bytearray(self.server.read_bytes())
        struct.pack_into('<H', header, 18, 183)
        self.server.write_bytes(header)
        self.refused()
        struct.pack_into('<H', header, 18, 62)
        self.server.write_bytes(header)
        self.server.chmod(0o444)
        self.refused()

    def test_same_byte_member_alias_directory_alias_and_special_file_refuse(self):
        target = self.web / 'assets/app.js'
        content = target.read_bytes()
        other = self.root / 'same-byte-original'
        other.write_bytes(content)
        target.unlink()
        target.symlink_to(other)
        self.refused()
        target.unlink()
        target.write_bytes(content)
        moved = self.root / 'moved-assets'
        (self.web / 'assets').rename(moved)
        (self.web / 'assets').symlink_to(moved, target_is_directory=True)
        self.refused()
        (self.web / 'assets').unlink()
        moved.rename(self.web / 'assets')
        import os
        os.mkfifo(self.web / 'special')
        self.refused()

    def test_complete_member_and_byte_coherence_rechecked_before_success(self):
        original = deployment.pack.stream_archive
        for kind in ('added', 'removed', 'bytes', 'alias'):
            with self.subTest(kind=kind):
                target = self.web / 'assets/app.js'
                before = target.read_bytes()
                extra = self.web / 'extra'
                def changed(*args):
                    if kind == 'added': extra.write_bytes(b'uninventoried')
                    elif kind == 'removed': target.unlink()
                    elif kind == 'bytes': target.write_bytes(b'changed previously captured bytes')
                    else:
                        outside = self.root / 'outside'
                        outside.write_bytes(before)
                        target.unlink()
                        target.symlink_to(outside)
                    return original(*args)
                with patch.object(deployment.pack, 'stream_archive', changed):
                    self.refused()
                extra.unlink(missing_ok=True)
                if target.is_symlink(): target.unlink()
                target.write_bytes(before)

    def test_parent_replacement_and_existing_outputs_never_write_foreign_bytes(self):
        parent = self.root / 'outputs'
        parent.mkdir()
        moved = self.root / 'old-outputs'
        outside = self.root / 'outside-output'
        outside.mkdir()
        original = deployment.pack.ArchiveOutputs.open
        swapped = False
        def changed(outputs, index):
            nonlocal swapped
            result = original(outputs, index)
            if not swapped:
                parent.rename(moved)
                parent.symlink_to(outside, target_is_directory=True)
                swapped = True
            return result
        with patch.object(deployment.pack.ArchiveOutputs, 'open', changed):
            with self.assertRaises(ValueError):
                deployment.produce(self.value, parent / 'deployment.tar.gz', parent / 'inventory.json')
        self.assertTrue(swapped)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(list(moved.iterdir()), [])
        self.assertTrue(parent.is_symlink())
        archive, manifest = self.produce()
        retained = archive.read_bytes(), manifest.read_bytes()
        with self.assertRaises(FileExistsError): self.produce()
        self.assertEqual((archive.read_bytes(), manifest.read_bytes()), retained)

    def test_nonempty_unique_text_source_evidence_mandatory(self):
        self.value['license_evidence'].append(copy.deepcopy(self.value['license_evidence'][0]))
        self.refused()
        self.value['license_evidence'].pop()
        self.license.write_bytes(b'\n')
        self.refused()
        self.license.write_bytes(b'\xff')
        self.refused()


if __name__ == '__main__':
    unittest.main()
