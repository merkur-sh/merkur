"""Exact five-binary/four-native-platform context inventory controls."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest

spec = importlib.util.spec_from_file_location('attribution_generator', Path(__file__).with_name('generator.py'))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class ContextInventory(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.directory = self.root / 'tools/bazel/rust/units/provenance'
        self.directory.mkdir(parents=True)
        for name, (compiler, target) in generator.expected_contexts().items():
            self.write(name, compiler, target)
        self.macro_id = hashlib.sha256(b'controlled original host macro unit').hexdigest()
        self.macro = {'pkg_id': 'macro', 'dependencies': [], 'target': {'kind': ['proc-macro']},
                      'platform': None, 'execution_host': 'aarch64-apple-darwin', 'mode': 'build',
                      'profile': {'name': 'release'}}
        self.graph = {'nodes': {self.macro_id: self.macro}, 'roots': {}}
        for name, (context, _, _) in generator.WASM_CONTEXTS.items():
            identity = hashlib.sha256(context.encode()).hexdigest()
            unit = {'pkg_id': 'fixture', 'dependencies': [{'unit': self.macro_id}],
                    'target': {'kind': ['lib'], 'crate_types': ['cdylib']}, 'emit_cdylib': True,
                    'platform': 'wasm32-unknown-unknown', 'execution_host': 'aarch64-apple-darwin',
                    'mode': 'build', 'profile': {'name': 'release'}}
            self.graph['nodes'][identity] = unit
            self.graph['roots'][context] = [identity]
            (self.directory / name).write_text(json.dumps({
                'roots': [identity], 'units': {identity: unit, self.macro_id: self.macro},
                'configuration': {'compiler_root': context, 'target': 'wasm32-unknown-unknown'},
                'packages': {'fixture': {'name': context.split('/')[0]}, 'macro': {'name': 'controlled-macro'}},
                'package_sources': {'fixture': '//fixture:package_data', 'macro': '//fixture:macro_data'},
                'package_manifests': {'fixture': '//fixture:Cargo.toml', 'macro': '//fixture:macro_Cargo.toml'},
            }))
        (self.directory.parent / 'graph.json').write_text(json.dumps(self.graph))
        self.host_path = self.directory / ('host_proc_macro_' + self.macro_id + '.json')
        self.host_path.write_text(json.dumps({
            'roots': [self.macro_id], 'units': {self.macro_id: self.macro},
            'configuration': {'compiler_root': 'host-proc-macro/' + self.macro_id, 'target': 'aarch64-apple-darwin'},
            'packages': {'macro': {'name': 'controlled-macro'}},
            'package_sources': {'macro': '//fixture:macro_data'},
            'package_manifests': {'macro': '//fixture:macro_Cargo.toml'},
        }))

    def write(self, name, compiler, target):
        package_name = compiler.split('/')[0]
        (self.directory / name).write_text(json.dumps({
            'configuration': {'compiler_root': compiler, 'target': target},
            'roots': ['selected'],
            'units': {'selected': {'pkg_id': 'fixture', 'target': {'name': package_name, 'kind': ['bin'], 'crate_types': ['bin']}, 'mode': 'build', 'profile': {'name': 'release'}}},
            'packages': {'fixture': {'name': package_name}},
            'package_sources': {'fixture': '//fixture:package_data'},
            'package_manifests': {'fixture': '//fixture:Cargo.toml'},
        }))

    def test_complete_exact_inventory_renders_twenty_contexts(self):
        rendered = generator.rendered(self.root)
        self.assertEqual(rendered.count('    rust_attribution('), 24)
        self.assertEqual(rendered.count('    compiled_rust_attribution('), 24)
        compiled = [node for node in ast.walk(ast.parse(rendered))
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                    and node.func.id == 'compiled_rust_attribution']
        for label in generator.PRODUCERS.values():
            self.assertEqual(sum(ast.literal_eval(attribute.value) == label
                                 for call in compiled for attribute in call.keywords
                                 if attribute.arg == 'producer'), 4)
        self.assertEqual(rendered.count('stdlib_notices = stdlib_notices'), 20)

    def generated_bindings(self):
        calls = []
        graphs = []
        def fail(message):
            raise ValueError(message)
        # Execute declaration wiring only. Genuine typed File/provider and
        # matched-compiler checks remain in the original Bazel rules/actions.
        namespace = {'load': lambda *args: None,
                     'type': lambda value: 'dict' if isinstance(value, dict) else type(value).__name__,
                     'fail': fail, 'stdlib_attribution_tests': lambda **kwargs: calls.append(kwargs),
                     'stock_stdlib_native_graph': lambda **kwargs: graphs.append(kwargs)}
        exec(compile(generator.rendered(self.root), '<generated declarations>', 'exec'), namespace)
        return namespace['declared_shipping_stdlib_attribution'], calls, graphs

    def test_each_selected_shipping_context_gets_its_own_matched_archive_graph(self):
        declare, calls, graphs = self.generated_bindings()
        standard = {target: '//original:stdlib_' + target for target in generator.SHIPPING_TARGETS}
        compilers = {target: '//original:rustc_' + target for target in generator.SHIPPING_TARGETS}
        result = declare('//original:sdk', '//original:prepared_source', '//original:source_archive', standard, compilers)
        expected = generator.expected_contexts()
        self.assertEqual(set(result), {Path(name).stem for name in expected})
        self.assertEqual(len(calls), len(expected))
        self.assertEqual(len(graphs), len(generator.SHIPPING_TARGETS))
        original_graphs = {':' + graph['name']: graph for graph in graphs}
        for call in calls:
            stem = call['name'].removeprefix('shipping_stdlib_attribution_')
            compiler_root, target = expected[stem + '.json']
            self.assertEqual(call['compiler'], generator.PRODUCERS[compiler_root.split('/')[0]])
            self.assertEqual(call['execution_host'], target)
            self.assertEqual(call['stdlib_archive'], standard[target])
            self.assertEqual(call['rustc_archive'], compilers[target])
            self.assertEqual(call['source_archive'], '//original:source_archive')
            self.assertEqual(result[stem], ':' + call['name'])
            graph = original_graphs[call['graph']]
            self.assertEqual(graph['sdk'], '//original:sdk')
            self.assertEqual(graph['source'], '//original:prepared_source')
            self.assertEqual(graph['producer'], generator.PRODUCERS['merkur-dataplane'])
            self.assertEqual(graph['stdlib_archive'], standard[target])
            self.assertEqual(graph['compiler_archive'], compilers[target])
            self.assertEqual(graph['exec_compatible_with'], call['target_compatible_with'])
            self.assertEqual(graph['target_compatible_with'], call['target_compatible_with'])
            self.assertEqual(set(call['target_compatible_with']), {
                '@platforms//cpu:' + ('aarch64' if target.startswith('aarch64') else 'x86_64'),
                '@platforms//os:' + ('macos' if 'apple-darwin' in target else 'linux'),
            })

    def test_partial_extra_or_untyped_distribution_bindings_refuse_before_declarations(self):
        complete = {target: '//original:archive_' + target for target in generator.SHIPPING_TARGETS}
        incomplete = dict(complete)
        incomplete.pop(generator.SHIPPING_TARGETS[0])
        foreign = dict(complete, wasm32_unknown_unknown='//foreign:archive')
        for changed in (None, [], incomplete, foreign):
            for field in ('stdlib', 'rustc'):
                declare, calls, graphs = self.generated_bindings()
                with self.assertRaises(ValueError):
                    declare('//original:sdk', '//original:source', '//original:source_archive',
                            changed if field == 'stdlib' else complete,
                            changed if field == 'rustc' else complete)
                self.assertEqual(calls, [])
                self.assertEqual(graphs, [])

    def test_real_wasm_and_loaded_macro_callers_bind_exact_original_contexts(self):
        calls = []
        def fail(message):
            raise ValueError(message)
        namespace = {'load': lambda *args: None, 'fail': fail,
                     'type': lambda value: 'dict' if isinstance(value, dict) else type(value).__name__}
        for name in ['rust_attribution', 'stock_stdlib_native_graph', 'stdlib_attribution_tests', 'compiled_rust_attribution']:
            namespace[name] = lambda _name=name, **kwargs: calls.append((_name, kwargs))
        exec(compile(generator.rendered(self.root), '<actual generated callers>', 'exec'), namespace)
        declare = namespace['declared_wasm_rust_attribution']
        result = declare('//original:sdk', '//original:prepared', '//original:source', '//original:wasm_std',
                         {'aarch64-apple-darwin': '//original:host_std'}, {'aarch64-apple-darwin': '//original:rustc'})
        compiled = [value for name, value in calls if name == 'compiled_rust_attribution']
        self.assertEqual(len(compiled), 4)
        macro = next(value for value in compiled if value['target_triple'] == 'aarch64-apple-darwin')
        self.assertEqual(macro['producer'], '//tools/bazel/rust/units:u_' + self.macro_id)
        for name, (context, producer, package) in generator.WASM_CONTEXTS.items():
            module = next(value for value in compiled if value['producer'] == producer)
            self.assertEqual(module['descriptor'], '//tools/bazel/rust/units/provenance:' + name)
            self.assertEqual(module['proc_macro_notices'], [':' + macro['name']])
            self.assertEqual(result['rust_attributions'][':' + module['name']], package)
        standard = [value for name, value in calls if name == 'stdlib_attribution_tests']
        self.assertEqual(len(standard), 4)
        for value in standard:
            self.assertEqual(value['execution_host'], 'aarch64-apple-darwin')
            self.assertEqual(value['rustc_archive'], '//original:rustc')
            self.assertEqual(value['stdlib_archive'], '//original:host_std' if value['compiler'] == macro['producer'] else '//original:wasm_std')
        for field in (0, 1):
            calls.clear()
            archives = [{}, {'aarch64-apple-darwin': '//original:rustc'}]
            if field:
                archives.reverse()
            with self.assertRaises(ValueError):
                declare('//original:sdk', '//original:prepared', '//original:source', '//original:wasm_std', *archives)
            self.assertEqual(calls, [])

    def test_missing_foreign_host_unit_and_coherent_omission_refuse(self):
        original = json.loads(self.host_path.read_text())
        changed = copy.deepcopy(original)
        changed['units'][self.macro_id]['profile']['name'] = 'dev'
        self.host_path.write_text(json.dumps(changed))
        with self.assertRaises(ValueError): generator.rendered(self.root)
        self.host_path.write_text(json.dumps(original))
        self.host_path.unlink()
        with self.assertRaises(ValueError): generator.rendered(self.root)
        self.host_path.write_text(json.dumps(original))
        path = self.directory / next(iter(generator.WASM_CONTEXTS))
        data = json.loads(path.read_text())
        del data['units'][self.macro_id]
        data['units'][data['roots'][0]]['dependencies'] = []
        path.write_text(json.dumps(data))
        with self.assertRaises(ValueError): generator.rendered(self.root)

    def test_shipped_wasm_foreign_kind_phase_context_and_subgraph_refuse(self):
        path = self.directory / next(iter(generator.WASM_CONTEXTS))
        original = json.loads(path.read_text())
        for field, value in [('emit_cdylib', False), ('platform', 'aarch64-apple-darwin'), ('mode', 'check')]:
            changed = copy.deepcopy(original)
            changed['units'][changed['roots'][0]][field] = value
            path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError): generator.rendered(self.root)
        changed = copy.deepcopy(original)
        changed['units'][self.macro_id]['mode'] = 'check'
        path.write_text(json.dumps(changed))
        with self.assertRaises(ValueError): generator.rendered(self.root)
        path.write_text(json.dumps(original))
        path.unlink()
        with self.assertRaises(FileNotFoundError): generator.rendered(self.root)

    def test_same_count_duplicate_context_inventory_rejects(self):
        for path in self.directory.iterdir():
            path.unlink()
        for index in range(20):
            self.write(f'fake{index}__release__duplicate.json', 'merkur-stun/release/aarch64-apple-darwin', 'aarch64-apple-darwin')
        with self.assertRaises(ValueError): generator.rendered(self.root)

    def test_missing_extra_and_renamed_contexts_reject(self):
        path = next(self.directory.iterdir())
        original = path.read_bytes()
        path.unlink()
        with self.assertRaises(ValueError): generator.rendered(self.root)
        path.write_bytes(original)
        foreign = self.directory / 'foreign__release__aarch64_apple_darwin.json'
        foreign.write_bytes(original)
        with self.assertRaises(ValueError): generator.rendered(self.root)
        foreign.unlink()
        path.rename(foreign)
        with self.assertRaises(ValueError): generator.rendered(self.root)

    def test_correct_names_with_foreign_compiler_or_target_reject(self):
        path = next(self.directory.iterdir())
        original = json.loads(path.read_bytes())
        for key in ['compiler_root', 'target']:
            changed = json.loads(json.dumps(original))
            changed['configuration'][key] = 'foreign'
            path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError): generator.rendered(self.root)
        path.write_text(json.dumps(original))

    def test_matching_context_fields_with_foreign_binary_or_profile_reject(self):
        path = next(self.directory.iterdir())
        original = json.loads(path.read_bytes())
        for branch, key, replacement in [('target', 'name', 'foreign'),
                                         ('target', 'kind', ['lib']),
                                         ('target', 'crate_types', ['lib']),
                                         ('profile', 'name', 'dev')]:
            changed = json.loads(json.dumps(original))
            changed['units']['selected'][branch][key] = replacement
            path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError): generator.rendered(self.root)
        changed = json.loads(json.dumps(original))
        changed['packages']['fixture']['name'] = 'foreign'
        path.write_text(json.dumps(changed))
        with self.assertRaises(ValueError): generator.rendered(self.root)


class OriginalWasmFacade(unittest.TestCase):
    def test_same_original_wrapped_cdylib_providers_and_graph_are_forwarded(self):
        class DefaultInfo:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
        class Files:
            def __init__(self, value):
                self.value = value
            def to_list(self):
                return self.value
        def fail(message):
            raise ValueError(message)
        crate_info, test_crate_info, link_info, groups, graph_info = [object() for _ in range(5)]
        namespace = {'DefaultInfo': DefaultInfo, 'OutputGroupInfo': groups, 'TestCrateInfo': test_crate_info,
                     'RustLinkMapInfo': link_info, '_CompilerGraphInfo': graph_info, 'fail': fail,
                     'rust_common': types.SimpleNamespace(crate_info=crate_info),
                     'type': lambda value: 'list' if isinstance(value, list) else type(value).__name__}
        directory = Path(__file__).parent
        for path, name in [(directory.parent / 'rust/units.bzl', '_wasm_artifact_impl'),
                           (directory / 'rust-compiled.bzl', '_compiler_graph_impl')]:
            function = next(node for node in ast.parse(path.read_text()).body
                            if isinstance(node, ast.FunctionDef) and node.name == name)
            exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), namespace)
        artifact = object()
        crate = types.SimpleNamespace(type='cdylib', is_test=False, output=artifact)
        original = {DefaultInfo: DefaultInfo(files=Files([artifact])), test_crate_info: types.SimpleNamespace(crate=crate),
                    link_info: object(), groups: object(), graph_info: object()}
        context = types.SimpleNamespace(attr=types.SimpleNamespace(target=[original]))
        forwarded = namespace['_wasm_artifact_impl'](context)
        self.assertIs(forwarded[0].files, original[DefaultInfo].files)
        self.assertEqual(forwarded[1:], [crate, original[link_info], original[groups]])
        target = {DefaultInfo: forwarded[0], crate_info: crate, link_info: original[link_info]}
        context.rule = types.SimpleNamespace(kind='wasm_artifact', attr=context.attr)
        self.assertEqual(namespace['_compiler_graph_impl'](target, context), [original[graph_info]])
        for field, invalid in [('type', 'rlib'), ('is_test', True), ('output', object())]:
            saved = getattr(crate, field)
            setattr(crate, field, invalid)
            with self.assertRaises(ValueError): namespace['_wasm_artifact_impl'](context)
            setattr(crate, field, saved)
        for provider in [DefaultInfo, crate_info, link_info]:
            changed = dict(target)
            changed[provider] = DefaultInfo(files=Files([artifact])) if provider is DefaultInfo else object()
            with self.assertRaises(ValueError): namespace['_compiler_graph_impl'](changed, context)


class OriginalCompilerUnitIdentity(unittest.TestCase):
    def setUp(self):
        class StarlarkString(str):
            def __getitem__(self, key):
                return StarlarkString(super().__getitem__(key))
            def elems(self):
                return list(self)
        self.string = StarlarkString
        self.identity = hashlib.sha256(b'original configured cdylib unit').hexdigest()
        def label(name, package='tools/bazel/rust/units', repository=''):
            return types.SimpleNamespace(name=self.string(name), package=self.string(package), repo_name=repository)
        self.label = label
        namespace = {'fail': lambda message: (_ for _ in ()).throw(ValueError(message)),
                     'Label': lambda value: label('BUILD.bazel')}
        path = Path(__file__).with_name('rust-compiled.bzl')
        function = next(node for node in ast.parse(path.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == '_unit_id')
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), namespace)
        self.unit_id = namespace['_unit_id']

    def test_original_cdylib_subpackage_preserves_exact_captured_unit_identity(self):
        value = self.label('cdylib', 'tools/bazel/rust/units/' + self.identity)
        self.assertEqual(self.unit_id(value, 'rust_cdylib_library'), self.identity)
        self.assertEqual(self.unit_id(self.label('u_' + self.identity), 'rust_library'), self.identity)
        self.assertEqual(self.unit_id(self.label('u_' + self.identity), 'cargo_build_script'), self.identity)

    def test_same_compiled_owner_gate_binds_cdylib_and_native_to_original_graph_root(self):
        # Execute the real producer identity gate, before any inventory/action
        # construction. This controls its original owner fields, not a complete
        # attribution provider or an executed compiler fixture.
        graph_info, crate_info = object(), object()
        namespace = {'_CompilerGraphInfo': graph_info,
                     'rust_common': types.SimpleNamespace(crate_info=crate_info),
                     '_unit_id': self.unit_id,
                     'fail': lambda message: (_ for _ in ()).throw(ValueError(message))}
        path = Path(__file__).with_name('rust-compiled.bzl')
        function = next(node for node in ast.parse(path.read_text()).body
                        if isinstance(node, ast.FunctionDef) and node.name == '_compiled_attribution_impl')
        boundary = next(index for index, node in enumerate(function.body)
                        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                        and node.targets[0].id == 'artifact')
        function.body = function.body[:boundary] + [ast.Return(value=ast.Constant(value=True))]
        module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
        exec(compile(module, str(path), 'exec'), namespace)
        validate = namespace['_compiled_attribution_impl']
        def context(owner, kind, wasm=True, root=None):
            producer = {graph_info: types.SimpleNamespace(root=root or self.identity),
                        crate_info: types.SimpleNamespace(owner=owner, type=kind)}
            return types.SimpleNamespace(attr=types.SimpleNamespace(producer=producer,
                target_triple='wasm32-unknown-unknown' if wasm else 'aarch64-apple-darwin'))
        original = self.label('cdylib', 'tools/bazel/rust/units/' + self.identity)
        self.assertTrue(validate(context(original, 'cdylib')))
        for kind in ['bin', 'proc-macro']:
            self.assertTrue(validate(context(self.label('u_' + self.identity), kind, wasm=False)))
        refused = [
            context(original, 'cdylib', root='0' * 64),
            context(self.label('cdylib', original.package, 'foreign'), 'cdylib'),
            context(self.label('cdylib', 'foreign/' + self.identity), 'cdylib'),
            context(original, 'bin'), context(original, 'bin', wasm=False),
            context(self.label('u_' + self.identity), 'rlib', wasm=False),
        ]
        for value in refused:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate(value)

    def test_foreign_namespace_role_or_malformed_unit_package_refused(self):
        valid = 'tools/bazel/rust/units/' + self.identity
        cases = [
            (self.label('cdylib', valid, 'foreign'), 'rust_cdylib_library'),
            (self.label('cdylib', 'foreign/' + self.identity), 'rust_cdylib_library'),
            (self.label('cdylib', valid), 'rust_library'),
            (self.label('cdylib', valid), 'cargo_build_script'),
            (self.label('cdylib', valid + '/nested'), 'rust_cdylib_library'),
            (self.label('cdylib', 'tools/bazel/rust/units/'), 'rust_cdylib_library'),
            (self.label('cdylib', 'tools/bazel/rust/units/' + self.identity.upper()), 'rust_cdylib_library'),
            (self.label('cdylib', valid[:-1] + 'z'), 'rust_cdylib_library'),
            (self.label('other', valid), 'rust_cdylib_library'),
            (self.label('u_' + self.identity[:-1]), 'rust_library'),
            (self.label('u_' + self.identity[:-1] + 'z'), 'rust_library'),
        ]
        for label, kind in cases:
            with self.subTest(label=label, kind=kind), self.assertRaises(ValueError):
                self.unit_id(label, kind)


if __name__ == '__main__':
    unittest.main()
