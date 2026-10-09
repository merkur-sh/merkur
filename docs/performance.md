# Performance and Reliability Profiling

## Unified WebGPU presentation ownership

A synchronized redraw is published exactly when the viewer's grid digests to the complete
screen the daemon claimed for it, and not before, however the redraw was clipped, lost,
repaired or reordered ([complete-screen closure](display-invariants.md#complete-screen-closure)).
A matched claim submits in the current task when the GPU is idle and no early commit has spent
the frame's opportunity. The claim costs 8 header bytes per display frame and no packet; it does not establish a
universal latency or GPU-contention guarantee.

The terminal worker owns one WebGPU canvas, WASM terminal and renderer. Transport decode/apply and
selective ACK never wait for presentation or GPU completion. Received rows accumulate in a bounded,
deduplicated viewport dirty set; an eligible grid and matching header advance at a presentation
commit. Predictions, provisional touch feedback, cursor and decorations render against that
eligible base in one text pass, with no per-frame main-thread handoff or bitmap copy.

Eligible work submits in the current task when no prior GPU work remains unconfirmed. While a
prior submission is unconfirmed, continuous changes replace one pending scene until a worker
animation-frame opportunity. An urgent authoritative row (the echo of fresh input) and a released
coherent transaction are the exceptions: they submit at once, up to the two in-flight
submissions, because the render they would wait for happens anyway and only later. Progress comes from a delivered frame or a genuine fence completion
and from nothing else: an estimated-period timer would be up to a whole frame wrong and would
delay exactly the images it was meant to rescue.
One post-submit idle observation also restores opportunity admission; there is no perpetual
animation loop or RTT-derived typing delay. Coherent
redraws retain a first-apply-anchored hold whose budget is two delivered animation frames — one
whole frame interval, counted rather than estimated — unless the newest applied frame claims a
complete screen, which holds until the grid matches it. An unclaimed coherent transaction commits at a
worker animation frame: complete advisory membership makes the next frame commit, an incomplete one
commits at the second. A complete paced transaction whose newest state awaited a grant commits as
it lands instead (`paced-complete`), one paid state per frame in a sustained flood. "Delivered" means delivered *after* the hold began. A callback carrying a
frame time older than the first coherent apply describes the frame this transaction interrupted —
its vsync had already passed and only its dispatch queued behind the display pump's drain slices —
so it neither counts against the budget nor commits complete membership. Without that filter the
guaranteed interval collapses and one redraw splits across two commits. The repaint hold counts its visual bound the same way, against
the instant its anchoring mutation applied. Nothing on the wire says another chunk of a redraw is coming, and one
logical redraw arrives as two or three separately ended groups
a millisecond or two apart; the vsync is the exact opportunity that advisory membership cannot
supply, and everything applied before it folds into that one commit. This establishes a software
presentation contract; whether an earlier submission would reach an earlier physical scanout
requires a separate on-screen measurement. A transaction held
for a non-coherent reason (a header whose row predecessor has not arrived) owes no opportunity and
still commits at the applying member. A released transaction submits without a second cadence wait,
and neither a later member, an intervening local echo, an urgent local edit nor safety revocation
can reopen it or promote held received rows.

The acceptance oracle for this has two tiers, because the guarantee does. A workload that declares
its redraw with synchronized output (`DECSET 2026` BSU/ESU) is held by the daemon until ESU and
commits exactly once with zero partial exposure; `terminal-performance-matrix.e2e.ts` asserts those
exact numbers for the alternate-screen truecolor TUI redraw. An unframed burst has no
end-of-update statement on the wire, so its guarantee is at most one ordinary commit per refresh
interval: every ordinary commit must carry a distinct, increasing worker rAF release timestamp.
The timestamp and eligible-frame count survive a delayed GPU submission and are cleared when
that transaction is consumed. `releaseFrameCount` checks the at-most-two-frame hold directly;
an estimated refresh period plus GPU-completion observation uncertainty is not a wall-clock
bound for callback dispatch. First-apply-to-commit time remains a diagnostic, and the separate
end-to-end fence latency limits still apply.
Exposure is bounded by `mainThread.rafGapMs.max + fenceObservationIntervalMs`, read from that run's
own measurements, because a chunk that straddles a vsync legitimately paints one frame later.
GPU completion gaps cannot count refresh intervals: different completion delays can shorten
the observed gap between two consecutive frames. Asserting exactly one commit for an unframed
burst would assert that the sender framed an update it never framed.

The exposure term is the *observed* frame gap, not the estimated refresh period, and the two are
not interchangeable. The estimator publishes a converged period; a one-frame exposure measures one
actual interval between two consecutive animation-frame callbacks, and a single interval routinely
exceeds the mean by enough to fail an exposure budget computed from the converged period.
`mainThread.rafGapMs` is that observed interval; the main-thread and worker rAF share the
compositor's BeginFrame, so the main-thread distribution bounds the worker's.

Two exact GPU submission owners bound unconfirmed work. `onSubmittedWorkDone()` retires capacity
asynchronously; it cannot move the cursor, reconcile predictions, or claim physical visibility.
Admission also checks 16 MiB of unconfirmed upload spans and 32 MiB of retired resources before
preparing geometry, committing authority, or resizing the canvas. These are watermarks plus at most
one admitted, device-limit-validated transaction, not measurements of browser-private memory.
Standalone atlas uploads cannot accumulate past the same watermark without submission. Persistent
destination buffers remain reusable through queue ordering; completion is not needed to upload
another eligible revision while admission permits it.

Completion callbacks still gate presentation at the capacity bound. Frame cadence is not evidence
that GPU work finished: expanding the window from observed callback delay can conceal a sudden GPU
slowdown and queue stale images; widening it is not an adaptive mode.
Input, received-state application and selective ACK remain independent during this wait. There is
no fence polling, task-yield completion substitute, or WebGL fallback.

Unsent touch previews use ten fixed shared-memory slots, synchronized as a latest active set rather
than queued commands. A shared wake revision prevents parking across a preview/command publication
race. Epoch, authenticated boundary/model revision, eligible anchor and security changes invalidate
stale previews. A completion-driven visibility calibration change alone does not retract an
already admitted preview. Main still captures input and publishes synchronous admission provenance;
no transport input id is assigned to an unsent touch preview.

Main's capture projection runs in `merkur-client::input_admission`, inside the existing
authorization WASM realm. A seqlock read copies seven published model words into reusable
WASM memory, then one three-argument call decides and advances the projection. The terminal
worker owns the grid and may revoke that decision; transport does not wait for it. A model
publication can reseed capture only after its input frontier catches up. Failed command
publication invalidates the projection, and authentication resets its input namespace.
Detached memory views refresh after authorization grows the realm's memory; steady-state
admission allocates nothing. Startup readiness requires both this owner and the terminal worker.

Geometry buffers, atlas and pipelines remain resident. Dirty ranges upload directly from WASM
memory without per-frame typed-array wrappers or renderer-side full-atlas copies. A second retained
viewport grid is an explicit memory/copy cost of separating received and eligible state. Warmed
ASCII row commits and shadow replay reuse capacity; wide/combining cell payloads can still require
their normal ownership work. WebGPU command encoders, texture views, command buffers and completion
promises are browser-owned per-submission objects: the design is bounded and low-allocation, not a
claim that the browser API allocates nothing.

Terminal backgrounds, glyphs, decorations, cursors and previews use four-vertex instanced triangle
strips. Each rectangle keeps its two triangles while sharing the diagonal's vertices; the geometry
ABI, uploads, blending and submission ownership are unchanged.

Glyph masks are rasterized at the current device pixel density. Cell dimensions and the
baseline lie on whole physical pixels; nearest atlas sampling preserves the mask's existing
antialiasing. The terminal canvas uses `image-rendering: pixelated` so compositor layout
quantization does not smooth the completed image again. Image placement filtering remains
inside the graphics compositor, before this final canvas presentation.

Text colors are decoded from sRGB at the vertices. Glyph coverage stays linear and
unmodified; an `rgba8unorm-srgb` attachment decodes the actual destination, blends, and
encodes the result in hardware. The fragment shader does no coverage power or foreground
luminance approximation. Predictions use the same pipeline, including their alpha.
The underlying canvas stays `rgba8unorm` for Firefox presentation ordering. Inline images
retain encoded-color compositing through its unorm view. Resident image layers below text
share one encoded pass with cell backgrounds; images above text have their own encoded pass,
followed by a linear pass only when a cursor or preview remains to draw. These passes share
one command submission and completion identity. Image-free text needs no extra pass or texture.

Font-size and device-pixel-density changes coalesce until an admitted surface commit. A held
display transaction keeps its old raster metrics and atlas for local prediction renders.
The replacement rebuilds glyph coverage and backing dimensions together, then publishes the
grid dimensions, CSS cell metrics and baseline in one `display_state_applied` event after
submission. Main updates sizing, hit testing and the selection layer from that same tuple;
the environment notification itself never stretches the previous canvas.

The wire display/control shapes do not change in this renderer cutover; codec VERSION is unchanged.
The local WASM and SAB contracts cut over together. Unsupported WebGPU fails explicitly. The canvas is configured `rgba8unorm`, never the preferred
format: Firefox's shared-texture swap chain is `bgra8unorm`-only and pushes to the compositor without
a completion wait, so from a worker the preferred format shows a stale frame for one refresh; any
other format takes its synchronised readback presenter.
Configuring it also presents it, in the same synchronous turn: the canvas is `alphaMode: 'opaque'`,
and WebKit composites a configured surface with no submitted frame as black rather than as nothing,
while nothing else submits until the daemon's first display frame. The geometry-free present sits
immediately after `configure`, deliberately ahead of the awaited `createRenderPipelineAsync` compile
— on the far side of that await a cold shader cache would hold the surface at full black for the
length of the compile. It makes
the surface hold the terminal background from its first
composited pixel, matching what the container behind it already paints, and draws no cursor the
browser has no authority for. Chromium and Firefox both composite an unpresented surface as nothing,
so neither ever showed the flash. Device loss
rebuilds the same backend with full atlas/geometry refresh; repeated failure without a successful
completion is fatal rather than an unbounded recovery loop. Browser suspension still bounds neither
JavaScript execution nor physical scanout, and missing datagrams can require later row repair after
the advisory hold expires. This architecture does not promise arbitrary-loss whole-burst atomicity.

Merkur treats perceived terminal latency as the primary performance result. Throughput is
useful only when it keeps the interactive path free of queueing, long tasks, and memory growth.
The browser trace therefore correlates each input through transport receive, worker queue,
display apply, paint submission, and input acknowledgement.

This document defines the methodology and runnable gates. It holds no results: a claim here
names the gate that reproduces it, and measurements are recorded outside the reference docs.

## Profiling Commands

The WASM session benchmarks and their fixture tests consume a prepared native signed-session
oracle. Before running `bench:input-send-path`, `bench:input-ack` or `bench:reconnect`
directly, run this once from the repository root:

```sh
bun run scripts/prepare-client-session-oracle.ts
```

The preparer records the exact Cargo command, executable path, executable SHA-256 and a
SHA-256 digest of the checkout's Rust crate inputs, workspace manifests, lockfile, toolchain
pin and Cargo configuration in `target/rust/client-session-oracle.json`. Untracked crate
inputs are included. The executable is copied into an independent file beneath
`target/rust/client-session-oracle`, in a directory named by its binary SHA-256, with mode
0555. The manifest names that retained file, so a parallel Cargo profile build cannot
replace the fixture's executable. A matching source and binary receipt permits reuse;
changed bytes require preparation again. Fixture consumers verify that receipt before starting the
oracle and refuse missing or mismatched evidence. These session benchmarks and fixture tests
never invoke Cargo.
`gates --run` prepares the oracle once in preflight when a selected test's import closure
includes `scripts/perf/client-session-fixture.ts`, before the parallel Rust and Bun lanes.
Oracle build and validation costs remain outside benchmark timing.

| Command | Coverage | Intended use |
| --- | --- | --- |
| `bun run bench:all` | Repeated production/component/model hot-path benchmarks, including browser, TypeScript/WASM, server, and the Rust display pipeline | Fast local regression check |
| `bun run scripts/bench-user-agent.ts` | Browser/OS and OS-only parsing, with separate UA, Client Hints, and unknown-input batches | Local parser cost, with validated inputs and recorded timing samples |
| `bun run bench:display-ack:rust` | One selective display acknowledgement crediting a full 120x40 screen, with an exact per-acknowledgement allocation tally | Owner-loop cost of the ACK half of the display path |
| `bun run bench:compression-planner` | Production C-zstd sender service and achieved wire-ratio surfaces across nine frame sizes, plain and finalized-dictionary classes | Seed and regress the planner's sender-side empirical posteriors without substituting host constants into production policy |
| `bun run bench:display-pipeline:browser` | Browser-built `term-wasm` under Bun/JSC, running the production startup calibration plus raw and fused zstd-to-validator-to-apply paths over six frame sizes | Receiver incremental-cost surface, embedded calibration-fixture oracle, and proof that compressed receive has no normalized staging buffer or second parse; use browser tracing for engine-specific absolute timing |
| `bun run bench:terminal-render-readers` | The renderer's own `cursorInfo` read at 100 000 iterations a sample, measured twice: with the backwards-cursor journal off, which is production, and with it armed, which is every profiling session. The armed arm asserts it recorded nothing, so the figure is the comparison and not the recording | Cost of the per-frame cursor read, and the standing guard that the journal stays free |
| `bun run bench:webgpu-renderer` | Real-Chromium production WebGPU submit CPU and observed queue completion, plus separately counted API uploads/resources for glyph/cursor, all-pass, and unchanged-version frames | Isolated renderer API cost; not open-loop interaction or paint latency |
| `bun run bench:render-admission` | Production mailbox under independent virtual serial-GPU service and completion-observation delay; uniform offers, bursts, slowdowns, recovery, missing callbacks, and rejected larger-credit sweeps | Bounds and all-offer latency, not browser or network performance |
| `bun run bench:render-admission:browser [--burst]` | Hardware Chromium, production worker-owned WebGPU renderer/mailbox, matched ABBA arms, 0/100 ms injected callback delay, uniform or six-offer bursts, and untimed final-row pixel checks | Submission and original queue-observation latency; never physical paint |
| `GPU_EXPERIMENT_HEADED=1 bun scripts/bench-webgpu-terminal.ts` | Direct worker-owned WebGL/WebGPU canvas rendering with matched two-completion capacity and latest-state scheduling | Component comparison of submission and observed completion, not physical paint or a production cutover |
| `bun run bench:retained-wire-payload` | Real-Chromium retained display-wire payload acquisition/release at representative frame sizes and pool depths | Worker payload-pool scan, reuse, copy, and temporary-allocation cost |
| `bun run bench:display-pipeline:rust` | PTY cells through capture, diff, encode, compression, FEC, and Noise seal in the production dataplane flush workload | Daemon-side per-flush cost and allocation regression |
| `bun run bench:input-ring` | The ring-as-outbox round trip of one keystroke batch between the main thread and the transport worker | Input-ring handoff cost |
| `bun run bench:display-ack` | The Rust viewer's ACKs for a batch of frames through the viewer-output ring into the authenticated WASM `Session`, which seals them; live `bun:jsc` heap cells per ACK across both ends of the ring, net of the same frames with their outputs left unread | The browser's ACK path between its workers, and that an ACK mints no JavaScript object there; excludes worker scheduling and the daemon round trip |
| `bun run bench:reconnect -- --reps=9 --rtt=85 --outage=0` | Authenticated Rust `Session` in WASM against a signed native daemon fixture, with virtual carrier RTT/outage: closed-carrier replacement dial, rebind transmission and committed usable lineage | Core recovery ordering and authenticated post-rebind input/ACK; excludes QUIC, browser networking and OS outage detection |
| `bun run bench:relay-keystroke-packets` | A relay-pinned Chromium session typing into `cat > /dev/null` at 50 ms RTT through the local edge harness, with profiling off and on: per window (30 s idle, 30 keys at 1/s, 10 s idle, 180 keys at 6/s) the delay proxy's packet count for every relay, and with profiling on the daemon's datagrams grouped by the QUIC packet they were built into, with each input ACK's queued-to-packetized residence. Chromium's net log is on by default (`--no-netlog` is the control arm), and `scripts/analyze-quic-netlog.ts` reads it for the browser leg's per-packet frame composition. `--direct` pins the direct path instead (`FORCE_EDGE=0`): its packets never cross the delay proxy, so both browser-leg figures come from the net log, which that arm requires | Packets per keystroke on each leg and which messages share a packet; a census, not a latency gate |
| `cargo run -p merkur-edge --bin migration_probe --release` | A self-signed WebTransport server behind a NAT-emulating UDP relay, timing socket rebind (RFC 9000 path validation) against a full redial on the daemon-to-edge leg; `MIGRATION_PROBE_DELAY_MS` sets the injected one-way delay and `MIGRATION_PROBE_REPS` the sample size | What an OS network-path change costs the daemon's edge leg |
| `bun run bench:input-send-path` | One keystroke through the Rust WASM input/outbox/Noise boundary and copied output actions, counted in live `bun:jsc` heap cells; signed native delivery and ACK validation run outside capture | JavaScript objects at the WASM boundary; excludes Rust allocator requests, the SAB input ring, real transport and PTY latency |
| `bun run bench:input-ack` | Authenticated WASM `Session` input/retry/ACK against a signed native peer under six virtual carrier schedules, including held streams, a datagram blackhole and first-datagram loss | Ordered, exactly-once application admission and authenticated ACK convergence; excludes actual PTY, QUIC and rendering latency |
| `bun run profile:services` | Project verification workloads, including startup E2E, harness tests, TypeScript services, and Rust workspaces, with wall/CPU/RSS measurements | Reliability and service-cost check |
| `bun run profile:full` | Hot paths, Rust Criterion benches, and every service verification | Release or architectural-change gate |
| `bun run profile:soak` | Twenty full-size benchmark repetitions (including every Rust Criterion workload), three repetitions of ordinary verification workloads, and one terminal-startup E2E repetition | Variance, leak, and stability investigation |
| `bun run scripts/run-session-issuance-benchmark.ts` | Real session issuance state transitions through disposable Dragonfly, with exact command counts | Redis round-trip and durable-state regression check |
| `bun run scripts/run-auth-continue-rate-limit-benchmark.ts` | Ordered two-key auth IP/identity rate-limit microbenchmark through disposable Dragonfly | Multi-key rate-limit latency, command count, and denial-semantics check |
| `bun run scripts/run-session-start-benchmark.ts` | Registered local-owner control dispatch through accepted `command_ack`, p50/p95/p99 | Control-plane dispatch latency, optionally compared with a retained baseline artifact |
| `bun run scripts/bench-session-crypto-startup.ts` | Shipped E2E Wasm initialization plus an authenticated ML-KEM-1024/Noise bootstrap, both daemon signatures, and hybrid secondary-secret derivation | Keep post-quantum session setup outside the perceived-latency budget and frame hot path |
| `bun run test:e2e:transport` | Chromium, edge, server, daemon WSS control client, dataplane, and PTY | Real clean-path felt latency |
| `bun run test:e2e:latency` | Two-worker SAB handoff, prediction, authoritative apply, GPU fence, and input ACK through the real clean transport tree | Fast exact felt-latency gate |
| `bun run test:e2e:latency:impaired` | The same exact latency trace under the calibrated 120 ms profile with 3% loss and moderate reordering | Fast recovery/tail-latency gate |
| `bun run test:e2e:transport:impaired` | The real transport tree under the calibrated 120 ms profile with 3% loss and moderate reordering | Recovery and tail-latency behavior |
| `bun run test:e2e:transport:reorder` | 40 fresh cold WebTransport dials under the calibrated 120 ms profile while the named `handshake-split` scenario releases a coalesced server flight's suffix ahead of the crypto prefix that decrypts it | Regression gate for a deadlocked fresh-connection handshake. Whole-datagram loss and reordering provably cannot produce this split |
| `bun run bench:terminal-network-matrix` | Resumable 80-cell real Chromium/edge/daemon plan: the 28 workload and 12 recovery profiles each run under two distinct deterministic seeds across 50/120/200 ms application RTT, bounded centered jitter, 0/1/3/9% exact-rate loss where requested, profile-appropriate reordering, short burst loss, and temporary congestion | Final presentation-coherence, latency-tail, recovery, and queue-stability evidence; atomic checkpoint plus per-cell raw artifacts |

`bench:reconnect` reports when a replacement carrier is first dialled, when its rebind
request is transmitted, and when an authenticated successor lineage is Ready. Its
`closed-carrier` scenario supplies an explicit signaling-carrier close; `closed-carriers`
also closes both incumbent data carriers and counts every replacement dial. Both delay fixture
traffic by the selected virtual RTT and outage. The completion check sends retained input and requires
an authenticated ACK. It does not measure silence detection, actual network migration or
browser reconnection latency; those require the transport and rebind E2E suites.

### Terminal network matrix

The profile names describe the complete browser→daemon→browser application round trip, not
one proxy hop:

| Profile | Target RTT | Delay on each of four legs | One-way jitter span | Reorder arm |
| --- | ---: | ---: | ---: | --- |
| `fast` | 50 ms | 12.5 ms | 0–5 ms peak-to-peak | none and light (1%) |
| `typical` | 120 ms | 30 ms | 0–15 ms peak-to-peak | none and moderate (5%) |
| `difficult` | 200 ms | 50 ms | 0–30 ms peak-to-peak | none and moderate (5%) |

Each proxy leg receives an independent, seed-derived sample centered on its base delay. The radius
is 1.25, 3.75, or 7.5 ms per leg, so the sum of the two legs in one direction has the advertised
5, 15, or 30 ms peak-to-peak span without silently raising median RTT. Delay and jitter apply in
both directions. Loss, reordering, burst loss, and congestion apply only on each proxy's
edge-to-client egress. A logical browser↔daemon direction therefore crosses exactly one destructive
fault site; applying 9% independently on both proxy legs would have manufactured 17.19% effective
loss.

Proxy statistics schema 9 separates the controller-selected delay from the observed monotonic
userspace residence. For every released UDP unit it records enqueue-to-deadline target, actual
enqueue-to-release residence immediately before the socket send, and scheduler overshoot
distributions; an early release, missing release sample, or profile/overshoot bound violation makes
the cell incomplete. These measurements deliberately exclude socket, kernel, edge, QUIC, and
browser transit. The synchronous daemon sample independently sanity-checks the authenticated
heartbeat RTT against the complete four-leg 50/120/200 ms profile, so a bypassed emulator cannot
pass on configuration labels alone. Schema 9 also lists every live relay with its pending packets,
its ledger since the current trace mark, and the most packets each of its two delay lines held at
once since that mark; its settle status sums every relay's ledger since that mark, including a
relay that has detached since.

The steady loss selector is a seeded permutation of each 100-packet window of one relay's
downstream packets, so every complete window contains exactly 0, 1, 3, or 9 selected packets
without the unrealistic every-Nth pattern that can never drop adjacent packets. Windows are per
relay and a trace mark abandons a relay's partial window, so the proxy totals its completed windows
and their drops; a cell requires the drops to equal the configured percent times the windows.
`burst-loss` adds four adjacent losses in each 400-packet cycle. `congestion` serializes a
48-packet interval in each 256-packet cycle at 1 ms per packet through one shared downstream queue,
with 32 ms as the hard additional queue-delay ceiling. These delay scenarios alone declare no
capacity bottleneck. Their delay line never drops for capacity: each relay direction is an
unbounded channel, and a downstream reorder heap takes in every waiting arrival before each release. A relay's 65,535-packet
lease is the only bound. An exhausted lease, an oversized datagram, and an admission-handoff drop
are counted as harness drops, separately from intentional impairment, and any of them fails the
run.

`EDGE_NETWORK_BOTTLENECK` adds an independently shaped link. Browser and daemon sockets use
role-owned listeners, and all connections belonging to one role share that role's link. Thus
an image connection and its interactive sibling compete for the same capacity. Link bytes
include the UDP payload plus 48 bytes of wire overhead. Uplink shaping precedes propagation;
downlink shaping follows propagation and precedes destructive loss, so a subsequently lost
packet still spends link capacity.

| Bottleneck | Shared link | Rate | Queue bytes |
| --- | --- | --- | --- |
| `uplink-bloat` | Daemon upstream | 10 Mbit/s | 256 KiB |
| `downlink-bloat` | Browser downstream | 25 Mbit/s | 640,000 |
| `downlink-shallow` | Browser downstream | 25 Mbit/s | 0.25 BDP |
| `downlink-step` | Browser downstream | 25 → 5 Mbit/s, two seconds after a trace mark | 640,000 |
| `downlink-fq` | Browser downstream, per-relay fair queueing | 50 Mbit/s | 625,000 |
| `downlink-bdp`, `downlink-half`, `downlink-deep` | Browser downstream | 25 Mbit/s | 1, 0.5, 4 BDP respectively |
| `downlink-fast-bdp` | Browser downstream | 100 Mbit/s | 1 BDP |

Here BDP uses the profile's complete application RTT, not one proxy leg. Schema 9 records
link departures, intentional bottleneck drops, busy time, rate changes, bytes ahead at
enqueue, residence and release-overshoot histograms. A shaped-link run is invalid if release
overshoot p99 reaches one packet's serialization time at its lowest configured rate. Those
bottleneck drops are distinct from harness failures. The optional
`EDGE_NETWORK_COMPETITOR=daemon|browser` attaches the CUBIC bulk competitor to the same role's
link. FIFO and fair queues do not emulate radio scheduling, AQM or ECN; native packet-level
tests exercise ECN separately.

The graphics paired workload uses `GRAPHICS_TYPING_BYTES=256KiB|2MiB|16MiB`, retains every
valid matched sample and records voided carrier transitions separately. A bottleneck run's
successful exit establishes measurement validity, not acceptable typing cost: its paired
tails, link residence and transfer goodput must be compared against the declared experiment
criteria and the same build without shaping. The report records the verdict.

The 56 workload cells (28 profiles under two seeds) run terminal editing, cursor movement,
history/completion, geometry/reflow,
rapid and large input, sparse distant-row updates, burst/cat-style output, a full-screen
alternate-screen truecolor repaint, sustained output, and exact input/display/GPU-fence latency.
The 24 recovery cells (12 profiles under two seeds) run carrier rebind/incremental repair and a
forced real-protocol resync under
clean, loss+reorder, burst+reorder, and congestion+loss+reorder conditions at every RTT. The resync
fixture primes more than one complete impairment cycle after resetting proxy statistics, then
requires the normal authenticated snapshot request, application, one authoritative presentation,
and GPU fence. The rebind fixture accepts only a target-satisfied repair release; a deadline expiry
cannot pass as recovery.

The two-seed default is 80 independent Playwright launches. Based on the prior 40-cell host runtime,
budget roughly 14–20 hours for a fresh run; the atomic per-cell checkpoint is therefore part of the
measurement contract, not merely crash diagnostics.

The runner writes a temporary file and atomically renames it after every cell. A compatible
checkpoint resumes only when its exact cell ids, per-phase Playwright arguments, and complete
source/build-input fingerprint match. Each run keeps proxy counters, application display outcomes,
percentile completeness, the terminal latency summary, compressed raw events, and synchronous Rust
transport samples. A raw trace is mandatory: the runner decompresses and parses it, checks its exact
event count, rebuilds the unbounded latency report, and compares every aggregate and completeness bit
(excluding only the summary's intentionally bounded sample list) plus the application display
outcome. The artifact records SHA-256 hashes for the compressed trace, replayed report, and replayed
display outcome. After every Playwright test
body and before its page closes the live carrier, the fixture sends `SIGUSR2`; the daemon asks the
Rust owner loop to close its current positive partial window, waits until that exact sample reaches
the serialized metric worker, and logs the bounded aggregate. Capturing before page teardown is
required because per-peer interval cursors leave with the peer. Matrix evidence is incomplete unless
the final sample observation brackets that request, has a live browser peer, is adjacent to run end,
and both the latest and aggregate samples report zero telemetry drops. A percentile whose source reports
`complete: false` remains incomplete in the matrix artifact and must not be quoted as a benchmark
result.

Each replay-verified trace also retains every non-null per-input analyzer value. The matrix computes
nearest-rank median, p95, p99, and worst directly from those raw observations, with one observation
as one weight. Exact loss/reorder/scenario rollups remain separate; the convenience per-profile
table contains only the clean steady workload cells. It never computes a percentile of per-test
percentiles, and every table records its expected/accepted run count, trace count, raw event count,
and completeness.

Matrix schema 9 also records `headlineEvidenceErrors`. A completed set of commands
does not make the final report complete: each selected RTT needs two independent
clean steady seeds, complete raw replay, and at least 100 observations with non-null
median, p95, p99, and worst for the declared isolated-typing and coherent-redraw
metrics. Speculative typing is required at 120 and 200 ms, where its visibility gate
admits the isolated workload. The coherent redraw headline combines only explicit
redraw windows; typing and separately classified sustained streaming cannot dilute it.
It is explicitly a **canonical workload-mix distribution**, not a homogeneous workload:
per seed it includes 20 dense redraws, 20 wide redraws, 20 bounded cat-output redraws,
20 alternate-screen redraws, and one sparse edge sweep. The two-seed mix has 162
windows; its p99 describes that weighting, not the p99 of each workload. Individual
repeated redraw workloads currently contribute 40 windows across the two seeds, so
their p99 remains unavailable even when the mixture has enough observations.
Filtered diagnostic runs can execute successfully while remaining incomplete for
this final-report gate.

Browser receipt/decode/apply and presentation-stage distributions use those explicit
windows when present. Setup commands and cleanup remain in the raw trace for causal
validation but do not contribute stage samples. `presentation.renderSubmissionMs`
counts one exact renderer submission per authoritative commit, rather than weighting
that CPU work once for every input the same frame confirms. Input and daemon timing
reports retain their documented causal-input or display-operation populations.

The matrix injects browser keyboard events. The `input_queued` event's `atMs` timestamp
is normalized DOM event time, not a hardware interrupt. Likewise,
the authoritative endpoint is browser-observed WebGPU queue completion: it proves preceding
GPU commands completed, not when the fence physically signaled or when the compositor
displayed those pixels. Report these as browser-input-to-observed-sync-readiness measurements
and retain the final polling interval alongside them. The speculative canvas metric is a draw issue; neither
metric can establish physical input-to-photon latency without external capture.

List the exact workload identities and their effective repetition/warm-up counts without running
them:

```bash
bun run scripts/profile-project.ts --mode=full --list
```

The profiler writes a versioned JSON report to `test-results/profile/latest.json`. Each workload
records the exact command, fidelity, warm-up and repetition counts, process wall and CPU time,
maximum RSS, captured output, and structured internal metrics. Summaries use nearest-rank
p50/p90/p95/p99, standard deviation, coefficient of variation, and median absolute deviation.
Reports also pin the OS/kernel version, architecture, CPU model/count, memory size, Bun version,
Rust compiler/host, Cargo, LLVM, Git revision, and dirty-worktree state.
Commands have explicit timeouts and bounded output capture so a wedged or noisy service cannot
wedge the harness. Output draining has a separate post-exit deadline, covering escaped descendants
that retain inherited pipes after the measured command exits. Inherited `BENCH_*` and
compiler-tuning variables are removed before each
workload; only the explicit, non-secret overrides recorded in the workload can affect benchmark
size. A failed command, metric parser, or profiler capture is retained as a failed workload while
the remaining project workloads continue. The partial report is still written.

The session-start benchmark measures control-plane dispatch. It starts immediately before
`DaemonControlService.startSession` and stops only after an exact accepted `command_ack`. It uses
real fenced presence reads in a disposable Dragonfly instance and a registered, bounded local
control-socket adapter. This isolates owning-replica dispatch and acknowledgement overhead; it
does not include HTTP/session issuance, a kernel/TLS WebSocket hop, cross-replica Redis pub/sub, or
the Rust queue's own admission work. Those paths remain integration gates. The release gate is no
meaningful regression at p50, p95, or p99 against a same-machine baseline artifact, the single-line
`server-session-start-ack` JSON line the benchmark prints:

```bash
bun run scripts/run-session-start-benchmark.ts \
  --baseline-artifact=test-results/profile/session-start-baseline.jsonl \
  --regression-percent=5
```

The artifact parser requires the exact
`server-session-start-dispatch-to-delivery-confirmation` measurement boundary, environment, and
sample configuration, so a result from a different boundary cannot be mislabeled as a control-plane
comparison. Artifacts also identify their confirmation semantics and harness topology, and the
runner reports a delta between differing topologies as non-like-for-like.

Use a stable machine with release artifacts already built. Close high-CPU applications, keep
power and thermal conditions consistent. The project profiler comparison below is for repeated
measurements of the same workload definition (for example, subsequent WSS releases); use the
explicit session-start artifact comparison above across the control-plane protocol cut:

```bash
bun run scripts/profile-project.ts \
  --mode=full \
  --output=test-results/profile/baseline.json

bun run scripts/profile-project.ts \
  --mode=full \
  --baseline=test-results/profile/baseline.json \
  --regression-percent=5 \
  --strict-variance \
  --variance-percent=10 \
  --output=test-results/profile/candidate.json
```

Use repeatable exact `--workload=service/name` selectors to isolate an A/B run without executing
unrelated workloads. Selectors are validated against the chosen mode, and the report contains only
the selected workload set, so capture the baseline and candidate with the same selectors:

```bash
bun run scripts/profile-project.ts \
  --mode=full \
  --workload=web/browser-display-production-pipeline \
  --repetitions=20 \
  --output=test-results/profile/display-baseline.json
```

Display compression splits the row body in one pass through the compressor's retained
`RowSplitter`, then writes the zstd frame directly after the header in the caller's pooled
output vector, using zstd's `WriteBuf` cursor support. There is no compressed-payload staging copy or separate
128 KiB staging allocation per compressor. Output vectors reserve compression headroom, with
the requested capacity capped at the maximum wire frame; ordinary vector growth can retain more.
This trades larger individual output capacities for eliminating the intermediate buffer/copy,
not a claim of lower whole-process RSS. Warm reuse, byte-exact plain/dictionary output, and
rejected-candidate clearing are covered by `display::compressor::tests`. Their allocation tally
counts Rust allocator requests, not C-zstd's internal allocations. `pty::buffer_pool_tests` also
requires the full requested capacity before a reused frame is filled. Paired measurements bound
the speed claim; it is component evidence, not an end-to-end result.

The display compression/row-encoding and daemon updater profiles have focused workload
selectors. Run the two updater modes together: separate processes are required for meaningful
maximum-RSS comparison. The zstd browser workloads execute the real `term-wasm` decoder, while the
dataplane workloads execute the production C zstd context and row codec:

```bash
bun run scripts/profile-project.ts --mode=full \
  --workload=dataplane/display-compression-planner-surface \
  --workload=dataplane/display-single-pass-row-encoding \
  --workload=web/browser-display-production-pipeline \
  --workload=web/browser-display-zstd-one-row \
  --workload=daemon/update-download-memory \
  --workload=daemon/update-download-stream \
  --output=test-results/profile/display-update-investigation.json
```

A comparison covers structured workload metrics plus process wall time, CPU time, and maximum
RSS. It fails when a lower-is-better value rises beyond the allowed ratio or a
higher-is-better value falls beyond it. `--strict-variance` also fails metrics whose coefficient
of variation exceeds the selected limit, including process wall, CPU, and RSS signals. Keep the
baseline file as a CI artifact. The comparator rejects failed or internally inconsistent
baselines, recomputes every summary from raw runs, and requires exact workload and metric sets.
Mode, environment policy, Bun, OS/kernel, architecture, CPU identity/count, memory, Rust, Cargo,
LLVM, command, explicit environment overrides, warm-up/repetition/timeout settings, fidelity, and
metric sample sizes must match. The harness resolves symlink and hard-link identity before work,
then commits the candidate report with an atomic same-directory rename so a crash cannot leave a
half-written JSON file or overwrite the baseline through an alias.
Cargo's native build outputs may share an inode with its deps directory. Retained artifact
copies must be singly linked; installing them atomically replaces the Cargo directory entry
without changing its other links. Source, toolchain and executable hashes are still verified.

The WebGPU render benchmark bundles the production renderer in memory and uses real Chromium.
Normal benchmark runs require hardware. The source correctness test explicitly selects
`BENCH_GPU=swiftshader`, verifies that adapter identity, and exercises the same pixel and
API-count assertions on CPU-only CI runners; those timings are not hardware measurements.
It separates synchronous submission from exact asynchronous queue completion. Fixed scenarios
exercise dirty uploads, retained buffers and full replacement; final untimed RGBA checks verify
background, glyph, decoration and all cursor shapes. Fake-device tests separately pin upload
ranges, two-owner capacity, out-of-order retirement and device recovery. These component checks
are not network, compositor, or physical input-to-photon measurements.

The terminal render-reader benchmark instantiates the production terminal Wasm adapter and measures
the cursor snapshot reader used by every ordinary frame. Besides timing, it reports whether the
adapter reuses the typed-array view, making the eliminated wrapper allocation a deterministic
oracle. WebAssembly compilation, font loading, and terminal creation remain outside the measured
loops.

`bun run bench:client-viewer-boundary` measures the shared Rust viewer's reusable-memory
receive boundary against the terminal's staged validate/apply/release boundary in Bun/JSC.
Both arms receive identical frames with increasing sequences, alternate measurement order,
and check row hashes, row sequences and presented text after every sample. The viewer arm
includes lineage and FEC admission; the terminal arm excludes the browser's TypeScript
receive logic. Presentation and ACK serialization run outside the timed interval. This
component comparison does not establish end-to-end browser performance or a copy reduction.

The terminal multi-chunk benchmark drives the production Wasm validate/apply boundary for raw
direct, raw staged, and compressed staged logical frames. It reports all three as independent
controls with the same deterministic terminal-state checksum. This catches accidental duplicate
decoding in an all-chunks validation barrier without confusing it with ring or renderer time.

Outer process wall, CPU, and RSS are gated by default. Static artifact inspections may declare
those measurements diagnostic: their emitted size/budget metrics remain gated, while incidental
compression-tool runtime does not masquerade as startup latency. The immutable font-asset check is
therefore sampled once with no warm-up instead of recompressing the same files six times.

The dirty-grid capture pool and the cache-miss scratch pool each retain at most two immutable
storage versions per visible row, bounded by the viewport. Both fill a uniquely owned `Arc` directly. A row held
by preparation, transport, ACK provenance, or a weak observer is never overwritten: the pool
drops its oldest retained handle and allocates a new version if both are busy. Released versions
are reused, and dimension changes retire incompatible storage. This removes the warm row-buffer
allocation and scratch-to-snapshot copy without changing baseline identity checks.

Display preparation retains frame buffers for the maximum viewport burst: at most one
record per row and one parity buffer per group of at least two records. The pool therefore
has 384 slots for the 256-row limit, with payload capacity allocated only as exercised.
Each retained prepare-buffer set pays 9,216 bytes of vector-slot metadata on a 64-bit target,
plus its exercised payload capacities; the existing bound on spare sets still applies.
This reduces allocation churn at the cost of higher retained storage.

The capture census also retains the selected color and hyperlink-table modes in
two bytes per row. Prepared encoding writes that representation directly, with
separate constant-mode loops for indexed and literal RGB. It never writes a larger
discarded indexed form into a buffer reserved for the final literal size. This is
necessary when measured sender costs switch a recycled compressed-output buffer
to raw output. The generic codec API still performs its own census while encoding;
the wire bytes are identical. A deterministic transition regression test and paired
measurements cover it.

## Scheduling Contract

Local state transitions wake their consumer directly. A connection close, queue admission change,
edge attach/detach, IPC close, or GPU-poll task must not wait for a periodic sweep before useful
work can resume. The current wake paths use owned channels, watch generations, stream completion,
visibility/network events, `Atomics.waitAsync`, and one-shot task continuations. Cancel-and-replace
work carries an identity or generation; a cancelled task may finish, but it cannot clear a
replacement's handle, repeat an ambiguous mutation, or publish stale state.

On a visible environment signal, the terminal worker replaces retained render and presentation
animation-frame arms. WebKit clears native worker callbacks during suspension without notifying
their JavaScript owners; retaining only the ownership flag would prevent either callback from
being scheduled again. This recovery uses the explicit visibility signal, including one whose
hidden predecessor was coalesced, and adds no steady-state timer or frame loop.

Font installation must not compile outlines for every character in a bundled Nerd Font.
`packages/fontdue-patch` retains validated immutable font bytes and compiles a glyph's outline
on its first metrics/rasterization request. The outline is cached across atlas rebuilds and
sizes; existing geometry generation and rasterization remain unchanged. Full regular and style
promotion can therefore run after first paint without blocking the display worker for hundreds
of milliseconds. Reference metrics and bitmap tests cover all bundled faces, multiple sizes,
non-Latin text, box drawing and icons. The patch and terminal WASM must build together; source
provenance follows the Cargo dependency closure, including the local fontdue patch.

A matched authenticated repair verdict also confirms an unchanged retained grid. The terminal
worker nominates that grid for the current session's first GPU fence and schedules a render,
including when the repair has zero rows. It reports `display_resume` readiness without inventing
an applied display frame. A stale generation or repair identifier cannot earn readiness; the
usual GPU completion ownership still fences session changes and renderer replacement.

Incremental display repair anchors presentation suppression to the first visual application,
even before its reliable membership marker arrives. Exact row versions permit early release;
otherwise the bound is the same two delivered animation frames the presentation coordinator counts.
Before a visual application it suppresses no new pixels, so data-attachment setup does not spend
its frame budget. The resume-response watchdog starts on actual control admission, not enqueue;
a lost request is handled by transport recovery, not a premature presentation timeout. Only
snapshot-owned suppression retains its RTT-scaled hard deadline; an early fractional timer wake
retains a wake for that same deadline. Newly advancing input ACKs also cancel heartbeat
escalation immediately, including partial progress after the first timeout; duplicate partial
ACKs cannot discharge a newly armed deadline. Neither policy adds a steady-state typing timer.

Distributed state follows the same rule. Daemon presence writes one fenced deadline into Redis;
all server instances subscribe to the deadline-change channel and run an exact earliest-deadline
scheduler. Atomic Lua transitions make lease renewal, explicit disconnect, silent expiry,
and competing-instance expiry exactly once. Session commands are ephemeral and carry unique
`commandId` values. A non-owning replica reads the current presence and publishes to the owning
replica; that replica verifies `presenceId` and `claimSeq`, admits the command to its bounded WSS
queue, and waits for the daemon to acknowledge dataplane admission before returning a result.
Commands are never replayed after reconnect. Lost publication, stale presence, backpressure,
rejection, and unknown delivery all fail closed after a bounded timeout. If Redis pub/sub loses
the wake for a durable presence deadline, an empty-index-only reconciliation watchdog observes it
within one second; a refresh that repairs a missing deadline publishes a wake itself. There is no
steady-state presence scan while the deadline index is non-empty.

The shared Rust session owns Noise sealing and per-writer reliable admission state. Browser
and native adapters retain a pending record on its exact carrier/channel and report actual writer
readiness; datagram retries and other writers remain independent. While PTY's writer is blocked,
the core retains its unsent reliable input suffix and continues cumulative input datagrams.
Unblocking releases that suffix once; retirement drops pending carrier-owned writes. Replay
windows and input sequence authority handle legitimate cross-provider arrival order.
Edge `session_auth` is exact-shape checked, matched to the authenticated control offer, checked
against the server capability and user-root daemon binding, authorized by the root-signed browser
certificate and its per-session ML-DSA proof, checked against revocation and the identity/bootstrap
commitments, and replay claimed before ML-KEM work and authenticated provider publication. Each
signaling reconnect creates a fresh server issuance, session, nonce, one-use ML-KEM bootstrap,
delegate proof, and Noise state; recoverable close preserves only daemon-matched display/session
state, and terminal close discards it.

Initial terminal startup overlaps independent work: transport begins before the next visual frame,
cached edge dialing overlaps crypto Wasm initialization, and delegation loading overlaps both
initialization and session issuance. Authentication still gates terminal traffic; direct discovery
runs after edge establishment. Page-owned admission prevents failed direct probes from being
repeated across sessions: Chromium shares its handshake throttle with later relay connections,
so background discovery can otherwise delay the next startup. A first visit without cached edge
coordinates still waits for issuance before dialing. These are removed serial dependencies, not
a fixed millisecond saving; compare complete browser startup traces to measure the result.

The startup browser gate also types on the first animation frame that observes the connected
state, before priming or waiting for direct upgrade, and requires the first input to reach an
authoritative GPU completion. Its artifact includes `firstInputGpuMs` for every attempt.
A snapshot alone is insufficient evidence of usability: the interactive relay delivery gate
accepts the current data-handshake ACK as well as the concurrent FIN proof, so a failed
transport probe cannot strand input and resize behind an already visible screen.

The session-crypto startup benchmark reports Wasm module initialization separately from one cold
and repeated steady bootstrap. The timed bootstrap includes ML-KEM-1024 browser key generation,
daemon encapsulation, canonical request/response transcripts, a fixed 64-byte browser-delegation
authorization digest in the daemon response/KDF transcript, hedged ML-DSA-87 and canonical P-256
daemon signatures over the exact responder Noise message 2, both signature verifications before
implicit-rejection decapsulation, the complete Noise handshake, and HKDF-SHA-512 bootstrap and
hybrid secondary-secret derivation. It does not time OPAQUE, user-root/delegate signature creation or
verification, server capability issuance, the production daemon boundary, transport dialing,
or network service, so it is a cryptographic-boundary regression gate rather than an end-to-end
session-start claim.

Display recovery is state-derived rather than retry-driven, and there is no NACK. Any row whose
current content the peer has not exactly acknowledged is re-selected by the next flush, so recovery
needs no signal from the browser and converges even when one is lost; identical content is merely
rate-limited to one re-send per round trip. If both the send record and per-row provenance have
already been pruned, the daemon immediately arms a reliable authoritative snapshot; it does not
tighten AIMD pacing because a stale record is not fresh wire-loss evidence. Every chunk of a
peer's snapshot carries the same latest processed input sequence, so a chunked recovery has one
causal high-water mark and cannot strand input behind an otherwise complete grid.

Prediction separates model safety from visibility, and visibility is an *admission* decision, not
a continuous one. The gate's inputs — a smoothed rtt, measured local queue-readiness observation latency, a trust
window — move constantly, and an outstanding prediction is exactly the state in which the
predicted and authoritative cursors differ, so consulting them at render time stepped the cursor
sideways every time one of them moved. The decision is therefore latched once per speculative
line, on the shared admission-model read and carried to the model on the prediction command
itself. Provisional touch feedback uses the same admission revision and the worker's eligible base. A line begins visible or it does not; the gate gets its
next say the moment the line has nothing outstanding — where authority draws the row and the cursor
already sits at the authoritative column, so re-taking the decision moves no pixel — and otherwise
when the line is flushed, which every non-predictable key already does. Nothing already
presented is retracted except by contradiction, by the prediction lifetime, or by an unsafe-mode
revocation. The worker clears provisional geometry at those same boundaries. Admission visibility
is latched, so a later confidence change cannot erase already admitted feedback. There is only one
terminal painter: text, cursor and local overlays are part of the same WebGPU pass. Coverage in particular is not contradiction: the authenticated input watermark
advances at PTY *write* completion and a stale advertisement is by itself a reason for the daemon
to flush, so a header-only frame carrying no cell authority for an edit routinely overtakes the
slave's echo. Output arrivals do not retract an admitted speculative line or impose a quiet-time
cooldown; the next admission uses trust and safety. An input the model does not project — Enter,
Tab, a paste, a key it refused — seals the line rather than flushing it (`ShadowLine::sealed`):
nothing typed behind it is modelled, and every painted glyph waits for its echo, with the cursor
no longer expected at the projection because the sealing input may have moved it. Flushing on the
key put the row's previous contents back on screen for one round trip on every line submitted
faster than the path; the
oracles are `a_line_submitted_inside_its_round_trip_never_steps_the_cursor_backwards` in
`display::cursor_lab` and the submission spec in `terminal-cursor-motion.e2e.ts`. A snapshot replaces
the speculative lineage and flushes the bounded shadow even when its geometry is unchanged; sparse deltas reconcile only
the exact cells and header state they authoritatively cover. WASM records a local authority
revision only for cells actually covered by an applied frame, so a sparse repair's global cursor
cannot contradict a prediction on an unrelated row. An exact-cell contradiction discards the
tainted epoch and rebases the predicted cursor to applied authority. Queued and new actions then
model from that fresh base while the confirmation gate keeps them hidden. The default mismatch
cooldown is zero: authoritative confirmation is the recovery event, with no retry delay or
continuously extended input barrier. A render frame carries the eligible scene's authoritative input high-water mark. A local-only
submission while received rows are held retains that committed mark, rather than falsely claiming
that newly received authority was drawn.
Predicted spaces still advance the speculative cursor model, but do not claim visible geometry or
a prediction-paint latency sample. The reporter independently rejects any regressing render
provenance and marks that stage incomplete instead of fabricating a tail sample.

Visibility is trust and causal safety only: a bounded window of confirmations and an
authoritative, mode-safe base. There is no measured threshold: a gate that compares a smoothed path
RTT against an estimated local paint latency has two estimates and no hysteresis, and one stalled
fence flips it between visible and learning for the rest of the line. There is no threshold tracker,
hidden calibration render, or idle/atlas exclusion; the render a fast path cannot use costs one
worker frame and paints the glyph the echo paints.

What survives of that tracker is `presented-prediction-sources.ts`: WASM always publishes bounded
visible-input membership, independently of profiling; the worker copies that borrowed view at
submission, and a clear counts as visibly predictive only if its source was in the newest
completion-observed submission. A source in an older, still-unconfirmed submission does not
establish visible clear-effect evidence, and truncated membership records nothing rather than an
under-count. Ownership is bounded by the renderer's `MAX_IN_FLIGHT_RENDER_FRAMES`; full ownership
refuses a new frame rather than overwriting an unresolved one; an out-of-order callback retires
only its exact token, and older completions cannot roll the newest observed prediction-source set
backward. Semantic invalidation does not free physical GPU credits, and a retired metadata slot
remains borrowed until its callback explicitly releases it. Raw input and exact render-membership
telemetry remain the sole end-to-end speculative-latency reporting path.

What none of that could see is the eligible/predicted base cursor. It is predicted while the
shadow is visible and uses eligible authority otherwise, so it is a function of both ends: the
daemon's frame oracles describe the sender, the viewer's row-hash convergence describes the grid,
and a cursor drawn in the wrong column shows up in neither, because the two grids agree throughout.
`display::cursor_lab` is the base-cursor state oracle. It runs the production `TerminalState`, `flush_display`,
sealed frames and the real `term_wasm::Terminal`, transcribes the terminal worker's control loop,
scripts a shell's echo down to the chunks it writes it in, explicitly commits each applied batch,
and reads `cursor_info_ptr` after every event. term-wasm journals sampled backwards steps against the site
that caused it (`cursor_motion_ptr`, armed with `perfEnabled` and surfaced as the
`cursor_stepped_backwards` display diagnostic), and every authoritative cursor shape or visibility
change against the header that carried it (cause `AuthorityShape`, surfaced as
`cursor_shape_changed`), so a cursor that hid or turned into a beam for one frame is attributable
even though it never moved. The journal excludes the worker's separate UNSENT provisional cursor
geometry, which has no input-sequence membership. `tests/e2e/terminal-cursor-motion.e2e.ts` reads
both in a real browser against the daemon's own shell, fish under tmux, and Neovim under tmux; its
`tui-redraw-census` fixture joins the browser's commits to the daemon's native trace per keystroke,
which is what says whether a cursor move painted more images than the PTY reads it arrived in (the
Neovim spec needs `MERKUR_E2E_FINAL_TRANSPORT_CAPTURE=1` for that trace and skips without it). Neither this state oracle nor
the journal measures GPU completion, compositor presentation, or physical pixels.

History traversal and completion deliberately remain authority-only. Authenticated display frames
carry a daemon-issued prediction-safe mode bit (`DISPLAY_MODE_PREDICTION_SAFE`), but that bit is a conservative
heuristic inferred from shell/editor control-sequence hints plus point-in-time termios and
foreground-process-group checks. Those hints are not authenticated editor semantics and do not
identify the editor or reveal shell history policy, pre-session or concurrent history, working
directory, remote filesystem, environment, functions, or completion plugins. Two sessions can
therefore present the same prompt and command cells while ArrowUp selects different commands or
Tab produces different text, menus, bells, or no output. A local cache or heuristic has no
nonzero worst-case accuracy bound and can mispaint an entire valuable command row or completion
UI. ArrowUp, ArrowDown, Tab, and Shift+Tab consequently flush the bounded shadow and wait for
authenticated display authority.

The prompt anchor does not change that. `MESSAGE_TYPE_EDITOR_ANCHOR` (`0x2e`) carries geometry only,
`generation | row | col | flags`, captured by the daemon's own emulator at the
exact byte where the shell's OSC 133;B terminated. It authenticates *where the editable region begins*, not what the
shell would do with a key. History contents, completion results, and this shell's word semantics
remain unavailable, so those keys stay authority-only.

An erase does not claim the column it vacates. The model paints a blank there so
Backspace feels immediate, but it is not predicting what ends up in that column:
a shell with autosuggestions refills it in the very frame that echoes the erase,
and in the ordinary case with the character just erased — which is the one the
suggestion completes. Requiring a blank there made that echo a contradiction the
model could never confirm, so one Backspace ended speculative echo for the rest
of the line on every such shell. What proves the erase happened is the typed
prefix and the cursor, both still compared exactly, and a confirmed erase drops
its vacated column out of the model entirely so nothing goes on painting over
what the shell put back. The cost is stated where it is paid: an erase authority
never performs is no longer contradicted at the mismatch grace deadline, because
a refill with the erased character is byte-identical to no erase at all — only
the cursor separates them, and the cursor branch waits rather than retracting.
Such an erase is retired by the prediction lifetime instead.

What the anchor does fix is a separate and larger problem: `ensure_shadow_line` requires the row
tail from the cursor to the right margin to be blank, and a shell drawing an autosuggestion there
makes it non-blank. Without an anchor, any mid-line flush — a modifier key, a reconcile mismatch,
a TTL expiry — leaves the speculative model unable to re-seed until the next prompt, so prediction
stays dead for the rest of the line. The anchor is the one path allowed to bypass that tail check,
because it is authenticated evidence that the cursor is inside the line editor, where the tail
belongs to the shell and is exactly what the next keystroke overwrites. Cells before the cursor are
adopted as already-typed base, so a Backspace reaches back to the prompt rather than only to where
this browser started modelling.

Enter is deliberately excluded. Predicting it would require marking the keystroke
`shadow_modelled`, and that bit is what suppresses the daemon's pre-emptive
`observe_user_input` revocation — the only defense that fires *before* a same-process silent read
(`read --silent`) rather than after. That is a security regression, not a latency tradeoff, and its
upside is small: the typed line stays on screen either way.

Sustained producers also have a per-turn work budget. The dataplane returns to its owner
`select!` after a carrier-capacity-bounded unpaced display flush, after a bounded reliable-send batch, and after a bounded
PTY-completion drain. The terminal worker has one display ingress/apply owner: parsing, FEC,
decompression, validation, application and reconciliation share a refresh-bounded CPU slice.
Each current-generation datagram applies and releases its staged storage before the next SAB lease;
there is no 64-frame decoded prefetch or extra ready-frame MessagePort queue. The transport input/ACK
pumps yield after bounded real-work batches. Idle consumers park on their exact event source: each shared ring carries its
own wake word (`terminal/shared-ring.ts`), the two workers wake each other on it directly, and on
the one engine whose suspended workers can lose a futex notify (Apple mobile WebKit,
`displayRingWakeMode: 'task'`, resolved once on main) the edge crosses a worker-to-worker
`MessagePort` transferred in `init` — never the main thread. Backlog continuations and the drain
loops' fair yield are timer tasks armed from a `MessagePort` handler that never reposts to itself:
a continuously self-reposting port can monopolize Chromium worker task selection, and a timer
armed from inside a timer is clamped to ≥4 ms past five levels of nesting, so the two sources
strictly alternate. This keeps input, acknowledgements, disconnects, and control traffic runnable
during bulk output instead of relying on scheduler luck.

Timers remain only where elapsed time is part of the protocol or no event source exists:

- transport/auth/liveness deadlines, heartbeat RTO probes, and remote bulk-lane confirmation;
- bounded full-jitter backoff after an actual external dial, stream, or WSS control failure;
- congestion pacing, loss-repair windows, snapshot recovery, and rate limits;
- token cleanup, registered-edge expiry, and coordinated certificate rotation;
- the empty-index-only Redis reconciliation watchdog described above, which closes the durable
  write/pub-sub lost-wake window without adding a scan to the active scheduler;
- a low-frequency SharedArrayBuffer wait watchdog, because suspended WebKit workers can lose an
  `Atomics.notify`; normal input/frame/ACK delivery still wakes directly and pays no polling delay,
  and the task-wake arm keeps one watchdog timer for its lifetime rather than arming and clearing
  one per park;
- the display-output settle in the terminal worker, which turns a burst of applied frames into one
  "changed" and one "settled" notice for the screen-reader mirror — elapsed stillness is the
  signal, and it is checked against a stored deadline once per burst, never re-armed per frame;
- exact asynchronous WebGPU completion ownership and fair worker-backlog continuations, because
  completion must not serialize ingestion and Chromium does not guarantee fairness for a self-reposting
  `MessagePort`; both are generation-owned and cancelled while idle;
- native route-change debounce, whose bounded quiet period belongs to the OS connectivity signal.

Browser reliable writers await the native stream's creation, `ready`, and `write` promises.
Write completion releases one exact writer and its reliable Noise lane; datagram retries and
other crypto lanes remain independent. A stream-creation or write rejection ends that carrier.
No timer substitutes for a native write-readiness promise.

A timer must not be introduced merely to observe local readiness. If a platform API lacks a wake
primitive, document that limitation beside the timer, keep it inactive while idle, and cover its
cancellation and stale-completion behavior deterministically.

Elapsed-time decisions use a monotonic clock. Wall time is reserved for persisted expiries,
distributed timestamps, and user-visible occurrence times. This distinction is part of the
reliability contract: changing the system clock must not indefinitely suppress a liveness probe,
rate-limit release, command-ack watchdog, cache refresh, or daemon stop deadline.

Rust Criterion confidence-interval point estimates are normalized to `ns/op` structured metrics,
so codec, FEC, and zstd kernel regressions participate in the same gate instead of being hidden
inside a fixed-duration `cargo bench` process time. The live display boundary uses a 1,100-byte
datagram ceiling, up to four data shards, width-selected parity for groups of two through four, and
path-evidence-gated exact replay for a one-data-shard group. The global display planner
selects row partitions and raw or zstd representations using sender cost, receiver cost,
carrier delivery quotes, and measured loss. Acknowledged per-peer dictionaries are an
input to that decision. Benchmarks must exercise the shared planner, not a per-class policy.

The browser receiver-cost profile retains each raw-window mean until a raw observation changes
that size class. Publication recomputes and writes only buckets with new compressed observations;
unchanged buckets retain their shared-memory statistics under the same seqlock. Each publication
still advances its revision, timestamp and service debt. A new writer recomputes every bucket on
its first publication, clearing its predecessor's observations. Window order, sample variance,
predictive upper bounds and the wire representation stay identical. The caches add 96 bytes of
typed-array backing storage per writer. `scripts/bench-web-display-periodic-paths.ts` measures
unchanged, single-bucket and full-bucket publication, plus compressed sampling with a retained or
fresh raw baseline. Those CPU and allocation measurements exclude network and GPU work.

The remaining native write paths use kernel or transport readiness instead of retry polling. The
PTY master is blocking, with one FIFO and a hard 320 KiB combined allocation cap (including its
64 KiB terminal-reply reserve); accounting is released only when the owner observes completion.
User writes below 256 bytes stay on the immediate path. Larger paste entries are split into bursts
of at most 256 bytes and two logical lines, adjacent CR/LF bytes stay together, and a 1 ms pacing
edge is carried across FIFO entries. This paces fresh input after a successful kernel write rather
than retrying bytes the line discipline may already have consumed. Only an interrupted syscall is
retried; an unexpected `WouldBlock`, zero-length write, or ambiguous error closes the writer.
Durable edge transport owns one long-lived uni stream per active logical channel and direction.
The edge retains each accepted source stream across counterpart replacement, validates length
prefixes, and transfers received `Bytes` ownership into QUIC. The original header fragments and any
already available body prefix share one admission; later ready chunks batch up to 16 entries / 16 KiB
per receive/write operation, without reading beyond the current record. There are no complete-frame
staging allocations or per-frame open/write/finish tasks at the edge. Endpoint writers use independent bounded queues, so
bulk display backpressure cannot block signaling, PTY input, or control. Idle streams have no timer;
partial records and transport operations retain bounded deadlines. The parent session owns every
lane task and cancels it on detach. Any lane FIN, reset, malformed record, timeout, or ambiguous
write closes the exact carrier generation instead of silently continuing after reliable loss.

The finite stream class has separate admission and byte budgets. It forwards bounded batches of
owned buffers, reserves the entire possible transfer queue until acknowledgement or reset, and
pins one destination attachment. Cancellation never tears down a durable lane. Finite image
consumers activate shared packet admission for the concrete interactive/bulk attachments, with
a shared delivery-rate model, bulk pacer and interactive MTU reserve. Only interactive flight
spends the interactive window; bulk pays for both classes. Quinn returns a freed stream slot immediately when the
peer has consumed all advertised stream credit, so persistent streams cannot prevent a small
finite completion batch from opening a successor. Otherwise its existing credit batching remains.

Edge datagrams use owned admission with a separate WebTransport prefix, eliminating the envelope
allocation/copy and the separate advisory capacity lock. Lifecycle and quote JSON serialize directly
into one length-prefixed owner and use one owned write. These are ownership transfers at relay
admission, not an allocation-free QUIC stack: receive processing, packetization, and send-queue
metadata retain their own costs. Retained receive slices can also pin their backing allocation.

The repeatable component profile is:

```bash
cargo test -p merkur-edge --locked --release --bin merkur-edge \
  edge_owned_admission_profile -- --ignored --nocapture
```

It compares the prior copying admission against owned admission on real local QUIC streams, using
paired ABBA/BAAB ordering, 20 warm-up rounds and 120 measured samples per arm. The old arm retains
its 16 KiB scratch buffer across records. Payload fragmentation is supplied by the fixture; ingress,
network delivery and the byte-exact receive oracle are outside timing. Small warmed reliable
admissions and datagram admission allocate nothing in the owned path. This is component evidence,
not an end-to-end latency or throughput claim.

For Bun workloads, add `--cpu-profile`, `--heap-profile`, or both. The extra capture run writes
artifacts beside the report under `profiles/`. Deterministic artifact names are removed before
capture and the new files must be fresh, non-empty, and valid JSON where applicable. Profiler
directories are always passed to Bun as normalized cwd-relative paths; this avoids Bun mirroring
an absolute path under the repository:

```bash
bun run scripts/profile-project.ts \
  --mode=micro \
  --repetitions=3 \
  --cpu-profile \
  --heap-profile
```

### Terminal Selection Layer

Selection is the browser's, not Merkur's: while Shift is held, a transparent, metric-matched DOM
text layer is mounted over the WebGPU grid so native drag-select, word and line select, right-click
Copy, and the iOS long-press callout all work, and so a copy reaches the clipboard inside the
gesture that requested it. That last point is a correctness constraint rather than a nicety —
WebKit permits a clipboard write only while it is synchronously dispatching the gesture's own
handler, and the grid lives in WASM inside a worker, so any read-then-write loses the gesture.

The layer is off the render path by construction, and the gate is Shift held *alone* rather than
Shift being down. That distinction is load-bearing: Shift is pressed for every capital letter, so
gating on the key itself would fetch the viewport and rebuild the layer mid-word and drop a
`pointer-events: auto` surface over the grid while the user is typing. Enabling is therefore
deferred 200 ms and cancelled by any other keydown; disabling stays immediate.

Where a drag starts is the one thing the browser cannot be left to decide. Shift+mousedown is also
the browser's own "extend the current selection" gesture, so a drag under this gate anchors at
whatever base the browser was already holding — the caret from an earlier click, or a position
outside the layer that reads on screen as the end of the viewport — and sweeps every row between
there and the pointer into the selection. Chromium, whose base sits in the focused editing surface,
refuses to extend out of it and selects nothing at all instead. Every press therefore carries its
own anchor: the grid cell under the pointer, mapped to a DOM position through the same
wide-character accounting the rows are painted with. It is recorded on `pointerdown`, the event that
knows the pointer is a mouse, and applied on `mousedown`, because the panel focuses the editing
surface from a bubbling `pointerdown` handler and moving focus re-parks the browser's base. The same
anchor is applied again when the layer mounts with a button already down: pressing Shift and the
button together beats the 200 ms intent delay, so the mount lands mid-drag on a selection the
browser anchored before this layer existed.

Two things must then leave that selection alone until the user is done with it.

The first is focus. Focusing an element that carries an `EditContext` moves the document selection
into it, so the panel's click-to-focus handler collapsed every mouse selection on the click that
ended its own drag — the selection was correct right up to `mouseup` and empty immediately after.
While the layer is mounted the panel therefore does not move focus at all, and takes the editing
surface back only once the layer comes down. Nothing is lost by waiting: ordinary keys reach the
terminal through a window-level keydown listener, and the editing surface matters only for IME
composition, the emoji picker and dead keys, none of which happen mid-drag.

The second is the application. Mouse reporting is suppressed for any gesture that carries Shift,
read from the event itself rather than from the layer's mounted state — the mount is 200 ms of
intent delay plus a worker round trip late, and a press inside that window reaches an application
that tracks the mouse, which starts its own selection underneath the browser's. In vim that is two
selections, and the release never arrives either, because by then the layer is up and swallowing it.
Ownership is decided at the press and never revisited, so a release is always reported to whoever
was told about its press; Shift+wheel is swallowed on the same rule, since scrolling an
application's buffer out from under a live selection is the same confusion.

While mounted it refreshes on a 120 ms debounce driven by the worker's `viewport_stale` event, posted once on the first grid change after a watched read — the
cursor does not move for every repaint, so watching cursor position would miss output entirely — and
that refresh is skipped outright whenever a selection is live, so a selection stays anchored to the
screen it started on. Nothing is mounted otherwise, so the idle cost is zero and the ordinary
keystroke and display paths are untouched.

Advance calibration is what makes it usable and is measured, not assumed: `charWidth` is
`widthPhysical / dpr`, which no DOM font's natural advance matches, so each row carries a
`letter-spacing` of `charWidth - measureText('M')` and each wide character a fixed-width
`inline-block` of exactly two cells, because correcting wide characters with letter-spacing instead
drifts by nearly a pixel. Coverage is
Chromium by default (`PW_E2E_BROWSER=firefox` selects Firefox in the edge config), and the WebKit gesture rule this
feature exists for cannot be gated in CI — only `scripts/run-ios-webkit-harness.ts` runs real
Safari, and it measures startup timing.

## Display preparation

The graphics tile components use a 256-pixel interior with one source-neighbour gutter,
clipped at source boundaries. Native Up filtering reads immutable validated source rows
directly into reusable scanline scratch; libdeflate writes the PNG IDAT into its context's
reusable output span. Filtering/encoding has no intermediate packed tile; the one copy moves
the encoded length into the transfer's own allocation, and a vectorized wipe clears that
prefix of the span before its context returns to the pool. The native processing pool owns two
reusable contexts; each reserves a 512 KiB C arena, fixed scanline scratch, 131,184 bytes of
reduction rows and a 264 KiB output span before allocation. Libdeflate's per-instance
allocation callback can use only that arena. A job acquires an actual context before
entering the blocking pool, a returned context wakes exactly one waiting request, and
cancellation retains its context, source and transfer credit until execution retires. The native fetch owner initializes the pool outside the terminal
owner. Encoded tiles are transfer objects, never terminal storage: 64 process-wide transfer
credits of 588 KiB each (36.75 MiB) cover the exact-length tile, its sealed stream copy and
the task's seal scratch through acknowledged FIN. Requests wait for a credit in arrival
order and are never refused for capacity. No tile is kept after its transfer and concurrent
requests are not deduplicated; the browser's encoded cache is the only tile cache, and a
resumed range re-encodes deterministically to the same bytes. Resolution reduction
visits only the requested tile's source footprint, including neighboring gutter pixels.
A depth-first pipeline retains two rows per level in fixed reusable scratch, preserving
alpha-weighted linear-light reduction and exact odd-edge sampling. It allocates no whole
mip level and makes one processing handoff per request. Source destruction uses a lazy,
dedicated retirement thread: each object preallocates its queue record before publication,
and final release only links that record under a short lock. Wiping and deallocation run
outside the terminal owner, and a retirement completion covers every frame and pixel
allocation its destruction released. Projection and placeholder shortfalls evict nothing while
any removed source's release is in flight, and at most one source per landed release. The process
drains retirement after joining processing tasks.
WASM presentation export has an independent lease derived from admitted descriptor count;
growing it releases the old allocation before refunding and reserving replacement storage.
Aggregate packet admission coordinates the concrete interactive/bulk attachments; paired
measurements bound its cost.

The browser creates its asset worker only on visible image demand. It holds encoded PNGs
in a 64 MiB memory-only budget, permits two decodes, and transfers one reusable 16 KiB
chunk buffer per active request. At most 32 request slots cover receiving, decoding and
unconfirmed upload; cancelled work keeps its slot until both browser-worker and native
retirement. Interrupted transfers reuse the existing encoded allocation and incremental
verifier, requesting only the missing suffix after an inventory/cancellation handshake.
Native refusal waiters use existing queue semaphores; text-only enqueue and retirement
gain no per-frame notifier or additional allocation.
The compositor reserves all demanded regions before download, packing actual guttered
extents into at most 15 pages of 16 258-square RGBA layers. Admission reduces resolution
when this exact texture working set cannot fit. One tile copy joins each eligible terminal
submission, after interactive uploads, with the existing GPU completion releasing its
credit. Tile arrival updates a 16-byte texture mapping rather than rebuilding image
geometry. Text-only frames allocate no image resources or image worker and submit no
additional GPU commands. Removing the last image detaches image frame processing while
retaining bounded backing storage for reuse. These structural bounds do not establish
latency under image load.

Visible animation playback retains one exact next-boundary timer for all visible timelines;
hidden tabs cancel it and resume by sampling elapsed native time. Stopped and completed
timelines do not wake on heartbeat clock updates. A slow frame retains its requests until
all required tiles are GPU-resident, then reconciles to the current timeline. The compositor
keeps the previous complete frame while a replacement is incomplete. Geometry admission proves
room for a complete successor before selecting the sampling level, including frames whose
currently shared pixels can later diverge. Stopped timelines need only their visible working
set. This admission work runs on geometry changes, not ordinary frame boundaries. Its bounded resident
cache retains unused tiles until allocation pressure; cached frame changes update 16-byte
texture mappings without uploading pixels or placement geometry. Next-frame prefetch begins
only after all visible tiles are resident and only if the exact additional atlas allocation
fits; it cannot lower visible quality or request unreserved pixels. Canonical manifest storage
has separate 16 MiB bounds in JavaScript and terminal WASM. Text-only terminals create none
of these owners. These are structural properties, not latency evidence.

Native descriptor submission avoids base64, PTY bulk copies and the terminal parser's
per-chunk handoff. The confined helper snapshots the submitted extent and validates it before
the program receives a one-use reference. The parser boundary only transfers the validated
image into its scene and applies placement. The local broker reserves bounded bookkeeping
at terminal startup and waits on socket readiness; idle terminals add no polling, image
processing, display work or GPU commands. Native jobs share inline storage and processing
admission, including reservations retained by cancelled hashing and helper cleanup.

The asset verifier streams domain-separated BLAKE3 through 16 KiB WASM ingress scratch,
with WebAssembly SIMD enabled, retaining only hash state and fixed envelope fields.
Native browser decoding follows complete commitment and shape verification. The component
comparison lives in `scripts/bench-graphics-codec-browser.ts`; generate its corpus with
the image worker's `tile-codec-bench` example and build both graphics WASM packages first.
The zstd comparison crate is benchmark-only. The codec decision rests on those measurements; this is not integrated
image-delivery or physical-device acceptance.

A terminal flush captures each changed row once and derives its cells, encoded bytes,
encoded-size metadata, and XXH3 hash in the same traversal. Peer diffs compare those immutable
captures with their acknowledged baselines and reuse the same reference-counted cell storage for
encoding and ACK provenance; a full snapshot uses the same one-pass capture primitive instead of
separately encoding, copying the grid, and hashing rows.

Graphics rows have a separate immutable owner with a cached digest, bounds and canonical
encoding, without a duplicate native descriptor array. Native capture and ACK provenance
share it; encoding another viewer's frame
does not sort content domains or walk descriptors again. Empty rows allocate no graphics
object. A persistent AVL visibility index stores resolved direct and relative placements
in canonical stacking order. Exact subtree row masks prune unrelated contributions, while
placement dependency invalidation resolves only changed members. Arena nodes are reused for
updates without allocation; removals recycle slots. Unaffected rows retain their encodings,
and exact canonical comparison avoids republishing invalidated but unchanged rows. One batch reservation precedes retained row
allocation, and transferred leases avoid per-row readmission. Unicode placeholders use a
sparse quota-owned row index only while virtual prototypes exist. Damage refreshes affected
rows and exact decoded-cell equality avoids reprojection for unchanged cursor damage.
Prototype geometry is compiled once, adjacent cells reuse their resolved prototype, and
contiguous image slices coalesce before merging into the stack-ordered row query. Unchanged
rows reuse storage without allocation.

Grid movement notifications reuse admitted anchor nodes. Repeated movement while a tag
is pending avoids queue locks and reference-count changes; ring remapping sets one domain
flag without visiting anchors. Retirement examines only rows leaving live history, even
when unused physical ring capacity retains their storage. The native consumer invalidates
the affected dependency subtrees; a remapped batch currently invalidates all placements.
Viewport or cell-metric changes invalidate all placement geometry. Local changes update only
their indexed dependency members and old/new row intervals. Index arenas, reverse lookups and
row encoding scratch are reserved before population. Placeholder selectors retain exact row
masks, including missing identities. Only changed dependency members compile prototype geometry,
and only their referring rows rebind. Per-row origin contributions and a preallocated dirty-parent
worklist avoid rescanning all prototypes or cells when one virtual parent changes. Existing row
and selector storage is reused when cell positions change without changing selector membership.

Dictionary work is revision-scoped rather than peer-scoped. A dedicated `merkur-display-dict`
thread receives already captured rows, builds and truncates one dictionary source for the flush,
finalizes and hashes it once, and shares the result with every eligible peer. Display deltas are
prepared on a separate `merkur-display-prepare` thread with two lanes and strict interactive
priority: a queued interactive delta is always encoded before a queued bulk redraw and never waits
behind a dictionary build. Small raw updates stay on the owner loop when queueing would cost more
than the work; compression, snapshot, and larger-delta preparation run away from the
latency-sensitive owner flow.

The fixed display envelope stays visible and only the encoded row body is compressed, in its
stream-split layout. Every row carries literal cells, so a delayed datagram never depends on
another mutable receiver row. Each independent transformation also carries advisory
presentation provenance, and receiver-cost feedback gives the global sender planner measured
browser service distributions without changing application or ACK boundaries. On the browser,
compressed ring entries are leased until terminal WASM has copied them into its reusable input
allocation; WASM then validates the envelope, resolves the dictionary, decompresses the split
payload, joins it into reusable row storage, and applies the rows without a normalized
JavaScript buffer. Rust owns bounded FEC storage, and render geometry scratch buffers retain
capacity across frames.

## Workload Fidelity

The report labels every workload:

- `production` calls production codec, receive, telemetry, or FEC code.
- `component` exercises production-like component work without the whole process tree.
- `model` is a deterministic transport or multicast lower bound. It is diagnostic and cannot
  prove a user-visible latency objective.
- `verification` measures a service's test process and is primarily a reliability/resource
  signal.

This distinction is intentional. A fast model never overrides a slow real-browser result.
The browser `fec-retention-admission` workload is a `component` benchmark of the production
Rust `ClientViewer` WASM boundary, retention, real FEC recovery, authoritative apply and output
bridge copies. Native codec/parity generation and JavaScript fixture allocation run before
timing; frames enter already opened. Every fourth original frame is omitted, and the oracle
requires the exact recovered count and final sequence. Crypto, transport and GPU work are
excluded. The `dataplane/display-fec` Criterion workload measures daemon FEC separately.

The impaired browser suite's UDP delay proxy is also deliberately bounded so harness behavior
cannot masquerade as an application tail. It owns at most 64 active client relays, one pending
admission packet, and 4,096 least-recently-active flow tombstones, and each relay holds at most
65,535 delayed packets, its lease. The relay bound covers every connection the harness keeps
live: reclaiming a live relay hands the edge a new source address mid-connection, a migration no
profile configures, and the worker-scoped daemon keeps each finished spec's peer for its 60 s
rebind window with three connections. Settle and mark replies list every live relay, so they
arrive in the same bounded chunks as the full snapshot. A flow is the destination listener plus the source address and
port; source-port reuse across listeners creates independent relays with separate role accounting.
A valid QUIC Initial admits a new flow; a tombstone lets a previously validated flow rebind from a
plausible short-header packet on the same listener. When capacity is busy,
recovery takes priority in the one-packet handoff, and an exact pending-packet 1-to-0 transition
wakes admission through `Notify`. There is no admission poll or retry queue, and every ownership
structure has a hard memory bound.

Host capacity is the one confound the harness cannot bound for itself. The latency assertions in
`terminal-performance-matrix` and `transport-latency` are `production` browser measurements, so a
host that cannot schedule the whole stack shows up as an application tail. `test:e2e:transport`
runs the Bun server, Redis, the Rust edge, a daemon, the Rust dataplane, and Chromium with three
web workers concurrently; a small VM without a GPU (Chromium falls back to SwiftShader) sits at a
load average several times its core count, and p95 paint and worker-handoff budgets are missed.

The discriminator is position, not code: the same spec passes alone and misses p95 budgets inside
the full gate while process counts and available memory stay flat, which is CPU contention rather
than a leak. Playwright also restarts its worker after a failed test, which briefly doubles the
browser count and spikes the load further, so one host-induced failure makes the next more likely.

The same host also starves the sample counts those specs depend on, but by a different mechanism
than the p95 misses, and the two must not be conflated. `transport-latency` drives a deterministic
192 keystrokes at a 10-12 ms cadence and requires 180 complete samples; a sample is a whole
input-to-paint chain, so an input whose chain does not finish inside the measurement window is
simply absent. Run alone, every chain completes, so a shortfall is contention, not the renderer
dropping work. `MIN_PREDICTION_COVERAGE_RATIO` degrades under the same pressure.

The p95 budgets are the part that does not recover in isolation. A software rasterizer's frame
period is a multiple of a hardware one, so a 50 ms apply-to-paint budget is below two of its frame
periods and cannot be satisfied at any load; the cost is not in Merkur, whose `submitCpu` stays in
the low milliseconds while the GPU fence wait absorbs the rest.

Treat a p95 miss, a sample-count shortfall, or a prediction-coverage shortfall in those two specs
as a host-capacity signal until it reproduces on an unloaded machine, and never respond to one by
widening a budget or lowering a minimum: those thresholds are the only thing those tests assert. A
renderer `Target crashed` with no preceding `pageerror` is the same class of signal.

`transport-latency` enforces that rule itself rather than leaving it to the reader.
It asks the browser for its WebGPU adapter and skips when the adapter is a fallback adapter or its
identity names a software rasterizer (SwiftShader, llvmpipe, softpipe, swrast, software), because on such a host it cannot measure what it asserts: every
budget in it is wall-clock. Neutralising only the GPU-bound budgets is rejected: with those gated
the same host fails a different wall-clock budget instead, so whichever budget loses that run's
scheduling lottery is the one that fails. The thresholds are untouched and stay fully enforced
wherever there is a GPU to enforce them against. A browser that returns no adapter at all fails the spec
rather than skipping it. The check reads the adapter, not an environment variable: a host either
has a GPU or it does not. `PW_E2E_GPU=swiftshader` exists only to force the software adapter on
purpose.

That skip is only honest if the browser was actually offered the GPU. Headless Chromium picks
SwiftShader by default even on a machine with one, so `playwright.edge.config.mjs` launches it with
`--enable-gpu`; on a hardware host the renderer then names the GPU and the spec measures. On a host
with no GPU the flag changes nothing — Chromium still lands on SwiftShader and the spec still skips
— so it asks for hardware without ever faking it.

A perf record carries `visiblePredictionInputSeqs` as a base sequence plus a 256-bit mask over the
sequences above it, which is the bound the terminal worker and the analyzer already impose on the
set. One u32 slot per sequence would cap a frame at eight visible predictions, reachable on any link
where a keystroke's round trip outlasts eight more keystrokes, and since the analyzer refuses to
compute coverage from a truncated frame that would leave the exact-prediction metric unavailable for
the whole run. Truncation means one thing only: the visible sequences did not fit inside one
256-sequence window, and a frame carrying that flag still contributes nothing. That is what makes
prediction coverage measurable on a high-RTT lossy link under `test:e2e:latency:impaired`.

## Felt-Latency Measurement Contract

All terminal latency reports explicitly declare
`frameCompletionBoundary: "browser-observed-webgpu-queue-completion"`. Metric names ending in
`PaintMs` identify that software-observed boundary, not physical photons. Reference artifact
schema 4 retains exact observed fence exposure, not claimed exposure bounds.

Terminal perf artifact schema 20 retains every command-readiness completion and its required
`latest-submitted`, `superseded`, or `invalidated` disposition. Only the first may contribute
prediction-visibility samples; the latter two still contribute authoritative/readiness counts and
tails. Submitted membership is immutable between `render_end` and `frame_complete`, including the
queue-depth snapshot. Render-gate attribution names the exact completing render through
`fenceReleasedRenderSeq`, not a timestamp-nearest predecessor. These fields fit the existing
128-byte telemetry record; this common contract does not increase production render capacity.

The same fixed-size I/O record retains the callback-owned inbound carrier and lane
(`direct-datagram`, `direct-reliable`, `relay-datagram`, `relay-reliable`). Terminal-owned
stages use explicit null; they cannot infer a receive route after the shared-ring boundary.
Direct phase reports retain an exact frame-identity ingress census with all admitted,
refused, late, and unmatched attempts. Mixed-route replicas remain ambiguous rather than
being assigned a winner by timestamp; FEC reconstruction is reported separately. This
proves observed route candidates, not packet network transit or why the sender chose them.

The network matrix rejects a clean workload with any repair-assisted presentation, recovered
FEC display, or interior application sequence gap. Coherent-redraw coverage requires exactly
the dense, wide-cell, cat, alternate-screen truecolor, and sparse edge workloads per run; a
single passing dense redraw cannot stand in for all five. Every planned proxy scope must have
complete delay populations with at least 100 samples. A percentile in the saturated final
histogram bucket is unknown, not its nominal bucket edge, and cannot pass the headline gate.
These are pooled per-packet samples across seeds only within an identical
phase/profile/loss/reordering/scenario scope, not 100 independent application updates.

### Shared native artifact preflight for paired browser runs

Each local edge-harness Playwright phase owns a fresh server and Redis, while the edge process
survives between phases. Global setup waits until that phase's Redis contains the indexed,
accepting registration with the harness edge's exact identity, URL and certificate. A listening
server alone is not readiness to issue terminal sessions. The setup deadline fails missing
registration; it never substitutes a fixed settle delay or retries a failed browser case.

A paired source-tree benchmark must not rebuild byte-different native executables in its two
arms. Build the shared edge, delay proxy, and dataplane once from a clean native source closure
into a new absolute directory:

```sh
bun run prepare:e2e-native-artifacts -- \
  --output=/tmp/merkur-native-preflight-<checkpoint>
```

The preparer records every tracked file in the Cargo manifests/lockfile, dataplane, edge, local
Rust dependencies and crate patches; it refuses dirty or untracked files in that closure. Its
manifest also pins the resolved Cargo and rustc executables, their hashes and verbose versions,
the exact `--release --locked` build commands, compiler/profile/target environment overrides,
and the three staged executable hashes. The output directory must not already exist.
This is an exact cross-arm artifact control: it records the clean source/toolchain/build inputs
and the resulting bytes, but does not claim a cryptographic proof that those bytes were derived
from the source. The preparer rejects aliased or multiply linked build outputs before staging.

Supply the same resolved manifest path to every fresh benchmark process:

```sh
MERKUR_EDGE_HARNESS_NATIVE_ARTIFACT_MANIFEST=\
/private/tmp/merkur-native-preflight-<checkpoint>/native-artifact-manifest.json \
bun run scripts/run-edge-harness.ts <spec> --workers=1
```

Use the preparer's emitted `manifestPath` verbatim. It is canonical; on macOS that means a
directory requested below `/tmp` is reported below `/private/tmp`. A symlinked spelling is
rejected so every arm records and verifies the same manifest identity.

Manifest mode is a benchmark setup control, not a product behavior flag. The runner recomputes
the current worktree source closure and host toolchain, reads and hashes the staged executables,
then installs those retained exact bytes at the normal edge/proxy/dataplane paths before any
server, daemon, or browser starts. A missing, malformed, stale, non-canonical, or byte-mismatched
manifest aborts; it never falls back to rebuilding. The ordinary no-manifest harness invocation
continues to build its local native artifacts as before. Retain the runner's
`nativeArtifactProvenance` result and `[harness-native-artifacts]` line with every run artifact.

For a separate full-application Chrome trace, run the Direct latency E2E with
`DIRECT_GPU_TRACE=1 DIRECT_DIAGNOSTIC_WORKLOAD=typing` (or `tmux` / `neovim`) and the normal Direct network-emulation
setup. It refuses other browsers/scopes and labels all resulting timing populations
`timingAcceptanceEligible=false`. Typing retains the unchanged seven phase populations and
their controls, but records a separate bounded trace only around each complete regular100ms
and irregular100ms input driver. Other cadences in that run are still diagnostic-only;
they cannot be pooled into an untraced acceptance run. The two trace prefixes are
`direct-typing-100ms-gpu-trace` and `direct-typing-irregular-100ms-gpu-trace`.
For TUI selection, only the selected measured loop is traced, after activation.
Both use one shared lifecycle: setup and reset precede the begin marks; end marks and
trace drain precede raw observation/summary capture. No per-input trace commands run.
The browser-level trace includes task/flow, GPU, compositor/Viz, graphics-pipeline and page
UserTiming categories plus `blink` for native OffscreenCanvas export; it excludes screenshots, stack sampling, device timer queries and the
optional broad `cc` category (its prolific sequence counters obscure the required pipeline data).
The trace and JSON metadata are durable attachments. The native recording buffer is capped
at64MiB; its expanded JSON stream is separately capped at256MiB and drained after the end
mark. Commands/drain remain bounded, with buffer-full/data-loss checks and stream cleanup.
Both page-clock boundary marks must survive with consistent ownership/offset and in-window
task/flow/GPU/Viz/graphics-pipeline events before the trace is complete. This diagnostic can distinguish task,
command-buffer and compositor delays, but cannot prove the physical instant a WebGL fence
signaled or the panel displayed a pixel. Do not pool its timings with untraced populations.
Native canvas export events do not contain Merkur render identities. Report their
worker-thread ownership and census separately; do not join a render to a surface by nearest
timestamp. Coalescing or multiple in-flight submissions can invalidate such a join. Exact
child-surface/aggregation/display joins prove that surface's software presentation only,
not which Merkur submission it contains. Broad `blink` recording can perturb scheduling;
buffer limits and truncation checks remain unchanged, and even a complete trace is diagnostic.

To trace the actual relay typing workload without substituting Direct's slower typing
driver, run `TERMINAL_GPU_TRACE=1 EDGE_NETWORK_PROFILE=difficult
EDGE_NETWORK_DATAGRAM_LOSS_PERCENT=1 EDGE_NETWORK_REORDER=moderate
EDGE_NETWORK_SCENARIO=steady EDGE_NETWORK_SEED=<seed> bun run
scripts/run-edge-harness.ts transport-latency.e2e.ts --workers=1`, retaining the same hardware
browser/headed and native-artifact settings as the untraced reproduction. This test-only switch
captures the unchanged measured typing driver and settlement, after viewport priming. It drains
in `finally` before timing assertions, attaches `terminal-gpu-trace.json` and
`terminal-gpu-trace-metadata.json`, and uses a distinct diagnostic test title that cannot satisfy
the matrix's required acceptance test identity. Timings from this run are not acceptance evidence.
The shared collector includes `disabled-by-default-gpu.dawn`; broad `gpu` alone does not
enable Dawn's native events. The relay diagnostic additionally requires Dawn events inside the
exact terminal-worker clock window, retaining all existing buffer, hash, and clock checks.

For an untraced focused root-cause capture, `DIRECT_DIAGNOSTIC_WORKLOAD=typing` runs only
the seven typing phases; `tmux` and `neovim` select their respective application loop.
The
default runs every workload. Each source manifest and final report records the
selection and `completeSuitePopulation`; a diagnostic subset never claims full-suite
acceptance, and all selected phase, clean-path, convergence, and bracketed-control gates
still execute. Chrome tracing remains restricted to the separate tmux/Neovim diagnostics.

Typing includes a separate `typing-irregular-100ms` population alongside the six regular
cadences. Its repeated intended per-input delays are 30/40/60/70/90/110/130/140/160/170 ms,
averaging 100 ms (nominally 120 WPM at five characters per word). It preserves six
20-printable/20-backspace runs, 120 inputs per class and 114 within-run adjacent pairs per
class. This is a deterministic irregular driver, not a recording of human typing or a
claim that browser events hit those intervals. Playwright `keyboard.press` delays between
keydown and keyup; sequential calls add driver overhead. Actual DOM input gaps own cadence
analysis. Each phase retains its pattern metadata and its own raw/cadence artifacts; the
irregular population is never pooled with regular typing. The driver makes no per-key
presentation waits, telemetry dumps, or network-control requests.

Every typing phase and TUI loop also receives a cold native recorder drain immediately
before its observation setup and after its retained browser evidence. SIGUSR2 requests
the ordinary final transport sample followed by the bounded native trace export. The
Direct harness requires `MERKUR_E2E_FINAL_TRANSPORT_CAPTURE=1` before daemon launch;
the fixture refuses to signal a daemon that did not install this existing test listener.
The fixture waits at most 20 seconds and validates exact daemon/command identity, chunk order,
metadata, record ordinals and completion counts through the shared IPC validator. Both
raw compressed logs and decoded records remain durable artifacts, including partial or
failed exports. A completed export with dropped current-owner records is not complete
timing evidence: `recordCoverageEligible` stays false and the measured after-capture fails.
`stale` counts records discarded from a previous observation, not current-owner loss;
it remains visible but does not automatically disqualify the following measured phase.
The before-capture may contain discarded setup history; it is retained, never attributed
to the following measured phase. Export and phase failures are combined so one cannot
hide the other. Native process-monotonic timestamps must not be subtracted from browser
epoch timestamps; exact sequence/member identities connect their separate timing domains.

The cold `native-display-boundaries` analyzer accepts one to four explicitly selected
native captures plus one browser population and its retained startup `session_bound`
identity. Every drain must have the same owner, peer, session and observation epoch.
It merges by exact ordinal, rejecting conflicting duplicates, rather than requiring
ordinal ranges to advance across drains: a reserved record can be published late.
Connection plus all 128 ciphertext-tag bits identifies a FIFO queue/packetization copy;
an accepted display attempt must own exactly one matching queue event inside its recorded
call interval. Ambiguity stays ambiguous. Packet outcomes join only by connection and
application-data packet number; unrelated packet ACKs/losses are retained separately.
Per-presentation admission, packetization, browser receipt and screen-changing submission
spans remain separate clocks. Nonmutating duplicates cannot widen exposure, and missing
admitted members cannot turn zero observed exposure into complete redraw evidence.
Queue/packet construction is not OS transmission; earliest-copy spans do not identify
which replica won at the browser. Carrier snapshots without a plan identity remain
unattributed rather than nearest-timestamp quote matches.

Start with the real transport test and inspect the retained
`terminal-latency-summary.json` under `test-results/e2e-edge/` (it is also attached to the
Playwright result). Successful runs keep this artifact instead of relying on a reporter to retain
an in-memory attachment. Follow the first stage whose p95/p99 grows:

```text
input queued
  -> display received
  -> terminal worker queued
  -> display applied
  -> rendered / GPU completion
```

The last stage, `displayApplyToPaintMs`, is decomposed further. Its three sub-terms are computed
from the same four timestamps, so per sample they sum to it exactly; that identity is asserted
both in the unit suite and in `transport-latency.e2e.ts`, and it is what makes the split
trustworthy:

```text
display applied
  -> render start        displayApplyToRenderStartMs   waiting to submit
  -> render end          renderStartToRenderEndMs      synchronous CPU submission
  -> GPU completion      renderEndToDisplayPaintMs     fence wait PLUS fence observation
```

`renderGate` attributes submission wait to the actual decision: `immediate`, `fence`, `opportunity`,
or `fence-and-opportunity`. Fence and opportunity durations accumulate disjoint intervals; time
paused behind coherence is not counted in either. The combined label does not assert their order.
At most two unconfirmed submissions are outstanding; subsequent dirty notifications replace one
pending latest state. A callback releases only its exact owner. Idle work with no unconfirmed GPU
work submits immediately. Otherwise rAF alone provides presentation
opportunities, never physical completion evidence. A completed coherent transaction bypasses this
additional opportunity wait; an intervening echo cannot reopen it.
The estimator's long-baseline period includes only a contiguous accepted span: any rejected
forward delta re-anchors the span without freshening its phase. Duplicate, backward and
non-finite timestamps cannot move the delta origin; interrupted seed chains cannot mix old
monitor samples with a new cadence. A run of continuous outliers re-seeds from the very deltas that
produced them, so a lock taken from a jittery calibration burst converges back down inside the same
burst instead of standing for the session: the cold fastest-supported bound applies only until the
first continuous delta and is no longer a floor under the converged estimate.
The period gates no presentation release — it feeds the drain CPU budget, the daemon hint and
telemetry. These are effective browser callback
cadence measurements, not proof of physical panel scanout.

Coherent display frames additionally carry timing-only zero-based membership within one daemon
prepared presentation. Membership is scoped to the current renderer transaction: every group
attached to it must be applied through, and the newest membership-bearing group *of that
transaction* must have carried `END`. A group first observed after the transaction started — a
queued newer redraw, or a daemon re-send of identical rows under a fresh presentation id — belongs
to the next transaction and cannot move the goalpost, and a queued frame can never re-hold a
transaction that already released. Completion is evaluated at the applying member, not only at the
safe end of the display-pump turn; for coherent work it makes the next animation frame commit
rather than committing there, so separately ended chunks of one redraw fold into one image.
Missing, inconsistent, oversized, or capacity-evicted advice
cannot reject grid state or delay ACK/recovery and cannot extend the frame budget.
The fixed browser ledger survives a partial frame-rule commit so a late final member does not pay a
second frame. Fully applied unpoisoned groups in a consumed renderer transaction advance the
retirement watermark even without END, so delayed replicas cannot reopen an already-presented
clipped prefix. Retirement validates the serial order of both visual and nonvisual members: the latest
visual mutation is not necessarily the newest successfully applied group. A later no-op/header
can advance the committed ledger without introducing new pixels. Queued-only members never advance
that watermark. Those already attached when the transaction opened still participate in its
half-range/cycle ambiguity checks; one first observed afterwards joins no transaction, so it
neither poisons the commit in front of it nor escapes the audit — its ambiguity is decided against
the moved retirement floor at the moment it actually applies. Otherwise
an ordinary newer no-op would permanently disable early commits for the rest of the session.
A K1-protected isolated original carries complete 0/1 END membership and releases
at its own pump regardless of whether its optional nonmember probe arrives first or never arrives.
The serial retirement watermark makes forgotten old ids permanently
ineligible without disabling optimization for newer traffic. This evidence proves completion of a
sender-prepared presentation only. It cannot prove that a future PTY read belongs to the same
logical redraw, so the strict redraw acceptance gate remains the explicit workload window and its
final grid-convergence/GPU-fence oracle.

A late nonvisual duplicate behind that retirement watermark is ignored by the presentation
ledger, not treated as malformed new advice. It still applies and is selectively acknowledged,
but cannot poison the next complete group's early-release eligibility. If retired history really
changes visible state, only the transaction receiving those pixels loses early-release eligibility;
its original refresh deadline remains the bound. Malformed active groups and ambiguous lineage
overflow retain their conservative timing behavior.
Half-range presentation IDs and cyclic serial order are also unknown, including against an
already-retired floor. They disable membership-based early release until the lineage resets;
normal one-refresh deadlines, independent row application and selective ACKs remain usable.

Transport independence, terminal application and browser presentation have distinct boundaries.
The worker copies each complete leased frame into `ClientViewer`'s WASM input and releases the
shared ring receipt after the core accepts it. Rust owns display parsing, decompression, bounded
snapshot/delta retention, FEC recovery, selective ACK production and presentation readiness.
Ahead-of-snapshot deltas retain bounded encoded bytes and replay after the snapshot applies.
Superseding snapshots retire older assembly ownership before allocating replacement state.
The worker drains the core's typed outputs and presents only a core-approved transaction.

The slice suppresses renderer submission until reconciliation completes, except for security
revocation of already-painted speculation. Isolated interactive work submits in that same task,
without another queue wake or coalescing timer. Deadline/rAF callbacks first give already-readable
work one bounded owner turn. If a control command prevents that turn, they cannot paint an old
prefix; control ownership must resolve first and then resumes the original, unchanged deadline.
Actual late execution remains measurable deadline lateness, not an extended batching interval.

Font-family network loading does not own the control pump. One abort-owned request prepares bytes
without touching the terminal; one bounded ready slot gets a synchronous commit opportunity per
four-command control slice. The commit rechecks controller, terminal and authenticated-session
identity, then parses the font and reapplies current metrics/surface geometry in the same task.
It cannot overtake queued lifecycle barriers, and newer family/lifecycle commands discard both
request and ready slot immediately. A stalled download cannot block resize, theme, viewport reads,
health checks or display/input progress. Ordinary controls return synchronously; initialization is
the sole asynchronous control barrier. This removes network head-of-line blocking, not the CPU
cost of font parsing, which remains a separate measured boundary.

The current endpoint is browser-observed WebGPU queue completion, not a physical GPU timestamp.
Immediately after every submission the renderer registers `onSubmittedWorkDone()` for that exact
identity and continues ingestion without awaiting it. All supported platforms use this path;
there is no task-yield substitute or fence-polling chain. Callback timing includes browser
observation delay and cannot establish compositor/scanout timing. Submission metrics and exact-completion metrics remain separate.

Phone measurements must separate Merkur's custom touch keyboard, native keyboard/IME,
and hardware keyboard populations. Native text timing currently starts when committed text
reaches Merkur, not at the earlier physical touch or IME processing. Record the actual
device/OS, browser versus installed-app context, visibility changes, and keyboard source
beside each capture. `run-ios-webkit-harness.ts` explicitly uses the iOS Simulator and
checks startup surfaces; it is not a physical-iPhone fast-typing benchmark.

Draw issue, prediction sync readiness, authoritative apply, submission and observed readiness
are separate populations: initial post-submission delay and its subsequent scheduler propagation
must be analyzed separately, and a main-rAF control comparison does not control GPU behavior.

No p95 gate exists for any of these sub-terms; their sum is bounded by the existing
`APPLY_TO_GPU_FENCE_P95_LIMIT_MS`. They are reported so a regression can be attributed, not gated,
because a limit set before they were ever measured would be arbitrary.

Also inspect input acknowledgement separately; it exposes transport and daemon input delays even
when local prediction hides them visually. Run the impaired suite after every queueing, pacing,
FEC, reconnect, or snapshot change. A change is acceptable only when it preserves completion
ratio and connection stability while improving or holding the interactive tail.

The micro suite includes both dense and deliberately unmatched latency traces. The latter protects
the diagnostic reporter from quadratic sparse-correlation regressions. It also exercises the
production ring-as-outbox round trip — publish, read, admit, size the datagram run, acknowledge —
including its byte/entry accounting and p50/p95/p99 batch latency, and counts the objects one
keystroke allocates on the send path.

Event-driven latency changes use complementary gates instead of timing assertions in unit tests:

| Path | Deterministic regression | Performance / felt-latency gate |
| --- | --- | --- |
| Browser terminal geometry | One floored sizing rule pinned to the same vectors from the TypeScript and Rust suites, a grid anchored at the container origin proven by the pointer hit-testing tests, and an idempotent geometry commit | `terminal-geometry-matrix` drives a one-pixel-per-step drag and requires that every geometry commit changed the grid, that the canvas never exceeds the box that measured it, and that the origin never moves; resize repaints are excluded from every latency percentile by `abandonInFlightLatencyFrame`, so no existing gate can see them |
| Viewport intent ordering | The dataplane's resize-ordering tests deliver newer direct dimensions before an older edge request to the real PTY handler, and check duplicates, invalid requests, and serial wrap; outbound queue and fresh-auth tests pin the serial lifetime | `terminal-geometry-matrix` and `transport-latency` exercise resizing and subsequent output with the real browser and dataplane |
| Browser terminal reflow | `a_viewer_reflows_a_narrowing_resize_onto_the_daemon_grid` (`display/viewer.rs`) reflows a real `term_wasm::Terminal` and the daemon's grid independently and requires them equal row for row; `term-wasm`'s own reflow tests pin that the row wrap bit, not row fullness, is what decides a join, and that the alternate screen never reflows | `terminal-geometry-matrix` reports `corrected=n/rows` on every `resize_authority_window` — the rows the daemon's frame changed relative to the worker's own rewrap, i.e. the rows a user watched change twice — and gates the p95 share of them on a narrowing drag |
| Browser worker and GPU fairness | Scheduler coalescing, cancellation, stale-generation, reentrant-submit, bounded SAB drains, authenticated ACK lineage, exact-cell prediction authority, and mismatch-rebase tests | Exact asynchronous WebGPU submission ownership is unit-tested; clean and impaired traces gate worker-handoff tails and prediction coverage. The superseded polling microbenchmark is removed. |
| Browser session ownership | Start IDs fence lifecycle events and server RPCs; superseded requests are aborted, stale replies are rejected even after ID wrap, ACK-ring lineages reject prior high-water marks, and unchanged transport hints are delivered once to every new peer | Clean/impaired reconnect and latency traces prove the new owner reaches authoritative apply and ACK without borrowing predecessor state |
| Browser reliable outbound | Rust pins each reliable Noise lane to its unfinished native write across provider changes; completion or exact retirement releases custody, and datagram retries continue independently | Shared core and native credit regressions prove writer FIFO, independent ACK progress, exact unsent suffix handoff and retirement release; clean/impaired traces gate actual queue-to-wire progress |
| Browser display-gap scheduling | One indexed min-heap owns each missing sequence, supports in-place deadline updates, and is disposed with its session generation | Saturation tests prove bounded heap cardinality and stale-deadline rejection |
| Browser device events | Offline state parks the stream with no retry timer, network/visibility edges wake it immediately, only a definitive 401 may rotate the refresh credential, duplicate starters share one snapshot barrier, every attempt is bounded by a stall deadline that only the opening frame may extend until that frame arrives — bytes prove the socket, not the stream, and a server's keep-alives begin the moment it believes it has written that frame — so neither a half-open socket nor a stream that opened and delivered nothing can park it forever, and what the list says about itself is *derived* from the attempt in hand rather than assigned on each edge — a badge cannot outlive, undershoot, or contradict the stream it describes | SSE tests fragment events down to single bytes and enforce the memory bound; `web/sse-incremental-parser` measures the production incremental parser; recovery tests drive a stream to silence, hold one open with keep-alive bytes alone, hang a request that never answers, and require that a cleared error hands the badge straight back; `device-list-updates` takes six real terminal round trips and requires the list to be live again after each |
| Distributed daemon presence | Redis claim-generation deadlines and Lua CAS make lease renewal, explicit disconnect, silent expiry, and multi-instance contention exactly once; pub/sub is primary and an empty-index-only watchdog closes the durable lost-wake window | Multi-instance fake-clock tests plus live Redis integration require one online/offline transition and prove a raw deadline written without any local/pub-sub wake is observed within the watchdog bound |
| Session issue/cancel | Unique command IDs, fenced presence, replica-addressed Redis pub/sub, bounded WSS queues, and daemon acknowledgements make accepted delivery explicit; commands are ephemeral and never replayed after reconnect | Cross-replica delivery, stale-fence rejection, crash/ack ambiguity, publication loss, backpressure, cancellation races, and bounded timeout tests |
| Server edge selection | The registry test requires one atomic Redis `EVAL`, including stale-entry pruning | Real edge topology and transport suites exercise replica selection; a fake-Redis microsecond number is intentionally not treated as network latency |
| Edge half-pair expiry | The cleanup worker must stay asleep while idle and wake directly on an attach transition | Edge service verification covers the worker; expiration is control-plane cleanup and is kept out of interactive throughput scores |
| Edge reliable lanes | Per-channel stream ownership, record writes, and partial reads are generation-owned and deadline-bounded; an idle STOP, ambiguous failure, FIN, reset, or malformed record closes once with no lane reopen | Edge unit tests cover stalled operations, fixed-buffer forwarding, bounded ownership, and stale completion; clean/impaired transport runs prove CTRL remains isolated from display-flood backpressure |
| Dataplane IPC, PTY, display recovery, and owner-loop fairness | Writer close/admission wakeups, paced bulk-input boundaries, reliable flush bounds, pruned-provenance snapshots, snapshot input provenance, blocking PTY FIFO/completion accounting, the 320 KiB shared byte cap, carrier-generation fencing, and parked-identity retirement are exact assertions | Dataplane service verification plus sustained clean/impaired transport runs catch starvation, stale display tails, stale ingress, immortal relay renewals, memory growth, and input-ACK tail regressions |
| Daemon-control backpressure | A bounded outbound queue rejects overload, each `commandId` owns one acknowledgement deadline, and connection/presence fences prevent stale sockets from completing a replacement's command | Server and daemon service verification cover queue limits, acknowledgement timeout, reconnect, supersession, and stale-result rejection; transport E2E proves a newly dispatched command succeeds after recovery |
| Direct-WebTransport rotation | The retiring server returns a bounded exact connection-identity set; the owner immediately demotes only old direct paths and cannot touch a newer replacement | Dataplane rotation and stale-A-after-B tests cover the handoff; real transport E2E exercises certificate/path recovery |

For browser main-thread or GPU regressions, use the Playwright trace and terminal event attachment.
For Bun CPU/allocation regressions, use the generated CPU/heap artifacts. For Rust kernels, use
the Criterion reports produced by `profile:full`. For long-lived regressions, compare maximum RSS
and tail metrics across `profile:soak`, then run a sustained real transport session because
repeated process launches cannot detect every in-process leak.

Rust and terminal WASM builds are pinned by `rust-toolchain.toml`. The WASM build ignores an
ambient `RUSTUP_TOOLCHAIN` and uses that exact release unless
`MERKUR_RUST_TOOLCHAIN` is deliberately set for a migration experiment.

### Adaptive scalar display recovery

One-row typing updates start as one datagram. Proven path loss promotes them to same-path replay of
the exact sealed bytes; censored replicated ACKs cannot demote the policy, so sparse rowless probes
provide the clean evidence. Groups of two through four retain FEC, but choose two, one, or zero
recovery shards from the current maximum shard width so a repair never crosses the datagram ceiling
and never enters the reliable lane. The sender's physical budget includes data, replicas, probes,
and repair. The deterministic simulator keys stochastic loss to sender-stable generation, logical
data ordinal, path, role, and retransmission attempt, so adding a replica does not change which
data frames the paired control arm loses.

The fixed-seed production-path matrix covers 50, 120, and 200 ms RTT; 0%, 1%, 5%, and 10% loss; and
solo typing plus typing during output; it asserts that adaptive replay admits fewer bytes than
unconditional replay in every cell, leaves p90 unchanged, and applies every clean key in one RTT.

The ignored statistical companion pools 1,536 keys per cell over 64 paired loss seeds. The trade
is explicit at the unprotected first loss: an isolated solo key can pay a whole extra RTT that the
unconditional arm does not. That tail is not hidden as a win; it is the price of avoiding a
permanent 2x clean scalar wire tax before the carrier supplies loss evidence. Exact-fault tests
separately prove FEC reconstruction, loss of both a scalar data copy and its replica, clean-probe
demotion, physical queue accounting, and rejection of stale scalar repair.

## Against Mosh

Measured with the `v0.60.2` release on one Apple Silicon Mac; the recorded run and its limits
are in the private ledger entry "Keystroke-to-paint on v0.60.2 and a side-by-side against Mosh".

Both sides type one character every 250 ms into a shell line editor with prediction disabled
and record when the confirmed echo comes back. Merkur is the `transport-latency` spec through
the local edge harness (`EDGE_NETWORK_PROFILE=typical` is 120 ms RTT, moderate reordering,
exact-rate datagram loss at one fault site); the figure is `inputToDisplayPaintMs`, the
browser-observed WebGPU queue completion of the authoritative echo. Mosh 1.4.0 runs
`mosh-server` and `mosh-client` in one Debian container with `tc qdisc add dev lo root netem
delay 60ms loss N% reorder 5%`, the client under a pty, `MOSH_PREDICTION_DISPLAY=never`; the
figure is the echoed byte arriving in the client pty, before any terminal draws it. The two
impairments are not byte-identical, and Mosh's number excludes its own rendering while Merkur's
includes decode, draw, and the GPU fence, so the comparison leans against Merkur.

Confirmed echo at 120 ms RTT, milliseconds, 192 keys per Merkur cell and 200 per Mosh cell:

| Loss | Mosh p50 / p95 / p99 / max | Merkur p50 / p95 / p99 / max |
| --- | --- | --- |
| 0 % | 140 / 144 / 145 / 153 | 135 / 151 / 159 / 160 |
| 3 % | 139 / 168 / 445 / 503 | 137 / 156 / 169 / 174 |
| 9 % | 140 / 378 / 459 / 551 | 147 / 229 / 262 / 275 |

The median is the round trip on both sides. The tail is where they differ: Mosh waits on its
retransmit timer, so one lost packet costs 300 to 400 ms, while Merkur replays a lost echo on
the path that lost it and bounds the cost to about one extra round trip. `fecRecoveredReceivedDatagramCount`
is zero in every run: a typed echo is one datagram and is protected by replay, not by FEC, which
only forms groups over multi-datagram bursts. At 9 % the `transport-latency` spec's own
acceptance gate (authoritative receive p95 at or under 200 ms) fails, so that row is a
measurement, not a passing gate; one of the three 9 % variants aborted at prediction priming and
is excluded.

With prediction on, both paint before the round trip: Mosh's local echo lands in the pty in
0.1 ms, Merkur's predicted glyph reaches the GPU fence in 1.0 ms p50 (1.1 ms on loopback,
88 % coverage; 100 % under the impaired profile). On loopback Mosh's confirmed echo is 14.3 ms
p50 against Merkur's 1.8 ms, which is Mosh's own scheduling rather than the network.

To reproduce the Merkur side, run each profile once with
`PW_E2E_OUTPUT_DIR=<dir> EDGE_PORT=14433 EDGE_NETWORK_PROFILE=typical EDGE_NETWORK_DATAGRAM_LOSS_PERCENT=<0|3|9> EDGE_NETWORK_REORDER=moderate bun run scripts/run-edge-harness.ts transport-latency.e2e.ts --workers=1`
and read `report.inputToDisplayPaintMs` from the `[pristine]` variant's
`terminal-latency-summary.json`. A `[harness-invalid]` line means a native artifact changed
during the run; discard it. For the Mosh side, `mosh-server new -i 127.0.0.1 -p 60001 -- bash
--norc` prints the key, `mosh-client 127.0.0.1 60001` needs a pty with a window size set, and the
per-key timestamps come from writing one distinct letter and waiting for it to appear in the
client's output.

## Correlating terminal surfaces with Chromium presentation

The bounded `DIRECT_GPU_TRACE=1` tmux diagnostic is causality evidence only; tracing
invalidates latency-acceptance eligibility. Its native trace buffer is 64 MiB and its
expanded JSON limit is 256 MiB. Missing EOF, native loss/full reports, invalid JSON or
missing clock/category coverage invalidate the trace. Do not increase these limits to
hide a failed capture.

Use `scripts/analyze-terminal-gpu-trace.ts` to correlate a verified, caller-identified
terminal child surface. Arguments are trace JSON, metadata JSON, frame-sink client ID,
frame-sink ID, render-end epoch milliseconds and a bounded window in milliseconds:

```sh
bun scripts/analyze-terminal-gpu-trace.ts TRACE.json METADATA.json 7 2147483648 1788634630063.73 50
```

Identify the worker's sink through its outgoing compositor Mojo flow first; a page's
root surface is not necessarily the OffscreenCanvas terminal surface. The analyzer
verifies trace bytes and clock coverage, preserves signed 64-bit IDs exactly (including
array elements), then joins child receive → exact surface aggregation → exact display-ID
draw → process-local async swap → coincident `Display::FrameDisplayed`. Missing or
ambiguous joins remain incomplete. Choosing the first nearby FrameDisplayed is wrong
when an older swap completes during the new frame's lifetime.

The same analyzer is imported by the Direct Playwright spec. Its CLI uses the shared
Bun/Node main-module guard, not `import.meta.main`, because Playwright's Node CommonJS
transform must parse imported helpers before any browser starts. A regression executes
the Bun CLI's usage boundary and collects the real Direct spec through Node Playwright
`--list`; collection starts no browser, server or native measurement.

This endpoint is a **software compositor notification**, not physical scan-out. Browser-observed
sync readiness overstates it, and neither timestamp establishes physical GPU completion or
input-to-photon latency. Serial tmux operations alone cannot establish that later dirty work was
blocked behind that sync; continuous typing/navigation must provide that evidence before changing
submission depth, and a Neovim trace's pending-work evidence does not transfer tmux's compositor
timing to Neovim or establish that a deeper queue improves final presentation.

The Direct Neovim oracle (schema 4) independently reconstructs the pinned application's
two producer-consecutive presentations: a one-row showcmd update and a dense page.
Their cross-update span is not partial exposure within one redraw. A showcmd received
after the later dense state is ready may apply nonvisually; its
`obsolete-before-receipt` outcome retains all sender membership but has no invented
render or readiness timestamp. This evidence establishes ordering and nonvisual
application, not which exact row overwrote another. Dense latency always retains all
100 navigation windows; showcmd readiness reports its actual rendered population and
separate obsolete count. Complete supplemental nonvisual groups and header-only
nonmembers stay in the serial/generation census, including across sequence wrap.

Every actual render must have exact raw apply → start → end → commit → readiness
ownership, even when timestamps tie. Missing membership, extra unowned submissions,
invalidated steady-workload completions and unresolved publication debt cannot pass.
Evidence-integrity eligibility and the executed performance gate result are recorded
separately. An incomplete reconstruction never reports a passing performance gate. A complete but
slow run retains its raw tails and an explicit failed gate. Diagnostic tracing remains
ineligible for timing acceptance irrespective of either result.

## Adding a Benchmark

Transport E2E tests explicitly use Playwright's `chromium` channel, including in
headless mode, so both headed and headless runs select the full Chromium binary.
The omitted-channel headless default selects **Headless Shell**, a different
executable that can report the same version. Record and verify the executable and
complete browser bundle before and after comparative runs; hashing full Chrome
does not establish the identity of a Headless Shell run. Headless full-browser
readiness still does not measure physical scan-out or establish headed-browser
equivalence.

A benchmark must use production code where possible, validate its result, and emit one or more
framed metrics with `emitPerfMetric` from `scripts/perf/harness.ts`. Give each metric an explicit
unit and `higher` or `lower` direction. Add the workload to `scripts/profile-project.ts` with a
realistic timeout and honest fidelity label. Keep setup outside the timed region and batch
sub-microsecond operations so clock overhead does not dominate.

Every benchmark change should include a deterministic test for its statistics or parser logic.
Pin wire-layout constants in shared code instead of duplicating offsets in benchmark generators.

### Fast-typing cadence diagnostics

The Direct input harness includes 100 ms/key (nominally 120 WPM at five characters
per word), alongside 0/8/16/33/80 ms. These are regular synthetic inputs; zero
delay is overload, not human typing. Actual browser input timestamps, not the
requested delay, define observed cadence. Each phase still contains six separate
20-printable/20-Backspace cycles, with 120 inputs per class; it is not a long-line,
wrap, irregular-burst or Neovim-insert workload.

`direct-typing-<cadence>ms-cadence.json` retains every per-input latency sample,
class-specific stage distributions, and the 114 adjacent pairs within each
class's six runs. `latencyGrowthMs = endpointGapMs - inputGapMs` distinguishes
constant RTT from uneven feedback. Positive growth exceeding the independently
calibrated refresh period and negative catch-up intervals are diagnostic counts,
not measured dropped frames or acceptance gates. Missing endpoints never become
zero latency, and pairs never bridge missing observations or class/run boundaries.
Equal timestamps do not prove shared renderer ownership or transport batching.

Worker prediction submission, predicted GPU queue completion, authoritative readiness,
and ACK progress remain separate. Per-input render-stage durations describe
`inputToDisplayPaintMs`; they may belong to an earlier header render than
`inputToAuthoritativeVisualFenceMs`. Attribute a visual tail only after checking
exact render/commit identities. Null fence/floor gate durations may simply mean
an immediate render. None of these endpoints measures compositor visibility or
physical photons.

The diagnostic runs after capture, adds no production per-key messages or timers,
records no input text, and preserves all speculation security gates. Its raw
artifact hash and parent report identify the evidence; parent recorder, network,
replay or capture failures cannot be upgraded by this diagnostic.

## Server coordination cost

The server uses reusable untraced Effect builders for request orchestration and issuance state
transitions. Fixed identity query shapes compile at service construction; execution still reads
SQL on each authorization rather than caching revocable identity state. A single-chunk daemon
body is hashed and decoded from its original buffer without concatenation.

Hashing in server services, edge registration and CSP generation uses `Bun.CryptoHasher`,
retaining the exact algorithms, transcript bytes and digest encodings. One-shot hashes use
its static API; multipart transcripts use incremental updates. Redis script identities and
verification content keys remain byte-identical.
Daemon binary file reads use `Bun.file().bytes()` without copying a Node buffer into a second
typed array. Text reads retain Node's UTF-8 decoding, which preserves a leading BOM for strict
JSON, lock ownership and existing shell-file contents. Permission-sensitive writes, exclusive
creation, atomic rename, file sync and bounded asynchronous gzip decompression retain the APIs
that supply those guarantees.

Presence waiters share the account's Redis device-event subscription. Matching presence events
and resync signals complete their Deferred directly, without launching a notification fiber.
The subscribe-before-read barrier prevents a daemon registration from slipping between the
presence read and its wake subscription. Daemon pings remain synchronous bookkeeping outside
Effect, SQL and Redis work.

`apps/server/scripts/bench-daemon-requests.ts` measures request orchestration with fixture
infrastructure and reports live JavaScriptCore heap cells, not bytes or native allocations.
`apps/server/scripts/bench-daemon-control.ts` measures the production control-loop code with
fixture sockets; its results describe local work, not network or production request latency.

## Browser session presence

Browser activity reuses the authenticated device-event SSE connection across terminal
navigation. Presence bootstraps alongside the device snapshot, without adding a serial
Redis round trip to first device-list paint. First/last-tab transitions publish absolute
account-scoped presence snapshots. There is no browser heartbeat endpoint, periodic
session-list fetch, or per-client Redis lease renewal.

A server replica renews one 45-second lease every 15 seconds and checks for expired
replicas. Idle cost is two Redis script calls per replica per cycle regardless of client
count. Membership writes happen on connect/disconnect; crash cleanup retires at most
128 connections per atomic removal, yielding between batches. Every accessed key is
declared for Dragonfly shard locking. Cleanup first discovers an expired replica and
peeks at up to 128 memberships, then removes them atomically with the discovered account
keys declared. Failed discovery cannot lose records; concurrent sweeps and late closes
are fenced by set membership. Sequence filtering prevents
a late opening snapshot from overwriting a newer pub/sub update. Reconnects discard
unconfirmed browser presence.

Cross-replica tests cover shared delegations, account isolation, idempotent closes, and crash
cleanup across multiple batches. The command-count validation runs against disposable Dragonfly; it is not a throughput or
latency benchmark.

## Link-status waveform work budget

The waveform's publication cadence is driven by its content, never by a clock of
its own. A terminal byte (`pty`, the two display lanes, the display
acknowledgement) publishes; the 60 ms cadence continues only while that traffic
is still inside the widest visible strip, then one publication shows the empty
strip and the worker parks with no timer armed. Control, signaling and framing
bytes, the heartbeat included, reach the totals and never wake the strip, so a
connected idle session publishes nothing. Empty columns scroll history out
normally; there is no idle freeze or whole-history expiry, and no idle cadence
either. Wire callbacks increment totals unconditionally, but timestamp and bucket
traffic only with an active visible subscriber. Its fixed producer ring and one
outstanding publication bound retained history and queued work during a
main-thread stall. Acknowledgement releases publication credit; it never gates
input, display, or transport ACKs. Main coalesces snapshots into one rAF and paints
a settled total from its timer without a frame. Cached heights avoid rescaling
unchanged bytes; text deadlines do not move the history.

`apps/web/src/components/link-strip.test.ts` drives the production publisher,
series and scheduler with a deterministic clock. It checks source-time gaps,
hidden-feed parking, parking after scroll-out, deferred publication from the wire
callback, the channel selection, stale subscription/start credit, bounded
delivery, final settlement, the frame-free text deadline, and separate text/canvas
work. The worker-client tests cover subscriber ownership, the widest-strip horizon,
old-session delivery, and the absence of keystroke/quality-triggered activity
callbacks. `tests/e2e/client-idle-work.e2e.ts` is the browser gate: a connected
idle terminal in the production build, telemetry off, must run zero main-thread
animation frames, WebGL draws, waveform canvas fills and waveform publications
across an eight-second window, after two control phases prove each counter moves.
`tests/e2e/terminal.e2e.ts` gates the other side: live terminal output must paint
bars off the strip's baseline. The worker's ticks and main's columns share
`linkActivityNow`; `performance.now()` alone counts from each realm's own origin,
which leaves every bin off-screen. These are work-count and correctness oracles, not power measurements. Device
energy claims require controlled on-device comparisons of idle, typing, sustained
output, and hidden-tab workloads at fixed display brightness.

## Native send-storage ownership

Display datagrams seal into immutable pooled `Bytes` owners. Carrier admission
clones the owner, not the ciphertext; each WebTransport carrier queues its own
HTTP/3 quarter-stream-id prefix separately. Quinn writes prefix and payload into
the encrypted packet at packetization. That packet assembly remains a copy;
"zero copy" here means removing the intermediate display-to-transport envelope.
Retransmission row/frame storage and selective ACK semantics are unchanged.

The per-peer pool retains at most 128 KiB of ciphertext payload and 256 owners
(plus bounded owner metadata), lazily populated in 64-byte size classes. It
reclaims only uniquely owned storage. A rolling scan avoids repeatedly walking
the already-queued prefix of a burst. A stalled or retired carrier can retain an
owner without allowing reuse; the pool never waits for it or enlarges carrier
admission budgets. Both prefix bytes and actual Quinn entry metadata count toward
the existing exact, non-dropping queue capacity.

When the congestion window has room for a small datagram but less than one MTU,
Quinn sizes the first established-data packet to that remaining byte allowance.
The queued head must fit after conservative ACK/control/header bounds; no trial
encoding, allocation, queue reordering or datagram dropping is needed. Packet
construction and pacing use the same reduced limit, and bytes in flight cannot
exceed the existing window. Handshake, path validation, loss probes and explicitly
padded packets retain their required sizes. Stream-only bulk GSO stays unchanged.
This removes a needless ACK wait without increasing Cubic's congestion window.

A loss cuts that window only when the lost packet was sent against a full window, with no
room behind it for another full-size packet. RFC 9002 already keeps an unused window from
growing on its acknowledgments; a lost packet the window did not bound says nothing about
its size either. Cutting on such losses walked an application-limited typing flow on a
lossy link down to the two-packet minimum, one erasure at a time, until fast typing queued
keystrokes behind the window for an acknowledgment round trip. A window-limited flight is
cut as before, and persistent congestion still collapses the window.

A browser carrier that replaces its predecessor resumes the capacity the predecessor
demonstrated (RFC 9959 Careful Resume, `congestion/careful_resume.rs` in `quinn-proto-patch`).
Every connection records the most bytes one round trip delivered while some packet of the
round found the window full. When a successor attaches to the same lane, the edge hands it
that observation, capped by the predecessor's window; Quinn refuses it unless the browser and
edge addresses match. The successor confirms its path under the initial window, then jumps to
half the observation, paced at that window per current RTT in bursts no larger than the
initial window. It keeps the flight the jump validated, or halves the validated pipe if any of
it was lost. The jump waits for a backlog beyond the whole window: the edge relays what the
daemon sends, so the first window-full moment after a rebind is the echo of the command being
typed, and a jump taken then expires one round trip before the frame it was for arrives. With
that wait, a 200×60 styled redraw right after a rebind leaves the edge 65 ms sooner at 120 ms
RTT (98 % of its packets, 470 → 405 ms) and 70 ms sooner at 200 ms, with no added loss.

Loss detection learns reordering from proof. A packet declared lost that the peer later
acknowledges was reordered, not lost: packet numbers are never reused, so the acknowledgment
is unambiguous. The path's packet threshold rises to the distance that declaration crossed,
and its time threshold to cover that packet's round trip, at most twice the RTT (RFC 8985's
bound of one SRTT on the reordering window). The packet's stream data counts as acknowledged,
which drops a retransmission still queued, and it leaves the loss count every consumer reads.

Reliable send queues release acknowledged payloads immediately but retain eight
`Bytes` slots (256 bytes on 64-bit targets). Large queues shrink once per ACK
operation only below quarter occupancy; fully acknowledged bursts clear their
owners in bulk instead of walking every segment's length. The dictionary worker keeps its
split samples, their lengths and its split scratch across builds, so a steady session builds
without reallocating; the finalized dictionary still requires its own allocation.

The ignored release tests `owned_display_admission_profile` and
`retained_segments_profile` retain the prior
implementation as test-only negative controls, interleave paired timings, and
check ownership/output invariants. The display profile includes actual Noise
sealing, pool selection and real WebTransport admission, not network delivery
or input-to-photon time. Run timing profiles without concurrent builds/tests.
Prediction reconciliation treats an exact unchanged base as a zero-operation echo prefix.
A repeated absolute row may refresh cell revisions before a header advertises a later PTY
write; those revisions do not prove that write has echoed. Matching base cursor and affected
cells defer reconciliation without confirmation, while changed cells still take the mismatch
path and the existing lifetime bounds the wait. Targeted regression cases cover one and multiple
pending edits, a contradictory pending suffix, and expiry. Independently delivered rows and
headers can also show different known operation prefixes. The coupled-prefix check remains the
usual path; only a failed coupled check replays the bounded log to establish independent row
and cursor evidence, checking the entire affected cell span. Such a split receipt defers without
confirmation and cannot extend the original prediction lifetime. Its committed presentation
certificate survives later held receipts, and a presentation commit or model flush replaces it.
The warmed split-prefix check allocates nothing. Changed pending characters and security
revocation still reject. The presentation commit also republishes
the final reconciled admission model: a received prompt can remain unseedable until its rows and
anchor become presentation-eligible, and leaving main's shared snapshot at that earlier state
incorrectly withholds provenance from the first input. This publication adds no cross-thread wait.
Browser GPU queue completion
remains the measurement boundary, with no physical input-to-photon claim.

Browser reliable records copy from WASM into JS-owned arrays before asynchronous publication.
Independent output allocations within one WASM memory are insufficient ownership:
`memory.grow()` detaches existing non-shared views, including records queued behind a writer.
The carrier constructs an owned framed record and retains it through its native write promise.
Each reliable crypto lane keeps counter custody across provider changes until the owning write
completes or its carrier retires. Queued records preserve that lane's order; datagram cipher
counters remain independent. A replacement provider cannot advance that lane while an earlier
record is still owned by its asynchronous writer. Native write completion establishes local
carrier admission; remote delivery is a separate network verification boundary.


## Edge datagram routing

Each attachment gets a stable route to its session's authoritative peer pair. Per-datagram work
does not hash the session label or acquire the global registry lock. Source validation,
current-destination selection and bounded mailbox admission are one session-local read-lock
transaction. Lifecycle writers update that same pair; slot destruction clears senders even if old
route handles survive. Reliable watches and budgets stay slot-owned, and all expiry paths name
retirement. The cold cost is one routing-cell allocation per session, and the 256-frame mailbox
remains in place.

## Authenticated Linux edge profiling

`bun run profile:edge:prepare -- --output /tmp/merkur-edge-profile-build` prepares the
release edge, the feature-gated authenticated peer and the independent Aya collector,
with a receipt binding source, compiler, build commands and executable hashes.
[`tools/edge-kernel-profile`](../tools/edge-kernel-profile/README.md) documents Linux
permissions, samply installation and the complete recording commands. The fixture uses
production WebTransport attachment tickets and validates both relay legs. Its local
registration service supplies fresh fixture credentials; it does not exercise account
login, Noise, a PTY or browser presentation.

`bun run profile:edge:linux` records typing, concurrent sessions, mixed-size bursts and
persistent reliable streams. Acceptance runs use no profiler. Every offered frame must
arrive with its expected identity and bytes; raw observations independently reproduce
p50/p95/p99. Separate baseline receipts permit alternating ABBA/BAAB comparisons with
identical authenticated peers. Process CPU and RSS are recorded with their measurement
scope and resolution. Missing work or invalid provenance fails the run.

Aya reports bounded, edge-filtered syscall wall durations, off-CPU intervals and observed
wake-to-run delays. Blocking time is not kernel CPU attribution. Samply supplies edge CPU
stacks; absent target samples fail capture. A VM without a hardware PMU may use software
CPU-clock sampling, but a VM run does not establish physical-host or production network
performance. Instrumented captures remain diagnostic and cannot supply acceptance tails.

An io_uring experiment requires representative Linux evidence of removable socket work.
It must preserve GSO/GRO metadata, immediate isolated-packet delivery, lifecycle ownership,
bounded buffers and bounded work per poll. Alternating uninstrumented trials must deliver
equal work and improve latency tails without regressing typing or reliable traffic. The
relay never waits to fill a batch. No io_uring transport is selected by the profiler.

## Native terminal presentation

The native terminal client shares the authenticated session and display viewer with the
browser. It separates host writes from each tab's transport reactor. The UI composes only
changed cells and maintains one outstanding host-consumption query. Changed state composes
as soon as the previous frame is consumed; ready work does not register a timer. Grant-only
refreshes and redraw/repair frame bounds retain a 60 Hz maintenance cadence. Partial writes
preserve their offset while input and display grants continue. Graphics raster preparation
runs on a lazy worker, and uploads require host acknowledgements before
replacement placements become visible.

Native carrier and UI deliveries retain count and byte reservations through every forwarding
queue; enqueueing to a second queue does not release their original credit. Control, display
and ACK/heartbeat ingress have separate admission budgets. Filtered QUIC dequeue allows a
pulse to pass buffered display packets without an application copy or discard. The exact
ownership and budgets are in [the process map](processes.md#native-terminal-client).
Reliable writer reservations survive the actual stream write. One blocked writer retains one
unfinished record and pins its reliable Noise lane across provider changes, even when its
queue has free credit. Input datagrams, authenticated ACKs and other crypto lanes continue;
retiring that carrier drops its pending reservations immediately. Control-producing work waits for its
writer, and fixed latest facts and repair-row membership remain bounded in the shared session.
The authenticated interactive fixture reports 64 serial authoritative echoes from a remote
raw-mode program into an independently interpreted ANSI host grid. Prediction cannot
satisfy these markers. It verifies the actual Direct or Relay footer for every sample and
retains the raw samples and lower sample quantiles as a JSON attachment. Set
`MERKUR_TUI_BENCHMARK_BASELINE` to an independently retained executable to run three
alternating baseline/current pairs against the same linked fixture. This endpoint includes
the controlling-PTY bridge and parser; it does not measure physical scanout.

These bounds establish memory and scheduling behavior; host query consumption establishes
terminal acceptance of a frame. Neither proves physical scanout latency. Compare native and
browser presentation only with authenticated peers and the actual host terminal or browser.
