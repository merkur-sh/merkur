"""Exact original-source and configured CLI root controls (no tool qualification)."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import tarfile
import unittest


def load(path):
    spec = importlib.util.spec_from_file_location('bindgen_original_control', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OriginalControls(unittest.TestCase):
    def test_original_archive_and_locked_catalog(self):
        value = original.document(archive)
        self.assertEqual(value, json.loads((directory / 'original.json').read_text()))
        self.assertEqual(original.declarations(value), (directory / 'data.bzl').read_text())
        self.assertEqual(len(value['registry']), 251)
        self.assertTrue(all(path in value['source_files'] for path in original.BINS.values()))

    def test_changed_archive_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            changed = Path(temporary) / 'changed.crate'
            changed.write_bytes(archive.read_bytes() + b'x')
            with self.assertRaisesRegex(ValueError, 'exact original'):
                original.original(changed)

    def roots(self):
        targets = [('wasm_bindgen_cli', 'lib', 'src/lib.rs')]
        targets += [(name, 'bin', path) for name, path in original.BINS.items()]
        return [{'pkg_id': 'workspace:.', 'mode': 'build', 'features': ['default', 'rustls-tls'],
                 'target': {'name': name, 'kind': [kind], 'crate_types': [kind], 'src_path': path}}
                for name, kind, path in targets]

    def test_exact_original_compiler_roots(self):
        roots = self.roots()
        self.assertEqual(set(original.native_binaries(roots)), set(original.BINS))
        self.assertIs(original.native_binary(roots), roots[1])

    def test_missing_or_duplicate_original_root_refused(self):
        roots = self.roots()
        for changed in [roots[:-1], roots + [roots[-1]]]:
            with self.subTest(roots=len(changed)), self.assertRaises(ValueError):
                original.native_binaries(changed)

    def test_wrong_root_identity_refused(self):
        for field, value in [('pkg_id', 'registry:wasm-bindgen-cli@0.2.127'), ('mode', 'test')]:
            changed = copy.deepcopy(self.roots())
            changed[1][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                original.native_binaries(changed)
        for field, value in [('src_path', 'src/bin/foreign.rs'), ('kind', ['example']),
                             ('crate_types', ['cdylib']), ('name', 'foreign')]:
            changed = copy.deepcopy(self.roots())
            changed[1]['target'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                original.native_binaries(changed)

    def test_changed_publisher_default_tls_features_refused(self):
        for features in [[], ['default'], ['default', 'native-tls'], ['default', 'rustls-tls', 'native-tls']]:
            changed = copy.deepcopy(self.roots())
            changed[1]['features'] = features
            with self.subTest(features=features), self.assertRaises(ValueError):
                original.native_binaries(changed)


class CapturedContextControls(unittest.TestCase):
    def emit(self, value):
        with tempfile.TemporaryDirectory() as temporary:
            context = Path(temporary) / 'context.json'
            context.write_text(json.dumps(value))
            return generator.emit([context], archive, original, units, lto, edges)

    def test_original_actual_context_emits_three_source_binary_maps(self):
        result = self.emit(captured)
        self.assertEqual(result.count('native_link_map = True'), 3)
        for name in original.BINS:
            self.assertIn('name = "' + name.replace('-', '_') + '"', result)
        self.assertNotIn('//conditions:default', result)
        self.assertEqual(result.count('"MERKUR_WASM_BINDGEN_REVISION": "' + original.REVISION + '"'), 1)

    def test_declared_original_publisher_revision(self):
        value = original.document(archive)
        self.assertEqual(value['publisher_revision'], original.REVISION)
        self.assertEqual(json.loads(original.original(archive)[0]['.cargo_vcs_info.json'])['git']['sha1'], original.REVISION)
        with tarfile.open(registry / 'wasm-bindgen-shared-0.2.127.crate', mode='r:gz') as source:
            vcs = source.extractfile('wasm-bindgen-shared-0.2.127/.cargo_vcs_info.json')
            self.assertIsNotNone(vcs)
            self.assertEqual(json.loads(vcs.read()), {'git': {'sha1': original.REVISION}, 'path_in_vcs': 'crates/shared'})

    def test_changed_source_archive_or_context_membership_refused(self):
        for field, value in [('package', 'foreign'), ('mode', 'test'), ('platform', 'wasm')]:
            changed = copy.deepcopy(captured)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.emit(changed)
        for key in ['archive_sha256', 'cargo_lock_sha256']:
            changed = copy.deepcopy(captured)
            changed['original_source'][key] = '0' * 64
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.emit(changed)
        changed = copy.deepcopy(captured)
        del changed['inputs']['Cargo.toml']
        with self.assertRaises(ValueError):
            self.emit(changed)

    def test_unsupported_or_uncaptured_host_refused(self):
        for key in ['contexts', 'unit_graphs']:
            changed = copy.deepcopy(captured)
            changed[key] = {}
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.emit(changed)
        changed = copy.deepcopy(captured)
        changed['contexts']['foreign-host'] = changed['contexts'].pop('aarch64-apple-darwin')
        changed['unit_graphs']['foreign-host'] = changed['unit_graphs'].pop('aarch64-apple-darwin')
        with self.assertRaises(ValueError):
            self.emit(changed)

    def test_exact_original_package_notices_for_each_selected_binary(self):
        values = generator.attribution([context], archive, registry, original, units, directory / 'publisher-licenses.json')
        descriptors = [json.loads(value) for name, value in values.items() if name.endswith('.json')]
        self.assertEqual(len(descriptors), 3)
        for descriptor in descriptors:
            self.assertEqual(len(descriptor['roots']), 1)
            self.assertEqual(set(descriptor['packages']), set(descriptor['package_sources']))
            self.assertFalse(descriptor['shipping_qualified'])
            self.assertTrue(descriptor['pending'])
            self.assertEqual(descriptor['packages']['workspace:.']['archive_checksum'], original.SHA256)
        self.assertIn('stdlib_notices[', values['attribution.bzl'])
        self.assertNotIn('stdlib_notices = {}', values['attribution.bzl'])
        self.assertEqual(values['attribution.bzl'].count('source_patches = '), 1)
        self.assertIn('//tools/bazel/wasm/bindgen_source:declared-revision.patch', values['attribution.bzl'])

    def test_changed_locked_notice_archive_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary)
            for file in registry.glob('*.crate'):
                (copied / file.name).symlink_to(file.resolve())
            changed = copied / 'adler2-2.0.1.crate'
            changed.unlink()
            changed.write_bytes(b'foreign archive')
            with self.assertRaisesRegex(ValueError, 'original locked archive'):
                generator.attribution([context], archive, copied, original, units, directory / 'publisher-licenses.json')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--original', type=Path, required=True)
    parser.add_argument('--context', type=Path, required=True)
    parser.add_argument('--registry-directory', type=Path, required=True)
    parser.add_argument('--rust-directory', type=Path, required=True)
    args = parser.parse_args()
    archive, directory = args.archive, args.original.parent
    original = load(args.original)
    generator = load(directory / 'generate.py')
    generator.load('configured_parity', args.rust_directory / 'configured_parity.py')
    generator.load('license_metadata', args.rust_directory / 'license_metadata.py')
    generator.load('native_receipts', args.rust_directory / 'native_receipts.py')
    units = generator.load('bindgen_units', args.rust_directory / 'units.py')
    lto = generator.load('bindgen_lto', args.rust_directory / 'rolldown_generate.py')
    edges = generator.load('existing_native_edges', args.rust_directory / 'audit_tool/generate.py')
    context, registry = args.context, args.registry_directory
    captured = json.loads(context.read_text())
    unittest.main(argv=['original-controls'])
