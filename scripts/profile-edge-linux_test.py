import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("profile_edge", Path(__file__).with_name("profile-edge-linux.py"))
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


class CompletedWorkOracle(unittest.TestCase):
    def record(self):
        return dict(workload="typing", sessions=1, offered=10000, delivered=10000,
                    delivered_bytes=570000, p50_ns=100, p95_ns=200, p99_ns=300, wall_ns=1000000)

    def test_exact_completed_work(self):
        profile.validate_work(self.record(), "typing")

    def test_missing_work_cannot_improve_a_tail(self):
        for field in ["offered", "delivered", "delivered_bytes", "sessions"]:
            record = self.record()
            record[field] -= 1
            with self.assertRaises(RuntimeError):
                profile.validate_work(record, "typing")

    def test_inconsistent_quantiles_are_rejected(self):
        record = self.record()
        record["p99_ns"] = 150
        with self.assertRaises(RuntimeError):
            profile.validate_work(record, "typing")

    def test_capture_input_survives_a_concurrent_cargo_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "edge"
            original.write_bytes(b"measured executable")
            retained = profile.retain_binary(original, root, profile.digest(original))
            original.write_bytes(b"later build")
            self.assertEqual(retained.read_bytes(), b"measured executable")
            self.assertEqual(retained.stat().st_mode & 0o777, 0o555)


if __name__ == "__main__":
    unittest.main()
