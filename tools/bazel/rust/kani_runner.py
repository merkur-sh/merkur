#!/usr/bin/env python3
"""Execute Kani's complete specialized pipeline inside the nonce-keyed test action.

The driver/compilers/backend and source inputs are declared runfiles. This runner
never consumes a solver verdict emitted by a reusable build action.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def original_tree(checker, checker_path, production_path):
    """Resolve the original TreeArtifact using another declared generated File."""
    paths = [Path(value) for value in [checker_path, production_path]]
    if any(path.is_absolute() or not path.parts or any(part in [".", ".."] for part in path.parts) for path in paths):
        raise ValueError("proof artifacts require exact declared relative execution paths")
    executable = checker.resolve(strict=True)
    root = executable
    for _ in paths[0].parts:
        root = root.parent
    if root / paths[0] != executable:
        raise ValueError("checker location does not match its declared generated File")
    return (root / paths[1]).resolve(strict=True)


def native_preprocessor(specification, runfiles, destination, environment):
    """Bind CBMC's hardcoded gcc/clang names to the genuine declared C compiler."""
    mappings = {}
    conflicts = set()
    for execution_path, runfile in specification["files"].items():
        source, target = Path(execution_path), runfiles / runfile
        if source.is_absolute() or ".." in source.parts or Path(runfile).is_absolute() or ".." in Path(runfile).parts:
            raise ValueError("native compiler closure requires exact declared relative File paths")
        if not target.exists():
            raise ValueError("native compiler closure File is absent from runfiles")
        while str(source) != ".":
            key, value = str(source), str(target)
            if key in mappings and mappings[key] != value:
                conflicts.add(key)
            mappings[key] = value
            source, target = source.parent, target.parent
    for key in conflicts:
        del mappings[key]
    compiler = specification["compiler"]
    if compiler not in specification["files"]:
        raise ValueError("native compiler is not an original declared CcToolchain File")

    def relocate(value):
        # Paths come from cc_common and the exact File closure, not guessed host roots.
        for key in sorted(mappings, key=len, reverse=True):
            start = 0
            while True:
                index = value.find(key, start)
                if index < 0:
                    break
                end = index + len(key)
                prefix = value[:index]
                if (index == 0 or value[index - 1] in "=:" or prefix in ["-I", "-F", "-L"]) and (end == len(value) or value[end] in "/:"):
                    value = value[:index] + mappings[key] + value[end:]
                    start = index + len(mappings[key])
                else:
                    start = end
        return value

    command = [mappings[compiler]] + [relocate(flag) for flag in specification["flags"]]
    compiler_environment = dict(environment)
    compiler_environment.update({key: relocate(value) for key, value in specification["environment"].items()})
    # The compiler may locate subordinate tools only inside its declared closure.
    compiler_paths = compiler_environment.get("PATH") if "PATH" in specification["environment"] else str(Path(mappings[compiler]).parent)
    if any(path not in mappings.values() for path in compiler_paths.split(os.pathsep)):
        raise ValueError("native compiler PATH escapes the declared CcToolchain closure")
    compiler_environment["PATH"] = compiler_paths
    destination.mkdir()
    body = "#!" + sys.executable + "\nimport os,sys\nos.execve(" + repr(command[0]) + "," + repr(command) + "+sys.argv[1:]," + repr(compiler_environment) + ")\n"
    for name in ["gcc", "clang"]:
        executable = destination / name
        executable.write_text(body)
        executable.chmod(0o700)
    return destination


def copy_sources(source, destination):
    if source.is_dir():
        destination.mkdir()
        for entry in source.iterdir():
            if entry.is_symlink():
                raise ValueError("generated proof source tree contains a symlink")
            copy_sources(entry, destination / entry.name)
    elif source.is_file():
        shutil.copyfile(source, destination)
    else:
        raise ValueError("proof input is not a declared source File or directory")


def execute(driver, checker, source, production_sources, outputs, native, runfiles, negative=False):
    driver, checker = driver.resolve(strict=True), checker.resolve(strict=True)
    output = outputs / "kani"
    output.mkdir()  # A prior verdict or interrupted pipeline cannot be restored here.
    work, proof, home = [output / name for name in ["sources", "proof", "home"]]
    for directory in [work, proof, home]:
        directory.mkdir()
    harness = work / source.name
    shutil.copyfile(source, harness)
    production = work / "production"
    copy_sources(production_sources, production)
    prefix = driver.parent.parent
    environment = {
        "PATH": os.pathsep.join([str(driver.parent), str(prefix / "toolchain/bin")]),
        "HOME": str(home), "TMPDIR": str(home), "KANI_HOME": str(prefix),
        "OUT_DIR": str(production),
    }
    native_bin = native_preprocessor(native, runfiles, output / "native-bin", environment)
    environment["PATH"] = str(native_bin) + os.pathsep + environment["PATH"]
    results = proof / "results.json"
    arguments = [str(driver), str(harness), "--target-dir", str(proof),
                 "--keep-temps", "-Z", "unstable-options", "--export-json", str(results)]
    if negative:
        arguments += ["--harness", "proofs::custody_survives_provider_switch", "--exact"]
    # Write through owned output descriptors so cancellation still retains diagnostics.
    with (output / "driver.stdout").open("xb") as stdout, (output / "driver.stderr").open("xb") as stderr:
        completed = subprocess.run(arguments, cwd=work, env=environment, stdout=stdout, stderr=stderr)
    (output / "exit-status").write_text(str(completed.returncode) + "\n")
    expected_status = 1 if negative else 0
    if completed.returncode != expected_status:
        raise ValueError("specialized Kani compilation or verification failed: " + str(completed.returncode))
    if not results.is_file():
        raise ValueError("specialized Kani pipeline did not produce fresh verification results")
    classification = [str(checker), str(results)] + (["negative"] if negative else [])
    with (output / "classifier.stdout").open("xb") as stdout, (output / "classifier.stderr").open("xb") as stderr:
        checked = subprocess.run(classification, cwd=work, env=environment, stdout=stdout, stderr=stderr)
    if checked.returncode != 0:
        raise ValueError("specialized Kani proof inventory or intended negative failure was rejected")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["driver", "checker", "source"]:
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--negative", action="store_true")
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--runfiles", required=True, type=Path)
    args = parser.parse_args()
    runfiles = args.runfiles.absolute()
    native = json.loads(args.native.read_text())
    production = original_tree(args.checker, native["checker"], native["production_sources"])
    execute(args.driver, args.checker, args.source, production,
            Path(os.environ["TEST_UNDECLARED_OUTPUTS_DIR"]).absolute(),
            native, runfiles, args.negative)


if __name__ == "__main__":
    main()
