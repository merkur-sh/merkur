"""Owned case-sensitive storage for CI Bazel repository materialization."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

HDIUTIL = "/usr/bin/hdiutil"
PREFIX = "merkur-bazel-storage-"


def case_sensitive(directory):
    """Prove the exact upstream names can coexist without replacing either File."""
    probe = Path(tempfile.mkdtemp(prefix="case-control-", dir=directory))
    try:
        upper = probe / "README.md"
        mixed = probe / "Readme.md"
        with upper.open("xb") as stream:
            stream.write(b"upper-case upstream name\n")
        with mixed.open("xb") as stream:
            stream.write(b"mixed-case upstream name\n")
        if upper.read_bytes() != b"upper-case upstream name\n" or mixed.read_bytes() != b"mixed-case upstream name\n":
            raise RuntimeError("Case-distinct upstream Files do not retain distinct bytes")
        if (upper.stat().st_dev, upper.stat().st_ino) == (mixed.stat().st_dev, mixed.stat().st_ino):
            raise RuntimeError("Case-distinct upstream names refer to one File")
    finally:
        shutil.rmtree(probe)


def hdiutil(*args):
    result = subprocess.run([HDIUTIL, *map(str, args)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError("hdiutil failed: " + result.stderr.decode(errors="replace"))
    return result.stdout


def save_state(directory, runner, platform):
    stat = directory.stat()
    state = {"directory": str(directory), "runnerTemp": str(runner), "platform": platform,
             "device": stat.st_dev, "inode": stat.st_ino}
    target = directory / "state.json"
    with target.open("x") as stream:
        json.dump(state, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    return target


def setup(runner_temp, *, platform=None, size_bytes=None):
    platform = sys.platform if platform is None else platform
    if platform not in ("darwin", "linux"):
        raise RuntimeError("Bazel storage supports Darwin and Linux runners")
    runner = Path(runner_temp)
    if not runner.is_absolute() or not runner.is_dir():
        raise RuntimeError("An existing absolute runner temporary directory is required")
    runner = runner.resolve(strict=True)
    directory = Path(tempfile.mkdtemp(prefix=PREFIX, dir=runner))
    directory.chmod(0o700)
    state = save_state(directory, runner, platform)
    try:
        if platform == "darwin":
            mount = directory / "mount"
            mount.mkdir()
            capacity = os.statvfs(directory)
            available = capacity.f_bavail * capacity.f_frsize if size_bytes is None else size_bytes
            hdiutil("create", "-sectors", available // 512, "-type", "SPARSE", "-fs",
                    "Case-sensitive APFS", "-volname", "MerkurBazel", directory / "output.sparseimage")
            attached = plistlib.loads(hdiutil("attach", "-plist", "-nobrowse", "-mountpoint", mount,
                                              directory / "output.sparseimage"))
            if not any(entity.get("mount-point") == str(mount) for entity in attached.get("system-entities", [])):
                raise RuntimeError("Owned APFS image was not mounted at the requested directory")
            base = mount
        else:
            base = directory
        case_sensitive(base)
        output = base / "bazel"
        output.mkdir(mode=0o700)
        temporary = base / "tmp"
        temporary.mkdir(mode=0o700)
        return {"state": str(state), "outputUserRoot": str(output), "tmpdir": str(temporary)}
    except BaseException:
        cleanup(state)
        raise


def cleanup(state_path):
    state_path = Path(state_path)
    if not state_path.is_absolute() or state_path.name != "state.json" or state_path.is_symlink():
        raise RuntimeError("Exact owned storage state File required")
    directory = state_path.parent
    if not directory.name.startswith(PREFIX) or directory.is_symlink():
        raise RuntimeError("Storage directory is not owned")
    state = json.loads(state_path.read_text())
    runner = Path(state["runnerTemp"])
    stat = directory.stat()
    if (state["directory"] != str(directory) or directory.parent != runner or runner.resolve(strict=True) != runner
            or directory.resolve(strict=True) != directory
            or (state["device"], state["inode"]) != (stat.st_dev, stat.st_ino)
            or state["platform"] not in ("darwin", "linux")):
        raise RuntimeError("Storage state does not identify the owned directory")
    if state["platform"] == "darwin":
        image = directory / "output.sparseimage"
        mount = directory / "mount"
        attached = plistlib.loads(hdiutil("info", "-plist"))
        matches = [entry for entry in attached.get("images", []) if entry.get("image-path") == str(image)]
        if len(matches) > 1:
            raise RuntimeError("Owned image has more than one attachment")
        if matches:
            entities = matches[0].get("system-entities", [])
            if not any(entity.get("mount-point") == str(mount) for entity in entities):
                raise RuntimeError("Owned image attachment differs from the requested mount")
            hdiutil("detach", mount)
        if os.path.ismount(mount):
            raise RuntimeError("Owned mount remains active; storage retained")
    shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("setup")
    create.add_argument("--runner-temp", required=True)
    create.add_argument("--github-env", required=True)
    create.add_argument("--github-output", required=True)
    remove = commands.add_parser("cleanup")
    remove.add_argument("--state", required=True)
    check = commands.add_parser("check")
    check.add_argument("--directory", required=True)
    args = parser.parse_args()
    if args.command == "setup":
        result = setup(args.runner_temp)
        try:
            values = {"BAZEL_OUTPUT_USER_ROOT": result["outputUserRoot"], "TMPDIR": result["tmpdir"],
                      "MERKUR_BAZEL_STORAGE_STATE": result["state"]}
            if any("\n" in value or "\r" in value for value in values.values()):
                raise RuntimeError("CI storage paths must fit one environment record")
            with Path(args.github_env).open("a") as stream:
                for name, value in values.items():
                    stream.write(f"{name}={value}\n")
            with Path(args.github_output).open("a") as stream:
                stream.write(f"output-user-root={result['outputUserRoot']}\n")
                stream.write(f"storage-state={result['state']}\n")
        except BaseException:
            cleanup(result["state"])
            raise
        print(json.dumps(result, sort_keys=True))
    elif args.command == "cleanup":
        cleanup(args.state)
    else:
        case_sensitive(args.directory)


if __name__ == "__main__":
    main()
