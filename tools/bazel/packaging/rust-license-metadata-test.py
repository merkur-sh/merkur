"""Effective metadata controls on actual TOML bytes, including inheritance."""
import copy
import ast
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('rust_license_metadata', Path(__file__).with_name('rust-license-metadata.py'))
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class OriginalProcMacroConfiguration(unittest.TestCase):
    def test_notice_supplier_uses_the_compiler_execution_configuration(self):
        source = Path(metadata.__file__).with_name('rust-compiled.bzl').read_text()
        declaration = next(node for node in ast.parse(source).body
                           if isinstance(node, ast.Assign) and any(
                               isinstance(target, ast.Name) and target.id == 'compiled_rust_attribution'
                               for target in node.targets))
        attributes = SimpleNamespace(label=lambda **values: values,
                                     label_list=lambda **values: values,
                                     label_keyed_string_dict=lambda **values: values,
                                     string=lambda **values: values)
        namespace = {'rule': lambda **values: values, 'attr': attributes,
                     '_compiled_attribution_impl': object(), 'configured_rust_graph': object(),
                     'RustLinkMapInfo': object(), 'PackageSourceInfo': object(),
                     'SelectedAttributionInfo': object(), 'OutputGroupInfo': object()}
        exec(compile(ast.Module(body=[declaration], type_ignores=[]),
                     'actual-rust-compiled.bzl', 'exec'), namespace)
        actual = namespace['compiled_rust_attribution']['attrs']
        self.assertEqual(actual['proc_macro_notices']['cfg'], 'exec')
        self.assertNotIn('cfg', actual['producer'])
        self.assertEqual(actual['_python']['cfg'], 'exec')


class OriginalLinkMapDeclarations(unittest.TestCase):
    def setUp(self):
        source = Path(metadata.__file__).with_name('rust-link-map.bzl').read_text()
        def refuse(message):
            raise ValueError(message)
        self.namespace = {'provider': lambda **_: lambda **fields: SimpleNamespace(**fields),
                          'struct': lambda **fields: SimpleNamespace(**fields), 'fail': refuse}
        exec(compile(ast.parse(source), 'actual-rust-link-map.bzl', 'exec'), self.namespace)
        self.declared = []
        def declare_file(name, **kwargs):
            self.declared.append((name, kwargs))
            return name
        self.ctx = SimpleNamespace(actions=SimpleNamespace(declare_file=declare_file))
        self.output = SimpleNamespace(basename='original-output')
        self.crate = SimpleNamespace(type='bin', is_test=False, output=self.output)
        self.toolchain = SimpleNamespace(target_triple=SimpleNamespace(str='aarch64-apple-darwin'),
            exec_triple=SimpleNamespace(str='aarch64-apple-darwin'), rust_std=['original-std'],
            rustc='original-rustc', version='1.97.1')

    def declaration(self, native=False, wasm=False, metadata_only=False, cc_link=False):
        return self.namespace['declare_link_map'](self.ctx,
            SimpleNamespace(native_link_map=native, wasm_link_map=wasm), self.crate,
            self.toolchain, metadata_only, cc_link)

    def test_native_original_flags_and_same_action_file_preserved(self):
        for target, flag in [('aarch64-apple-darwin', '-Clink-arg=-Wl,-map,%s'),
                             ('x86_64-apple-darwin', '-Clink-arg=-Wl,-map,%s'),
                             ('aarch64-unknown-linux-gnu', '-Clink-arg=-Wl,-Map,%s'),
                             ('x86_64-unknown-linux-gnu', '-Clink-arg=-Wl,-Map,%s')]:
            self.toolchain.target_triple.str = target
            for kind in ('bin', 'proc-macro'):
                self.crate.type = kind
                result = self.declaration(native=True)
                self.assertEqual(result.flag_format, flag)
                self.assertEqual(result.output_group, 'native_link_map')
                self.assertEqual(self.declared[-1], ('original-output.link-map.txt', {'sibling': self.output}))

    def test_wasm_exact_cdylib_map_and_original_toolchain_files(self):
        self.toolchain.target_triple.str = 'wasm32-unknown-unknown'
        self.crate.type = 'cdylib'
        declaration = self.declaration(wasm=True)
        self.assertEqual(declaration.flag_format, '-Clink-arg=-Map=%s')
        self.assertEqual(declaration.output_group, 'wasm_link_map')
        info = self.namespace['link_map_info'](declaration, self.crate, self.toolchain)
        self.assertIs(info.artifact, self.output)
        self.assertIs(info.stdlib, self.toolchain.rust_std)
        self.assertEqual(info.rustc, self.toolchain.rustc)
        self.assertEqual(info.execution_host, 'aarch64-apple-darwin')

    def test_unsupported_or_detached_link_paths_refuse_before_declaration(self):
        self.assertIsNone(self.declaration())
        self.assertEqual(self.declared, [])
        for kwargs in [{'native': True, 'wasm': True}, {'wasm': True},
                       {'native': True, 'metadata_only': True}, {'native': True, 'cc_link': True}]:
            with self.assertRaises(ValueError): self.declaration(**kwargs)
        self.crate.is_test = True
        with self.assertRaises(ValueError): self.declaration(native=True)
        self.assertEqual(self.declared, [])


class RustLicenseMetadata(unittest.TestCase):
    def test_license_file_only_is_preserved_without_inventing_expression(self):
        manifest = b'[package]\nname="fixture"\nversion="1.0.0"\nlicense-file="COPYING"\n'
        expected = {'name': 'fixture', 'version': '1.0.0', 'license': None,
                    'repository': None, 'license_file': 'COPYING'}
        self.assertEqual(metadata.validate(expected, manifest), [])
    def test_published_registry_manifest_matches_effective_metadata(self):
        manifest = b'[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT OR Apache-2.0"\nrepository="https://example.invalid/source"\nlicense-file="legal/COPYING"\n'
        expected = {'name': 'fixture', 'version': '1.0.0', 'license': 'MIT OR Apache-2.0',
                    'repository': 'https://example.invalid/source', 'license_file': 'legal/COPYING'}
        self.assertEqual(metadata.validate(expected, manifest), [])
        for key in expected:
            with self.assertRaises(ValueError): metadata.validate(expected | {key: 'foreign'}, manifest)

    def test_workspace_inheritance_requires_declared_matching_workspace(self):
        manifest = b'[package]\nname="fixture"\nversion.workspace=true\nlicense.workspace=true\n'
        workspace = b'[workspace.package]\nversion="1.0.0"\nlicense="AGPL-3.0-only"\n'
        expected = {'name': 'fixture', 'version': '1.0.0', 'license': 'AGPL-3.0-only',
                    'repository': None, 'license_file': None}
        self.assertEqual(metadata.validate(expected, manifest, workspace), ['license', 'version'])
        for missing in [None, b'[workspace]\n', b'[workspace.package]\nversion="1.0.0"\n']:
            with self.assertRaises(ValueError): metadata.validate(expected, manifest, missing)

    def test_runner_carrier_cannot_load_undeclared_helpers_from_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = Path(directory) / 'tools/bazel/packaging/rust-license-metadata.py'
            runner.parent.mkdir(parents=True)
            runner.symlink_to(Path(__file__).with_name('rust-license-metadata.py').absolute())
            script = ("import importlib.util,sys; "
                      "s=importlib.util.spec_from_file_location('isolated_metadata',sys.argv[1]); "
                      "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                      "m.load_compiled_modules()")
            result = subprocess.run([sys.executable, '-B', '-I', '-c', script, str(runner)],
                                    capture_output=True, env={})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'FileNotFoundError', result.stderr)
            self.assertIn(str(Path(directory)).encode(), result.stderr)

    def test_isolated_loader_requires_declared_stdlib_module(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'tools/bazel'
            packaging = root / 'packaging'
            rust = root / 'rust'
            packaging.mkdir(parents=True)
            rust.mkdir()
            for source in Path(__file__).absolute().parent.glob('*.py'):
                (packaging / source.name).symlink_to(source)
            for source in Path(__file__).absolute().parent.parent.joinpath('rust').glob('*.py'):
                if source.name != 'stdlib_attribution.py':
                    (rust / source.name).symlink_to(source)
            runner = packaging / 'rust-license-metadata.py'
            script = ("import importlib.util,sys; "
                      "s=importlib.util.spec_from_file_location('isolated_metadata',sys.argv[1]); "
                      "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                      "m.load_compiled_modules()")
            result = subprocess.run([sys.executable, '-B', '-I', '-c', script, str(runner)],
                                    capture_output=True, env={'PATH': ''})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(str(rust / 'stdlib_attribution.py').encode(), result.stderr)
            self.assertIn(b'FileNotFoundError', result.stderr)

    def test_malformed_inheritance_and_missing_license_do_not_resolve(self):
        for manifest in [b'[package]\nname="fixture"\nversion="1"\n',
                         b'[package]\nname="fixture"\nversion.workspace=false\nlicense="MIT"\n',
                         b'[package]\nname.workspace=true\nversion="1"\nlicense="MIT"\n',
                         b'[package]\nname="fixture"\nversion="1"\nlicense=" "\n']:
            with self.assertRaises(ValueError): metadata.effective(manifest, b'[workspace.package]\nname="fixture"\nversion="1"\n')


class PublisherLicenseCustody(unittest.TestCase):
    def setUp(self):
        import io
        import tarfile
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.crate = self.root / 'crate'
        self.crate.mkdir()
        self.commit = '1' * 40
        self.identity = 'registry+https://github.com/rust-lang/crates.io-index#fixture@1.0.0'
        manifest = b'[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT"\nrepository="https://github.com/original/fixture"\n'
        (self.crate / 'Cargo.toml').write_bytes(manifest)
        (self.crate / 'Cargo.toml.orig').write_bytes(manifest)
        vcs = json.dumps({'git': {'sha1': self.commit}, 'path_in_vcs': 'crate'}).encode()
        (self.crate / '.cargo_vcs_info.json').write_bytes(vcs)
        members = {'Cargo.toml': b'[workspace]\n', 'crate/Cargo.toml': manifest,
                   'LICENSE': b'Original publisher fixture license text\n'}
        prefix = 'fixture-' + self.commit
        archive = self.root / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for name, data in members.items():
                member = tarfile.TarInfo(prefix + '/' + name)
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
        self.sources = {}
        def attach(role, path, label):
            self.sources[role] = {'input': str(path), 'label': label}
        attach('archive', archive, '//publisher:source.tar.gz')
        attach('vcs', self.crate / '.cargo_vcs_info.json', '//fixture:.cargo_vcs_info.json')
        attach('package_manifest', self.crate / 'Cargo.toml', '//fixture:Cargo.toml')
        for name, role in [('Cargo.toml', 'workspace_manifest'), ('crate/Cargo.toml', 'manifest'), ('LICENSE', 'license:LICENSE')]:
            path = self.root / 'publisher' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(members[name])
            attach(role, path, '//publisher:' + name)
        self.catalog = {'packages': {self.identity: {
            'archive_sha256': '2' * 64, 'license': 'MIT', 'source': 'original',
            'licenses': {'LICENSE': '//publisher:LICENSE'}, 'manifest': '//publisher:crate/Cargo.toml',
            'workspace_manifest': '//publisher:Cargo.toml', 'source_archive': '//publisher:source.tar.gz',
            'vcs_file': '//fixture:.cargo_vcs_info.json', 'vcs_path': 'crate',
            'vcs_sha256': hashlib.sha256(vcs).hexdigest()}},
            'sources': {'original': {'commit': self.commit, 'repository': 'original/fixture',
                'url': 'https://codeload.github.com/original/fixture/tar.gz/' + self.commit,
                'prefix': prefix, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'members': {name: {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in members.items()}}}}
        attach('catalog', self.root / 'catalog.json', '//publisher:catalog.json')
        self.package = {'id': self.identity, 'name': 'fixture', 'version': '1.0.0', 'license': 'MIT',
                        'source': 'registry+https://github.com/rust-lang/crates.io-index',
                        'archive_checksum': '2' * 64, 'repository': 'https://github.com/original/fixture'}
        spec = importlib.util.spec_from_file_location('publisher_inputs', Path(__file__).with_name('license-inputs.py'))
        self.inputs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.inputs)

    def tearDown(self):
        self.temporary.cleanup()

    def collect(self, catalog=None, package=None, sources=None):
        (self.root / 'catalog.json').write_text(json.dumps(self.catalog if catalog is None else catalog))
        return metadata.publisher_licenses(self.package if package is None else package,
            self.crate, '//fixture:Cargo.toml', self.sources if sources is None else sources, self.inputs)

    def test_original_archive_vcs_manifest_and_license_join(self):
        texts, original = self.collect()
        self.assertEqual(texts[0]['text'], 'Original publisher fixture license text\n')
        self.assertEqual(original['commit'], self.commit)
        self.assertEqual(len(original['files']), 7)
        self.assertFalse((self.crate / 'LICENSE').exists())

    def test_package_owned_license_text_cannot_be_replaced(self):
        with self.assertRaises(ValueError):
            self.collect(package=self.package | {'license_file': 'legal/COPYING'})
        for name in ['LICENSE', 'Copying.txt', 'NOTICE', 'Unlicense']:
            original = self.crate / name
            original.write_text('Original crate-owned text\n')
            with self.subTest(name=name), self.assertRaises(ValueError): self.collect()
            original.unlink()
        original = self.crate / 'LICENSE'
        original.symlink_to(self.root / 'publisher/LICENSE')
        with self.assertRaises(ValueError): self.collect()

    def test_notice_collector_preserves_original_publisher_file_join(self):
        self.collect()
        descriptor = {
            'configuration': {'compiler_root': 'fixture', 'target': 'aarch64-apple-darwin'},
            'roots': ['root'], 'units': {'root': {'pkg_id': self.identity, 'dependencies': []}},
            'packages': {self.identity: self.package | {'license_file': None}},
            'package_sources': {self.identity: '//fixture:package_data'},
            'package_manifests': {self.identity: '//fixture:Cargo.toml'},
        }
        path = self.root / 'descriptor.json'
        path.write_text(json.dumps(descriptor))
        workspace = self.root / 'Cargo.toml'
        workspace.write_text('[workspace]\n')
        (self.root / 'LICENSE').write_text('Original repository license\n')
        _, notices, _, _ = metadata.load_compiled_modules()
        result = notices.collect({
            'descriptor': str(path), 'compiler_root': 'fixture', 'target': 'aarch64-apple-darwin',
            'workspace_manifest': str(workspace), 'workspace_license': str(self.root / 'LICENSE'),
            'packages': {self.identity: {'root': str(self.crate), 'source_label': '//fixture:package_data',
                'manifest_label': '//fixture:Cargo.toml', 'publisher_sources': self.sources}},
        })
        component = result['components'][0]
        self.assertEqual(component['texts'][0]['label'], '//publisher:LICENSE')
        self.assertEqual(component['publisher_source']['commit'], self.commit)
        self.assertEqual(len(component['publisher_source']['files']), 7)

    def test_foreign_crate_pin_commit_path_and_file_roles_refuse(self):
        for field, value in [('archive_checksum', '3' * 64), ('license', 'Apache-2.0'), ('id', 'foreign'), ('repository', 'https://github.com/foreign/fixture')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.collect(package=self.package | {field: value})
        for role in ['archive', 'manifest', 'workspace_manifest', 'vcs', 'package_manifest', 'license:LICENSE']:
            sources = copy.deepcopy(self.sources)
            sources[role]['label'] = '//foreign:input'
            with self.subTest(role=role), self.assertRaises(ValueError): self.collect(sources=sources)
        for field, value in [('commit', '4' * 40), ('prefix', 'foreign'), ('sha256', '5' * 64)]:
            catalog = copy.deepcopy(self.catalog)
            catalog['sources']['original'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.collect(catalog=catalog)

    def test_mutated_license_original_manifest_and_foreign_vcs_tree_refuse(self):
        for role in ['license:LICENSE', 'manifest', 'workspace_manifest', 'archive']:
            path = Path(self.sources[role]['input'])
            original = path.read_bytes()
            path.write_bytes(original + b'changed')
            with self.subTest(role=role), self.assertRaises(ValueError): self.collect()
            path.write_bytes(original)
        (self.crate / 'Cargo.toml.orig').write_bytes(b'foreign original manifest')
        with self.assertRaises(ValueError): self.collect()
        (self.crate / 'Cargo.toml.orig').write_bytes((self.crate / 'Cargo.toml').read_bytes())
        outside = self.root / '.cargo_vcs_info.json'
        outside.write_bytes((self.crate / '.cargo_vcs_info.json').read_bytes())
        sources = copy.deepcopy(self.sources)
        sources['vcs']['input'] = str(outside)
        with self.assertRaises(ValueError): self.collect(sources=sources)


class MaintainedPatchCustody(unittest.TestCase):
    def setUp(self):
        import difflib
        import io
        import tarfile
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.crate = self.root / 'crate'
        self.crate.mkdir()
        self.original = b'fn main() {\n    original();\n}\n'
        self.patched = b'fn main() {\n    declared();\n}\n'
        self.manifest = b'[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT"\n'
        self.vcs = json.dumps({'git': {'sha1': '1' * 40}, 'path_in_vcs': 'crates/shared'}).encode()
        self.archive = self.root / 'original.crate'
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data in {'build.rs': self.original, 'Cargo.toml': self.manifest, '.cargo_vcs_info.json': self.vcs}.items():
                member = tarfile.TarInfo('fixture-1.0.0/' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        self.patch = self.root / 'maintained.patch'
        self.patch.write_text(''.join(difflib.unified_diff(self.original.decode().splitlines(True), self.patched.decode().splitlines(True),
            fromfile='a/registry/fixture-1.0.0/build.rs', tofile='b/registry/fixture-1.0.0/build.rs')))
        for name, data in {'build.rs': self.patched, 'Cargo.toml': self.manifest, '.cargo_vcs_info.json': self.vcs}.items():
            (self.crate / name).write_bytes(data)
        self.license = self.root / 'LICENSE'
        self.license.write_text('Original workspace AGPL license text\n')
        self.sources = {role: {'input': str(path), 'label': label} for role, path, label in [
            ('archive', self.archive, '@original//:fixture.crate'), ('patch', self.patch, '//workspace:maintained.patch'),
            ('source', self.crate / 'build.rs', '@original//registry/fixture-1.0.0:build.rs'),
            ('vcs', self.crate / '.cargo_vcs_info.json', '@original//registry/fixture-1.0.0:.cargo_vcs_info.json')]}
        self.package = {'name': 'fixture', 'version': '1.0.0', 'source': 'registry+https://github.com/rust-lang/crates.io-index',
                        'archive_checksum': hashlib.sha256(self.archive.read_bytes()).hexdigest()}
        spec = importlib.util.spec_from_file_location('patch_inputs', Path(__file__).with_name('license-inputs.py'))
        self.inputs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.inputs)

    def collect(self, sources=None, package=None):
        return metadata.maintained_patch(self.package if package is None else package, self.crate,
            self.sources if sources is None else sources, self.license, self.inputs)

    def test_original_patch_and_actual_compiler_bytes_are_bound(self):
        patch, license = self.collect()
        self.assertEqual(patch['original']['sha256'], hashlib.sha256(self.original).hexdigest())
        self.assertEqual(patch['files']['source']['sha256'], hashlib.sha256(self.patched).hexdigest())
        self.assertEqual(patch['revision'], '1' * 40)
        self.assertEqual(patch['license'], 'AGPL-3.0-only')
        self.assertEqual(license['text'], self.license.read_text())

    def test_original_archive_patch_member_and_source_mutations_refuse(self):
        for role in self.sources:
            path = Path(self.sources[role]['input'])
            original = path.read_bytes()
            path.write_bytes(original + b'changed')
            with self.subTest(role=role), self.assertRaises(ValueError): self.collect()
            path.write_bytes(original)
        with self.assertRaises(ValueError): self.collect(package=self.package | {'archive_checksum': '0' * 64})
        sources = copy.deepcopy(self.sources)
        sources['patch']['label'] = '@foreign//:maintained.patch'
        with self.assertRaises(ValueError): self.collect(sources=sources)
        sources = copy.deepcopy(self.sources)
        del sources['vcs']
        with self.assertRaises(ValueError): self.collect(sources=sources)
        self.patch.write_bytes(self.patch.read_bytes().replace(b'fixture-1.0.0/build.rs', b'foreign/build.rs'))
        with self.assertRaises(ValueError): self.collect()

    def test_hunk_context_counts_and_unchanged_source_refuse(self):
        original = self.patch.read_bytes()
        for changed in [original.replace(b'@@ -1,3 +1,3 @@', b'@@ -1,2 +1,3 @@'),
                        original.replace(b'-    original();', b'-    unrelated();'), original + b'--- a/foreign\n']:
            self.patch.write_bytes(changed)
            with self.assertRaises(ValueError): self.collect()
        self.patch.write_bytes(original)
        (self.crate / 'build.rs').write_bytes(self.original)
        with self.assertRaises(ValueError): self.collect()


class CompiledRustCustody(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        previous = Path.cwd()
        os.chdir(directory.name)
        self.addCleanup(os.chdir, previous)
        self.root = Path(".")
        self.units, self.notices, self.closure, self.stock = metadata.load_compiled_modules()
        self.package = self.root / 'package'
        self.package.mkdir()
        (self.package / 'Cargo.toml').write_text('[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT"\nedition="2024"\n')
        (self.package / 'LICENSE').write_text('Original package license text\n')
        (self.package / 'main.rs').write_text('fn main() {}\n')
        self.workspace = self.root / 'Cargo.toml'
        self.workspace.write_text('[workspace]\n')
        (self.root / 'LICENSE').write_text('Original repository license text\n')
        self.artifact = self.root / 'bin/fixture'
        self.artifact.parent.mkdir()
        self.artifact.write_bytes(b'actual fixture compiler output')
        self.artifact.chmod(0o555)
        profile = {'name': 'release', 'opt_level': '3', 'debuginfo': 0, 'debug_assertions': False,
                   'overflow_checks': False, 'panic': 'unwind', 'codegen_units': None, 'lto': 'false', 'rpath': False}
        package = {'id': 'fixture', 'name': 'fixture', 'version': '1.0.0', 'license': 'MIT', 'license_file': None,
                   'repository': None, 'source': None, 'archive_checksum': None, 'authors': [], 'features': {},
                   'description': None, 'homepage': None, 'rust_version': None, 'manifest': None}
        unit = {'pkg_id': 'fixture', 'dependencies': [], 'features': [], 'compiler': '1.97.1',
                'platform': 'aarch64-apple-darwin', 'execution_host': 'aarch64-apple-darwin',
                'mode': 'build', 'emit_cdylib': False, 'profile': profile, 'rust_flags': [],
                'target': {'name': 'fixture', 'edition': '2024', 'src_path': 'main.rs', 'crate_types': ['bin'], 'kind': ['bin']}}
        self.descriptor = {'roots': ['selected'], 'units': {'selected': unit}, 'packages': {'fixture': package},
                           'configuration': {'compiler_root': 'fixture/release/aarch64-apple-darwin', 'target': 'aarch64-apple-darwin'},
                           'package_sources': {'fixture': '//fixture:package_data'}, 'package_manifests': {'fixture': '//fixture:Cargo.toml'}}
        self.descriptor_path = self.root / 'descriptor.json'
        self.descriptor_path.write_text(json.dumps(self.descriptor))
        files = [{'input': str(path), 'label': '//fixture:' + path.name} for path in sorted(self.package.iterdir())]
        record = {'unit': 'selected', 'rule': 'rust_binary', 'dependencies': [], 'aliases': {}, 'features': [],
                  'version': '1.0.0', 'compiler': {'version': '1.97.1', 'target': 'aarch64-apple-darwin'},
                  'crate_name': 'fixture', 'crate_type': 'bin', 'edition': '2024', 'lint_config': None,
                  'rustc_flags': self.units.flags(profile) + ['--check-cfg=cfg(feature,values())', '--cap-lints=allow'],
                  'environment': {'CARGO_PKG_NAME': 'fixture', 'CARGO_PKG_AUTHORS': '', 'CARGO_PKG_DESCRIPTION': '',
                                  'CARGO_PKG_HOMEPAGE': '', 'CARGO_PKG_REPOSITORY': '', 'CARGO_PKG_LICENSE': 'MIT', 'CARGO_PKG_RUST_VERSION': '', 'CARGO_MANIFEST_DIR': '$${pwd}/' + str(self.package)},
                  'root': str(self.package / 'main.rs'), 'inputs': [{'input': str(self.package / 'main.rs'), 'label': '//fixture:main.rs', 'tree': False}], 'stdlib': []}
        packages = {'fixture': {'root': str(self.package), 'source_label': '//fixture:package_data',
                                'manifest_label': '//fixture:Cargo.toml', 'manifest': str(self.package / 'Cargo.toml'), 'files': files}}
        intermediate = self.notices.collect({'descriptor': str(self.descriptor_path),
            'compiler_root': self.descriptor['configuration']['compiler_root'], 'target': 'aarch64-apple-darwin',
            'packages': {'fixture': {key: packages['fixture'][key] for key in ['root', 'source_label', 'manifest_label']}},
            'workspace_manifest': str(self.workspace), 'workspace_license': str(self.root / 'LICENSE')})
        self.intermediate = self.root / 'intermediate.json'
        self.intermediate.write_bytes(self.closure.canonical(intermediate))
        self.value = {'producer': '//fixture:u_selected', 'artifact': {'input': str(self.artifact), 'label': '//fixture:u_selected'},
                      'descriptor': str(self.descriptor_path), 'intermediate': str(self.intermediate), 'compiler_root': 'selected',
                      'target': 'aarch64-apple-darwin', 'units': [record], 'packages': packages,
                      'stdlib_notices': {'input': 'stdlib.json', 'label': '//fixture:stdlib',
                                          'notices': {'input': 'stdlib-notices', 'label': '//fixture:stdlib'}},
                      'workspace_manifest': str(self.workspace), 'workspace_license': str(self.root / 'LICENSE')}
        # Controlled collector contract data, not evidence of a compiler or mapper action.
        self.stdfile = self.root / 'stock/lib/rustlib/aarch64-apple-darwin/lib/libstd.rlib'
        self.stdfile.parent.mkdir(parents=True)
        self.stdfile.write_bytes(b'explicit synthetic standard-library callback input')
        self.value['units'][0]['stdlib'] = [{'input': str(self.stdfile), 'label': '@stock//:files'}]
        self.mapping = self.root / 'native.map'
        self.mapping.write_bytes(b'explicit synthetic already-produced link-map callback input')
        self.compiler = self.root / 'stock/bin/rustc'
        self.compiler.parent.mkdir(parents=True)
        self.compiler.write_bytes(b'explicit synthetic already-produced compiler File input')
        self.compiler.chmod(0o555)
        self.notices_tree = self.root / 'stdlib-notices'
        self.notices_tree.mkdir()
        for name, content in {'COPYRIGHT-library.html': b'<html>Explicit synthetic Rust notice fixture</html>',
                              'LICENSE-MIT': b'Explicit synthetic MIT notice fixture',
                              'LICENSE-APACHE': b'Explicit synthetic Apache notice fixture'}.items():
            (self.notices_tree / name).write_bytes(content)
        self.stock_inventory = {
            'kind': 'linked-stdlib-source-attribution', 'producer': '//fixture:u_selected',
            'compiler': '1.97.1', 'target': self.value['target'], 'execution_host': self.value['target'], 'pending_scopes': [],
            'rustc': self.input_fact(self.compiler, '@stock//:rustc'),
            'artifact': self.input_fact(self.artifact, '//fixture:u_selected'),
            'link_map': self.input_fact(self.mapping, '//fixture:u_selected'),
            'source_archive': {'sha256': self.stock.SOURCE_SHA256, 'label': '@stock_source//:archive'},
            'stdlib_archive': {'sha256': self.stock.DISTRIBUTIONS[self.value['target']][0], 'label': '@stock_std//:archive'},
            'rustc_archive': {'sha256': self.stock.DISTRIBUTIONS[self.value['target']][1], 'label': '@stock_rustc//:archive'},
            'selected_stdlib': [self.input_fact(self.stdfile, '@stock//:files')],
            'source_members': {item.name: self.stock.fact(item.read_bytes()) for item in self.notices_tree.iterdir()},
            'selected_packages': [], 'selected_dependency_notices': [],
        }
        self.publish_stock_fixture()
        self.standard = self.stock.collect_compiled_stdlib

    def input_fact(self, path, label):
        data = path.read_bytes()
        return {'path': str(path), 'label': label, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def publish_stock_fixture(self):
        Path('stdlib.json').write_text(json.dumps(self.stock_inventory))

    def collect(self, value=None, standard=None):
        return metadata.collect_compiled(value or self.value, self.units, self.notices, self.closure, standard or self.standard)

    def compiler_carrier(self):
        producer = self.root / 'engine'
        carrier = self.root / 'sandbox'
        relative = Path('bazel-out/generated/tree')
        original = producer / relative
        original.mkdir(parents=True)
        (original / '.empty').write_bytes(b'')
        (original / 'module.rs').write_bytes(b'pub const GENERATED: u8 = 1;\n')
        shown = carrier / relative
        shown.mkdir(parents=True)
        for child in original.iterdir():
            (shown / child.name).symlink_to(child.absolute())
        context = Path('bazel-out/producer.json')
        (producer / context).write_bytes(b'actual fixture generated context')
        (carrier / context).symlink_to((producer / context).absolute())
        record = {'selected': {'inputs': [{'input': str(relative), 'label': '@@//fixture:generated', 'tree': True}]}}
        return producer.absolute(), carrier.absolute(), original.absolute(), shown.absolute(), context, record

    def test_exact_compiler_tree_carrier_retains_empty_original_source_bytes(self):
        producer, carrier, original, shown, context, records = self.compiler_carrier()
        os.chdir(carrier)
        facts = metadata.compiler_input_facts(records, self.notices.license_inputs, str(context))
        self.assertEqual([fact['path'] for fact in facts],
                         ['bazel-out/generated/tree/.empty', 'bazel-out/generated/tree/module.rs'])
        self.assertEqual(facts[0]['size'], 0)
        self.assertEqual(facts[0]['sha256'], hashlib.sha256(b'').hexdigest())
        deployment = self.stock.load('strict_empty_shipping',
                                     Path(metadata.__file__).with_name('deployment-pack.py'))
        owned = deployment.DeclaredInputs()
        try:
            with self.assertRaisesRegex(ValueError, 'nonempty safe regular'):
                owned.file(original.absolute() / '.empty')
            with self.assertRaisesRegex(ValueError, 'nonempty safe regular'):
                deployment.declared_tree({'input': records['selected']['inputs'][0]['input'],
                                          'label': '@@//fixture:generated'}, 'shipping',
                                         producer.absolute(), owned)
        finally:
            owned.close()

    def test_compiler_tree_carrier_foreign_missing_and_original_alias_refuse(self):
        producer, carrier, original, shown, context, records = self.compiler_carrier()
        producer, original, shown = producer.absolute(), original.absolute(), shown.absolute()
        foreign = self.root / 'foreign.rs'
        foreign.write_bytes((original / 'module.rs').read_bytes())
        foreign = foreign.absolute()
        os.chdir(carrier)
        selected = shown / 'module.rs'
        selected.unlink()
        selected.symlink_to(foreign)
        with self.assertRaisesRegex(ValueError, 'redirects a declared producer member'):
            metadata.compiler_input_facts(records, self.notices.license_inputs, str(context))
        selected.unlink()
        with self.assertRaisesRegex(ValueError, 'exact producer membership'):
            metadata.compiler_input_facts(records, self.notices.license_inputs, str(context))
        selected.symlink_to(original / 'module.rs')
        (original / 'module.rs').unlink()
        (original / 'module.rs').symlink_to(foreign)
        with self.assertRaisesRegex(ValueError, 'link or special member'):
            metadata.compiler_input_facts(records, self.notices.license_inputs, str(context))

    def test_compiler_tree_carrier_change_during_capture_refuses(self):
        producer, carrier, original, shown, context, records = self.compiler_carrier()
        foreign = (self.root / 'foreign.rs').absolute()
        foreign.write_bytes((original / 'module.rs').read_bytes())
        (carrier / 'trigger.rs').write_bytes(b'pub fn trigger() {}')
        records['selected']['inputs'].append({'input': 'trigger.rs', 'label': '//fixture:trigger', 'tree': False})
        os.chdir(carrier)
        read = self.notices.license_inputs.read_regular
        def change_alias(root, name, **kwargs):
            data = read(root, name, **kwargs)
            if name == 'trigger.rs':
                selected = shown / 'module.rs'
                selected.unlink()
                selected.symlink_to(foreign)
            return data
        with patch.object(self.notices.license_inputs, 'read_regular', change_alias):
            with self.assertRaisesRegex(ValueError, 'engine input presentation changed'):
                metadata.compiler_input_facts(records, self.notices.license_inputs, str(context))

    def test_original_stdlib_callback_retains_validated_same_action_inventory(self):
        artifact = metadata.file_fact(self.value['artifact'], self.notices.license_inputs)
        records = {record['unit']: record for record in self.value['units']}
        original = self.standard(self.value['stdlib_notices'], artifact,
                                 self.value['target'], records, self.notices.license_inputs)
        self.assertEqual(original['linkage'], self.stock_inventory)
        self.assertEqual(original['linkage']['artifact'], artifact)
        changed = copy.deepcopy(self.stock_inventory)
        changed['link_map']['sha256'] = '0' * 64
        Path('stdlib.json').write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, 'link map changed'):
            self.standard(self.value['stdlib_notices'], artifact,
                          self.value['target'], records, self.notices.license_inputs)

    def test_original_canonical_main_compiler_label_keeps_exact_custody(self):
        producer = '@@//fixture:u_selected'
        self.value['producer'] = producer
        self.value['artifact']['label'] = producer
        self.stock_inventory['producer'] = producer
        self.stock_inventory['artifact']['label'] = producer
        self.stock_inventory['link_map']['label'] = producer
        self.publish_stock_fixture()
        configuration, source, inventory, text = self.collect()
        selected = json.loads(inventory)
        self.assertEqual(json.loads(configuration)['producer'], producer)
        self.assertEqual(json.loads(source)['producer'], producer)
        self.assertEqual(selected['producer'], producer)
        self.assertEqual(selected['artifacts'][0]['label'], producer)
        self.assertEqual(text, self.closure.render(selected))
        self.value['producer'] = '@//fixture:u_selected'
        with self.assertRaisesRegex(ValueError, 'producer schema'):
            self.collect()

    def test_configuration_sources_and_artifact_are_bound_to_original_bytes(self):
        configuration, source, inventory, text = self.collect()
        selected = json.loads(inventory)
        self.assertEqual(selected['configuration'], hashlib.sha256(configuration).hexdigest())
        self.assertEqual(selected['source_digest'], hashlib.sha256(source).hexdigest())
        self.assertEqual(selected['artifacts'][0], {'label': '//fixture:u_selected', 'path': 'fixture', 'mode': '0555',
            'size': len(self.artifact.read_bytes()), 'sha256': hashlib.sha256(self.artifact.read_bytes()).hexdigest()})
        self.assertEqual(text, self.closure.render(selected))
        self.assertIn(b'Original package license text', text)
        self.artifact.chmod(0o644)
        self.artifact.write_bytes(b'changed compiled output')
        self.artifact.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'another original compiler artifact'):
            self.collect()
        self.stock_inventory['artifact'] = self.input_fact(self.artifact, '//fixture:u_selected')
        self.publish_stock_fixture()
        changed = json.loads(self.collect()[2])
        self.assertNotEqual(changed['artifacts'], selected['artifacts'])

    def test_actual_compiler_configuration_mutations_refuse(self):
        mutations = [('compiler', {'version': 'foreign', 'target': 'aarch64-apple-darwin'}),
                     ('features', ['foreign']), ('dependencies', ['foreign']), ('crate_type', 'rlib'),
                     ('edition', '2021'), ('version', '2.0.0'), ('rustc_flags', ['-Copt-level=0'])]
        for field, replacement in mutations:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.value)
                changed['units'][0][field] = replacement
                with self.assertRaises(ValueError): self.collect(changed)
        changed = copy.deepcopy(self.value)
        changed['units'][0]['environment']['RUSTC_BOOTSTRAP'] = '1'
        with self.assertRaises(ValueError): self.collect(changed)
        changed = copy.deepcopy(self.value)
        changed['units'].append(copy.deepcopy(changed['units'][0]))
        with self.assertRaises(ValueError): self.collect(changed)

    def test_maintained_revision_environment_requires_original_patch_join(self):
        descriptor = copy.deepcopy(self.descriptor)
        descriptor['packages']['fixture']['name'] = 'wasm-bindgen-shared'
        run = copy.deepcopy(descriptor['units']['selected'])
        run['mode'] = 'run-custom-build'
        descriptor['units']['run'] = run
        descriptor['units']['selected']['dependencies'] = [{'unit': 'run', 'extern_crate_name': 'build_script'}]
        compiler = copy.deepcopy(self.value['units'][0])
        compiler['dependencies'] = ['run']
        compiler['environment']['CARGO_PKG_NAME'] = 'wasm-bindgen-shared'
        runner = copy.deepcopy(compiler)
        runner.update({'unit': 'run', 'rule': 'cargo_build_script', 'dependencies': [],
                       'package_name': 'wasm-bindgen-shared', 'rundir': str(self.package), 'rustc_flags': []})
        runner['environment'].update({'CARGO_MANIFEST_DIR': str(self.package), 'OPT_LEVEL': '3',
            'PROFILE': 'release', 'DEBUG': 'false', 'MERKUR_WASM_BINDGEN_REVISION': '1' * 40})
        def validate(patches):
            return metadata.validate_compiler_graph(descriptor, [compiler, runner], 'selected', self.value['target'],
                self.units.flags, {'fixture': str(self.package / 'Cargo.toml')}, self.units.custom_cfg_env, patches)
        self.assertEqual(set(validate({'fixture': {'revision': '1' * 40}})), {'run', 'selected'})
        with self.assertRaises(ValueError): validate(None)
        runner['environment']['MERKUR_WASM_BINDGEN_REVISION'] = '2' * 40
        with self.assertRaises(ValueError): validate({'fixture': {'revision': '1' * 40}})
        runner['environment']['MERKUR_WASM_BINDGEN_REVISION'] = '1' * 40
        runner['environment']['UNDECLARED'] = 'not allowed'
        with self.assertRaises(ValueError): validate({'fixture': {'revision': '1' * 40}})

    def test_maintained_patch_requires_actual_compiler_input(self):
        fixture = MaintainedPatchCustody()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        for name in ['Cargo.toml', 'build.rs', '.cargo_vcs_info.json']:
            (self.package / name).write_bytes((fixture.crate / name).read_bytes())
        package = self.descriptor['packages']['fixture']
        package.update({'source': fixture.package['source'], 'archive_checksum': fixture.package['archive_checksum']})
        self.descriptor_path.write_text(json.dumps(self.descriptor))
        sources = copy.deepcopy(fixture.sources)
        for role, name in [('source', 'build.rs'), ('vcs', '.cargo_vcs_info.json')]:
            sources[role]['input'] = str(self.package / name)
        self.value['packages']['fixture']['source_patches'] = sources
        self.value['packages']['fixture']['files'] = [{'input': str(path), 'label': '//fixture:' + path.name} for path in self.package.iterdir()]
        self.value['units'][0]['inputs'].append({'input': str(self.package / 'build.rs'), 'label': '//fixture:build.rs', 'tree': False})
        original = self.notices.collect({'descriptor': str(self.descriptor_path),
            'compiler_root': self.descriptor['configuration']['compiler_root'], 'target': self.value['target'],
            'packages': {'fixture': {key: self.value['packages']['fixture'][key] for key in ['root', 'source_label', 'manifest_label', 'source_patches']}},
            'workspace_manifest': str(self.workspace), 'workspace_license': str(self.root / 'LICENSE')})
        self.intermediate.write_bytes(self.closure.canonical(original))
        source = json.loads(self.collect()[1])
        self.assertEqual(source['source_patches']['fixture']['files']['source']['sha256'], hashlib.sha256(fixture.patched).hexdigest())
        self.value['units'][0]['inputs'].pop()
        with self.assertRaisesRegex(ValueError, 'absent from actual compiler inputs'): self.collect()

    def test_manifest_license_intermediate_and_artifact_owner_mutations_refuse(self):
        original = self.intermediate.read_bytes()
        altered = json.loads(original)
        altered['components'][0]['license'] = 'foreign'
        self.intermediate.write_bytes(self.closure.canonical(altered))
        with self.assertRaises(ValueError): self.collect()
        self.intermediate.write_bytes(original)
        (self.package / 'LICENSE').write_text('Changed published license')
        with self.assertRaises(ValueError): self.collect()
        (self.package / 'LICENSE').write_text('Original package license text\n')
        changed = copy.deepcopy(self.value)
        changed['artifact']['label'] = '//foreign:binary'
        with self.assertRaises(ValueError): self.collect(changed)
        changed = copy.deepcopy(self.value)
        changed['packages']['fixture']['source_label'] = '//foreign:package_data'
        with self.assertRaises(ValueError): self.collect(changed)
        self.artifact.chmod(0o444)
        with self.assertRaises(ValueError): self.collect()

    def test_callback_receives_original_artifact_before_basename_publication(self):
        calls = []
        def observe(value, artifact, target, records, inputs):
            calls.append((value, dict(artifact), target))
            return self.stock.collect_compiled_stdlib(value, artifact, target, records, inputs)
        selected = json.loads(self.collect(standard=observe)[2])
        self.assertEqual(calls[0][1]['path'], 'bin/fixture')
        self.assertEqual(calls[0][0], self.value['stdlib_notices'])
        self.assertEqual(selected['artifacts'][0]['path'], 'fixture')
        self.assertEqual(selected['pending_scopes'], [])
        self.assertIn('rust-stdlib@1.97.1#aarch64-apple-darwin', {item['id'] for item in selected['components']})

    def test_pending_foreign_artifact_and_target_stdlib_proofs_refuse(self):
        original = copy.deepcopy(self.stock_inventory)
        for key, value in [('pending_scopes', ['stdlib-source-license-selection']),
                           ('target', 'x86_64-apple-darwin'),
                           ('artifact', {**original['artifact'], 'label': '//foreign:binary'})]:
            with self.subTest(key=key):
                self.stock_inventory = {**original, key: value}
                self.publish_stock_fixture()
                with self.assertRaises(ValueError):
                    self.collect()
        self.stock_inventory = original
        self.publish_stock_fixture()

    def test_original_compiler_file_custody_refuses_absent_or_mutated_bytes(self):
        original = copy.deepcopy(self.stock_inventory)
        self.stock_inventory.pop('rustc')
        self.publish_stock_fixture()
        with self.assertRaisesRegex(ValueError, 'compiler File custody'):
            self.collect()
        self.stock_inventory = original
        self.publish_stock_fixture()
        self.compiler.chmod(0o644)
        self.compiler.write_bytes(b'changed original compiler File')
        self.compiler.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'compiler File changed'):
            self.collect()

    def test_nested_notice_tree_owner_and_byte_mismatch_refuse(self):
        changed = copy.deepcopy(self.value)
        changed['stdlib_notices']['notices']['label'] = '//foreign:notice_tree'
        with self.assertRaisesRegex(ValueError, 'another producer'):
            self.collect(changed)
        changed = copy.deepcopy(self.value)
        changed['stdlib_notices'].pop('notices')
        with self.assertRaisesRegex(ValueError, 'inventory and notice Tree'):
            self.collect(changed)
        (self.notices_tree / 'LICENSE-MIT').write_bytes(b'changed original notice')
        with self.assertRaisesRegex(ValueError, 'membership/bytes mismatch'):
            self.collect()

    def test_isolated_real_cli_loads_same_callback_and_publishes_same_four_files(self):
        Path('request.json').write_text(json.dumps(self.value))
        destinations = ['configuration.json', 'sources.json', 'inventory.json', 'NOTICES']
        result = subprocess.run([sys.executable, '-B', '-I', str(Path(metadata.__file__).absolute()),
                                 '--compiled', 'request.json', *destinations],
                                capture_output=True, env={'PATH': ''})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual([Path(path).read_bytes() for path in destinations], list(self.collect()))

    def test_generated_input_alias_refuses_and_regular_byte_changes_rekey(self):
        generated = self.root / 'generated'
        generated.mkdir()
        (generated / 'generated.rs').write_text('pub const VALUE: u8 = 1;')
        self.value['units'][0]['inputs'].append({'input': str(generated), 'label': '//fixture:build_script', 'tree': True})
        before = self.collect()[1]
        (generated / 'generated.rs').write_text('pub const VALUE: u8 = 2;')
        self.assertNotEqual(before, self.collect()[1])
        (generated / 'generated.rs').unlink()
        (generated / 'generated.rs').symlink_to(self.package / 'main.rs')
        with self.assertRaises(ValueError): self.collect()

    def wasm_fixture(self):
        """Collector-contract data only; no Rust/linker execution is represented."""
        native_standard = self.standard(self.value['stdlib_notices'],
            self.input_fact(self.artifact, self.value['producer']), self.value['target'],
            {'selected': self.value['units'][0]}, self.notices.license_inputs)
        self.value['target'] = 'wasm32-unknown-unknown'
        self.value['proc_macro_notices'] = []
        self.descriptor['configuration']['target'] = self.value['target']
        unit = self.descriptor['units']['selected']
        unit['platform'] = self.value['target']
        unit['emit_cdylib'] = True
        unit['target']['crate_types'] = ['cdylib']
        unit['target']['kind'] = ['cdylib']
        record = self.value['units'][0]
        record['compiler']['target'] = self.value['target']
        record['crate_type'] = 'cdylib'
        record['rule'] = 'rust_shared_library'
        self.artifact.chmod(0o644)
        self.artifact.write_bytes(b'\0asm\1\0\0\0')
        self.descriptor_path.write_text(json.dumps(self.descriptor))
        original = self.notices.collect({'descriptor': str(self.descriptor_path),
            'compiler_root': self.descriptor['configuration']['compiler_root'], 'target': self.value['target'],
            'packages': {'fixture': {key: self.value['packages']['fixture'][key] for key in ['root', 'source_label', 'manifest_label']}},
            'workspace_manifest': str(self.workspace), 'workspace_license': str(self.root / 'LICENSE')})
        self.intermediate.write_bytes(self.closure.canonical(original))
        wasm_std = self.root / 'stock/lib/rustlib/wasm32-unknown-unknown/lib/libstd.rlib'
        wasm_std.parent.mkdir(parents=True)
        wasm_std.write_bytes(self.stdfile.read_bytes())
        self.stdfile = wasm_std
        record['stdlib'] = [{'input': str(self.stdfile), 'label': '@stock//:files'}]
        self.linkage = {**self.stock_inventory, 'target': self.value['target'],
                        'artifact': self.input_fact(self.artifact, self.value['producer']),
                        'selected_stdlib': [self.input_fact(self.stdfile, '@stock//:files')]}
        self.linkage['selected_stdlib'][0]['members'] = {'synthetic.o': {'size': 1, 'sha256': 'a' * 64}}
        for name in ('source_archive', 'stdlib_archive', 'rustc_archive', 'graph'):
            path = Path('synthetic-wasm.' + name)
            path.write_bytes(('Explicit controlled original ' + name).encode())
            self.linkage[name] = self.input_fact(path, '@synthetic//:' + name)
        self.standard = lambda *_: {'sources': [self.input_fact(self.stdfile, '@stock//:files')],
                                   'components': native_standard['components'], 'linkage': self.linkage}

    def test_wasm_module_source_context_and_same_action_linkage_bound(self):
        self.wasm_fixture()
        configuration, source, inventory, text = self.collect()
        selected = json.loads(inventory)
        self.assertEqual(selected['kind'], 'selected-wasm-rust-attribution')
        self.assertEqual(selected['artifacts'][0]['mode'], '0444')
        self.assertEqual(json.loads(configuration)['kind'], 'configured-wasm-rust-release')
        self.assertEqual(json.loads(source)['module_linkage'], self.linkage)
        self.assertEqual(json.loads(source)['host_proc_macros'], [])
        self.assertEqual(text, self.closure.render(selected))
        self.artifact.write_bytes(b'not an original WASM module')
        with self.assertRaisesRegex(ValueError, 'binary module'): self.collect()

    def test_wasm_missing_map_stdlib_or_pending_linkage_refuses(self):
        self.wasm_fixture()
        baseline = copy.deepcopy(self.linkage)
        for key, replacement in [('target', 'foreign'), ('execution_host', 'foreign'),
                                 ('selected_stdlib', []), ('pending_scopes', ['stdlib']),
                                 ('artifact', {**baseline['artifact'], 'label': '//foreign:module'})]:
            self.linkage = {**baseline, key: replacement}
            with self.subTest(key=key):
                with self.assertRaises(ValueError): self.collect()
        self.linkage = baseline
        self.mapping.write_bytes(b'changed original linker map')
        with self.assertRaisesRegex(ValueError, 'linker/compiler/source File changed'): self.collect()

    def test_wasm_loaded_proc_macro_cannot_omit_host_source_runtime_notices(self):
        self.wasm_fixture()
        record = copy.deepcopy(self.value['units'][0])
        record.update({'unit': 'macro', 'crate_type': 'proc-macro',
                       'artifact': {'input': 'actual-host-macro', 'label': '//fixture:u_macro'}})
        with self.assertRaisesRegex(ValueError, 'omits a loaded compiler artifact'):
            metadata.proc_macro_sources([], {'macro': record}, self.closure, self.notices.license_inputs)
        record.pop('artifact')
        with self.assertRaisesRegex(ValueError, 'output File is required'):
            metadata.proc_macro_sources([], {'macro': record}, self.closure, self.notices.license_inputs)

    def test_actual_host_proc_macro_output_graph_runtime_and_notices_join(self):
        # Explicit controlled compiler/linker callback inputs, never a claim of
        # executed native compiler/proc-macro code or genuine distribution data.
        unit = self.descriptor['units']['selected']
        unit['target']['kind'] = ['proc-macro']
        unit['target']['crate_types'] = ['proc-macro']
        record = self.value['units'][0]
        record.update({'crate_type': 'proc-macro', 'rule': 'rust_proc_macro',
                       'artifact': copy.deepcopy(self.value['artifact'])})
        self.descriptor_path.write_text(json.dumps(self.descriptor))
        original = self.notices.collect({'descriptor': str(self.descriptor_path),
            'compiler_root': self.descriptor['configuration']['compiler_root'], 'target': self.value['target'],
            'packages': {'fixture': {key: self.value['packages']['fixture'][key] for key in ['root', 'source_label', 'manifest_label']}},
            'workspace_manifest': str(self.workspace), 'workspace_license': str(self.root / 'LICENSE')})
        self.intermediate.write_bytes(self.closure.canonical(original))
        self.stock_inventory['selected_stdlib'][0]['members'] = {'synthetic.o': {'size': 1, 'sha256': 'a' * 64}}
        self.publish_stock_fixture()
        native_callback = self.standard
        linkage = copy.deepcopy(self.stock_inventory)
        for name in ('source_archive', 'stdlib_archive', 'rustc_archive', 'graph'):
            path = Path('synthetic-host.' + name)
            path.write_bytes(('Explicit controlled original ' + name).encode())
            linkage[name] = self.input_fact(path, '@synthetic//:' + name)
        self.standard = lambda *args: {**native_callback(*args), 'linkage': linkage}
        payloads = self.collect()
        provider = {'producer': self.value['producer'], 'artifact': self.value['artifact']}
        for name, body in zip(('configuration', 'source_inventory', 'inventory', 'notices'), payloads):
            path = Path('proc-macro.' + name)
            path.write_bytes(body)
            provider[name] = {'input': str(path), 'label': '//fixture:compiled_proc_macro'}
        records = {'selected': record}
        origins, components = metadata.proc_macro_sources([provider], records, self.closure, self.notices.license_inputs)
        self.assertEqual(origins[0]['artifact'], self.input_fact(self.artifact, self.value['producer']))
        self.assertTrue(components)
        self.assertEqual(origins[0]['notices']['sha256'], hashlib.sha256(payloads[3]).hexdigest())
        # A label and even identical bytes do not identify the loaded configured File.
        other = Path('other-configuration') / self.artifact.name
        other.parent.mkdir()
        other.write_bytes(self.artifact.read_bytes())
        other.chmod(0o555)
        wrong = copy.deepcopy(provider)
        wrong['artifact']['input'] = str(other)
        with self.assertRaisesRegex(ValueError, 'actual loaded compiler File'):
            metadata.proc_macro_sources([wrong], records, self.closure, self.notices.license_inputs)
        for field in ('inventory', 'notices'):
            path = Path(provider[field]['input'])
            original = path.read_bytes()
            path.write_bytes(b'changed original host ' + field.encode())
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    metadata.proc_macro_sources([provider], records, self.closure, self.notices.license_inputs)
            path.write_bytes(original)
        source = json.loads(payloads[1])
        source['module_linkage']['pending_scopes'] = ['host-runtime']
        changed = self.closure.canonical(source)
        Path(provider['source_inventory']['input']).write_bytes(changed)
        inventory = json.loads(payloads[2])
        inventory['source_digest'] = hashlib.sha256(changed).hexdigest()
        Path(provider['inventory']['input']).write_bytes(self.closure.canonical(inventory))
        Path(provider['notices']['input']).write_bytes(self.closure.render(inventory))
        with self.assertRaisesRegex(ValueError, 'linkage inventory required'):
            metadata.proc_macro_sources([provider], records, self.closure, self.notices.license_inputs)


if __name__ == '__main__':
    unittest.main()
