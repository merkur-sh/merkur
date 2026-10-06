# Network simulator

The real client, edge and dataplane on [turmoil](https://github.com/tokio-rs/turmoil)'s
simulated network and clock. A run is a function of its seed: the same seed replays every
datagram at the same simulated instant, so a fault found once (a partition at one packet, a
carrier lost mid-rebind) becomes a test that fails the same way every time.

```sh
bun run test:sim                    # every scenario and every recorded regression
bun run test:sim --test spike       # one file
bun run test:sim:sweep 200          # 200 random seeds from a random start
bun run test:sim:sweep 50 7000      # seeds 7000..7050
bun run test:sim:update-lock        # after a production dependency change
```

## Declared simulator targets

The Bazel factory consumes the original release capture from `tools/sim/manifest.toml`
and its retained lock. It declares the library, all 11 authored harnesses (including
rotation), and rustdoc from that captured graph. `//tools/sim:simulator` selects the
library; `//tools/sim:scenarios` selects the library test, every harness and rustdoc.
These targets are manual diagnostics until the matching native runtime is qualified.
The generated `test:sim` operation lists those exact 13 tests.

Each Bun harness uses the existing configured Rust test wrapper. The declared executable
has basename `merkur-sim`; the launcher exports its absolute runfile path as
`MERKUR_SIM_BINARY`. The Rust wrapper sets `CARGO_MANIFEST_DIR` and the working directory
to the original `tools/sim` package. Tests retain `--test-threads=1 --nocapture`, and
compilation retains `--cfg merkur_sim --cfg tokio_unstable`.

`//tools/sim:configured_sweep` runs the captured sweep wrapper with the original
`--ignored --exact --test-threads=1 --nocapture` selection and declared regressions.
It is a fresh, uncached external test. Each selected test receives its own nonce;
dependency runtime files exclude the dependency's nonce.

Capture requires a matched declared SDK and native execution host. The supported shapes
are Darwin ARM64 and x64, and Linux ARM64 and x64. Runnable bindings exist only for
captured hosts; an absent host is refused, with no foreign fallback. A successful source
capture or declaration control does not qualify native compilation or scenario execution.

## How production code ends up simulated

- **Isolation.** `scripts/sim-tests.ts` writes `manifest.toml` into the generated workspace
  `test-results/sim/workspace` with absolute paths and the production `[patch.crates-io]`
  table and lints, and builds it with `--cfg merkur_sim --cfg tokio_unstable` against the
  retained `tools/sim/Cargo.lock`. `update-lock` seeds that lock from production's, so
  every crate production links keeps its version. turmoil and tokio's `test-util` never
  reach the production workspace or its lockfile.
- **Sockets.** Under `cfg(merkur_sim)`, `wtransport::Endpoint::client` and `::server`
  take their socket, runtime and packet-number seed from `wtransport::endpoint::sim`,
  which this crate installs (`bind` in `src/lib.rs`). The socket is a turmoil UDP socket
  (`src/socket.rs`); the runtime runs quinn's tasks and timers, pacing included, on the
  host's paused tokio clock (`src/runtime.rs`). No call site changes.
- **Clocks.** The simulator binary defines `clock_gettime` (`src/clock.rs`), so `std`'s
  `Instant::now()` and `SystemTime::now()` read simulated time wherever production calls
  them. Inside a host it is the host's tokio clock. Monotonic time starts far from zero,
  and wall time starts at 2026-09-01, so certificates and tokens minted inside a run are
  valid inside it. The technique is madsim's, as `mad-turmoil` packages it.
- **Entropy.** The binary also defines `getentropy` and the platform entry points `std`
  and ring draw from (`src/entropy.rs`), so hash keys, handshake randomness and connection
  ids come from one seeded stream. It is a simulation generator, not a cryptographic one.
  On glibc two readers bypass a symbol definition: `std` and `getrandom` 0.3 and later
  find `getrandom` with `dlsym`, so `build.rs` exports this binary's definition; and
  `getrandom` 0.2, which ring uses, makes the system call itself, so the binary defines
  `syscall` too, answering `SYS_getrandom` and passing every other call to the C library.
- **Threads.** `merkur_sim::run` gives every run a fresh thread, because `std` draws a
  thread's hash keys once and then steps them. Runs share process-wide hooks, so the
  runner passes `--test-threads=1`.

## The deployment a scenario runs

`src/world.rs` builds one: an edge host, a daemon host and the server between them; a
scenario adds client hosts and drives them.

- **Edge.** `merkur_edge::sim::Edge`: the relay's accept loop and splice registry, and no
  registration, telemetry or egress budget. Its `Identity` (the certificate it serves, the
  one it will serve next, and the stateless-reset secret) is held across the host's
  restarts, as the identity directory holds it. A scenario can rotate it in place, as the
  registration loop does (`World::edge_rotator`), or restart the edge as a new identity
  (`World::run_rotating_edge`).
- **Daemon.** `merkur_dataplane::sim::start` runs the dataplane's owner loop with what the
  process gets from its parent and its terminal handed in as channels: commands for stdin,
  an event reader for stdout, and the PTY's far end. `src/daemon.rs` plays the Bun daemon
  on them: it configures the dataplane with a software identity seal, relays each control
  lease (revocation generation, and the edge admission: a fresh edge ticket and the edge's
  certificate pair, every 20 s) and each session start. The STUN ticket a lease also carries is not relayed, because it starts the
  direct path's discovery. `src/shell.rs` is the program on the PTY, a line editor with a
  `$ ` prompt. Every thread the process hands work to does that work on the owner loop
  instead, at the top of each turn or in place: the PTY writer, display preparation and
  dictionary finalizing, and identity signing. The owner loop's order of events is then
  a function of the seed.
- **Server.** `src/server.rs` is one account (root, delegate, delegation, the daemon's
  binding, all from fixed seeds) and the issuance and renewal routes. An issuance hands
  the daemon its `session_start` (after retracting the session it supersedes, as the
  server's issuance service does), answers the client once the dataplane accepts, and
  mints the session capability and both attach tickets; a renewal mints a capability
  over the renewal intent's commitment and, when it names the edge, answers with that
  edge's certificate pair. The pair is read as the edge registers it at each boot and
  rotation, so a new session or renewal pins what the edge serves now. The capability encoder is
  the one record the server writes in TypeScript; `tests/issuer.rs` pins it to the
  server's vector byte for byte.
- **Client.** `src/client.rs` runs the client core under `merkur-client-native`'s driver,
  with the server as its `Issuer`, and a viewer that presents at 60 Hz as
  `merkur-tui headless` does. The driver signs its delegate's proofs in place, and its
  path watcher hears the changes a scenario announces
  (`merkur_client_native::network_changed`) instead of the host's.

## Faults and invariants

turmoil partitions links (both ways or one way), holds and releases them, crashes and
bounces hosts (`World::run_bouncing`), and draws each datagram's latency from a range, so
datagrams reorder (`world::Network`). `src/faults.rs` adds what it cannot express: a
host's datagrams lost from an exact packet onward (`cut_after`), a count of the datagrams
an exchange sends (`count`), so a sweep can kill an exchange at each of its packet
boundaries in turn, loss drawn from the run's seed (`set_loss`), and a NAT that maps a
host's sockets to new ports (`rebind_nat`). Each host registers its runtime as it boots
(`src/hosts.rs`), which is how a socket bound to the wildcard address knows its host.

`src/scenario.rs` holds the outage every recovery test shares and the invariants each one
must hold:

- recovery within the client's 5 s retry ceiling plus one attempt of the network healing,
  plus the blackout an attempt already in flight crossed (its QUIC handshake backs off
  exponentially through the loss, and nothing announces a silent heal);
- every key reaches the program exactly once, in order (`src/shell.rs` transcribes the
  PTY);
- the client presents the daemon's grid: `src/oracle.rs` rebuilds that grid from the
  program's output with the emulator the dataplane runs, never from the display stream;
- a session is retracted only when a fresh issuance superseded it.

## Sweeps and recorded regressions

`tests/sweep.rs` derives one outage from each seed: which way the link is cut (both ways,
uplink or downlink), for 1 to 90 s, and for half the seeds a cut of the recovery at a
packet boundary as well (the client's datagrams after its k-th, k < 40, lost for 1 to 5 s).
Every recovery invariant must hold. An attempt the outage caught in flight can still be
backing off when the network heals, and is abandoned only at the client's 10 s attempt
watchdog, so a sweep's bound adds that much blackout; the fixed-seed scenarios keep the
tighter bound their seeds meet. `test:sim:sweep` runs a range of seeds and appends
each one that fails to `regressions.json` with its failure and the date; every `test:sim`
replays the whole file, so a found seed fails the suite until its fix lands and guards
the fix from then on. Commit the entry with the fix. The scheduled Assurance run sweeps
200 seeds on Linux and uploads the file.

## Diagnosing a divergence

`MERKUR_SIM_TRACE=<dir>` writes every datagram of run *n* to `<dir>/run-<n>.trace` as
`nanoseconds source destination length`; `diff` two runs of one seed to find the first
datagram that moved.

## Scenarios

| File | What it proves |
| --- | --- |
| `tests/spike.rs` | A WebTransport session over the patched stack echoes a datagram and a stream, survives a 2 s partition with quinn's loss detection, and closes on its 10 s idle timeout at exactly that simulated instant; `std` clocks inside a host read simulated time; 20 runs of one seed hash identically and another seed does not. |
| `tests/issuer.rs` | The simulator's session capability is the server's vector token, byte for byte. |
| `tests/session.rs` | A session is issued, attaches through the edge, authenticates and reaches `Ready`; the prompt and a keystroke's echo reach the client's grid over the relay; input reaches the PTY once; the grid is the daemon's; 20 runs of one seed hash identically and another seed does not. |
| `tests/recovery.rs` | A client cut off from the edge for 10 s or 45 s rebinds on its own lineage with no issuance. For 75 s, past the 60 s rebind window, it issues exactly once and recovers: the 2026-09-22 loop retried the rebind forever. Every recovery invariant holds, and each replays. |
| `tests/faults.rs` | A first connection, the recovery after a 10 s outage (a rebind) and the one after a 75 s outage (a fresh issuance), each killed at every packet boundary in turn, still connect or recover with every invariant. |
| `tests/regressions.rs` | 2026-09-21: path hints never cancel or re-issue a healthy session. 2026-09-23: hints during a recovery never restart its attempt. 2026-09-30: a client that re-authenticates while the daemon still holds its peer, cut off mid-burst, gets its screen within an attempt; the incident's trigger was a dead direct connection, so on the relay this one does not fail with its fix reverted. |
| `tests/expiry.rs` | A session typed into for seven minutes renews its 5 minute capability in place twice: one issuance, never out of `Ready`. |
| `tests/network.rs` | An outage of the uplink alone, or of the downlink alone, recovers within the same bound as a two-way one. A session on a link that loses 2% of datagrams and reorders them (10 to 40 ms) converges without leaving `Ready`. A NAT rebinding under a live session keeps its carrier: the edge follows the connection to its new port. |
| `tests/sweep.rs` | Every seed in `regressions.json` recovers with every invariant; `test:sim:sweep` adds the seeds a sweep finds. |
| `tests/bounces.rs` | An edge restarted with its identity keeps the session with no issuance: its stateless resets tell the client at once, and both legs re-attach under their tickets. A restarted dataplane costs one issuance and keeps every key, within one attempt: its announced incarnation retires the dead process's sessions at the edge. An edge restarted as a new identity costs one issuance: the client's failed dial asks the server, through a renewal, for the hashes it serves now. |
| `tests/rotation.rs` | A session issued before one in-place certificate rotation rebinds after a 45 s outage on the pins its issuance carried; across two, its renewal brings the new pins and it still rebinds, with no issuance. |

## Limits

- A reader outside every host, such as an OS thread, gets the last simulated reading,
  not a clock of its own. That is why no thread runs in a simulated process.
- Relay only. The direct path's discovery (STUN, port mapping, interface candidates) binds
  host sockets and is not simulated, so scenarios keep the client on the relay.
- No images: the daemon host has no image helper, and its program draws none.
- No host pause. turmoil ticks every running host each step, so a host cannot sleep while
  time passes and then fire its overdue timers at once, as a phone does. A partition is not
  a stand-in: during one, the client's timers keep running.
