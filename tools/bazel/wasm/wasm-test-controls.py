"""Synthetic controls for the actual producer predicates, not cipher qualification."""
import ast
import sys
from pathlib import Path
from types import SimpleNamespace as S
import unittest
SOURCE = Path(sys.argv[1])
CrateInfo, TestRuntimeInfo = (object(), object())

def fail(message):
    raise ValueError(message)

def depset(files):
    return files

def DefaultInfo(**values):
    return S(**values)
parsed = ast.parse(SOURCE.read_text())
functions = ast.Module(body=[node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name in ['_codegen_contract', '_cipher_contract_impl', '_harness_impl', 'wasm_cipher_test']], type_ignores=[])
exec(compile(functions, str(SOURCE), 'exec'), globals())

def fixture():
    crate = S(is_test=True, type='bin', name='merkur_e2e', root=S(short_path='packages/merkur-e2e/src/lib.rs'), output=S(extension='wasm', is_directory=False))
    runtime = S(runfiles=object())
    target = {CrateInfo: crate, TestRuntimeInfo: runtime}
    attr = S(crate_features=['wasm'], rustc_flags=['-Copt-level=3', '-Cdebug-assertions=no', '-Ctarget-feature=+simd128'])
    return (target, S(rule=S(kind='rust_test', attr=attr)))

class Controls(unittest.TestCase):

    def test_real_testonly_harness_bridge(self):
        calls = []
        globals()['wasm_cipher_harness'] = lambda **kwargs: calls.append(('harness', kwargs))
        globals()['bun_command_test'] = lambda **kwargs: calls.append(('runner', kwargs))
        wasm_cipher_test(name='cipher', harness='//tools/bazel/rust/protocol_wasm:cipher_harness')
        self.assertEqual([name for name, _ in calls], ['harness', 'runner'])
        self.assertTrue(calls[0][1]['testonly'])
        self.assertEqual(calls[0][1]['harness'], '//tools/bazel/rust/protocol_wasm:cipher_harness')
        self.assertNotIn('_revocation_epochs', calls[0][1])
        self.assertEqual(calls[1][1]['environment_files'], {':cipher_harness': 'MERKUR_WASM_TEST_HARNESS'})

    def test_actual_producer_attributes(self):
        target, ctx = fixture()
        self.assertEqual(_cipher_contract_impl(target, ctx), [])
        ctx.rule.attr.rustc_flags[-1:] = ['-C', 'target-feature=+simd128']
        self.assertEqual(_cipher_contract_impl(target, ctx), [])

    def test_no_rlib_or_build_mode(self):
        for field, value in [('is_test', False), ('type', 'rlib'), ('name', 'e2e_wasm')]:
            target, ctx = fixture()
            setattr(target[CrateInfo], field, value)
            with self.assertRaises(ValueError):
                _cipher_contract_impl(target, ctx)

    def test_original_source_root(self):
        target, ctx = fixture()
        target[CrateInfo].root.short_path = 'foreign/lib.rs'
        with self.assertRaises(ValueError):
            _cipher_contract_impl(target, ctx)

    def test_no_native_default_feature(self):
        for features in [[], ['default', 'wasm'], ['std', 'wasm'], ['wasm', 'testing']]:
            target, ctx = fixture()
            ctx.rule.attr.crate_features = features
            with self.assertRaises(ValueError):
                _cipher_contract_impl(target, ctx)

    def test_release_actual_flags(self):
        for omitted in ['-Copt-level=3', '-Cdebug-assertions=no']:
            target, ctx = fixture()
            ctx.rule.attr.rustc_flags.remove(omitted)
            with self.assertRaises(ValueError):
                _cipher_contract_impl(target, ctx)

    def test_simd_actual_paired_flag(self):
        for flags in [[], ['target-feature=+simd128'], ['-C', 'codegen-units=1', 'target-feature=+simd128']]:
            target, ctx = fixture()
            ctx.rule.attr.rustc_flags[-1:] = flags
            with self.assertRaises(ValueError):
                _cipher_contract_impl(target, ctx)

    def test_not_filegroup_or_raw_file(self):
        target, ctx = fixture()
        ctx.rule.kind = 'filegroup'
        with self.assertRaises(ValueError):
            _cipher_contract_impl(target, ctx)
        target, ctx = fixture()
        del target[CrateInfo]
        with self.assertRaises(ValueError):
            _cipher_contract_impl(target, ctx)

    def test_later_conflicting_options_refuse(self):
        for suffix in [['-Copt-level=0'], ['-Cdebug-assertions=yes'], ['-Ctarget-feature=-simd128'], ['--codegen=opt-level=0'], ['--codegen', 'debug_assertions=yes'], ['-Cdebug-assertions']]:
            target, ctx = fixture()
            ctx.rule.attr.rustc_flags.extend(suffix)
            with self.assertRaises(ValueError):
                _cipher_contract_impl(target, ctx)
        for suffix in [['-Ctarget-feature=+atomics'], ['-Ctarget-feature=-simd128,+simd128'], ['-Copt-level=0', '-Copt-level=3']]:
            target, ctx = fixture()
            ctx.rule.attr.rustc_flags.extend(suffix)
            self.assertEqual(_cipher_contract_impl(target, ctx), [])

    def test_exact_compiler_output_runtime_no_epoch(self):
        target, ctx = fixture()
        out = _harness_impl(S(attr=S(harness=[target])))[0]
        self.assertEqual(out.files, [target[CrateInfo].output])
        self.assertIs(out.runfiles, target[TestRuntimeInfo].runfiles)
        for field, value in [('extension', 'rlib'), ('is_directory', True)]:
            target, ctx = fixture()
            setattr(target[CrateInfo].output, field, value)
            with self.assertRaises(ValueError):
                _harness_impl(S(attr=S(harness=[target])))
if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])
