"""Synthetic registration controls; these do not manufacture configured providers."""
import ast
import hashlib
from pathlib import Path
import types
import unittest


class Label:
    def __init__(self, value):
        if not value.startswith(('//', ':', '@')) or ':' not in value:
            raise ValueError('Malformed fixture label')
        self.value = value
        self.name = value.rsplit(':', 1)[1]
        self.package = value.split("//", 1)[1].split(":", 1)[0] if "//" in value else ""
        self.repo_name = value.split("//", 1)[0].lstrip("@") if "//" in value else ""

    def __eq__(self, other):
        return isinstance(other, Label) and self.value == other.value

    def __hash__(self):
        return hash(self.value)


class StarlarkMethods(ast.NodeTransformer):
    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Attribute) and node.func.attr == 'elems':
            return ast.copy_location(ast.Call(func=ast.Name(id='list', ctx=ast.Load()),
                                             args=[node.func.value], keywords=[]), node)
        return node


def fail(message):
    raise ValueError(message)


def source(path, namespace):
    parsed = ast.parse(path.read_text())
    body = [row for row in parsed.body if not isinstance(row, ast.Expr)]
    module = StarlarkMethods().visit(ast.Module(body=body, type_ignores=[]))
    exec(compile(ast.fix_missing_locations(module), str(path), 'exec'), namespace)


def fixture():
    calls = []
    namespace = {'Label': Label, 'fail': fail, 'struct': lambda **kw: types.SimpleNamespace(**kw),
                 'type': lambda value: 'dict' if isinstance(value, dict) else 'list' if isinstance(value, list) else 'string' if isinstance(value, str) else type(value).__name__,
                 'native': types.SimpleNamespace(package_name=lambda: 'tools/bazel/packaging')}
    for name in ['native_unsigned_release', 'bun_npm_attribution', 'first_party_attribution',
                 'npm_attribution', 'rust_attribution', 'compiled_rust_attribution',
                 'selected_wasm_input_custody']:
        namespace[name] = lambda _name=name, **kw: calls.append((_name, kw))
    # The exact original consumer layouts remain the production source of roles.
    layout_path = Path(__file__).with_name('native-release.bzl')
    parsed = ast.parse(layout_path.read_text())
    wanted = {'NATIVE_RELEASE_PLATFORMS', 'NATIVE_RELEASE_TARGETS', '_DAEMON_FILES'}
    body = [row for row in parsed.body if
            isinstance(row, ast.Assign) and any(isinstance(key, ast.Name) and key.id in wanted for key in row.targets)
            or isinstance(row, ast.FunctionDef) and row.name == 'native_release_layout']
    exec(compile(ast.Module(body=body, type_ignores=[]), str(layout_path), 'exec'), namespace)
    source(Path(__file__).with_name('native-suppliers.bzl'), namespace)
    values = {}
    for item in namespace['_layouts']():
        rust = {}
        if item.kind == 'daemon':
            for public, package in namespace['_rust'](item.platform).items():
                triple = namespace['_TARGETS'][item.platform]
                profile = 'profile_use' if package == 'merkur-dataplane' else 'release'
                identity = package + '/' + profile + '/' + triple
                compiler = '//tools/bazel/rust/release_pgo/' + triple if package == 'merkur-dataplane' else '//tools/bazel/rust/units'
                rust[public] = {'producer': compiler + ':u_' + hashlib.sha256(identity.encode()).hexdigest(),
                                'descriptor': '//fixture:' + identity.replace('/', '_'),
                                'compiler_root': identity, 'packages': {'//fixture:package': identity},
                                'stdlib_notices': '//fixture:stdlib_' + item.platform}
        producer = '//apps/daemon:daemon' if item.kind == 'daemon' else '//scripts:release_verifier'
        values[item.layout.name] = {'bun': {'producer': producer, 'packages': ['//fixture:authored'],
                                          'registry': '//tools/bazel/bun:npm-inventory.json',
                                          'wasm': {'rust_producers': {'//fixture:wasm_compiler': '//packages/e2e-wasm:wasm_artifacts'},
                                                   'rust_attributions': {'//fixture:wasm_compiled_scope': '//packages/e2e-wasm:wasm_artifacts'},
                                                   'rust_packages': {'//fixture:wasm_source': 'workspace:packages/e2e-wasm'},
                                                   'generator_attributions': ['//fixture:bindgen', '//fixture:wasm_opt']},
                                          'embedded_runtime': '//fixture:runtime_' + item.layout.name}, 'rust': rust}
    return namespace, values, calls


class Controls(unittest.TestCase):
    def test_complete_registration_preserves_same_original_dependencies(self):
        namespace, values, calls = fixture()
        out = namespace['declare_native_release_suppliers'](values)
        self.assertEqual(set(out), set(values))
        self.assertEqual(len(calls), 54)
        compiled = [kw for name, kw in calls if name == 'compiled_rust_attribution']
        self.assertEqual(len(compiled), 12)
        for item in namespace['_layouts']():
            value = values[item.layout.name]
            release = next(kw for name, kw in calls if name == 'native_unsigned_release' and kw['name'] == item.layout.name)
            self.assertEqual(release['files'], item.layout.files)
            self.assertEqual(release['platform'], item.platform)
            self.assertEqual(len(release['attributions']), 7 if item.kind == 'daemon' else 4)
            self.assertIn(':' + item.layout.name + '_selected_wasm', release['attributions'])
            self.assertIn(value['bun']['embedded_runtime'], release['attributions'])
            for public, spec in value['rust'].items():
                bound = next(kw for kw in compiled if kw['producer'] == spec['producer'])
                self.assertEqual(bound['descriptor'], spec['descriptor'])
                self.assertIs(bound['packages'], spec['packages'])
                self.assertEqual(bound['stdlib_notices'], spec['stdlib_notices'])
                self.assertEqual(bound['target_triple'], namespace['_TARGETS'][item.platform])
            prefix = item.layout.name + '_selected'
            selector = next(kw for name, kw in calls if name == 'bun_npm_attribution' and kw['name'] == prefix + '_npm_sources')
            authored = next(kw for name, kw in calls if name == 'first_party_attribution' and kw['name'] == prefix + '_first_party')
            npm = next(kw for name, kw in calls if name == 'npm_attribution' and kw['name'] == prefix + '_npm')
            self.assertEqual(selector['compiler'], value['bun']['producer'])
            self.assertEqual(authored['producer'], selector['compiler'])
            self.assertIs(authored['packages'], value['bun']['packages'])
            self.assertEqual(npm['producer'], ':' + selector['name'])
            wasm = next(kw for name, kw in calls if name == 'selected_wasm_input_custody' and kw['name'] == prefix + '_wasm')
            self.assertEqual(wasm['compiler'], selector['compiler'])
            for field, original in value['bun']['wasm'].items():
                self.assertIs(wasm[field], original)
            self.assertIn(':' + wasm['name'], release['attributions'])

    def test_each_native_daemon_retains_same_trained_supplier_and_shipping_filename(self):
        namespace, values, calls = fixture()
        namespace['declare_native_release_suppliers'](values)
        for item in namespace['_layouts']():
            if item.kind != 'daemon':
                continue
            triple = namespace['NATIVE_RELEASE_TARGETS'][item.platform]
            trained = '//tools/bazel/rust/release_pgo/' + triple + ':dataplane_release'
            spec = values[item.layout.name]['rust'][trained]
            release = next(kw for name, kw in calls if name == 'native_unsigned_release' and kw['name'] == item.layout.name)
            self.assertEqual(release['files'][trained], 'merkur-dataplane')
            self.assertNotIn('//apps/daemon/dataplane:merkur_dataplane', release['files'])
            self.assertEqual(spec['compiler_root'], 'merkur-dataplane/profile_use/' + triple)
            bound = next(kw for name, kw in calls if name == 'compiled_rust_attribution' and kw['producer'] == spec['producer'])
            self.assertEqual(Label(bound['producer']).package, 'tools/bazel/rust/release_pgo/' + triple)
            self.assertEqual(bound['descriptor'], spec['descriptor'])
            self.assertIs(bound['packages'], spec['packages'])
            self.assertEqual(bound['stdlib_notices'], spec['stdlib_notices'])

    def test_plain_dataplane_role_cannot_replace_any_native_trained_supplier(self):
        namespace, _, _ = fixture()
        for platform, triple in namespace['NATIVE_RELEASE_TARGETS'].items():
            role = 'merkur-daemon-' + platform
            trained = '//tools/bazel/rust/release_pgo/' + triple + ':dataplane_release'
            self.refuses(lambda _, rows, role=role, trained=trained: rows[role]['rust'].update({'//apps/daemon/dataplane:merkur_dataplane': rows[role]['rust'].pop(trained)}), 'selected Rust release members')

    def test_plain_release_context_cannot_replace_any_native_profile_use(self):
        namespace, _, _ = fixture()
        for platform, triple in namespace['NATIVE_RELEASE_TARGETS'].items():
            role = 'merkur-daemon-' + platform
            trained = '//tools/bazel/rust/release_pgo/' + triple + ':dataplane_release'
            self.refuses(lambda _, rows, role=role, trained=trained, triple=triple: rows[role]['rust'][trained].update(compiler_root='merkur-dataplane/release/' + triple), 'Rust context differs')

    def test_profile_use_units_require_the_same_native_trained_namespace(self):
        namespace, _, _ = fixture()
        for platform, triple in namespace['NATIVE_RELEASE_TARGETS'].items():
            role = 'merkur-daemon-' + platform
            trained = '//tools/bazel/rust/release_pgo/' + triple + ':dataplane_release'
            foreign = next(value for value in namespace['NATIVE_RELEASE_TARGETS'].values() if value != triple)
            for package in ['tools/bazel/rust/units', 'tools/bazel/rust/release_pgo/' + foreign]:
                producer = '//' + package + ':u_' + 'a' * 64
                self.refuses(lambda _, rows, role=role, trained=trained, producer=producer: rows[role]['rust'][trained].update(producer=producer), 'original trained profile-use compiler')

    def test_same_package_spelling_in_foreign_repository_is_not_trained_authority(self):
        namespace, _, _ = fixture()
        for platform, triple in namespace['NATIVE_RELEASE_TARGETS'].items():
            role = 'merkur-daemon-' + platform
            trained = '//tools/bazel/rust/release_pgo/' + triple + ':dataplane_release'
            foreign = '@foreign//tools/bazel/rust/release_pgo/' + triple + ':u_' + 'a' * 64
            self.refuses(lambda _, rows, role=role, trained=trained, foreign=foreign: rows[role]['rust'][trained].update(producer=foreign), 'original trained profile-use compiler')

    def test_frontend_binds_original_profile_use_and_package_compilers(self):
        namespace, _, calls = fixture()
        scopes = {'//fixture:e2e': '//packages/e2e-wasm:wasm_artifacts',
                  '//fixture:graphics': '//packages/graphics-wasm:wasm_artifacts',
                  '//fixture:terminal': '//packages/term-wasm:wasm_artifacts'}
        packages = {'//fixture:source': 'workspace:packages/e2e-wasm'}
        generators = ['//fixture:bindgen', '//fixture:wasm_opt', '//fixture:pgo']
        self.assertEqual(namespace['declare_frontend_wasm_supplier'](scopes, packages, generators), ':web_wasm_notices')
        self.assertEqual(len(calls), 1)
        kind, selected = calls[0]
        self.assertEqual(kind, 'selected_wasm_input_custody')
        self.assertEqual(selected['compiler'], '//apps/web:frontend_precompressed')
        self.assertEqual(selected['rust_producers'], {
            '//tools/bazel/rust/units:e2e_wasm__release_wasm': '//packages/e2e-wasm:wasm_artifacts',
            '//tools/bazel/rust/units:graphics_wasm__release_wasm': '//packages/graphics-wasm:wasm_artifacts',
            '//tools/bazel/rust/units:term_wasm__profile_use_wasm': '//packages/term-wasm:wasm_artifacts',
        })
        self.assertIs(selected['rust_attributions'], scopes)
        self.assertIs(selected['rust_packages'], packages)
        self.assertIs(selected['generator_attributions'], generators)

    def test_frontend_missing_compiled_package_refuses_without_action(self):
        namespace, _, calls = fixture()
        with self.assertRaisesRegex(ValueError, 'attribution packages differ'):
            namespace['declare_frontend_wasm_supplier'](
                {'//fixture:e2e': '//packages/e2e-wasm:wasm_artifacts'},
                {'//fixture:source': 'workspace:packages/e2e-wasm'}, ['//fixture:bindgen'])
        self.assertEqual(calls, [])

    def refuses(self, mutate, message):
        namespace, values, calls = fixture()
        mutate(namespace, values)
        with self.assertRaisesRegex(ValueError, message):
            namespace['declare_native_release_suppliers'](values)
        self.assertEqual(calls, [])

    def test_every_missing_native_role_refuses_before_registration(self):
        _, values, _ = fixture()
        for name in values:
            self.refuses(lambda _, rows, name=name: rows.pop(name), 'six native release roles')

    def test_extra_native_role_refuses(self):
        self.refuses(lambda _, rows: rows.update({'foreign': {}}), 'six native release roles')

    def test_missing_each_bun_or_rust_field_refuses(self):
        _, values, _ = fixture()
        for role, spec in values.items():
            for field in spec['bun']:
                self.refuses(lambda _, rows, role=role, field=field: rows[role]['bun'].pop(field), 'Bun compiler')
            for producer, rust in spec['rust'].items():
                for field in rust:
                    self.refuses(lambda _, rows, role=role, producer=producer, field=field: rows[role]['rust'][producer].pop(field), 'original Rust compiler context')

    def test_coherent_selected_rust_omission_refuses(self):
        self.refuses(lambda _, rows: rows['merkur-daemon-linux-x64']['rust'].pop('//apps/tui:bin_merkur_tui'), 'selected Rust release members')

    def test_foreign_bun_producer_refuses(self):
        self.refuses(lambda _, rows: rows['verify-linux-arm64']['bun'].update(producer='//apps/daemon:daemon'), 'Bun compiler differs')

    def test_foreign_registry_refuses(self):
        self.refuses(lambda _, rows: rows['verify-linux-x64']['bun'].update(registry='//fixture:registry'), 'registry differs')

    def test_standalone_wasm_label_cannot_replace_original_join(self):
        self.refuses(lambda _, rows: rows['verify-linux-x64']['bun'].update(wasm='//fixture:diagnostic'), 'complete source joins')

    def test_missing_and_extra_wasm_fields_refuse_before_registration(self):
        _, values, _ = fixture()
        for field in values['verify-linux-x64']['bun']['wasm']:
            self.refuses(lambda _, rows, field=field: rows['verify-linux-x64']['bun']['wasm'].pop(field), 'complete source joins')
        self.refuses(lambda _, rows: rows['verify-linux-x64']['bun']['wasm'].update(pending=[]), 'complete source joins')

    def test_missing_and_foreign_compiled_wasm_join_refuse(self):
        for field in ['rust_producers', 'rust_attributions']:
            self.refuses(lambda _, rows, field=field: rows['verify-linux-x64']['bun']['wasm'].update({field: {}}), 'nonempty original Rust joins')
        self.refuses(lambda _, rows: rows['verify-linux-x64']['bun']['wasm']['rust_attributions'].update({'//fixture:wasm_compiled_scope': '//packages/graphics-wasm:wasm_artifacts'}), 'attribution packages differ')

    def test_duplicate_wasm_package_join_refuses(self):
        for field in ['rust_producers', 'rust_attributions']:
            self.refuses(lambda _, rows, field=field: rows['verify-linux-x64']['bun']['wasm'][field].update({'//fixture:duplicate': '//packages/e2e-wasm:wasm_artifacts'}), 'one original Rust join')

    def test_empty_wasm_sources_or_generators_refuse(self):
        for field, empty in [('rust_packages', {}), ('generator_attributions', [])]:
            self.refuses(lambda _, rows, field=field, empty=empty: rows['verify-linux-x64']['bun']['wasm'].update({field: empty}), 'package source providers')

    def test_public_alias_cannot_replace_maintained_rust_unit(self):
        self.refuses(lambda _, rows: rows['merkur-daemon-darwin-arm64']['rust']['//apps/tui:bin_merkur_tui'].update(producer='//apps/tui:bin_merkur_tui'), 'maintained Rust compiler unit')

    def test_other_target_or_profile_refuses(self):
        for context in ['merkur-tui/release/x86_64-unknown-linux-gnu', 'merkur-tui/dev/aarch64-apple-darwin']:
            self.refuses(lambda _, rows, context=context: rows['merkur-daemon-darwin-arm64']['rust']['//apps/tui:bin_merkur_tui'].update(compiler_root=context), 'Rust context differs')

    def test_empty_and_duplicate_source_providers_refuse(self):
        for packages in [[], ['//fixture:source', '//fixture:source']]:
            self.refuses(lambda _, rows, packages=packages: rows['verify-linux-x64']['bun'].update(packages=packages), 'package source providers')
        self.refuses(lambda _, rows: rows['merkur-daemon-darwin-x64']['rust']['//apps/tui:bin_merkur_tui'].update(packages={'//fixture:a': 'same', '//fixture:b': 'same'}), 'distinct original Cargo')

    def test_wrong_package_namespace_refuses(self):
        self.refuses(lambda namespace, _: namespace.update(native=types.SimpleNamespace(package_name=lambda: 'release')), 'package action namespace')


if __name__ == '__main__':
    unittest.main()
