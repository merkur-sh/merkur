#!/usr/bin/env python3
"""Verify the actual harness guard against Cargo's encoded-flags precedence."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


GUARD = Path(__file__).resolve().with_name("seeds.rs")
ROOT = GUARD.parents[2]
MESSAGE = "cargo-bolero libFuzzer instrumentation was not enabled"


class InstrumentationGuard(unittest.TestCase):
    def test_real_guard_detects_silent_encoded_flag_override(self):
        original_lock = (ROOT / "Cargo.lock").read_bytes()
        with tempfile.TemporaryDirectory(prefix="merkur-fuzz-instrumentation-") as temporary:
            workspace = Path(temporary)
            (workspace / "src").mkdir()
            (workspace / "Cargo.toml").write_text(
                '[workspace]\n[package]\nname="instrumentation-control"\n'
                'version="0.0.0"\nedition="2024"\n'
                '[lints.rust]\nunexpected_cfgs="allow"\ndead_code="allow"\n'
            )
            (workspace / "src" / "main.rs").write_text(
                f'include!(r"{GUARD}");\nfn main() {{}}\n'
            )
            environment = os.environ.copy()
            environment.pop("RUSTUP_TOOLCHAIN", None)
            environment.pop("CARGO_ENCODED_RUSTFLAGS", None)
            environment["RUSTFLAGS"] = "--cfg merkur_libfuzzer --cfg fuzzing_libfuzzer"
            arguments = [
                "cargo", "check", "--offline", "--manifest-path",
                str(workspace / "Cargo.toml"), "--target-dir", str(workspace / "target"),
            ]
            positive = subprocess.run(
                arguments, cwd=workspace, env=environment, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
            self.assertEqual(positive.returncode, 0, positive.stdout)
            # This was the real failure mode: Cargo ignores RUSTFLAGS entirely
            # when CARGO_ENCODED_RUSTFLAGS exists, losing cargo-bolero's engine cfg.
            environment["CARGO_ENCODED_RUSTFLAGS"] = "--cfg\x1fmerkur_libfuzzer"
            negative = subprocess.run(
                arguments, cwd=workspace, env=environment, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
            self.assertNotEqual(negative.returncode, 0, negative.stdout)
            self.assertIn(MESSAGE, negative.stdout)
        self.assertEqual((ROOT / "Cargo.lock").read_bytes(), original_lock)


if __name__ == "__main__":
    unittest.main(verbosity=2)
