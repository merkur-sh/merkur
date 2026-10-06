"""Reuse existing bounded controls with explicitly synthetic, small original Files."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import types
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


root = Path(__file__).parent
controls = load('stdlib_original_controls', root / 'stdlib_attribution_test.py')
controls.collector = load('stdlib_mapper', root / 'stdlib_attribution.py')
controls.deployment = load('stdlib_custody', root.parent / 'packaging/deployment-pack.py')


class RoutineControls(controls.AttributionTests):
    @classmethod
    def setUpClass(cls):
        cls.old = Path.cwd()
        cls.root = tempfile.TemporaryDirectory(prefix='stdlib-routine-')
        os.chdir(cls.root.name)
        Path('original').mkdir()
        body = b'actual synthetic object bytes'
        header = ('member.o/'.ljust(16) + '0'.ljust(12) + '0'.ljust(6) +
                  '0'.ljust(6) + '100644'.ljust(8) + str(len(body)).ljust(10) + '`\n').encode()
        archive = b'!<arch>\n' + header + body + (b'\n' if len(body) % 2 else b'')
        original = Path('original/fixture.rlib').absolute()
        original.write_bytes(archive)
        cls.stdpath = Path('carrier.rlib')
        cls.stdpath.symlink_to(original)
        controls.args = types.SimpleNamespace(stdlib=str(original))
        cls.members = controls.collector.archive_members(archive)
        cls.member = 'member.o'
        cls.record = str(original) + '(' + cls.member + ')'
        cls.mapping = '# Object files:\n[  0] linker synthesized\n[  1] ' + cls.record + '\n# Sections:\n'
        cls.request = {'target': 'aarch64-apple-darwin'}


class CompilerIdentityControls(unittest.TestCase):
    def setUp(self):
        self.original = b'explicitly synthetic original stock compiler bytes'
        self.fact = {'size': len(self.original), 'sha256': hashlib.sha256(self.original).hexdigest()}
        self.target = 'aarch64-apple-darwin'
        self.member = 'rustc-' + controls.collector.VERSION + '-' + self.target + '/rustc/bin/rustc'
        self.graph = {'stock_association': {'compiler_files': {
            self.member: {'path': '/declared/sdk/bin/rustc', **self.fact},
        }}}

    def test_original_action_sdk_and_archive_compiler_bytes_match(self):
        controls.collector.matched_stock_compiler(self.graph, self.target, self.fact, self.original)

    def test_same_version_custom_compiler_bytes_reject(self):
        custom = b'explicitly synthetic custom compiler with the same version'
        current = {'size': len(custom), 'sha256': hashlib.sha256(custom).hexdigest()}
        with self.assertRaisesRegex(ValueError, 'Actual action compiler differs'):
            controls.collector.matched_stock_compiler(self.graph, self.target, current, self.original)

    def test_foreign_sdk_compiler_observation_rejects(self):
        graph = copy.deepcopy(self.graph)
        graph['stock_association']['compiler_files'][self.member]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Actual action compiler differs'):
            controls.collector.matched_stock_compiler(graph, self.target, self.fact, self.original)

    def test_missing_foreign_or_duplicate_original_member_rejects(self):
        for files in [{}, {'foreign/rustc': self.graph['stock_association']['compiler_files'][self.member]},
                      {**self.graph['stock_association']['compiler_files'], 'extra/rustc': {}}]:
            graph = {'stock_association': {'compiler_files': files}}
            with self.assertRaisesRegex(ValueError, 'exact original stock compiler File'):
                controls.collector.matched_stock_compiler(graph, self.target, self.fact, self.original)

    def test_malformed_compiler_file_identity_rejects(self):
        for key, value in [('size', True), ('size', str(len(self.original))), ('path', 'relative/rustc')]:
            graph = copy.deepcopy(self.graph)
            graph['stock_association']['compiler_files'][self.member][key] = value
            with self.assertRaisesRegex(ValueError, 'identity is malformed'):
                controls.collector.matched_stock_compiler(graph, self.target, self.fact, self.original)


names = [
    'test_original_member_corruption_truncation_and_duplicate_names_reject',
    'test_foreign_full_path_cannot_match_original_archive_by_basename',
    'test_duplicate_or_malformed_object_inventory_rejects',
    'test_gnu_original_object_record_uses_same_exact_file_join',
    'test_symbol_literal_bytes_never_reinterpret_object_path_bytes',
    'test_wasm_live_chunks_select_only_exact_original_archive_members',
    'test_wasm_non_file_rows_and_foreign_paths_cannot_select_an_archive',
    'test_wasm_malformed_original_map_refuses',
    'test_retargeted_declared_engine_carrier_refuses_final_check',
    'test_publisher_dependency_omission_and_url_substitution_refuse',
    'test_wrong_distribution_pin_refuses_without_accepting_notice_metadata',
]
if __name__ == '__main__':
    suite = unittest.TestSuite(RoutineControls(name) for name in names)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(CompilerIdentityControls))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
