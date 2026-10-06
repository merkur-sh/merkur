# Merkur Process Map

This document describes the processes and execution realms Merkur starts, who owns them,
and how they stop. The application server never carries terminal data.

## Local Development

`bun run dev` starts `scripts/dev.ts`, the owner of the local application stack:

```text
scripts/dev.ts
├── merkur-edge                 local blind WebTransport relay
├── Bun server --watch           HTTPS/SSE + daemon WSS control
└── Vite
    └── browser execution realms after navigation
        ├── service worker
        ├── transport worker
        ├── terminal/render worker
        ├── event-stream worker
        └── telemetry worker
```

Redis is the separate Docker Compose service started by `bun run infra:up`. The supervisor checks
it before starting with an authenticated PING, including TLS when configured. It builds
the local edge, starts the server, then starts the edge with a persistent identity and the
server's registration secret. The edge publishes its exact URL and
current certificate pins through the authenticated registration endpoint. If any owned child
exits, the supervisor terminates the others. Ctrl-C follows the same path.

Use `bun run dev:server` when Vite is not needed. It still starts the edge because a server
without a healthy registered edge cannot issue usable terminal sessions.

The supervisor resolves dotenv once and validates typed Effect configuration. The server,
edge, daemon, and Vite receive separate environments containing their owned inputs;
compiler children receive only platform and compiler inputs. Vite receives the public
OPAQUE pin and an explicit proxy target derived from the server's bind address and port.
It disables dotenv loading and binds strictly to local port 3000. `PUBLIC_ORIGIN` is the
browser-facing origin, including an HTTPS tunnel when configured. `bun run dev:web`
starts Vite alone through the same resolver.

## Application Server

`apps/server/src/index.ts` is the server boundary. Direct execution starts the production
entry point; the E2E launcher calls `startServer` with its verified immutable web-artifact
directory. Each E2E server still owns a fresh local database and Redis process.
The server entry point imports its `elysia-runtime.ts` before route construction. It
registers TypeBox and Exact Mirror through static imports so Bun's standalone executable
carries validation dependencies without an installed `node_modules`.
The workspace pins TypeBox to 1.3.23, the release whose compiler exposes the
`buildResult.external` field the selected Elysia beta reads.

The composition root resolves infrastructure and application dependencies once, then supplies
`SessionServiceLive` from that shared graph. The session service owns establishment, capability
renewal, cancellation and revocation; HTTP handlers translate its results and errors. Database,
Redis and telemetry retain their runtime scopes and finalizer order.

The composition root snapshots runtime configuration into an Effect ConfigProvider and
supplies the immutable compiled web-public-key pin separately. Text credentials remain
redacted in typed configuration until IO or crypto adapters consume them. Optional box-host
and web-push settings are either complete validated groups or absent.

The Effect runtime owns:

- Elysia HTTP routes and SSE responses.
- Browser presence shares the authenticated device-event connection across screens. First/last
  tab transitions are pushed through Redis pub/sub. One lease per server replica, renewed every
  15 seconds, bounds crash cleanup without browser heartbeat requests or per-client Redis renewals.
- Database OPAQUE accounts, encrypted user-root envelopes, browser delegations, linked daemons,
  refresh families, signed revocations, ordered daemon outboxes, and migrations.
- Redis/Dragonfly presence, active sessions, rate limits, and pub/sub.
- Authenticated daemon WebSocket registrations, bounded outbound queues, ping deadlines and
  batched lease renewal,
  session commands, ordered delegation-revocation delivery, and command acknowledgements.
- Replica-addressed Redis subscriptions and scoped socket/timer cleanup.
- A supervised five-second health monitor for the database, Redis command/publisher/subscriber
  connections, daemon-control workers, the liveness ticker, and presence expiry.

Each device-event response runs one scoped fiber owned by the server runtime. Setup Effects
compose directly into that fiber; abort, consumer cancellation and runtime shutdown release
subscriptions and browser membership. Stream admission follows the response controller's byte
demand, bounded to 64 KiB plus one complete frame, including a large opening snapshot. Native
socket and proxy buffering has its own ownership outside that application queue.
During shutdown, the application's stream owner first closes admission and awaits every stream's
scoped cleanup, then gracefully drains ordinary HTTP requests before disposing the runtime.

Account session changes and device mutations append notification intents in the same SQL
transaction as their state change. The scoped notification worker starts after migrations,
wakes on local commits and scans durable pending rows every second to recover cross-process
commits and lost wakes. It acknowledges only confirmed Redis publication; ambiguous outcomes
can repeat delivery. Browser changes carry exact delegation IDs. Device invalidations advance
the account cursor and request an authoritative snapshot, so replay cannot restore an obsolete
name or resurrect a removed device. Pending intents survive account erasure until acknowledged.

Failed-login push notices use a separate scoped queue; request completion does not wait for
push delivery. Box-host and push HTTP requests pass Effect's cancellation signal to fetch and
apply their deadline through response consumption. Non-abortable SQL transaction coroutines
settle before interruption can roll back and release their connection.

The Redis service uses Bun's native client with separate command, publisher, and subscriber
connections. Its Effect scope owns reconnect attempts without an attempt limit and closes all
three clients on shutdown. Offline commands are rejected; in-flight mutations are never replayed.
After a subscriber reconnects, the service restores channel subscriptions without duplicating
local listeners and waits for their acknowledgements before notifying consumers to resync.
Cancelled or failed subscription attempts disable delivery immediately and retire their exact
native listener again when a pending subscribe settles; late completion cannot revive a released
listener or remove its replacement.

Each accepted daemon socket is fenced by `connectionId`, `presenceId`, and `claimSeq`, and only the
current owner may dispatch a command. Command *delivery* fences on the lease alone — `daemonId`,
`userId`, `presenceId`, `claimSeq` — because a reconnect that resumes a suspended lease keeps those
while replacing `connectionId` and possibly `ownerInstanceId`. Acknowledgement matching and broker
retirement still compare the full identity, since there the subject really is one specific socket.

A command still pending when a carrier drops is re-sent to a carrier that resumes the same lease on
the same replica; the daemon recognises a command it already applied and re-acknowledges it from a
short-lived memo instead of executing it twice. Nothing is replayed across replicas — a lease
reclaimed elsewhere leaves the caller to time out and retry. Browser input, display frames, ACKs,
resync, and terminal encryption never pass through this process tree.

## Native Terminal Client

`apps/tui` builds `merkur-tui`. Its account workspace owns one UI reactor and a transport
reactor per open tab on separate threads. The UI owns host terminal input, the shared viewer's
presentation grid and ANSI composition; each tab's transport thread owns client session state
and WebTransport. Account requests and the shared machine-event stream run outside host
presentation. Input is modelled on the UI thread before its record and modelled result cross
the command channel. A lazy graphics worker decodes verified PNG tiles and prepares host pixel
rasters; its completion notification wakes the UI directly. Lineage and scene cancellation
fence pending work, and buffer reservations survive until the worker releases them.

Host deliveries own both record and byte credits until the UI applies them, including while
forwarded through the workspace queue. Each tab has 64 delivery slots and a 64 MiB delivery
budget. Carrier ingress reserves bodies before allocating them, with separate 64-slot,
64 MiB control and display budgets and a 64-slot, 4 MiB datagram pulse budget. Bounded reader
owners retain their credits through handoff. Each display or control lane stops admitting
host-bearing events while its prior event waits for host delivery; commands, timers, outgoing
I/O and authenticated input ACK/heartbeat pulses remain selectable. Selective reads leave
blocked display datagrams in QUIC's bounded receive storage, so they do not fence the pulse
reader. UDP retains its ordinary transport loss semantics. Carrier retirement aborts every
owned reader and releases unread deliveries; closing a session refuses queued input before
its terminal status has reached the UI.

Each reliable writer reserves 16 record slots and 32 MiB, keeping both reservations until
its stream write completes. The driver owns one unfinished record per writer and pins its
reliable Noise lane across provider changes until explicit completion or carrier retirement;
enqueueing or dequeueing alone does not release custody. A refused record awaits its own permit.
Datagram input retries, ACKs and writers of other crypto lanes continue independently. The shared
session keeps the unsent reliable input suffix, the latest display ACK and host facts, one
latest plaintext PONG per provider and an exact repair-row bitmap until their writers admit
them. Control-producing commands and reliable control ingress wait for actual writer credit.
A separate 16-slot lifecycle ingress carries closure even when those lanes are blocked.
UI commands own independent input, control and ACK reservations, each with 4,096 slots and a
64 MiB resident budget. Reactor account and dial jobs have an owned cancellation handle and
publish through a 16-result channel; closing a dial or reactor cancels its unfinished jobs.
Dial setup retains unpolled streams until the reactor accepts the carrier and applies
`Connected`; only then do its reader and writer tasks start. Immediate pairing verdicts
and close events cannot overtake dial acceptance, and failed or cancelled setup leaves no
detached tasks.

The host runs in raw mode on the alternate screen. The TUI requests Kitty keyboard flags 31,
bracketed paste and focus reporting. It opens the actual stdin terminal device as a separate file
description, so its nonblocking mode does not change the calling shell's stdin. A host frame
ends with a consumed query (`CSI 5 n`); one unanswered query is allowed. Changed state
composes as soon as the previous frame is consumed, without a refresh-clock wait. Grant-only
refreshes and the viewer's redraw/repair frame bounds retain their 60 Hz maintenance cadence.
Partial host writes retain their offset while the UI continues input, output and ACK processing.
A status row is excluded from remote geometry and pointer input. The viewport states one
cell's pixels when the host reports them, through its window size or a `CSI 16 t` answer, and
only the grid when it reports neither. The first screen holds until the host has answered its
first frame, so that answer is known before any session opens. SIGWINCH updates the
viewport; exit, SIGINT, SIGTERM, SIGHUP and panic restore
termios, host modes and the normal screen.

Host input accepts raw CR as Enter, BS or DEL as Backspace, HT as Tab, and
other C0 bytes except ESC as control-key presses alongside extended keyboard reports. Text
runs stop at each key so text, deletion and submission retain their order across reads.
LF denotes Ctrl-J; bracketed paste retains its text, including embedded control bytes.
The workspace prefix is Ctrl-\\; pressing it twice sends one Ctrl-\\ to the machine.

Press `?` on the machines screen, or `Ctrl-\\` then `?` in a session, to open the
scrollable shortcut guide. Enter or Esc returns to the previous session. The read-only guide
owns local input and hides remote presentation while preserving the session's focus and
viewport ownership. Account dialogs release remote focus while open and restore it when
dismissed. The machine picker keeps availability beside each name, marks the selected row,
and explains how to link a machine when the account is empty. Long local labels clip at
terminal columns with an ellipsis; the editing end of a long sign-in field stays visible.
Passwords and approval codes are masked.

Local screens (sign-in, machines, dialogs) paint into an offscreen terminal grid, and the
host receives only the cells that changed, through the composer a remote session uses. A
local frame never clears the host: a multiplexer reads a frame from its pty in pieces and may
redraw between them (tmux does, in a popup), and a cleared screen redrawn halfway is a blank
flash on every keystroke. After a remote session draws, the next local frame repaints every
cell and turns pointer reporting off.

Local chrome uses Quicksilver's tokens: violet headings, `meta` grey for secondary lines,
`faint` frames, an `accentsoft` cursor row, a `sunken` hint bar, and an ok/warn/faint dot
beside each machine's state. Sign-in and the machine picker display the silver-and-violet
Merkur orb, sampled from the web mark's shader into terminal half cells: rendered at 352
pixels, box-filtered in linear light, inside a fixed disc. Wide screens place the orb
beside sign-in; narrower tall screens put a small orb above it. The machine picker puts the
small orb top-left beside its heading, as the web list does, while short screens retain the
compact list. The interactive orb uses 48 compiled shader samples in a four-second loop at
twelve frames per second; its highlights shift and its outline stays still. Animation
patches the orb's rectangle and preserves the editing cursor and pen.
It shares the host's consumption fence with ordinary rendering, coalesces delayed frames, and
pauses while unfocused, hidden, or displaying a remote terminal. Compiled artwork needs no
runtime image decoding or GPU rendering; command help uses the canonical static still.
`NO_COLOR` and `TERM=dumb` use monochrome shading and the host palette.
Regenerate the native and command-help artwork with `bun run scripts/generate-cli-orb.ts`
after changing `packages/quicksilver/assets/orb-still.webp` or
`packages/quicksilver/src/orb.ts`.

`merkur help` groups commands by task. `merkur help <command>`, `<command> --help` and
`<command> -h` show focused usage, examples and options. Help never starts an account or
service operation. `merkur --version` and `merkur -v` print the build version. Commands
without parameters reject extra arguments before changing service state. Command output
uses plain text when redirected, and terminal styling honors `NO_COLOR`. The daemon runtime
keeps structured JSON logging.
The styled command overview includes the orb; focused help and plain output remain compact.

The fish shell integration launches interactive `merkur` client commands inside local tmux
in a borderless popup occupying the attached client's full size at launch. The popup
forwards keys before the outer tmux prefix and root bindings, so Ctrl-B followed by a
command reaches remote tmux directly. Closing Merkur closes the popup, returns its exit
status to fish, and restores the outer client's ordinary keyboard handling. Other clients,
session options and key tables are unchanged. Popup dimensions follow tmux's popup sizing:
shrinking the host clips the popup, and growing beyond its initial dimensions does not
enlarge it. Noninteractive commands and launches outside tmux execute directly.

Without that fish integration, local and remote tmux instances sharing Ctrl-B use the
ordinary nested behavior: Ctrl-B followed by a command controls the local instance, and
Ctrl-B Ctrl-B followed by a command controls the remote instance through tmux's send-prefix
binding. The TUI forwards the received Ctrl-B.

Each tab's reactor reports its retirement, including a panic. A refused driver command retires
only that tab immediately, wipes its queued input and discards speculative presentation;
queued driver output cannot revive it. The authoritative screen remains available. Closed
reactors and completed account jobs are joined; shutdown waits for every committed account operation before removing
revoked credentials. Reopening an ended tab assigns a fresh identity, so its queued output
cannot enter the replacement session. Revocation finishes the reserved host frame, deletes
owned graphics and returns to account entry on the same host consumption fence.

`merkur-tui headless` owns the same client session and viewer without host terminal I/O. It
reads its password from piped stdin, presents at 60 Hz, and prints the presentation grid on
SIGUSR1. Subsequent pipe and terminal input uses an owned nonblocking descriptor; finite
regular files use bounded reads. Pending input does not keep the runtime alive after the
session closes. The transport harness exercises both headless sessions and the interactive
executable in a controlling PTY, with Alacritty interpreting its ANSI output independently.

## Local Daemon

`apps/daemon/src/index.ts` is a thin lifecycle owner:

```text
merkur daemon (Bun)
└── merkur-dataplane (Rust)
    ├── user shell in a PTY
    └── merkur-image-worker (one isolated inline or descriptor image decode job)
```

The Bun process loads linked config, acquires the single-instance lock, starts the dataplane, and
owns the persistent daemon-to-server WSS control connection, ping liveness, reconnect,
and command dispatch. It also supervises terminal-bell reporting and a 30-second structured
health/metric reporter; an unexpected failure in any critical owner terminates the runtime. The
Rust dataplane owns PTY state, server-capability/control-offer validation, user-root daemon-binding
and browser-delegation verification, revocation enforcement, permanent daemon-identity response
signing, one-use ML-KEM/Noise bootstrap, edge/direct WebTransport, input sequencing, display
synchronization, ACK/resync/FEC, and transport heartbeat policy.

Inline graphics query, transmit and transmit-and-place commands launch the sibling `merkur-image-worker` with a
clean environment and bounded pipes. The canonical terminal parser holds command order;
the owner retains one unread PTY buffer while helper capacity or validation is pending.
Input admission and ACKs remain live. A partial synchronized-output drain cannot enter
display capture. Reset revokes publication and waits for cancellation before subsequent
terminal semantics; shutdown reaps the helper before dropping terminal ownership. Image
storage and processing have separate reservations, each charged to terminal-local and
shared daemon domains. Only two image helpers can hold processing reservations across
the daemon; cancellation keeps its reservation until the process is reaped. Source
commitments run on blocking workers after output becomes immutable, carrying the same
processing reservation until hashing completes. A cancelled caller cannot expose that
capacity while detached work still owns it. Only published source allocations preallocate
retirement records. Final release only queues the record; one lazy retirement thread wipes
and frees storage, keeping the reservation until physical release. The terminal owner keeps
the completion of every source it removes until it lands. Meanwhile a storage refusal on the
parser path waits instead of answering: an upload's, a placement's, a native reference's and
an animation edit's. The owner sizes an edit exactly from its command, its source and a
frame's decoded patch, and admits all of it before the transaction builds off the owner, so
nothing the transaction allocates can be refused and an edit that fits never waits. A
shortfall there is answered only once every recorded release has landed, so those answers do
not depend on when the retirement thread runs. Two cases stay outside that rule
and remain open: storage that returns with no recorded release, from a static image an edit
superseded while the new frames share its pixels or from what a failed publication or a failed
edit drops, and a native side-channel submission, which reserves on arrival, with no place in
the PTY stream to wait at. A release the parser waits on must never wait on the parser in turn,
so nothing outside the scene keeps a removed source until the parser advances: a transfer ends
when its content retires, and an edit's transaction drops its source when it returns. Encoded
tiles are per-transfer allocations, wiped by their transfer before its credit returns.
The thread uses a fixed 256 KiB stack. Process shutdown joins runtime processing owners
before draining retirement; text-only processes never initialize this worker.
Local builds, native harness artifacts
and signed release archives include the helper; release activation validates all four executables, including `merkur-tui`.
Each PTY also receives a private local descriptor-submission endpoint and credential.
The broker checks OS peer credentials, shares existing image admission, and launches the same
confined helper with the source descriptor as stdin. The helper snapshots the bounded extent
and closes it before decoding. Validated results wait under one-use references; only their
canonical APC consumption can publish them. Reset fences pending submissions; shutdown
stops acceptance, cancels and reaps client jobs, and removes the broker's own socket.
The [native image API](native-images.md) specifies the local contract.

Immutable row projection, finite authenticated asset streams, explicit geometry ownership
and WebGPU rendering are connected. Confined animation composition, shared frame storage
and aggregate packet scheduling use the same bounded owners. Conformance and
integration evidence cover this path; platform and tool validation are outside its scope. The helper
README describes its fixed allocation arena and platform confinement.

Bun and Rust talk over bounded framed IPC whose structs are `snake_case` with
`#[serde(deny_unknown_fields)]` and no `rename_all`. A TypeScript writer emitting a camelCase
key does not produce a slightly wrong payload: serde rejects the whole command and the feature
is silently dead while every TypeScript gate passes, so both sides assert the exact key set
(`packages/shared/src/ipc-wire-conformance.test.ts`, `apps/daemon/src/services/dataplane-client.test.ts`).

Permanent linking starts at the CLI but requires a browser-owned root approval. `merkur link`
uses the five-minute account token from `MERKUR_LINK_TOKEN` (set by the browser's one-line
install-and-link command) to open a ten-minute pending claim, generates the permanent daemon
identity through the one-shot Rust `identity-seal` mode and a separate 256-bit out-of-band code
locally, prints it as an `<origin>/link#<code>` address and QR code, then polls. The CLI handles opaque sealed material; Rust owns key generation and signing. An authenticated
browser recomputes that code's commitment to the exact public claim, asks for the password to run
OPAQUE and unlock the user root, and signs the daemon binding. The daemon verifies the approval
MAC, root signature, and its exact local identity before saving config and completing the claim.
Enrollment issues no daemon bearer credential. The Bun owner proves possession of the linked
identity against a fresh WSS challenge before registration, and signs each HTTP management request.
Those checks never enter the Rust PTY/display path.

For browser-session revocation, the dataplane verifies and applies the signed tombstone, evicts
affected live/dialing/parked peers, and reports acceptance over IPC. The Bun owner merges and
atomically saves the tombstone set before it acknowledges `delegation_revoke` to the server. A
server outbox item is marked delivered only after a successful acknowledgement. A rejection is
retained as undelivered, keeps the daemon unavailable for sessions, and is retried after reconnect;
newly linked daemons also receive retained signed revocations with still-live targets before they
become session-ready.

The dataplane's WebTransport maintenance owner serialises four kinds of work on one detached
task at a time — startup, certificate rotation, the STUN reprobe, and the mapping cycle — with a
generation on each so a stale completion cannot publish. The mapping cycle acquires or renews the
v4 gateway lease and the v6 firewall pinhole concurrently, using discovery bound to each
address family; its next run is due at
half the shorter granted lifetime, checked on the heartbeat tick rather than by a timer. Its egress
interface also owns the gateway-announcement socket (`224.0.0.1:5350`, address-reused, joined on
that interface), a detached reader that turns a NAT-PMP address change or PCP `ANNOUNCE` into one
capacity-1 message; the owner loop compares the announced epoch and address against the leases it
holds and requests a cycle that skips renewal and the fencing delete. The listener is rebound when a
cycle reports a different egress interface and aborted at shutdown with the network-path watcher.

The daemon owns the dataplane; the dataplane owns the shell. Shutdown proceeds in that order.

## Hosted Processes Outside The Session Path

Two deployed processes are neither started by `scripts/dev.ts` nor part of the terminal data path.

`apps/stun` owns one blocking Binding receive loop per UDP socket. Ordinary Binding
is stateless and uses fixed buffers. A separate two-thread Tokio runtime owns only
source-consented external WT checks: eight jobs at most, three seconds per job,
a fixed 64-entry replay/rate table, and two admissions per source IP per ten seconds.
No diagnostic connection creates a terminal peer. Authentication and admission
refusals are silent. A host with one public address cannot perform the
independent-address checks; the same binary supports a host with independently
routed addresses. See [`transport.md`](./transport.md).

A box host is an external service that owns container lifecycle. The application server
reaches it through `BoxHostService` at `BOX_HOST_URL`, authorized by the bearer token
`BOX_HOST_TOKEN`; with neither set, box creation is disabled. The server makes three calls:

| Call | Meaning |
| --- | --- |
| `POST /boxes/linked` | Create a box from a name, the server origin and a link token. The answer carries the link code the box's daemon printed, which the browser approves with the account password. |
| `POST /boxes/:id/start` | Start a stopped box. |
| `DELETE /boxes/:id` | Destroy a box. An exact 404 means the box is already gone; any other refusal is an error. |

The server destroys a box on three occasions. Unlinking its device and the account-erasure
sweep both call the host first and drop the row only once it answers. A password reset cannot
wait on the host, so its transaction records the account's boxes in `box_removals` as it drops
the rows that named them, and a maintenance loop (`BOX_REMOVAL_INTERVAL`, one minute) destroys
each queued box and removes its entry when the host confirms. A box the host refuses stays
queued for the next pass. `POST /api/boxes` answers `box_removal_pending` for a name still in
the queue, so a new box cannot take a name whose removal is owed.

The host owns every policy decision (image, lifetime, quotas, capacity), so none of it is on
the wire. A box is a hosted variant of the ordinary local daemon: the container runs its own
Merkur daemon and appears as its own device, so a box host adds no transport, no auth path,
and no data plane, and never carries terminal traffic.

A box host relies on four things from this repository, and nothing else: the `merkur link`
output (`apps/daemon/src/cli/cli-output.test.ts` pins it); the daemon's published WebTransport
endpoint setting and `MERKUR_WEBTRANSPORT_PORT` (`packages/config/src/daemon-config.ts`); the
shell-integration snippet it installs in each box, without which the daemon sees no
authenticated `OSC 133;B` and grants no speculative local echo; and the signed release assets
with `merkur setup` and `merkur update`. Personal daemons remain owner-managed.

## Browser Realms

The Solid application remains on the main thread. Heavy terminal work is split into workers:

| Realm | Responsibility |
| --- | --- |
| Main thread | UI state, credentials and HTTP bridging, device selection, input event capture, DOM hints, and explicit worker-failure supervision. |
| Transport worker | Owns one Rust `Session` through the E2E WASM wrapper: authentication, Noise, path ranking, input/retry, heartbeat and recovery; browser adapters own native carrier I/O and HTTP bridging. |
| Terminal worker | Owns one Rust `ClientViewer` through term WASM: display receipt/apply, retention, FEC, ACK and presentation readiness; WebGPU rendering and host effects stay worker-owned. |
| Graphics asset worker | Lazy memory-only encoded cache, bounded PNG decoding and direct bitmap delivery to the terminal worker; Rust `Session` verifies received content before publishing an asset. |
| Service worker | PWA shell caching, update lifecycle, and push notifications. |
| Event-stream worker | Fetches and reads the authenticated SSE streams (`GET /api/devices/events`) and posts their parsed events to the main thread. It does nothing else, so it is never busy when a chunk arrives: iOS WebKit holds back body chunks that queue behind one another on a busy reading thread until more data arrives. |
| Telemetry worker | Drains the three SharedArrayBuffer perf rings, decodes them, and POSTs NDJSON — a full batch as soon as it exists, the tail on a slow timer. Exists so profiling costs the main thread nothing; it is spawned only when performance reporting is enabled. |

The transport worker preserves its terminal-owner identity across recovery attempts. Page hints
wake backoff or start a non-displacing candidate; they never stop/start the worker's session.
Only explicit worker failure replaces the worker, with callbacks fenced to their original start.
Recovery progress crosses to main for diagnostics; it cannot drive retry decisions. Main writes
one outcome per attempt to its perf ring, including the last observed phase if the worker crashes.

A service-worker update installs only after its complete generated shell manifest is cached.
It then waits while the current worker serves the running pages and their hashed worker scripts.
Returning to a visible page asks the registration for an update, since an installed app that
never navigates is otherwise never checked. The banner follows `registration.waiting` exactly and
sits in the top notice rail, clear of the home indicator and keyboards. Its Reload action activates
the waiting worker, or whichever newer build replaces it; activation claims clients before any
cache work. Every already-controlled page, and the page that asked even if it was uncontrolled,
reloads on controller replacement. Activation then retires older shell caches unless another build
is installing or waiting, whose own activation retires them. First installation claims the page
without reloading. Replacing the cache while leaving existing pages running strands their old
worker URLs after a deployment, leaving terminal startup reconnecting.

Device selection starts transport in the same turn that mounts the terminal. The next animation
frame controls presentation of the terminal view, without gating either worker's startup.
The transport worker starts cached edge dialing and session-auth preparation together; preparation
overlaps the delegation vault read with crypto runtime initialization. Runtime readiness gates
key generation, and delegation readiness gates the session proof. Canceled attempts cannot present
an old terminal view or retain a late delegation result.

The account screen exposes one Continue action. The browser owns separate OPAQUE login and
registration client states, starts both through one server request, and chooses a finish endpoint
only from the local OPAQUE login result. Both branches share one server flow, which the first finish
attempt consumes. Registration policy remains server-owned; disabling account creation does not
add a different browser mode or start response.

Authentication storage is origin/profile scoped and uses the same path in a normal browser tab and
an installed PWA. One active ML-DSA-87 delegate seed is AES-GCM encrypted in IndexedDB under a
nonextractable IndexedDB `CryptoKey`; its root-signed certificate expires after exactly 30
non-sliding days. A surviving refresh cookie plus that vault lets reloads, browser restarts, and
phone restarts resume without the password. Different browsers/profiles are separate trusted
sessions. PWA installation adds no hardware binding or stronger trust boundary, and same-origin
JavaScript can still invoke the stored key.

## End-To-End Tests

`bun run test:e2e` uses Playwright's web-server lifecycle to start
`tests/e2e/start-server.ts`. That process owns a non-persistent Redis instance, a fixed test-only
OPAQUE setup and matching browser public-key pin, generated access-token HMAC and edge-registration
key material, a test-only ML-DSA-87 session seed, an isolated SQLite database, a production web
build, and the Bun server. Local `.env` files are disabled. Teardown removes the database, Redis
directory, and all children.

`bun run test:e2e:transport` adds the real transport tree:

```text
run-edge-harness.ts
├── merkur-edge
└── Playwright
    ├── isolated Redis + server
    ├── Chromium
    └── linked Bun daemon
        └── Rust dataplane
            └── test shell
```

The transport suite is explicit because it requires Rust artifacts, Chromium WebTransport, and
the local blind edge. Failure artifacts live under `test-results/`.

With no spec filter, `run-edge-harness.ts` runs Playwright twice against the one edge it started:
first serially, one worker, over the three specs that assert a hard p95 millisecond budget and
cannot tolerate concurrent load, then fully parallel over the specs whose daemon/account/browser
context is isolated per worker (multiple copies of the tree above running concurrently against the
shared edge and server). The latency phase goes first because what runs *before* a timing
measurement is part of it: a host that has just torn down the parallel phase is not a quiet one,
and no settle delay reliably makes it one. Both phases run even when one fails. One browser
harness runs per host: `scripts/host-harness-lock.ts` holds a kernel `flock`
from before the native build, and a second harness waits for the first instead of loading the
machine under its latency phase.

### Suites

No single command runs every spec. Each spec belongs to exactly one config:

<!-- generated:e2e-specs -->
| Command | Config | Profile | Specs | Phase |
| --- | --- | --- | --- | --- |
| `test:e2e` | `playwright.config.mjs` | default | `app`, `auth-cross-tab`, `auth-resilience`, `display-burst-paint`, `keyboard-navigation` | one Playwright run |
| `test:e2e:email` | `playwright.email.config.mjs` | default | `auth-email` | one Playwright run |
| `test:e2e:burst` | `playwright.burst.config.mjs` | default | `display-burst-paint`, `fence-poll-cadence` | one Playwright run |
| `test:e2e:site` | `playwright.site.config.mjs` | default | `site`, `site-blog` | one Playwright run |
| `test:e2e:transport` | `playwright.edge.config.mjs` | default | `carrier-rebind`, `client-idle-work`, `device-list-updates`, `edge-handshake-reorder`, `edge-sweep`, `ios-webkit-startup`, `startup-latency`, `terminal`, `terminal-cursor-motion`, `terminal-geometry-matrix`, `terminal-graphics`, `terminal-input-matrix`, `terminal-links`, `terminal-performance-matrix`, `terminal-selection`, `terminal-touch`, `terminal-touch-matrix`, `transport-latency`, `tui-headless` | serial `--workers=1`: `startup-latency`, `terminal-performance-matrix`, `transport-latency`; then 16 functional specs in parallel |
| `test:e2e:tui` | `playwright.edge.config.mjs` | default | `tui-headless`, `tui-rebind` | one Playwright run, `--workers=1` |
| `test:e2e:latency` | `playwright.edge.config.mjs` | default | `transport-latency` | one Playwright run, `--workers=1` |
| `test:e2e:latency:impaired` | `playwright.edge.config.mjs` | `typical`, 3% loss, moderate reorder | `transport-latency` | one Playwright run, `--workers=1` |
| `test:e2e:transport:impaired` | `playwright.edge.config.mjs` | `typical`, 3% loss, moderate reorder | `terminal`, `terminal-geometry-matrix`, `terminal-input-matrix`, `terminal-performance-matrix`, `terminal-touch`, `terminal-touch-matrix`, `transport-latency` | one Playwright run |
| `test:e2e:transport:impaired:functional` | `playwright.edge.config.mjs` | `typical`, 3% loss, moderate reorder | `terminal`, `terminal-geometry-matrix`, `terminal-input-matrix`, `terminal-touch`, `terminal-touch-matrix` | one Playwright run, `--workers=1` |
| `test:e2e:rebind` | `playwright.edge.config.mjs` | `fast` | `carrier-rebind`, `tui-rebind` | one Playwright run, `--workers=1` |
| `test:e2e:handover` | `playwright.edge.config.mjs` | `FORCE_EDGE=0`, `fast` | `network-handover`, `tui-direct` | one Playwright run, `--workers=1` |
| `test:e2e:transport:reorder` | `playwright.edge.config.mjs` | `typical`, `handshake-split` scenario | `edge-handshake-reorder` | one Playwright run, `--workers=1` |
| `test:e2e:edge-topology` | `playwright.edge-topology.config.mjs` | default | `edge-topology` | one Playwright run |
| `test:e2e:cloud` | `playwright.edge-cloud.config.mjs` | default | `edge-sweep` | one Playwright run |
| `test:e2e:edge-probe` | `playwright.edge-probe.config.mjs` | default | `edge-wt-probe` | one Playwright run |

- Reachable only by an explicit filter (pass the spec name to the harness): `display-resync-recovery` (`playwright.edge.config.mjs`; driven by `scripts/run-terminal-network-matrix.ts`); `relay-keystroke-packets` (`playwright.edge.config.mjs`; driven by `scripts/run-relay-keystroke-packets.ts`); `terminal-direct-latency` (`playwright.edge.config.mjs`; no script drives it); `terminal-redraw-reference` (`playwright.edge.config.mjs`; driven by `scripts/run-terminal-redraw-reference.ts`).
- In no config, so no `test:e2e*` script can select them: `terminal-direct-reference` (driven by `scripts/run-terminal-direct-reference.ts`); `terminal-packing-delivery` (driven by `scripts/run-terminal-packing-delivery.ts`).
<!-- /generated:e2e-specs -->

The table is generated by `bun run generate:docs` from the Playwright configs, the `test:e2e*`
scripts, and `scripts/run-edge-harness.ts`; `check:docs` fails when it is stale. What each run
needs, and what it proves, is hand-written:

- `test:e2e`: builds the Rust dataplane for link claims; isolated server/account state; macOS builds require Xcode Command Line Tools.
- Every `playwright.edge*.config.mjs` run (`test:e2e:transport` and the rows sharing its config): Rust artifacts; the harness starts the local edge; the iOS spec runs only when its SafariDriver prerequisites are available. The network-fault cases in `carrier-rebind`, and `edge-handshake-reorder`, **skip** without an explicit calibrated profile; `test:e2e:rebind` and `test:e2e:transport:reorder` supply it. The carrier-rebind ownership, renewal, and lost-final-flight regressions also run under the default profile. With no spec filter, `run-edge-harness.ts` runs the three specs that assert hard p95 millisecond budgets serially first, because a real GPU fence is skewed by concurrent load, then the functional specs in parallel (`E2E_TRANSPORT_WORKERS`, default one worker per three cores; each worker fixtures its own isolated daemon and account). An explicit spec or filter opts out of the split and runs as one plain Playwright invocation.
- `test:e2e:rebind`: the calibrated 50 ms fast profile. The suite proves the session survives and keeps its terminal, recovery takes the rebind path with no server round trip within its authorization epoch, and generation-budget exhaustion renews that epoch without replacing the session. Candidate proof leaves the incumbent attached; input acknowledged there while the final flight is held retains its sequence namespace after handover. Lost final flights and commit acknowledgements reconcile before another key cut. Online/visibility events cannot cancel a connected session, including after full re-issuance.
- `SESSION_TOKEN_TTL_MS=2000 bun run test:e2e:transport --workers=1 --grep 'an expired authorization'`: holds proactive renewal until a real server-signed capability expires, then proves the daemon's authenticated refusal triggers renewal and a committed rebind on the same session. This case skips without the explicit short lifetime; the harness forwards the existing server setting.
- `test:e2e:transport:reorder`: the calibrated 120 ms profile with the explicit `handshake-split` fault. Runs 40 fresh cold WebTransport dials through a real Chromium client; fails if the edge times a session handshake out, or if a dial exceeds 8 s from `transport_start` to `transport_connected`. It guards the handshake against a lost or reordered SETTINGS frame: whole-datagram loss or reordering cannot split the edge's coalesced server flight, so the named scenario delays its crypto prefix by one base hop while releasing the suffix.
- `test:e2e:burst`: the standalone browser burst harness.
- `test:e2e:cloud`: a configured remote server and edge. `test:e2e:edge-topology`: Rust artifacts; the harness starts every edge. `test:e2e:edge-probe`: `EDGE_URL` and `EDGE_CERT_HASH` for a running edge.
- `bench:terminal-network-matrix` (not a `test:e2e*` script): terminal, cursor, geometry, input, performance, edge-sweep, transport-latency, carrier-rebind, and forced real-protocol resync suites in a resumable 80-cell Chromium plan: the 28 workload and 12 recovery profiles each run under two deterministic seeds across calibrated 50/120/200 ms application RTT, requested loss/reordering combinations, short burst loss, and temporary congestion; writes an atomic checkpoint to `test-results/terminal-network-matrix.json` and per-cell raw browser/proxy artifacts plus a synchronous final daemon/Rust transport sample beside it.

The `playwright.edge*.config.mjs` files are not runnable directly. Their harness scripts build the
Rust artifacts, start the edge, and export its coordinates before invoking Playwright; each config
says so in its header.

For browser-specific transport checks, set `PW_E2E_BROWSER=chromium` (the default) or
`PW_E2E_BROWSER=firefox`; the latter launches Playwright's bundled Firefox without Chromium
launch flags. Artifacts identify the actual browser build and GPU. A bundled Chromium run is
not evidence of a separately installed Chrome version.

Two additional serial benchmarks use `playwright.edge.config.mjs` through explicit harness
filters, not the default functional run. `scripts/run-terminal-redraw-reference.ts` runs
`terminal-redraw-reference` with 100 staged redraws per selected RTT, retaining common-event
raw traces for revision comparisons. The direct-carrier regression is:

```sh
FORCE_EDGE=0 EDGE_NETWORK_PROFILE=typical DIRECT_NETWORK_PROFILE=fast \
  bun run scripts/run-edge-harness.ts terminal-direct-latency.e2e.ts --workers=1
```

It delays the direct carrier itself to 50 ms, keeps the production companion edge slower,
and measures printable input, Backspace, small redraws, and large redraws separately. Merely
disabling `FORCE_EDGE` would bypass the edge emulator and is not a network benchmark.

The network emulator has one current contract. Set `EDGE_NETWORK_PROFILE` to `fast`, `typical`, or
`difficult`; optionally select `EDGE_NETWORK_DATAGRAM_LOSS_PERCENT` (`0`, `1`, `3`, or `9`),
`EDGE_NETWORK_REORDER` (`none`, `light`, or `moderate`), `EDGE_NETWORK_SCENARIO` (`steady`,
`burst-loss`, `congestion`, or `handshake-split`), and an unsigned `EDGE_NETWORK_SEED`. The removed
delay/denominator/phase knobs are rejected rather than silently approximated. Base delay and
centred jitter apply on all four proxy legs in an application round trip. Exact loss, reorder,
burst loss, and congestion apply only at edge-to-client egress, so each browser↔daemon logical
direction crosses one destructive fault site and a requested 9% is not compounded into 17.19%.

Every proxy relay (one UDP source, so one QUIC connection) owns its trace: per-direction packet
ordinals and a seed mixed from its admission order and the current trace key. Its loss, jitter, and
reorder decisions never depend on another connection's volume, and each complete 100-packet window
of its downstream holds exactly the requested losses. The control verb `mark:<nonce>:<key>`
restarts every relay's ordinals under that key at its next packet, so two windows marked with one
key replay the same decisions relay by relay; `reset` does the same under key 0 and also clears the
epoch's counters, so a spec that resets before each window replays from ordinal zero. `settle`,
`mark`, and `stats` report each live relay's pending packets, its exact ledger since the mark, and
the most packets each of its delay lines held at once since the mark; `settle` and `mark` also
report every relay's ledger since the mark together, which keeps the packets of a relay that has
detached since. Congestion windows share one downstream bottleneck queue. The delay lines never
drop for capacity: a relay's 65,535-packet lease is the only bound, and a packet an exhausted lease
refuses is a harness drop that fails the run.

The touch terminal stays edge-to-edge, without safe-area padding. Its app shell owns
viewport positioning; the body is scroll-locked but not fixed. Rotation, resize, and
scroll notifications resynchronize its height and reset a retained document scroll origin.
`terminal-touch` covers portrait/landscape/portrait sizing, delayed scroll offsets, and
touch activation of keyboard and Back. This emulation does not replace testing rotation
in an installed iPhone PWA with a connected terminal.

`bun run test:tpm-sim` starts an isolated Docker `swtpm`, exercises the raw TPM command path and
signing worker, and removes the container. To run browser transport tests against an already
running simulator, set `MERKUR_TPM_SIM_ADDR=127.0.0.1:<port>` on `test:e2e:transport`; the harness
builds the `tpm-sim` feature and records it in native artifact provenance. Ordinary release builds
omit that feature.

## Build And Release

| Command | Process boundary |
| --- | --- |
| `bun run build:web` | Resolve the local public pin, sync terminal WASM, then run Vite with public inputs only. |
| `bun run build:server` | Compile the Bun server executable. |
| `bun run build:daemon` | Compile the daemon CLI and Rust dataplane distribution. |
| `bun run build:dataplane` | Build and copy the Rust dataplane and isolated image worker. |
| `bun run build:wasm` | Build terminal, browser E2E and graphics asset WASM packages. |
| `bun run sync:wasm` | Copy terminal WASM artifacts into the web source tree. |
| `bun run rust:all` | Check Rust, build dataplane/WASM, and sync web artifacts. |

The tag-triggered CI release workflow builds daemon tarballs for macOS arm64, macOS x64,
Linux x64, and Linux arm64, smoke-tests each compiled CLI and dataplane, signs in the
protected signing job, and publishes the four artifacts with one canonical
ML-DSA-87-signed release manifest to GitHub Releases; see [CI operations](ci.md).

### Health and lifecycle states

Server liveness is independent of dependencies. Readiness starts with every component in
`starting`, becomes `ready` only when every component is `healthy`, and returns to `not_ready`
when any component is `unhealthy`. The server marks every component unhealthy before draining the
HTTP listener during orderly shutdown.

The daemon is ready only while its control state is `registered` and its dataplane state is
`ready`. Control moves through `starting`, `connecting`, `registering`, `registered`, `backoff`, or
`superseded`; dataplane health is `starting`, `ready`, `down`, or `fatal`. A superseded daemon
closes its dataplane scope and remains dormant so launchd/systemd cannot restart it into a
replacement loop; process signals can still stop it normally.

Linked daemon configuration has one exact, unversioned active shape with pinned
`daemon_identity_seal: {backend, material}`, user-root public key/epoch, root-signed daemon
binding, and sorted browser-delegation tombstones; startup rejects any other shape. The link
command alone also reads the older `daemon_identity_signing_seed` layout, once, to re-link a
daemon that still carries it (`apps/daemon/src/cli/legacy-daemon-config-migration.ts`). Kysely runs a whole migration pass and its
bookkeeping in one transaction, so a pass that fails anywhere leaves the database exactly as it
found it, ledger rows included. Server configuration validates the stable setup, runtime public key, and web-build
pin before that transaction begins.
Full health documents, metric names, log behavior, and OTLP ownership are in
[`docs/observability.md`](./observability.md).

## Profiling And Device Acceptance

The project-wide harness records repeated hot-path metrics plus wall time, CPU time, maximum RSS,
variance, and baseline regressions. Use `bun run bench:all` for the fast benchmark set,
`bun run profile:services` for every service, and `bun run profile:full` for the complete release
profile. The methodology and profiler/soak options are documented in
[`docs/performance.md`](./performance.md).

Repeatable benchmark sources live under `scripts/`. A root script without a package command or a
reachable command dependency fails `bun run check:files`.

`spikes/webtransport-ios` is an isolated real-device prototype for the iPhone WebTransport drain
gate, run as two processes with `bun run spike:ios:server` and `bun run spike:ios:web`. Its
final-tail loss calculation excludes an entirely missing trailing burst, a known limitation of the
spike. Its UDP extra-hop scenario is not Merkur's application-level edge splice.

### Direct-discovery lifetime

The Rust PTY owner owns a bounded traversal queue and one outstanding blocking-pool batch.
Offer handlers enqueue work without sending punch packets inline. Batches include port generation,
side-channel locks and socket sends; timer pacing and cancellation stay with the owner. Shutdown
joins the outstanding batch, and topology invalidation aborts queued work. A running batch is at
most 16 packets. IPv4 mapping and IPv6 pinhole acquisition run concurrently in the maintenance
owner's task, outside terminal traffic. Browser direct races run in the transport worker, own
all connection/timer lifetimes, and leave the edge relay available during discovery.

Hardware identity opening occurs before control authentication. A bounded Rust signing worker owns
both proof halves; HTTP/WSS callers request proofs through IPC `0x10` and receive `0x94` before the
command acknowledgement. Session signing parks a pending auth attempt and resumes it through an
owner-loop completion without blocking PTY/display processing. Backend failure exits 3 and requires
relinking; there is no automatic software downgrade. The runtime requires the composite identity,
and a link made under any earlier shape is invalid. See [identity custody](security.md#hardware-bound-daemon-identity).
