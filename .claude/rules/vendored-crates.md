---
paths:
  - "packages/*-patch/**"
  - "Cargo.toml"
  - "Cargo.lock"
  - "apps/edge/**"
  - "apps/daemon/dataplane/**"
  - "packages/term-wasm/**"
---

# Vendored `[patch.crates-io]` crates

`packages/alacritty-terminal-patch`, `packages/vte-patch`, `packages/wtransport-patch`,
`packages/quinn-patch`, `packages/quinn-proto-patch`, and `packages/fontdue-patch` are
applied via `[patch.crates-io]`. Each keeps upstream's edition and `rust-version`
declaration; do not "harmonize" those away. The comment in `Cargo.toml` says why the
transport patches are deliberately not workspace members; read it before moving them.

- `vte-patch` exists for the batched printable-run hook (`Perform::print_str`,
  `ansi::Handler::input_str`) upstream lacks; both new trait methods default to the
  per-character loop they replace. VTE also owns synchronized-output completion/deadline
  evidence and canonical shell-boundary callbacks below application buffering. Never
  restore a parallel raw ANSI scanner for speculative authority: its semantics diverge on
  C1, cancellation, compound private modes, and OSC termination. Fresh canonical boundaries
  invalidate the prior kernel sample even when their active/authenticated bits are
  unchanged. Terminal-semantics fixes belong here, not in a fork of the call site. Move
  `vte-patch`, `alacritty-terminal-patch`, `term-wasm`, and the lockfile together or not
  at all.
- `wtransport-patch` awaits the QUIC handshake before H3 SETTINGS (the 0.5-RTT
  experiment was reverted), exposes exact batch datagram capacity, performs atomic
  non-dropping datagram admission, and receives by pulling datagrams from Quinn
  (`receive_datagrams` fills a `DatagramBatch`; `receive_datagram` is the same pull with
  room for one), with no worker channel. Together with `quinn-patch` it carries shared
  ciphertext plus a carrier-local prefix to packetization without an envelope copy. Under
  `cfg(merkur_sim)`, which only the simulator's generated workspace sets (`tools/sim`),
  `Endpoint::client` and `::server` take their socket, runtime and packet-number seed from
  `endpoint::sim` and never bind the host's network. Move it, `apps/edge`,
  `apps/daemon/dataplane` and the lockfile together.
- `quinn-proto-patch` accounts for every queued datagram entry, preserves accepted
  datagrams when a new admission cannot fit, and exposes the congestion controller's
  exact bytes in flight and pacer rate through `PathStats`; the display planner consumes
  those values together with RTT, loss, MTU, and send-buffer occupancy instead of
  inferring delivery from an application bitrate. A loss cuts the congestion window only
  when the lost packet was sent against a full window (`SentPacket::window_limited`);
  persistent congestion still collapses it. A packet declared lost that the peer then
  acknowledges is proven reordering: the path's packet and time thresholds rise to what it
  needed (time at most 2× RTT), `PathStats::spurious_lost_*` count it, `DeliveryState` and
  every loss consumer report `lost_packets - spurious_lost_packets`, and its stream data is
  acknowledged, so a queued retransmission is dropped (`SendBuffer::ack` returns the bytes
  it newly acknowledges; an original and its retransmission can both arrive). It implements
  Careful Resume (RFC 9959, `congestion/careful_resume.rs`): a connection hands one successor
  on the same local and peer address the most bytes one window-bounded round delivered
  (`take_careful_resume_observation`, capped by its window), and the successor
  (`careful_resume`) jumps to half of it once its own backlog exceeds its whole window, paced,
  then keeps or retreats from the jump as the RFC's phases decide.
  `Controller::resume_window` hands each phase's window back; Bbr refuses it and never
  resumes. Move it with both Rust transport crates and the lockfile.
- `quinn-patch`'s connection driver never holds the connection-state lock across socket I/O,
  and every release of that lock publishes the connection's `DeliveryState` for lock-free
  reads (`Connection::delivery_state`, `is_closed`). A reader on a latency path (the daemon
  owner, a flush, a quote) reads that view; `stats()` locks and stays for cold telemetry.
  Never move a send back under the lock or publish anywhere but at a release: the
  `driver_io` tests in its `src/tests.rs` fail on either. An `EgressHold`
  (`Connection::hold_egress`) stops packet construction, never admission, until its last
  release wakes the driver; `read_datagrams` takes a packet's buffered datagrams under one
  lock hold.
- `fontdue-patch` compiles glyph outlines on first use and caches them, preserving the
  rasterizer; eager full-font parsing stalled the Firefox display worker during
  post-first-paint style promotion. Move it with `term-wasm` and the lockfile. Its tests
  pin metrics and bitmap hashes from upstream Fontdue.
