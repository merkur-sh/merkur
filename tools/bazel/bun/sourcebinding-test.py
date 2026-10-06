"""Existing source SDK factory declaration controls; no native provider qualification."""

import argparse
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


def declarations(source, bindings):
    # Evaluate the same factory body, isolating only its target constructors.
    # Constructor capture asserts declared inputs, never tool execution/providers.
    module = ast.parse(source.read_text())
    module.body = [node for node in module.body if isinstance(node, (ast.Assign, ast.FunctionDef))]
    calls = []
    def capture(kind):
        def invoke(**values):
            calls.append((kind, values))
        return invoke
    def fail(message):
        raise ValueError(message)
    names = ["declared_cmake_driver", "declared_cmake_sdk", "declared_bun_build_utility",
             "declared_ninja_sdk", "llvm_sdk", "bun_runtime_build_native",
             "bun_source_runtime_compile", "bun_runtime_selected_inputs"]
    context = {name: capture(name) for name in names}
    context.update({"fail": fail, "native": SimpleNamespace(filegroup=capture("filegroup")),
                    "runtime_webkit_pin": lambda platform: SimpleNamespace(url="explicit-unit-archive", sha256="unit-pin"),
                    "PUBLISHER_NOTICE_INPUTS": {"explicit-unit-identity": {"metadata": "//unit:metadata", "source": "//unit:source"}}})
    exec(compile(module, str(source), 'exec'), context)
    context['bun_native_runtime_targets']('unit', bindings)
    return calls


def binding(linux=False):
    value = {name: '//original-unit-sdk:' + name for name in ['sysroot', 'ranlib', 'git', 'uname', 'shell', 'make']}
    value['tools'] = {name: '//original-unit-sdk:' + name for name in ['tar', 'touch', 'mkdir', 'cp', 'rm', 'cat', 'env']}
    if linux:
        value.update(strip='//original-unit-sdk:strip', compiler_constraint='//original-unit-sdk:compiler')
    return value


class Controls(unittest.TestCase):
    def test_known_partial_platform_retains_exact_original_inputs(self):
        value = binding()
        calls = declarations(args.factory, {'darwin_arm64': value})
        self.assertTrue(calls)
        self.assertTrue(all(item['name'].startswith('unit_darwin_arm64') for _, item in calls))
        cmake = next(item for kind, item in calls if kind == 'declared_cmake_sdk')
        self.assertEqual(cmake['target'], 'aarch64-apple-darwin')
        self.assertEqual(cmake['sdk'], value['shell'])
        self.assertEqual(cmake['make'], value['make'])
        self.assertEqual(cmake['git'], value['git'])
        runtime = next(item for kind, item in calls if kind == 'bun_runtime_build_native')
        self.assertEqual(runtime['sysroot'], value['sysroot'])
        self.assertEqual(runtime['tools'][value['tools']['env']], 'env')
        self.assertIn(value['tools']['env'], runtime['runtime_library_roots'])
        self.assertEqual(len(runtime['dependencies']), 21)

    def test_all_four_original_target_triples(self):
        targets = {'darwin_arm64': 'aarch64-apple-darwin', 'darwin_x64': 'x86_64-apple-darwin',
                   'linux_arm64': 'aarch64-unknown-linux-gnu', 'linux_x64': 'x86_64-unknown-linux-gnu'}
        calls = declarations(args.factory, {name: binding(name.startswith('linux')) for name in targets})
        observed = {item['name'].removeprefix('unit_').removesuffix('_cmake'): item['target']
                    for kind, item in calls if kind == 'declared_cmake_sdk'}
        self.assertEqual(observed, targets)

    def test_empty_and_foreign_platform_refused(self):
        for values in [{}, {'windows_x64': binding()}]:
            with self.assertRaisesRegex(ValueError, 'nonempty known'):
                declarations(args.factory, values)

    def test_missing_sdk_role_refused(self):
        for name in binding():
            value = binding()
            del value[name]
            with self.subTest(role=name), self.assertRaisesRegex(ValueError, 'absent/foreign'):
                declarations(args.factory, {'darwin_arm64': value})

    def test_missing_or_foreign_utility_refused(self):
        for change in ['missing', 'foreign', 'empty']:
            value = binding()
            if change == 'missing':
                del value['tools']['env']
            elif change == 'foreign':
                value['tools']['foreign'] = '//unit:foreign'
            else:
                value['tools']['env'] = ''
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'utility SDK'):
                declarations(args.factory, {'darwin_arm64': value})

    def test_one_tool_target_cannot_claim_two_names(self):
        value = binding()
        value['tools']['cat'] = value['tools']['env']
        with self.assertRaisesRegex(ValueError, 'multiple tool identities'):
            declarations(args.factory, {'darwin_arm64': value})

    def test_linux_requires_original_compiler_constraint(self):
        value = binding(linux=True)
        calls = declarations(args.factory, {'linux_x64': value})
        cmake = next(item for kind, item in calls if kind == 'declared_cmake_sdk')
        self.assertEqual(cmake['exec_compatible_with'], ['@platforms//os:linux', '@platforms//cpu:x86_64', value['compiler_constraint']])
        del value['compiler_constraint']
        with self.assertRaisesRegex(ValueError, 'absent/foreign'):
            declarations(args.factory, {'linux_x64': value})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--factory', type=Path, required=True)
    args = parser.parse_args()
    unittest.main(argv=['source-sdk-factory-controls'])
