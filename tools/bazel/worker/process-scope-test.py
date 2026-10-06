"""Real Linux namespace controls. Missing kernel authority is a failure, never a skip."""
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import unittest

SCOPE = Path(__file__).with_name("process_scope")


def fixture(mode):
    ready = int(os.environ["FIXTURE_READY"])
    held = int(os.environ["FIXTURE_HELD"])
    shutdown = int(os.environ["FIXTURE_SHUTDOWN"])
    if mode == "owner":
        owner = os.pidfd_open(os.getpid())
        process = subprocess.Popen(
            [str(SCOPE), "--owner-fd", str(owner), "--", sys.executable, "-I", __file__, "fixture", "cancel"],
            pass_fds=(ready, held, shutdown, owner),
        )
        os.close(owner)
        process.wait()
        return
    local_read, local_write = os.pipe()
    for _ in range(3):
        child = os.fork()
        if child == 0:
            if os.fork() != 0:
                os._exit(0)
            os.setsid()
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            for descriptor in (0, 1, 2, local_read):
                os.close(descriptor)
            os.write(local_write, b"g")
            os.write(ready, b"g")
            # Retain this explicit pipe while alive; exit/cleanup is observable as EOF.
            os.read(shutdown, 1)
            os._exit(0)
    os.close(local_write)
    for _ in range(3):
        if os.read(local_read, 1) != b"g":
            raise RuntimeError("grandchild startup acknowledgement was lost")
    os.close(local_read)
    os.close(ready)
    os.close(held)
    if mode == "cancel":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.close(1)
        os.close(2)
        os.read(shutdown, 1)


class ProcessScopeControls(unittest.TestCase):
    def campaign(self, mode):
        ready_read, ready_write = os.pipe()
        held_read, held_write = os.pipe()
        shutdown_read, shutdown_write = os.pipe()
        environment = {
            "PATH": "/__no_ambient_path__",
            "FIXTURE_READY": str(ready_write),
            "FIXTURE_HELD": str(held_write),
            "FIXTURE_SHUTDOWN": str(shutdown_read),
        }
        owner = os.pidfd_open(os.getpid())
        command = [str(SCOPE), "--owner-fd", str(owner), "--", sys.executable, "-I", __file__, "fixture", mode]
        if mode == "owner":
            command = [sys.executable, "-I", __file__, "fixture", mode]
        process = subprocess.Popen(
            command,
            env=environment,
            pass_fds=(ready_write, held_write, shutdown_read, owner),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        os.close(ready_write)
        os.close(held_write)
        os.close(shutdown_read)
        os.close(owner)
        try:
            for _ in range(3):
                readable, _, _ = select.select([ready_read], [], [], 20)
                self.assertTrue(readable, "native namespace campaign did not start")
                self.assertEqual(os.read(ready_read, 1), b"g", "namespace admission refused")
            if mode == "cancel":
                process.send_signal(signal.SIGTERM)
            elif mode == "owner":
                process.kill()
            stdout, stderr = process.communicate(timeout=20)
            expected = {"normal": 0, "cancel": 130, "owner": -signal.SIGKILL}[mode]
            self.assertEqual(process.returncode, expected, stderr.decode())
            readable, _, _ = select.select([held_read], [], [], 20)
            self.assertTrue(readable, "descendant retained a pipe after scope completion")
            self.assertEqual(os.read(held_read, 1), b"")
            self.assertEqual(stdout, b"")
        finally:
            # Explicit test-owned lifeline releases fixtures on any failed assertion;
            # it is never used as the tested process-ownership completion signal.
            os.close(shutdown_write)
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=20)
            os.close(ready_read)
            os.close(held_read)

    def test_normal_wrapper_exit_reaps_escaped_grandchildren(self):
        self.campaign("normal")

    def test_cancel_closed_stdio_ignoring_signal_grandchildren(self):
        self.campaign("cancel")

    def test_worker_death_reaps_namespace_without_pid_scanning(self):
        self.campaign("owner")

    def test_missing_wrapper_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = os.pidfd_open(os.getpid())
            result = subprocess.run(
                [str(SCOPE), "--owner-fd", str(owner), "--", str(Path(directory) / "absent")],
                env={"PATH": "/__no_ambient_path__"},
                pass_fds=(owner,),
                capture_output=True,
                timeout=20,
            )
            os.close(owner)
            self.assertNotEqual(result.returncode, 0)

    def test_non_pidfd_owner_refuses_before_wrapper(self):
        read, write = os.pipe()
        try:
            result = subprocess.run(
                [str(SCOPE), "--owner-fd", str(read), "--", "/absent-wrapper"],
                env={"PATH": "/__no_ambient_path__"},
                pass_fds=(read,),
                capture_output=True,
                timeout=20,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b"process namespace admission failed", result.stderr)
        finally:
            os.close(read)
            os.close(write)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "fixture":
        fixture(sys.argv[2])
    else:
        unittest.main()
