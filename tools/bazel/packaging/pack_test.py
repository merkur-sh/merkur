"""Real archive and signing-input negative controls on the declared Python."""
import gzip
import hashlib
import copy
import io
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

module = importlib.util.spec_from_file_location('pack', Path(__file__).with_name('pack.py'))
pack = importlib.util.module_from_spec(module)
module.loader.exec_module(pack)
module = importlib.util.spec_from_file_location('unpack', Path(__file__).with_name('unpack.py'))
unpack = importlib.util.module_from_spec(module)
module.loader.exec_module(unpack)


class PackageControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.binary = self.root / 'binary'
        self.binary.write_bytes(b'actual executable bytes\n')
        self.binary.chmod(0o755)
        self.license = self.root / 'license'
        self.license.write_bytes(b'license bytes\n')
        self.spec = {'files': [
            {'path': 'merkur', 'input': str(self.binary), 'label': '//fixture:binary', 'mode': '0555'},
            {'path': 'LICENSE', 'input': str(self.license), 'label': '//fixture:license', 'mode': '0444'},
        ], 'expected': ['merkur', 'LICENSE'], 'licenses': ['LICENSE']}

    def produce(self, name='a'):
        archive, manifest = self.root / (name + '.tar.gz'), self.root / (name + '.json')
        pack.produce(self.spec, archive, manifest)
        return archive, manifest

    def test_determinism_inventory_and_consumer(self):
        first, first_manifest = self.produce()
        self.binary.touch()
        self.spec['files'].reverse()
        second, second_manifest = self.produce('b')
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(first_manifest.read_bytes(), second_manifest.read_bytes())
        data = json.loads(first_manifest.read_bytes())
        self.assertEqual(data['archive']['sha512'], hashlib.sha512(first.read_bytes()).hexdigest())
        with tarfile.open(first) as archive:
            self.assertEqual(archive.getnames(), ['LICENSE', 'merkur'])
            for member in archive.getmembers():
                self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 0))
                self.assertEqual(member.mode, 0o555 if member.name == 'merkur' else 0o444)
                self.assertTrue(member.isfile())
                item = next(item for item in data['files'] if item['path'] == member.name)
                self.assertEqual(hashlib.sha512(archive.extractfile(member).read()).hexdigest(), item['sha512'])
        header = gzip.decompress(first.read_bytes())
        self.assertEqual(header[257:263], b'ustar\0')

    def test_missing_extra_and_license_fail_closed(self):
        for mutate in [lambda: self.spec['expected'].append('missing'),
                       lambda: self.spec['expected'].remove('merkur'),
                       lambda: self.spec.update(licenses=[]),
                       lambda: self.spec.update(licenses=['missing'])]:
            original = json.loads(json.dumps(self.spec))
            mutate()
            with self.assertRaises(ValueError): self.produce()
            self.assertFalse((self.root / 'a.tar.gz').exists())
            self.spec = original

    def test_path_duplicate_permission_and_shape_controls(self):
        for path in ['../merkur', '/merkur', 'a/../merkur', 'a\\merkur', 'a\nmerkur', 'x' * 101, 'LICENSE']:
            self.spec['files'][0]['path'] = path
            with self.assertRaises(ValueError): self.produce()
        self.spec['files'][0]['path'] = 'merkur'
        self.binary.chmod(0o644)
        with self.assertRaises(ValueError): self.produce()
        # Darwin's sandbox clears setuid on chmod; sticky survives and is also unsafe.
        self.binary.chmod(0o1755)
        self.assertEqual(self.binary.stat().st_mode & 0o1000, 0o1000)
        with self.assertRaises(ValueError): self.produce()
        self.binary.chmod(0o755)
        self.spec['files'][0]['mode'] = '0777'
        with self.assertRaises(ValueError): self.produce()
        self.spec['files'][0]['mode'] = '0555'
        self.spec['unexpected'] = True
        with self.assertRaises(ValueError): self.produce()

    def test_output_overwrite_does_not_delete_existing_bytes(self):
        archive, manifest = self.produce()
        retained = archive.read_bytes(), manifest.read_bytes()
        with self.assertRaises(FileExistsError): self.produce()
        self.assertEqual((archive.read_bytes(), manifest.read_bytes()), retained)

    def test_consumer_digest_inventory_and_mode_controls(self):
        archive, manifest = self.produce()
        contract = {'files': {item['path']: {'label': item['label'], 'mode': item['mode']} for item in self.spec['files']}, 'licenses': ['LICENSE']}
        output = self.root / 'consumer'
        unpack.extract(archive, manifest, contract, output)
        self.assertEqual((output / 'merkur').read_bytes(), self.binary.read_bytes())
        self.assertEqual((output / 'merkur').stat().st_mode & 0o777, 0o555)
        with self.assertRaises(FileExistsError): unpack.extract(archive, manifest, contract, output)
        original = json.loads(manifest.read_bytes())
        for mutate in [lambda data: data['files'].pop(),
                       lambda data: data.update(licenses=[]),
                       lambda data: data['files'][0].update(mode='0555'),
                       lambda data: data['files'][1].update(label='//foreign:producer'),
                       lambda data: data['files'][1].update(size=True),
                       lambda data: data['files'][1].update(sha512='0' * 128),
                       lambda data: data.update(unexpected=True)]:
            data = json.loads(json.dumps(original))
            mutate(data)
            manifest.write_bytes(pack.canonical(data))
            with self.assertRaises(ValueError): unpack.extract(archive, manifest, contract, self.root / 'invalid')
            self.assertFalse((self.root / 'invalid').exists())
        manifest.write_bytes(pack.canonical(original))
        archive.write_bytes(archive.read_bytes() + b'extra unsigned bytes')
        with self.assertRaises(ValueError): unpack.extract(archive, manifest, contract, self.root / 'invalid')

    def test_duplicate_json_fields_are_rejected(self):
        with self.assertRaises(ValueError): pack.load_json('{"files":[],"files":{}}')

    def test_actual_archive_member_negatives(self):
        archive, manifest = self.produce()
        contract = {'files': {item['path']: {'label': item['label'], 'mode': item['mode']} for item in self.spec['files']}, 'licenses': ['LICENSE']}
        original_manifest = json.loads(manifest.read_bytes())
        with tarfile.open(archive) as package:
            original = [(copy.copy(member), package.extractfile(member).read()) for member in package.getmembers()]
        def wrong_mode(members): members[1][0].mode = 0o777
        def wrong_owner(members): members[1][0].uid = 1000
        def link(members):
            members[1][0].type = tarfile.SYMTYPE
            members[1][0].linkname = '../../outside'
            members[1][0].size = 0
        def changed_bytes(members): members[1] = (members[1][0], b'x' * len(members[1][1]))
        for mutate in [wrong_mode, wrong_owner, link, changed_bytes,
                       lambda members: members.pop(), lambda members: members.append(copy.deepcopy(members[1]))]:
            members = copy.deepcopy(original)
            mutate(members)
            with archive.open('wb') as output, gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.USTAR_FORMAT) as package:
                    for member, content in members: package.addfile(member, io.BytesIO(content))
            data = copy.deepcopy(original_manifest)
            data['archive'] = {'size': archive.stat().st_size, 'sha512': hashlib.sha512(archive.read_bytes()).hexdigest()}
            manifest.write_bytes(pack.canonical(data))
            with self.assertRaises(ValueError): unpack.extract(archive, manifest, contract, self.root / 'invalid')
            self.assertFalse((self.root / 'invalid').exists())

    def test_independent_critic_framing_and_contract_regressions(self):
        archive, manifest = self.produce()
        original_manifest = pack.load_json(manifest.read_bytes())
        contract = {'files': {item['path']: {'label': item['label'], 'mode': item['mode']} for item in self.spec['files']}, 'licenses': ['LICENSE']}
        with tarfile.open(archive) as package:
            members = [(copy.copy(member), package.extractfile(member).read()) for member in package.getmembers()]
        for case in ('gnu', 'gzip_time', 'gzip_name', 'gzip_second_member', 'file_padding', 'end_padding'):
            plain = io.BytesIO()
            with tarfile.open(fileobj=plain, mode='w|', format=tarfile.GNU_FORMAT if case == 'gnu' else tarfile.USTAR_FORMAT) as package:
                for member, content in members: package.addfile(member, io.BytesIO(content))
            payload = bytearray(plain.getvalue())
            if case == 'file_padding': payload[512 + members[0][0].size] = 1
            if case == 'end_padding': payload[-1] = 1
            with archive.open('wb') as output, gzip.GzipFile(filename='host-name' if case == 'gzip_name' else '', mode='wb', fileobj=output, mtime=1 if case == 'gzip_time' else 0) as zipped:
                zipped.write(payload)
            if case == 'gzip_second_member':
                with archive.open('ab') as output: output.write(gzip.compress(b'UNINVENTORIED', mtime=0))
            data = copy.deepcopy(original_manifest)
            data['archive'] = {'size': archive.stat().st_size, 'sha512': hashlib.sha512(archive.read_bytes()).hexdigest()}
            manifest.write_bytes(pack.canonical(data))
            with self.assertRaises(ValueError): unpack.extract(archive, manifest, contract, self.root / 'invalid')
            self.assertFalse((self.root / 'invalid').exists())
        malformed = copy.deepcopy(contract)
        malformed['licenses'] = ['LICENSE', 'LICENSE']
        with self.assertRaises(ValueError): unpack.extract(archive, manifest, malformed, self.root / 'invalid')


if __name__ == '__main__':
    unittest.main()
