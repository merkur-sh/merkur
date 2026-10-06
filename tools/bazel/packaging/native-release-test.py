"""Native layout and selected-input controls; synthetic headers are not runtime qualification."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load('native-release')
layout = load('release-layout')


def header(platform):
    data = bytearray(96)
    if platform.startswith('linux-'):
        data[:7] = b'\x7fELF\x02\x01\x01'
        struct.pack_into('<HHI', data, 16, 3, 62 if platform == 'linux-x64' else 183, 1)
        struct.pack_into('<H', data, 52, 64)
    else:
        data[:4] = b'\xcf\xfa\xed\xfe'
        struct.pack_into('<I', data, 4, 0x01000007 if platform == 'darwin-x64' else 0x0100000c)
        struct.pack_into('<I', data, 12, 2)
    return bytes(data)


class NativeReleaseControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def fixture(self, kind='daemon', platform='linux-x64'):
        """Explicit synthetic selected publishers, never shipped provider defaults."""
        root = self.root / (kind + '-' + platform + '-inputs')
        root.mkdir(exist_ok=True)
        roles = sorted(native.DAEMON_MEMBERS if kind == 'daemon' else {kind})
        value = {'kind': kind, 'platform': platform, 'files': [], 'expected': roles,
                 'licenses': [], 'attributions': []}
        license_file = root / 'LICENSE'
        license_file.write_text('Original fixture license\n')
        value['licenses'].append({'input': str(license_file), 'label': '//fixture:LICENSE'})
        for role in roles:
            producer = '//fixture:' + role
            executable = root / (role + '.bin')
            executable.write_bytes(header(platform) + role.encode())
            executable.chmod(0o755)
            value['files'].append({'path': role, 'artifact_path': executable.name,
                                   'input': str(executable), 'label': producer, 'mode': '0555'})
            scopes = ('first-party', 'npm', 'wasm', 'embedded-runtime') if role in {'merkur', 'verify'} else ('rust',)
            artifact = {'path': executable.name, 'label': producer, 'mode': '0555',
                        'size': executable.stat().st_size,
                        'sha256': hashlib.sha256(executable.read_bytes()).hexdigest()}
            for scope in scopes:
                prefix = root / (role + '-' + scope)
                paths = {name: Path(str(prefix) + '.' + name) for name in
                         ('configuration', 'source_inventory', 'inventory', 'notices')}
                paths['configuration'].write_bytes(native.pack.canonical({'producer': producer}))
                source = {'configuration': {'compiler_root': '//fixture:wasm', 'target': 'wasm32-unknown-unknown'}} if scope == 'wasm' else {'selected': role + '/' + scope}
                paths['source_inventory'].write_bytes(native.pack.canonical(source))
                text = 'Fixture original license text\n'
                component = {'id': role + '/' + scope, 'name': role + '-' + scope,
                             'version': '1.0.0', 'source': None, 'license': 'MIT',
                             'repository': None, 'license_file': None,
                             'source_label': '//fixture:' + role + '-' + scope,
                             'texts': [{'path': 'LICENSE', 'text': text, 'size': len(text.encode()),
                                        'sha256': hashlib.sha256(text.encode()).hexdigest()}]}
                inventory = {'kind': 'selected-' + scope + '-attribution', 'producer': producer,
                             'configuration': hashlib.sha256(paths['configuration'].read_bytes()).hexdigest(),
                             'source_digest': hashlib.sha256(paths['source_inventory'].read_bytes()).hexdigest(),
                             'pending_scopes': [], 'components': [component], 'artifacts': [artifact]}
                if scope == 'first-party':
                    inventory['compiler_tooling'] = []
                if scope == 'rust':
                    inventory.update(kind='selected-native-rust-attribution',
                                     target=native.PLATFORMS[platform], profile='release')
                if scope == 'wasm':
                    inventory.update(kind='rust-attribution-intermediate', configuration=source['configuration'],
                                     descriptor_sha256=hashlib.sha256(paths['source_inventory'].read_bytes()).hexdigest(), pending=[])
                    lines = ['DECLARED RUST ATTRIBUTION', 'Compiler root: //fixture:wasm', '',
                             '-' * 78, component['name'] + ' 1.0.0', 'Package identity: ' + component['id'], '',
                             'LICENSE SHA-256 ' + component['texts'][0]['sha256'], text, '']
                    notice_text = '\n'.join(lines).encode()
                else:
                    notice_text = native.notices.closure.render(inventory)
                paths['inventory'].write_bytes(native.pack.canonical(inventory))
                paths['notices'].write_bytes(notice_text)
                value['attributions'].append({'role': role, 'scope': scope, 'producer': producer,
                    **{name: {'input': str(path), 'label': '//fixture:' + role + '-' + scope}
                       for name, path in paths.items()}})
        return value

    def produce(self, value, name='result'):
        artifact, signing = self.root / name, self.root / (name + '.json')
        native.produce(value, artifact, signing)
        return artifact, native.pack.load_json(signing.read_bytes())

    def refused(self, value, message):
        with self.assertRaisesRegex(ValueError, message):
            self.produce(value)
        self.assertFalse((self.root / 'result').exists())
        self.assertFalse((self.root / 'result.json').exists())

    def test_exact_four_daemon_members_reproduce_and_pass_original_consumer(self):
        for platform in native.PLATFORMS:
            with self.subTest(platform=platform):
                value = self.fixture(platform=platform)
                artifact, manifest = self.produce(value, platform)
                self.assertEqual(manifest['archive'], {'size': artifact.stat().st_size,
                    'sha512': hashlib.sha512(artifact.read_bytes()).hexdigest()})
                output = self.root / (platform + '-consumer')
                output.mkdir()
                with tarfile.open(artifact) as package:
                    self.assertEqual(package.getnames(), sorted(native.DAEMON_MEMBERS))
                    for member in package.getmembers():
                        self.assertEqual((member.mode, member.uid, member.gid, member.mtime), (0o555, 0, 0, 0))
                        path = output / member.name
                        path.write_bytes(package.extractfile(member).read())
                        path.chmod(member.mode)
                layout.daemon(output, platform)
                for item in value['files']:
                    Path(item['input']).touch()
                repeated, repeated_manifest = self.produce(value, platform + '-again')
                self.assertEqual(artifact.read_bytes(), repeated.read_bytes())
                self.assertEqual(manifest, repeated_manifest)

    def test_raw_native_outputs_preserve_bytes_normalized_mode_and_sha512(self):
        for platform in ('linux-arm64', 'linux-x64'):
            value = self.fixture('verify', platform)
            artifact, manifest = self.produce(value, 'verify-' + platform)
            self.assertEqual(artifact.read_bytes(), Path(value['files'][0]['input']).read_bytes())
            self.assertEqual(artifact.stat().st_mode & 0o7777, 0o555)
            self.assertEqual(manifest['artifact'], {'size': artifact.stat().st_size,
                'sha512': hashlib.sha512(artifact.read_bytes()).hexdigest()})
            layout.native(artifact, platform)

    def test_missing_scope_duplicate_foreign_and_intermediate_rust_cannot_publish(self):
        original = self.fixture()
        for index in range(len(original['attributions'])):
            value = copy.deepcopy(original)
            value['attributions'].pop(index)
            self.refused(value, 'missing exact original selected providers')
        value = copy.deepcopy(original)
        value['attributions'].append(copy.deepcopy(value['attributions'][0]))
        self.refused(value, 'duplicate or unsupported')
        value = copy.deepcopy(original)
        value['attributions'][0]['producer'] = '//foreign:compiled'
        self.refused(value, 'another executable')
        item = next(x for x in original['attributions'] if x['scope'] == 'rust')
        path = Path(item['inventory']['input'])
        body = native.pack.load_json(path.read_bytes())
        body['kind'] = 'rust-attribution-intermediate'
        path.write_bytes(native.pack.canonical(body))
        self.refused(original, 'original compiled release custody')

    def test_original_artifact_basename_bytes_and_configuration_are_bound(self):
        value = self.fixture()
        item = next(x for x in value['attributions'] if x['scope'] == 'rust')
        path = Path(item['inventory']['input'])
        before = path.read_bytes()
        for change in ('path', 'sha256', 'target', 'profile', 'configuration'):
            with self.subTest(change=change):
                body = native.pack.load_json(before)
                if change in ('path', 'sha256'):
                    body['artifacts'][0][change] = item['role'] if change == 'path' else '0' * 64
                else:
                    body[change] = 'foreign'
                path.write_bytes(native.pack.canonical(body))
                self.refused(value, 'original compiled release custody')
        path.write_bytes(before)
        value['files'][0]['artifact_path'] = 'invented.bin'
        self.refused(value, 'original executable basename')

    def test_wrong_architecture_inventory_mode_license_and_pending_scope_refuse(self):
        original = self.fixture()
        for change in ('architecture', 'expected', 'mode', 'license', 'pending'):
            with self.subTest(change=change):
                value = copy.deepcopy(original)
                if change == 'architecture':
                    value['platform'] = 'darwin-arm64'
                    message = 'Mach-O'
                elif change == 'expected':
                    value['expected'].append(value['expected'][0])
                    message = 'inventory differs'
                elif change == 'mode':
                    value['files'][0]['mode'] = '0755'
                    message = 'normalized executable'
                elif change == 'license':
                    value['licenses'] = []
                    message = 'external license'
                else:
                    item = next(x for x in value['attributions'] if x['scope'] == 'first-party')
                    path = Path(item['inventory']['input'])
                    body = native.pack.load_json(path.read_bytes())
                    body['pending_scopes'] = ['unimplemented-native-sdk']
                    path.write_bytes(native.pack.canonical(body))
                    Path(item['notices']['input']).write_bytes(native.notices.closure.render(body))
                    message = 'unresolved original scope'
                self.refused(value, message)

    def test_original_input_change_during_publication_cleans_outputs(self):
        value = self.fixture('verify')
        verify = native.deployment.DeclaredInputs.verify
        calls = 0
        def changed(owned):
            nonlocal calls
            calls += 1
            if calls == 2:
                Path(value['files'][0]['input']).write_bytes(header('linux-x64') + b'replaced')
            verify(owned)
        with patch.object(native.deployment.DeclaredInputs, 'verify', changed):
            self.refused(value, 'changed')

    def test_six_native_artifacts_are_exact_subset_of_ten_original_contract(self):
        contract = native.pack.load_json(Path(__file__).with_name('release-contract.json').read_bytes())
        names = {item['name'] for item in contract['artifacts']}
        native_names = {'merkur-daemon-' + platform + '.tar.gz' for platform in native.PLATFORMS}
        native_names |= {'verify-' + platform for platform in ('linux-arm64', 'linux-x64')}
        self.assertEqual(len(native_names), 6)
        self.assertEqual(names - native_names, {'deployment.tar.gz', 'edge-image.tar.gz', 'stun-image.tar.gz', 'NOTICES.txt'})


if __name__ == '__main__':
    unittest.main()
