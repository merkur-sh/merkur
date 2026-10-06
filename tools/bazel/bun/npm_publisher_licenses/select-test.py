"""Original six public publisher notice controls; no native runtime admission claim."""

import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class PublisherNotices(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.pins = copy.deepcopy(pins)
        self.identity = 'asn1.js@4.10.1'

    def original(self, identity=None, metadata=None, npm=None, source=None):
        identity = identity or self.identity
        paths = inputs[identity]
        return selector.select(identity, self.pins, original_catalog,
            Path(paths['metadata']).read_bytes() if metadata is None else metadata,
            Path(paths['npm']).read_bytes() if npm is None else npm,
            Path(paths['source']).read_bytes() if source is None else source,
            self.root / identity, self.root / identity, custody, linked, licenses)

    def test_all_six_actual_original_notices_are_complete_members(self):
        self.assertEqual(len(self.pins['packages']), 6)
        for identity in sorted(inputs):
            with self.subTest(identity=identity):
                directory = self.root / identity
                directory.mkdir()
                origin, member = self.original(identity)
                self.assertEqual(origin['component'], identity)
                self.assertEqual(member, 'README.md')
                (directory / member).write_bytes(origin['members'][member])
                texts = licenses.collect(directory, license_file=member)
                self.assertEqual(len(texts), 1)
                self.assertEqual(texts[0]['text'].encode(), origin['members'][member])
                self.assertEqual(licenses.read_regular(directory, member), origin['members'][member])
                self.assertIn('Copyright Fedor Indutny', texts[0]['text'])
                self.assertIn('Permission is hereby granted', texts[0]['text'])
                self.assertIn('THE SOFTWARE IS PROVIDED', texts[0]['text'])

    def installed(self, identity):
        entry = selector.declaration(identity, self.pins, original_catalog)
        raw = Path(inputs[identity]['npm']).read_bytes()
        members, _ = custody.source_archive_members(raw, {'source': entry['npm']}, licenses.relative)
        directory = self.root / identity
        directory.mkdir()
        for name, body in members.items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        main = json.loads(members['package.json'])['main']
        selected = main if main in members else main + '.js'
        self.assertIn(selected, members)
        return directory, directory / selected, members

    def test_all_six_actual_consumer_admissions_preserve_whole_original_readmes(self):
        for identity in sorted(inputs):
            with self.subTest(identity=identity):
                directory, selected, members = self.installed(identity)
                origin, member = self.original(identity)
                bound, texts = consumer.bind_npm_source(selected, self.root,
                    {identity: members}, linked, licenses, lambda selected_identity, directory: (origin, member) if selected_identity == identity else None)
                self.assertEqual(bound['component'], identity)
                self.assertEqual(texts, [{'path': identity + '/README.md',
                    'size': len(members[member]), 'sha256': hashlib.sha256(members[member]).hexdigest()}])
                self.assertEqual(licenses.read_regular(directory, member), origin['members'][member])

    def test_actual_from_files_preserves_existing_origin_contract(self):
        paths = inputs[self.identity]
        result = selector.from_files(self.identity, self.pins, original_catalog,
            {name: paths[name] for name in ('metadata', 'source')}, paths['npm'],
            self.root, self.root, custody, linked, licenses)
        self.assertEqual(set(result[0]), {'component', 'namespace', 'directory', 'members', 'aliases'})
        self.assertEqual(result[1], 'README.md')

    def test_mutated_original_archives_or_metadata_refuse(self):
        for name in ('metadata', 'npm', 'source'):
            with self.subTest(input=name), self.assertRaisesRegex(ValueError, 'Changed original'):
                self.original(**{name: Path(inputs[self.identity][name]).read_bytes() + b'foreign'})

    def changed_metadata(self, update):
        value = json.loads(Path(inputs[self.identity]['metadata']).read_bytes())
        update(value)
        raw = json.dumps(value).encode()
        entry = selector.declaration(self.identity, self.pins, original_catalog)
        entry['metadata'].update(size=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        return raw

    def test_foreign_publisher_identity_refuses(self):
        raw = self.changed_metadata(lambda value: value.update(name='foreign'))
        with self.assertRaisesRegex(ValueError, 'exact locked package'):
            self.original(metadata=raw)

    def test_missing_or_foreign_githead_refuses(self):
        for value in (None, '0' * 40):
            with self.subTest(gitHead=value):
                raw = self.changed_metadata(lambda item: item.update(gitHead=value))
                with self.assertRaisesRegex(ValueError, 'gitHead/repository'):
                    self.original(metadata=raw)

    def test_foreign_publisher_dist_or_repository_refuses(self):
        for update, reason in [
            (lambda value: value['dist'].update(integrity='sha512-foreign'), 'original npm archive'),
            (lambda value: value['dist'].update(tarball='https://example.invalid/source'), 'original npm archive'),
            (lambda value: value.update(repository={'type': 'git', 'url': 'git@github.com:foreign/source'}), 'gitHead/repository'),
        ]:
            raw = self.changed_metadata(update)
            with self.assertRaisesRegex(ValueError, reason):
                self.original(metadata=raw)

    def test_unknown_duplicate_or_relocked_package_refuses(self):
        with self.assertRaisesRegex(ValueError, 'exact declared package identity'):
            selector.declaration('foreign@1.0.0', self.pins, original_catalog)
        self.pins['packages'].append(copy.deepcopy(self.pins['packages'][0]))
        with self.assertRaisesRegex(ValueError, 'exact declared package identity'):
            selector.declaration(self.identity, self.pins, original_catalog)
        self.pins = copy.deepcopy(pins)
        self.pins['packages'][0]['package']['integrity'] = 'sha512-foreign'
        with self.assertRaisesRegex(ValueError, 'original Bun npm lock'):
            self.original()

    def test_foreign_notice_member_or_digest_refuses(self):
        for field, value in [('member', 'package.json'), ('sha256', '0' * 64)]:
            self.pins = copy.deepcopy(pins)
            selector.declaration(self.identity, self.pins, original_catalog)['notice'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'authored notice member'):
                self.original()

    def test_publisher_manifest_and_source_prefix_refuse_mismatch(self):
        for field, value, message in [('manifest', '0' * 64, 'npm manifest member'),
                                      ('source', 'foreign-prefix', 'foreign source prefix')]:
            self.pins = copy.deepcopy(pins)
            entry = selector.declaration(self.identity, self.pins, original_catalog)
            entry[field]['sha256' if field == 'manifest' else 'prefix'] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, message):
                self.original()

    def test_changed_installed_notice_and_symlink_refuse_original_file_authority(self):
        origin, member = self.original()
        directory, selected, members = self.installed(self.identity)
        notice = directory / member
        notice.write_bytes(b'Foreign replacement notice')
        with self.assertRaisesRegex(ValueError, 'original npm/publisher commit members'):
            consumer.bind_npm_source(selected, self.root, {self.identity: members},
                linked, licenses, lambda selected_identity, directory: (origin, member) if selected_identity == self.identity else None)
        notice.unlink()
        original = self.root / 'original'
        original.write_bytes(origin['members'][member])
        notice.symlink_to(original)
        with self.assertRaisesRegex(ValueError, 'safe regular file'):
            consumer.bind_npm_source(selected, self.root, {self.identity: members},
                linked, licenses, lambda selected_identity, directory: (origin, member) if selected_identity == self.identity else None)

    def test_consumer_foreign_identity_or_unbound_notice_refuses(self):
        origin, member = self.original()
        _, selected, members = self.installed(self.identity)
        foreign = dict(origin, component='foreign@1.0.0')
        with self.assertRaisesRegex(ValueError, 'another package identity'):
            consumer.bind_npm_source(selected, self.root, {self.identity: members},
                linked, licenses, lambda selected_identity, directory: (foreign, member) if selected_identity == self.identity else None)
        with self.assertRaisesRegex(linked.PendingLinkedSource, 'no declared published notice member'):
            consumer.bind_npm_source(selected, self.root, {self.identity: members}, linked, licenses)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('selector', 'pins', 'original_catalog', 'inputs', 'custody', 'linked', 'licenses', 'consumer'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    arguments = parser.parse_args()
    selector = load('publisher_notice_selector', arguments.selector)
    custody = load('publisher_original_archives', arguments.custody)
    linked = load('publisher_original_linked', arguments.linked)
    licenses = load('publisher_original_licenses', arguments.licenses)
    consumer = load('publisher_original_consumer', arguments.consumer)
    pins = json.loads(arguments.pins.read_bytes())
    original_catalog = json.loads(arguments.original_catalog.read_bytes())
    inputs = json.loads(arguments.inputs.read_bytes())
    unittest.main(argv=[sys.argv[0]])
