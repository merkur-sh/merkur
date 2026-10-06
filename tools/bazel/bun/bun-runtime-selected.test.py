"""Genuine native component controls; no full Bun runtime qualification claim."""

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import unittest
import tempfile
import io
import tarfile
import hashlib
import copy


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('runner', 'generated', 'native_controls', 'linked', 'mapper', 'runtime_sections',
                 'custody', 'licenses', 'cc_helper', 'cc_spec', 'execution_root', 'ninja', 'bash',
                 'sdk_lib', 'python', 'elf_linker', 'nightly_manifest'):
        parser.add_argument('--' + name.replace('_', '-'), type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments, remaining = parser.parse_known_args()
    controls = load('selected_genuine_native_controls', arguments.native_controls)
    controls.arguments = arguments
    for name, argument in [('linked', 'linked'), ('mapper', 'mapper'), ('sections', 'runtime_sections'),
                           ('custody', 'custody'), ('licenses', 'licenses'), ('cc_helper', 'cc_helper')]:
        setattr(controls, name, load('selected_native_' + name, getattr(arguments, argument)))
    runner = load('selected_runtime_reader', arguments.runner)
    generated = load('selected_embedded_reader', arguments.generated)
    linked, licenses = controls.linked, controls.licenses

    class DependencyOriginControls(unittest.TestCase):
        def setUp(self):
            temporary = tempfile.TemporaryDirectory()
            self.addCleanup(temporary.cleanup)
            self.root = Path(temporary.name).resolve(strict=True)
            self.published = self.root / 'published'
            self.directory = self.published / 'actual-fetch-destination'
            self.directory.mkdir(parents=True)
            self.source = b'int original_dependency() { return 7; }\n'
            (self.directory / 'selected.cpp').write_bytes(self.source)
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as archive:
                for name, body in [('selected.cpp', self.source), ('LICENSE', b'Original fixture license\n')]:
                    member = tarfile.TarInfo('exact-original-root/' + name)
                    member.size = len(body)
                    archive.addfile(member, io.BytesIO(body))
            self.archive = self.root / 'original.tar.gz'
            self.archive.write_bytes(data.getvalue())
            self.webkit = self.root / 'webkit-lto.tar.gz'
            self.webkit.write_bytes(b'Original prebuilt fixture, not C++ source')
            self.origin = '/original/native/source'
            self.configuration = {'cfg': {'cwd': self.origin}, 'dependencySources': [
                {'name': 'library', 'kind': 'github-archive', 'url': 'https://original.invalid/library.tar.gz',
                 'directory': self.origin + '/actual-fetch-destination'},
                {'name': 'webkit', 'kind': 'prebuilt', 'url': 'https://original.invalid/webkit.tar.gz',
                 'directory': self.origin + '/actual-webkit-destination'}]}
            self.build_pins = {'bun_commit': 'original-commit', 'dependencies': {
                'library': {'kind': 'github-archive', 'original_url': 'https://original.invalid/library.tar.gz',
                            'sha256': hashlib.sha256(data.getvalue()).hexdigest(), 'revision': 'exact-revision'}}}
            self.specification = {'dependency_files': {'library': str(self.archive)},
                'declared_files': [str(self.archive), str(self.webkit)],
                'webkit': {'file': str(self.webkit), 'url': 'https://original.invalid/webkit.tar.gz',
                           'sha256': hashlib.sha256(self.webkit.read_bytes()).hexdigest()}}

        def collect(self):
            return runner.native_dependency_origins(self.configuration, self.specification, self.build_pins,
                {'commit': 'original-commit'}, self.published, linked, controls.custody, licenses)

        def test_exact_consumed_archive_directory_joins_original_selected_source(self):
            origins = self.collect()
            self.assertEqual(len(origins), 1)
            self.assertEqual(origins[0]['namespace'], self.origin + '/actual-fetch-destination')
            facts = linked.bind_original_inputs([str(self.directory / 'selected.cpp')],
                [{**origins[0], 'namespace': str(self.directory)}], licenses)
            self.assertEqual(facts[0]['component'], 'library@exact-revision')
            self.assertEqual(facts[0]['sha256'], hashlib.sha256(self.source).hexdigest())
            self.assertNotIn('webkit', [origin['component'] for origin in origins])

        def test_missing_duplicate_foreign_and_retargeted_acquisition_refuse(self):
            original = copy.deepcopy(self.configuration)
            mutations = [None, original['dependencySources'][:1], original['dependencySources'] * 2,
                         [{**original['dependencySources'][0], 'url': 'https://foreign.invalid'}, original['dependencySources'][1]],
                         [{**original['dependencySources'][0], 'directory': '/outside'}, original['dependencySources'][1]],
                         [{**original['dependencySources'][0], 'kind': 'prebuilt'}, original['dependencySources'][1]]]
            for relations in mutations:
                with self.subTest(relations=relations), self.assertRaises(ValueError):
                    self.configuration['dependencySources'] = relations
                    self.collect()
            self.configuration = original

        def test_undeclared_or_changed_original_archive_cannot_supply_source(self):
            self.specification['declared_files'].remove(str(self.archive))
            with self.assertRaisesRegex(ValueError, 'absent from its native action Files'):
                self.collect()
            self.specification['declared_files'].append(str(self.archive))
            self.archive.write_bytes(self.archive.read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'archive bytes changed'):
                self.collect()

        def test_foreign_original_commit_and_modified_selected_member_refuse(self):
            self.build_pins['bun_commit'] = 'foreign'
            with self.assertRaisesRegex(ValueError, 'another original Bun commit'):
                self.collect()
            self.build_pins['bun_commit'] = 'original-commit'
            origin = self.collect()[0]
            (self.directory / 'selected.cpp').write_bytes(b'foreign same-path source')
            with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                linked.bind_original_inputs([str(self.directory / 'selected.cpp')],
                    [{**origin, 'namespace': str(self.directory)}], licenses)

    class SelectedRuntimeControls(controls.LinkedSourceControls):
        def setUp(self):
            super().setUp()
            self.published = self.own / 'published'
            shutil.copytree(self.root, self.published, symlinks=True)
            (self.published / 'build/compile_commands.json').write_text(json.dumps(self.database))
            (self.published / 'build/original-compiler-deps.txt').write_bytes(self.deps_bytes)
            self.runtime = self.own / 'actual-declared-runtime'
            self.runtime.write_bytes(self.native_bytes)
            # Only this native config bridge is synthetic. Native/map/compiler
            # commands/dependency bytes are genuine declared source builds.
            self.configuration = {'cfg': {'cwd': str(self.root), 'buildDir': str(self.build)},
                'runtime': str(self.binary), 'output': {'exe': str(self.binary)},
                'linkerMaps': [str(self.map_file)]}

        def component(self):
            return runner.retained_native_inputs(self.configuration, self.published, self.runtime,
                'aarch64-apple-darwin', [self.origin], linked, licenses, controls.sections, controls.mapper)

        def admission(self):
            return runner.read_selected_runtime(self.configuration, self.published, self.runtime,
                'aarch64-apple-darwin', [self.origin], linked, generated, licenses,
                controls.sections, controls.mapper)

        def test_genuine_retained_component_reads_only_published_original_selected_bytes(self):
            facts = self.component()
            self.assertEqual({fact['path'] for fact in facts}, {'main.cpp', 'retained.cpp', 'selected.h'})
            # No ambient read of the old original native source namespace.
            old = self.source / 'retained.cpp'
            data = old.read_bytes()
            try:
                old.write_bytes(b'changed original temporary source after publication')
                self.assertEqual(self.component(), facts)
            finally:
                old.write_bytes(data)

        def test_missing_embedded_metadata_refuses_actual_retained_native_component(self):
            self.assertTrue(self.component())
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'same-action embedded compiler source custody is absent'):
                self.admission()

        def test_embedded_gate_precedes_native_map_or_runtime_validation(self):
            self.runtime.write_bytes(b'foreign runtime')
            (self.published / self.map_file.relative_to(self.root)).write_bytes(b'foreign map')
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'embedded compiler source custody is absent'):
                self.admission()

        def test_embedded_pending_cannot_be_ignored_by_selected_reader(self):
            self.configuration['embeddedCompilerInputs'] = {'pending': [
                {'metadata': 'functions/missing.json', 'reason': 'original compiler metadata missing'}]}
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'authority remains pending'):
                self.admission()

        def test_foreign_runtime_and_published_source_bytes_refuse(self):
            self.runtime.write_bytes(b'foreign runtime')
            with self.assertRaisesRegex(ValueError, 'same source-built runtime File'):
                self.component()
            self.runtime.write_bytes(self.native_bytes)
            (self.published / 'source/retained.cpp').write_bytes(b'foreign selected source')
            with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                self.component()

        def test_foreign_configured_namespace_and_missing_map_refuse(self):
            self.configuration['cfg']['cwd'] = '/foreign'
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'published original namespace'):
                self.component()
            self.configuration['cfg']['cwd'] = str(self.root)
            self.configuration['linkerMaps'] = []
            with self.assertRaisesRegex(ValueError, 'exact single linker map'):
                self.component()

    unittest.main(argv=[sys.argv[0], *remaining])
