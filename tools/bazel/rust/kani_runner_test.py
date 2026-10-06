#!/usr/bin/env python3
"""Kani TestRunner lifecycle controls with explicitly synthetic driver/checker tools.

These execute the actual runner and filesystem/subprocess boundary on declared
Python. They do not qualify Kani compilation, proof results, or CBMC itself.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).absolute().parent))
import kani_runner


class KaniRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        tools = self.root / "toolchain/bin"
        tools.mkdir(parents=True)
        self.driver = tools / "driver"
        self.checker = tools / "checker"
        self.source = self.root / "original.rs"
        self.source.write_text("positive")
        self.production = self.root / "generated"
        self.production.mkdir()
        (self.production / "lanes.rs").write_text("original production lanes")
        (self.production / "writer_custody.rs").write_text("original production custody")
        self.marker = self.root / "driver-invocations"
        self.compiler = tools / "native-compiler"
        self.compiler.write_text("#!" + sys.executable + "\n" + '''
import os,sys
from pathlib import Path
assert sys.argv[1:]==['--no-default-config','-isysroot',os.environ['SDKROOT'],'-E','input.c']
assert Path(os.environ['SDKROOT']).is_dir()
assert 'MERKUR_UNDECLARED_TEST_ENV' not in os.environ
print('declared preprocessor invoked')
''')
        self.compiler.chmod(0o755)
        (self.root / "sdk").mkdir()
        (self.root / "sdk/header.h").write_text("original sdk input")
        self.native = {
            "compiler": "external/native/bin/cc",
            "flags": ["--no-default-config", "-isysroot", "external/native/sdk"],
            "environment": {"SDKROOT": "external/native/sdk", "PATH": "external/native/bin"},
            "files": {"external/native/bin/cc": "toolchain/bin/native-compiler", "external/native/sdk/header.h": "sdk/header.h"},
        }
        self.driver.write_text("#!" + sys.executable + "\n" + f'''
import json,os,sys,subprocess
from pathlib import Path
args=sys.argv[1:]
source=Path(args[0]);mode=source.read_text()
marker=Path({str(self.marker)!r})
with marker.open('a') as out: out.write(mode+'\\n')
assert 'MERKUR_UNDECLARED_TEST_ENV' not in os.environ
assert Path(os.environ['OUT_DIR']).is_dir()
assert Path.cwd()==source.parent
assert os.environ['PATH'].split(os.pathsep)[1:]==[{str(tools)!r},{str(tools.parent/'toolchain/bin')!r}]
assert Path(os.environ['PATH'].split(os.pathsep)[0]).name=='native-bin'
preprocessor=subprocess.run(['gcc','-E','input.c'],capture_output=True,text=True)
assert preprocessor.returncode==0,preprocessor.stderr
assert preprocessor.stdout=='declared preprocessor invoked\\n'
assert Path(os.environ['HOME']).parent.name=='kani'
source.write_text('mutation of owned harness copy')
results=Path(args[args.index('--export-json')+1])
if mode=='setup-error': sys.exit(2)
negative='--harness' in args
if negative:
 assert args[args.index('--harness')+1]=='proofs::custody_survives_provider_switch'
 assert '--exact' in args
results.write_text(json.dumps({{'mode':mode,'negative':negative}}))
print('synthetic driver log')
if mode=='positive-engine-error': sys.exit(2)
if mode.startswith('exit-'): sys.exit(int(mode.split('-')[1]))
if mode=='signal-termination':
 import signal
 os.kill(os.getpid(), signal.SIGTERM)
sys.exit(1 if negative else 0)
''')
        self.checker.write_text("#!" + sys.executable + "\n" + '''
import json,sys
from pathlib import Path
report=json.loads(Path(sys.argv[1]).read_text())
assert report['negative']==(len(sys.argv)==3 and sys.argv[2]=='negative')
sys.exit(1 if report['mode']=='classifier-refusal' else 0)
''')
        self.driver.chmod(0o755)
        self.checker.chmod(0o755)

    def outputs(self, name):
        result = self.root / name
        result.mkdir()
        return result

    def run_pipeline(self, output, negative=False):
        kani_runner.execute(self.driver, self.checker, self.source, self.production, output, self.native, self.root, negative)

    def test_each_fresh_test_destination_reexecutes_pipeline_for_identical_inputs(self):
        with patch.dict(os.environ, {"MERKUR_UNDECLARED_TEST_ENV": "must not inherit"}):
            for name in ["run-a", "run-b"]:
                self.run_pipeline(self.outputs(name))
        self.assertEqual(self.marker.read_text().splitlines(), ["positive", "positive"])
        self.assertEqual(self.source.read_text(), "positive")
        self.assertEqual((self.production / "lanes.rs").read_text(), "original production lanes")

    def test_restored_output_is_refused_instead_of_consuming_cached_solver_results(self):
        output = self.outputs("restored")
        (output / "kani/proof").mkdir(parents=True)
        (output / "kani/proof/results.json").write_text('{"cached":"pass"}')
        with self.assertRaises(FileExistsError):
            self.run_pipeline(output)
        self.assertFalse(self.marker.exists())
        self.assertEqual((output / "kani/proof/results.json").read_text(), '{"cached":"pass"}')

    def test_positive_engine_failure_cannot_promote_a_success_shaped_report(self):
        self.source.write_text("positive-engine-error")
        output = self.outputs("failed")
        with self.assertRaisesRegex(ValueError, "compilation or verification failed"):
            self.run_pipeline(output)
        self.assertEqual((output / "kani/exit-status").read_text(), "2\n")
        self.assertTrue((output / "kani/proof/results.json").is_file())
        self.assertTrue((output / "kani/driver.stdout").is_file())
        self.assertFalse((output / "kani/classifier.stdout").exists())

    def test_negative_setup_error_and_classifier_refusal_are_failures(self):
        for name, expected in [("setup-error", "compilation or verification failed"), ("classifier-refusal", "intended negative failure")]:
            with self.subTest(mode=name):
                self.source.write_text(name)
                output = self.outputs(name)
                with self.assertRaisesRegex(ValueError, expected):
                    self.run_pipeline(output, negative=True)
                self.assertTrue((output / "kani/driver.stderr").is_file())

    def test_negative_report_cannot_mask_wrong_driver_exit_status(self):
        for mode in ["positive-engine-error", "exit-0", "exit-2", "exit-101", "signal-termination"]:
            with self.subTest(mode=mode):
                self.source.write_text(mode)
                output = self.outputs(mode)
                with self.assertRaisesRegex(ValueError, "compilation or verification failed"):
                    self.run_pipeline(output, negative=True)
                self.assertTrue((output / "kani/proof/results.json").is_file())
                self.assertFalse((output / "kani/classifier.stdout").exists())

    def test_negative_pipeline_passes_exact_scope_to_classifier(self):
        self.run_pipeline(self.outputs("negative"), negative=True)
        report = json.loads((self.root / "negative/kani/proof/results.json").read_text())
        self.assertTrue(report["negative"])
        self.assertEqual((self.root / "negative/kani/exit-status").read_text(), "1\n")

    def test_generated_source_symlink_is_not_followed_into_undeclared_checkout(self):
        (self.production / "escape.rs").symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, "source tree contains a symlink"):
            self.run_pipeline(self.outputs("symlink"))
        self.assertFalse(self.marker.exists())

    def test_native_preprocessor_requires_declared_original_compiler_and_sdk(self):
        for mode in ["undeclared-compiler", "missing-sdk", "ambient-path"]:
            with self.subTest(mode=mode):
                native = json.loads(json.dumps(self.native))
                if mode == "undeclared-compiler":
                    native["compiler"] = "/usr/bin/gcc"
                elif mode == "missing-sdk":
                    native["files"]["external/native/sdk/header.h"] = "missing/header.h"
                else:
                    native["environment"]["PATH"] = "/usr/bin"
                with self.assertRaisesRegex(ValueError, "declared|closure|runfiles"):
                    kani_runner.execute(self.driver, self.checker, self.source, self.production,
                                        self.outputs(mode), native, self.root)
        self.assertFalse(self.marker.exists())

    def test_generated_sdk_tree_paths_relocate_before_native_preprocessing(self):
        self.compiler.write_text("#!" + sys.executable + "\nimport json,os,sys\nprint(json.dumps({'args':sys.argv[1:],'sdk':os.environ['SDKROOT']}))\n")
        (self.root / "sdk/include").mkdir()
        native = {
            "compiler": "bazel-out/native/bin/cc",
            "flags": ["--sysroot=bazel-out/native/sdk", "-Ibazel-out/native/sdk/include"],
            "environment": {"SDKROOT": "bazel-out/native/sdk"},
            "files": {"bazel-out/native/bin/cc": "toolchain/bin/native-compiler", "bazel-out/native/sdk": "sdk"},
        }
        directory = kani_runner.native_preprocessor(native, self.root, self.root / "tree-native", {"PATH": ""})
        import subprocess
        completed = subprocess.run([str(directory / "clang"), "-E", "input.c"],
                                   env={"PATH": ""}, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), {
            "args": ["--sysroot=" + str(self.root / "sdk"), "-I" + str(self.root / "sdk/include"), "-E", "input.c"],
            "sdk": str(self.root / "sdk"),
        })

    def test_declared_artifact_paths_resolve_tree_before_copying_sandbox_symlinks(self):
        runfiles = self.root / "runfiles"
        projection = runfiles / "_main/proof_sources"
        projection.mkdir(parents=True)
        for source in self.production.iterdir():
            (projection / source.name).symlink_to(source)
        original = kani_runner.original_tree(self.checker, "toolchain/bin/checker", "generated")
        self.assertEqual(original, self.production)
        kani_runner.execute(self.driver, self.checker, self.source, original,
                            self.outputs("sandbox-projection"), self.native, self.root)
        self.assertEqual((self.production / "lanes.rs").read_text(), "original production lanes")
        with self.assertRaisesRegex(ValueError, "does not match"):
            kani_runner.original_tree(self.checker, "other/bin/checker", "generated")
        with self.assertRaisesRegex(ValueError, "exact declared"):
            kani_runner.original_tree(self.checker, "toolchain/bin/checker", "../undeclared")
        with self.assertRaises(FileNotFoundError):
            kani_runner.original_tree(self.checker, "toolchain/bin/checker", "missing")


if __name__ == "__main__":
    unittest.main()
