# Linux edge profiling

The profiler measures the real `merkur-edge` binary with separately running native
daemon-role and browser-role WebTransport peers. Both peers use the production attach
ticket codec, a fresh fixture deployment key and the certificate hash published by the
edge. It never opens an installed daemon, deployed edge or user session. The HTTP
registration receiver is a local fixture; no application login, Noise session, PTY or
browser rendering is part of this measurement.

The diagnostic peer is behind the `profiling` Cargo feature. Aya lives in an independent
workspace and lockfile. Neither instrumentation nor Aya enters the shipped edge's
dependency graph. Its C tracepoint object uses standard BPF helpers and is loaded and
attached by Aya; no libbpf runtime or nightly Rust compiler is required.

## Prepare on Linux

Use the pinned Rust toolchain, Python 3.9 or later, and Clang with its BPF backend. For CPU
stack capture, install [samply](https://github.com/mstange/samply) separately. The runner
records the exact samply binary hash. Build preparation checks source hashes before and
after compiling and retains the complete receipt, including compiler versions, source
inputs, build commands and binary hashes. Changed source or mismatched binaries require
preparation again. Capture retains independently hashed, read-only executable copies;
another Cargo build cannot replace a running measurement's input. Use an isolated output
directory; no shared Cargo target is needed.

```sh
python3 scripts/prepare-edge-profile-linux.py --output /tmp/merkur-edge-profile-build
python3 scripts/profile-edge-linux_test.py
cargo test --manifest-path tools/edge-kernel-profile/Cargo.toml --locked \
  --target-dir /tmp/merkur-aya-tests
```

The pinned samply source handles absent hardware PMUs with the actual syscall error,
allowing its software CPU-clock sampler to operate on suitable Linux VMs:

```sh
CARGO_TARGET_DIR=/tmp/merkur-samply-build cargo install --locked \
  --git https://github.com/mstange/samply.git \
  --rev 247df8fe0fa259ddb5e671bfe3121728e0d6119d samply
```

The default edge build retains release optimization and adds line-table debug symbols.
It does not change frame-pointer policy, Tokio, QUIC, socket settings or packetization.

## Record

Start from the repository root on the Linux machine being investigated. The output
directory must be new. On a quiet, representative Linux host, first run the fixed
workloads without instrumentation:

```sh
python3 scripts/profile-edge-linux.py \
  --edge /tmp/merkur-edge-profile-build/edge-target/release/merkur-edge \
  --peer /tmp/merkur-edge-profile-build/edge-target/release/relay_profile \
  --build-receipt /tmp/merkur-edge-profile-build/receipt.json \
  --output /tmp/merkur-edge-baseline --repetitions 3
```

Run instrumented diagnostics separately:

```sh
python3 scripts/profile-edge-linux.py \
  --edge /tmp/merkur-edge-profile-build/edge-target/release/merkur-edge \
  --peer /tmp/merkur-edge-profile-build/edge-target/release/relay_profile \
  --build-receipt /tmp/merkur-edge-profile-build/receipt.json \
  --aya /tmp/merkur-edge-profile-build/aya-target/release/merkur-edge-kernel-profile \
  --ebpf /tmp/merkur-edge-profile-build/trace.bpf.o \
  --samply /usr/local/bin/samply --capture aya samply --diagnostic-only \
  --output /tmp/merkur-edge-captures
```

`--workloads typing concurrent burst stream` selects cases. Typing validates 10,000
57-byte datagrams. Concurrent validates eight sessions with 10,000 each. Burst validates
512 closed-loop groups of one 57-byte and 31 1,100-byte datagrams. Stream validates 1,024
64-KiB records on the production persistent reliable lane. Every payload and identity is
checked. A missing, corrupt, duplicate or reordered datagram fails the trial; there is
no received-only timing result after dropped work. Groups are an explicit offered
workload and are sent immediately; the relay never waits to fill a batch.

Samples measure source admission through validated destination receive, across both QUIC
legs. The runner independently recomputes p50/p95/p99 from retained raw samples and
reconciles exact offered/delivered counts and bytes. Edge CPU comes from that process's
`/proc` counters, with their clock-tick resolution recorded; these surrounding readings
include the go/result IPC interval and final peer teardown. RSS and the kernel's process
lifetime high-water RSS include startup. Fixed workload and bounded profiler maps make
this fixture bounded; an RSS observation alone does not prove production memory bounds.

Each result retains logs, platform/load/cgroup metadata, binary and source provenance,
raw samples and success/failure state. Capture failure leaves successful baseline runs
available and exits nonzero. Load averages do not establish a quiet host, and a quiet VM
does not establish physical-host scheduling or production network behavior.

For a code change comparison, prepare a separate baseline source tree and provide
`--baseline-edge`, `--baseline-build-receipt` and `--baseline-source` to the uninstrumented
run. The current authenticated peer drives both binaries. The runner checks each edge
against its own binary/source receipt and alternates ABBA/BAAB across repetitions. It
retains per-arm samples and reports medians and ratios for tails, elapsed time, CPU and
peak RSS. It supplies evidence, not an automatic acceptance verdict under noisy load.

## Kernel access and metric meaning

Aya requires Linux 5.7 or later, tracefs mounted at `/sys/kernel/tracing`, BPF loading permission and
perf-event attachment permission. Tracepoint field offsets and sizes come from this
kernel's event format. Layout mismatches fail rather than guessing. A disposable Docker
fixture can grant `BPF`, `PERFMON` and `SYS_ADMIN`, with `seccomp=unconfined` and
`--network none`; mount tracefs inside that fixture before recording. This permits the
fixture's diagnostic operations. It does not alter host sysctls or restart services.
Use a prepared Linux image with Python, Clang and samply; bind the worktree and retain
artifacts outside the source tree. Docker's VM is useful for capability and delivery
verification but requires separate assessment before using timings to select a design.

Aya filters to the edge process and tracks at most 4,096 thread owners, with 64
logarithmic nanosecond buckets for each metric. Map refusal or read failure invalidates
the capture. Unmatched syscall exits can occur at attachment boundaries and are reported.
Process-exit tracepoints remove thread owners. Namespace-aware PID matching keeps the
edge filter correct inside containers while scheduler event TIDs remain kernel identities.
Its metrics are:

- `sendmsg`, `recvmsg`, `sendmmsg`, `recvmmsg`, and other syscall **wall duration**, which
  includes any off-CPU blocking and is not kernel CPU attribution.
- `off_cpu`: switch-out to switch-in time, including sleep and preemption.
- `wake_to_run`: observed successful wakeup to switch-in delay for tracked edge threads.
  A preempted runnable thread may have no wakeup event; this is not all scheduling delay.

Samply captures and presymbolicates native CPU stacks for the edge PID only. The runner rejects a capture
with no target CPU samples. A virtual PMU, perf policy, unavailable kernel symbols or
unresolved native symbols can still limit attribution; inspect the capture instead of
turning a syscall-duration histogram into a CPU percentage. Keep the debug binaries when
moving the profile to another machine for further source or disassembly inspection.

## Decision gate for io_uring

An `io_uring` integration is justified only after representative, authenticated Linux
profiles identify removable UDP submission/receive overhead. Off-CPU duration,
syscall-boundary samples, macOS measurements or a virtual PMU failure alone do not meet
that condition. A transport experiment must retain immediate isolated-packet delivery,
current GSO/GRO metadata and destination addresses, exact lifecycle ownership, bounded
receive buffers and bounded work per poll. It must never wait to fill a receive or send
batch.

Compare the current transport and an isolated candidate in alternating uninstrumented
runs, on the same quiet Linux host with identical authenticated workloads and profiles.
Require equal delivered counts and bytes, valid payloads, bounded memory and improved
p95/p99 without regressing typing or mixed reliable traffic. Profilers run separately.
No transport replacement is selected automatically by this tool.
