#!/usr/bin/env python3
"""Qualify genuine patched compiler requests; require original declared tool paths."""

import argparse
import base64
import ctypes
import hashlib
import json
import pathlib
import select
import shutil
import subprocess
import tempfile
import time


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Requests:
    def __init__(self, root, worker, confiner, wrapper, compiler):
        self.root = root
        self.root.mkdir()
        shutil.copytree(compiler, root / "sdk")
        shutil.copy2(confiner, root / "confiner")
        shutil.copy2(wrapper, root / "wrapper")
        self.immutable = [path for path in sorted(root.rglob("*")) if path.is_file()]
        self.process = subprocess.Popen([str(worker), "--persistent_worker"], cwd=root, env={"PATH": "", "TMPDIR": str(root.parent), "HOME": str(root.parent)}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.sequence = 0

    def close(self):
        self.process.stdin.close()
        status = self.process.wait(timeout=120)
        if status:
            raise AssertionError("Worker failed to finish: " + self.process.stderr.read())

    def request(self, source):
        (self.root / "source.rs").write_text(source)
        specification = {"crate": "//qualification:compiler", "confiner": "confiner", "env": {"PATH": ""}, "sources": ["source.rs"], "outputs": [{"path": "out/libcontrol.rlib", "directory": False}, {"path": "out/libcontrol.rmeta", "directory": False}]}
        (self.root / "spec.json").write_text(json.dumps(specification))
        self.sequence += 1
        inputs = [{"path": path.relative_to(self.root).as_posix(), "digest": base64.b64encode(digest(path).encode()).decode()} for path in [*self.immutable, self.root / "source.rs", self.root / "spec.json"]]
        value = {"requestId": self.sequence, "verbosity": 1, "inputs": inputs, "arguments": ["--spec", "spec.json", "--command", "wrapper", "--", "sdk/bin/rustc", "source.rs", "--crate-name=control", "--crate-type=rlib", "--edition=2024", "--emit=metadata,link", "--out-dir=out", "-Cdeterministic-incremental-temporaries=yes", "-Cdebuginfo=0", "-Cmetadata=merkur_compiler_qualification", "-Copt-level=0"]}
        self.send(value)
        return self.sequence

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def response(self, request):
        value = self.process.stdout.readline()
        if not value:
            raise AssertionError("Worker exited before response: " + self.process.stderr.read())
        result = json.loads(value)
        if result.get("requestId") != request:
            raise AssertionError("Worker returned another request's response")
        return result

    def outputs(self):
        return {path: digest(self.root / path) for path in ["out/libcontrol.rlib", "out/libcontrol.rmeta"]}


def only_child(parent, libproc):
    # The worker owns one wrapper, which owns one fork-denied compiler leaf.
    # Any additional child is an actual confinement failure, not a truncated
    # process enumeration accepted as complete.
    children = (ctypes.c_int * 3)()
    count = libproc.proc_listchildpids(parent, children, ctypes.sizeof(children))
    if count <= 0:
        return None
    if count != 1:
        raise AssertionError("Compiler scope contains multiple child processes")
    return children[0]


def cancel_real_compiler(requests, request):
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_listchildpids.restype = ctypes.c_int
    libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    libproc.proc_pidpath.restype = ctypes.c_int
    deadline = time.monotonic() + 120
    events = select.kqueue()
    try:
        while True:
            wrapper = only_child(requests.process.pid, libproc)
            compiler = only_child(wrapper, libproc) if wrapper else None
            if compiler:
                path = ctypes.create_string_buffer(4096)
                if libproc.proc_pidpath(compiler, path, len(path)) > 0 and path.value.decode().endswith("/execroot/sdk/bin/rustc"):
                    # Registration binds the exact live kernel process object;
                    # PID reuse after exit cannot satisfy these NOTE_EXIT events.
                    changes = [select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT) for pid in [wrapper, compiler]]
                    events.control(changes, 0, 0)
                    break
            if time.monotonic() >= deadline:
                raise AssertionError("Genuine compiler did not reach its native process-start event")
            time.sleep(0.001)
        requests.send({"requestId": request, "cancel": True})
        response = requests.response(request)
        if response.get("wasCancelled") is not True:
            raise AssertionError("Cancellation did not retire the active genuine compiler request")
        retired = set()
        while retired != {wrapper, compiler}:
            for event in events.control(None, 2, max(0, deadline - time.monotonic())):
                if event.flags & select.KQ_EV_ERROR or not event.fflags & select.KQ_NOTE_EXIT:
                    raise AssertionError("Compiler process retirement did not produce exact kernel exit events")
                retired.add(event.ident)
            if time.monotonic() >= deadline and retired != {wrapper, compiler}:
                raise AssertionError("Cancelled compiler scope failed to exit")
        if only_child(requests.process.pid, libproc):
            raise AssertionError("Worker acknowledged cancellation while retaining a child")
        if any((requests.root / path).exists() for path in ["out/libcontrol.rlib", "out/libcontrol.rmeta"]):
            raise AssertionError("Cancelled request retained a public compiler output")
        return {"response": response, "kernel_exit_events": sorted(retired)}
    finally:
        events.close()


def qualify(worker, confiner, wrapper, compiler, output):
    if output.exists():
        raise ValueError("Qualification evidence directory must be new")
    output.mkdir(parents=True)
    for name in ["rustc", "rustdoc"]:
        version = subprocess.run([str(compiler / "bin" / name), "-vV"], env={"PATH": ""}, capture_output=True, text=True, check=True).stdout
        if "release: 1.97.1" not in version.splitlines() or "commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452" not in version.splitlines() or "merkur-deterministic-worker-experiment" not in version:
            raise ValueError("Worker qualification requires the genuine matched patched compiler and rustdoc")
        (output / (name + "-version.txt")).write_text(version)
    with tempfile.TemporaryDirectory(prefix="actual-compiler-worker-", dir=output) as temporary:
        temporary = pathlib.Path(temporary)
        source = "pub fn value() -> u32 { 7 }\n"
        edited = "pub fn value() -> u32 { 11 }\n"
        requests = Requests(temporary / "warm", worker, confiner, wrapper, compiler)
        results = {}

        def record(name, value):
            results[name] = value
            (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")

        try:
            for name, contents, retained in [("first", source, False), ("edited", edited, True)]:
                response = requests.response(requests.request(contents))
                record(name, {"response": response})
                if response.get("exitCode") != 0 or "retained=" + str(retained).lower() not in response.get("output", ""):
                    raise AssertionError("Genuine " + name + " compilation failed: " + json.dumps(response))
                record(name, {"response": response, "outputs": requests.outputs()})
            fresh = Requests(temporary / "fresh", worker, confiner, wrapper, compiler)
            try:
                response = fresh.response(fresh.request(edited))
                record("fresh", {"response": response})
                if response.get("exitCode") != 0 or fresh.outputs() != results["edited"]["outputs"]:
                    raise AssertionError("Fresh and edited warm compiler artifacts differ: " + json.dumps(response))
                record("fresh", {"response": response, "outputs": fresh.outputs()})
            finally:
                fresh.close()
            response = requests.response(requests.request("pub fn value() -> u32 { absent() }\n"))
            record("failed", response)
            if response.get("exitCode", 0) == 0 or any((requests.root / path).exists() for path in ["out/libcontrol.rlib", "out/libcontrol.rmeta"]):
                raise AssertionError("Failed genuine compiler request retained an output")
            stress = "\n".join("pub fn function_" + str(index) + "(v:u64)->u64{v.wrapping_mul(" + str(index) + ")}" for index in range(10000))
            record("cancelled", cancel_real_compiler(requests, requests.request(stress)))
            response = requests.response(requests.request(edited))
            record("after_cancel", {"response": response})
            if response.get("exitCode") != 0 or "retained=false" not in response.get("output", "") or requests.outputs() != results["fresh"]["outputs"]:
                raise AssertionError("Cancelled state poisoned next genuine compiler request: " + json.dumps(response))
            record("after_cancel", {"response": response, "outputs": requests.outputs()})
        finally:
            requests.close()
        results["tools"] = {name: {"path": str(path), "sha256": digest(path)} for name, path in [("worker", worker), ("confiner", confiner), ("wrapper", wrapper)]}
        (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["worker", "confiner", "wrapper", "compiler", "output"]:
        parser.add_argument("--" + name, type=pathlib.Path, required=True)
    args = parser.parse_args()
    qualify(args.worker.resolve(strict=True), args.confiner.resolve(strict=True), args.wrapper.resolve(strict=True), args.compiler.resolve(strict=True), args.output.absolute())
