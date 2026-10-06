#!/usr/bin/env python3
"""Measure a disposable real edge and authenticated peers in separate Linux processes.

Never profiles or restarts a deployed process. Captures are separate diagnostic
runs; their latency/CPU numbers cannot be used as optimization acceptance data.
"""
import argparse
import base64
import hashlib
import http.server
import importlib.util
import json
import os
import platform
import queue
import shutil
import signal
import socket
import statistics
import subprocess
import tempfile
import threading
import time
from pathlib import Path


WORK = {
    "typing": (1, 10000, 57 * 10000),
    "concurrent": (8, 80000, 57 * 80000),
    "burst": (1, 512 * 32, 512 * (57 + 31 * 1100)),
    "stream": (1, 1024, 1024 * 65536),
}

prepare_spec = importlib.util.spec_from_file_location("prepare_edge_profile", Path(__file__).with_name("prepare-edge-profile-linux.py"))
prepare = importlib.util.module_from_spec(prepare_spec)
prepare_spec.loader.exec_module(prepare)


def digest(path):
    checksum = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def receipt(path):
    return {"path": str(path), "sha256": digest(path)}


def retain_binary(path, directory, expected):
    retained = directory / f"{path.name}-{expected}"
    if retained.exists():
        if digest(retained) != expected:
            raise RuntimeError("retained binary was modified")
        return retained
    shutil.copyfile(path, retained)
    if digest(retained) != expected:
        retained.unlink()
        raise RuntimeError("binary changed while retaining the capture input")
    retained.chmod(0o555)
    return retained


def text_or_none(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def edge_resources(pid):
    # After the closing paren: field 3 onwards, so utime/stime are 11/12.
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    clock = os.sysconf("SC_CLK_TCK")
    status = Path(f"/proc/{pid}/status").read_text().splitlines()
    peak = next(int(line.split()[1]) * 1024 for line in status if line.startswith("VmHWM:"))
    return {"user_ns": int(fields[11]) * 1000000000 // clock,
            "system_ns": int(fields[12]) * 1000000000 // clock,
            "rss_bytes": int(fields[21]) * os.sysconf("SC_PAGE_SIZE"),
            "lifetime_peak_rss_bytes": peak}


def validate_work(record, workload):
    sessions, offered, byte_count = WORK[workload]
    if (record.get("workload"), record.get("sessions"), record.get("offered"),
        record.get("delivered"), record.get("delivered_bytes")) != (
            workload, sessions, offered, offered, byte_count):
        raise RuntimeError("completed workload differs: missing delivery is never a latency win")
    if not 0 < record["p50_ns"] <= record["p95_ns"] <= record["p99_ns"] <= record["wall_ns"]:
        raise RuntimeError("invalid latency distribution")


class Child:
    def __init__(self, command, environment, log):
        self.log = log.open("w")
        self.lines = queue.Queue()
        self.process = subprocess.Popen(command, env=environment, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            self.log.write(line)
            self.log.flush()
            self.lines.put(line.rstrip("\n"))
        self.lines.put(None)

    def marker(self, prefix, timeout=120):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"deadline waiting for {prefix}; inspect child log")
            try:
                line = self.lines.get(timeout=remaining)
            except queue.Empty as error:
                raise RuntimeError(f"deadline waiting for {prefix}; inspect child log") from error
            if line is None:
                raise RuntimeError(f"process exited before {prefix}; inspect child log")
            if line.startswith(prefix):
                return line[len(prefix):]

    def send(self, line):
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self.reader.join(timeout=10)
        self.log.close()


def trial(args, workload, mode, directory, edge_path=None):
    directory.mkdir()
    certificate = queue.Queue()

    class Registration(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path != "/api/edge/register" or body["edgeId"] != "profile-local":
                self.send_error(400)
                return
            if len(base64.b64decode(body["certHash"], validate=True)) != 32:
                self.send_error(400)
                return
            certificate.put(body["certHash"])
            self.send_response(204)
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Registration)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    children = []
    sampling = None
    sampling_log = None
    # The socket closes before the edge binds; occupied ports fail startup rather
    # than selecting a different target. Readiness comes from edge registration.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    url = f"https://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="merkur-edge-profile-") as identity:
        try:
            # Construct a clean environment. No installed identity, deployment
            # secret, exporter or unrelated runtime tuning enters this fixture.
            environment = {"PATH": os.environ["PATH"], "RUST_LOG": "warn",
                "MERKUR_EDGE_PORT": str(port), "MERKUR_EDGE_HOSTNAME": "localhost",
                "MERKUR_EDGE_ID": "profile-local", "MERKUR_EDGE_REGION": "local",
                "MERKUR_EDGE_PUBLIC_URL": url, "MERKUR_EDGE_IDENTITY_DIR": identity,
                "MERKUR_EDGE_REGISTER_URL": f"http://127.0.0.1:{server.server_port}/api/edge/register",
                "MERKUR_EDGE_REGISTRATION_KEY": base64.urlsafe_b64encode(os.urandom(64)).decode().rstrip("="),
                "MERKUR_EDGE_ATTACH_TICKET_KEY": base64.urlsafe_b64encode(os.urandom(64)).decode().rstrip("="),
                "MERKUR_EDGE_EGRESS_INTERFACE": "lo", "MERKUR_EDGE_DATA_BUDGET_GB": "10",
                "MERKUR_EDGE_SIGNALING_RESERVE_GB": "1"}
            edge = Child([str(edge_path or args.edge)], environment, directory / "edge.log")
            children.append(edge)
            try:
                pin = certificate.get(timeout=30)
            except queue.Empty as error:
                raise RuntimeError("edge never registered; inspect edge.log") from error
            environment.update(MERKUR_EDGE_CERT_HASH=pin, MERKUR_EDGE_URL=url,
                               EDGE_PROFILE_WORKLOAD=workload,
                               EDGE_PROFILE_SAMPLES=str(directory / "latencies.json"))
            peer = Child([str(args.peer)], environment, directory / "peer.log")
            children.append(peer)
            peer.marker("@@edge-profile-ready", timeout=60)
            kernel = None
            if mode == "aya":
                kernel = Child([str(args.aya), str(edge.process.pid), str(args.ebpf)],
                               environment, directory / "aya.log")
                children.append(kernel)
                kernel.marker("@@edge-kernel-ready", timeout=30)
            if mode == "samply":
                sampling_log = (directory / "samply.log").open("w")
                sampling = subprocess.Popen([str(args.samply), "record", "--save-only",
                    "--presymbolicate", "-o", str(directory / "samply.json"),
                    "--pid", str(edge.process.pid)], stdout=sampling_log, stderr=sampling_log)
                # samply exposes no attach-ready channel. Its startup interval is
                # diagnostic capture only; kernel samples are validated afterwards.
                time.sleep(1)
                if sampling.poll() is not None:
                    raise RuntimeError("samply attach failed; inspect samply.log")
            before = edge_resources(edge.process.pid)
            load_before = os.getloadavg()
            peer.send("go")
            record = json.loads(peer.marker("@@edge-linux-profile "))
            after = edge_resources(edge.process.pid)
            load_after = os.getloadavg()
            if peer.process.wait(timeout=10) != 0:
                raise RuntimeError("peer failed after workload")
            validate_work(record, workload)
            samples = json.loads((directory / "latencies.json").read_text())
            if len(samples) != record["delivered"] or samples != sorted(samples):
                raise RuntimeError("raw latency sample count/order does not match delivery")
            for percentile in [50, 95, 99]:
                if samples[(len(samples) * percentile + 99) // 100 - 1] != record[f"p{percentile}_ns"]:
                    raise RuntimeError("reported percentile differs from raw samples")
            record.update(mode=mode, instrumented=mode != "none", edge_pid=edge.process.pid,
                          user_ns=after["user_ns"] - before["user_ns"],
                          system_ns=after["system_ns"] - before["system_ns"],
                          initial_rss_bytes=before["rss_bytes"], final_rss_bytes=after["rss_bytes"],
                          lifetime_peak_rss_bytes=after["lifetime_peak_rss_bytes"],
                          load_before=load_before, load_after=load_after,
                          cpu_counter_resolution_ns=1000000000 // os.sysconf("SC_CLK_TCK"))
            if kernel:
                kernel.send("stop")
                capture = json.loads(kernel.marker("@@edge-kernel-profile ", timeout=30))
                if kernel.process.wait(timeout=10) != 0 or not capture["complete"]:
                    raise RuntimeError("Aya capture incomplete")
                if not capture["metrics"]["sendmsg"]["count"] + capture["metrics"]["sendmmsg"]["count"]:
                    raise RuntimeError("Aya capture contains no UDP send observations")
                (directory / "kernel.json").write_text(json.dumps(capture, indent=2) + "\n")
            if sampling:
                sampling.send_signal(signal.SIGINT)
                status = sampling.wait(timeout=30)
                if status != 0:
                    raise RuntimeError(f"samply recording failed with status {status}")
                profile = json.loads((directory / "samply.json").read_text())
                samples = sum(thread["samples"]["length"] for thread in profile["threads"]
                              if str(thread["pid"]) == str(edge.process.pid))
                if samples == 0:
                    raise RuntimeError("samply capture has zero target CPU samples")
                record["samply_samples"] = samples
            (directory / "result.json").write_text(json.dumps(record, indent=2) + "\n")
            return record
        finally:
            if sampling and sampling.poll() is None:
                sampling.send_signal(signal.SIGINT)
                try:
                    sampling.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    sampling.kill()
                    sampling.wait(timeout=10)
            if sampling_log:
                sampling_log.close()
            for child in reversed(children):
                child.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edge", type=Path, required=True)
    parser.add_argument("--peer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--build-receipt", type=Path, required=True)
    parser.add_argument("--baseline-edge", type=Path)
    parser.add_argument("--baseline-build-receipt", type=Path)
    parser.add_argument("--baseline-source", type=Path)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--workloads", nargs="+", choices=WORK, default=list(WORK))
    parser.add_argument("--capture", nargs="*", choices=["aya", "samply"], default=[])
    parser.add_argument("--diagnostic-only", action="store_true", help="skip uninstrumented runs")
    parser.add_argument("--aya", type=Path)
    parser.add_argument("--ebpf", type=Path)
    parser.add_argument("--samply", type=Path)
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("run inside Linux; macOS syscall samples cannot identify a Linux bottleneck")
    if args.repetitions < 1:
        parser.error("repetitions must be positive")
    if args.diagnostic_only and not args.capture:
        parser.error("--diagnostic-only requires a capture")
    baseline_arguments = [args.baseline_edge, args.baseline_build_receipt, args.baseline_source]
    if any(baseline_arguments) and not all(baseline_arguments):
        parser.error("comparison requires --baseline-edge, --baseline-build-receipt and --baseline-source")
    if "aya" in args.capture and (not args.aya or not args.ebpf):
        parser.error("Aya capture requires --aya and --ebpf")
    if "samply" in args.capture and not args.samply:
        parser.error("samply capture requires --samply")
    for name in ["edge", "peer", "aya", "ebpf", "samply"]:
        if getattr(args, name):
            setattr(args, name, getattr(args, name).resolve(strict=True))
    args.output = args.output.resolve()
    build = json.loads(args.build_receipt.read_text())
    if build["machine"] != platform.machine() or build["source_inputs"] != prepare.source_inputs():
        parser.error("build receipt has different source/platform; run preparation again")
    for name in ["edge", "peer", "aya", "ebpf"]:
        if getattr(args, name) and digest(getattr(args, name)) != build["binaries"][name]["sha256"]:
            parser.error(f"{name} does not match the prepared binary")
    baseline = None
    if args.baseline_edge:
        args.baseline_edge = args.baseline_edge.resolve(strict=True)
        baseline = json.loads(args.baseline_build_receipt.read_text())
        if baseline["machine"] != platform.machine() or baseline["source_inputs"] != prepare.source_inputs(args.baseline_source.resolve(strict=True)):
            parser.error("baseline receipt has different source/platform; prepare baseline again")
        if digest(args.baseline_edge) != baseline["binaries"]["edge"]["sha256"]:
            parser.error("baseline edge does not match its receipt")
    args.output.mkdir(parents=True, exist_ok=False)
    retained = args.output / "binaries"
    retained.mkdir()
    # Cargo can replace an executable in its target directory. Capture uses an
    # independent, read-only retained copy whose hash was checked after copying.
    for name in ["edge", "peer", "aya", "ebpf", "samply", "baseline_edge"]:
        original = getattr(args, name)
        if original:
            setattr(args, name, retain_binary(original, retained, digest(original)))
    provenance = {"platform": platform.platform(), "machine": platform.machine(),
                  "cpuinfo": text_or_none("/proc/cpuinfo"), "perf_event_paranoid": text_or_none("/proc/sys/kernel/perf_event_paranoid"),
                  "cpu_max": text_or_none("/sys/fs/cgroup/cpu.max"), "cpuset": text_or_none("/sys/fs/cgroup/cpuset.cpus.effective"),
                  "binary_inputs": {name: receipt(getattr(args, name)) for name in ["edge", "peer", "aya", "ebpf", "samply"] if getattr(args, name)},
                  "harness": receipt(Path(__file__)), "repetitions": args.repetitions,
                  "build_receipt": build,
                  "baseline_build_receipt": baseline,
                  "boundary": "real edge binary with current signed attach tickets and pinned certificate; native peers in a separate process; no PTY/browser rendering; loopback network",
                  "cpu_boundary": "edge-only /proc process counters surrounding go/result IPC; tick resolution; excludes warmup but includes final peer teardown",
                  "memory_boundary": "edge process RSS and kernel lifetime high-water RSS including startup; does not prove a universal memory bound",
                  "acceptance": "uninstrumented runs only; host/VM contention and platform fidelity require independent assessment; no automated io_uring adoption"}
    (args.output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    records, failures = [], []
    # Capture attempts do not replace baseline measurements or erase earlier
    # successful evidence when a profiler is unavailable on this kernel.
    for mode in ([] if args.diagnostic_only else ["none"]) + args.capture:
        repetitions = args.repetitions if mode == "none" else 1
        for repetition in range(repetitions):
            workloads = args.workloads if repetition % 2 == 0 else list(reversed(args.workloads))
            for workload in workloads:
                arms = ["baseline", "candidate", "candidate", "baseline"] if baseline and mode == "none" else ["candidate"]
                if repetition % 2 and len(arms) == 4:
                    arms = ["candidate", "baseline", "baseline", "candidate"]
                for position, arm in enumerate(arms):
                    directory = args.output / f"{mode}-{repetition}-{workload}-{position}-{arm}"
                    try:
                        edge_path = args.baseline_edge if arm == "baseline" else args.edge
                        result = trial(args, workload, mode, directory, edge_path)
                        result.update(arm=arm, repetition=repetition, position=position, edge_sha256=digest(edge_path))
                        (directory / "result.json").write_text(json.dumps(result, indent=2) + "\n")
                        records.append(result)
                        print(f"{mode}/{workload}/{arm}: {result['delivered']} delivered p95={result['p95_ns']}ns p99={result['p99_ns']}ns", flush=True)
                    except Exception as error:
                        failure = {"mode": mode, "workload": workload, "arm": arm, "error": str(error), "directory": str(directory)}
                        failures.append(failure)
                        (directory / "failure.json").write_text(json.dumps(failure, indent=2) + "\n")
                        print(f"FAIL {mode}/{workload}/{arm}: {error}", flush=True)
    comparisons = []
    if baseline:
        for workload in args.workloads:
            for metric in ["p50_ns", "p95_ns", "p99_ns", "wall_ns", "user_ns", "system_ns", "lifetime_peak_rss_bytes"]:
                samples = {arm: [run[metric] for run in records if run["arm"] == arm and run["workload"] == workload and not run["instrumented"]] for arm in ["baseline", "candidate"]}
                if len(samples["baseline"]) == len(samples["candidate"]) == args.repetitions * 2:
                    medians = {arm: statistics.median(values) for arm, values in samples.items()}
                    comparisons.append({"workload": workload, "metric": metric, "samples": samples, "medians": medians,
                                        "change_ratio": medians["candidate"] / medians["baseline"] - 1 if medians["baseline"] else None})
    (args.output / "report.json").write_text(json.dumps({"runs": records, "failures": failures, "comparisons": comparisons}, indent=2) + "\n")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
