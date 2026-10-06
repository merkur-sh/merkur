#!/usr/bin/env python3
"""Run the original bounded Cargo harness in a fresh nonce-keyed test action."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess


def classify(report, harness):
    if report.get("metadata", {}).get("kani_version") != "0.68.0" or report.get("tools", {}).get("cbmc") != "6.11.0 (cbmc-6.11.0)":
        raise ValueError("bounded proof uses an unqualified verifier identity")
    verification = report.get("verification_results", {})
    summary = verification.get("summary", {})
    expected = {"total_harnesses": 1, "executed": 1, "successful": 1, "failed": 0, "status": "completed"}
    if any(summary.get(key) != value for key, value in expected.items()):
        raise ValueError("bounded proof has no complete successful verdict")
    results = verification.get("results", [])
    if len(results) != 1 or results[0].get("harness_id") != harness or results[0].get("status") != "Success":
        raise ValueError("bounded proof selected another or incomplete harness")
    checks = results[0].get("checks", [])
    covers = [check for check in checks if check.get("category") == "cover"]
    ordinary = [check for check in checks if check.get("category") != "cover"]
    if not covers or any(check.get("status") != "Satisfied" for check in covers):
        raise ValueError("bounded proof has an absent or unsatisfied cover and is vacuous")
    if not ordinary or any(check.get("status") not in ["Success", "Unreachable"] for check in ordinary):
        raise ValueError("bounded proof has failed, unknown or absent safety checks")


def execute(driver, cargo, workspace, retained_lock, production_lock, output, native, runfiles, package, harness, helpers):
    driver, cargo = driver.resolve(strict=True), cargo.resolve(strict=True)
    if (driver.parent.parent / "toolchain/bin/cargo").resolve(strict=True) != cargo:
        raise ValueError("Cargo Kani requires its original matched toolchain Cargo File")
    retained, production = retained_lock.read_bytes(), production_lock.read_bytes()
    if (workspace / "Cargo.lock").read_bytes() != retained:
        raise ValueError("declared generated workspace has another dependency lock")
    output.mkdir()
    work, home = output / "workspace", output / "home"
    helpers.copy_sources(workspace, work)
    home.mkdir()
    prefix = driver.parent.parent
    environment = {
        "PATH": os.pathsep.join([str(cargo.parent), str(driver.parent), str(prefix / "toolchain/bin")]),
        "HOME": str(home), "TMPDIR": str(home), "KANI_HOME": str(prefix),
        "CARGO": str(cargo), "CARGO_HOME": str(home / "cargo"), "CARGO_NET_OFFLINE": "true",
        "CARGO_TARGET_DIR": str(output / "target-kani"), "CARGO_INCREMENTAL": "0",
        "RUSTFLAGS": " ".join(native["rustflags"]), "PYTHONNOUSERSITE": "1",
    }
    native_bin = helpers.native_preprocessor(native, runfiles, output / "native-bin", environment)
    environment["PATH"] = str(native_bin) + os.pathsep + environment["PATH"]
    environment["CC"] = str(native_bin / "gcc")
    environment["CXX"] = str(native_bin / "clang")
    results = output / "results.json"
    # Kani's original driver chooses Cargo mode from argv[0]. This invokes the
    # exact declared executable; no cargo plugin lookup or ambient rustup runs.
    # Original keeper proofs stub only their declared external outcomes. Kani
    # 0.68 requires this opt-in to compile those original proof attributes.
    arguments = ["cargo-kani", "kani", "--tests", "--package", package, "--harness", harness, "--exact",
                 "-Z", "unstable-options", "-Z", "stubbing", "--harness-timeout", "15m", "--export-json", str(results),
                 "--target-dir", str(output / "target-kani")]
    with (output / "driver.stdout").open("xb") as stdout, (output / "driver.stderr").open("xb") as stderr:
        completed = subprocess.run(arguments, executable=driver, cwd=work, env=environment, stdout=stdout, stderr=stderr)
    (output / "exit-status").write_text(str(completed.returncode) + "\n")
    if (work / "Cargo.lock").read_bytes() != retained or retained_lock.read_bytes() != retained or production_lock.read_bytes() != production:
        raise ValueError("Cargo Kani changed the retained or production dependency lock")
    if completed.returncode != 0:
        raise ValueError("bounded compilation or solver failed: " + str(completed.returncode))
    if not results.is_file():
        raise ValueError("bounded Kani pipeline omitted fresh verification results")
    classify(json.loads(results.read_text()), harness)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["helpers", "driver", "cargo", "native", "runfiles", "lock", "production-lock"]:
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ["package", "harness"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    specification = importlib.util.spec_from_file_location("declared_kani_helpers", args.helpers)
    helpers = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(helpers)
    native = json.loads(args.native.read_text())
    workspace = helpers.original_tree(args.native, native["anchor"], native["workspace"])
    execute(args.driver, args.cargo, workspace, args.lock, args.production_lock,
            Path(os.environ["TEST_UNDECLARED_OUTPUTS_DIR"]).absolute() / "bounded-kani",
            native, args.runfiles.absolute(), args.package, args.harness, helpers)


if __name__ == "__main__":
    main()
