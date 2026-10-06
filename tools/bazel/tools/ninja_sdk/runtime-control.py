"""Exercise an actual built Ninja and original declared Bash/Python Files."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def control(ninja, shell, python):
    for tool in [ninja, shell, python]:
        if not tool.is_absolute() or not tool.is_file() or not os.access(tool, os.X_OK):
            raise ValueError("Ninja runtime controls require actual declared native executable Files")
    with tempfile.TemporaryDirectory(prefix="merkur-ninja-control-") as temporary:
        root = Path(temporary)
        (root / "build.ninja").write_text("rule produce\n  command = printf '%s\\n' verified > $out\nbuild result: produce\n")
        environment = {"HOME": str(root), "TMPDIR": str(root), "PATH": "/__no_ambient_ninja_tools__", "LC_ALL": "C", "MERKUR_NINJA_SHELL": str(shell), "MERKUR_NINJA_PYTHON": str(python)}
        environment["DYLD_FALLBACK_LIBRARY_PATH" if os.uname().sysname == "Darwin" else "LD_LIBRARY_PATH"] = str(shell.parent.parent / "lib")
        results = []
        for name, value in [("missing", None), ("relative", "bash"), ("nonexistent", str(root / "foreign-shell"))]:
            changed = dict(environment)
            if value is None:
                del changed["MERKUR_NINJA_SHELL"]
            else:
                changed["MERKUR_NINJA_SHELL"] = value
            result = subprocess.run([str(ninja), "-f", "build.ninja"], cwd=root, env=changed, capture_output=True, text=True)
            if result.returncode == 0 or "MERKUR_NINJA_SHELL" not in result.stderr or (root / "result").exists():
                raise RuntimeError("Ninja accepted an absent or invalid declared shell")
            results.append({"control": name, "exit": result.returncode, "stderr": result.stderr})
        result = subprocess.run([str(ninja), "-f", "build.ninja"], cwd=root, env=environment, capture_output=True, text=True)
        if result.returncode != 0 or (root / "result").read_bytes() != b"verified\n":
            raise RuntimeError("Original Ninja rule failed through its declared shell")
        results.append({"control": "actual-rule", "exit": result.returncode, "stdout": result.stdout})
        changed = dict(environment)
        del changed["MERKUR_NINJA_PYTHON"]
        result = subprocess.run([str(ninja), "-f", "build.ninja", "-t", "browse", "--help"], cwd=root, env=changed, capture_output=True, text=True)
        if result.returncode == 0 or "MERKUR_NINJA_PYTHON" not in result.stderr:
            raise RuntimeError("Ninja browse selected an ambient Python")
        results.append({"control": "missing-browse-python", "exit": result.returncode, "stderr": result.stderr})
        result = subprocess.run([str(ninja), "-f", "build.ninja", "-t", "browse", "--help"], cwd=root, env=environment, capture_output=True, text=True)
        if result.returncode != 0 or "usage: ninja -t browse" not in result.stdout:
            raise RuntimeError("Ninja original browse feature failed with the declared Python")
        results.append({"control": "actual-browse-python", "exit": result.returncode, "stdout": result.stdout})
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ninja", type=Path, required=True)
    parser.add_argument("--shell", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    arguments = parser.parse_args()
    control(arguments.ninja, arguments.shell, arguments.python)
