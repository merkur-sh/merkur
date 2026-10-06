# merkur-edge

The edge is Merkur's blind relay. It is a WebTransport server that joins a browser's
session to the matching daemon's session and forwards their frames without reading them.
This document covers what the edge can and cannot see, the routing preface and the lanes it
splices, the limits it enforces, its certificate and registration lifecycle, configuration,
telemetry, and how to build, run, and deploy it. The transport design around it is in
`docs/transport.md`.

## What the edge is

The application server is never on the terminal path. When a browser cannot reach a daemon
directly, both dial the same edge and the edge splices the two QUIC connections together.
Terminal channels are Noise ciphertext end to end, so the edge forwards bytes it cannot
decrypt.

```
browser ──native WebTransport──► edge ◄──HTTP/3 tunnel── daemon
          └── Noise end to end on terminal channels; plaintext handshake on channel 0x00 ──┘
```

Each peer opens one bidirectional control stream and sends a routing preface naming the
session and its role. When a `browser` and a `daemon` preface arrive for the same
`session_id`, the two connections are spliced. Every replica is an independent process with
its own in-memory splice registry and its own public URL; the server picks one exact replica
per session and tells both peers, so they always meet in the same registry. A live session
uses three routing labels: `<session_id>#signaling` for signaling, the bare session id
for interactive traffic, and `<session_id>#bulk` for bulk transfers. Budget admission uses
these labels without inspecting payloads.

### What the edge reads and what it cannot

The edge holds no Noise secret, no ML-KEM secret material, no daemon identity signing seed,
and no session-token signing key. It cannot decrypt a terminal channel, and it is not a
session authentication boundary: a peer that lies about a `session_id` reaches only a
counterpart that will fail the Noise handshake. It is an admission boundary. Every preface
carries a server-signed attach ticket, and a peer whose ticket does not verify is closed
before it reaches the splice registry, so the relay carries only sessions the server issued
for a linked machine.

The plaintext the edge parses is limited to two envelopes it owns:

| Envelope | Stream | Content |
| --- | --- | --- |
| Routing preface | The first bidirectional stream each peer opens | `session_id`, `role`, `version`, `attachment`, `daemon_id`, `ticket` |
| Delivery quote | A second bidirectional stream the daemon opens, prefaced `merkur-edge-quote-v1` | Advisory QUIC delivery state for the browser leg, written by the edge to the daemon |

On the control stream the edge writes splice control events back to the peer:
`CounterpartPresent` (first message to an arriving peer), `CounterpartAttached`,
`CounterpartProbing`, `CounterpartResponsive`, and `CounterpartDetached` with the remaining
rebind window. Signaling attachments also receive `RelayDataPaused` when the relay data
budget is exhausted or resumes. These describe edge state, never application payloads.

Everything else is opaque. The relay never parses, interprets, or branches on a data frame's
channel or body; on reliable lanes it copies the one-byte channel prefix without reading it
and inspects only each four-byte body length, for bounds and byte accounting. It can observe
sizes and timing, and the pre-Noise handshake on channel `0x00` (ML-KEM keys and ciphertexts,
ML-DSA signatures, Noise handshake messages) crosses it in plaintext. A packet capture at the
edge shows ciphertext on every terminal channel. `apps/edge/src/splice.rs` states this
invariant in its module documentation.

## Splice protocol

### Routing preface

Immediately after its WebTransport session is accepted, each peer opens one bidirectional
control stream and writes exactly one length-delimited JSON preface before anything else:

```
+--------------------------+--------------------------------------+
| u32 length (big-endian)  | JSON RoutingPreface (`length` bytes) |
+--------------------------+--------------------------------------+
```

```jsonc
{
  "session_id": "<opaque routing label shared by one browser and one daemon>",
  "role": "browser" | "daemon",
  "version": 8,
  "attachment": { "kind": "primary" } | { "kind": "candidate", "nonce": "<43 chars>" }
              | { "kind": "tunnel", "incarnation": "<22 chars>" }
              | { "kind": "announce", "incarnation": "<22 chars>" },
  "daemon_id": "<the daemon this attachment serves>",
  "ticket": "<server-signed attach ticket, base64url>"
}
```

`session_id` is an opaque label: the browser gets it from `/api/sessions/request`, the daemon
gets the same id over its control link to the server, and the edge derives no trust from it.
`version` must equal `PREFACE_VERSION`, which is `8`; any other value, a missing field, or an
unknown field is rejected. A browser attaches as `primary`, or as a `candidate` on a
`#signaling` id. A daemon attaches as a `tunnel` naming its dataplane process's incarnation,
16 random base64url bytes drawn at start. An `announce` names the incarnation without a
session: its `session_id` is empty, and the edge closes it with `0x4d04`
(`incarnation-announced`) once recorded. The edge keeps the newest incarnation per daemon id,
and a tunnel or announcement naming another retires every slot the earlier process held, each
counterpart told `CounterpartDetached`. A crashed dataplane cannot close its connections, so
this is what spares its browsers the connections' 30 s idle timeout.

The `ticket` is what admits the peer (`src/attach_ticket.rs`; the server issues it from
`apps/server/src/services/edge-attach-ticket.ts`). It is an HMAC-SHA256 tag, truncated to 16
bytes, under the deployment-wide `MERKUR_EDGE_ATTACH_TICKET_KEY`:

| Role | Binds | Lifetime | Issued |
| --- | --- | --- | --- |
| Daemon | `daemon_id` | 90 s, bounded at the edge to 5 minutes plus 60 s of skew | On control registration and every lease renewal, so an unlinked or disconnected daemon stops being admitted within one lifetime |
| Browser | `daemon_id` and the base session id | None: renewal and rebind are in-band, and the ticket is useless without a live daemon ticket for the same daemon | With the session, covering all three lanes and every redial |

The tag is checked before the expiry, so a forged and an expired ticket take one path. A slot
records the daemon its first verified attachment named, and a counterpart naming a different
daemon is closed with `splice-daemon-mismatch`; a refused ticket closes with `bad-ticket`. The length is capped at `MAX_PREFACE_LEN` (4096 bytes) so a hostile
length prefix cannot reserve memory, and a peer that sends no valid preface within 10 seconds
is dropped. The edge keeps the send half of this stream for the control events above.

### Datagrams

Datagrams carry the latency-sensitive path: display deltas, input and their
acknowledgements. The edge reads every datagram a connection has already received in one
batch (`DatagramBatch`: up to eight, and after the first no more than one packet's bytes), so
the datagrams one QUIC packet carried stay together, and admits the batch to the
counterpart's mailbox using the received buffers, with no copy. Egress admits a batch of
several under one egress hold on the destination connection, so those datagrams leave in one
packet again; a lone datagram's own admission wakes the driver.
A full mailbox drops the whole batch, counted per datagram, and the end-to-end FEC and resync
layer recovers. Admission is non-dropping: a datagram that finds the destination's send queue
full is the one dropped and counted, never an older queued one. Routing takes only a
session-local lock, never the global registry lock.

### Persistent reliable lanes

A persistent unidirectional stream carries one logical reliable channel for a whole carrier
generation. Its wire is:

```text
[channel: u8, once][u32 body length, big-endian][opaque body]...
```

Each accepted source stream owns a lane actor that survives counterpart reconnects. It checks
each declared length against the 8 MiB record ceiling and forwards fragments as they arrive,
never holding a whole record. If the destination fails mid-record, the actor drains to the
next record boundary, opens a successor stream on the new destination, repeats the channel
byte, and resumes with the next complete record. Source reset, malformed input, or a stalled
record closes the source generation; a clean source FIN ends only that lane.

### Finite streams

A stream whose prefix byte has the high bit set (`FINITE_STREAM_FLAG`, `0x80`) is a finite
transfer: one sealed object with a known end, such as an image or a file. The remaining seven
bits are as opaque as a channel id. Finite streams draw on their own byte budget so a blocked
bulk transfer cannot starve the durable lanes, and each peer's QUIC receive window starts at
the bulk credit floor until its preface names a role.

### Limits

Every value is a constant in `apps/edge/src/splice.rs` or `apps/edge/src/relay.rs`. The byte
budgets are logical record credits, not a process RSS cap.

| Limit | Value |
| --- | --- |
| Routing preface length | 4096 bytes |
| Datagram mailbox depth per direction | 256 batches of up to 8 datagrams |
| Reliable record ceiling | 8 MiB |
| Persistent lanes per peer | 5 |
| Finite streams per peer | 32 |
| Finite stream size | 16 MiB |
| Advertised unidirectional stream credit per peer | 40 (5 lanes + 32 finite + 3 HTTP/3 control) |
| Reliable bytes in flight, per session per direction | 16 MiB |
| Reliable bytes in flight, process-wide | 256 MiB |
| Finite bytes in flight, per session per direction | 64 MiB |
| Finite bytes in flight, process-wide | 256 MiB |
| Reliable operation deadline once a record is in progress | 30 s |
| QUIC keep-alive and idle timeout | 4 s and 30 s |
| Splice sessions in the registry | 4096 |

## Monthly egress budget

The edge samples the configured NIC's 64-bit transmit counter every second, including
QUIC retransmissions, handshakes, registration, and OTLP traffic. Linux reads the interface's
sysfs `statistics/tx_bytes`; macOS uses `sysctl NET_RT_IFLIST2` and `if_data64.ifi_obytes`.
A decreasing counter means the interface reset: the new reading is charged as the bytes
sent since the reset. No 32-bit counter or wrap inference is used.

The identity directory holds `egress-ledger`, a fixed JSON format containing version `1`,
the UTC `YYYY-MM`, and reserved bytes. Each reservation advances by 1 GiB only after writing
a temporary file, syncing it, renaming it over the ledger, and syncing the directory. The
first chunk is reserved before binding. Startup charges the previous reservation in full,
so unused reservations are forfeited across every restart. An exclusive file lock prevents
two processes from spending the same ledger. A missing ledger is initialized with the
warning event `egress_ledger_initialized` and a metric; a corrupt ledger refuses startup.
Keep the volume: deleting it discards accounting history.

At the first sample in a new UTC month, zero is durably written and accounting restarts.
The complete delta in a sample spanning the month boundary is charged to the new month;
the counter cannot identify which bytes fell on each side. A backward month, counter read
failure, or persistence failure is fatal, rather than continuing without accounting.

Below the data budget the state is `Open`. At that budget it becomes `SignalingOnly`:
existing interactive and bulk attachments are retired, and new primary data prefaces are
closed with application code `0x4d03`, reason exactly `egress-budget`, and handshake reason
`egress_budget`. Signaling and candidate
attachments remain available. At data budget plus signaling reserve it becomes `Stopped`:
all attachments close, including those still in admission, and new QUIC Initials are
silently ignored before TLS. This avoids response egress and leaves the endpoint able to
reopen next month. Registration and telemetry remain metered while stopped.

Every budget-caused close, including admission and `Stopped`, uses `0x4d03` with
`egress-budget`. Peers match both fields. This is distinct from `0x4d01` with
`counterpart-detached`, which retains the existing counterpart-loss recovery contract.

On each primary or candidate `#signaling` control stream, a paused edge writes
`{"type":"relay_data_paused","paused":true}` immediately after the initial presence event.
An `Open` attachment adds no event. The registry publishes budget changes before retiring
data attachments; every live signaling writer observes the newest value and writes `true`
on pause or `false` on reopening. `Stopped` only closes connections. The first new-month
sample publishes `Open`, so both peers immediately dial their paused data lanes with fresh
generations and attempt budgets, without a resume timer. Paused lanes never exhaust redials,
park the daemon peer, or trigger browser session rebind. Signaling and direct WebTransport
remain usable. Without a direct carrier, the existing browser link status says relay is
paused for the month.

Enforcement is sampled, not an exact packet quota. A reservation is persisted before its
in-memory extension is published, but the NIC observation reports bytes already sent;
traffic between samples, scheduler stalls, and non-relay traffic can exceed the recorded
reservation or monthly threshold. The HTB rate cap limits the sending rate, not that gap's
duration. A strict reserve-before-wire guarantee would require a kernel quota gate. The
configured replica has 2400 GiB for data and another 100 GiB for signaling; its 200 Mbit/s
cap is a rate backstop. Local runs use generous budgets on loopback, counting other loopback
traffic too.

## Certificate and registration

The edge serves a self-signed certificate. Peers pin its SHA-256 hash through
`serverCertificateHashes`, so no public CA is involved. The WebTransport specification caps
hash-pinned certificates at 14 days, so the edge always holds two, each issued for 13 days:
the one it serves and the one it will serve next (`src/cert.rs`). Both hashes reach peers out
of band: in the server's `/api/sessions/request` response and every renewal answer
(`edgeCertHashes`), and in the daemon's `registered` and `lease` control messages. On startup
it logs both pins:

```
edge self-signed certificates loaded; peers pin both hashes  cert_hash_b64=… next_cert_hash_b64=… valid_days=13
```

A rotation is due once the next certificate has been published for `ROTATION_PERIOD`
(6 days) or the served one is two periods old, so no certificate is pinned past its twelfth
day. The edge generates and persists a new next certificate, hot-reloads the endpoint onto the
one it already published, and publishes the new pair at once. Established connections stay
open, and a peer holding the pair from any time since the previous rotation still dials.
`SIGHUP` requests a rotation immediately. The identity directory holds both certificates and
keys plus `current` and `next` pointers, and each rotation deletes the generation it retired;
a restart reloads them, repairs a rotation cut between its two pointer writes, and catches up
on rotations that fell due while it was down.
Private key files are kept at mode `0600` on Unix.

Each replica publishes its public URL, region, and certificate hashes to the server at
`/api/edge/register`, then heartbeats every 30 seconds. The server drops a replica whose
heartbeat lapses for `EDGE_HEALTH_TTL_MS` (90 s) and refuses a URL already owned by another
live replica. Every POST carries `x-merkur-edge-id`, `x-merkur-edge-timestamp`, a fresh
32-byte `x-merkur-edge-nonce`, and an `x-merkur-edge-auth` HMAC-SHA-512 tag over the canonical
payload, edge id, method, and path, keyed by the replica's own 64-byte registration key. The
server rejects stale timestamps, fences nonce replay in Redis, and reads its copy of every key
from `EDGE_REGISTRATION_KEYS_JSON`, which `parseEdgeRegistrationKeys`
(`packages/config/src/server-config.ts`) fails closed on when malformed or duplicated.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `MERKUR_EDGE_PORT` | `4433` | UDP/QUIC listen port. |
| `MERKUR_EDGE_HOSTNAME` | `localhost` | Extra SAN on the certificate; advisory, the browser pins the hash. |
| `MERKUR_EDGE_REGISTER_URL` | required | Server `/api/edge/register` URL. Canonical HTTPS; loopback HTTP is accepted for development. |
| `MERKUR_EDGE_REGISTRATION_KEY` | required | Canonical base64url of this replica's distinct 64-byte HMAC-SHA-512 key. |
| `MERKUR_EDGE_EGRESS_RATE_MBIT` | required in the image | Aggregate egress ceiling in Mbit/s. The image entrypoint (`entrypoint.sh`) installs it with `tc` (HTB, 10 ms burst, fq_codel beneath) on `MERKUR_EDGE_EGRESS_INTERFACE` before dropping privileges, and refuses to start without it. Rendered per replica from `egressRateMbit` in `replicas.json`. It bounds the worst month's egress bill at rate × seconds in the month; set it well above honest use. |
| `MERKUR_EDGE_EGRESS_INTERFACE` | required | Metered NIC, also used by the image cap. Fly uses `eth0`; local scripts use `lo0` on macOS and `lo` on Linux. Missing interfaces refuse startup. |
| `MERKUR_EDGE_DATA_BUDGET_GB` | required | Positive integer monthly data budget in GiB (2³⁰ bytes). |
| `MERKUR_EDGE_SIGNALING_RESERVE_GB` | required | Positive integer additional monthly signaling allowance in GiB. |
| `MERKUR_EDGE_ATTACH_TICKET_KEY` | required | Canonical base64url of the 64-byte deployment key every replica verifies attach tickets with; the same value as the server's `EDGE_ATTACH_TICKET_KEY`. The edge refuses to start without it. |
| `MERKUR_EDGE_ID` | required | Stable replica id, for example `fra-1`; unique across the deployment. |
| `MERKUR_EDGE_REGION` | required | Region label, for example `fra`; a key of `ZONE_BY_FLY_REGION` in `apps/server/src/services/ip-region.ts`. |
| `MERKUR_EDGE_PUBLIC_URL` | required | This replica's canonical root HTTPS WebTransport URL. |
| `MERKUR_EDGE_IDENTITY_DIR` | required | Durable directory for the certificate, private key, and exclusive egress ledger. |
| `RUST_LOG` | `info` | `tracing` env filter. |
| `MERKUR_EDGE_OTLP_ENDPOINT` | unset | OTLP base URL. Presence is the master switch for telemetry; unset, the edge only logs. |
| `MERKUR_EDGE_OTLP_TOKEN` | required with endpoint | Bearer token for the OTLP endpoint. |
| `MERKUR_EDGE_OTLP_DATASET` | required with endpoint | Dataset receiving traces and logs (`x-axiom-dataset`). |
| `MERKUR_EDGE_OTLP_METRICS_DATASET` | unset | Dataset receiving metrics (`x-axiom-metrics-dataset`). Unset disables metrics only. |
| `TELEMETRY_ENVIRONMENT` | `development` | `deployment.environment.name` resource attribute. |
| `MERKUR_VERSION` | edge crate version | `service.version` resource attribute; releases set it to the Merkur version. |

The public URL is the replica's identity, not its location: it may be a DNS name, since
`normalizeEdgeWebTransportUrl` (`packages/shared/src/edge-webtransport.ts`) accepts any HTTPS
host and nothing verifies a SAN. It must front exactly one process, or the browser lands in
one splice registry and the daemon in another.

## Telemetry

Spans are per session, never per frame: `edge.session.splice` covers a session's lifetime and
`edge.register.publish` each registration POST; the frame path touches counters and atomic
gauges only. Export runs on a dedicated thread off the Tokio runtime, so an unreachable
collector cannot stall the accept loop. Resources carry `service.name=merkur-edge`,
`service.version`, `deployment.environment.name`, `merkur.edge.id`, and `merkur.edge.region`.
Spans flush every 5 seconds and metrics every 60; a redeploy loses at most one interval.

With a metrics dataset configured the edge registers these instruments
(`apps/edge/src/metrics.rs`):

| Instrument | Kind | Meaning |
| --- | --- | --- |
| `merkur_edge_egress_month_bytes` | gauge | NIC bytes charged this UTC month, including forfeited reservations. |
| `merkur_edge_egress_reserved_bytes` | gauge | Durably reserved bytes this month. |
| `merkur_edge_egress_budget_state` | gauge | `0` Open, `1` SignalingOnly, `2` Stopped; no labels. |
| `merkur_edge_egress_ledger_initialized_total` | counter | Missing ledgers initialized; no labels. |
| `merkur_edge_sessions_active` | gauge | Registry slots with at least one peer attached. |
| `merkur_edge_sessions_paired` | gauge | Slots with both roles attached. |
| `merkur_edge_route_mailbox_drops_total` | counter | Datagrams dropped because the destination mailbox was full, by `role`. |
| `merkur_edge_session_attach_total` | counter | Attach attempts by `role` and `outcome`. |
| `merkur_edge_handshake_failures_total` | counter | Sessions rejected before splice admission. |
| `merkur_edge_datagram_egress_drops_total` | counter | Datagrams dropped at egress under backpressure. |
| `merkur_edge_datagrams_superseded_total` | counter | Unsent datagrams discarded when a browser leg blocked. |
| `merkur_edge_contained_stream_drop_panics_total` | counter | Panics contained while closing a QUIC stream; non-zero means a poisoned quinn mutex. |
| `merkur_edge_reliable_write_timeouts_total` | counter | Lane setup or record operations abandoned at their deadline. |
| `merkur_edge_pump_settle_timeouts_total` | counter | Session pumps aborted at the shutdown timeout. |
| `merkur_edge_unpaired_pruned_total` | counter | Half-paired slots retired by the expiry sweep. |
| `merkur_edge_cert_rotations_total` | counter | Certificate rotations by outcome. |
| `merkur_edge_registration_publish_total` | counter | Registration publish attempts by outcome. |
| `merkur_edge_quic_datagrams_total` | counter | QUIC DATAGRAM frames received and sent; the denominator for the drop counters. |
| `merkur_edge_quic_packets_sent_total` | counter | QUIC packets sent on a peer connection. |
| `merkur_edge_quic_packets_lost_total` | counter | QUIC packets declared lost. |
| `merkur_edge_quic_congestion_events_total` | counter | QUIC congestion events, as distinct from random loss. |
| `merkur_edge_quic_black_holes_total` | counter | QUIC black holes detected. |
| `merkur_edge_quic_udp_bytes_total` | counter | UDP payload bytes including retransmits (`By`). |
| `merkur_edge_session_rtt_ms` | histogram | Final QUIC path RTT at teardown (`ms`). |
| `merkur_edge_session_mtu_bytes` | histogram | Final QUIC path MTU at teardown (`By`). |
| `merkur_edge_session_duration_ms` | histogram | Peer attachment lifetime by role and exit reason (`ms`). |

## Build, run, and deploy

Build from the repository root so the workspace lockfile and the vendored QUIC and
WebTransport patches apply. Run against a server that accepts edge registration:

```bash
MERKUR_EDGE_REGISTER_URL=http://127.0.0.1:3100/api/edge/register \
MERKUR_EDGE_REGISTRATION_KEY=<canonical-base64url-64-byte-key> \
MERKUR_EDGE_ATTACH_TICKET_KEY=<the server's EDGE_ATTACH_TICKET_KEY> \
MERKUR_EDGE_ID=local-1 \
MERKUR_EDGE_REGION=local \
MERKUR_EDGE_PUBLIC_URL=https://127.0.0.1:4433 \
MERKUR_EDGE_IDENTITY_DIR=.local/edge-identity \
MERKUR_EDGE_EGRESS_INTERFACE=lo0 \
MERKUR_EDGE_DATA_BUDGET_GB=1000000 \
MERKUR_EDGE_SIGNALING_RESERVE_GB=100000 \
cargo run -p merkur-edge
```

Use `lo` instead of `lo0` on Linux.

`cargo test -p merkur-edge` runs the in-memory and real-QUIC regressions. `probe` exercises a
running edge with one reliable echo lane plus datagrams; `hol_probe` floods a display lane
while pinging a control lane and fails on head-of-line inflation. The real-browser topology
test runs two replicas in Chromium through a coordinated certificate rotation:

```bash
MERKUR_EDGE_URL=https://localhost:4433 MERKUR_EDGE_CERT_HASH=<base64-sha256> \
MERKUR_EDGE_ATTACH_TICKET_KEY=<the edge's attach ticket key> \
cargo run -p merkur-edge --bin probe
bun run test:e2e:edge-topology
```

### Forwarding profiles

The ignored release test `authenticated_forwarding_profile` uses the real accept loop,
signed attach tickets, and QUIC endpoints from the liveness fixture. Endpoints verify every
opaque datagram and reliable body. Run it alone, with no builds or other workloads in flight:

```bash
EDGE_PROFILE_WORKLOAD=typing EDGE_PROFILE_WORKERS=default \
cargo test --locked --release -p merkur-edge --bin merkur-edge \
  authenticated_forwarding_profile -- --ignored --nocapture --test-threads=1
```

`EDGE_PROFILE_WORKLOAD` selects `typing` (57-byte closed-loop datagrams), `burst` (32-datagram
display bursts), `slow` (typing while a reliable receiver has exhausted stream credit), or
`concurrent` (eight sessions). The slow case waits for the actual QUIC stream-credit event,
then verifies backpressure and drains every reliable record. `EDGE_PROFILE_WORKERS` selects
Tokio's `default` worker count, `current` for a single-thread runtime, or a positive worker
count. It affects the entire fixture, including its endpoints; scheduler conclusions need
an isolated edge process and unchanged endpoint runtimes too.

The `@@edge-forward-profile` JSON reports delivered latency and receive-to-egress-admission
residence distributions, datagram-pump polls, waker invocations, poll-scoped allocations and
allocated bytes, and egress drops. Residence ends at QUIC queue admission, before network
delivery. Waker invocations are neither kernel wakeups nor context switches. Allocation
counts cover the two datagram pumps, including queue metadata; they exclude endpoint and
QUIC-driver allocations. Instrumentation is test-only. The ownership regressions separately
check that datagram payloads and reliable chunks keep their received storage at admission.

Use `hol_probe` against a separately running edge for persistent reliable-flood contention,
and the browser transport harness for server issuance, Noise authentication, PTY traffic and
presentation. Retain exact native artifacts and compare equal completed work, latency tails,
CPU and RSS as described in [the performance guide](../../docs/performance.md).

The image is `apps/edge/Dockerfile`, built from the repository root so one lockfile describes
the edge whether cargo or the image builds it; it drops to an unprivileged user before the
binary starts. Replicas are listed in `apps/edge/replicas.json` (id, app, region, public
URL, rate cap, data budget, and signaling reserve). `scripts/edge-fly-config.ts` renders everything else into a per-replica `<edge-id>.toml`
under an ignored `fly/` directory inside `apps/edge`, so no deployment manifest is tracked,
and it refuses a duplicate id, app, or URL, a non-canonical public URL, and a region missing
from `ZONE_BY_FLY_REGION`, which would leave `selectEdge` unable to rank the replica.

```bash
bun run edge:fly-config list                    # what is deployed, and where
bun run edge:fly-config render <edge-id> <ver>  # writes the manifest for one replica
```

Adding a replica: give it a dedicated public address that routes to exactly one machine, a
persistent volume for `MERKUR_EDGE_IDENTITY_DIR`, and its own registration key as a secret;
add that key to the server's `EDGE_REGISTRATION_KEYS_JSON`; add the entry to
`apps/edge/replicas.json`, render, and deploy with the rendered manifest and
`apps/edge/Dockerfile`. Browsers and daemons learn the URL and pin from the server, so no
client release is involved. The release tooling owns the procedure that deploys every replica.
