"""Complete original consumer union with explicit synthetic selected publishers."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load('release-notices')
native_fixture = load('native-release-test')
service_fixture = load('deployment-pack-test')
image_fixture = load('oci-release-test')


class ReleaseNoticeControls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.native = native_fixture.NativeReleaseControls()
        self.native.setUp()
        self.addCleanup(self.native.doCleanups)
        self.service = service_fixture.DeploymentControls()
        self.service.setUp()
        self.addCleanup(self.service.doCleanups)
        self.value = {'packages': [], 'deployment': {'inventory': self.service.value['notices']['inventory'],
            'notices': self.service.value['notices']['notices'],
            'producers': {role: self.service.value[role] for role in ('server', 'migrations', 'web')}}, 'images': []}
        for platform in release.native.PLATFORMS:
            for kind in (('daemon', 'verify') if platform.startswith('linux-') else ('daemon',)):
                name = ('merkur-daemon-' if kind == 'daemon' else kind + '-') + platform
                value = self.native.fixture(kind, platform)
                artifact = self.root / (name + ('.tar.gz' if kind == 'daemon' else ''))
                inventory = self.root / (name + '.signing-inputs.json')
                release.native.produce(value, artifact, inventory)
                label = '//tools/bazel/packaging:' + name
                self.value['packages'].append({'platform': platform, 'name': name,
                    'artifact': {'input': str(artifact), 'label': label}, 'inventory': {'input': str(inventory), 'label': label}})
        for kind in ('edge', 'stun'):
            value = image_fixture.prepare(self.root / kind, kind)
            source = self.root / (kind + '.source.json')
            source.write_bytes(release.pack.canonical(value))
            paths = [self.root / (kind + '-image' + extension) for extension in ('.tar.gz', '.signing.json', '.attribution.json', '.NOTICES.txt')]
            image_fixture.oci.produce(value, source.read_bytes(), *paths)
            label = value['producer']
            desc = lambda path: {'input': str(path), 'label': label}
            self.value['images'].append({'producer': label, 'artifact': desc(paths[0]),
                'configuration': value['runtime']['context'], 'source_inventory': desc(source),
                'inventory': desc(paths[2]), 'notices': desc(paths[3])})

    def produce(self, name='global'):
        inventory, text = self.root / (name + '.json'), self.root / (name + '.txt')
        release.produce(self.value, inventory, text)
        return inventory, text

    def refused(self, message):
        with self.assertRaisesRegex(ValueError, message):
            self.produce()
        self.assertFalse((self.root / 'global.json').exists())
        self.assertFalse((self.root / 'global.txt').exists())

    def test_complete_union_retains_every_native_platform_and_service_scope(self):
        inventory, text = self.produce()
        original = release.pack.load_json(inventory.read_bytes())
        self.assertEqual(original['kind'], 'complete-release-selected-attribution')
        self.assertEqual(len(original['providers']), 47)
        self.assertEqual({item['platform'] for item in original['providers']}, set(release.native.PLATFORMS))
        self.assertEqual(original['notices'], {'name': 'NOTICES.txt', 'sha256': hashlib.sha256(text.read_bytes()).hexdigest(), 'size': text.stat().st_size})
        self.assertEqual(text.read_bytes(), release.render(original['providers']))
        again = self.produce('again')
        self.assertEqual(inventory.read_bytes(), again[0].read_bytes())
        self.assertEqual(text.read_bytes(), again[1].read_bytes())

    def test_missing_duplicate_native_platform_or_foreign_package_label_refuse(self):
        original = copy.deepcopy(self.value)
        for index in range(6):
            self.value = copy.deepcopy(original)
            self.value['packages'].pop(index)
            self.refused('omit one or more exact native platforms')
        self.value = copy.deepcopy(original)
        self.value['packages'].append(self.value['packages'][0])
        self.refused('six configured native producers')
        self.value = copy.deepcopy(original)
        self.value['packages'][0]['inventory']['label'] = '//foreign:manifest'
        self.refused('foreign package action custody')

    def test_native_artifact_bytes_scope_omission_and_changed_image_refuse(self):
        item = self.value['packages'][0]
        path = Path(item['inventory']['input'])
        before = path.read_bytes()
        body = release.pack.load_json(before)
        body['attributions'].pop()
        path.write_bytes(release.pack.canonical(body))
        self.refused('omitted original selected attribution scopes')
        path.write_bytes(before)
        image = Path(self.value['images'][0]['artifact']['input'])
        image.write_bytes(image.read_bytes() + b'foreign')
        self.refused('actual configured image bytes')

    def test_missing_partial_or_foreign_image_provider_refuse(self):
        original = copy.deepcopy(self.value)
        self.value['images'].pop()
        self.refused('both original configured service images')
        self.value = copy.deepcopy(original)
        self.value['images'][0]['producer'] = '//foreign:image'
        self.refused('original image custody')
        self.value = copy.deepcopy(original)
        path = Path(self.value['images'][0]['inventory']['input'])
        body = release.pack.load_json(path.read_bytes())
        body['pending_scopes'] = ['native-rust']
        path.write_bytes(release.pack.canonical(body))
        self.refused('actual configured image bytes')

    def test_changed_service_producer_cannot_reuse_old_deployment_notices(self):
        Path(self.value['deployment']['producers']['server']['input']).write_bytes(native_fixture.header('linux-x64') + b'changed service')
        self.refused('another deployment artifact inventory')


if __name__ == '__main__':
    unittest.main()
