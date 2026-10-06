"""Original source/SDK replay and bounded parser/custody regressions.

The linker text fixture is synthetic. This does not qualify a compiler action,
linked product or complete binary-distribution attribution.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AttributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.TemporaryDirectory(prefix='merkur-stdlib-source-')
        cls.old = Path.cwd()
        os.chdir(cls.root.name)
        Path('original').mkdir()
        Path('original/program').write_bytes(b'synthetic compiler artifact fixture\n')
        Path('original/rustc').symlink_to(args.rustc)
        provider = json.loads(Path(args.stdlib_files).read_bytes())
        cls.stdpath = Path(next(row['input'] for row in provider['stdlib'] if Path(row['input']).name == Path(args.stdlib).name))
        cls.stdpath.parent.mkdir(parents=True)
        cls.stdpath.symlink_to(args.stdlib)
        Path('original/source.tar.xz').symlink_to(args.source_archive)
        Path('original/stdlib.tar.xz').symlink_to(args.stdlib_archive)
        Path('original/rustc.tar.xz').symlink_to(args.rustc_archive)
        cls.members = collector.archive_members(Path(args.stdlib).read_bytes())
        cls.member = next(name for name in cls.members if name.endswith('.o'))
        cls.record = str(Path(args.stdlib).resolve()) + '(' + cls.member + ')'
        cls.mapping = '# Object files:\n[  0] linker synthesized\n[  1] ' + cls.record + '\n# Sections:\n'
        Path('original/map').write_text(cls.mapping)
        cls.graph = json.loads(Path(args.graph).read_bytes())
        Path('original/graph.json').symlink_to(args.graph)
        cls.stdlib = []
        for row in provider['stdlib']:
            original = Path(args.execroot) / row['input']
            logical = row['input']
            carrier = Path(logical)
            if carrier != cls.stdpath:
                carrier.parent.mkdir(parents=True, exist_ok=True)
                carrier.symlink_to(original)
            cls.stdlib.append({'path': logical, 'label': row['label']})
        cls.request = {
            'producer': '//fixture:program', 'compiler': '1.97.1',
            'target': 'aarch64-apple-darwin', 'execution_host': 'aarch64-apple-darwin',
            'rustc': {'path': 'original/rustc', 'label': '//fixture:actual_rustc'},
            'artifact': {'path': 'original/program', 'label': '//fixture:program'},
            'link_map': {'path': 'original/map', 'label': '//fixture:program'},
            'source': {'path': 'original/source.tar.xz', 'label': '@merkur_worker_compiler_source//file:file'},
            'stdlib': cls.stdlib,
            'graph': {'path': 'original/graph.json', 'label': '//fixture:graph'},
            'stdlib_archive': {'path': 'original/stdlib.tar.xz', 'label': '@rust_std_archive//file:file'},
            'rustc_archive': {'path': 'original/rustc.tar.xz', 'label': '@rustc_archive//file:file'},
        }
        Path('callback').mkdir()
        Path('callback/request.json').write_text(json.dumps(cls.request))
        collector.produce('callback/request.json', 'callback/inventory.json', 'callback/notices', deployment, outputs, graph_module)
        cls.inventory = json.loads(Path('callback/inventory.json').read_bytes())
        cls.value = {'input': 'callback/inventory.json', 'label': '//fixture:stdlib',
                     'notices': {'input': 'callback/notices', 'label': '//fixture:stdlib'}}
        cls.records = {'original_configured_unit': {'stdlib': [{'input': row['path'], 'label': row['label']} for row in cls.stdlib]}}

    @classmethod
    def tearDownClass(cls):
        os.chdir(cls.old)
        cls.root.cleanup()

    def capture(self, request=None):
        held = deployment.DeclaredInputs()
        try:
            return collector.collect(request or self.request, held, graph_module)
        finally:
            held.close()

    def test_original_source_and_sdk_publish_with_explicit_unresolved_scope(self):
        Path('request.json').write_text(json.dumps(self.request))
        collector.produce('request.json', 'inventory.json', 'notices', deployment, outputs, graph_module)
        inventory = json.loads(Path('inventory.json').read_text())
        self.assertEqual(inventory['source_archive']['sha256'], collector.SOURCE_SHA256)
        selected = next(row for row in inventory['selected_stdlib'] if row['path'] == str(self.stdpath))
        self.assertEqual(selected['members'][self.member], self.members[self.member])
        self.assertEqual(inventory['pending_scopes'], [])
        self.assertFalse(any(item['name'] in ('fortanix-sgx-abi', 'vex-sdk', 'wasip1', 'cc', 'shlex') for item in inventory['selected_packages']))
        self.assertTrue(inventory['selected_dependency_notices'])
        self.assertTrue((Path('notices') / 'LICENSE-MIT').is_file())
        self.assertTrue((Path('notices') / 'LICENSES/Unicode-3.0.txt').is_file())
        self.assertEqual(inventory['copyright_library']['sha256'], '0a65bb747c49c7bb816cbc7188319bd6e4e8d08091c1190b8a3c0971c47968ed')
        self.assertEqual(len(inventory['distribution_source_dependencies']), 30)
        self.assertTrue((Path('notices') / 'COPYRIGHT-library.html').is_file())
        self.assertTrue((Path('notices') / 'NOTICES-stdlib-dependencies.html').is_file())

    def test_original_member_corruption_truncation_and_duplicate_names_reject(self):
        data = Path(args.stdlib).read_bytes()
        for malformed in (b'bad', data[:-1], data[:8] + b' ' * 60):
            with self.assertRaises(ValueError):
                collector.archive_members(malformed)

    def test_substituted_original_source_archive_rejects_before_member_selection(self):
        data = bytearray(Path(args.source_archive).read_bytes())
        data[-1] ^= 1
        with self.assertRaisesRegex(ValueError, 'source archive SHA mismatch'):
            collector.source_members(data)

    def test_foreign_full_path_cannot_match_original_archive_by_basename(self):
        records = [str(Path('foreign') / Path(args.stdlib).name) + '(' + self.member + ')']
        with self.assertRaisesRegex(ValueError, 'no original declared'):
            collector.selected_members(records, {str(Path(args.stdlib).resolve()): 0})

    def test_original_archive_does_not_contain_invented_object(self):
        Path('original/map').write_text(self.mapping.replace(self.member, 'foreign-original.o'))
        try:
            with self.assertRaisesRegex(ValueError, 'absent from original'):
                self.capture()
        finally:
            Path('original/map').write_text(self.mapping)

    def test_load_without_contributing_object_is_not_selected_membership(self):
        request = copy.deepcopy(self.request)
        request['target'] = request['execution_host'] = 'aarch64-unknown-linux-gnu'
        Path('original/map').write_text('Archive member included to satisfy reference by file (symbol)\nLinker script and memory map\nLOAD ' + str(Path(args.stdlib).resolve()) + '\n')
        try:
            with self.assertRaisesRegex(ValueError, 'no original stdlib archive object'):
                self.capture(request)
        finally:
            Path('original/map').write_text(self.mapping)

    def test_duplicate_or_malformed_object_inventory_rejects(self):
        for malformed in (self.mapping.replace('[  1]', '[  0]'), self.mapping.replace('[  1]', 'missing-index'), self.mapping + '# Object files:\n'):
            with self.assertRaises(ValueError):
                collector.map_records(malformed.encode(), self.request['target'])

    def test_gnu_original_object_record_uses_same_exact_file_join(self):
        text = 'Archive member included to satisfy reference by file (symbol)\n' + self.record + '\n\nLinker script and memory map\nLOAD ' + str(Path(args.stdlib).resolve()) + '\n'
        selected = collector.selected_members(collector.map_records(text.encode(), 'x86_64-unknown-linux-gnu'), {str(Path(args.stdlib).resolve()): 0})
        self.assertEqual(selected, {0: [self.member]})

    def test_wasm_live_chunks_select_only_exact_original_archive_members(self):
        header = b'    Addr      Off     Size Out     In      Symbol\n'
        live = b'       -       44        9         ' + self.record.encode() + b':(fixture)\n'
        symbol = b'       -       44        9                 ignored-symbol\xc0\n'
        zero = b'       0        0        0         __stack_pointer\n'
        dead = b'       -       44        0         ' + self.record.encode().replace(self.member.encode(), b'dead.o') + b':(dead)\n'
        text = header + b'       -       43        c CODE\n' + zero + live + symbol + live + dead
        records = collector.map_records(text, collector.WASM_TARGET)
        self.assertEqual(records, [self.record])
        selected = collector.selected_members(records, {str(Path(args.stdlib).resolve()): 0})
        self.assertEqual(selected, {0: [self.member]})
        data = header + b'      10       44        9         ' + self.record.encode() + b':(.data)\n'
        self.assertEqual(collector.map_records(data, collector.WASM_TARGET), [self.record])

    def test_wasm_non_file_rows_and_foreign_paths_cannot_select_an_archive(self):
        text = b'    Addr      Off     Size Out     In      Symbol\n' + b'       -       44        9         /foreign/' + Path(args.stdlib).name.encode() + b'(' + self.member.encode() + b'):(fixture)\n'
        records = collector.map_records(text, collector.WASM_TARGET)
        with self.assertRaisesRegex(ValueError, 'no original declared'):
            collector.selected_members(records, {str(Path(args.stdlib).resolve()): 0})
        with self.assertRaisesRegex(ValueError, 'no live input'):
            collector.map_records(b'    Addr      Off     Size Out     In      Symbol\n       0        0        0         __stack_pointer\n', collector.WASM_TARGET)

    def test_wasm_malformed_original_map_refuses(self):
        text = b'    Addr      Off     Size Out     In      Symbol\n       -       44        9         ' + self.record.encode() + b':(fixture)\n'
        for malformed in (text.replace(b'Addr', b'Address'), text.replace(b'44', b'not-hex'),
                          text.replace(b'9         ', b'9     '), text.replace(b':(fixture)', b'no-chunk'),
                          text.replace(self.member.encode(), b'bad\xc0')):
            with self.subTest(malformed=malformed):
                with self.assertRaises((ValueError, UnicodeError)):
                    collector.map_records(malformed, collector.WASM_TARGET)

    def test_symbol_literal_bytes_never_reinterpret_object_path_bytes(self):
        text = self.mapping.encode() + b'# Symbols:\n[  1] invalid symbol literal\xc0\n'
        self.assertIn(self.record, collector.map_records(text, self.request['target']))
        with self.assertRaises(UnicodeError):
            collector.map_records(self.mapping.encode().replace(self.member.encode(), b'bad\xc0'), self.request['target'])

    def test_duplicate_and_foreign_descriptor_context_rejects(self):
        for mutate in (lambda r: r.update(compiler='1.96.0'), lambda r: r.update(target='wasm32-unknown-unknown'), lambda r: r['stdlib'].append(r['stdlib'][0]), lambda r: r['stdlib'][0].update(path='../outside'), lambda r: r.update(extra=True)):
            request = copy.deepcopy(self.request)
            mutate(request)
            with self.assertRaises(ValueError):
                self.capture(request)
        with self.assertRaisesRegex(ValueError, 'Duplicate attribution'):
            collector.parse_json('{"producer":1,"producer":2}')

    def test_retargeted_declared_engine_carrier_refuses_final_check(self):
        held = deployment.DeclaredInputs()
        try:
            original = held.presentation(str(self.stdpath))
            held.file(original)
            Path('original/foreign').write_bytes(b'foreign\n')
            self.stdpath.unlink()
            self.stdpath.symlink_to(Path('original/foreign').absolute())
            with self.assertRaisesRegex(ValueError, 'presentation changed'):
                held.verify()
        finally:
            held.close()
            self.stdpath.unlink()
            self.stdpath.symlink_to(args.stdlib)

    def test_publisher_dependency_omission_and_url_substitution_refuse(self):
        text = b'<html><body><h3>\xf0\x9f\x93\xa6 thing-1.0.0</h3><p><b>URL:</b> <a href="https://crates.io/crates/thing/1.0.0">thing</a></p><p><b>License:</b> MIT</p><summary><code>LICENSE</code></summary><pre>original fixture text</pre></body></html>'
        lock = b'[[package]]\nname="thing"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + b'a' * 64 + b'"\n'
        facts, _ = collector.dependency_notices(text, lock)
        self.assertEqual(facts[0]['id'], 'thing@1.0.0')
        for altered in (text.replace(b'thing-1.0.0', b'foreign-1.0.0'), text.replace(b'crates.io/crates/thing', b'crates.io/crates/foreign'), text.replace(b'original fixture text', b'')):
            with self.assertRaises(ValueError):
                collector.dependency_notices(altered, lock)

    def test_wrong_distribution_pin_refuses_without_accepting_notice_metadata(self):
        with self.assertRaisesRegex(ValueError, 'distribution archive SHA mismatch'):
            collector.distribution_members(b'foreign distribution', collector.DISTRIBUTIONS['aarch64-apple-darwin'][0], 'original/', ['LICENSE'])

    def changed_graph(self, mutate, message):
        graph = copy.deepcopy(self.graph)
        mutate(graph)
        Path('changed-graph.json').write_text(json.dumps(graph))
        request = copy.deepcopy(self.request)
        request['graph']['path'] = 'changed-graph.json'
        with self.assertRaisesRegex(ValueError, message):
            self.capture(request)

    def test_compiler_execution_host_is_mandatory_and_cannot_retarget_native(self):
        for mutate in (lambda r: r.pop('execution_host'),
                       lambda r: r.update(execution_host='wasm32-unknown-unknown'),
                       lambda r: r.update(execution_host='x86_64-apple-darwin')):
            request = copy.deepcopy(self.request)
            mutate(request)
            with self.assertRaises(ValueError):
                self.capture(request)

    def test_actual_compiler_file_is_mandatory_and_custom_same_version_refuses(self):
        request = copy.deepcopy(self.request)
        del request['rustc']
        with self.assertRaisesRegex(ValueError, 'Exact typed stdlib request'):
            self.capture(request)
        Path('custom-rustc').write_bytes(b'explicitly synthetic different same-version compiler')
        Path('custom-rustc').chmod(0o755)
        request = copy.deepcopy(self.request)
        request['rustc'] = {'path': 'custom-rustc', 'label': '//fixture:custom_rustc'}
        with self.assertRaisesRegex(ValueError, 'Actual action compiler differs'):
            self.capture(request)

    def test_callback_changed_actual_compiler_file_refuses(self):
        carrier = Path('original/rustc')
        original = carrier.readlink()
        carrier.unlink()
        carrier.write_bytes(b'explicitly synthetic changed compiler File')
        carrier.chmod(0o755)
        try:
            with self.assertRaisesRegex(ValueError, 'Actual action compiler File changed'):
                self.callback()
        finally:
            carrier.unlink()
            carrier.symlink_to(original)

    def test_graph_source_context_and_membership_refuse_coherent_omission(self):
        self.changed_graph(lambda g: g.update(target='x86_64-apple-darwin'), 'configured native')
        self.changed_graph(lambda g: g['source_inputs'].pop(), 'source membership')
        self.changed_graph(lambda g: g['source_archive'].update(sha256='a' * 64), 'source archive mismatch')

    def test_original_metadata_identity_custody_and_exact_coverage_are_mandatory(self):
        self.changed_graph(lambda g: g['metadata'].pop(), 'metadata omitted')
        self.changed_graph(lambda g: g['metadata'].append(g['metadata'][0]), 'Duplicate or malformed')
        Path('foreign.rmeta').write_bytes(Path(self.graph['metadata'][0]['file']['path']).read_bytes())
        self.changed_graph(lambda g: g['stock_association']['members'][0].update(metadata_input='foreign.rmeta'), 'no exact original distribution File')

    def test_graph_package_relation_and_original_source_bytes_refuse(self):
        self.changed_graph(lambda g: g['associations'][0].update(pkg_id='foreign-package'), 'package relation mismatch')
        self.changed_graph(lambda g: g['source_inputs'][0].update(sha256='a' * 64), 'source File bytes mismatch')
        self.changed_graph(lambda g: g['packages'].pop(), 'package membership mismatch')

    def test_original_compiler_svh_pairs_cannot_be_omitted_or_relabelled(self):
        self.changed_graph(lambda g: g['stock_association']['members'].pop(), 'no exact original distribution File')
        self.changed_graph(lambda g: g['stock_association']['members'][0].update(archive_label='//foreign:generated'), 'member custody mismatch')
        self.changed_graph(lambda g: g['stock_association']['members'][0]['compiler_observation'].update(exit=True), 'object-emission pair observation')
        def change_emit(graph):
            command = graph['stock_association']['members'][0]['compiler_observation']['command']
            command[command.index('--emit=obj')] = '--emit=metadata'
        self.changed_graph(change_emit, 'object-emission pair observation')

    def callback(self, value=None, artifact=None, records=None):
        return collector.collect_compiled_stdlib(value or self.value, artifact or self.inventory['artifact'],
                                                 self.request['target'], records or self.records,
                                                 deployment.license_inputs)

    def test_callback_preserves_selected_publisher_components_and_llvm_exception(self):
        result = self.callback()
        self.assertTrue(result['sources'])
        names = {item['name'] for item in result['components']}
        self.assertIn('Rust standard library', names)
        self.assertIn('compiler_builtins', names)
        self.assertFalse(names.intersection({'fortanix-sgx-abi', 'vex-sdk', 'wasip1', 'cc', 'shlex'}))
        builtins = next(item for item in result['components'] if item['name'] == 'compiler_builtins')
        self.assertIn('LLVM-exception', builtins['license'])
        self.assertIn('LICENSES/LLVM-exception.txt', {item['path'] for item in builtins['texts']})
        self.assertTrue(all(item['texts'] for item in result['components']))

    def test_callback_rejects_pending_and_unrelated_original_artifact(self):
        artifact = copy.deepcopy(self.inventory['artifact'])
        artifact['label'] = '//foreign:program'
        with self.assertRaisesRegex(ValueError, 'another original compiler artifact'):
            self.callback(artifact=artifact)
        original = Path(self.value['input']).read_bytes()
        try:
            changed = copy.deepcopy(self.inventory)
            changed['pending_scopes'] = ['actual-unresolved-scope']
            Path(self.value['input']).write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, 'Complete matching'):
                self.callback()
        finally:
            Path(self.value['input']).write_bytes(original)

    def test_callback_missing_original_sdk_file_and_foreign_notice_tree_refuse(self):
        records = copy.deepcopy(self.records)
        selected = self.inventory['selected_stdlib'][0]['path']
        records['original_configured_unit']['stdlib'] = [row for row in records['original_configured_unit']['stdlib'] if row['input'] != selected]
        with self.assertRaisesRegex(ValueError, 'absent from actual compiler records'):
            self.callback(records=records)
        value = copy.deepcopy(self.value)
        value['notices']['label'] = '//foreign:tree'
        with self.assertRaisesRegex(ValueError, 'another producer'):
            self.callback(value=value)

    def test_callback_foreign_same_byte_notice_alias_and_missing_member_refuse(self):
        leaf = Path('callback/notices/LICENSE-MIT')
        body = leaf.read_bytes()
        Path('foreign-license').write_bytes(body)
        leaf.unlink()
        leaf.symlink_to(Path('foreign-license').absolute())
        try:
            with self.assertRaisesRegex(ValueError, 'link or special'):
                self.callback()
        finally:
            leaf.unlink()
            leaf.write_bytes(body)
        leaf.unlink()
        try:
            with self.assertRaisesRegex(ValueError, 'membership/bytes mismatch'):
                self.callback()
        finally:
            leaf.write_bytes(body)

    def test_failed_selection_publishes_no_output_and_preserves_caller(self):
        request = copy.deepcopy(self.request)
        request['target'] = 'foreign'
        Path('bad-request.json').write_text(json.dumps(request))
        Path('caller').write_bytes(b'caller\n')
        with self.assertRaises(ValueError):
            collector.produce('bad-request.json', 'bad-inventory', 'bad-notices', deployment, outputs, graph_module)
        self.assertFalse(Path('bad-inventory').exists())
        self.assertFalse(Path('bad-notices').exists())
        self.assertEqual(Path('caller').read_bytes(), b'caller\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ('collector', 'custody', 'outputs', 'rustc', 'stdlib', 'source-archive', 'stdlib-archive', 'rustc-archive', 'graph', 'graph-module', 'stdlib-files', 'execroot'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    collector = load('stdlib_collector', args.collector)
    deployment = load('stdlib_custody', args.custody)
    outputs = load('stdlib_outputs', args.outputs)
    graph_module = load('stdlib_native_graph', args.graph_module)
    unittest.main(argv=['stdlib_attribution_test.py'])
