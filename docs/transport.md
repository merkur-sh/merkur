# Merkur Transport

This document explains how a browser or native terminal client reaches a remote machine through Merkur: the
three parties involved, the one rule that shapes everything else, how a session is set up and
authenticated, how a connection survives a network change, what the relay in the middle can and
cannot see, how a direct path is found through NAT, and what travels on each logical channel.
Display encoding has its own reference, [`docs/display-invariants.md`](display-invariants.md);
the trust model has [`docs/security.md`](./security.md).

- [Overview](#overview)
- [Native Client Adapter](#native-client-adapter)
- [Daemon Control Plane](#daemon-control-plane)
- [Session Establishment](#session-establishment)
- [Browser Transport States](#browser-transport-states)
- [Edge Relay](#edge-relay)
- [Direct-Path Candidates](#direct-path-candidates)
- [STUN Responder](#stun-responder)
- [Logical Channels](#logical-channels)
- [Input Records](#input-records)
- [Display Codec, Compression, And Recovery](#display-codec-compression-and-recovery)
- [Security And Correctness Invariants](#security-and-correctness-invariants)

## Overview

Three parties take part in every session:

- The **client** is the SolidJS browser app or `merkur-tui`. Browser main owns the UI and input;
  workers own transport, the terminal grid and telemetry. Native input, the viewer and ANSI
  composition live on the UI reactor, with transport on a separate reactor.
- The **server** (`apps/server`) owns accounts, devices, presence, and the issuance of
  short-lived session capabilities. It talks to clients over HTTPS and server-sent events, and
  to each daemon over one persistent authenticated WebSocket.
- The **daemon** runs on the machine that owns the terminal. A Bun process handles setup and
  orchestration; the Rust **dataplane** (`apps/daemon/dataplane`) owns the PTY, the encryption,
  and every latency-sensitive byte.

The invariant: **the server is never in the terminal hot path.** Keystrokes, display frames,
acknowledgements, repair, and forward error correction flow between client and dataplane only.
The server coordinates who may talk to whom and then steps aside.

Terminal traffic takes one of two routes. The default is the **edge** (`apps/edge`), Merkur's
blind relay: a WebTransport server that pairs a client connection with a daemon connection by
a rendezvous id and splices bytes between them. The optional route is a **direct path**, a
WebTransport connection from the client straight to the daemon, dialled when the daemon can
advertise a reachable address. Either way the terminal bytes are encrypted end to
end between client and dataplane with a Noise session keyed by ML-KEM-1024.

```text
 client ───HTTPS/SSE──▶ server ◀──WSS control link── daemon (Bun)
    │                                                     │
    │  WebTransport                            WebTransport│
    ▼                                                     ▼
  edge (blind relay) ◀════ sealed terminal frames ════▶ dataplane (Rust)
    ▲                                                     ▲
    └──────── optional direct WebTransport path ──────────┘
```

| Party | Sees | Never sees |
| --- | --- | --- |
| Server | Accounts, devices, presence, session allocation, the capability it signs | Terminal bytes, display ACKs, Noise keys |
| Edge | Rendezvous id, role, daemon id and attach ticket from the routing preface; lane, size and timing of frames; the plaintext signaling channel `0x00` and the data-attachment handshake on `0x06` | Terminal plaintext, the ML-KEM shared secret, any reusable key, the daemon identity seed |
| Dataplane and client | Everything | |

Channel `0x00` is plaintext by design: capabilities, delegation certificates, ML-KEM public keys
and ciphertexts, signatures, and Noise handshake messages are readable there, and none of them
unlocks anything on its own. Merkur provides no traffic-analysis resistance, and because the
server serves the browser application, a compromised server origin can replace the client.

## Native Client Adapter

`packages/merkur-client` owns a sans-IO session and viewer. Its host supplies monotonic time,
entropy, received bytes and readiness; its actions request HTTPS, carrier operations, sealed
writes and presentation. `packages/merkur-client-native` executes those actions using Tokio,
reqwest with rustls/ring, and WebTransport. `apps/tui` owns the host terminal and feeds the same
input records and display grants that the daemon accepts from a browser.

The native client uses the existing `browser` wire role and a root-signed account delegation.
It sends its canonical account `Origin` on account requests and WebTransport connections;
it does not synthesize browser fetch-metadata headers. Refresh uses the same `merkur_refresh`
cookie contract, carried by the native account adapter and stored through the platform's
credential custody. Certificate hashes from the issued edge coordinates pin the carrier, and
each renewal's answer replaces them.
Device kind and platform labels identify it as Merkur TUI in the account's session list;
those labels grant no authorization.

OS interface notifications are recovery hints. The native watcher discards its initial address
snapshot, ignores loopback and link-local churn and coalesces a path-change burst. A hint can
start an authenticated probe and candidate race; only carrier and peer evidence decide whether
the path is usable. The session's recovery and rebind rules remain the authority. Browser-only
Chromium endpoint admission and local-network permission handling stay in the browser adapter.

The native machine list reads `GET /api/devices/events` on its transport reactor. It retains
the exact event cursor across stream reconnection, accepts a resume only for that cursor and
marks presence unavailable while the stream is disconnected. Account-session revocation uses
that same authenticated event stream to retire native terminal sessions.

## Daemon Control Plane

The control plane exists so the server can tell a daemon "a browser wants a session" and know
whether that daemon is alive. It carries registration, liveness, lease renewal, presence
ownership, and session commands. It never carries terminal bytes.

### Authentication and registration

The daemon connects to `/api/daemon/control` on its configured `server_origin`. The WebSocket
upgrade carries the persistent `daemonId` in `x-merkur-daemon-id`, the release identifier in
`x-merkur-version`, and an optional `x-merkur-resume-presence`. The server answers with an
`auth_challenge` holding a fresh nonce. The dataplane signs it with both halves of the linked
composite identity, ML-DSA-87 plus a hardware-resident P-256 key, binding the public control URL
and every upgrade header. The server gives that proof 5 s. No presence and no command authority
exist before it lands. `wss://` is mandatory outside explicit loopback development. The exact
proof and replay rules are in [`security.md`](./security.md#daemon-management-proofs).

| Direction | Message | Meaning |
| --- | --- | --- |
| server to daemon | `auth_challenge` | Fresh nonce to sign |
| daemon to server | `auth_proof` | Composite signature over nonce, URL and upgrade metadata |
| server to daemon | `registered` | Presence claimed; carries the current revocation generation, the edge attach ticket and every registered edge's URL and certificate hashes |
| server to daemon | `lease` | Answer to each lease renewal; carries the revocation-generation bound, a fresh STUN ticket, a fresh edge attach ticket and the registered edges again |
| server to daemon | `revocation` | The user's revocation generation moved |
| server to daemon | `session_start` | Authenticated control offer for one session |
| server to daemon | `session_cancel` | Withdraw a pending session |
| server to daemon | `delegation_revoke` | Signed statement revoking one browser delegation |
| server to daemon | `superseded` | A newer connection for the same `daemonId` took over |
| daemon to server | `command_ack` | The only daemon-originated message; every command has a unique `commandId` |

The server tracks sockets by an ephemeral `connectionId`; logical ownership and cryptographic
identity always use `daemonId`. The presence record in Redis holds `daemonId`, `userId`,
`ownerInstanceId`, `connectionId`, `presenceId`, `claimSeq`, `state` (`online`, `silent`, or
`suspended`), `zone`, and `updatedAt`. A newer connection supersedes the older one, and a stale
presence fence can neither dispatch nor complete a command.

### Liveness, lease, and teardown

Liveness is not a message. The daemon sends a WebSocket ping frame on a fixed cadence and the
server observes it at the transport layer, with no parse and no Redis round trip. The cadences
are defined in `apps/server/src/services/daemon-control-service.ts`:

| Event | Value | Effect |
| --- | --- | --- |
| Ping interval | 2 s | Daemon sends a WebSocket ping |
| Silent after | 5 s without a ping | Presence marked `silent`; the browser shows the device down; the lease is untouched; the next ping clears it |
| Carrier torn down | 15 s without a ping | Connection closed; the daemon reconnects and re-registers |
| Lease renewal | every 20 s | One batched Redis round trip per server instance, answered with `lease` |
| Lease TTL | 60 s | Held through a reconnect so live sessions survive a blip |
| Shutdown close code | `4004` | Deliberate stop; lease and sessions released at once |

A daemon that is deliberately stopping closes with code `4004` because its PTYs went with the
process. Every other close is a lost carrier whose lease is held through the grace window, and
the daemon reconnects with exponential backoff and full jitter. Two teardowns are named by the
daemon instead of inferred from a missed pong. **Process suspension**: overshoot of the ping
sleep beyond `SUSPENSION_GAP_THRESHOLD_MS` (5 s) can only mean the process was not running, so
the carrier is retired at once as `suspended` and the reconnect skips the backoff ladder.
**OS network path change**: the dataplane publishes one coalesced edge per transition that could
change the published candidate set, and the daemon reconnects on the ordinary ladder.
When a path change arrives during backoff, it wakes the pending retry immediately. That
attempt retains the ladder's position, so another failure still backs off normally; the
consumed edge cannot tear down the new carrier.

The daemon's control-health states are `starting`, `connecting`, `registering`, `registered`,
`backoff`, and terminal `superseded`; dataplane-health states are `starting`, `ready`, `down`,
and `fatal`. Aggregate readiness is `registered` plus `ready`.

### Device-list events

The browser's device list is fed by one SSE stream per open list, `GET /api/devices/events`,
carrying one absolute `delta` frame per change under a cursor `<epoch>:<seq>` that is also sent
as `x-merkur-device-events-since`; a matching cursor is answered with a zero-byte `resume`,
anything else with a snapshot. Row edits (a rename, an unlink, a daemon reporting a build the row
does not hold) commit a `devices` resync to the notification outbox in the same transaction;
publishing it advances the cursor, so open lists and cached cursors reload a snapshot rather than
resume. A keep-alive every `DEVICE_EVENTS_KEEPALIVE_MS` (15 s) lets the
browser condemn a half-open stream (`packages/shared/src/device-events.ts`), and a row shows live
presence only while its stream is live. The stream is fetched and read in the event-stream worker
(`apps/web/src/event-stream-worker.ts`), never on the main thread: iOS WebKit holds a streamed
body's queued chunks while the reading thread is busy, which after a sign-in left the opening
frame undelivered until the next keep-alive.

## Session Establishment

Session establishment turns "this browser, holding this delegation, wants this daemon" into a
Noise session between browser and dataplane, with the server vouching for both sides once and
then leaving the path. The whole exchange after issuance is three flights.

1. The browser unlocks the browser's 30-day delegation from its profile-local vault while the
   crypto runtime initialises. It creates a fresh 32-byte nonce and a one-use ML-KEM-1024 keypair
   and requests a session over authenticated HTTPS with the delegation id and a new issuance id.
2. The server checks that the delegation is active, checks account ownership and the user-root
   daemon binding, resolves the daemon's composite identity, prepares a durable issuance, and
   selects one healthy edge replica.
3. The server dispatches a uniquely identified `session_start` to the daemon's owning replica,
   through fenced Redis pub/sub when the owner is another instance. The offer binds user, browser
   delegation, browser, session, browser nonce, and the one-use ML-KEM public key. The daemon
   acknowledges only after the dataplane admits the command to its bounded queue; a rejection or
   an acknowledgement timeout fails the request closed.
4. The server returns the edge coordinates, the daemon's public identity and user-root binding,
   the rendezvous/session id, and a short-lived ML-DSA-87 capability with canonical payload
   `{u,g,b,d,s,k,q,iat,e}`. `g` fixes the delegation, `k` fixes the daemon identity, and `q`
   fixes the exact browser nonce and ML-KEM public key. It names no browser address: the daemon
   learns that from the edge (see The browser's address).
5. Browser and daemon each dial the edge and present the rendezvous id and their role. The edge
   pairs the two sessions and reads only the routing preface.
6. **Flight 1.** The browser signs the complete capability/session/KEM request transcript with its
   delegate ML-DSA-87 key. `session_auth` carries the capability, session, nonce,
   one-use ML-KEM public key, root-signed delegation certificate, delegate signature, and Noise
   message 1. The daemon matches the tuple against the control offer, verifies the capability
   including `g`, `k`, and `q`, the user-root daemon binding, the fixed-30-day delegation
   certificate, its local revocation tombstones, and the delegate signature, claims `q` against
   replay, and encapsulates once with fresh entropy.
7. **Flight 2.** `session_ready` carries a fresh daemon nonce, the ML-KEM ciphertext, the next
   input sequence, Noise message 2, and two signatures over the complete request/response
   transcript: `daemon_signature` (ML-DSA-87) and `p256_signature` (canonical low-S P-256). A
   bounded signing worker owns the hardware call and never touches input or display work. The
   transcript includes a digest of the verified delegation proof, so the signatures and the key
   derivation bind the authorization chain. The browser requires both signatures before it
   decapsulates.
8. Both ends run HKDF-SHA-512 over the ML-KEM shared secret and the signed response transcript.
   Independent labels derive the Noise PSK and the direct-upgrade key. **Flight 3** is Noise
   message 3 of `Noise_XXpsk3_25519_ChaChaPoly_SHA512`. The prologue binds the session id, the
   canonical `daemonId`, and the request transcript hash. Terminal channels open only after Noise
   is established.

The handshake is fused into the flights above because the browser cannot bind a response it has
not yet received; an unfused Noise handshake would cost two more round trips.

### Issuance records

The HTTP routes handle schemas, authentication, trusted-proxy IP resolution, status mapping,
and the timing header. `apps/server/src/services/session-service.ts` owns request, renewal,
cancellation, and account revocation. Request and renewal resolve the linked daemon through
one identity boundary, matching its binding to the account, daemon id, and composite public-key
commitment before signing or changing issuance state. The HTTP timing header includes stage
timings only after same-user presence is established or a durable issuance succeeds.

The first connect creates a durable issuance record coordinated by
`apps/server/src/services/session-issuance-service.ts`. Its contracts live in
`apps/server/src/services/session-issuance-contract.ts`; atomic Redis scripts, leases and
subscriptions belong to `apps/server/src/services/session-issuance-store.ts`; exact record
shapes and decoding belong to `apps/server/src/services/session-issuance-codec.ts`:

| State | Meaning |
| --- | --- |
| `allocating` | Session requested; predecessor and delegation checks running |
| `prepared` | Durable session and edge selection written; `session_start` dispatched |
| `committed` | Daemon acknowledged; capability returned to the browser |
| `superseded` | A successor with the same user/delegation/daemon/browser lineage and a different `q` atomically replaced it |
| `cancelled` | Issuance withdrawn; the daemon cancels it only if Noise has not completed |
| `expired` | Capability lifetime ran out |

Creating an issuance installs its initial record and first owner lease in one atomic Redis
script. Existing records still acquire and re-read under the lease before dispatch, so
concurrent requests cannot deliver the same session command twice. Every commit remains
fenced by that owner and the exact stored record. Preparation and durable replay both require
the response's session, daemon, account, and daemon-binding identity commitment to match the
record. Terminal records retain identity without prepared credentials. Records have one exact
shape per state and no schema-version field; stored records are discarded when that shape
changes.

An expired capability, a verified rebind refusal or an absent counterpart ends its attempt
before fresh issuance rotates everything: new issuance id, session id, nonce, ML-KEM keypair, capability,
delegation proof, and Noise handshake. A carrier loss inside the rebind window keeps the issuance
and session id and re-authenticates against the daemon's retained tunnel (see Browser Transport
States). The server returns a relative `sessionTokenExpiresInMs` beside the absolute expiry, and
the browser snapshots only the relative value into its monotonic clock, minus the HTTPS round
trip and a 1 s safety margin, so a borrowed phone's wall clock is never trusted.

An explicit `auth_failed` from the current signaling attachment terminates the session during
authentication only: the record is unsigned, so once the daemon has authenticated it is
ignored. A final HTTP 401 or 403 from issuance or renewal, after the
account's one access-token refresh attempt, also terminates authorization: queued input is wiped
and all incumbent and candidate carriers retire. Transport closure and HTTP availability failures
do not establish revocation and retain their ordinary recovery behavior.

Issuance ownership and cancellation obligations are separate on the browser main thread.
Each failed attempt, explicit owner cancellation, or worker failure abandons only its exact
unfinished issuance; online and visibility events retry existing cancellation obligations without
creating any. An unknown HTTP outcome remains cancellable by issuance id. A successful worker connection releases its
issuance from that bookkeeping. The daemon serializes cancellation with Noise completion: a
matching peer with installed Noise ignores issuance cancellation without creating a tombstone
or retiring its tunnel. Closing that live session uses the authenticated peer disconnect;
delegation revocation remains a separate authorization operation.

### Path selection

The shared session retains authenticated direct and relay providers. It ranks them by lowest
RTT, with an unmeasured provider ranking after every measured one and registration order
breaking ties. Selection uses a 0.3 EWMA and a **biased** figure: every relay
sample has `DIRECT_PREFERENCE_GRACE_MS` (12 ms, `packages/merkur-client/src/session/path_selection.rs`)
added before it is recorded, so a relay path must beat the direct path by more than 12 ms to
win. The displayed RTT uses the raw sample.

The sample must measure the network, not a queue. The browser seals a heartbeat probe once per
provider, the daemon answers on the carrier the probe arrived on, and only the datagram copy of
the pong is a sample; display ACK round trips never feed the ranking. A typing emit's probe rides
its own `input_run` and is answered on arrival; only the emit's synchronous seals carry it, so
no sample includes the time a run waited for credit, a retry, or a deferred reliable copy. Direct admission adds a
path to the existing authenticated session and preserves the display generation, row baselines,
and the acknowledged compression dictionary. The daemon's direct-WebTransport certificate is
self-signed and short-lived; rotation swaps the TLS configuration on the live socket, and a
manifest carrying the new hash is the whole handoff.

### Browser delegation revocation

The browser's 30-day delegation, its access token, and its refresh family all name the same
`delegationId`. Access tokens last at most 15 minutes; refresh rotation cannot extend the
certificate's fixed expiry. A revocation from Settings or an explicit logout disables the target
refresh families at once and writes one durable outbox command per linked daemon. For each
`delegation_revoke`, the dataplane verifies the root-signed actor certificate and the
delegate-signed target statement, persists the tombstone, and evicts affected peers before the
command is acknowledged. An already active direct transport therefore ends only when the daemon
receives the statement, so revocation can be delayed while a daemon is offline.

## Browser Transport States

These states exist so the UI can tell the truth about the connection and so recovery acts on
evidence rather than on timers. The rule that shapes them: **only proof displaces a carrier.**

### Lifecycle

The shared Rust session owns authentication, recovery and the heartbeat ladder. The browser
adapter projects its status into the UI: connecting and authenticating show Connecting,
authenticated readiness shows Connected, recovery shows Reconnecting, and a paused relay
retains its explicit paused state. A terminal failure closes the worker owner. Session-ready
signaling alone never enables terminal controls: completed Noise authentication and the data
attachment's acknowledged pairing are required.

An established session can remain dormant while it has no working path. Dormancy has no browser
teardown deadline; only authenticated readiness or a terminal lifecycle event ends it.

### One recovery owner

`packages/merkur-client/src/session.rs` owns one attempt and one retry schedule from issuance
through hybrid authentication and established Noise. Queuing or writing `session_auth` is only
a milestone. Initial and resumed HTTP availability and carrier failures share the same
exponential retry history; authenticated readiness resets it. Invalid issuance responses,
binding or authentication failures, explicit authorization denial, and an unlinked daemon
terminate the owner. The terminal owner's `browserNodeId` stays
stable across all attempts. Attempt and carrier generations fence RPC results, callbacks,
watchdogs, and cancellation. A replacement owner waits for the old attempt's cleanup.

Connectivity hints during an attempt neither interrupt it nor queue a successor. During backoff,
a hint wakes the existing wait without resetting its exponent. On an established session it may
start one authenticated candidate while the incumbent continues serving. A page suspension of at
least `CARRIER_IDLE_DEATH_MS` is evidence for that race, not proof of native carrier death.
Suspension does not establish either remote peer's detach time, so elapsed page wall time never
forces fresh issuance or ends recovery. IPv4 and IPv6 browser-IP observations are kept separately;
a change within one family releases direct-candidate admission only.

The main thread bridges credentials and HTTP, forwards DOM hints, projects status, and replaces a
failed worker once per explicit failure. It has no session retry ladder or reachability breaker.
The UI stays Reconnecting through transient failures and becomes Connected at authenticated
readiness. Explicit authorization rejection, an unlinked daemon, owner cancellation, and sign-out
end recovery; no retry count does. A worker failure ends that worker's owner and starts its replacement.

### Detecting a dead carrier

The heartbeat (`packages/merkur-client/src/liveness.rs`) measures acknowledged uplink
progress. Outbound traffic arms a one-RTO deadline; an unanswered probe starts a candidate
without retiring the incumbent. Connectivity and resume hints can start the same race immediately.
The candidate uses an isolated proof stream, so a completed edge dial alone cannot displace a
working session.

A dead carrier need not report its death. A WebTransport that died while the page was suspended
can stay open in the browser with a datagram write that never settles. The browser host writes
datagrams on one lane per carrier (`apps/web/src/transport/carrier-datagram-lanes.ts`): a stalled
write holds only that carrier's later datagrams, and the candidate dial, account requests, and
every other carrier's traffic proceed.

The steady tick and the probe ladder send CTRL pings. An input emit carries its probe in its
`input_run` instead, on the datagram of each provider and on the reliable copy the same drain
step sends. The daemon answers it after offering the run to the PTY, without waiting for the
write, on the arriving carrier: the pong datagram is the sample. The reliable CTRL twin rides
along only when no input ACK will follow promptly, because the PTY writer was busy or the run
waited on a gap, a refusal or retained input; otherwise that ACK and its own twin cover a lost
pong. A carrier answers a token once. One double fault still costs a candidate dial: a gated
PTY lane and the loss of the one datagram that carried the probe. The ladder's CTRL probe then
answers, and the dial retires without an eviction.

| Event | Effect |
| --- | --- |
| Pong or input ACK covering the armed emit, with live incumbent signaling and before the candidate final | Cancel the candidate and keep the incumbent |
| First unanswered probe or connectivity hint | Dial and authenticate one candidate concurrently with incumbent probes |
| Candidate final sent | Retain both possible secrets; later incumbent traffic cannot roll back a possible commit |
| Authenticated successor commit acknowledgement | Publish the candidate and retire the incumbent |
| Candidate closes before its final | Dispose only candidate state |
| Candidate dial the edge does not take | Also renew, so the next candidate pins the hashes the edge serves now |
| Candidate closes after its final | Reconcile the exact pending attempt on the next candidate |
| No daemon attachment at the edge | Request a new issuance to restore the daemon leg |

Once the incumbent signaling carrier closes, its confirmed data attachments may continue
serving until they close or the successor commits. Recovery does not redial or claim data
attachments for that dead signaling owner: the authenticated successor opens its own pair.
Unconfirmed attachments retire immediately, including repairs whose dial is still queued.
Traffic from a surviving data attachment cannot cancel the replacement of closed signaling.

Inbound display alone proves only the downlink. A pong or an input ACK covering emitted input
proves the round trip. Attempt timers bound retained work; they cannot prove remote death.
Dormancy remains separate from candidate selection and is not armed while a direct path carries
the terminal. Input retains its existing wire sequence namespace across a rebind: the incumbent
can advance after the daemon captures the answer's input watermark, so that snapshot must not
renumber later input. Once a candidate final has been sent, incumbent progress and a late
incumbent data acknowledgement cannot report Ready: the final may already have committed at
the daemon. An unresolved final retains its reconciliation retry even if predecessor progress
settles liveness or a subsequent dial fails. Once publication selects a successor, its
interactive data acknowledgement restores readiness.

### Recovery budget

| Phase | Wait | Bound |
| --- | --- | --- |
| Detect | First unanswered RTO, or an immediate connectivity hint | RTO is `RTO_INITIAL_MS` (1000 ms) before a sample, then SRTT + 4·RTTVAR clamped to `RTO_FLOOR_MS` (250 ms) .. `RTO_CEIL_MS` (3000 ms) |
| Dial candidate | Concurrent with incumbent probes | Rust `Session` arms `AUTH_PHASE_WATCHDOG_MS` (10 s) when it creates the candidate; native carrier handshake and routing-preface completion must arrive within it |
| Authenticate candidate | Request/answer, then final/commit acknowledgement | Rust `Session`'s `AUTH_PHASE_WATCHDOG_MS` (10 s) |
| Publish | Verified successor acknowledgement | Data attachments activate after publication |

The client RTO constants live in `packages/merkur-client/src/liveness.rs`; authentication and
recovery attempt bounds live in `packages/merkur-client/src/session.rs`. Signaling has independent transport ownership and
congestion state from display at every hop. Candidate proof records use their own bounded stream
and queues. A dial that cannot reach the edge retries; an absent daemon attachment causes full
issuance. Every edge handshake of the page passes one admission queue in front of Chromium's
per-page WebTransport throttle, which delays each handshake exponentially in the number still
pending and keeps a repeated failure to the same address pending for five minutes. A request
cancelled in that queue never reaches Chromium. A started handshake is never cancelled, because
cancelling it counts as a failure; an abandoned one is closed after Chromium decides it. After a
failed handshake only one runs at a time until one succeeds, and none starts while the browser
reports no network. An authenticated `session_rebind_refused` answers policy rejection immediately. Expiry
or generation exhaustion obtains a fresh authorization epoch and retries with a fresh KEM key
while retaining the candidate's routing nonce. Other verified refusals lead to full issuance.
Lost commit evidence is reconciled under the two possible chaining secrets before another rebind;
transport presence cannot authenticate a refusal or a successful answer.

### Daemon peer lifecycle

One owner loop owns all peer state. A counterpart detach is classified once
(`classify_counterpart_detach`) into one of four outcomes:

| Outcome | Condition | Effect |
| --- | --- | --- |
| `Ignore` | A direct path is still available | Nothing changes |
| `Retire` | Unauthenticated, or no display cache | Peer dropped |
| `Park` | No rebind lineage | Tunnel closed, lineage and Noise cleared, display cache kept for `PARKED_PEER_TTL_MS` (30 min) |
| `Rebind` | Otherwise | Tunnel held; a carrier-gap window is armed for `REBIND_WINDOW_MS` (60 s) minus one heartbeat tick |

Within the window a `session_rebind` is admitted only on an exact generation match and a valid
chaining-secret proof (`apps/daemon/dataplane/src/session/rebind_flow.rs`). Invalid proofs leave
the lineage unchanged; identical retransmissions reuse the held answer. Each signed authorization
epoch permits `MAX_REBIND_GENERATIONS` (8) commits before renewal. The daemon enforces the actual
capability and delegation deadlines. An expired epoch stays retained within the carrier-gap window
so the browser can renew it over the isolated signaling lane. Renewal creates no issuance, resets
no terminal/input/display state, and does not change the cryptographic generation.
The one commit point is the authenticated successor Noise final message; a valid request alone
never spends the chaining secret. A failed or expired attempt leaves the incumbent keys intact.
A committed final retires the predecessor data attachments and waits for the successor's
interactive data rendezvous. This pending attachment is not an all-paths-down event and does
not arm a carrier-gap window. A matching interactive HELLO completes it; retirement of the
owning signaling lane ends the wait and restores normal loss classification. A replacement
interactive attachment announced over authenticated signaling follows the same rule.
The 60 s window matches the edge's unpaired-slot lifetime. Those windows begin on each
remote peer's own detach event; the browser uses the counterpart's protocol outcome rather
than inferring their expiry from its page-suspension duration.

## Edge Relay

The edge exists so a daemon behind NAT can be reached without the server touching terminal
bytes. It terminates WebTransport and forwards application frames blindly. It holds no account
material, no session-token signing key, no Noise PSK, and no terminal decryption path. It runs as
UID/GID 10001 with all capabilities dropped and `no_new_privs` set; only `/data/identity` is
writable, for its certificate (see
[runtime restrictions](releases.md#runtime-filesystem-restrictions)).

### Three connections and the routing preface

Browser and daemon each open three independent QUIC connections: signaling
(`<session>#signaling`), interactive data (`<session>`), and receive-oriented bulk data
(`<session>#bulk`). Signaling never shares a congestion window, pacer, reliable queue, or PTO
backoff with display. Each connection starts with a length-delimited routing preface:

```json
{
  "session_id": "opaque-rendezvous-id",
  "role": "browser",
  "version": 8,
  "attachment": { "kind": "primary" },
  "daemon_id": "daemon-id",
  "ticket": "server-signed-attach-ticket"
}
```

The daemon sends the same shape with `"role": "daemon"` and
`"attachment": { "kind": "tunnel", "incarnation": "<base64url-16-bytes>" }`, naming the dataplane
process that dials (see [daemon incarnations](#daemon-incarnations)). The ticket is the edge's admission
check, verified before the peer reaches the splice registry: the browser's comes with its
session issuance and binds that session and daemon for the session's whole life, rebinds
included; the daemon's rides every control lease, binds only its daemon id, and expires after
90 s, so an unlinked or disconnected daemon stops being admitted. A slot pairs only
attachments naming one daemon. The format and its bounds are in
[`apps/edge/README.md`](../apps/edge/README.md#routing-preface). The preface stream stays open, and its
reverse direction carries `SpliceControlEvent`s in the same `[u32 BE len][JSON]` envelope:
`counterpart_present`, `counterpart_attached`, `counterpart_detached`, `counterpart_responsive`,
and `counterpart_probing`, each naming the concrete counterpart attachment id so a delayed event
from a replaced carrier cannot revive stale evidence. The signaling-only
`relay_data_paused` event instead carries one boolean `paused`, describing the edge budget.
The relay admits a ticket, not a
session: it never authenticates either end, so a verdict may only make a peer wait longer or
stop waiting sooner; it can never make a peer accept, admit,
spend, or discard anything. The daemon also opens one stream prefixed `merkur-edge-quote-v1`, on
which the edge writes QUIC delivery quotes for the browser-facing leg
([observability](observability.md)).

### Candidate handover

A browser signaling preface may instead carry
`"attachment": { "kind": "candidate", "nonce": "<base64url-32-bytes>" }`.
The edge does not insert that candidate into the splice registry. It opens a proof stream to the
exact existing daemon signaling attachment and forwards the routing nonce as bounded metadata.
The request MAC covers the same nonce. A candidate cannot send terminal data or replace the
incumbent through this path.

The second browser bidirectional stream carries `[u32 BE length][opaque proof]` records. The
daemon's responses add one edge-facing selection byte before that envelope. Only the serialized
daemon owner can mark its committed candidate for selection. The edge compares the retained daemon
attachment id under the registry lock before replacing the browser; a changed or expired daemon
attachment invalidates promotion. The edge strips the selection byte and relays the authenticated
acknowledgement. The browser verifies it before publishing successor Noise and activating its
interactive and bulk prefaces.

Proof records are limited to 64 KiB. The edge admits at most 64 concurrent proof tasks and two per
daemon signaling attachment; the daemon admits two proof streams per signaling connection. Each
attempt has a 10 s retention bound and bounded request/response queues. Closing a candidate
revokes its exact reply owner. Neither capacity refusal nor candidate failure retires the incumbent.

### Stream framing

After the prefaces the edge forwards opaque datagrams and two kinds of reliable stream. A
**durable** stream carries a one-byte prefix with the high bit clear and a seven-bit channel id,
then repeated length-delimited bodies. On egress the edge prepends the source attachment id once
per stream:

```text
endpoint → edge: [channel: u8][body_len: u32 big-endian][opaque body]...
edge → endpoint: [source_attachment: u64 big-endian][channel: u8][body_len][opaque body]...
```

A **finite** stream sets the prefix's high bit and carries exactly one transfer:
`[prefix:u8][total_bytes:u32 big-endian][sealed bytes][FIN]`. It pins its destination attachment
and never rotates onto a successor. Finite transfers carry graphics content
([graphics contract](graphics.md)).

| Limit | Value |
| --- | --- |
| Durable slots per attachment | 5 |
| Finite slots per attachment | 32 |
| Finite transfer size | 16 MiB |
| Finite budget per destination direction | 64 MiB |
| Finite budget registry-wide | 256 MiB |
| Read batch | 16 chunks or 16 KiB |
| Datagram mailbox per session | 256 batches of up to 8 datagrams |

The datagrams one QUIC packet carried are read as one batch and, when there are several,
admitted to the destination under one egress hold, so they leave the edge in one packet too.

Credit is hop by hop: the relay reads a source batch only once its destination write returns, so
a daemon cannot put a whole image transfer ahead of every session's input and echoes. Finite
streams have lower priority than durable lanes, and interactive packets never wait on the image
pacer.

### Lanes and counterpart replacement

Signaling carries only channel `0x00`. Interactive carries datagrams, input, control, and
reliable display until bulk is proven. Bulk isolates large reliable display commits from input.
All three browser dials start in the same turn, signaling first; authentication never waits for
data dials. After Noise, the browser sends each data connection's `data_attach` nonce claim on
signaling and its HELLO on the data connection in the same flight.

A persistent reliable lane is **source-owned**, not pair-owned: its actor keeps the source
stream while a destination watch rotates across counterpart attachments, so one browser
`CONNECTION_CLOSE` cannot kill the daemon's long-lived lane and no partial record crosses an
attachment boundary. The daemon's three connections are durable; an ordinary browser rebind
attaches fresh browser connections and pays no daemon dial. Each fresh browser connection
resumes the capacity its predecessor on the same lane demonstrated (RFC 9959 Careful Resume,
see [performance](performance.md)) when the browser and edge addresses match, so the first
full-screen update after a same-network rebind does not slow-start from the initial window.
A daemon-side network path change
migrates the QUIC connection (connection id, not 4-tuple), costing one path-validation round trip
rather than a redial; Chromium performs no WebTransport migration, so a browser-side change runs
the full carrier rebind.

### Edge egress admission

Each edge replica meters its configured NIC once per second and keeps crash-conservative
monthly GiB reservations on its identity volume. Reaching the data budget retires interactive
and bulk splices and refuses their primary prefaces with application close code `0x4d03`
and reason exactly `egress-budget`; signaling labels
and candidate attachments remain available until the additional signaling reserve is spent.
At the combined threshold every attachment closes and incoming QUIC Initials are silently
ignored until the next UTC month. Every budget close uses that same code and reason;
peers require both, separately from `0x4d01` / `counterpart-detached`.

Primary and candidate signaling attachments receive `{"type":"relay_data_paused","paused":true}`
after their initial presence event only when already paused. `Open` adds zero attachment
bytes. The registry publishes the newest budget state before retiring data lanes; signaling
control writers send `true` on `Open -> SignalingOnly` and `false` on reopening at the first
new-month sample. `Stopped` sends no event. A pause event or a typed data-lane budget close
pauses both data lanes. Neither peer redials, counts attempts, parks, or rebinds for that
pause. A `false` event immediately dials exactly the paused lanes with fresh generations and
attempt budgets; no peer resume timer is involved. The daemon retains its peer while its
paired signaling attachment remains live. Direct negotiation and direct data remain usable.
The browser's existing link status shows a monthly relay pause when no direct carrier is
available, through the existing worker metrics message. A typed signaling-lane budget close
uses ordinary signaling recovery with the `edge-egress-budget` trigger and a budget status.
The relay remains blind to payloads. NIC samples include
retransmissions, handshakes, registration, and telemetry; sampled enforcement can overshoot
between observations and is not a strict wire-byte quota. The container's HTB cap separately
bounds the sending rate. See [the edge budget](../apps/edge/README.md#monthly-egress-budget)
for durability, counter-reset semantics, configuration, and operational limits.

### Registration and certificate rotation

Each edge registers its replica id, region label, replica-specific URL and two certificate
hashes, the one it serves and then the one it will serve next, at `POST /api/edge/register`
(`apps/edge/src/register.rs`), signed with a distinct 64-byte key per edge over method, path,
timestamp, nonce, and body digest using HMAC-SHA-512. It publishes again every 30 s heartbeat.
Redis rejects two live replica ids claiming one URL. Because the splice registry is per process
and in memory, each replica must own its address: scale by adding replicas with distinct
addresses, never by putting two behind one.

A hash-pinned certificate may be valid for at most 14 days, so the edge rotates
(`apps/edge/src/cert.rs`). It keeps both certificates in its identity volume, each valid
13 days. A rotation is due once the next certificate has been published for
`ROTATION_PERIOD` (6 days) or the served one is two periods old. It generates and persists a
new next certificate, hot-reloads the endpoint onto the one already published as next, without
interrupting established connections, and publishes the new pair at once. A peer pins both
hashes it was handed, so any pair it learned since the last rotation still dials after the
next one. The server hands the pair out with every issuance, every renewal answer
(`edgeCertHashes`, for the edge the renewal names) and every daemon `registered` and `lease`
message. A browser candidate dial that the edge does not take starts a renewal: the browser
cannot tell a certificate it no longer pins from an unreachable edge, so it asks the server,
which holds the registration, and the next candidate pins its answer. A daemon receives the
newest pair within one 20 s lease.

### Daemon incarnations

Every dataplane process draws a random 16-byte incarnation at start and names it in each
daemon preface. The edge remembers the newest incarnation per daemon id. A preface naming a
different one retires every slot the earlier incarnation held, and each browser counterpart
gets `counterpart_detached` at once. A clean shutdown closes its connections, but a crashed
dataplane cannot, and without this the edge would hold its slots until the dead connections'
30 s idle timeout before any browser re-issued. The dataplane does not wait for a session to
announce itself: whenever the daemon hands it an edge admission (the attach ticket and the
registered edges, on `registered`, every `lease` and every dataplane restart), it opens one
connection with an `announce` preface (`"attachment": { "kind": "announce", "incarnation": … }`
and an empty `session_id`) to each edge it has not yet announced itself to. The edge records the
incarnation, retires the earlier one's slots and closes that connection with application close
code `0x4d04` and reason `incarnation-announced`. A failed announcement is retried with the next
admission.

## Direct-Path Candidates

A direct path removes the relay hop when the browser can reach the daemon. The daemon publishes
its candidates; the browser orders and dials them. Five candidate kinds exist:

| Kind | What it is |
| --- | --- |
| `host4` | A routable IPv4 host address: RFC 1918 LAN, RFC 6598 CGNAT, or global |
| `host6` | A routable IPv6 host address: global, or RFC 4193 unique-local on an overlay |
| `srflx` | The public endpoint observed from the live WebTransport socket by an authenticated STUN probe, including the translated port |
| `nat_map` | An explicit port-mapping lease; the one kind that does not depend on NAT filter state |
| `loopback` | `127.0.0.1` or `::1`, offered only to a browser the edge observed on loopback |

Every browser gets the daemon's whole candidate set, its **manifest**. Whether a LAN, overlay or
reflexive candidate answers is something only a dial establishes, so no address heuristic
narrows it. The one exception is a fact: a browser the edge observed on loopback runs on this
host (the dev and e2e topology) and gets this host's loopback addresses alone. The collector
ranks each family best first, and a global IPv6 address the gateway holds a pinhole for ranks
first in its family. Each candidate carries a `scope`: `public`, or `local` for private, CGNAT,
unique-local, link-local and loopback addresses, exactly the targets a browser's local network
access permission gates. `MAX_WEBTRANSPORT_OFFER_CANDIDATES` (10) bounds what the parsers accept.

### The browser's address

The daemon learns where the browser is from the edge, never from the browser or the server. The
edge reports the address quinn *validated* on the browser's committed signaling connection, not
a source address seen once, as `observed_path` to the browser and `counterpart_path` to the
daemon, and again on every change of IP; a port-only NAT rebinding reports nothing. A rebind
candidate's connection carries its own validated address in its candidate metadata, and that
becomes the browser's address when the candidate commits.

The daemon sends `webtransport_manifest` `{generation, certHash, candidates, nat,
browserAddress, punch}` once authentication completes and the address is known, in either
order; when a rebind commits; when the committed carrier's address changes, which is how a
connection that migrates (Safari's) moves networks; and when its candidates or certificate
change. `generation` orders one peer's manifests.

### Keeping a reflexive candidate dialable

`srflx` names a NAT mapping the daemon did not ask for. Two mechanisms keep it usable, both on a
**send-only** clone of quinn's own UDP socket, so the same 4-tuple and mapping are used and
quinn keeps the only receive queue. The payload is one zero byte, which is not valid QUIC, STUN,
DTLS, or RTP and solicits no reply.

- **Keepalive.** One inert datagram goes to a STUN observer every seventh 2 s heartbeat tick
  (14 s), a two-fold margin under the 30 s idle timers real NATs commonly use.
- **Punch.** As it emits a manifest, the daemon queues a punch toward the manifest's
  `browserAddress`, which opens address-restricted filter state before the browser dials. A
  punch toward a private, CGNAT, unique-local, loopback, or link-local address is refused
  outright, since same-NAT is where a LAN candidate already wins and punching there would be an
  internal scan primitive. The punch runs off the owner loop, and every one queued ends in
  exactly one `webtransport_punch` `{generation, outcome}`: `dispatched`, `refused`,
  `superseded`, or `expired`. The manifest says `punch: pending` when it queued one.

The browser dials a punched candidate, `srflx` toward an IPv4 browser or a global `host6` toward
an IPv6 one, only under a manifest built for its carrier's current address, and only once that
manifest's punch outcome arrived. Every other candidate is dialled as soon as the manifest lands.

Under endpoint-dependent mapping every daemon flow gets a fresh external port the browser cannot
aim at, so `punch_plan` refuses and the manifest relies on the lease or a global IPv6 address.

Under port-dependent filtering there is no punch either. The filter admits only the exact browser
endpoint the daemon has sent to, and the browser dials each candidate once from an ephemeral port
that no API exposes, so the daemon has no known exact tuple to target. `srflx` is still offered,
because the browser's side can hold the state it needs. A daemon behind endpoint-independent
mapping with port-dependent filtering, no port-mapping lease, and no globally routable IPv6
address stays on the edge relay under this discovery policy. This is an implementation limit,
not a proof that direct WebTransport is impossible through that filter. The former search over
the browser OS's ephemeral range was removed: its coverage was probabilistic and its design
relied on several speculative sessions per race, which Chromium's handshake throttle charges
against later dials, relay dials included. The current implementation does not search ports.

The WebTransport API can dial URLs but exposes no UDP bind, STUN, source-port choice, migration,
or multipath. Chrome and Firefox never migrate a WebTransport connection: their network change
is a new connection, which reaches the session by rebind. Safari's connections migrate. No
browser exposes a handover event: `online` and `offline` do not fire on a make-before-break
handover, and Chrome's workers never receive them. Chromium on Android fires `typechange` on
`navigator.connection`, the one hint there is; it only warms a standby carrier. The browser
dials each candidate once, staggered, under a `RACE_DEADLINE_MS` (2.5 s) deadline per batch with
an adaptive `GRACE_FLOOR_MS` .. `GRACE_CEILING_MS` (80 ms to 400 ms) selection grace after the
first success. The edge relay carries the session throughout, and an unsuccessful race never
delays typing.

Each endpoint (`addr:port` under one certificate hash) gets one handshake per network visit,
page-wide (`apps/web/src/session/direct-dial-admission.ts`), because Chromium's throttle charges
every failed handshake against later dials, relay dials included. A visit is one stay on one
address, the one the edge validated on the active session's committed carrier: moving to another
address starts a new visit, and so does returning to an earlier one. A handshake that succeeded
is not charged, so an endpoint whose path later died is dialable again. There is no retry timer
and no give-up. The session's one race is joined by whatever becomes dialable: the winner cached
for this daemon on this address first, then a manifest's public candidates, then its local
ones, a punched candidate once its punch outcome arrives, a local candidate once its permission
stops being denied. A live direct path is kept across a network change; if it dies, the new
network's endpoints are dialled then. A port-mapping lease or pinhole that lands minutes later
arrives in the next manifest.

Chrome from version 147 gates a dial to a local-scope address behind the `local-network` or
`loopback-network` permission, from workers too. The browser leaves local candidates out while
their permission is denied and joins them when it changes.

Two limits stand. A network change behind the same public IP changes nothing any signal can see.
The browser's IPv6 address stays unknown while the server has no AAAA record and the browser
reaches the edge over IPv4.

### The port-mapping lease

A `nat_map` candidate comes from one lease on the pinned WebTransport port
(`apps/daemon/dataplane/src/webtransport/portmap`). All three protocols are asked whether they
are present at the same moment, with requests that change nothing: a PCP `ANNOUNCE` and a NAT-PMP
external-address request from one socket bound to the egress address, and an SSDP search sent to
the first hop before the multicast group. The first protocol that proves itself present is the
only one that maps, because miniupnpd serves all three from one table and an RFC 6886 delete
removes every mapping for the internal port. A gateway that speaks only UPnP therefore maps after
one SSDP and one HTTP exchange instead of after the datagram protocols' retransmission schedule.

Only the edge NAT's lease is published. The gateway's own external address (NAT-PMP's answer,
UPnP `GetExternalIPAddress` asked before `AddPortMapping`, PCP's assigned address) must equal the
STUN-observed reflexive address; otherwise the host is behind a second NAT, nothing is published
(`gateway:inner_nat`), and a PCP mapping already made is deleted. With no reflexive address, no
cycle runs. UPnP errors 725 and 402 retry as a permanent lease, 718 retries through
`AddAnyPortMapping` on IGDv2 and at another unprivileged port on IGDv1, and the DSL Forum service
names are accepted. Nothing blocks on the lease: the candidate set publishes immediately and a
won lease arrives in the next manifest. One socket on `224.0.0.1:5350` receives NAT-PMP address
changes and PCP `ANNOUNCE`, so a gateway reboot triggers a fresh mapping cycle.

IPv6 has no NAT, so a `host6` candidate is dialable exactly when the gateway's stateful firewall
admits the browser's first datagram. The daemon asks for a pinhole with PCP `MAP` over IPv6 and
with IGDv2 `WANIPv6FirewallControl:1 AddPinhole`, probed together the same way. `scripts/natlab`
(`bun run test:natlab`) proves both mechanisms in isolated Linux namespaces, where the lab owns
the firewall, and runs the lease against a real miniupnpd: every protocol on, UPnP only, NAT-PMP
and PCP silently dropped, and double NAT.

## STUN Responder

`apps/stun` answers one question, "what source address did this datagram arrive from", and only
for a caller holding a ticket. The daemon probes no public STUN server. Its answers are the sole
input to the daemon's NAT classification, so a forged answer could make a daemon believe in a
reflexive address it does not have.

### Tickets and silence

Every rejection drops the datagram silently, because a STUN error response would itself be an
amplification vector. A success response is never larger than the request that earned it.

The server mints a ticket over the daemon's authenticated control connection with each `lease`
and hands over the per-ticket MESSAGE-INTEGRITY-SHA256 key with it; the daemon never sees the
deployment secret. `apps/server/src/services/stun-ticket-service.ts` issues and
`apps/stun/src/ticket.rs` verifies, pinned to the same test vector because a rejected ticket at
runtime is only silence.

| Bound | Value |
| --- | --- |
| Ticket lifetime as issued | `STUN_TICKET_LIFETIME_MS`, 90 s |
| Responder clock-skew tolerance | `CLOCK_SKEW_TOLERANCE_SECS`, 60 s |
| Longest expiry a responder accepts | `MAX_TICKET_LIFETIME_SECS`, 15 min |

The 90 s lifetime is what makes "a daemon that lost its control connection stops being able to
probe" true, since a replacement rides every lease renewal. Between server, daemon, and dataplane
the remaining validity travels as a duration, so a daemon whose clock runs ahead does not read
every fresh ticket as expired. The ticket blob itself carries an absolute expiry that the
responder compares against its own clock within the skew tolerance; an expiry further out than
any honest issuer would mint is refused, so a leaked key cannot forge a credential that outlives
key rotation.

### Mapping and filtering evidence

The daemon binds the WebTransport socket once and gives quinn sole receive ownership; a wrapper
extracts only STUN-shaped messages matching an outstanding transaction. Reprobes publish the
observed public IP **and port** of that live socket. Two distinct observer IPs are necessary
before mapping can be classified `endpoint_independent`.

An observer is evidence only when the probe crossed the NAT being measured. A mapping reported
as a private, shared (RFC 6598), loopback, link-local, or unique-local address means the
observer sits inside the daemon's own NAT realm, and the daemon discards it. A box is the
standing case: a responder on the box host is reached over the host's bridge, so the server
leaves the entries named in `BOX_HOST_STUN_OBSERVERS` out of a box daemon's list. Which daemon is
a box is recorded when its link token is minted for that box, not inferred from its name.

Filtering is tested against the first observer, before any other observer address is contacted.
A response from a different IP and port proves `endpoint_independent` filtering; a same-IP
changed-port response proves `port_independent`; silence across two CHANGE-PORT attempts is the
one negative verdict, `port_dependent`. Changed-port answers come from a **change-only**
responder port (`MERKUR_STUN_CHANGE_PORTS`) that is never listed in `STUN_SERVERS`: on a
conntrack NAT an unsolicited reply from a port the daemon later probes is tracked as a flow
first, the probe collides with it, and an endpoint-independent NAT reads as symmetric. Filtering
never suppresses a candidate.

## Logical Channels

Every frame between browser and dataplane belongs to one logical channel. Ids live in
`packages/shared/src/transport.ts` (`TRANSPORT_CHANNEL_ID`) and
`packages/merkur-wire/src/protocol.rs`, which the dataplane and the native client share; the edge
copies the id byte without reading it.

| Id | Channel | Carries |
| --- | --- | --- |
| `0x00` | Signaling | Plaintext, reliable: capability, delegation proof, ML-KEM authentication, signed daemon response, Noise bootstrap, path-management JSON |
| `0x01` | PTY input | Noise-sealed `input_run`s of input records and the inline 8-byte input ACK, on the datagram lane and the reliable stream alike |
| `0x02` | Control | Reliable Noise-sealed heartbeat pings, pong twins, resize, geometry ownership, display resume/resync, dictionary install, session control and typed terminal title/bell/notification/clipboard events; the pong's RTT-sample copy is a datagram |
| `0x03` | Display datagram | Low-latency sealed row deltas with FEC repair |
| `0x04` | Display commit | Reliable sealed snapshots, jumbo rows, and repair |
| `0x05` | Display ACK | Sealed selective datagram acknowledgements; the same body rides control when reliable delivery is needed |
| `0x06` | Data-attachment handshake | Plaintext kind and 16-byte nonce on each data connection, matched to a post-Noise claim on signaling |
| `0x07` | Graphics content | Finite one-transfer streams of sealed image content, keyed in the independent content domain ([graphics](graphics.md)) |

An `input_run` is `base_seq:u32 | count:u8 | flags:u8 | [probe:u64] | shadow_modelled_bits |
entries`; `flags` bit 0 is the retransmit mark, bit 1 says a liveness probe token follows the
flags byte, and every other bit is rejected. The browser encodes a run straight
from the input ring's held slots into the Noise session's output buffer and never holds an
owning copy of a keystroke. No timer stands between a keystroke and the wire. The one timer on
the input path is loss recovery for the last run before a pause (`merkur-client::input_retry`):
while typing continues, each run re-sends every unacknowledged entry, so the timer fires only
after the keys stop. It waits 1.5 × the input-ACK round trip (at least 40 ms) and backs off from
there. The round trip is sampled by Karn's algorithm: a sample is voided once its input is sent
again, and the backoff holds until an unambiguous sample lands.

Resize (`MSG_TYPE_RESIZE`) carries
`cols:u16 | rows:u16 | seq:u32 | cell_width:u32 | cell_height:u32 | geometry_generation:u64`.
Each PTY has one geometry owner: `geometry_claim` (`0x3b`) observes, claims a vacant terminal, or
transfers ownership when the supplied generation still matches, and `geometry_state` (`0x3c`)
reports vacant, owner, or observer. The focused browser window claims ownership when its geometry
changes and when it gains focus, so the shell fits the window being typed into; observers keep
the canonical grid. A client also takes ownership on the user's request, as `Ctrl-\` `f` does
in the terminal client. A host that knows no cell pixels states both cell metrics
as zero. The PTY's pixel extent is then zero, the operating system's "unknown", and the daemon
places no image until a viewport states them; a single zero metric is refused.

## Input Records

The browser never decides which bytes an application reads. Every entry of an `input_run` is an
**input record**, a description of what the user did, and the dataplane encodes it against the
terminal it owns at the moment the record is admitted (`admit_user_record`). The modes that
decide an encoding (Kitty keyboard flags, DECCKM, `modifyOtherKeys`, bracketed paste, mouse and
focus reporting) reach the browser a round trip late, so a browser-side encoder would encode in
the wrong mode during exactly that window. The layout is pinned in
`packages/merkur-wire/src/input_record.rs` and `packages/protocol/src/input-record.ts`:

| Kind | Record | Carries |
| --- | --- | --- |
| Key `0` | head, key, `[mods]`, `[ext]`, `[shifted]`, `[base]`, `[text]` | Press, repeat, or release; Kitty key number; modifier bits; shifted and base-layout keys; the text typed when not implied. A plain letter is two bytes |
| Text `1` | head, UTF-8 | An IME commit or on-screen insertion |
| Paste `2` | head, UTF-8 | One complete paste, bracketed by the daemon when the application asked, with every ESC removed |
| Mouse `3` | head, button, column, row | Press, release, or motion; SGR, UTF-8 (1005), or X10 as the application enabled |
| Wheel `4` | head, count, column, row | Wheel buttons under mouse reporting, or cursor keys on an alternate screen with alternate scroll |
| Focus `5` | head | This browser's window gained or lost focus |

A malformed record rejects its whole run before any PTY write. Keys follow Kitty's reference
encoder, and the encoder writes straight into the PTY write payload, so decoding, encoding, and
queueing a key allocate nothing. Releases, bare modifiers, and focus changes are never dropped;
while the mode word says they encode to nothing, the browser holds them in the input ring and
they leave in the same `input_run` as the next input, costing no datagram of their own.

The display header's **mode word** carries only the routing decisions the browser acts on,
derived by the daemon (`encode_terminal_mode`):

| Bit | Meaning |
| --- | --- |
| `1` | Pointer presses go to the application |
| `2` | Drags are reported |
| `4` | Hover is reported (any-motion tracking) |
| `8` | The wheel goes to the application |
| `16` | Alternate screen (resizes without reflow) |
| `32` | Prediction grant |
| `64` | Key releases encode to bytes (Kitty flag 2) |
| `128` | Bare modifiers encode to bytes (Kitty flag 8) |
| `256` | Focus changes encode to bytes (DECSET 1004) |

The bits only gate what the browser sends: a word one frame stale costs a record that encodes to
nothing or a click that selects, never a wrong byte. While image validation holds a synchronized
update's drain and no header may leave, the routing and input-report bits travel alone on the
control lane as the input-routing word (`MESSAGE_TYPE_INPUT_ROUTING`, `0x3d`, bits `0x1cf`
only), which names its display position so the terminal worker applies it in order with the
frames around it. Focus is reported for the terminal, not per browser: focus-in when the first
attached browser gains focus, focus-out when the last one loses it.

## Display Codec, Compression, And Recovery

This section is a summary. The normative rules (idempotent datagrams, advisory presentation, the
selective ACK, the no-coalescing owner loop, compression, the wrap bit) are in
[`docs/display-invariants.md`](display-invariants.md).

The codec version is 32; `merkur-codec` (`packages/merkur-codec/src/lib.rs`) has exactly one integrated version and every side of the wire moves with it.

Display frames use `merkur-codec` with a 1100-byte application datagram ceiling. The 18-byte
stream envelope carries type and flags, a 32-bit body length, sequence, generation, and input
sequence. **One datagram is one frame**: every batch is framed and, when compression wins,
compressed on its own, so it is complete on arrival and can be decrypted, applied, acknowledged,
lost, or recovered without any other datagram. Each flush ranks rows into `Critical` (cursor rows
and changed cursor/mode headers, sent redundantly across live direct and relay paths) and
`NonCritical` (one admitted carrier, chosen by the prepared burst's complete delivery cost). Row
text is literal cell spans only; there are no mutable-grid row copies.

Three boundaries are deliberately separate: each datagram stands alone on the wire, the terminal
worker applies each accepted datagram to the authoritative WASM grid at once, and one bounded
presentation transaction decides what the renderer submits. Presentation metadata can never delay
or reject a grid mutation.

The browser host drains session I/O and viewer delivery independently. A receipt that arrives
while a drain's completed promise still owns its lane retains a pending request; retirement
hands that request to a successor drain. Neither lane waits for another packet to release
work already queued, and a retired session cannot restart a successor session's lane.

The browser acknowledges with a selective 128-bit bitmap anchored at the newest applied
sequence. A sequence is **lost** when it is unacknowledged with `LOSS_PACKET_THRESHOLD` (three) later sequences already applied above it,
which disowns its rows so the next flush re-sends their current content. Forward error
correction groups up to four datagrams and adds parity shards sized by the group's payload.

Delivery is bounded by presentation. The same ACK carries the browser's cumulative display
grant: the terminal worker issues at most one per animation frame it is shown, plus one
immediately when a hidden view becomes visible. Outstanding grants are bounded by the largest
delivery loop observed in the carrier session and the measured network RTT. An output run is delivered as
produced for at least one presented frame and until the browser has acknowledged one of its
datagrams; after that it is admitted as new screen states only against an unconsumed grant, and
the daemon keeps applying PTY output in between, so a flood costs about one state per presented
frame, always the newest screen, instead of one per owner turn. Input-caused urgent frames,
input-caused header-only feedback even amid blocked bulk rows, a header change with no row waiting,
the clipped remainder of an admitted state,
overdue or selectively lost row repairs and snapshots
need no grant. Every datagram carries the demand serial its state consumed, the
demand-limited / demand-prompt flags the browser's controller reads, and the awaits-grant flag
that lets the viewer commit a paced state as it lands rather than at the next frame. A frame captured exactly at
an explicit synchronized-update end also carries the closure digest of the complete screen it
is (zero otherwise); the viewer holds that screen offscreen until its own grid digests to it
([display invariants](display-invariants.md#complete-screen-closure)). Every frame also carries
the scroll serial: the whole-screen scrolls the terminal had made when it was captured, wrapping,
with scroll-region scrolls not counted. The difference between two states is how far every row's
content moved up, so the viewer's cursor journal judges a step backwards in content, and a
submitted line's new prompt on the same bottom row is not one. Every frame also carries its
peer's echo horizon: the newest input the daemon had queued for the PTY when the terminal last
applied output before the capture. The advertised input sequence counts completed writes,
which precede the program's answer, so a frame captured between a key's write and its echo
covers the key; only the horizon says the grid cannot show that key's effect yet. A line
sealed by Enter is answered against it, so an echo still on the wire is not read as Enter
having rewritten the row. Generation and carrier
boundaries reopen the free delivery window until the replacement flight is acknowledged.

Deltas may be compressed with zstd against a per-peer dictionary trained on the browser's own
grid. A dictionary is finalized (`ZDICT_finalizeDictionary`) so every frame carries a dictionary
id and a diverged dictionary is rejected rather than decoded to garbage. Install is reliable,
on the control lane, and three-step: the browser signals readiness (`0x2b`), the daemon installs (`0x2d`), and the daemon must not compress against that dictionary until the browser acknowledges it (`0x2c`), because a successful reliable write is not evidence the browser installed anything.
The browser keeps the current and previous dictionary, since datagrams can overtake the install.

A carrier swap keeps the display generation, the sequence space, the browser's grid, and the
dictionary: it is the same screen over a different pipe. The daemon retires only what the dead
carrier held and disowns every outstanding send at the boundary rather than waiting for an
acknowledgement that cannot arrive. What does not survive is the Noise keys: rebind is a
transactional key cut committed at the successor's final Noise message.

## Security And Correctness Invariants

- Session capabilities are validated in the Rust dataplane, never in Bun orchestration.
- Before any terminal payload is accepted, all of these must succeed: the control-offer match,
  the server capability, the root-signed daemon binding, the root-signed browser certificate,
  the delegate session proof, the revocation check, both daemon identity signatures
  (`daemon_signature` and `p256_signature` over the same transcript), ML-KEM completion, and
  Noise.
- Plaintext signaling contains neither the daemon identity seed nor any reusable terminal key.
- Capability `g` and the delegate proof bind the exact browser delegation to the one-use KEM
  request; the delegation-authorization digest is in the daemon-signed response and its KDF input.
- Noise prologues bind session id, canonical `daemonId`, and the request transcript, so no
  handshake message can be replayed across sessions.
- Stream and datagram nonce spaces are disjoint and replay checked. Each per-lane 56-bit send
  counter accepts its final value once and then fails closed; it never wraps.
- Fresh issuance, session, nonce, ML-KEM keypair, delegate proof, and Noise handshake are
  mandatory for every edge signaling authentication and every reconnect that is not a rebind. A
  rebind keeps the issuance and session id but still runs a fresh ML-KEM exchange and Noise
  handshake, authenticated by a chaining secret under a bounded window, signed authorization epoch, and
  generation cap. Direct admission proves the separately derived upgrade key with HMAC-SHA-512
  and cannot bypass the end-to-end gate.
- Rebind is a transactional key cut. A tentative successor is built beside the incumbent; a bad
  proof or abandoned attempt disposes only the tentative state. The daemon commits when message 3
  authenticates, in one owner-loop turn that retires the predecessor direct path, applies the
  carrier boundary, installs successor Noise, and emits a fresh direct offer.
- A fresh authentication that resumes a retained display applies the same carrier boundary,
  whether the daemon parked the peer or still held it for a rebind: no preparation, repair set,
  row attempt or carrier block read from the dead connections survives into the successor. A
  carrier's block belongs to the connection it was read from, so display is held only while
  the connection serving that carrier now is blocked.
- A browser leaving a splice demotes the slot to half-paired; the daemon holds its tunnel
  quiesced for the rebind window. The daemon losing its own edge tunnel arms the same window,
  and the all-paths-down liveness sweep classifies before it parks, because a blackholed tunnel
  never produces a close event.
- Recovery starts from evidence; only proof displaces a carrier. Candidate proof traffic coexists
  with the incumbent, and only an authenticated commit acknowledgement authorizes browser
  publication. A late incumbent packet cannot roll back a final flight already sent.
- Both WebTransport servers await the full QUIC handshake before sending HTTP/3 SETTINGS. Neither
  0-RTT nor 0.5-RTT data is used; the rationale sits beside `IncomingSessionFuture::new` in
  `packages/wtransport-patch/src/endpoint.rs`.
- The daemon persists signed delegation tombstones before acknowledging them. Offline or
  coordinator-suppressed delivery is a documented revocation-delay limit.
- The edge never parses terminal frames or owns terminal keys, and each replica owns its address.
- The server remains outside the display, ACK, resync, FEC, and input hot paths.
