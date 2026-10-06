#!/usr/bin/env python3
"""Run the original release-library workloads with the configured Rust LLVM tools."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


WORKLOADS = (
    ("suite", (), False),
    ("display-pipeline", ("display::send::tests::production_display_pipeline_benchmark", "--exact", "--ignored"), True),
    ("scroll", ("production_scroll_literal_benchmark", "--test-threads=1", "--ignored"), True),
)


def matching_tools(rustc, profdata, environment, run=subprocess.run):
    compiler = run([str(rustc), "-vV"], env=environment, capture_output=True, text=True)
    llvm = run([str(profdata), "--version"], env=environment, capture_output=True, text=True)
    if compiler.returncode or llvm.returncode:
        raise ValueError("The configured Rust compiler and LLVM profile tool must execute")
    fields = dict(line.split(": ", 1) for line in compiler.stdout.splitlines() if ": " in line)
    if fields.get("release") != "1.97.1" or fields.get("LLVM version") != "22.1.6":
        raise ValueError("Release PGO requires the pinned Rust1.97.1 compiler")
    version = "LLVM version " + fields["LLVM version"] + "-rust-" + fields["release"] + "-stable"
    if version not in [line.strip() for line in llvm.stdout.splitlines()]:
        raise ValueError("Release PGO must merge with the same Rust compiler's LLVM")
    return fields


def train(binary, profdata, cwd, raw, output, environment, run=subprocess.run):
    """Preserve suite breadth policy while requiring real work and data in every case."""
    profiles = []
    for name, arguments, must_pass in WORKLOADS:
        listed = run([str(binary), *arguments, "--list"], cwd=cwd,
                     env={**environment, "LLVM_PROFILE_FILE": "/dev/null"},
                     capture_output=True, text=True)
        if listed.returncode or not any(line.endswith(": test") for line in listed.stdout.splitlines()):
            raise ValueError("PGO workload " + name + " selects no test")
        result = run([str(binary), *arguments], cwd=cwd,
                     env={**environment, "LLVM_PROFILE_FILE": str(raw / (name + "-%p-%m.profraw"))})
        if must_pass and result.returncode:
            raise RuntimeError("PGO workload " + name + " failed: " + str(result.returncode))
        written = sorted(raw.glob(name + "-*.profraw"))
        if not written or any(not path.is_file() or path.is_symlink() or path.stat().st_size == 0 for path in written):
            raise ValueError("PGO workload " + name + " wrote no regular nonempty profile")
        profiles.extend(written)
    result = run([str(profdata), "merge", "-o", str(output), *map(str, profiles)],
                 cwd=cwd, env=environment)
    if result.returncode or not output.is_file() or output.is_symlink() or output.stat().st_size == 0:
        raise ValueError("The matching LLVM tool did not merge the original workload profiles")
    # rustc warns and continues for malformed profile-use data. The producing
    # action must establish that its ordinary output is a real LLVM profile.
    verified = run([str(profdata), "show", str(output)], cwd=cwd, env=environment,
                   capture_output=True, text=True)
    if verified.returncode:
        raise ValueError("Release PGO merged output is not a valid matching LLVM profile")


def materialize_runtime(records, root):
    for record in records:
        if not isinstance(record, dict) or set(record) != {"logical", "path"}:
            raise ValueError("PGO runtime requires original declared File placements")
        relative = Path(record["logical"])
        if not relative.parts or relative.is_absolute() or any(part in ("", ".", "..") for part in record["logical"].split("/")):
            raise ValueError("PGO runtime placement must stay inside the original workspace")
        source = Path(record["path"]).resolve(strict=True)
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() or destination.is_symlink():
            raise ValueError("PGO runtime File placement is duplicated")
        destination.symlink_to(source, target_is_directory=source.is_dir())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    binary = Path(request["binary"]).resolve(strict=True)
    rustc = Path(request["rustc"]).resolve(strict=True)
    profdata = Path(request["profdata"]).resolve(strict=True)
    output = Path(request["output"]).absolute()
    raw_output = Path(request["raw_output"]).absolute()
    with tempfile.TemporaryDirectory(prefix="merkur-release-pgo-") as directory:
        root = Path(directory)
        home, raw, workspace = root / "home", root / "profiles", root / "workspace"
        home.mkdir()
        raw.mkdir()
        workspace.mkdir()
        materialize_runtime(request["runtime"], workspace)
        cwd = workspace / "apps/daemon/dataplane"
        if not (cwd / "Cargo.toml").is_file():
            raise ValueError("PGO training requires the original dataplane runtime manifest")
        environment = {"PATH": "", "HOME": str(home), "TMPDIR": str(root),
                       "CARGO_MANIFEST_DIR": str(cwd)}
        fields = matching_tools(rustc, profdata, environment)
        if fields.get("host") != request["target"]:
            raise ValueError("Release workloads require their actual native compiler host")
        temporary = root / "dataplane.profdata"
        train(binary, profdata, cwd, raw, temporary, environment)
        shutil.copyfile(temporary, output)
        # A TreeArtifact root may already have been created by Bazel.
        raw_output.mkdir(exist_ok=True)
        if list(raw_output.iterdir()):
            raise ValueError("PGO raw output must be fresh")
        for source in sorted(raw.iterdir()):
            shutil.copyfile(source, raw_output / source.name)


if __name__ == "__main__":
    main()
