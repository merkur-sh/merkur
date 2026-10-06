"""Ask original stock rustc to validate exact rmeta/rlib SVH pairing.

Object emission is essential: metadata-only rlib emission intentionally skips
object archives and does not establish this relation. No linker executes.
"""
import hashlib
from pathlib import Path
import subprocess

# Exact original crate-level unstable gates on panic_abort, panic_unwind,
# unwind, profiler_builtins, std_detect, and test source entry Files.
GATES = {"panic_abort": "panic_abort", "panic_unwind": "panic_unwind",
         "unwind": "panic_unwind", "profiler_builtins": "profiler_runtime_lib",
         "std_detect": "stdarch_internal", "test": "test"}

def pair(sdk, rlib, metadata, target, output, crate, sysroot=None):
    namespace = []
    if target == "wasm32-unknown-unknown":
        if sysroot is None:
            raise ValueError("Original WASM pair requires its declared target sysroot")
        root = Path(sysroot)
        if not root.is_absolute() or root.resolve(strict=True) != root:
            raise ValueError("Original WASM pair requires an exact ordinary sysroot namespace")
        directory = root / "lib/rustlib/wasm32-unknown-unknown/lib"
        if any(Path(file).resolve(strict=True).parent != directory for file in [rlib, metadata]):
            raise ValueError("Original WASM pair Files differ from the declared target sysroot")
        namespace = ["--sysroot=" + str(root)]
    elif sysroot is not None:
        raise ValueError("Explicit target sysroot is only supported for original WASM pairs")
    output = Path(output).absolute()
    output.mkdir()
    source = output / "association.rs"
    features = ["rustc_private"] + ([GATES[crate]] if crate in GATES else [])
    body = ("#![allow(internal_features)]\n#![feature(" + ",".join(features) + ")]\nextern crate association;\nfn main() {}\n").encode()
    source.write_bytes(body)
    source_hash = hashlib.sha256(body).hexdigest()
    object_file = output / "association.o"
    command = sdk.command("rustc", "1.97.1") + [
        "--crate-name=stock_association", "--crate-type=bin", "--emit=obj",
        "--target=" + target, "--extern", "association=" + str(metadata),
        "--extern", "association=" + str(rlib), str(source), "-o", str(object_file),
    ]
    command[1:1] = namespace
    process = subprocess.run(command, cwd=output, env=sdk.environment(bootstrap=True), capture_output=True)
    (output / "stdout").write_bytes(process.stdout)
    (output / "stderr").write_bytes(process.stderr)
    if process.returncode != 0:
        raise ValueError("Original compiler rejected exact stock archive/metadata pairing: " + process.stderr.decode("utf-8"))
    body = object_file.read_bytes()
    return {"command": command, "exit": 0,
            "source_sha256": source_hash,
            "object": {"path": str(object_file), "size": len(body), "sha256": hashlib.sha256(body).hexdigest()},
            "relation": "Original compiler CrateSource rmeta/rlib with equal SVH; object emission, no linker"}
