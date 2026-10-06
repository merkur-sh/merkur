"""Bounded proof lifecycle controls; these fixtures do not qualify Kani."""

import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import types
import unittest


def report():
    return {
        "metadata": {"kani_version": "0.68.0"}, "tools": {"cbmc": "6.11.0 (cbmc-6.11.0)"},
        "verification_results": {
            "summary": {"total_harnesses": 1, "executed": 1, "successful": 1, "failed": 0, "status": "completed"},
            "results": [{"harness_id": "proof_input_mapping", "status": "Success", "checks": [
                {"status": "Success", "category": "assertion"}, {"status": "Satisfied", "category": "cover"},
            ]}],
        },
    }


class BoundedKaniControls(unittest.TestCase):
    def setUp(self):
        specification = importlib.util.spec_from_file_location("bounded_kani", pathlib.Path(__file__).with_name("bounded_kani_runner.py"))
        self.module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(self.module)

    def test_complete_nonvacuous_original_harness(self):
        self.module.classify(report(), "proof_input_mapping")

    def test_absent_or_unsatisfied_cover_refuses(self):
        for status in [None, "Unsatisfiable", "Unreachable", "Unknown", "Success"]:
            value = report()
            if status is None:
                value["verification_results"]["results"][0]["checks"].pop()
            else:
                value["verification_results"]["results"][0]["checks"][1]["status"] = status
            with self.assertRaisesRegex(ValueError, "vacuous"):
                self.module.classify(value, "proof_input_mapping")

    def test_failed_unknown_or_absent_safety_check_refuses(self):
        for status in [None, "Failure", "Unknown", "Error", "Undetermined", "Satisfied"]:
            value = report()
            checks = value["verification_results"]["results"][0]["checks"]
            if status is None:
                checks.pop(0)
            else:
                checks[0]["status"] = status
            with self.assertRaisesRegex(ValueError, "safety"):
                self.module.classify(value, "proof_input_mapping")

    def test_another_or_duplicate_harness_refuses(self):
        for duplicate in [False, True]:
            value = report()
            if duplicate:
                value["verification_results"]["results"] *= 2
            else:
                value["verification_results"]["results"][0]["harness_id"] = "proof_input_serial_order"
            with self.assertRaisesRegex(ValueError, "harness"):
                self.module.classify(value, "proof_input_mapping")

    def test_timeout_incomplete_and_wrong_tool_refuse(self):
        for mutation in ["summary", "kani", "cbmc"]:
            value = report()
            if mutation == "summary":
                value["verification_results"]["summary"]["status"] = "timed_out"
            elif mutation == "kani":
                value["metadata"]["kani_version"] = "other"
            else:
                value["tools"]["cbmc"] = "other"
            with self.assertRaises(ValueError):
                self.module.classify(value, "proof_input_mapping")

    def run_pipeline(self, mode):
        with tempfile.TemporaryDirectory(prefix="bounded-kani-control-") as temporary:
            root = pathlib.Path(temporary)
            work, driver, lock, production = [root / name for name in ["source", "driver", "retained.lock", "production.lock"]]
            driver = root / "sdk/bin/kani-driver"
            driver.parent.mkdir(parents=True)
            cargo = root / "sdk/toolchain/bin/cargo"
            cargo.parent.mkdir(parents=True)
            cargo.symlink_to(sys.executable)
            work.mkdir()
            (work / "Cargo.lock").write_bytes(b"original retained dependency lock")
            lock.write_bytes((work / "Cargo.lock").read_bytes())
            production.write_bytes(b"unchanged production dependency lock")
            driver.write_text("#!" + sys.executable + "\n" +
                "import sys,os,json,pathlib\nargs=sys.argv[1:]\n" +
                "assert args[0]=='kani' and args[args.index('--harness-timeout')+1]=='15m'\n" +
                "assert '--tests' in args and '--exact' in args\n" +
                "assert [args[i+1] for i,arg in enumerate(args) if arg=='-Z']==['unstable-options','stubbing']\n" +
                "assert os.environ['CARGO_NET_OFFLINE']=='true' and os.environ['RUSTFLAGS']=='--cfg merkur_fuzz'\n" +
                ("pathlib.Path('Cargo.lock').write_text('changed')\n" if mode == "lock" else "") +
                ("pathlib.Path(args[args.index('--export-json')+1]).write_text(json.dumps(" + repr(report()) + "))\n" if mode != "missing" else "") +
                ("raise SystemExit(2)\n" if mode == "failure" else ""))
            driver.chmod(0o700)
            helpers = types.SimpleNamespace(copy_sources=shutil.copytree, native_preprocessor=lambda native, runfiles, output, environment: output)
            self.module.execute(driver, cargo, work, lock, production, root / "outputs",
                                {"rustflags": ["--cfg", "merkur_fuzz"]}, root, "merkur-client-fuzz", "proof_input_mapping", helpers)
            self.assertEqual(lock.read_bytes(), b"original retained dependency lock")
            self.assertEqual(production.read_bytes(), b"unchanged production dependency lock")

    def test_original_budget_offline_exact_selection_and_retained_locks(self):
        self.run_pipeline("success")

    def test_driver_success_without_fresh_results_refuses(self):
        with self.assertRaisesRegex(ValueError, "fresh"):
            self.run_pipeline("missing")

    def test_driver_failure_cannot_admit_failure_shaped_success_report(self):
        with self.assertRaisesRegex(ValueError, "solver failed: 2"):
            self.run_pipeline("failure")

    def test_copied_lock_mutation_refuses(self):
        with self.assertRaisesRegex(ValueError, "dependency lock"):
            self.run_pipeline("lock")


if __name__ == "__main__":
    unittest.main()
