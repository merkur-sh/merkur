"""Run unchanged lab assertions with engine-owned, offline Linux fixtures."""

import hashlib
import json
from pathlib import Path
import re
import signal
import subprocess
import sys
import tarfile
import tempfile
import uuid


def declared_file(root, relative):
    path = root / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("natlab input must be a declared runfile")
    # Bazel's runfile carrier itself is a symlink. Resolve that File, not an
    # ambient directory or a caller-provided installation prefix.
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError("natlab input must resolve to one regular File")
    if any(char in str(resolved) for char in (",", "\n", "\r")):
        raise ValueError("natlab input cannot be represented as a Docker mount")
    return resolved


def verify_image(archive_path, identity_path):
    identity = identity_path.read_text().strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", identity):
        raise ValueError("invalid declared Docker image configuration digest")
    with tarfile.open(archive_path, "r") as archive:
        names = archive.getnames()
        if len(names) != len(set(names)):
            raise ValueError("ambiguous Docker image archive")
        manifest_file = archive.extractfile("manifest.json")
        if manifest_file is None:
            raise ValueError("Docker image has no manifest")
        manifest = json.load(manifest_file)
        if len(manifest) != 1 or manifest[0]["RepoTags"]:
            raise ValueError("natlab image must have one anonymous configuration")
        config_name = identity[7:] + ".json"
        if manifest[0]["Config"] != config_name:
            raise ValueError("natlab image digest does not name its configuration")
        config_file = archive.extractfile(config_name)
        if config_file is None:
            raise ValueError("Docker image configuration is absent")
        config_bytes = config_file.read()
        if hashlib.sha256(config_bytes).hexdigest() != identity[7:]:
            raise ValueError("Docker image configuration bytes changed")
        config = json.loads(config_bytes)
        if config["os"] != "linux" or config["architecture"] not in ("amd64", "arm64"):
            raise ValueError("natlab needs a declared native Linux image")
        layers = manifest[0]["Layers"]
        expected = config["rootfs"]["diff_ids"]
        if len(layers) != len(expected) or not layers:
            raise ValueError("Docker image layer inventory mismatch")
        for name, digest in zip(layers, expected):
            layer = archive.extractfile(name)
            if layer is None or "sha256:" + hashlib.file_digest(layer, "sha256").hexdigest() != digest:
                raise ValueError("Docker image layer bytes changed")
    return identity


def checked(command, environment):
    completed = subprocess.run(command, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode:
        sys.stdout.write(completed.stdout)
        sys.stderr.write(completed.stderr)
        raise RuntimeError("declared Docker command failed with exit " + str(completed.returncode))
    return completed.stdout


def assert_markers(output, markers):
    lines = output.splitlines()
    for marker in markers:
        if lines.count(marker) != 1:
            raise RuntimeError("original natlab success marker is absent or ambiguous: " + marker)
    if any(line.startswith(("LAB=FAIL", "DISCOVERY_LAB=FAIL", "PORTMAP_LAB=FAIL")) for line in lines):
        raise RuntimeError("original natlab reported a failed assertion")


def mount(source, destination):
    return ["--mount", "type=bind,src=" + str(source) + ",dst=" + destination + ",readonly"]


def run_fixture(docker, environment, identity, sources, script, markers):
    name = "merkur-natlab-" + uuid.uuid4().hex
    command = [docker, "container", "create", "--name", name, "--pull=never", "--privileged", "--network=none", "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid", "--tmpfs", "/run:rw,exec,nosuid"]
    for source, destination in sources:
        command.extend(mount(source, destination))
    command.extend(["--env", "MERKUR_DISCOVERY_TEST_BIN=/target/debug/dataplane-test", identity, "/bin/bash", "-euo", "pipefail", "-c", script])
    try:
        created = checked(command, environment).strip()
        if not re.fullmatch(r"[0-9a-f]{64}", created):
            raise RuntimeError("Docker did not return an owned container identity")
        # Attach to the real process: the exit status and original assertion
        # output both must pass; lab.sh historically prints LAB=FAIL with exit0.
        output = checked([docker, "container", "start", "--attach", name], environment)
        sys.stdout.write(output)
        state = checked([docker, "container", "inspect", "--format", "{{.State.ExitCode}} {{.State.Running}}", name], environment).strip()
        if state != "0 false":
            raise RuntimeError("original natlab process did not finish successfully: " + state)
        assert_markers(output, markers)
    finally:
        # Names are reserved before creation. Cancellation during create cannot
        # leave an untracked namespace host; never enumerate other containers.
        # A second cancellation cannot abandon the already-owned cleanup. The
        # daemon's successful removal response is required before a pass can be
        # admitted; cleanup17 used to leave the successful lab green.
        previous = {signum: signal.signal(signum, signal.SIG_IGN) for signum in (signal.SIGINT, signal.SIGTERM)}
        try:
            checked([docker, "container", "rm", "--force", name], environment)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)


def main(descriptor_path, runfiles):
    root = Path(runfiles)
    descriptor = json.loads(Path(descriptor_path).read_text())
    docker = declared_file(root, descriptor["docker"])
    endpoint = descriptor["docker_host"]
    if not re.fullmatch(r"unix:///[^\r\n]+", endpoint):
        raise ValueError("natlab requires an explicitly configured local Docker Unix socket")
    image = declared_file(root, descriptor["image"])
    identity = verify_image(image, declared_file(root, descriptor["identity"]))
    scripts = [declared_file(root, name) for name in descriptor["scripts"]]
    if len(scripts) != 3:
        raise ValueError("natlab requires the complete original three-script inventory")
    sources = list(zip(scripts, ["/merkur-lab/lab.sh", "/merkur-lab/discovery.sh", "/merkur-lab/portmap.sh"]))
    sources += [(declared_file(root, descriptor["stun"]), "/target/debug/merkur-stun"), (declared_file(root, descriptor["dataplane"]), "/target/debug/dataplane-test")]
    def cancelled(signum, _frame):
        raise RuntimeError("natlab cancelled by signal " + str(signum))
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    with tempfile.TemporaryDirectory(prefix="merkur-natlab-") as private:
        environment = {"HOME": private, "DOCKER_CONFIG": private, "DOCKER_HOST": endpoint, "PATH": "", "LC_ALL": "C"}
        if checked([str(docker), "info", "--format", "{{.OSType}}"], environment).strip() != "linux":
            raise RuntimeError("natlab requires a privileged Linux Docker backend")
        checked([str(docker), "image", "load", "--input", str(image)], environment)
        actual = checked([str(docker), "image", "inspect", "--format", "{{.Id}}", identity], environment).strip()
        if actual != identity:
            raise RuntimeError("Docker loaded a different image configuration")
        run_fixture(str(docker), environment, identity, sources, "/bin/bash /merkur-lab/lab.sh", ["LAB=PASS"])
        run_fixture(str(docker), environment, identity, sources, "/bin/bash /merkur-lab/discovery.sh; /bin/bash /merkur-lab/portmap.sh", ["DISCOVERY_LAB=PASS", "PORTMAP_LAB=PASS"])


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: runner.py DESCRIPTOR RUNFILES")
    main(*sys.argv[1:])
