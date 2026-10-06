"""Capture fresh original audits; consume their declared immutable report snapshots."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import tomllib


COMMANDS = {"bun": ["--no-env-file", "--config=empty-bunfig.toml", "audit", "--json"],
            "cargo_audit": ["audit", "--deny", "yanked", "--color", "never", "--format", "terminal", "--file", "Cargo.lock"]}
VERSIONS = {"bun": "1.4.2", "cargo_audit": "cargo-audit 0.22.2"}
YANKED_ERRORS = ("couldn't update crates.io index:", "couldn't open crates.io index:",
                 "couldn't check if the package is yanked:")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def member(value):
    if not isinstance(value, str) or not value or "\\" in value or Path(value).is_absolute():
        raise ValueError("Audit input requires its declared portable member")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("Audit input escaped its declared member")
    return value


def runtime_digest(path):
    if path.is_file():
        return digest(path.read_bytes())
    if not path.is_dir():
        raise ValueError("Missing declared audit runtime File or TreeArtifact")
    entries = []
    for entry in sorted(path.rglob("*")):
        relative = entry.relative_to(path).as_posix()
        if entry.is_file():
            entries.append([relative, "file", stat.S_IMODE(entry.stat().st_mode), digest(entry.read_bytes())])
        elif entry.is_dir() and not entry.is_symlink():
            entries.append([relative, "directory"])
        else:
            raise ValueError("Unsupported member in declared audit runtime TreeArtifact")
    return digest(json.dumps(entries, separators=(",", ":")).encode())


def audit_commands(specification):
    locks = ["Cargo.lock"] + sorted(name for name in specification["inputs"]
                                    if name != "Cargo.lock" and Path(name).name == "Cargo.lock")
    return [("bun", COMMANDS["bun"])] + [
        ("cargo_audit", COMMANDS["cargo_audit"][:-1] + [lock]) for lock in locks
    ]


def configuration(specification, runfiles):
    if set(specification) != {"inputs", "tools", "runtime", "sdk"}:
        raise ValueError("Unexpected audit configuration")
    if not {"package.json", "bun.lock", "Cargo.lock"} <= set(specification["inputs"]):
        raise ValueError("Audit requires the original Bun/package/Cargo lock inputs")
    if set(specification["tools"]) != set(VERSIONS):
        raise ValueError("Audit requires both original pinned native engines")
    captured = {}
    facts = {}
    for name, runfile in specification["inputs"].items():
        member(name)
        if name == "empty-bunfig.toml":
            raise ValueError("Audit source cannot replace its declared empty acquisition configuration")
        captured[name] = (runfiles / member(runfile)).read_bytes()
        facts["input:" + name] = digest(captured[name])
    if ".cargo/audit.toml" in captured:
        policy = tomllib.loads(captured[".cargo/audit.toml"].decode())
        database = policy.get("database", {})
        yanked = policy.get("yanked", {})
        if (policy.get("output", {}).get("quiet", False) or
                database.get("fetch", True) is not True or database.get("stale", False) or
                database.get("path") is not None or database.get("url") is not None or
                yanked.get("enabled", True) is not True or yanked.get("update_index", True) is not True):
            raise ValueError("Audit configuration suppresses fresh original advisory/yanked acquisition")
    for runfile in specification["runtime"]:
        member(runfile)
        facts["runtime:" + runfile] = runtime_digest(runfiles / runfile)
    for name, runfile in specification["tools"].items():
        member(runfile)
        if runfile not in specification["runtime"]:
            raise ValueError("Audit engine is absent from its declared runtime Files")
        facts["tool:" + name] = digest((runfiles / runfile).read_bytes())
    member(specification["sdk"])
    return captured, facts


def validate(snapshot, specification, runfiles, request):
    _, facts = configuration(specification, runfiles)
    if set(snapshot) != {"request", "facts", "versions", "audits"}:
        raise ValueError("Incomplete original audit snapshot")
    if not request or snapshot["request"] != digest(request):
        raise ValueError("Audit snapshot belongs to another fresh acquisition request")
    if snapshot["facts"] != facts or snapshot["versions"] != VERSIONS:
        raise ValueError("Audit snapshot differs from configured source or native engine Files")
    audits = snapshot["audits"]
    if not isinstance(audits, list) or not audits:
        raise ValueError("Missing native Bun audit result")
    commands = audit_commands(specification)
    if len(audits) > len(commands):
        raise ValueError("Native audit order or short-circuit coverage differs")
    for index, audit in enumerate(audits):
        if set(audit) != {"engine", "command", "exit", "stdout", "stderr"}:
            raise ValueError("Incomplete native audit result")
        if (audit["engine"], audit["command"]) != commands[index]:
            raise ValueError("Audit command introduced a policy exemption")
        if type(audit["exit"]) is not int or not isinstance(audit["stdout"], str) or not isinstance(audit["stderr"], str):
            raise ValueError("Invalid native audit process result")
        if audit["exit"] > 255:
            raise ValueError("Invalid native audit process exit status")
        if audit["exit"] != 0:
            if index != len(audits) - 1:
                raise ValueError("Native audit continued after its short-circuit failure")
            return audit["exit"] if audit["exit"] > 0 else 1
        if audit["engine"] == "bun":
            report = json.loads(audit["stdout"])
            if not isinstance(report, dict):
                raise ValueError("Bun audit omitted its original JSON report")
        else:
            # These exact upstream failures can otherwise leave yanked coverage
            # absent while the original engine emits a nominal successful report.
            # Cargo's JSON output suppresses fetch/open warnings; keep the
            # original terminal mode so those failures remain observable.
            if any(error in audit["stderr"] for error in YANKED_ERRORS):
                raise ValueError("Cargo audit did not complete its yanked registry acquisition")
    if len(audits) != len(commands):
        raise ValueError("Native audit omitted its complete declared Cargo lock coverage")
    return 0


def acquire(specification, runfiles, request, output):
    if not request:
        raise ValueError("Fresh audit requires the controller's acquisition request File")
    inputs, facts = configuration(specification, runfiles)
    snapshot = {"request": digest(request), "facts": facts, "versions": {}, "audits": []}
    with tempfile.TemporaryDirectory(prefix="dependency-audit-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        home = root / "home"
        home.mkdir()
        for name, data in inputs.items():
            destination = workspace / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        (workspace / "empty-bunfig.toml").write_text("")
        sdk = runfiles / specification["sdk"]
        environment = {"HOME": str(home), "CARGO_HOME": str(home / "cargo"), "PATH": str(sdk / "bin"),
                       "TMPDIR": str(root), "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1",
                       "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
                       "GIT_EXEC_PATH": str(sdk / "libexec/git-core"), "GIT_TEMPLATE_DIR": str(sdk / "share/git-core/templates"),
                       "SSL_CERT_FILE": str(sdk / "ssl/cacert.pem"), "GIT_SSL_CAINFO": str(sdk / "ssl/cacert.pem"),
                       "OPENSSL_CONF": str(sdk / "ssl/openssl.cnf"), "OPENSSL_MODULES": str(sdk / "lib/ossl-modules")}
        environment["DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = str(sdk / "lib")
        # Validate both engine identities before running either. No tool discovery,
        # dependency installation, resolver, or ambient home/configuration is used.
        for name, version in VERSIONS.items():
            executable = runfiles / specification["tools"][name]
            observed = subprocess.check_output([str(executable), "--version"], cwd=workspace, env=environment, text=True).strip()
            if observed != version:
                raise ValueError("Audit requires its original pinned " + name + " engine")
            snapshot["versions"][name] = observed
        for name, command in audit_commands(specification):
            executable = runfiles / specification["tools"][name]
            completed = subprocess.run([str(executable), *command], cwd=workspace, env=environment,
                                       capture_output=True, text=True)
            snapshot["audits"].append({"engine": name, "command": command, "exit": completed.returncode,
                                       "stdout": completed.stdout, "stderr": completed.stderr})
            if completed.returncode != 0:
                break
    if configuration(specification, runfiles)[1] != facts:
        raise ValueError("Declared audit source or native runtime changed during acquisition")
    # Failed acquisition remains reviewable; it never manufactures a green report.
    with output.open("x") as stream:
        json.dump(snapshot, stream, indent=2)
        stream.write("\n")
    return validate(snapshot, specification, runfiles, request)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["acquire", "check"])
    parser.add_argument("--configuration", type=Path, required=True)
    parser.add_argument("--runfiles", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    arguments = parser.parse_args()
    specification = json.loads(arguments.configuration.read_text())
    request = arguments.request.read_bytes()
    if arguments.operation == "acquire":
        return acquire(specification, arguments.runfiles.absolute(), request, arguments.snapshot.absolute())
    snapshot = json.loads(arguments.snapshot.read_text())
    for audit in snapshot.get("audits", []):
        sys.stdout.write(audit.get("stdout", ""))
        sys.stderr.write(audit.get("stderr", ""))
    return validate(snapshot, specification, arguments.runfiles.absolute(), request)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
