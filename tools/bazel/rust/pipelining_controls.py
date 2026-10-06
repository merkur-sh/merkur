#!/usr/bin/env python3
"""Run the pinned stable compiler through rules_rust's actual metadata wrapper.

A passing fixture checks the supported metadata-termination strategy and metadata
compatibility. Production scheduling, four-host execution and timing remain
separate qualifications; this fixture does not enable pipelining globally.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rustc", required=True, type=Path)
    parser.add_argument("--wrapper", required=True, type=Path)
    parser.add_argument("--dependency", required=True, type=Path)
    parser.add_argument("--consumer", required=True, type=Path)
    parser.add_argument("--failure", required=True, type=Path)
    args = parser.parse_args()
    rustc, wrapper = args.rustc.resolve(strict=True), args.wrapper.resolve(strict=True)
    with tempfile.TemporaryDirectory(dir=os.environ.get("TEST_TMPDIR")) as temporary:
        root = Path(temporary)
        environment = {"PATH": "", "HOME": str(root), "TMPDIR": str(root)}
        version = subprocess.run([str(rustc), "-vV"], env=environment, capture_output=True, text=True, check=True).stdout
        if "release: 1.97.1" not in version.splitlines() or "commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452" not in version.splitlines():
            raise AssertionError("Pipelining controls require the declared stable Rust1.97.1 compiler")
        for name in ["dependency", "consumer", "failure"]:
            shutil.copyfile(getattr(args, name), root / (name + ".rs"))

        def compile(crate, source, output, profile, dependency=None, metadata=False):
            output.mkdir()
            flags = [str(rustc), str(root / (source + ".rs")), "--crate-name=" + crate,
                     "--crate-type=rlib", "--edition=2024", "--emit=metadata,link",
                     "--error-format=json", "--json=artifacts", "--out-dir=" + str(output),
                     "--remap-path-prefix=" + str(root) + "=/merkur-pipeline",
                     "-Cmetadata=merkur_pipelining_control", "-Copt-level=" + ("0" if profile == "dev" else "3"),
                     "-Cdebug-assertions=" + ("yes" if profile == "dev" else "no"), "-Cdebuginfo=0"]
            if dependency is not None:
                flags += ["--extern=pipeline_dependency=" + str(dependency)]
            command = ([str(wrapper), "--rustc-quit-on-rmeta", "true", "--rustc-output-format", "json", "--"] if metadata else []) + flags
            return subprocess.run(command, env=environment, capture_output=True, text=True)

        for profile in ["dev", "release"]:
            serial, metadata = root / (profile + "-serial"), root / (profile + "-metadata")
            serial_result = compile("pipeline_dependency", "dependency", serial, profile)
            metadata_result = compile("pipeline_dependency", "dependency", metadata, profile, metadata=True)
            if serial_result.returncode != 0 or metadata_result.returncode != 0:
                raise AssertionError("Actual stable metadata wrapper failed: " + serial_result.stderr + metadata_result.stderr)
            serial_rmeta, early_rmeta = serial / "libpipeline_dependency.rmeta", metadata / "libpipeline_dependency.rmeta"
            if not early_rmeta.is_file() or early_rmeta.read_bytes() != serial_rmeta.read_bytes():
                raise AssertionError("Early metadata differs from ordinary compilation")
            consumer_serial, consumer_pipeline = root / (profile + "-consumer-serial"), root / (profile + "-consumer-pipeline")
            ordinary = compile("pipeline_consumer", "consumer", consumer_serial, profile, serial / "libpipeline_dependency.rlib", metadata=True)
            pipelined = compile("pipeline_consumer", "consumer", consumer_pipeline, profile, early_rmeta, metadata=True)
            if ordinary.returncode != 0 or pipelined.returncode != 0:
                raise AssertionError("Downstream compilation rejected early metadata: " + ordinary.stderr + pipelined.stderr)
            if (consumer_serial / "libpipeline_consumer.rmeta").read_bytes() != (consumer_pipeline / "libpipeline_consumer.rmeta").read_bytes():
                raise AssertionError("Downstream metadata differs between rlib and early-rmeta inputs")
            failure = root / (profile + "-failure")
            rejected = compile("pipeline_failure", "failure", failure, profile, metadata=True)
            if rejected.returncode == 0 or (failure / "libpipeline_failure.rmeta").exists():
                raise AssertionError("Type failure was accepted by the actual metadata wrapper")
        print("Stable metadata termination controls passed: dev/release metadata parity, downstream rmeta consumption, rejected type errors")


if __name__ == "__main__":
    main()
