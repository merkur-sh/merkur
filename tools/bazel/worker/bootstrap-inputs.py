"""Materialize pinned stage0/LLVM inputs; never execute a compiler bootstrap."""

import argparse
import hashlib
import json
import pathlib
import shutil
import tarfile
import tempfile

HOST = "aarch64-apple-darwin"
SELECTORS = ["compiler/rustc", "library", "src/tools/rustdoc"]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check_sources(request):
    source = pathlib.Path(request["sources"])
    pin = json.loads(pathlib.Path(request["compiler_pins"]).read_text())
    bootstrap = json.loads(pathlib.Path(request["bootstrap_pins"]).read_text())
    if bootstrap["host"] != HOST or bootstrap["stage0_version"] != "1.96.0" or bootstrap["stage0_date"] != "2026-05-28":
        raise ValueError("Bootstrap distributions require the exact native stage0 host")
    if digest(pathlib.Path(request["source_archive"])) != pin["source_archive"]["sha256"] or digest(pathlib.Path(request["patch"])) != pin["patch"]["sha256"]:
        raise ValueError("Original compiler source or patch differs from the declared pins")
    receipt = json.loads((source / "merkur-source-receipt.json").read_text())
    if receipt["source_archive_sha256"] != pin["source_archive"]["sha256"] or receipt["patch_sha256"] != pin["patch"]["sha256"]:
        raise ValueError("Prepared source does not bind the original source and patch")
    for row in pin["files"]:
        if digest(source / row["path"]) != row["patched_sha256"]:
            raise ValueError("Prepared compiler source differs: " + row["path"])
    for name, sha in bootstrap["source_guards"].items():
        if digest(source / name) != sha:
            raise ValueError("Pinned bootstrap source differs: " + name)
    if digest(source / "src/stage0") != bootstrap["stage0_sha256"]:
        raise ValueError("Bootstrap stage0 identity differs")
    stage0 = dict(line.split("=", 1) for line in (source / "src/stage0").read_text().splitlines() if "=" in line and not line.startswith("#"))
    if stage0["compiler_version"] != bootstrap["stage0_version"] or stage0["compiler_date"] != bootstrap["stage0_date"]:
        raise ValueError("Native stage0 version/date differs from upstream source")
    roles = {}
    for row in bootstrap["stage0_archives"]:
        key = row["source_key"]
        filename = key.rsplit("/", 1)[1]
        role = filename.removesuffix("-1.96.0-" + HOST + ".tar.xz")
        if role not in {"rustc", "cargo", "rust-std"} or role in roles or stage0.get(key) != row["sha256"]:
            raise ValueError("Stage0 archive does not match its upstream bootstrap identity")
        roles[role] = {"sha256": row["sha256"], "prefix": filename.removesuffix(".tar.xz"), "component": "rust-std-" + HOST if role == "rust-std" else role}
    if set(roles) != {"rustc", "cargo", "rust-std"} or set(request["archives"]) != {"rustc", "cargo", "rust-std", "llvm"}:
        raise ValueError("Every original stage0 and LLVM archive is mandatory")
    llvm = pin["llvm_archive"]
    if llvm["platform"] != HOST or pin["llvm"] != "22.1.6":
        raise ValueError("LLVM must match the patched compiler and host")
    roles["llvm"] = {"sha256": llvm["sha256"], "prefix": "rust-dev-1.97.1-" + HOST, "component": "rust-dev"}
    files = request["sdk_files"]
    if not isinstance(files, list) or not files or len(files) != len(set(files)) or request["git"] not in files or request["python"] not in files:
        raise ValueError("The complete declared Python/Git SDK closure is mandatory")
    facts = []
    for name in files:
        path = pathlib.Path(name)
        if not path.is_file():
            raise ValueError("Declared bootstrap SDK input is not a regular File")
        facts.append({"path": name, "sha256": digest(path)})
    return source, pin, bootstrap, roles, facts


def captured_archive(path, expected, scratch):
    """Hash and extract the same private captured bytes, never reopen for provenance."""
    capture = tempfile.TemporaryFile(dir=scratch)
    sha = hashlib.sha256()
    with path.open("rb") as original:
        for chunk in iter(lambda: original.read(1024 * 1024), b""):
            sha.update(chunk)
            capture.write(chunk)
    if sha.hexdigest() != expected:
        capture.close()
        raise ValueError("Original bootstrap archive differs from its upstream pin")
    capture.seek(0)
    return capture


def extract(capture, role, destination):
    with tarfile.open(fileobj=capture, mode="r:xz") as archive:
        members = archive.getmembers()
        seen = set()
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != role["prefix"] or path in seen:
                raise ValueError("Bootstrap archive has an unexpected or duplicate member")
            if not member.isdir() and not member.isfile():
                raise ValueError("Bootstrap archive links and special members are forbidden")
            seen.add(path)
        archive.extractall(destination, members=members, filter="data")
    component = destination / role["prefix"] / role["component"]
    if not component.is_dir():
        raise ValueError("Original bootstrap component is absent")
    return component


def copy_component(component, sdk):
    for entry in component.iterdir():
        if entry.name == "manifest.in":
            continue  # The original remains in distribution/, rather than overwriting another component.
        target = sdk / entry.name
        if entry.is_dir():
            for path in entry.rglob("*"):
                if path.is_file() and (target / path.relative_to(entry)).exists():
                    raise ValueError("Bootstrap components overlap a regular SDK member")
            shutil.copytree(entry, target, dirs_exist_ok=True)
        else:
            if target.exists():
                raise ValueError("Bootstrap components overlap a regular SDK member")
            shutil.copy2(entry, target)


def materialize(request, configuration, stage0_output, llvm_output):
    source, pin, bootstrap, roles, facts = check_sources(request)
    for output in [configuration, stage0_output / "sdk", llvm_output / "sdk"]:
        if output.exists() or output.is_symlink():
            raise ValueError("Bootstrap output must be new")
    with tempfile.TemporaryDirectory(prefix="compiler-bootstrap-inputs-") as scratch:
        scratch = pathlib.Path(scratch)
        captures = {}
        try:
            for name, role in roles.items():
                captures[name] = captured_archive(pathlib.Path(request["archives"][name]), role["sha256"], scratch)
            prepared = {}
            for name, role in roles.items():
                root = scratch / name
                prepared[name] = extract(captures[name], role, root / "distribution")
            stage0 = scratch / "stage0"
            llvm = scratch / "llvm-sdk"
            stage0.mkdir()
            llvm.mkdir()
            for name in ["rustc", "cargo", "rust-std"]:
                copy_component(prepared[name], stage0)
            copy_component(prepared["llvm"], llvm)
            for name in ["rustc", "cargo", "rustdoc"]:
                if not (stage0 / "bin" / name).is_file():
                    raise ValueError("Matching original stage0 compiler, Cargo and Rustdoc are mandatory")
            if not (stage0 / "lib/rustlib" / HOST / "lib").is_dir() or not (llvm / "bin/llvm-config").is_file():
                raise ValueError("Complete native stage0 sysroot and matched LLVM are mandatory")
            # Original action Files remain independently bound; no filesystem-mode admission is claimed.
            for name, role in roles.items():
                if digest(pathlib.Path(request["archives"][name])) != role["sha256"]:
                    raise ValueError("Original bootstrap archive changed during materialization")
            check_sources(request)
            for fact in facts:
                if digest(pathlib.Path(fact["path"])) != fact["sha256"]:
                    raise ValueError("Declared Python/Git SDK File changed during materialization")
            stage0_root = stage0_output / "sdk"
            llvm_root = llvm_output / "sdk"
            manifest = {
                "producer": request["producer"],
                "host": HOST,
                "sources": str(source),
                "source_archive_sha256": pin["source_archive"]["sha256"],
                "patch_sha256": pin["patch"]["sha256"],
                "source_commit": pin["commit"],
                "bootstrap_source_guards": bootstrap["source_guards"],
                "archives": [{"role": name, "path": request["archives"][name], "sha256": role["sha256"]} for name, role in roles.items()],
                "stage0": {"version": "1.96.0", "date": "2026-05-28", "root": str(stage0_root), "rustc": str(stage0_root / "bin/rustc"), "cargo": str(stage0_root / "bin/cargo"), "rustdoc": str(stage0_root / "bin/rustdoc")},
                "llvm": {"version": "22.1.6", "root": str(llvm_root), "llvm_config": str(llvm_root / "bin/llvm-config")},
                "python": request["python"], "git": request["git"], "sdk_files": facts,
                "bootstrap": {
                    "stage": 1, "selectors": SELECTORS,
                    "build": {"build": HOST, "host": [HOST], "target": [HOST], "jobs": 4, "extended": False, "vendor": True, "locked-deps": True, "submodules": False, "description": "merkur-deterministic-worker-experiment", "python": request["python"], "rustc": str(stage0_root / "bin/rustc"), "cargo": str(stage0_root / "bin/cargo"), "rustdoc": str(stage0_root / "bin/rustdoc")},
                    "rust": {"channel": "stable", "download-rustc": False, "incremental": False, "debug": False, "lto": "off", "llvm-tools": False},
                    "llvm": {"download-ci-llvm": False},
                    "target": {HOST: {"llvm-config": str(llvm_root / "bin/llvm-config"), "llvm-has-rust-patches": True}},
                    "environment": {"PATH": "", "CARGO_NET_OFFLINE": "true"},
                    "required_outputs": ["stage1/bin/rustc", "stage1/bin/rustdoc", "stage1/lib/rustlib/" + HOST + "/lib"],
                },
                "native_execution": {
                    "available": False,
                    "requires": ["Approved native CcToolchainInfo with original compiler, C++, ar, ranlib, linker, runtime and Apple sysroot all_files authority", "Explicit target cc/cxx/ar/ranlib/linker and SDKROOT; no system tool discovery", "Declared Darwin install_name_tool/codesign if the selected bootstrap invokes the source's conditional runtime path"],
                },
                "compiler_built": False, "rustdoc_built": False, "qualified": False,
            }
            configuration.parent.mkdir(parents=True, exist_ok=True)
            for root in [stage0_output, llvm_output]:
                root.mkdir(parents=True, exist_ok=True)
            shutil.move(stage0, stage0_root)
            shutil.move(llvm, llvm_root)
            for name in ["rustc", "cargo", "rust-std"]:
                shutil.move(scratch / name / "distribution", stage0_output / ("distribution-" + name))
            shutil.move(scratch / "llvm" / "distribution", llvm_output / "distribution")
            configuration.write_text(json.dumps(manifest, indent=2) + "\n")
            return manifest
        finally:
            for capture in captures.values():
                capture.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=pathlib.Path, required=True)
    parser.add_argument("--configuration", type=pathlib.Path, required=True)
    parser.add_argument("--stage0", type=pathlib.Path, required=True)
    parser.add_argument("--llvm", type=pathlib.Path, required=True)
    args = parser.parse_args()
    materialize(json.loads(args.request.read_text()), args.configuration, args.stage0, args.llvm)
