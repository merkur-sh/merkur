#!/usr/bin/env python3
"""Bounded metadata-only input and original archive refusal controls."""

import argparse
import ast
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import re
import sys
import textwrap
import unittest
from types import SimpleNamespace


spec = importlib.util.spec_from_file_location('linux_typecheck', Path(__file__).with_name('linux-typecheck.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

ORIGINAL_SHA256 = 'd8bcc1e111e98270dc03172e22ef7af9c2f94f3269801618a2b83d20890f8df5'
ROOT_DEFAULTS = None


def patched_rule_source(original, patch):
    """Apply only the exact maintained rust.bzl hunks, without offsets or fuzz."""
    result = original.splitlines(keepends=True)
    lines = patch.splitlines(keepends=True)
    index = 0
    sections = 0
    while index < len(lines):
        if lines[index].rstrip() != '--- a/rust/private/rust.bzl':
            index += 1
            continue
        sections += 1
        index += 1
        if lines[index].rstrip() != '+++ b/rust/private/rust.bzl':
            raise ValueError('Maintained Rust source patch destination differs')
        index += 1
        offset = 0
        while index < len(lines) and lines[index].startswith('@@ '):
            header = re.fullmatch(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*\n?', lines[index])
            if header is None:
                raise ValueError('Malformed maintained source hunk')
            start = int(header[1]) - 1 + offset
            old_count = int(header[2] or '1')
            new_count = int(header[4] or '1')
            index += 1
            before, after = [], []
            while index < len(lines) and lines[index][:1] in (' ', '+', '-') and not lines[index].startswith(('--- ', '+++ ')):
                line = lines[index]
                if line[0] in ' -':
                    before.append(line[1:])
                if line[0] in ' +':
                    after.append(line[1:])
                index += 1
            if len(before) != old_count or len(after) != new_count or result[start:start + old_count] != before:
                raise ValueError('Maintained source hunk differs from the original bytes')
            result[start:start + old_count] = after
            offset += new_count - old_count
    if sections == 0:
        raise ValueError('Maintained patch does not bind the Rust rule source')
    return ''.join(result)


class AttributeDefaults:
    """Evaluate original attribute declarations only; never execute rule actions."""

    def __getattr__(self, kind):
        defaults = {'label': None, 'label_list': [], 'label_keyed_string_dict': {},
            'string': '', 'string_list': [], 'string_dict': {}, 'bool': False, 'int': 0}
        if kind not in defaults:
            raise ValueError('Unmodeled original attribute type: ' + kind)
        return lambda **kwargs: copy.deepcopy(kwargs.get('default', defaults[kind]))


def original_root_defaults(archive_path, patch_path):
    data = Path(archive_path).read_bytes()
    if hashlib.sha256(data).hexdigest() != ORIGINAL_SHA256:
        raise ValueError('rules_rust original archive checksum differs')
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        rust = tar.extractfile('./rust/private/rust.bzl').read().decode()
        allocator = tar.extractfile('./rust/private/rust_allocator_libraries.bzl').read().decode()
    rust = patched_rule_source(rust, Path(patch_path).read_text())
    wanted = {'RUSTC_ALLOCATOR_LIBRARIES_ATTRS', 'RUSTC_ATTRS', '_COMMON_ATTRS',
        '_PLATFORM_ATTRS', '_EXPERIMENTAL_USE_CC_COMMON_LINK_ATTRS', '_RUST_BINARY_ATTRS',
        '_stamp_attribute', '_common_attrs_for_binary_without_process_wrapper'}
    namespace = {'attr': AttributeDefaults(), 'Label': lambda value: value,
        'dedent': textwrap.dedent, 'configuration_field': lambda **kwargs: None,
        'rust_common': SimpleNamespace(crate_info=object())}
    for name in ['AllocatorLibrariesInfo', 'CcInfo', 'LintsInfo', 'CrateInfo',
            'CrateGroupInfo', 'UnstableRustFeaturesInfo', 'UnstableSelfProfileInfo']:
        namespace[name] = object()
    found = set()
    for filename, source in [('allocator.bzl', allocator), ('rust.bzl', rust)]:
        for node in ast.parse(source).body:
            name = node.name if isinstance(node, ast.FunctionDef) else node.targets[0].id if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) else None
            if name in wanted:
                if name in found:
                    raise ValueError('Original attribute declaration duplicated: ' + name)
                found.add(name)
                exec(compile(ast.Module(body=[node], type_ignores=[]), filename, 'exec'), namespace)
    if found != wanted:
        raise ValueError('Original attribute declarations incomplete')
    roots = {}
    for node in ast.parse(rust).body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ['rust_binary', 'rust_binary_without_process_wrapper']:
            if not isinstance(node.value, ast.Call) or not isinstance(node.value.func, ast.Name) or node.value.func.id != 'rule':
                raise ValueError('Original binary rule declaration differs')
            expressions = [keyword.value for keyword in node.value.keywords if keyword.arg == 'attrs']
            if len(expressions) != 1 or node.targets[0].id in roots:
                raise ValueError('Original binary attribute expression duplicated or absent')
            roots[node.targets[0].id] = eval(compile(ast.Expression(body=expressions[0]), 'original-rule-attrs.bzl', 'eval'), namespace)
    if set(roots) != {'rust_binary', 'rust_binary_without_process_wrapper'}:
        raise ValueError('Original binary rules incomplete')
    return roots


class RuleAttributes(SimpleNamespace):
    def __dir__(self):
        return list(self.__dict__)


def archive(names):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:xz') as tar:
        for name, kind in names:
            member = tarfile.TarInfo(name)
            if kind == 'link':
                member.type = tarfile.SYMTYPE
                member.linkname = '/outside'
                tar.addfile(member)
            else:
                data = b'fixture archive structure only'
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
    return output.getvalue()


class Controls(unittest.TestCase):
    def setUp(self):
        self.target = 'x86_64-unknown-linux-gnu'
        self.member = 'rust-std-1.97.1-' + self.target + '/rust-std-' + self.target + '/lib/rustlib/' + self.target + '/lib/libstd-fixture.rlib'
        self.request = {'target': self.target, 'execution_host': 'aarch64-apple-darwin',
            'rustc': 'rustc', 'compiler_archive': 'rustc.tar.xz', 'std_archive': 'std.tar.xz',
            'pins': 'pins.py', 'compiler_files': ['rustc'], 'configured_std': ['libstd.rlib'],
            'sources': ['worker.rs'], 'root': 'worker.rs', 'crate_name': 'worker',
            'crate_type': 'bin', 'edition': '2024', 'rustc_flags': [], 'dependencies': {}, 'dependency_files': []}

    def members(self, entries):
        data = archive(entries)
        return driver.std_members(data, self.target, hashlib.sha256(data).hexdigest(), '1.97.1')

    def test_original_member_layout_only(self):
        self.assertEqual(list(self.members([(self.member, 'file')])), ['libstd-fixture.rlib'])

    def test_duplicate_and_normalized_alias_refuse(self):
        for name in [self.member, self.member.replace('/lib/libstd', '/lib/./libstd')]:
            with self.assertRaises(ValueError):
                self.members([(self.member, 'file'), (name, 'file')])

    def test_alias_and_traversal_refuse(self):
        for name, kind in [(self.member, 'link'), ('../outside', 'file')]:
            with self.assertRaises(ValueError):
                self.members([(name, kind)])

    def test_wrong_target_and_digest_refuse(self):
        data = archive([(self.member, 'file')])
        for target, digest in [('wasm32-unknown-unknown', hashlib.sha256(data).hexdigest()), (self.target, '0' * 64)]:
            with self.assertRaises(ValueError):
                driver.std_members(data, target, digest, '1.97.1')

    def test_no_fake_cfg_or_undeclared_metadata(self):
        driver.validate(self.request)
        for key, value in [('cfg', ['target_os="linux"']), ('root', 'outside.rs'), ('sources', ['worker.rs', '../outside.rs']), ('dependencies', {'libc': 'outside.rmeta'}), ('compiler_files', []), ('configured_std', [])]:
            request = dict(self.request, **{key: value})
            with self.assertRaises(ValueError):
                driver.validate(request)

    def test_host_and_target_are_real_declarations(self):
        for key, value in [('execution_host', 'x86_64-unknown-linux-gnu'), ('target', 'aarch64-apple-darwin'), ('crate_name', 'worker;command')]:
            with self.assertRaises(ValueError):
                driver.validate(dict(self.request, **{key: value}))

    def test_literal_flags_preserved_and_metadata_authority_cannot_be_overridden(self):
        driver.validate(dict(self.request, rustc_flags=['-Cstrip=debuginfo', '--cfg', 'configured_root']))
        for flags in [['--emit=link'], ['--target=x86_64-apple-darwin'], ['--sysroot', 'outside'], ['-ooutside'], ['--extern=libc=outside.rmeta'], ['@outside.args'], ['$(location :outside)'], ['--cfg=target_os="linux"'], ['--cfg', 'test']]:
            with self.assertRaises(ValueError):
                driver.validate(dict(self.request, rustc_flags=flags))

    def root_contract(self, kind='rust_binary', **changes):
        source = Path(__file__).with_name('linux_typecheck.bzl').read_text()
        start = source.index('_ROOT_ATTRIBUTES =')
        end = source.index('\ndef _root_aspect_impl', start)
        namespace = {'fail': lambda message: (_ for _ in ()).throw(ValueError(message))}
        exec(source[start:end], namespace)
        fields = copy.deepcopy(ROOT_DEFAULTS[kind])
        fields.update(changes)
        empty = SimpleNamespace(to_list=lambda: [])
        crate = SimpleNamespace(is_test=False, compile_data=empty, compile_data_targets=empty, cfgs=[])
        for name in ['is_test', 'provider_compile_data']:
            if name in fields:
                value = fields.pop(name)
                if name == 'is_test':
                    crate.is_test = value
                else:
                    crate.compile_data = SimpleNamespace(to_list=lambda: value)
        return namespace['_root_contract'](kind, RuleAttributes(**fields), crate)

    def test_complete_original_and_maintained_attribute_inventories(self):
        for kind, fields in ROOT_DEFAULTS.items():
            with self.subTest(kind=kind):
                self.assertGreater(len(fields), 50)
                self.assertEqual(self.root_contract(kind=kind), [])
                for name in ['proc_macro_aliases', 'native_link_map', 'wasm_link_map', 'apply_lints_in_exec', 'semantic_metadata']:
                    self.assertIn(name, fields)
                self.assertIs(fields['wasm_link_map'], False)

    def test_actual_maintained_extensions_refuse_when_nonempty(self):
        for kind in ROOT_DEFAULTS:
            for name, value in [('proc_macro_aliases', {'macro': 'alias'}), ('native_link_map', True), ('wasm_link_map', True), ('apply_lints_in_exec', True), ('semantic_metadata', 'matched')]:
                with self.subTest(kind=kind, name=name), self.assertRaises(ValueError):
                    self.root_contract(kind=kind, **{name: value})

    def test_maintained_patch_context_corruption_refuses(self):
        original = 'original\n'
        patch = '--- a/rust/private/rust.bzl\n+++ b/rust/private/rust.bzl\n@@ -1 +1 @@\n-original\n+patched\n'
        self.assertEqual(patched_rule_source(original, patch), 'patched\n')
        for wrong in [patch.replace('-original', '-foreign'), patch.replace('@@ -1 +1', '@@ -2 +2'), patch.replace('b/rust/private/rust.bzl', 'b/foreign.bzl')]:
            with self.assertRaises(ValueError):
                patched_rule_source(original, wrong)

    def test_uncollected_features_and_test_compile_data_refuse(self):
        for kind in ROOT_DEFAULTS:
            for fields in [{'crate_features': ['hidden_feature']}, {'is_test': True}, {'compile_data': ['fixture']}, {'provider_compile_data': ['fixture']}, {'unknown_compile_attribute': []}, {'rustc_env': {'HIDDEN': 'value'}}, {'proc_macro_deps': ['derive']}]:
                with self.subTest(kind=kind, fields=fields), self.assertRaises(ValueError):
                    self.root_contract(kind=kind, **fields)

    def test_uncollected_custom_cfg_is_captured_from_actual_source_attributes(self):
        flags = ['--cfg', 'configured_root', '-Cstrip=debuginfo']
        self.assertEqual(self.root_contract(rustc_flags=flags), flags)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--original-archive', required=True)
    parser.add_argument('--maintained-patch', required=True)
    args, unittest_args = parser.parse_known_args()
    ROOT_DEFAULTS = original_root_defaults(args.original_archive, args.maintained_patch)
    unittest.main(argv=[sys.argv[0], *unittest_args])
