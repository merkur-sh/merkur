# Observability

This document explains how Merkur is observed: the structured logs every process writes, the
opt-in diagnostics a browser posts, the health routes and OTLP export of the application
server, the health snapshot and performance report of the daemon (the process on a user's
machine that owns the terminal), and the telemetry of the edge (Merkur's blind relay). It
ends with the semantics that apply to every metric.

Three kinds of signal exist, and each answers a different question:

| Signal | Answers | Produced by |
| --- | --- | --- |
| Structured logs | What did this process do, in order | server, daemon, edge, STUN responder |
| Browser diagnostics | What did one opted-in session experience | browser, relayed by the server |
| Metrics and spans | How is the fleet doing, and why was one request slow | server (own), daemon and edge (own spans), browser reports turned into server metrics |

Two rules shape all of it. **Nothing here sits in the terminal hot path.** Keystrokes and
display frames flow between browser and daemon through sealed WebTransport frames; no span,
log line, or metric update is taken per frame on that path. The daemon's Rust dataplane
reports numbers over IPC on a slow cadence and the browser writes fixed-size records into
shared memory. **No vendor credential reaches a user's machine.** A daemon runs on a user's
machine and a browser is one, so neither holds an ingest token. Both reach the backend only
through a Merkur server endpoint that holds the token for them.

Observability is diagnostic only. An export or log-sink failure never changes service
lifecycle. Health supervision is separate: it can make the server unready or stop a critical
fiber when an internal invariant fails.

The STUN responder (`apps/stun`) is reachable by anyone, so it exports nothing. It logs one
coarse counter line every five minutes: requests served and drops by reason. What its
behaviour decides is visible on the daemon side through the `merkur_daemon_nat_*` and
`merkur_browser_upgrade_*` metrics below.

Contents: [Structured Logs](#structured-logs), [Browser Diagnostics](#browser-diagnostics),
[Server Health Routes](#server-health-routes), [Server OTLP Export](#server-otlp-export),
[Daemon Health And Metrics](#daemon-health-and-metrics), [Edge Telemetry](#edge-telemetry),
[Native boundary capture](#native-boundary-capture), [Metric semantics](#metric-semantics).

## Structured Logs

Logs are the one signal every process has, including a daemon whose server is unreachable.
The shared TypeScript logger (`packages/logger`) writes one JSON object per line to stdout.

| Field | Meaning |
| --- | --- |
| `ts`, `level`, `scope`, `message` | Always present. `level` is `info`, `warn`, or `error`. |
| `context` | Structured detail, redacted recursively (below). |
| `fiberId`, `spans` | Effect-native records only. `spans` is elapsed milliseconds per `Effect.withLogSpan` label, not a span identity. |
| `traceId`, `spanId` | Present only when the record is logged inside a fiber that has a span. |

`traceId` is read from the fiber's current span, the same source the OTLP logger uses, so a
stdout line and its exported twin agree about their trace. A record logged outside any span
(a Redis event handler, a WebSocket lifecycle hook, the SSE stream fiber) carries no trace
id. Those sites are connection- or process-scoped, and an invented id would be worse than
none.

Redaction is by key pattern and by value scan. A context key matching credential, cookie,
password, private key, secret, seed, token, authorization, API key, decapsulation key, HMAC,
pairing code or root, or PSK is replaced with `<redacted>` (`packages/logger/src/sink.ts`).
Bearer values, URL user information, and sensitive query parameters inside strings are also
scrubbed.

`LOG_LEVEL` sets the threshold for the server and daemon: `info`, `warn`, `error`, or
`silent`. It defaults to `info`. An unknown value emits all three levels rather than failing
startup.

Where each process writes:

| Process | Destination |
| --- | --- |
| Server | stdout JSON. With OTLP export on, every level is also exported, including the synchronous `createLogger(...).error()` sites, which route through an injectable sink registered in `apps/server/src/index.ts`. A sink that throws falls back to a direct stdout write. |
| Daemon | stdout JSON, including the periodic `daemon_health_snapshot` record. |
| Edge | Rust `tracing` formatter controlled by `RUST_LOG`, plus an OTLP log bridge for `merkur_edge` events when edge telemetry is configured. |
| STUN responder | The five-minute counter line only. |

## Browser Diagnostics

The browser is a user's machine, so it runs no tracer and exports no OTLP. It posts a small
set of reports to Merkur's own `/api/telemetry/*` routes, all behind one opt-in switch, and
keeps its detailed diagnostics in the DevTools console where only the person debugging sees
them. Every `/api/*` request also carries a W3C `traceparent`, minted per request, so the
server's work for that request is one trace; this is a trace identity only, never a span.

### The switch

Every browser telemetry surface is off by default. The switch is "Performance reporting" on
the Account tab of Settings (`apps/web/src/screens/AccountSettings.tsx`), stored in
`localStorage` under `merkur:telemetry-enabled` and owned by
`apps/web/src/perf/telemetry-preference.ts`. One boolean gates four surfaces:

| Surface | Route | Installed |
| --- | --- | --- |
| Link report | `POST /api/telemetry/link` | With the session |
| Direct-upgrade report | `POST /api/telemetry/upgrade` | With the session |
| Profiling rows and derived bootstrap spans | `POST /api/telemetry/perf`, `POST /api/telemetry/traces` | With the next terminal session, because workers latch the flag at init |
| Failure report | `POST /api/telemetry/error` | At page load, so a session that never starts is still reported |

Turning the switch off discards the partial window rather than posting it. Because
reporting is opt-in, every `merkur_browser_*` metric describes opted-in sessions only. None
is a fleet denominator, and a drop in volume is as likely a preference change as a
regression.

### The link report and the upgrade report

The link report says how a working session feels. One report is posted per transport
heartbeat projection (`TRANSPORT_HEARTBEAT_INTERVAL_MS`, 2 s), plus a flush when the page is
hidden and on teardown. One request is in flight at a time; projections that arrive while a
send is outstanding fold into the next report, which then carries `sampleCount > 1`. A
failed send is dropped, never retried, because a retry double-counts. The sample is built on
the main thread from fields that already cross the worker boundary
(`apps/web/src/perf/link-quality-aggregator.ts`): `rttMs`, `inputAckRttMs`, `path`,
`linkState`, `degraded`, and cumulative `txBytes` and `rxBytes`. Paint timing is not in this
body; the profiling rows carry the events it would be derived from.

A sample is `degraded` when a display snapshot was requested within the last
`RESYNC_DEGRADE_WINDOW_MS` (5 s, `apps/web/src/session/session-state.ts`). A snapshot
request means the browser abandoned its display lineage and the daemon re-sends the whole
screen, the cheapest proxy for "this link is visibly misbehaving". Row-level repair does
not set it.

The upgrade report says what became of one direct-WebTransport race, the optional path
that bypasses the edge. A race dials only endpoints its network has not tried, and one that
dialed nothing posts nothing, so every report is new evidence. Every field is a member of a
closed union; no address, port, host name, or duration crosses. The report carries one entry per offered candidate with a
disposition:

| Disposition | Meaning |
| --- | --- |
| `not_dialled` | The race ended before this candidate's stagger timer fired. |
| `no_settle` | Dialled and still pending when selection ended. Possibly filtered. |
| `refused`, `tls_rejected`, `closed_during_connect`, `other` | Failed, classified from the browser's error. |
| `ready_lost_race` | Connected; another candidate measured faster. |
| `ready_upgrade_failed` | Connected, and Merkur's own admission failed. A bug, not a network verdict. |
| `won` | Carried traffic. |

A browser cannot tell a firewall from a daemon that is not listening. The daemon's
performance report (below) carries the other half: connections that reached its direct
listener from an address one of its own offers named, from any other address, and how many
completed the upgrade. Browsers reporting `no_settle` while the daemon's expected arrivals
stay at zero is filtering; expected arrivals without admissions is a Merkur bug.

### Profiling rows

Profiling rows are the fine-grained record of one session: one row per keystroke, display
frame, render, and resync. The design rule is that the threads being profiled do no
profiling work beyond a few typed-array stores.

Producers write fixed 128-byte records into one `SharedArrayBuffer` ring per thread
(terminal worker, transport worker, main thread; `apps/web/src/perf/perf-ring.ts`). A full
ring overwrites its oldest records rather than refusing a write, and the reader reports the
loss as data. Records carry numbers only: every enum is a closed union encoded as a small
integer, and the three free-form strings (`deviceId`, `merkurSessionId`, `reason`) are
interned in a 64-slot shared string table.

A dedicated telemetry worker (`apps/web/src/telemetry-worker.ts`) drains the three rings,
decodes, sorts, and POSTs gzip-compressed NDJSON. Shipping is backlog-driven: a full
request's worth of rows is posted the moment a drain finds it, and a timer carries only the
partial tail.

| Quantity | Value |
| --- | --- |
| Records per ring | 65,536 (`PERF_RING_DEFAULT_RECORDS`) |
| Rows per request | 1,000 |
| Pending queue | 196,608 rows (three full rings); overflow is reported as `pendingRowsDropped` |
| Tail drain interval | 2 s |
| Per-session byte budget | 2 GiB (`TELEMETRY_SESSION_BYTE_BUDGET`), charged on compressed bodies of rows and bootstrap spans; export stops when it is exhausted and the preference says so |

The server decompresses with a bound on the expanded size and relays rows verbatim to the
backend's native ingest API, not OTLP. Rows are not metrics: per-render cardinality has no
place in a registry with no eviction path.

Every shipped row carries three join keys, stamped in the telemetry worker
(`apps/web/src/perf/perf-session-stamp.ts`) rather than written by every producer:

| Key | Joins to |
| --- | --- |
| `merkur_session_id` | `merkur.session.id` on server and daemon spans; the edge routing ID after removing its exact lane suffix |
| `merkur_version` | The browser build that emitted the row. It matches `service.version` on server spans because web and server ship from one image. It never names the daemon; join to daemon spans for that. A source run reports `dev`. |
| `trace_id` | The bootstrap trace of the connect attempt that produced the row |

The session id is established by two events. `session_start` is written when the session
begins, before the server has issued anything, and is a hard boundary: everything older is
discarded. `session_bound` announces the real id when the transport worker connects. Rows
between the two are back-filled within a batch.

The complete field set a row can carry is declared in `apps/web/src/perf/perf-row.ts` and
pinned by test in both directions, because the backend counts a field the first time it
sees one. A few derived quantities are worth knowing how to read:

- **Keystroke residual.** `input_ack` carries `network_rtt_ms`, the windowed minimum of the
  heartbeat RTT (`RTT_FLOOR_WINDOW_MS`, 8 s). `(ack.at_ms - sent.at_ms) - network_rtt_ms`
  is an upper bound on the non-network cost of that keystroke. The field is absent, never
  zero, when unmeasured.
- **Resyncs.** `display_resync` is written each time the terminal worker abandons its
  lineage, with a closed `resync_reason` and `already_pending` for repeat entries.
- **Display loss per path.** `display_datagrams_received`, `_recovered_by_fec`, and
  `_declared_lost` are disjoint outcomes and sum to the classified denominator;
  `_outcome_unknown` is censoring and is excluded from it.
- **The daemon segment.** `daemon_timing` rows split the daemon's share of a keystroke
  round trip into ten contiguous microsecond terms defined in
  `apps/daemon/dataplane/src/perf_timing.rs`, carried as durations, never timestamps,
  because the two clocks share no origin. The segment is complete only when
  `daemon_display_dropped_total` is zero and the attributed totals equal the decoded record
  count; otherwise its numbers are diagnostic, not evidence.
- **Relay carrier death.** `carrier_recovery` rows carry every phase of a recovery,
  including how each speculative dial ended (`standby_ready`, `dial_failed`,
  `dial_retired`) and `first_ack`, the first input acknowledgement after a
  `dial_started`, which is the exact end of the stall that dial answered. `carrier_closed`
  records each edge connection of the session closing: `carrier_lane` (`signaling`,
  `interactive`, `bulk`), `carrier_close_source` (`clean`, `session`, `stream`, `other`),
  `carrier_close_code`, and its lifetime in `duration_ms`. `session_bound` carries
  `browser_network_type` and `browser_effective_type` from `navigator.connection` where the
  browser exposes them, else `unavailable`. These rows ship over HTTPS, so they survive the
  carrier they describe; the edge's detach record (below) is the other half.
- **Recovery attempts.** `recovery_outcome` emits once per attempt, including startups that
  never reach `session_bound`. It carries `owner_id`, `attempt_id`, `carrier_id`, `issuance_id`,
  and `merkur_session_id` (empty before issuance returns), `recovery_trigger`, the last
  `recovery_phase`, typed `recovery_end_reason`, and `cancellation_initiator`. Timing fields are
  `duration_ms`, `capability_remaining_ms`, `retry_index`, `backoff_delay_ms`, and
  `handshake_admission_ms`; `signaling_outcome`, `interactive_outcome`, and `bulk_outcome`
  record each native lane's observed outcome. A signaling close with `0x4d03` and
  `egress-budget` uses recovery trigger `edge-egress-budget`; paused data lanes do not start
  recovery attempts. The browser's `relay-paused` and `relay-stopped` link states use the
  existing dormant availability bucket in link-quality aggregates. Phases are `issuance_requested`, `issued`,
  `carrier_ready`, `preface_sent`, `binding_done`, `auth_queued`, `auth_written`, `session_ready`,
  and `noise_established`. The vocabulary is shared with the server's ingest validator in
  `packages/shared/src/recovery-outcome.ts`. Main records worker failure from the last delivered
  progress snapshot and deduplicates any queued completion for that same attempt. Explicit owner
  cancellation also settles any pending snapshot before worker teardown. These records use the
  existing performance opt-in and are never backfilled with a later session's identity. UUIDs
  are encoded directly in the fixed-size perf record, without consuming string-table slots.
  The flat perf schema uses 199 of the dataset's 256 field slots.
- **Presentation.** With tracing enabled, the shared Rust viewer emits `display_received` at
  successful chunk decode, `worker_display_queued` at chunk admission, and
  `worker_display_applied` once a complete frame is applied. The synchronous WASM observer
  uses the terminal worker clock; a buffered frame retains its earliest chunk decode time
  for decode-to-apply duration. The observer survives a viewer reset, while tracing is
  enabled explicitly for the new session. `worker_display_applied` says whether a frame
  mutated the screen; `presentation_commit` joins visual applies to one renderer submission
  and shares its timestamp with `render_end` so GPU completion joins the same frame.
  Authenticated input ACKs use the precise host receipt clock. `frame_complete` carries
  `completion_disposition` (`latest-submitted`, `superseded`, `invalidated`). GPU queue
  completion is readiness evidence, never physical paint.
  The same synchronous observer records `resize_authority_window` only when a complete
  authoritative frame matches the controlling viewport's latest request. Observer stages
  1–3 carry the display fields; stage 4 carries columns, rows, snapshot status, corrected
  rows and total rows. Hashes captured after local reflow measure actual row corrections;
  a retained graphics layout has no same-size guess and reports `corrected=-1`.

### Bootstrap spans

The connect path is what a user feels, and it is one trace from browser to daemon. The
attempt mints its trace context before `POST /api/sessions/request` goes out and sends it as
that request's `traceparent`, so the server's `session_request` span and the daemon's
`daemon.control.command_admission` hang below the browser's root. The telemetry worker
derives the spans (`apps/web/src/perf/bootstrap-spans.ts`) from startup milestones it has
already decoded; no main-thread instrumentation is added.

| Span | From → to |
| --- | --- |
| `browser.session.bootstrap` (root) | `device_selected` → `first_display_visible` |
| `browser.terminal.worker_boot` | `terminal_mount_requested` → `worker_ready` |
| `browser.ui.present` | `terminal_mount_requested` → `terminal_view_presented` |
| `browser.session.connect` | `transport_start` → `transport_connected` |
| `browser.display.first_frame` | `transport_connected` → `first_display_applied` |
| `browser.display.first_paint` | `first_display_applied` → `first_display_visible` |

An attempt that never reaches `first_display_visible` emits nothing rather than a truncated
tree. The spans go to `POST /api/telemetry/traces`, relayed verbatim, and count against the
same byte budget as the rows.

### The failure report

Every other surface measures a working session. A session that dies because WASM does not
instantiate or a worker does not start produces no rows and no spans, so
`POST /api/telemetry/error` exists to report the failure class. The body is two closed unions
and a count:

| Field | Values |
| --- | --- |
| `source` | `window`, `unhandled_rejection`, `session_start`, `transport_worker`, `telemetry_worker`, `device_events` |
| `kind` | `no_response`, `no_frame`, `wasm_instantiate`, `webgl_context`, `worker_start`, `security`, `network`, `quota`, `abort`, `type_error`, `range_error`, `reference_error`, `other` |
| `count` | Occurrences within one coalescing window |

There is no message, stack, or free-text field. An error message can carry terminal bytes, so
classification is a function of the error's type and name only (`apps/web/src/perf/error-reporter.ts`).
Failures accumulate per `source:kind` and flush on a timer, so a render loop throwing every
frame becomes one report with a count.

| Bound | Value |
| --- | --- |
| Flush interval | 10 s |
| Distinct `source:kind` pairs held per window | `MAX_PENDING_KEYS`, the product of the two unions, so every well-formed pair fits |
| Count per report | 10,000 |

`device_events` is the one source that is not a thrown value. The device-events stream is a
server-sent events stream the browser holds open for account state. An attempt that ends
without the opening `snapshot` or `resume` frame reports `no_frame`; one whose request is
never answered at all reports `no_response`. Attempts the browser cut short itself, and a
definitive 401, are not reported. The browser fetches the stream with `cache: 'no-store'`,
because a stored entry has one writer and a reloaded page's request would otherwise queue
behind the one it replaced.

The server side of that picture is a stream census. `merkur.device_events_streams_open` on
every `device_events_subscribe` span counts the streams this replica holds for the account,
and `device_events_stream_closed` logs why each one ended, how many remain, and how long it
lived. The close reasons are a closed set (`apps/server/src/http/sse.ts`):

| Reason | Meaning |
| --- | --- |
| `client_gone` | `request.signal` aborted |
| `consumer_cancelled` | The stream's own consumer ended it |
| `resync` | A pub/sub resync signal requires a fresh snapshot |
| `session_ended` | The browser session behind the stream ended |
| `sequence_gap` | The client's resume point is no longer held |
| `buffer_overflow` | The bounded outbound buffer filled |
| `write_failed` | A write to the response failed |
| `stream_failed` | The stream fiber failed |
| `server_shutdown` | The application or runtime closed its owned stream during shutdown |

`notification_outbox_delivery_failed` records pending publication or acknowledgement failures;
retained SQL intents are retried by the scoped worker. Unexpected worker defects are logged at
the recovery boundary. These records describe delivery attempts, not exactly-once receipt by a
browser. The `device_events_subscribe` setup span ends after setup; the long-lived stream fiber
does not retain a request span.

### In the UI

The terminal header's link-status widget is a two-sided traffic waveform: sent wire bytes
above the centre line, received below, on a fixed logarithmic scale (64-byte knee, 64 KiB
ceiling per 60 ms column) so a burst never rescales history. Height is traffic, not latency.
Colour follows the latest heartbeat RTT. Only the terminal channels are plotted, so an idle
connection rests flat. The transport worker fills the buckets and publishes only while there
is something to show; a connected idle session schedules no animation frame. The visible
column count follows the widget's width, capped at `LINK_ACTIVITY_COLUMNS` (64). Beside it,
`Direct` or `Relay` is paired with the latest heartbeat RTT, and `Connecting`,
`Reconnecting`, or `Disconnected` replaces it when the session is not ready.

Always-on display-transition breadcrumbs go to the DevTools console, rate-limited to one per
event per second except resync triggers, which are emitted in full. Development builds add
a diagnostics panel that polls worker health every 500 ms; it is absent from production
builds.

## Server Health Routes

The health routes let a platform prober and a person answer "is this replica serving" without
credentials. They are unauthenticated, refuse inbound trace context (`{ root: true }`), and
their spans are `Debug` so a poll does not fill the trace backend.

| Route | Purpose | Fails when |
| --- | --- | --- |
| `GET /health/live` | `200` with `{ "status": "live", "version": "..." }` while the process can answer | Never; it inspects no dependency |
| `GET /health/ready` | The readiness snapshot; `200` when every component is healthy | `503` when any component is `unhealthy` or still `starting` |
| `GET /health/metrics` | `200` with the in-process Effect metric snapshot as JSON | Never. Not Prometheus text; contains no daemon or edge metrics |

Readiness is refreshed every five seconds after one immediate startup probe. The database
probe has a two-second deadline. Every component begins in `starting` and becomes `healthy`
or `unhealthy`:

| Component | Checks |
| --- | --- |
| `database` | `SELECT 1` against the database |
| `redis_commands` | The command connection and reply contract |
| `redis_publisher`, `redis_subscriber` | The dedicated pub/sub connections; subscriber recovery also waits for restored subscription acknowledgements |
| `daemon_control_broker` | Cross-replica broker and local connection worker |
| `daemon_control_liveness` | The daemon-control liveness ticker and its lease renewals |
| `presence_expiry` | The durable presence-expiry scheduler |

The document has `status` (`ready` or `not_ready`), a matching boolean `ready`, `checkedAt`,
and a component map with each component's `status`, `updatedAt`, and an optional
machine-readable `detail`. During orderly shutdown every component is marked `unhealthy`
with `detail: "server_shutdown"` before the listener drains.

## Server OTLP Export

The server is the only Merkur process with a full export path: traces, logs, and metrics over
OTLP/HTTP, plus the relay routes through which daemons and browsers reach the same backend.
Everything goes through Effect's own `effect/observability` modules. There is no
OpenTelemetry SDK and no `@opentelemetry/*` dependency anywhere in the repository, because
an SDK exists to share a global mutable context, and ambient trace state is adopted by
accident: a span that never ends fuses unrelated requests into one trace. The trace topology
is asserted in `apps/server/src/observability/trace-topology.test.ts`.

### Configuration

Export is off when all four `AXIOM_*` keys are absent. A partial set is a startup error.
The Axiom token remains an Effect `Redacted` value in server configuration and is revealed
only for the outbound authorization header. Configuration failures and local source
diagnostics do not print credentials or credential-bearing Redis URLs.

| Key | Meaning | Default |
| --- | --- | --- |
| `AXIOM_TOKEN` | Bearer token for every signal | required with the three datasets |
| `AXIOM_DATASET` | Trace and log dataset | required |
| `AXIOM_METRICS_DATASET` | Metrics dataset | required |
| `AXIOM_PERF_DATASET` | Profiling-row dataset, written through the native ingest API | required |
| `AXIOM_ENDPOINT` | Absolute OTLP base URL; `/v1/traces`, `/v1/logs`, `/v1/metrics` are appended | `https://api.axiom.co` |
| `TELEMETRY_ENVIRONMENT` | `deployment.environment.name` | `development` |
| `TRACE_LEVEL` | Minimum span level that is sampled | `Info` |
| `TRACE_SAMPLE_RATIO` | Share of unremarkable traces kept by tail sampling, 0 to 1 | `1` |
| `TRACE_SLOW_THRESHOLD_MS` | Root duration at or above which a trace is always kept | `1000` |

Every signal carries `service.name=merkur-server`, the release as `service.version`, the
environment, and one `service.instance.id` shared by this process's exporters. A new process
gets a new identity, so cumulative metrics from replicas on the same build remain distinct.
Traces and logs are OTLP/HTTP JSON in two-second batches. Metrics are OTLP/HTTP
protobuf with cumulative temporality every 30 seconds. On shutdown the exporter gets five
seconds to flush.

Without that configuration the server installs a stdout tracer
(`packages/logger/src/span-tree-tracer.ts`) that prints each finished trace as an indented
tree with durations and attributes. The two are selected by presence or absence of the
configuration, so they are mutually exclusive by construction. A local wire-contract smoke
test runs without credentials:

```bash
bun run --cwd apps/server telemetry:smoke
```

### Traces

`runRouteEffect` opens the root span for every HTTP request, parented from the request's own
`traceparent` (`apps/server/src/observability/traceparent.ts`) or from nothing. `request` is
a required field on the route options, so no route can omit it. The route span is named
after the operation (`edge_register` for the log event `edge_register_failed`) and carries
`http.request.method`, `url.path`, `http.response.status_code`, `merkur.outcome`, and
`error.type` on failure.

Sampling is decided at the tail, when the root span ends, because the traces worth keeping
are the slow and failed ones and a head decision cannot know that
(`apps/server/src/observability/tail-sampling-tracer.ts`):

| Rule | Keep |
| --- | --- |
| Any span in the trace failed | always |
| Root duration at or above `TRACE_SLOW_THRESHOLD_MS` | always |
| The trace reached a daemon (`daemon-control.delivery` or `.broker-delivery`) | always, because the daemon exports its own spans and an orphan would otherwise arrive under a parent that was never exported |
| Otherwise | `TRACE_SAMPLE_RATIO` |

A `Debug` span is buffered and emitted only when its trace is kept, so lowering `TRACE_LEVEL`
changes what a kept trace contains, not how many traces arrive. `merkur_trace_sampling_total`
reports one decision per trace; `evicted` means a root never ended and is a defect.

A span must be guaranteed to end. Background loops carry no span; the repeated unit of work
carries one and declares `{ root: true }`. `bun run check:span-lifetimes` enforces this.

| Span | Level | Lifetime | Attributes |
| --- | --- | --- | --- |
| One route span per request | `Info` | Per request | `http.request.method`, `url.path`, `http.response.status_code`, `merkur.outcome`, `error.type` |
| `session_request` | `Info` | Per request | adds `merkur.session.id`, `merkur.daemon.id` |
| `daemon_perf_report`, `browser_link_report`, `browser_perf_ingest`, `browser_upgrade_report`, `browser_error_report`, `browser_trace_relay`, `daemon_trace_relay` | `Info` | Per report | the per-report values behind the aggregate metrics |
| `daemon-control.inbound` | `Info` | Per inbound control message | `merkur.daemon.id`, `merkur.connection.id`, `merkur.presence.id`, `merkur.claim.seq`, `merkur.message.type`, `merkur.command.id` |
| `daemon-control.delivery` | `Info` | Per command delivery | `merkur.daemon.id`, `merkur.command.id`, `merkur.command.type`, `merkur.presence.id`, `merkur.claim.seq` |
| `daemon-control.broker-delivery` | `Info` | Per brokered command | adds `merkur.requester.instance_id`, `merkur.owner.instance_id`; parented by an explicit `Tracer.externalSpan` carried across the Redis broker |
| `server.health.refresh` | `Info` | Per loop iteration, `{ root: true }` | none |
| `redis.operation` | `Debug` | Per Redis command | `db.system`, `db.operation.name` |
| `health.ready`, `health.metrics` | `Debug` | Per poll, `{ root: true }` | none |

Attribute keys are typed. `packages/shared/src/span-attributes.ts` declares every key and its
value type, `spanAttributes()` is the only way to build a set, and
`bun run check:span-attributes` bans any other call shape and cross-checks the edge's Rust
field names against `EDGE_SPAN_ATTRIBUTE_KEYS`. Naming is `merkur.<measure>` for report
fields and `merkur.<entity>.<field>` for identity (`merkur.daemon.id`, `merkur.command.id`,
`merkur.session.id`). The dotted form is what lets a daemon span and a server span join.

Four hops carry `traceparent`, all through one implementation
(`packages/shared/src/traceparent.ts`, mirrored in Rust by `apps/edge/src/register.rs`):

| Hop | Carrier |
| --- | --- |
| browser → server | Header on every `/api/*` request, minted per request |
| edge → server | Header on `POST /api/edge/register`, the only edge-to-server request |
| server → daemon | Required `traceparent` field on `session_start`, `session_cancel`, `delegation_revoke`; empty when the server has no span |
| daemon → server | Header on `POST /api/daemon/traces` |

The edge cannot be joined by context beyond registration. Its `edge.session.splice` span and
the server's `session_request` span both carry `merkur.session.id`. On edge spans this is the
routing ID: the interactive lane uses the product session ID, while signaling and bulk append
`#signaling` and `#bulk`. Session queries remove those exact suffixes and retain the lane when
comparing peer evidence. An exported attachment span ends at teardown; observing both roles
does not prove they were paired simultaneously.

Daemon HTTP identity-proof refusals emit `daemon_http_authentication_rejected`, without
credentials or request contents. The verifier returns a null identity for an invalid proof,
so a successful `daemon_authorize` span alone does not establish that the request was admitted.
Infrastructure failures still emit `daemon_authorize_failed`.

### Metrics

Effect's metric registry is keyed by `(metric, attributes)` and has no eviction path, and the
exporter is cumulative, so every distinct attribute set is re-serialised every 30 seconds
for the life of the process. No unbounded dimension may appear on a metric: no daemon,
user, session, connection, presence, or command id, no IP address, no user agent. Identity
lives on spans. The server's own metrics (`apps/server/src/observability/metrics.ts`):

| Metric | Kind | Meaning |
| --- | --- | --- |
| `merkur_server_ready` | Gauge | `1` only when every readiness component is healthy |
| `merkur_daemon_control_active_connections` | Gauge | Daemon control WebSockets owned by this replica |
| `merkur_daemon_control_inbound_overflow_total` | Counter | Sockets closed because the bounded inbound mailbox overflowed |
| `merkur_daemon_control_ping_timeout_total` | Counter | Connections retired after their ping deadline |
| `merkur_daemon_control_silent_transition_total` | Frequency | `silent` after missed pings, `recovered` on the next |
| `merkur_daemon_control_delivery_outcome_total` | Frequency | Command-delivery outcomes |
| `merkur_daemon_control_delivery_latency_ms` | Histogram | End-to-end command acknowledgement latency |
| `merkur_redis_operation_timeout_total` | Counter | Redis operations past their deadline |
| `merkur_background_worker_failure_total` | Frequency | Unexpected failures of named long-lived fibers |
| `merkur_trace_sampling_total` | Frequency | `kept_error`, `kept_slow`, `kept_daemon`, `kept_ratio`, `dropped_ratio`, `evicted` |

Metrics derived from browser reports:

| Metric | Kind | Meaning |
| --- | --- | --- |
| `merkur_browser_link_reports_total` | Frequency | Link report ingestion outcomes |
| `merkur_browser_perf_ingest_total`, `merkur_browser_trace_ingest_total` | Frequency | `accepted`, `rejected_rate_limited`, `rejected_invalid`, `discarded_unconfigured`, `forward_failed` |
| `merkur_browser_perf_rows_total` | Counter | Profiling rows forwarded |
| `merkur_browser_error_total` | Frequency | Failures labelled `<source>:<kind>`, a closed 78-label set |
| `merkur_browser_errors_total` | Counter | Failures including repeats within a coalescing window |
| `merkur_browser_link_rtt_p50_ms`, `_p95_ms` | Histogram | Heartbeat RTT per report |
| `merkur_browser_input_ack_rtt_p50_ms`, `_p95_ms` | Histogram | Input-acknowledgement RTT per report |
| `merkur_browser_link_path_total` | Frequency | `direct`, `relay`, `unknown` |
| `merkur_browser_link_state_total` | Frequency | The five link states |
| `merkur_browser_link_samples_total`, `_degraded_samples_total` | Counter | Denominator and numerator of the degraded ratio; divide at query time |
| `merkur_browser_link_tx_bytes_total`, `_rx_bytes_total` | Counter | Wire bytes as browsers observe them |
| `merkur_browser_session_quality_total` | Frequency | `good`, `degraded`, `bad` per accepted report, classified on the server in `apps/server/src/observability/session-quality.ts`. A zero percentile means no measurement, never "instant" |
| `merkur_browser_upgrade_total` | Frequency | Attempts labelled `<outcome>` |
| `merkur_browser_upgrade_winner_total` | Frequency | Candidate kind that carried the session, or `none` |
| `merkur_browser_upgrade_candidate_disposition_total` | Frequency | `<kind>:<disposition>` per offered candidate |
| `merkur_browser_upgrade_admission_total` | Frequency | `<stage>:<reason>` of a failed admission over a connected candidate |
| `merkur_browser_upgrade_nat_total` | Frequency | Daemon-reported NAT mapping class at attempt time |

Per-user rate limits on these routes: the link route admits four times the heartbeat rate
per minute, profiling batches 240 per minute, and daemon span batches 30 per minute per
daemon. The limiter keys on the user or daemon id and never reads a client address.

## Daemon Health And Metrics

The daemon has two observability outputs with different reach. A stdout snapshot every 30
seconds is its only signal when the server is unreachable, which is exactly when it
matters. A performance report every 60 seconds over HTTP is what the fleet metrics are built
from. Its spans go to the server as well.

### The health snapshot

`daemon_health_snapshot` is logged every 30 seconds through the shared logger. It carries the
daemon id, the control and dataplane state, and a bounded metric snapshot. The daemon is
`ready` only when the control state is `registered` and the dataplane state is `ready`.

| Control state | Meaning |
| --- | --- |
| `starting` | Before the first connection attempt |
| `connecting` | Opening the server WebSocket |
| `registering` | Connected, awaiting registration acceptance |
| `registered` | Registered; `stable` says whether the connection has crossed its stability threshold |
| `backoff` | Waiting before the next attempt |
| `superseded` | A replacement daemon connection owns the registration |

Dataplane states are `starting`, `ready`, `down`, and `fatal`. `ready` means the Rust
dataplane reached a serving PTY; it does not require the direct path, because terminal
traffic rides the edge relay.

Alert on `checkedAt - control.updatedAt`, never on `control.state` alone. A suspended process
emits nothing, so a snapshot can read `registered` with an arbitrarily old `updatedAt` after
a laptop sleep.

Metrics local to the snapshot, never relayed:

| Metric | Meaning |
| --- | --- |
| `merkur_daemon_control_reconnect_outcomes` | Reconnects by preceding outcome: `stable_connection`, `unstable_registered_connection`, `unregistered_connection`, `process_suspended` |
| `merkur_daemon_control_registration_outcomes` | Registration and pre-registration outcomes |
| `merkur_daemon_control_ping_outcomes` | `pong`, `timeout`, `send_failed`, `suspended`. A resumed process reports `suspended`, never `timeout` |
| `merkur_daemon_dataplane_restart_outcomes` | Dataplane restart requests by reason |
| `merkur_daemon_dataplane_ack_timeouts_total` | Commands rejected after the Rust acknowledgement deadline |
| `merkur_daemon_dataplane_ready` | `1` when the dataplane is ready |
| `merkur_daemon_ipv6_reachability` | Listener startup probes by whether unsolicited inbound IPv6 arrived |
| `merkur_daemon_nat_mapping_outcomes` | Port-mapping cycles by `<who>:<what>`, eighteen values across the v4 lease and the v6 pinhole; `gateway:inner_nat` is a gateway whose external address is not the STUN-observed one, `skipped:no_reflexive` a cycle with no such address to compare |
| `merkur_dataplane_<field>` | The transport sample mirrored locally: interval deltas as counters, `edge_rtt_us`, `webtransport_rtt_us`, `unacked_datagrams_max`, `stats_events_dropped` as gauges |
| `merkur_dataplane_rebind_*` | Six owner-loop rebind tallies since dataplane start, mirrored as gauges |
| `merkur_daemon_rebind_outcomes` | Per-attempt rebind outcomes over a closed 32-value vocabulary, rate-bounded |

The transport sample behind those fields is the dataplane's `EVT_TRANSPORT_STATS` (`0x90`)
IPC event, emitted every five heartbeat ticks (`STATS_TICKS_PER_SAMPLE`). Its payload is a
fixed set of unsigned integers whose size does not depend on peer count, and it is the only
droppable event kind: a monitoring frame must never be able to shut down the process it
monitors, and drops are self-reported in `statsEventsDropped`. Per-attempt
`EVT_SESSION_REBIND` (`0x92`) events are capped at eight per tick
(`MAX_REBIND_EVENTS_PER_TICK`).

### The performance report

Every 60 seconds the daemon posts a window to `POST /api/daemon/perf`, authorized by an
ML-DSA-87 identity proof over the exact request. The window is expressed as deltas; a
negative delta is read as a restart. A window is skipped unless the control state is
`registered`, and a failed send is dropped, never retried. The report goes over HTTP rather
than the control WebSocket because that socket's inbound mailbox is sized for command
acknowledgements and its overflow policy destroys the socket.

The server turns the report into these metrics, none carrying a daemon id:

| Subsystem | Metric | Kind | Meaning |
| --- | --- | --- | --- |
| Ingestion | `merkur_daemon_perf_reports_total` | Frequency | `accepted`, `rejected_rate_limited`; a schema-invalid body is refused before the handler and leaves no metric |
| Ingestion | `merkur_daemon_trace_ingest_total` | Frequency | Span batch relay: `accepted`, `rejected_rate_limited`, `rejected_invalid`, `discarded_unconfigured`, `forward_failed` |
| Control | `merkur_daemon_ping_rtt_p50_ms`, `_p95_ms` | Histogram | Distribution of per-daemon percentiles of the control ping, one observation per window |
| Control | `merkur_daemon_reported_ping_outcome_total` | Frequency | Fleet rollup of ping outcomes |
| Control | `merkur_daemon_reported_dataplane_restarts_total`, `_ack_timeouts_total` | Counter | Dataplane restarts and acknowledgement timeouts |
| Control | `merkur_daemon_suspension_gap_ms` | Histogram | Largest wall-clock gap the control ping producer observed in a window, recorded only when it crossed the suspension threshold; zero in a window without a suspend/resume |
| Rebind | `merkur_daemon_rebind_requests_total`, `_accepted_total`, `_refused_total`, `_committed_total`, `_envelopes_rejected_total`, `_events_suppressed_total` | Counter | Rebind requests through validation, answer, refusal, commit; frames rejected before validation; diagnostics suppressed by the emission budget. Committed below accepted isolates post-answer failure |
| Direct path | `merkur_daemon_direct_wt_incoming_expected_total`, `_unexpected_total` | Counter | Arrivals at the direct listener from an offered address, and from any other. Read the zero direction of `expected` only |
| Direct path | `merkur_daemon_direct_wt_admitted_total` | Counter | Direct upgrades admitted. Expected arrivals without admissions is a Merkur bug |
| NAT | `merkur_daemon_nat_keepalives_total`, `_punch_bursts_total` | Counter | Reflexive-mapping keepalives and punch bursts toward a browser |
| NAT | `merkur_daemon_nat_punch_refused_not_global_total` | Counter | Punches skipped for a non-global browser address; the correct outcome for a same-NAT browser |
| NAT | `merkur_daemon_nat_punch_refused_rate_limited_total` | Counter | Punches dropped by the token bucket or cooldown; a defect |
| NAT | `merkur_daemon_nat_side_channel_send_failures_total` | Counter | Side-channel datagrams the socket refused |
| Display | `merkur_daemon_row_versions_sent_total` | Counter | Sends whose row content differs from the previous send. Denominator for the two counters below only |
| Display | `merkur_daemon_row_versions_superseded_unapplied_total` | Counter | Row versions replaced before the browser applied them |
| Display | `merkur_daemon_row_resends_identical_total` | Counter | Byte-identical re-sends. Duplicate share of all row sends is `identical / (identical + row_versions_sent)` |
| Display | `merkur_daemon_rows_declared_lost_total` | Counter | Rows disowned because their carrying datagram was declared lost. One datagram can carry several rows, so do not divide by `row_versions_sent` |
| Display | `merkur_daemon_resync_rows_requested_total` | Counter | Rows browsers asked to resynchronise from the hash-digest backstop |
| Display | `merkur_daemon_fec_repairs_sent_total`, `_refused_total` | Counter | FEC repair frames emitted, and refused by the transport |
| Display | `merkur_daemon_direct_display_datagrams_received_total`, `_recovered_by_fec_total`, `_declared_lost_total`, `_outcome_unknown_total` | Counter | Sole-path direct display datagrams by final outcome. Classified is received + recovered + declared lost; residual loss is declared lost / classified; unknown is excluded |
| Display | `merkur_daemon_edge_display_datagrams_*` | Counter | The same four outcomes for the edge path |

### Daemon spans

The daemon runs an OTLP tracer pointed at `POST /api/daemon/traces` on the Merkur server,
never at the backend (`apps/daemon/src/observability/telemetry.ts`). It exports every five
seconds, at a constant `Info` threshold, and only around the long-lived runtime: the CLI
commands never open an exporter. The request is signed by the daemon identity after
serialization; the server hashes the raw bytes and relays them, and with its own telemetry
unconfigured it reports `discarded_unconfigured`. See
[`security.md`](./security.md#daemon-management-proofs) for the proof.

| Span | Lifetime | Attributes |
| --- | --- | --- |
| `daemon.control.connection` | One control WebSocket connection | `merkur.daemon.id` |
| `daemon.control.command_admission` | Per admitted command, parented off the command's `traceparent` | `merkur.command.id`, `merkur.command.type`, `merkur.session.id` |
| `daemon.health.snapshot` | Per 30-second reporter iteration | none |
| `daemon.session.rebind` | Per rate-bounded rebind attempt | `merkur.session.id`, `merkur.rebind_outcome`, `merkur.rebind_generation`, `merkur.rebind_attempt_ms` |

The Rust dataplane and `apps/stun` create no spans. The dataplane reports
numbers over IPC instead; a span on the keystroke path would allocate and lock exactly where
the frame budget binds.

## Edge Telemetry

The edge relays sealed frames it cannot read, so its telemetry is about connections, not
content. Its master switch is `MERKUR_EDGE_OTLP_ENDPOINT`. With it present,
`MERKUR_EDGE_OTLP_TOKEN` and `MERKUR_EDGE_OTLP_DATASET` are mandatory, and
`MERKUR_EDGE_OTLP_METRICS_DATASET` independently enables metrics. Without it the edge keeps
stdout logging only.

Everything is OTLP/HTTP protobuf. Trace batches use a five-second delay, metrics export every
60 seconds, requests time out after ten seconds, and the batch exporter runs outside the
relay's Tokio runtime. Resources carry `service.name=merkur-edge`, the environment,
`merkur.edge.id`, and `merkur.edge.region`; `service.version` is `MERKUR_VERSION` when set.

| Span | Lifetime | Attributes |
| --- | --- | --- |
| `edge.session.splice` | One peer attachment on one routing lane | `merkur.session.id`, `merkur.peer.role` |
| `edge.register.publish` | Per registration request | `edge_id`, `outcome` |

Two structured log events, exported as OTLP logs into the same dataset, say how a
connection ended. `edge: peer detached` is written once per peer per session: `lane`,
`attachment`, the `exit` label, `cause` (the QUIC close reason read before the relay closes
its side: `idle_timeout`, `peer_application_closed` with `peer_close_code`,
`peer_connection_closed`, `reset`, `locally_closed`, `local_h3_error`, `transport_error`, or
`open` for a session the relay ended on a live connection; a peer ending its WebTransport
session reads as `peer_application_closed`), `uplink_silent_ms` (how long before the end a
browser leg last delivered a datagram, to the 100 ms quote tick; absent for a daemon leg),
`peer_rebinds` and `peer_address_changes` (the peer's NAT rebindings and address changes,
counted by the vendored quinn-proto and read lock-free), `pto_count`, and the QUIC totals. `edge:
peer path validated` is written when a browser leg's peer has answered on a new path, with `kind`
`rebind` (a new port) or `address` (a new IP) and the path's `sequence`; a move the peer never
confirms writes nothing. The signaling leg's `address` moves are what the browser and daemon learn
as the browser's address. Together with the browser's `carrier_closed` rows they separate a browser access
network that went silent from one connection that died, a NAT rebinding, and the daemon's
leg.

Spans follow peer attachments, never individual frames: `apps/edge/src/splice.rs`, the
per-datagram path, has none. Metric label values come from closed sets; session ids and
addresses never become metric labels. QUIC counters are read once per peer attachment at teardown,
because that read takes the connection mutex. The full metrics table lives in
[`apps/edge/README.md`](../apps/edge/README.md).

The edge's monthly NIC accounting exports `merkur_edge_egress_month_bytes`,
`merkur_edge_egress_reserved_bytes`, and `merkur_edge_egress_budget_state` as observable
gauges without labels. State values are 0 (open), 1 (signaling only), and 2 (stopped).
The charged month bytes include reservations forfeited on restart. Initializing a missing
ledger emits `egress_ledger_initialized` and increments
`merkur_edge_egress_ledger_initialized_total`; data admission refusals use the closed-set
handshake reason `egress_budget`.

## Native boundary capture

Authenticated browser profiling also arms a bounded recorder inside the dataplane that
timestamps the PTY and QUIC boundaries a keystroke crosses, so daemon queueing can be told
apart from shell and kernel time without inventing a causal join. It adds nothing to the
display or control lanes. An explicit `CMD_CAPTURE_PERF_TRACE` (`0x0e`) drains it through
`EVT_PERF_TRACE` (`0x93`) chunks of at most 128 records, from a retained set of 16,384
(`packages/shared/src/native-perf-trace.ts`). A malformed capture rejects the capture, not
the terminal session. The test-only `SIGUSR2` listener enabled by
`MERKUR_E2E_FINAL_TRANSPORT_CAPTURE=1` requests transport statistics and then this capture.

Each record has an owner, an ordinal, a process-monotonic `at_us`, a closed `kind`, and
sixteen integer words. Kinds are `pty_enqueue`, `pty_write`, `pty_read`, `pty_read_handled`,
`pty_boundary_discard`, `display_member`, `display_attempt`, `carrier_state`, and
`quic_datagram`. Display attempts and QUIC datagram records both carry the sealed AEAD tag,
which matches an admission attempt to its packet without reading the payload. A
`quic_datagram` record also carries the QUIC packet number it was built into and its
plaintext Merkur channel byte, so input ACKs, pongs and display datagrams that shared one
packet can be counted. No input
text, grid cell, plaintext, key material, or full packet is retained. Unmatched records stay
unmatched rather than being joined by time proximity.

## Metric semantics

Exported histograms are cumulative OTLP histograms, so any percentile read from them is
interpolated, not an exact raw observation. Browser input latency instead joins the first
observed ACK to its send on `(merkur_session_id, input_seq)`, with no upper-tail clipping.
Render joins use `(merkur_session_id, render_seq)` and require unique records. Empty session
ids and unmatched records cannot establish latency. GPU queue completion is readiness
evidence and must never be labelled physical paint.

Metric event totals are monotonic counters. Server latency histograms export `ms`, and
browser and edge byte totals export `By`. A browser link percentile of zero is an absence
sentinel and is not recorded as a latency sample. Browser byte accounting keeps its
cumulative baseline across heartbeat reports and establishes a fresh baseline if a transport
counter decreases.

Dashboard consumers must use the configured dataset identifiers independently of service,
metric, and attribute names. Compare queries with current producer declarations: historical
dataset fields can outlive their producers. Validate all distinct queries, then inspect
nonempty input, render, timing, and session joins. A query that compiles against an empty
window does not prove its measurement contract.

Counter differences run per original process series before time alignment or grouping.
Fleet readiness takes the minimum across replicas; control connections sum replica values.
Edge session gauges count routing slots across three lanes, and splice histograms describe
peer attachment lifetimes. Neither counts distinct product sessions. Upgrade reports have
no attempt ordinal, so they cannot establish a first-attempt success rate. Trace fan-out
counts span records only, excluding logs that share a trace ID. Cumulative attribution and
egress observations retain their session, observation epoch, and series identities; summing
repeated snapshots invents traffic.

Effect registers a metric on its first update, so a counter for a rare event is absent until
it fires and then appears at its post-increment value. A rate computed by differencing
reports zero for the increment that created the series. For a rare event, prefer the span or
log; where neither exists, read the cumulative value directly.
