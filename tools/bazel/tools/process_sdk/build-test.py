"""Original process utility native/member and watcher lifecycle controls."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("process_sdk_build", Path(__file__).with_name("build.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class ProcessSdkControls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "bin").mkdir()
        for name in ["ps", "pgrep"]:
            file = self.root / "bin" / name
            file.write_bytes(b"\xcf\xfa\xed\xfe" + b"declared fixture native image")
            file.chmod(0o755)

    def child(self):
        return SimpleNamespace(pid=42042, stdin=SimpleNamespace(close=lambda: None), wait=lambda: 0)

    def test_script_and_foreign_format_refuse_before_invocation(self):
        for original in [b"#!/bin/sh\n", b"\x7fELF"]:
            (self.root / "bin/ps").write_bytes(original)
            with patch.object(producer.subprocess, "Popen") as launched:
                with self.assertRaisesRegex(ValueError, "script or foreign"):
                    producer.runtime_control(self.root, "darwin")
                launched.assert_not_called()

    def test_output_alias_and_nonexecutable_refuse_before_invocation(self):
        file = self.root / "bin/ps"
        file.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "regular File"):
            producer.native_binary(file, "darwin")
        file.chmod(0o755)
        alias = self.root / "ps-alias"
        alias.symlink_to(file)
        with self.assertRaisesRegex(ValueError, "regular File"):
            producer.native_binary(alias, "darwin")

    def test_exact_stock_watcher_flags_select_owned_group_then_refuse_exited_group(self):
        child = self.child()
        replies = [SimpleNamespace(returncode=0, stdout="PID TTY TIME CMD\n42042 ?? 0:00 fixture\n"),
                   SimpleNamespace(returncode=0, stdout="42042\n"),
                   SimpleNamespace(returncode=1, stdout="")]
        with patch.object(producer.subprocess, "Popen", return_value=child) as launched, patch.object(producer.subprocess, "run", side_effect=replies) as runs:
            producer.runtime_control(self.root, "darwin")
        self.assertTrue(launched.call_args.kwargs["start_new_session"])
        self.assertEqual([list(call.args[0][1:]) for call in runs.call_args_list],
                         [["-p", "42042"], ["-a", "-g", "42042"], ["-a", "-g", "42042"]])
        self.assertEqual(runs.call_args_list[0].kwargs["env"],
                         {"PATH": str(self.root / "bin"), "HOME": str(self.root), "LC_ALL": "C"})

    def test_unrelated_pid_and_partial_or_foreign_group_refuse(self):
        for ps, pgrep in [("PID\n42\n", "42042\n"), ("PID\n42042\n", ""),
                          ("PID\n42042\n", "42042\n42\n")]:
            replies = [SimpleNamespace(returncode=0, stdout=ps), SimpleNamespace(returncode=0, stdout=pgrep)]
            with patch.object(producer.subprocess, "Popen", return_value=self.child()), patch.object(producer.subprocess, "run", side_effect=replies):
                with self.assertRaisesRegex(ValueError, "owned"):
                    producer.runtime_control(self.root, "darwin")

    def test_dead_group_success_or_stale_output_refuses(self):
        for code, stdout in [(0, ""), (1, "42042\n"), (3, "")]:
            replies = [SimpleNamespace(returncode=0, stdout="42042\n"), SimpleNamespace(returncode=0, stdout="42042\n"), SimpleNamespace(returncode=code, stdout=stdout)]
            with patch.object(producer.subprocess, "Popen", return_value=self.child()), patch.object(producer.subprocess, "run", side_effect=replies):
                with self.assertRaisesRegex(ValueError, "after its owner exited"):
                    producer.runtime_control(self.root, "darwin")

    def test_cross_platform_builder_refuses_before_tool_execution(self):
        foreign = "linux" if producer.sys.platform == "darwin" else "darwin"
        with patch.object(producer, "load_common", return_value=object()):
            with self.assertRaisesRegex(ValueError, "actual native platform"):
                producer.build({"common": "declared-common.py", "platform": foreign}, self.root)


if __name__ == "__main__":
    unittest.main()
