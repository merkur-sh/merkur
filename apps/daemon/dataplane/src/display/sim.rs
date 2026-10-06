//! Deterministic virtual-time simulation of the display pipeline.
//!
//! # Why this exists
//!
//! `tests/e2e/transport-latency.e2e.ts` asserts keystroke-to-display latency as
//! a wall-clock p95 against a fixed millisecond bound. On a host running
//! Chromium with software rasterisation plus three web workers, a Bun server,
//! Redis, a Bun daemon, a Rust dataplane and a Rust edge on four cores, the same
//! code measured 52 / 54 / 68 / 73 / 122 / 176 ms across runs — a spread far
//! larger than any regression it could detect. The failing samples are not slow
//! delivery at all: the terminal worker stops being scheduled for 120-160 ms and
//! several frames land in one burst when it resumes. That bound therefore
//! measures the machine, which is why `docs/performance.md` has to tell a human
//! how to interpret a red.
//!
//! A threshold cannot separate those two things, so this does not try to pick a
//! better one. Under a virtual clock the question stops being "was it fast
//! enough" and becomes an equality: **the frame carrying a terminal write is
//! emitted by the very next scheduled flush, never a later one.** That holds at
//! any clock speed, on any host, under any load, and it breaks by an exact
//! amount when a coalescing interval or a round trip is added — a 4ms change to
//! the pacing interval fails it, against a wall-clock assertion whose noise
//! floor is over a hundred.
//!
//! Measured, the equality holds exactly while the coalescing regime is stable,
//! and has one documented exception: the keystroke on which sustained typing
//! switches the flush interval off its interactive arm. There the owner loop has
//! already armed the short timer, wakes on it, and finds the peer's pacing
//! interval moved underneath it. `the_coalescing_switch_costs_one_keystroke`
//! pins that cost rather than hiding it.
//!
//! # How it is deterministic
//!
//! Time is an `f64` this harness owns, and it advances only to the next event
//! the daemon itself would have woken for: the flush timer, or a viewer's
//! acknowledgement arriving. The timer is `main.rs`'s `flush_sleep` /
//! `flush_armed` pair, modelled as one deadline (`flush_due_at_ms`) and armed
//! from the same sites with the same rule — a PTY read, a PTY-write
//! completion, an ACK or a keystroke asks `compute_next_flush_delay_ms` and
//! may only move the deadline EARLIER (`arm_flush_earlier_only`), while the
//! timer-fire arm re-arms from the scheduler's one answer after its flush
//! (`rearm_flush_after_wake`), or parks. A harness that recomputed the delay
//! at every step instead of holding the armed deadline over-advanced: it let
//! an ACK that landed while the timer was armed move the deadline later, which
//! no production site can do.
//!
//! Acknowledgements are queued by the viewer with a modelled delay and
//! released at their own instant, so the round-trip sample `recv.rs` folds
//! into `display_confirm` is exactly that delay. At a tie the ACK is released
//! before the timer fires — a modelling choice, stated once here: production
//! has no defined order between a datagram that has already arrived and a
//! timer that is due in the same instant, and delivering the ACK first is what
//! lets a flush see the freshest baseline. With no jitter in the model the
//! confirmation EWMA equals the delay exactly, and the row re-send interval is
//! its clamp, which the harness self-tests pin.
//!
//! Only the leaves are simulated. `TerminalState`, `flush_display` and the
//! scheduler are the production types and functions the daemon runs; the PTY is
//! a scripted byte source and the socket is the capture channel
//! `DirectSession` already exposes for tests. Nothing here reimplements a
//! code path, because a simulator that forks the implementation tests something
//! the daemon does not do.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::mpsc;

use super::clock::FlushClock;
use super::policy::DISPLAY_ACK_MASK_WORDS;
use super::send::{
    DisplayFlushCursor, DisplayPrepareCompletion, DisplayPrepareWorker, DisplayScratch,
    arm_expired_resume_snapshots, compute_next_flush_delay_ms, finish_display_prepare,
    finish_snapshot_prepare, flush_display, has_runnable_display_work, peer_row_resend_interval_ms,
    send_paused_drain_metadata, start_display_prepare_worker,
};
use crate::connection::{
    DisplayDatagramOutcome, DisplayDatagramProtection, PeerDisplayState, PeerMap, PeerTransport,
    SimDatagramMetadata, SimDatagramRole,
};
use crate::perf_timing::PerfTimingTracker;
use crate::pty::TerminalState;

/// Peer identity of the first simulated viewer.
///
/// Zero-padded because `take_display_peer_batch` round-robins peers in string
/// order; unpadded indices would order `sim-browser-10` before `sim-browser-2`
/// and make a fairness assertion test the wrong rotation.
pub(crate) const SIM_PEER_ID: &str = "sim-browser-00";

/// Identity of the `index`-th simulated viewer.
pub(crate) fn sim_peer_id(index: usize) -> String {
    format!("sim-browser-{index:02}")
}

/// One frame the send path admitted to the simulated transport.
#[derive(Debug, Clone)]
pub(crate) struct SimWireFrame {
    /// Position in the sender-admitted datagram stream, including losses.
    pub(crate) index: u64,
    pub(crate) at_ms: f64,
    /// Virtual instant this datagram reaches its viewer.
    pub(crate) deliver_at_ms: f64,
    pub(crate) len: usize,
    /// Which viewer this datagram was addressed to.
    pub(crate) peer_id: String,
    pub(crate) metadata: SimDatagramMetadata,
    /// The sealed bytes exactly as the send path admitted them. Held on the
    /// frame itself rather than in a parallel vector: a `continue` in the drain
    /// loop would silently desynchronise two vectors, and nothing would notice.
    pub(crate) bytes: Vec<u8>,
}

/// One frame the send path committed on a reliable lane. Snapshots, jumbo
/// frames and resync travel here rather than as datagrams.
#[derive(Debug, Clone)]
pub(crate) struct SimReliableFrame {
    pub(crate) deliver_at_ms: f64,
    pub(crate) len: usize,
    pub(crate) channel_id: u8,
    pub(crate) peer_id: String,
    pub(crate) bytes: Vec<u8>,
}

/// A datagram admitted by the sender and then discarded by the simulated
/// network. Retaining its sealed bytes lets the receiver-side inspector prove
/// whether an explicit fault hit data or parity without applying the frame.
#[derive(Debug, Clone)]
pub(crate) struct SimDroppedFrame {
    pub(crate) index: u64,
    pub(crate) len: usize,
    pub(crate) peer_id: String,
    pub(crate) metadata: SimDatagramMetadata,
    pub(crate) bytes: Vec<u8>,
}

/// A flush the harness performed, and what it produced.
#[derive(Debug, Clone)]
pub(crate) struct SimFlush {
    /// Virtual time the flush ran at.
    pub(crate) at_ms: f64,
    /// Datagrams emitted by this flush alone.
    pub(crate) datagrams: usize,
}

/// A viewer's acknowledgement on its way back to the daemon.
struct PendingAck {
    release_at_ms: f64,
    peer_id: String,
    generation: u32,
    largest_seq: u32,
    received_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    recovered_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    /// A display grant this acknowledgement delivers; later ones repeat it.
    grant: Option<u32>,
}

/// PTY activity scheduled independently of the owner loop. Input echoes carry
/// the input sequence whose display frame lets the viewer attribute latency;
/// background output has no peer or sequence.
struct PendingPtyWrite {
    release_at_ms: f64,
    bytes: Vec<u8>,
}

/// A physical key event at the browser, before network transport.
struct PendingBrowserKey {
    release_at_ms: f64,
    uplink_delay_ms: f64,
    peer_id: String,
    input_seq: u32,
    input_bytes: Vec<u8>,
    echo_bytes: Vec<u8>,
}

/// An input frame on its way from browser to daemon.
struct PendingDaemonInput {
    release_at_ms: f64,
    peer_id: String,
    input_seq: u32,
    input_bytes: Vec<u8>,
    echo_bytes: Vec<u8>,
}

/// Why [`DisplaySim::step`] woke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SimWake {
    /// The owner loop's flush timer fired.
    Timer,
    /// A viewer's acknowledgement was delivered at its release instant.
    Ack,
    /// One or more datagrams became readable by their viewers.
    Delivery,
    /// A person pressed a key in the browser.
    BrowserKey,
    /// That key's input frame reached the daemon.
    Input,
    /// External PTY activity became readable by the daemon.
    Pty,
}

/// What a bounded run of the owner loop did.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScheduleRun {
    /// Flush-timer fires. The run's wake cap bounds this: a timer that
    /// re-arms at zero and fires again is the owner loop spinning, and the cap
    /// is how the harness sees it.
    pub(crate) wakeups: usize,
    /// Flushes that ran. A timer fire with nothing runnable is a wake, not a
    /// flush.
    pub(crate) flushes: usize,
    /// Datagrams those flushes put on the wire.
    pub(crate) datagrams: usize,
    /// Virtual time at which the timer and the ACK queue were both empty, if
    /// the run got there inside its budget.
    pub(crate) parked_at_ms: Option<f64>,
}

pub(crate) struct DisplaySim {
    now_ms: f64,
    terminal: TerminalState,
    /// What the terminal writes back to the PTY, Kitty graphics replies among it.
    terminal_events: crossbeam_channel::Receiver<crate::pty::TerminalEvent>,
    scratch: DisplayScratch,
    worker: DisplayPrepareWorker,
    peers: PeerMap,
    cursor: DisplayFlushCursor,
    perf: PerfTimingTracker,
    completion_rx: mpsc::Receiver<DisplayPrepareCompletion>,
    snapshot_completion_rx: mpsc::Receiver<super::send::SnapshotPrepareCompletion>,
    /// Every datagram the send path admitted, in order.
    capture_rx: mpsc::UnboundedReceiver<(String, Vec<u8>)>,
    /// Reliable-lane frames the send path admitted: `(channel_id, payload)`.
    reliable_rx: mpsc::UnboundedReceiver<(u8, String, Vec<u8>)>,
    /// Reliable-lane frames admitted, in order.
    reliable: Vec<SimReliableFrame>,
    reliable_delivery_cursor: usize,
    built: usize,
    wire: Vec<SimWireFrame>,
    dropped_wire: Vec<SimDroppedFrame>,
    /// Constant one-way latency applied to newly admitted datagrams.
    downlink_delay_ms: f64,
    /// First wire frame whose delivery event has not yet fired. Constant delay
    /// keeps delivery order identical to admission order.
    delivery_cursor: usize,
    /// Deterministic loss model. Random loss is keyed by sender-assigned stable
    /// physical identity; `loss_index` survives only for explicit index faults
    /// and readable event ordering.
    loss_pct: u32,
    loss_seed: u64,
    loss_index: u64,
    dropped: usize,
    /// Frame indices the loss model dropped, in order. Compared directly when
    /// checking reproducibility: two seeds can easily drop the same NUMBER of
    /// frames while dropping different ones, so counts cannot tell whether the
    /// seed is doing anything.
    drop_log: Vec<u64>,
    /// Exact admitted-datagram indices to discard in addition to percentage
    /// loss. Sorted, deduplicated, and consumed deterministically.
    drop_indices: Vec<u64>,
    flushes: Vec<SimFlush>,
    /// `main.rs`'s `flush_sleep` deadline while `flush_armed`; `None` is the
    /// parked timer.
    flush_due_at_ms: Option<f64>,
    /// Acknowledgements in flight, sorted by release instant; among equal
    /// instants, in the order they were sent, because `enqueue_ack` inserts a
    /// new one after every existing one due at the same instant.
    pending_acks: Vec<PendingAck>,
    /// External PTY writes, sorted by release instant and insertion order.
    pending_pty_writes: Vec<PendingPtyWrite>,
    /// Modelled time the prepare worker spends on one flush. Output due inside
    /// it reaches the terminal before the completion is finished, as the owner
    /// loop keeps reading the PTY while the worker encodes.
    prepare_time_ms: f64,
    pending_browser_keys: Vec<PendingBrowserKey>,
    pending_daemon_inputs: Vec<PendingDaemonInput>,
    /// Number of subsequently sent acknowledgements the deterministic link
    /// should discard. Used to exercise quiet-tail recovery without adding a
    /// second random stream to the simulator.
    ack_drop_budget: usize,
    dropped_acks: usize,
    /// Whether more PTY output is queued behind the batch just applied. The
    /// harness applies synchronously, so this is false unless a test models a
    /// sustained producer.
    pty_output_pending: bool,
    /// Dictionary prepare completions from the `merkur-display-dict` thread.
    ///
    /// Production drains it on the `dictionary_prepare_completion_rx` arm of
    /// its select loop in `main.rs`. The harness waits on it explicitly after
    /// every flush that submitted a build (`has_dictionary_prepare_in_flight`),
    /// so the dictionary step is deterministic: a `try_recv` drain raced the
    /// build and installed the dictionary one flush earlier or later depending
    /// on the host. Dropping the receiver would stop only dictionary builds —
    /// display preparation runs on its own thread — but the simulator keeps
    /// them, because a session with dictionaries is the pipeline real
    /// sessions run.
    dictionary_rx: mpsc::Receiver<super::send::DictionaryPrepareCompletion>,
    /// Scratch for ACK handling, so a delivered ACK allocates nothing.
    /// Browser-side Noise transports, one per viewer.
    browsers: HashMap<String, crate::e2e::NoiseTransport>,
    /// How far the flush clock advances per read. Zero — the default — freezes
    /// time inside a flush, so a session replays identically. A positive step
    /// models a flush that takes real time to run, which is what makes the
    /// owner loop's turn budget reachable.
    clock_step_ms: f64,
    /// Peers whose datagram sequence advanced during the last flush, in id
    /// order. This is how a deferral is observed: a peer the owner loop put off
    /// is simply absent from the flush that deferred it. Snapshots travel the
    /// reliable lane and do not advance this, so a peer served a snapshot is
    /// deliberately not listed — see `snapshot_pending`.
    delta_served_last_flush: Vec<String>,
    /// Model a browser whose display demand never closes: every flush starts
    /// with a full window of grants for every peer. Suites about loss, FEC,
    /// fairness and encoding keep the delivery they were written against;
    /// presentation-bounded delivery is exercised with explicit grants
    /// (`use_explicit_demand`).
    unbounded_demand: bool,
    /// The newest cumulative grant each viewer has issued, carried by every
    /// acknowledgement it sends while demand is explicit.
    viewer_grants: HashMap<String, u32>,
}

/// The loss model: a pure function of `(seed, sender-assigned identity)`.
///
/// Free-standing on purpose. The simulator calls it to decide a frame's fate,
/// the viewer's display-unit disturbance calls it to decide an opened unit's,
/// and tests call it to predict either, so there is exactly one implementation
/// and a test can never drift into asserting its own copy.
pub(crate) fn frame_loss_value(seed: u64, metadata: &SimDatagramMetadata) -> u64 {
    let path = match metadata.path {
        PeerTransport::WebTransport => 0u64,
        PeerTransport::Edge => 1,
    };
    let role = match metadata.role {
        SimDatagramRole::Data => 0u64,
        SimDatagramRole::Replica => 1,
        SimDatagramRole::Repair => 2,
        SimDatagramRole::Probe => 3,
    };
    let mut z = seed;
    for component in [
        u64::from(metadata.generation),
        metadata.logical_ordinal,
        path,
        role,
        u64::from(metadata.role_index),
        u64::from(metadata.retransmit_attempt),
    ] {
        z = z.wrapping_add(
            component
                .wrapping_add(1)
                .wrapping_mul(0x9E37_79B9_7F4A_7C15),
        );
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
    }
    z
}

fn frame_is_dropped(seed: u64, metadata: &SimDatagramMetadata, loss_pct: u32) -> bool {
    loss_pct > 0 && (frame_loss_value(seed, metadata) % 100) < loss_pct as u64
}

/// One authenticated viewer whose display cache is primed to the blank grid.
///
/// Each peer gets its own Noise session, keyed by its own id the way production
/// derives the prologue. Sharing one session across peers would let a frame
/// sealed for one viewer open under another's counters and quietly hide
/// per-peer sequencing bugs.
fn build_sim_peer(
    peer_id: &str,
    cols: u16,
    rows: u16,
    blank_grid: &[merkur_codec::CellRepr],
    blank_hashes: &[u64],
) -> (PeerDisplayState, crate::e2e::NoiseTransport) {
    let psk = [0x11u8; 32];
    let prologue = crate::e2e::derive_prologue("display-sim", peer_id, &[0x42; 64]);
    let (browser_static, _) = crate::e2e::generate_static_keypair().expect("browser key");
    let (daemon_static, _) = crate::e2e::generate_static_keypair().expect("daemon key");
    let mut initiator = crate::e2e::NoiseHandshake::new_initiator(&browser_static, &psk, &prologue)
        .expect("initiator");
    let mut responder = crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue)
        .expect("responder");
    responder
        .read_message(&initiator.write_message(b"").expect("message 1"))
        .expect("read message 1");
    initiator
        .read_message(&responder.write_message(b"").expect("message 2"))
        .expect("read message 2");
    responder
        .read_message(&initiator.write_message(b"").expect("message 3"))
        .expect("read message 3");

    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::WebTransport);
    // SimViewer models a conventional 60Hz browser unless a scenario
    // explicitly overrides its receiver hint. Production starts at the safe
    // 480Hz cold bound, then receives the real period from the browser; leaving
    // the simulator at that transient default would turn every steady-state
    // transport oracle into an accidental 480Hz workload.
    peer.adaptive.presentation_period_ms = 1_000.0 / 60.0;
    peer.authenticated = true;
    peer.noise = Some(responder.into_transport().expect("daemon transport"));
    // A live carrier, or the send path has nowhere to admit a frame and skips
    // the peer before it ever submits a prepare.
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(0.0);
    peer.display_cache.resize(cols, rows);
    peer.display_cache
        .prime_from_snapshot(blank_grid, blank_hashes, &[]);
    peer.needs_snapshot = false;
    // The browser half of the same Noise session. Retained so a viewer can open
    // exactly the bytes the send path sealed, rather than a re-encoded copy.
    let browser = initiator.into_transport().expect("browser transport");
    (peer, browser)
}

impl DisplaySim {
    /// Build a simulated session with an authenticated peer whose display cache
    /// is primed, i.e. the steady state a live terminal is in.
    pub(crate) fn new(cols: u16, rows: u16) -> Self {
        Self::with_peers(cols, rows, 1)
    }

    /// Build a simulated session with `peer_count` authenticated viewers.
    ///
    /// More than one viewer is what makes the owner loop's fairness machinery
    /// reachable: `DISPLAY_PEERS_PER_FLUSH` caps how many peers one flush may
    /// serve, and `display_owner_should_defer` puts the rest back. Neither can
    /// be exercised by a single-peer harness, because the gate requires a peer
    /// to have already been offered.
    pub(crate) fn with_peers(cols: u16, rows: u16, peer_count: usize) -> Self {
        assert!(peer_count > 0, "a session needs at least one viewer");
        let (event_tx, terminal_events) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(cols, rows, event_tx);
        // One simulated daemon, not one of many sharing this test process.
        terminal.own_graphics_daemon();
        let mut blank_grid = Vec::new();
        let mut blank_hashes = Vec::new();
        terminal.current_grid_into(&mut blank_grid);
        terminal.current_row_hashes_into(&mut blank_hashes);
        // `build_peer` primes every browser cache from this exact blank grid,
        // so the simulator begins converged. Keeping TerminalState's
        // constructor-wide damage bitset after that would make the first
        // one-row keystroke look like a full-screen coherent redraw; the old
        // blanket causal-immediate scheduler accidentally hid that harness bug.
        terminal.clear_dirty();

        let scratch = DisplayScratch::new(4);
        let (worker, completion_rx, snapshot_completion_rx, dictionary_rx) =
            start_display_prepare_worker();

        // A real Noise session, because the send path seals every frame and a
        // peer without one is skipped entirely — which is how the first version
        // of this harness measured a pipeline that emitted nothing.

        // An in-memory transport. Each peer's direct session hands its sends to
        // this capture, so admission is exercised for real without a QUIC
        // connection — which is what makes the wire, not just the encoder,
        // observable in this harness.
        let (capture_tx, capture_rx) = mpsc::unbounded_channel();
        // Snapshots, jumbo frames and resync commit on the reliable lane.
        // Without this the send path cannot admit a snapshot at all, and a peer
        // that asks for one simply keeps asking.
        let (reliable_tx, reliable_rx) = mpsc::unbounded_channel();

        let mut peers = HashMap::new();
        let mut browsers = HashMap::new();
        for index in 0..peer_count {
            let peer_id = sim_peer_id(index);
            let (mut peer, browser) =
                build_sim_peer(&peer_id, cols, rows, &blank_grid, &blank_hashes);
            peer.direct_session = Some(crate::webtransport::DirectSession::new_capture(
                Arc::clone(&peer.peer_id),
                capture_tx.clone(),
                Some(reliable_tx.clone()),
            ));
            peers.insert(Arc::clone(&peer.peer_id), peer);
            browsers.insert(peer_id, browser);
        }

        Self {
            now_ms: 0.0,
            terminal,
            terminal_events,
            scratch,
            worker,
            peers,
            cursor: DisplayFlushCursor::default(),
            completion_rx,
            snapshot_completion_rx,
            capture_rx,
            reliable_rx,
            reliable: Vec::new(),
            reliable_delivery_cursor: 0,
            perf: PerfTimingTracker::default(),
            built: 0,
            wire: Vec::new(),
            dropped_wire: Vec::new(),
            downlink_delay_ms: 0.0,
            delivery_cursor: 0,
            loss_pct: 0,
            loss_seed: 0,
            loss_index: 0,
            dropped: 0,
            drop_log: Vec::new(),
            drop_indices: Vec::new(),
            flushes: Vec::new(),
            flush_due_at_ms: None,
            pending_acks: Vec::new(),
            pending_pty_writes: Vec::new(),
            prepare_time_ms: 0.0,
            pending_browser_keys: Vec::new(),
            pending_daemon_inputs: Vec::new(),
            ack_drop_budget: 0,
            dropped_acks: 0,
            pty_output_pending: false,
            dictionary_rx,
            browsers,
            clock_step_ms: 0.0,
            delta_served_last_flush: Vec::new(),
            unbounded_demand: true,
            viewer_grants: HashMap::new(),
        }
    }

    /// Stop topping up grants: display demand now comes only from viewer
    /// grants (`grant`), as it does from a real browser.
    pub(crate) fn use_explicit_demand(&mut self) {
        self.unbounded_demand = false;
    }


    /// Datagrams this session's flushes actually built, cumulative.
    ///
    /// Counted from prepare-worker completions, which is where frames are
    /// encoded for any damage large enough to leave the owner loop. This
    /// harness has no transport, so nothing is admitted to a wire and the
    /// peer's ACK bookkeeping stays empty — encode is the boundary this layer
    /// can observe, and admission belongs to the simulated-network layer that
    /// comes next.
    ///
    /// Checking emission at all is the point: asserting only that damage
    /// cleared is satisfied just as well by a flush that built nothing, which
    /// is exactly what the first version of these tests did.
    pub(crate) fn built_datagram_count(&self) -> usize {
        self.built
    }

    /// Drop `pct` percent of admitted frames, chosen by `seed`.
    ///
    /// Loss is applied where the harness drains the transport rather than
    /// inside the daemon, which is exactly the shape real UDP loss has from the
    /// daemon's point of view: the send succeeded, the bytes are gone, and the
    /// rows stay unacknowledged until resend or resync recovers them.
    ///
    /// The decision is a pure function of `(seed, generation, logical seq,
    /// path, physical role/index, retransmit attempt)`, so inserting a replica
    /// or repair cannot move every later data fault. The existing
    /// `MERKUR_DROP_DATAGRAM_PCT` harness samples `SystemTime::now()` instead,
    /// which means a failure it finds cannot be reproduced — the reason this
    /// model lives here rather than reusing it.
    pub(crate) fn set_loss(&mut self, pct: u32, seed: u64) {
        self.loss_pct = pct.min(100);
        self.loss_seed = seed;
    }

    /// Add an exact deterministic fault schedule by admitted datagram index.
    /// This composes with percentage loss; an index named here is always lost.
    pub(crate) fn set_drop_indices(&mut self, indices: &[u64]) {
        self.drop_indices.clear();
        self.drop_indices.extend_from_slice(indices);
        self.drop_indices.sort_unstable();
        self.drop_indices.dedup();
    }

    /// Apply a constant one-way delay to datagrams admitted from now on.
    ///
    /// Zero preserves the original harness: a caller pumping after the flush
    /// that emitted a frame can read it immediately.
    pub(crate) fn set_downlink_delay_ms(&mut self, delay_ms: f64) {
        assert!(
            delay_ms >= 0.0 && delay_ms.is_finite(),
            "a downlink delay must be finite and non-negative; got {delay_ms} ms"
        );
        assert!(
            !self.has_pending_deliveries(),
            "cannot change downlink delay while frames are in flight"
        );
        self.downlink_delay_ms = delay_ms;
    }

    /// Frames dropped by the loss model so far.
    pub(crate) fn dropped_count(&self) -> usize {
        self.dropped
    }

    /// Which frame indices the loss model dropped, in order.
    pub(crate) fn drop_log(&self) -> &[u64] {
        &self.drop_log
    }

    fn drops_next_frame(&mut self, metadata: &SimDatagramMetadata) -> bool {
        let index = self.loss_index;
        self.loss_index = self.loss_index.wrapping_add(1);
        self.drop_indices.binary_search(&index).is_ok()
            || frame_is_dropped(self.loss_seed, metadata, self.loss_pct)
    }

    /// Peers the last flush served a datagram delta, in id order.
    ///
    /// Datagram work only. A peer served a snapshot instead is absent from this
    /// list, because a snapshot is committed over the reliable lane and never
    /// advances a datagram sequence.
    pub(crate) fn delta_served_last_flush(&self) -> &[String] {
        &self.delta_served_last_flush
    }

    /// Make each flush-clock read advance simulated time by `step_ms`.
    ///
    /// Models a flush that takes time to run, deterministically: the daemon
    /// sees time passing inside one turn without any dependence on how busy the
    /// host is. Left at zero, a flush is instantaneous and a session replays
    /// exactly.
    pub(crate) fn set_clock_step_ms(&mut self, step_ms: f64) {
        assert!(step_ms >= 0.0, "simulated time never runs backwards");
        self.clock_step_ms = step_ms;
    }

    /// Reliable-lane frames admitted so far, cumulative.
    pub(crate) fn reliable_frames(&self) -> usize {
        self.reliable.len()
    }

    /// Reliable-lane frames admitted so far, in order.
    pub(crate) fn reliable(&self) -> &[SimReliableFrame] {
        &self.reliable
    }

    pub(crate) fn dropped_wire(&self) -> &[SimDroppedFrame] {
        &self.dropped_wire
    }

    /// Announce dictionary support the way a real browser does, and
    /// acknowledge whatever the daemon installs.
    ///
    /// `apps/web/src/transport-worker.ts` sends `display_dict_ready` once the
    /// terminal epoch is ready, and ACKs each install by id. Until both happen
    /// the daemon refuses to compress against a dictionary, because a successful
    /// reliable write is not evidence the browser installed anything.
    ///
    /// The reason has since inverted and the gate has not. Under raw-content LZ4
    /// a dictionary the peer lacked decoded to plausible garbage; zstd's
    /// finalized dictionary stamps an id into every frame header, so the same
    /// divergence is a rejected frame instead. A rejected frame is still a
    /// broken screen, so the gate stays. A simulator that never announces
    /// support measures a pipeline with dictionary compression permanently
    /// disabled either way.
    pub(crate) fn enable_display_dictionary(&mut self) {
        for peer in self.peers.values_mut() {
            peer.display_dictionary_ready = true;
        }
    }

    /// Acknowledge the exact dictionary a viewer installed.
    ///
    /// This is what a browser does: it acknowledges the dictionary it just
    /// stored, by id. Acknowledging whatever happens to be pending — which is
    /// what [`Self::acknowledge_pending_dictionaries`] does — lets the daemon
    /// compress against a dictionary no viewer holds.
    pub(crate) fn acknowledge_dictionary(&mut self, peer_id: &str, id: u32) -> bool {
        self.peers
            .get_mut(peer_id)
            .is_some_and(|peer| peer.dictionary.acknowledge(id))
    }

    pub(crate) fn active_dictionary_id(&self, peer_id: &str) -> Option<u32> {
        self.peers
            .get(peer_id)
            .and_then(|peer| peer.dictionary.active())
            .map(|dictionary| dictionary.id)
    }

    /// Run the heartbeat, which is what emits the display hash digest.
    ///
    /// Production reaches `send_heartbeat_if_due` from two places, and the two
    /// serve different arms of its own due-check: the tail of `flush_display`
    /// covers the frame-interval arm while output is flowing, and
    /// `heartbeat_tick` covers the time-interval arm when no flush is running —
    /// which is the only one left once a quiet, fully acknowledged peer drops
    /// out of both display-scheduling predicates and the owner loop parks.
    ///
    /// This drives the narrower function directly rather than `heartbeat_tick`,
    /// because the tick also owns path liveness and eviction and this harness
    /// has no carriers for those. `session::liveness`'s own test covers the tick
    /// call itself, so removing it does not pass unnoticed.
    pub(crate) async fn tick_heartbeat(&mut self) {
        let mut hashes = Vec::new();
        self.terminal.current_row_hashes_into(&mut hashes);
        let peer_ids: Vec<Arc<str>> = self.peers.keys().cloned().collect();
        for peer_id in peer_ids {
            crate::session::liveness::send_heartbeat_if_due(
                &mut self.peers,
                &peer_id,
                &hashes,
                self.now_ms,
            )
            .await;
        }
        // Drain what the digest just wrote. Without this its output stays in
        // the channel until some later `flush` happens to drain it, which makes
        // the digest's arrival depend on flush timing — the exact coupling this
        // method exists to break.
        while let Ok((channel_id, peer_id, bytes)) = self.reliable_rx.try_recv() {
            self.reliable.push(SimReliableFrame {
                deliver_at_ms: self.now_ms + self.downlink_delay_ms,
                len: bytes.len(),
                channel_id,
                peer_id,
                bytes,
            });
        }
        while self
            .reliable
            .get(self.reliable_delivery_cursor)
            .is_some_and(|frame| frame.deliver_at_ms <= self.now_ms)
        {
            self.reliable_delivery_cursor += 1;
        }
    }

    /// Deliver a client resync request, as the CTRL path would.
    ///
    /// The hash-digest backstop is the daemon's last loss signal: the browser
    /// compares the digest against its own row hashes and names the rows that
    /// disagree, and the daemon disowns them so the next flush re-sends them
    /// complete. A harness without this models a pipeline whose only recovery is
    /// FEC and idempotent re-selection, which is why it could not distinguish a
    /// correct acknowledgement from one that claims rows the viewer never got.
    pub(crate) fn deliver_resync(&mut self, peer_id: &str, generation: u32, rows: &[u16]) {
        if rows.is_empty() {
            return;
        }
        let mut body = Vec::with_capacity(6 + rows.len() * 2);
        body.extend_from_slice(&generation.to_be_bytes());
        body.extend_from_slice(&(rows.len() as u16).to_be_bytes());
        for row in rows {
            body.extend_from_slice(&row.to_be_bytes());
        }
        let msg = crate::network::peer::PeerMessage {
            input_permit: None,
            peer_node_id: std::sync::Arc::from(peer_id),
            channel_id: crate::network::protocol::CHANNEL_CTRL,
            payload: bytes::Bytes::from(body.clone()),
            via_transport: PeerTransport::WebTransport,
            delivery: crate::network::peer::DeliveryMode::Datagram,
            connection_id: 0,
            edge_ingress: None,
        };
        let mut hashes = Vec::new();
        self.terminal.current_row_hashes_into(&mut hashes);
        crate::display::recv::handle_display_resync_rows(&msg, &body, &mut self.peers, &hashes);
        // The peer-message arm: a disowned row is a reason to emit.
        self.arm_flush_earlier_only();
    }

    /// Deliver a display ACK from a viewer, exactly as the control path would.
    ///
    /// Closing this loop is what makes the harness resemble a live session: an
    /// acknowledged row retires from the dirty set, so the next flush's row
    /// budget selects further down the screen instead of re-sending the same
    /// prefix forever. Viewers do not call this directly: they queue the ACK
    /// with their modelled delay (`enqueue_ack`) and it is delivered here at
    /// its release instant, then the peer-message arm re-arms the flush timer
    /// earlier-only, as `main.rs` does after every inbound frame.
    pub(crate) fn deliver_ack(
        &mut self,
        peer_id: &str,
        generation: u32,
        largest_seq: u32,
        received_mask: [u32; DISPLAY_ACK_MASK_WORDS],
        recovered_mask: [u32; DISPLAY_ACK_MASK_WORDS],
    ) {
        let now_ms = self.now_ms;
        let grant = self.viewer_grants.get(peer_id).copied().unwrap_or(0);
        if let Some(peer) = self.peers.get_mut(peer_id) {
            let body = crate::display::recv::encode_display_ack(
                generation,
                largest_seq,
                received_mask,
                recovered_mask,
                grant,
            );
            if let Some(ack) = crate::display::recv::parse_display_ack(&body) {
                // The baseline the owner loop passes: the flush-time hash
                // vector `DisplayScratch` keeps, not a fresh walk of the grid.
                crate::display::recv::handle_display_ack(
                    peer,
                    ack,
                    now_ms,
                    PeerTransport::WebTransport,
                    &self.scratch.current_row_hashes,
                    self.terminal.has_dirty(),
                );
            }
        }
        self.arm_flush_earlier_only();
    }

    /// Queue a viewer's acknowledgement for delivery `delay_ms` from now.
    pub(crate) fn enqueue_ack(
        &mut self,
        peer_id: &str,
        generation: u32,
        largest_seq: u32,
        received_mask: [u32; DISPLAY_ACK_MASK_WORDS],
        recovered_mask: [u32; DISPLAY_ACK_MASK_WORDS],
        delay_ms: f64,
    ) {
        debug_assert!(
            delay_ms > 0.0 && delay_ms.is_finite(),
            "an acknowledgement takes time to come back"
        );
        if self.ack_drop_budget > 0 {
            self.ack_drop_budget -= 1;
            self.dropped_acks += 1;
            return;
        }
        let release_at_ms = self.now_ms + delay_ms;
        // After every ACK due at the same instant, so ties release in the
        // order they were sent.
        let at = self
            .pending_acks
            .partition_point(|ack| ack.release_at_ms <= release_at_ms);
        self.pending_acks.insert(
            at,
            PendingAck {
                release_at_ms,
                peer_id: peer_id.to_owned(),
                generation,
                largest_seq,
                received_mask,
                recovered_mask,
                grant: None,
            },
        );
    }

    /// Queue a viewer's display grant for delivery `delay_ms` from now, on a
    /// generation-only acknowledgement as the browser posts it. Grant loss is
    /// the same deterministic ACK loss (`drop_next_acks`).
    pub(crate) fn enqueue_grant(
        &mut self,
        peer_id: &str,
        generation: u32,
        grant: u32,
        delay_ms: f64,
    ) {
        debug_assert!(
            delay_ms > 0.0 && delay_ms.is_finite(),
            "a grant takes time to arrive"
        );
        if self.ack_drop_budget > 0 {
            self.ack_drop_budget -= 1;
            self.dropped_acks += 1;
            return;
        }
        let release_at_ms = self.now_ms + delay_ms;
        let at = self
            .pending_acks
            .partition_point(|ack| ack.release_at_ms <= release_at_ms);
        self.pending_acks.insert(
            at,
            PendingAck {
                release_at_ms,
                peer_id: peer_id.to_owned(),
                generation,
                largest_seq: 0,
                received_mask: [0; DISPLAY_ACK_MASK_WORDS],
                recovered_mask: [0; DISPLAY_ACK_MASK_WORDS],
                grant: Some(grant),
            },
        );
    }

    /// The daemon's grant accounting for one peer: `(granted, consumed)`.
    pub(crate) fn peer_credit(&self, peer_id: &str) -> (u32, u32) {
        let credit = &self.peers[peer_id].display_credit;
        (credit.granted(), credit.consumed())
    }

    /// Whether any acknowledgement is still on its way back.
    pub(crate) fn has_pending_acks(&self) -> bool {
        !self.pending_acks.is_empty()
    }

    pub(crate) fn has_pending_deliveries(&self) -> bool {
        self.delivery_cursor < self.wire.len()
            || self.reliable_delivery_cursor < self.reliable.len()
    }

    /// Drop the next `count` acknowledgements before they enter the return
    /// queue. Frame loss and ACK loss use separate deterministic controls so a
    /// quiet-tail test can name exactly which signal went missing.
    pub(crate) fn drop_next_acks(&mut self, count: usize) {
        self.ack_drop_budget = self.ack_drop_budget.saturating_add(count);
    }

    pub(crate) fn dropped_ack_count(&self) -> usize {
        self.dropped_acks
    }

    fn enqueue_pty_write(&mut self, delay_ms: f64, write: PendingPtyWrite) {
        assert!(
            delay_ms >= 0.0 && delay_ms.is_finite(),
            "a scheduled PTY delay must be finite and non-negative"
        );
        let release_at_ms = self.now_ms + delay_ms;
        let at = self
            .pending_pty_writes
            .partition_point(|pending| pending.release_at_ms <= release_at_ms);
        self.pending_pty_writes.insert(
            at,
            PendingPtyWrite {
                release_at_ms,
                ..write
            },
        );
    }

    /// Schedule a browser key origin, its uplink flight, and the daemon's PTY
    /// echo as three distinct events. Buffers are owned before the run begins,
    /// so the measurement loop allocates nothing to inject sustained typing.
    pub(crate) fn schedule_input_echo(
        &mut self,
        origin_delay_ms: f64,
        uplink_delay_ms: f64,
        peer_id: &str,
        input_seq: u32,
        input_bytes: Vec<u8>,
        echo_bytes: Vec<u8>,
    ) {
        assert!(
            origin_delay_ms >= 0.0 && origin_delay_ms.is_finite(),
            "a key-origin delay must be finite and non-negative"
        );
        assert!(
            uplink_delay_ms >= 0.0 && uplink_delay_ms.is_finite(),
            "an uplink delay must be finite and non-negative"
        );
        let release_at_ms = self.now_ms + origin_delay_ms;
        let at = self
            .pending_browser_keys
            .partition_point(|key| key.release_at_ms <= release_at_ms);
        self.pending_browser_keys.insert(
            at,
            PendingBrowserKey {
                release_at_ms,
                uplink_delay_ms,
                peer_id: peer_id.to_owned(),
                input_seq,
                input_bytes,
                echo_bytes,
            },
        );
    }

    /// Model the prepare worker taking `ms` per flush: output scheduled inside
    /// that window lands while the capture is being encoded, so the completion
    /// sees the terminal advance past it and keeps the presentation open, as
    /// every real flood does. Zero, the default, finishes a prepare at the
    /// instant it was submitted.
    pub(crate) fn set_prepare_time_ms(&mut self, ms: f64) {
        assert!(ms >= 0.0 && ms.is_finite(), "a prepare time is finite and non-negative");
        self.prepare_time_ms = ms;
    }

    /// Schedule command output unrelated to a browser input sequence.
    pub(crate) fn schedule_pty_write(&mut self, delay_ms: f64, bytes: Vec<u8>) {
        self.enqueue_pty_write(
            delay_ms,
            PendingPtyWrite {
                release_at_ms: 0.0,
                bytes,
            },
        );
    }

    pub(crate) fn has_pending_pty_writes(&self) -> bool {
        !self.pending_browser_keys.is_empty()
            || !self.pending_daemon_inputs.is_empty()
            || !self.pending_pty_writes.is_empty()
    }

    /// A keystroke admitted for `peer_id` that changes nothing visible.
    ///
    /// The input path stamps `last_input_at_ms` and advances
    /// `latest_input_seq` with no PTY output to follow, so the only thing left
    /// to carry is the header-only advertisement that releases the browser's
    /// prediction barrier. Arms the flush timer as the input arm does.
    pub(crate) fn note_keystroke(&mut self, peer_id: &str, seq: u32) {
        let now_ms = self.now_ms;
        let peer = self.peers.get_mut(peer_id).expect("peer exists");
        peer.last_input_at_ms = now_ms;
        peer.latest_input_seq = seq;
        peer.latest_input_display_revision = self.terminal.display_revision();
        self.arm_flush_earlier_only();
    }

    /// Simulate an exact direct-carrier replacement after its old supervisor
    /// has stopped producing lifecycle events. Production retires the old
    /// carrier's display provenance, installs the replacement, then re-runs the
    /// earlier-only flush scheduler in the owner loop.
    pub(crate) fn replace_direct_carrier(&mut self, peer_id: &str) {
        let peer = self.peers.get_mut(peer_id).expect("peer exists");
        peer.retire_display_attempts(PeerTransport::WebTransport);
        peer.paths.webtransport = crate::connection::PathHealth::fresh_available(self.now_ms);
        self.arm_flush_earlier_only();
    }

    /// `main.rs`'s input arm, followed by its PTY-write-completion arm.
    ///
    /// Production separates them by a real write to a real PTY: the terminal
    /// observes the keystroke as it is enqueued (which is where an unmodelled
    /// one withdraws the prediction grant) and the peer's watermark advances
    /// when the write completes. There is no kernel between them here, so they
    /// run back to back — the ordering production guarantees, with the delay
    /// removed.
    ///
    /// `shadow_modelled` is the browser's own claim that this keystroke is
    /// already in its speculative model. A false claim is what
    /// `observe_user_input` reads as unmodelled input.
    pub(crate) fn write_input(
        &mut self,
        peer_id: &str,
        seq: u32,
        bytes: &[u8],
        shadow_modelled: bool,
    ) {
        self.terminal.observe_user_input(
            shadow_modelled,
            TerminalState::bytes_leave_line_editor(bytes),
        );
        let now_ms = self.now_ms;
        let peer = self.peers.get_mut(peer_id).expect("peer exists");
        peer.last_input_at_ms = now_ms;
        peer.latest_input_seq = seq;
        peer.latest_input_display_revision = self.terminal.display_revision();
        self.arm_flush_earlier_only();
    }

    /// `main.rs`'s coalesced `prediction_safety_sample_pending` arm.
    ///
    /// Production samples the kernel there — the PTY's termios `ECHO` bit and
    /// the foreground process group — and combines it with the shell-integration
    /// boundary. There is no kernel here, so `kernel_grants` stands in for that
    /// half; the boundary half is the real one, read from the real parser, and
    /// it is the half a keystroke or a `133;C` revokes.
    pub(crate) fn sample_prediction_safety(&mut self, kernel_grants: bool) {
        let granted = kernel_grants && self.terminal.shell_integration_input_active();
        self.terminal.set_prediction_safe(granted);
        self.arm_flush_earlier_only();
    }

    /// The prompt anchor the daemon currently holds, if any.
    pub(crate) fn editor_anchor(&self) -> Option<(u16, u16)> {
        self.terminal.editor_anchor()
    }

    /// Whether the daemon currently grants speculative echo.
    pub(crate) fn prediction_safe(&self) -> bool {
        self.terminal.prediction_safe()
    }

    /// The daemon's own cursor, for comparison against what the browser draws.
    pub(crate) fn cursor_position(&self) -> Option<(usize, usize)> {
        self.terminal.current_cursor_position()
    }

    /// The re-send interval the next flush would stamp on this peer's rows.
    pub(crate) fn peer_row_resend_interval_ms(&self, peer_id: &str) -> f64 {
        peer_row_resend_interval_ms(self.peers.get(peer_id).expect("peer exists"), self.now_ms)
    }

    /// The physical floor under that interval: the primary path's heartbeat
    /// round trip plus twice its jitter. A datagram cannot be confirmed
    /// sooner, so this is what paces a peer before its first display ACK.
    pub(crate) fn peer_round_trip_floor_ms(&self, peer_id: &str) -> f64 {
        let peer = self.peers.get(peer_id).expect("peer exists");
        let path = peer.paths.get(peer.primary_path(self.now_ms));
        path.network_rtt_ewma_ms + 2.0 * path.network_jitter_ewma_ms
    }

    /// The peer's measured confirmation delay, as `recv.rs` has folded it in.
    pub(crate) fn display_confirm_ewma_ms(&self, peer_id: &str) -> f64 {
        self.peers
            .get(peer_id)
            .expect("peer exists")
            .display_confirm
            .ewma_ms
    }

    /// Put every peer's estimator in its stationary post-learning state.
    /// Cold-start learning is exercised separately; measured profiles should
    /// not charge their first key for setup traffic.
    pub(crate) fn warm_confirmation_estimator(&mut self, delay_ms: f64) {
        assert!(delay_ms > 0.0 && delay_ms.is_finite());
        for peer in self.peers.values_mut() {
            peer.display_confirm.record(delay_ms);
        }
    }

    /// Put one simulated carrier into the loss-proven k=1 policy state.
    ///
    /// This is a harness setup seam, not an alternate production policy: it
    /// feeds the same final selective-ACK outcome that promotes a live path.
    /// Tests that isolate exact replay mechanics use it so their first scalar
    /// frame does not have to manufacture and wait for an unrelated loss.
    pub(crate) fn promote_k1_replication(&mut self, peer_id: &str, path: PeerTransport) {
        self.peers
            .get_mut(peer_id)
            .expect("simulated peer exists")
            .display_cache
            .fec_evidence
            .get_mut(path)
            .observe(
                DisplayDatagramProtection::Unprotected,
                DisplayDatagramOutcome::Lost,
            );
    }

    pub(crate) fn k1_replication_enabled(&self, peer_id: &str, path: PeerTransport) -> bool {
        self.peers
            .get(peer_id)
            .expect("simulated peer exists")
            .display_cache
            .fec_evidence
            .get(path)
            .replication_enabled()
    }

    /// This peer's lifetime waste counters, as the send path has recorded them.
    ///
    /// `row_resends_identical` in particular had no harness reader at all, which
    /// is half of why the duplicate regime went unmeasured; the other half is
    /// that the default viewer confirms below the re-send floor, so the regime
    /// was unreachable. Both halves are addressed together.
    pub(crate) fn peer_waste(&self, peer_id: &str) -> crate::connection::DisplayWasteCounters {
        self.peers
            .get(peer_id)
            .expect("peer exists")
            .display_cache
            .waste
    }

    /// The daemon's authoritative row hashes — the other half of the
    /// convergence oracle. Same `merkur_codec::row_hash` the viewer uses.
    pub(crate) fn terminal_row_hashes(&mut self, out: &mut Vec<u64>) {
        self.terminal.current_row_hashes_into(out);
    }

    /// Take a viewer's browser-side Noise transport out of the session.
    pub(crate) fn take_browser(&mut self, peer_id: &str) -> Option<crate::e2e::NoiseTransport> {
        self.browsers.remove(peer_id)
    }

    /// Whether this peer is still waiting for a full snapshot.
    pub(crate) fn snapshot_pending(&self, peer_id: &str) -> bool {
        self.peers.get(peer_id).expect("peer exists").needs_snapshot
    }

    /// How many viewers this session has.
    pub(crate) fn peer_count(&self) -> usize {
        self.peers.len()
    }

    /// Whether this peer still holds a row the viewer has not confirmed.
    ///
    /// What separates "quiet" from "parked": an unconfirmed row keeps its
    /// re-send deadline armed, so `compute_next_flush_delay_ms` still answers
    /// for a peer holding one, while a peer without has nothing left to wake
    /// it.
    pub(crate) fn peer_has_unacked_rows(&self, peer_id: &str) -> bool {
        let cache = &self.peers.get(peer_id).expect("peer exists").display_cache;
        cache
            .sent_row_confirmed
            .iter()
            .zip(&cache.sent_row_latest_seq)
            .any(|(confirmed, seq)| *seq != 0 && !*confirmed)
    }

    /// Mark a peer as needing a full snapshot on the next flush.
    ///
    /// A snapshot is the other trigger for `display_owner_should_defer`: once a
    /// flush has offered one, every remaining peer is put back regardless of
    /// how much time the turn has spent. Arms the flush timer the way the
    /// request's own arrival would.
    pub(crate) fn request_snapshot(&mut self, peer_id: &str) {
        let peer = self.peers.get_mut(peer_id).expect("peer exists");
        peer.needs_snapshot = true;
        self.arm_flush_earlier_only();
    }

    /// Deliver a client snapshot request, as the CTRL path would.
    ///
    /// [`Self::request_snapshot`] pokes `needs_snapshot` directly, which is
    /// convenient but models a daemon-side arming site rather than the wire.
    /// The browser's request arrives as `MSG_TYPE_DISPLAY_SNAPSHOT_REQUEST` and
    /// is answered by `handle_display_snapshot_request`, which does more than
    /// set the flag — routing through it is what lets a test observe the
    /// difference.
    pub(crate) fn deliver_snapshot_request(&mut self, peer_id: &str) {
        let msg = crate::network::peer::PeerMessage {
            input_permit: None,
            peer_node_id: std::sync::Arc::from(peer_id),
            channel_id: crate::network::protocol::CHANNEL_CTRL,
            payload: bytes::Bytes::new(),
            via_transport: PeerTransport::WebTransport,
            delivery: crate::network::peer::DeliveryMode::Datagram,
            connection_id: 0,
            edge_ingress: None,
        };
        crate::session::resume::handle_display_snapshot_request(&msg, &mut self.peers);
        self.arm_flush_earlier_only();
    }

    /// Deliver a same-generation, same-dimensions resume without a row-hash
    /// claim, after putting the peer behind the exact resume gate installed by
    /// authentication/rebind.
    ///
    /// Matching cache coordinates are deliberately retained here: the point
    /// of this production-path helper is to prove they cannot substitute for a
    /// browser claim that its grid survived. A claimless browser has reset its
    /// terminal and therefore needs the reliable snapshot even when the
    /// daemon's cache is initialized and numerically matches.
    pub(crate) fn deliver_claimless_resume(&mut self, peer_id: &str) {
        let (generation, cols, rows) = {
            let peer = self.peers.get_mut(peer_id).expect("peer exists");
            peer.awaiting_resume_until_ms = Some(self.now_ms + 1_000.0);
            peer.needs_snapshot = false;
            (
                peer.generation,
                peer.display_cache.cols,
                peer.display_cache.rows,
            )
        };
        let mut body = Vec::with_capacity(16);
        body.extend_from_slice(&generation.to_be_bytes());
        body.extend_from_slice(&0u32.to_be_bytes());
        body.extend_from_slice(&1u32.to_be_bytes());
        body.extend_from_slice(&cols.to_be_bytes());
        body.extend_from_slice(&rows.to_be_bytes());
        let msg = crate::network::peer::PeerMessage {
            input_permit: None,
            peer_node_id: std::sync::Arc::from(peer_id),
            channel_id: crate::network::protocol::CHANNEL_CTRL,
            payload: bytes::Bytes::from(body.clone()),
            via_transport: PeerTransport::WebTransport,
            delivery: crate::network::peer::DeliveryMode::Stream,
            connection_id: 0,
            edge_ingress: None,
        };
        crate::session::resume::handle_display_resume(
            &msg,
            &body,
            &mut self.peers,
            &self.scratch.current_row_hashes,
            &self.scratch.flush_row_capture,
        );
        self.arm_flush_earlier_only();
    }

    /// Configure a follow-along viewer: a given primary-path RTT, no recent
    /// input, and optionally the transport hint a real browser publishes.
    ///
    /// The hint is fed through the real `apply_transport_hint`, so it is
    /// clamped exactly as a peer's own hint would be.
    pub(crate) fn configure_passive_viewer(
        &mut self,
        peer_id: &str,
        network_rtt_ms: f64,
        hinted: bool,
    ) {
        let now_ms = self.now_ms;
        let peer = self.peers.get_mut(peer_id).expect("peer exists");
        peer.paths
            .get_mut(crate::connection::PeerTransport::Edge)
            .network_rtt_ewma_ms = network_rtt_ms;
        peer.paths
            .get_mut(crate::connection::PeerTransport::WebTransport)
            .network_rtt_ewma_ms = network_rtt_ms;
        // Far enough back that `is_recently_interactive` is false.
        peer.last_input_at_ms = now_ms - 10_000.0;
        if hinted {
            peer.apply_transport_hint(crate::connection::TransportHint {
                profile: 0,
                chunk_bytes: 16 * 1024,
                snapshot_bytes: 64 * 1024,
                receive_queue_datagrams: 256,
                presentation_period_ms: 1_000.0 / 120.0,
            });
        }
    }

    /// Leave a peer exactly as a failed snapshot send leaves it: the retry
    /// parked in the future, with the failure count that produced that delay.
    pub(crate) fn arm_snapshot_backoff(&mut self, peer_id: &str, retry_at_ms: f64, failures: u32) {
        let peer = self.peers.get_mut(peer_id).expect("peer exists");
        peer.snapshot_retry_at_ms = retry_at_ms;
        peer.snapshot_consecutive_failures = failures;
    }

    /// Frames admitted to the simulated transport, in order.
    pub(crate) fn wire(&self) -> &[SimWireFrame] {
        &self.wire
    }

    /// Total bytes the session put on the wire.
    pub(crate) fn wire_bytes(&self) -> usize {
        self.wire.iter().map(|frame| frame.len).sum()
    }

    /// Step until a flush builds a frame, returning the virtual milliseconds it
    /// took. `None` if `max_steps` passed without one.
    pub(crate) async fn step_until_emit(&mut self, max_steps: usize) -> Option<f64> {
        let started = self.now_ms;
        let baseline = self.wire.len();
        for _ in 0..max_steps {
            if self.step().await.is_none() {
                break;
            }
            if self.wire.len() > baseline {
                return Some(self.now_ms - started);
            }
        }
        None
    }

    /// Fill every row with distinct content, so the flush has whole-screen
    /// damage rather than a single-row delta.
    pub(crate) fn write_full_screen(&mut self, seed: u8) {
        let cols = self.terminal.cols as usize;
        let rows = self.terminal.rows;
        let mut out = Vec::with_capacity(rows as usize * (cols + 8));
        for row in 0..rows {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            let ch = b'a' + ((seed as u16 + row) % 26) as u8;
            out.extend(std::iter::repeat_n(ch, cols));
        }
        self.write_pty(&out);
    }

    /// Fill the screen with realistic terminal output: source-code-shaped lines
    /// with indentation, repeated tokens and trailing blank space.
    ///
    /// [`write_noisy_screen`](Self::write_noisy_screen) is deliberate worst case
    /// — uniform random printable bytes, which neither run-length encoding nor
    /// LZ4 can shrink. Real output is nothing like that, and sizing a decision
    /// on the worst case would overstate how much a repaint actually costs.
    pub(crate) fn write_code_screen(&mut self, seed: u64) {
        const LINES: [&str; 8] = [
            "    let mut buffer = Vec::with_capacity(capacity);",
            "    for (index, entry) in entries.iter().enumerate() {",
            "        if entry.is_empty() { continue; }",
            "        buffer.extend_from_slice(entry.as_bytes());",
            "    }",
            "",
            "pub fn resolve(&self, name: &str) -> Option<&Entry> {",
            "        self.entries.get(name).filter(|e| e.enabled)",
        ];
        let cols = self.terminal.cols as usize;
        let rows = self.terminal.rows;
        let mut out = Vec::with_capacity(rows as usize * (cols + 8));
        for row in 0..rows {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            let line = LINES[(usize::from(row) + seed as usize) % LINES.len()];
            let mut text = line.as_bytes().to_vec();
            text.truncate(cols);
            out.extend_from_slice(&text);
            // Clear to end of line so the row's tail is blank, as a real
            // repaint leaves it.
            out.extend_from_slice(b"\x1b[K");
        }
        self.write_pty(&out);
    }

    /// Realistic *coloured* output: syntax-highlighted code or `ls --color`,
    /// where many cells carry their own foreground colour.
    ///
    /// This is the case that matters for sizing. Plain text run-length encodes
    /// almost to nothing, and uniform random bytes compress not at all; real
    /// terminal use sits between them, and a colour change every few cells is
    /// what actually defeats run-length encoding in practice.
    pub(crate) fn write_colored_screen(&mut self, seed: u64) {
        const PALETTE: [u8; 6] = [31, 32, 33, 34, 35, 36];
        const WORDS: [&str; 9] = [
            "pub", "fn", "resolve", "entries", "Option", "self", "filter", "enabled", "buffer",
        ];
        let cols = self.terminal.cols as usize;
        let rows = self.terminal.rows;
        let mut out = Vec::with_capacity(rows as usize * (cols * 6));
        let mut state = seed | 1;
        for row in 0..rows {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            let mut used = 0usize;
            while used + 8 < cols {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let pick = (state >> 33) as usize;
                let word = WORDS[pick % WORDS.len()];
                let color = PALETTE[(pick / WORDS.len()) % PALETTE.len()];
                out.extend_from_slice(format!("\x1b[{color}m{word} ").as_bytes());
                used += word.len() + 1;
            }
            out.extend_from_slice(b"\x1b[0m\x1b[K");
        }
        self.write_pty(&out);
    }

    /// Scroll the screen up by `lines`, feeding a fresh coloured line in at the
    /// bottom each time.
    ///
    /// Retained content moves between rows, exercising literal compression
    /// without introducing dependencies on mutable receiver source rows.
    pub(crate) fn scroll_colored_lines(&mut self, seed: u64, lines: u16) {
        const PALETTE: [u8; 6] = [31, 32, 33, 34, 35, 36];
        const WORDS: [&str; 9] = [
            "pub", "fn", "resolve", "entries", "Option", "self", "filter", "enabled", "buffer",
        ];
        let cols = self.terminal.cols as usize;
        let rows = self.terminal.rows;
        let mut out = Vec::with_capacity(usize::from(lines) * cols * 6);
        let mut state = seed | 1;
        // Park on the last row: a newline there scrolls the grid by one.
        out.extend_from_slice(format!("\x1b[{rows};1H").as_bytes());
        for _ in 0..lines {
            out.extend_from_slice(b"\n\r");
            let mut used = 0usize;
            while used + 8 < cols {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let pick = (state >> 33) as usize;
                let word = WORDS[pick % WORDS.len()];
                let color = PALETTE[(pick / WORDS.len()) % PALETTE.len()];
                out.extend_from_slice(format!("\x1b[{color}m{word} ").as_bytes());
                used += word.len() + 1;
            }
            out.extend_from_slice(b"\x1b[0m\x1b[K");
        }
        self.write_pty(&out);
    }

    /// Scroll the screen *down* by `lines`, feeding a fresh coloured line in at
    /// the top each time.
    ///
    /// The mirror of [`scroll_colored_lines`](Self::scroll_colored_lines),
    /// exercising the opposite terminal mutation direction.
    pub(crate) fn reverse_scroll_colored_lines(&mut self, seed: u64, lines: u16) {
        const PALETTE: [u8; 6] = [31, 32, 33, 34, 35, 36];
        const WORDS: [&str; 9] = [
            "pub", "fn", "resolve", "entries", "Option", "self", "filter", "enabled", "buffer",
        ];
        let cols = self.terminal.cols as usize;
        let mut out = Vec::with_capacity(usize::from(lines) * cols * 6);
        let mut state = seed | 1;
        for _ in 0..lines {
            // Home, then reverse index: the grid shifts down and row 0 clears.
            out.extend_from_slice(b"\x1b[1;1H\x1bM");
            let mut used = 0usize;
            while used + 8 < cols {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let pick = (state >> 33) as usize;
                let word = WORDS[pick % WORDS.len()];
                let color = PALETTE[(pick / WORDS.len()) % PALETTE.len()];
                out.extend_from_slice(format!("\x1b[{color}m{word} ").as_bytes());
                used += word.len() + 1;
            }
            out.extend_from_slice(b"\x1b[0m\x1b[K");
        }
        self.write_pty(&out);
    }

    /// Fill every cell with high-entropy content.
    ///
    /// [`write_full_screen`](Self::write_full_screen) repeats one letter per
    /// row, which the encoder's run-length representation collapses to
    /// almost nothing — a whole 200x50 screen fits in one datagram. Real
    /// terminal output does not compress like that, and a frame only chunks
    /// once it exceeds the datagram payload cap, so a harness that wants to
    /// exercise chunking has to produce content that actually occupies bytes.
    pub(crate) fn write_noisy_screen(&mut self, seed: u64) {
        let cols = self.terminal.cols as usize;
        let rows = self.terminal.rows;
        let mut out = Vec::with_capacity(rows as usize * (cols + 8));
        let mut state = seed | 1;
        for row in 0..rows {
            out.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            for _ in 0..cols {
                // splitmix64, so the content is deterministic per seed.
                state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = state;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^= z >> 31;
                out.push(b'!' + (z % 90) as u8);
            }
        }
        self.write_pty(&out);
    }

    fn has_prepare_in_flight(&self) -> bool {
        self.peers
            .values()
            .any(|peer| peer.display_prepare_in_flight.is_some())
    }

    /// Why the flush would skip this peer, if it would. Diagnostic.
    pub(crate) fn delta_gate(&self) -> String {
        let peer = self.peers.get(SIM_PEER_ID).expect("sim peer");
        format!(
            "auth={} e2e={} resume={} needs_snapshot={} cache_init={} cache_dims={}x{} term_dims={}x{} needs_full_diff={} net_rtt={} now={}",
            peer.authenticated,
            peer.is_e2e_ready(),
            peer.awaiting_resume_until_ms.is_none(),
            peer.needs_snapshot,
            peer.display_cache.initialized,
            peer.display_cache.cols,
            peer.display_cache.rows,
            self.terminal.cols,
            self.terminal.rows,
            peer.needs_full_diff,
            peer.paths.get(peer.primary_path(self.now_ms)).network_rtt_ewma_ms,
            self.now_ms
        )
    }

    /// True while the terminal still holds damage no flush has emitted.
    pub(crate) fn has_dirty(&self) -> bool {
        self.terminal.has_dirty()
    }

    /// Virtual time now, in milliseconds since the simulated start.
    pub(crate) fn now_ms(&self) -> f64 {
        self.now_ms
    }

    pub(crate) fn flushes(&self) -> &[SimFlush] {
        &self.flushes
    }

    /// Write PTY bytes into the terminal at the current virtual time.
    ///
    /// This is the simulated equivalent of the PTY reader delivering output: it
    /// marks the terminal dirty exactly as production does, then arms the
    /// flush timer earlier-only as the PTY-read arm does.
    pub(crate) fn write_pty(&mut self, bytes: &[u8]) {
        self.terminal.apply_bytes(bytes);
        crate::display::send::note_display_output(&mut self.peers, self.now_ms);
        self.arm_flush_earlier_only();
    }

    /// Model output still queued behind the batch just applied.
    ///
    /// In production this is `pty_async_rx.is_empty()` — the flush policy uses
    /// it to tell "the user typed and the shell echoed one chunk" (flush now;
    /// waiting coalesces with nothing) from "a command is pouring output"
    /// (coalesce). The harness applies bytes synchronously, so its natural state
    /// is drained; a test that means to exercise the coalescing regime has to
    /// say so, and saying so is the point.
    #[cfg(test)]
    pub(crate) fn set_pty_output_pending(&mut self, pending: bool) {
        self.pty_output_pending = pending;
    }

    /// Reflow the daemon's grid to new dimensions.
    ///
    /// Only the terminal — peer caches, snapshot scheduling and the resize
    /// handshake are untouched. The oracle this exists for compares the
    /// daemon's reflowed grid against a viewer that reflowed on its own, before
    /// either end has sent anything, so driving the send path would answer a
    /// different question.
    #[cfg(test)]
    pub(crate) fn resize_terminal(&mut self, cols: u16, rows: u16) {
        self.terminal.resize(cols, rows);
    }

    /// Run graphics jobs on the helper `bun run build:image-worker` builds,
    /// under this session's own resource ceilings. Call before any graphics
    /// command.
    pub(crate) fn use_built_image_worker(&mut self) {
        self.terminal.use_built_image_worker();
    }

    /// Commit a viewport the PTY accepted, through the step `main.rs` takes
    /// after a successful resize ioctl, then arm the flush as the control arm
    /// does. Unlike [`Self::resize_terminal`], every viewer is owed the
    /// geometry snapshot.
    pub(crate) fn commit_viewport(&mut self, viewport: crate::pty::Viewport) {
        crate::commit_viewport(&mut self.terminal, &mut self.peers, viewport);
        self.arm_flush_earlier_only();
    }

    /// Write PTY bytes the way the owner loop resumes a read an image command
    /// paused: each helper completion, or the landing of a release the parser
    /// waits on, wakes it, and the parser continues from the first unaccepted
    /// byte. The helper and the retirement thread run in wall-clock time while
    /// the virtual clock stands still, so the whole read lands at this instant.
    pub(crate) async fn write_pty_resuming(&mut self, bytes: &[u8]) {
        let wake = self.terminal.graphics_wake();
        let mut accepted = self.terminal.apply_bytes(bytes);
        while self.terminal.graphics_pending() {
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                match self.terminal.graphics_release() {
                    Some(release) => {
                        release.wait().await;
                        self.terminal.observe_graphics_release();
                    }
                    None => wake.notified().await,
                }
            })
            .await
            .expect("the image helper completes or fails every job, and every release lands");
            accepted += self.terminal.apply_bytes(&bytes[accepted..]);
        }
        assert_eq!(accepted, bytes.len(), "a resumed read applies every byte");
        crate::display::send::note_display_output(&mut self.peers, self.now_ms);
        self.arm_flush_earlier_only();
    }

    /// Every PTY reply the terminal wrote since the last call, in order.
    pub(crate) fn take_pty_replies(&mut self) -> Vec<Vec<u8>> {
        self.terminal_events
            .try_iter()
            .filter_map(|event| match event {
                crate::pty::TerminalEvent::PtyWrite(bytes) => Some(bytes),
                _ => None,
            })
            .collect()
    }

    /// Publish a complete graphics projection, as the live projector would
    /// inside the PTY read that changed it, then arm the flush as that read's
    /// arm does.
    pub(crate) fn publish_graphics_projection(
        &mut self,
        rows: Vec<merkur_codec::PreparedGraphics>,
    ) {
        self.terminal.publish_graphics_projection(rows);
        self.arm_flush_earlier_only();
    }

    /// The daemon's projection in the form a viewer's render owner exports
    /// it: every row's descriptors in wire order, each after its row index.
    pub(crate) fn graphics_export(&self, out: &mut Vec<u8>) {
        out.clear();
        let mut fragments = Vec::new();
        let mut table = Vec::new();
        for row in 0..self.terminal.rows {
            let bytes = self.terminal.graphics_row(usize::from(row)).bytes();
            if bytes.is_empty() {
                continue;
            }
            fragments.clear();
            merkur_codec::decode_graphics(
                &mut &bytes[4..],
                bytes.len() - 4,
                self.terminal.cols,
                &mut fragments,
                &mut table,
            )
            .expect("the projection retains canonical sections");
            for fragment in &fragments {
                out.extend_from_slice(&u32::from(row).to_be_bytes());
                out.extend_from_slice(&fragment.encode());
            }
        }
    }

    /// The daemon's grid dimensions.
    /// The terminal's explicit synchronized-update completion identity.
    pub(crate) fn completed_sync_update_epoch(&self) -> u64 {
        self.terminal.completed_sync_update_epoch()
    }

    pub(crate) fn terminal_dimensions(&self) -> (u16, u16) {
        (self.terminal.cols, self.terminal.rows)
    }

    /// The display generation the daemon has reached for `peer_id`. Every
    /// generation begins with a snapshot, so its advance counts them.
    pub(crate) fn peer_generation(&self, peer_id: &str) -> u32 {
        self.peers.get(peer_id).expect("peer exists").generation
    }

    /// Retire graphics jobs and helpers, as terminal teardown does.
    pub(crate) async fn shutdown_graphics(&mut self) {
        self.terminal.shutdown_graphics().await;
    }

    /// How many of the daemon's visible rows wrap onto the next.
    #[cfg(test)]
    pub(crate) fn wrapped_row_count(&self) -> usize {
        self.terminal.wrapped_row_count()
    }

    /// Advance virtual time, delivering every acknowledgement that falls due.
    ///
    /// The flush timer is left alone: a deadline this passes over fires on the
    /// next `step`, at the clock the step finds, which is how an overdue
    /// tokio timer behaves on its next poll.
    pub(crate) fn advance_ms(&mut self, delta_ms: f64) {
        debug_assert!(delta_ms >= 0.0, "virtual time never runs backwards");
        let until_ms = self.now_ms + delta_ms;
        self.release_acks_through(until_ms);
    }

    /// The delay the production scheduler asks for right now, in milliseconds,
    /// or `None` when it would park the flush timer.
    ///
    /// This is the same call `main.rs` makes at every arming site, with the
    /// same baseline: the flush-time row hashes `DisplayScratch` keeps, not a
    /// fresh walk of the grid.
    pub(crate) fn next_flush_delay_ms(&self) -> Option<u64> {
        compute_next_flush_delay_ms(
            &self.peers,
            self.terminal.pending_display_damage(),
            self.terminal.current_display_header_signal(),
            &self.scratch.current_row_hashes,
            self.now_ms,
        )
    }

    /// The armed flush deadline, in milliseconds from now; `None` while the
    /// timer is parked. An overdue deadline reads as zero.
    pub(crate) fn flush_due_in_ms(&self) -> Option<f64> {
        self.flush_due_at_ms
            .map(|due_ms| (due_ms - self.now_ms).max(0.0))
    }

    /// Virtual time of the next network, browser, daemon-input, PTY, or timer event.
    fn next_event_at_ms(&self) -> Option<f64> {
        let ack_at_ms = self.pending_acks.first().map(|ack| ack.release_at_ms);
        let browser_at_ms = self
            .pending_browser_keys
            .first()
            .map(|key| key.release_at_ms);
        let input_at_ms = self
            .pending_daemon_inputs
            .first()
            .map(|input| input.release_at_ms);
        let pty_at_ms = self
            .pending_pty_writes
            .first()
            .map(|write| write.release_at_ms);
        let datagram_at_ms = self
            .wire
            .get(self.delivery_cursor)
            .map(|frame| frame.deliver_at_ms);
        let reliable_at_ms = self
            .reliable
            .get(self.reliable_delivery_cursor)
            .map(|frame| frame.deliver_at_ms);
        [
            ack_at_ms,
            browser_at_ms,
            input_at_ms,
            pty_at_ms,
            datagram_at_ms,
            reliable_at_ms,
            self.flush_due_at_ms,
        ]
        .into_iter()
        .flatten()
        .reduce(f64::min)
    }

    /// `main.rs`'s PTY-read, PTY-write-completion, ACK and input arms: ask the
    /// scheduler, and move the deadline earlier — never later.
    fn arm_flush_earlier_only(&mut self) {
        if let Some(delay) = self.next_flush_delay_ms() {
            let flush_at_ms = self.now_ms + delay as f64;
            if self
                .flush_due_at_ms
                .is_none_or(|due_ms| flush_at_ms < due_ms)
            {
                self.flush_due_at_ms = Some(flush_at_ms);
            }
        }
    }

    /// `main.rs`'s timer-fire arm after its flush: a cohort the flush put off
    /// is due now; otherwise the scheduler's one answer arms the timer, or
    /// parks it.
    fn rearm_flush_after_wake(&mut self) {
        let delay = if self.cursor.has_deferred_peers(
            &self.peers,
            self.terminal.current_display_header_signal(),
            &self.scratch.current_row_hashes,
            self.now_ms,
        ) {
            Some(0)
        } else {
            self.next_flush_delay_ms()
        };
        self.flush_due_at_ms = delay.map(|delay| self.now_ms + delay as f64);
    }

    /// `main.rs`'s timer-fire arm: expire resume gates, flush if anything is
    /// runnable, re-arm.
    async fn fire_flush_timer(&mut self) {
        self.flush_due_at_ms = None;
        arm_expired_resume_snapshots(&mut self.peers, self.now_ms);
        if has_runnable_display_work(
            &self.peers,
            self.terminal.has_dirty(),
            self.terminal.current_display_header_signal(),
            &self.scratch.current_row_hashes,
            self.now_ms,
        ) {
            self.flush().await;
        }
        self.rearm_flush_after_wake();
    }

    /// Deliver every acknowledgement due at or before `until_ms`, each at its
    /// own release instant so the round-trip sample `recv.rs` records is
    /// exactly the modelled delay, then land the clock on `until_ms`.
    fn release_acks_through(&mut self, until_ms: f64) {
        while self
            .pending_acks
            .first()
            .is_some_and(|ack| ack.release_at_ms <= until_ms)
        {
            let ack = self.pending_acks.remove(0);
            self.now_ms = self.now_ms.max(ack.release_at_ms);
            if let Some(grant) = ack.grant {
                let delivered = self.viewer_grants.entry(ack.peer_id.clone()).or_insert(0);
                if grant.wrapping_sub(*delivered) < 0x8000_0000 {
                    *delivered = grant;
                }
            }
            self.deliver_ack(
                &ack.peer_id,
                ack.generation,
                ack.largest_seq,
                ack.received_mask,
                ack.recovered_mask,
            );
        }
        self.now_ms = self.now_ms.max(until_ms);
    }

    /// Run the owner loop for `budget_ms` of virtual time, calling `on_wake`
    /// after every event so a viewer can pump and acknowledge.
    ///
    /// Stops early, with `parked_at_ms` set, once the timer and the ACK queue
    /// and the delivery and PTY queues are all empty: that is the state
    /// production sits in
    /// until something external arrives, and this is the only way to observe
    /// it. `wake_cap`
    /// bounds timer fires; exceeding it is the owner loop spinning and fails
    /// the run outright. The clock lands on the end of the budget either way.
    pub(crate) async fn run_for_ms(
        &mut self,
        budget_ms: f64,
        wake_cap: usize,
        mut on_wake: impl FnMut(&mut Self, SimWake),
    ) -> ScheduleRun {
        let end_ms = self.now_ms + budget_ms;
        let mut run = ScheduleRun {
            wakeups: 0,
            flushes: 0,
            datagrams: 0,
            parked_at_ms: None,
        };
        loop {
            let Some(next_at_ms) = self.next_event_at_ms() else {
                run.parked_at_ms = Some(self.now_ms);
                break;
            };
            if next_at_ms > end_ms {
                break;
            }
            let flushes_before = self.flushes.len();
            let wake = self.step().await.expect("an event was due");
            if wake == SimWake::Timer {
                run.wakeups += 1;
                assert!(
                    run.wakeups <= wake_cap,
                    "the owner loop woke {} times inside {budget_ms} ms, past the cap of \
                     {wake_cap}: the flush timer is re-arming at zero and spinning",
                    run.wakeups
                );
            }
            for flush in &self.flushes[flushes_before..] {
                run.flushes += 1;
                run.datagrams += flush.datagrams;
            }
            on_wake(self, wake);
        }
        self.advance_ms(end_ms - self.now_ms);
        run
    }

    /// Run one flush at the current virtual time and record what it emitted.
    pub(crate) async fn flush(&mut self) -> SimFlush {
        // Sequence numbers before the flush, so the peers it served can be
        // named afterwards. `next_datagram_seq` only advances when a peer is
        // actually offered work, which is exactly the question a deferral test
        // asks.
        let seq_before: HashMap<Arc<str>, u32> = self
            .peers
            .iter()
            .map(|(peer_id, peer)| (Arc::clone(peer_id), peer.next_datagram_seq))
            .collect();
        if self.unbounded_demand {
            for peer in self.peers.values_mut() {
                let generation = peer.generation;
                peer.display_credit.grant_for_test(
                    generation,
                    crate::display::credit::DISPLAY_DEMAND_MAX_WINDOW,
                );
            }
        }
        // The owner loop's two flush turns: a synchronized drain paused on a
        // partial grid sends only the control metadata that describes no grid.
        if self.terminal.display_commit_pending() {
            send_paused_drain_metadata(&self.terminal, &mut self.peers, self.now_ms);
        } else {
            flush_display(
                &mut self.terminal,
                &mut self.scratch,
                &mut self.worker,
                &mut self.peers,
                &FlushClock::stepping(self.now_ms, self.clock_step_ms),
                &mut self.cursor,
                &mut self.perf,
            )
            .await;
        }

        // Frames are encoded off the owner loop, so a flush only SUBMITS work.
        // The run loop finishes it on a separate select arm; this waits for the
        // submissions this flush made, which is what makes a simulated flush
        // cover the whole production path instead of stopping at submission.
        // Reading the channel without waiting is why the first version of this
        // harness saw zero frames from a pipeline that was working correctly.
        let emitted = self.finish_outstanding_prepares().await;

        // Drain the in-memory transport. These are the frames the send path
        // actually admitted, as opposed to the ones the encoder built, and the
        // two differ whenever pacing or a closed carrier drops work.
        let on_wire = self.drain_wire();
        // Finish the dictionary build this flush submitted, as the daemon's
        // `dictionary_prepare_completion_rx` select arm does — but waiting for
        // it, so the next flush installs the dictionary deterministically. A
        // fenced build's stale completion arrives first and is rejected by
        // token; the loop keeps waiting for the live one.
        while self.worker.has_dictionary_prepare_in_flight() {
            let Some(completion) = self.dictionary_rx.recv().await else {
                break;
            };
            crate::display::send::finish_dictionary_prepare(completion, &mut self.worker);
        }
        while let Ok((channel_id, peer_id, bytes)) = self.reliable_rx.try_recv() {
            let len = bytes.len();
            self.reliable.push(SimReliableFrame {
                deliver_at_ms: self.now_ms + self.downlink_delay_ms,
                len,
                channel_id,
                peer_id,
                bytes,
            });
        }
        while self
            .reliable
            .get(self.reliable_delivery_cursor)
            .is_some_and(|frame| frame.deliver_at_ms <= self.now_ms)
        {
            self.reliable_delivery_cursor += 1;
        }
        let _ = emitted;
        self.delta_served_last_flush = {
            let mut served: Vec<String> = self
                .peers
                .iter()
                .filter(|(peer_id, peer)| {
                    seq_before
                        .get(*peer_id)
                        .is_some_and(|before| peer.next_datagram_seq > *before)
                })
                .map(|(peer_id, _)| peer_id.to_string())
                .collect();
            served.sort();
            served
        };
        let flush = SimFlush {
            at_ms: self.now_ms,
            datagrams: on_wire,
        };
        self.flushes.push(flush.clone());
        flush
    }

    /// Wait for every prepare this session has outstanding and finish it the way
    /// the owner loop's completion arm does. Returns the datagrams they built.
    ///
    /// Frames are encoded off the owner loop, so a flush only SUBMITS work. The
    /// run loop finishes it on a separate select arm; this waits for the
    /// submissions a flush made, which is what makes a simulated flush cover
    /// the whole production path instead of stopping at submission. Reading
    /// the channel without waiting is why the first version of this harness saw
    /// zero frames from a pipeline that was working correctly.
    async fn finish_outstanding_prepares(&mut self) -> usize {
        let mut emitted = 0;
        while self.has_prepare_in_flight() {
            tokio::select! {
                completion = self.completion_rx.recv() => {
                    let Some(completion) = completion else { break };
                    emitted += completion.datagram_count();
                    self.built += completion.datagram_count();
                    self.apply_output_during_prepare();
                    let revision = self.terminal.display_revision();
                    finish_display_prepare(
                        completion,
                        revision,
                        &mut self.peers,
                        &mut self.worker,
                        self.now_ms,
                        Some(&mut self.perf),
                    ).await;
                }
                completion = self.snapshot_completion_rx.recv() => {
                    let Some(completion) = completion else { break };
                    finish_snapshot_prepare(
                        completion,
                        self.terminal.display_revision(),
                        &mut self.scratch.buffers,
                        &mut self.peers,
                        self.now_ms,
                    ).await;
                }
            }
        }
        emitted
    }

    /// Output due while the worker encodes reaches the terminal first.
    fn apply_output_during_prepare(&mut self) {
        if self.prepare_time_ms == 0.0 {
            return;
        }
        let until_ms = self.now_ms + self.prepare_time_ms;
        let mut applied = false;
        while self
            .pending_pty_writes
            .first()
            .is_some_and(|write| write.release_at_ms <= until_ms)
        {
            let write = self.pending_pty_writes.remove(0);
            self.terminal.apply_bytes(&write.bytes);
            crate::display::send::note_display_output(&mut self.peers, write.release_at_ms);
            applied = true;
        }
        if applied {
            self.arm_flush_earlier_only();
        }
    }

    /// Move every datagram the in-memory carrier admitted onto `wire`, applying
    /// the loss model. Returns how many survived.
    ///
    /// The harness's own copy of each frame is made here, outside anything an
    /// allocation oracle brackets — the carrier's copy at admission is the one
    /// production also pays, and the oracle counts that one by name.
    pub(crate) fn drain_wire(&mut self) -> usize {
        let mut on_wire = 0;
        while let Ok((peer_id, bytes)) = self.capture_rx.try_recv() {
            let index = self.loss_index;
            let metadata = self
                .peers
                .get_mut(peer_id.as_str())
                .and_then(|peer| peer.sim_datagram_metadata.pop_front())
                .expect("every admitted simulator datagram has sender metadata");
            if self.drops_next_frame(&metadata) {
                self.dropped += 1;
                self.drop_log.push(index);
                self.dropped_wire.push(SimDroppedFrame {
                    index,
                    len: bytes.len(),
                    peer_id,
                    metadata,
                    bytes,
                });
                continue;
            }
            self.wire.push(SimWireFrame {
                index,
                at_ms: self.now_ms,
                deliver_at_ms: self.now_ms + self.downlink_delay_ms,
                len: bytes.len(),
                peer_id,
                metadata,
                bytes,
            });
            on_wire += 1;
        }
        // Zero-delay frames are readable on the flush wake itself and do not
        // manufacture a second wake at the same instant. Positive-delay frames
        // remain behind the cursor until their delivery event fires.
        while self
            .wire
            .get(self.delivery_cursor)
            .is_some_and(|frame| frame.deliver_at_ms <= self.now_ms)
        {
            self.delivery_cursor += 1;
        }
        on_wire
    }

    /// Frame buffers parked in the prepare pool across every spare buffer set.
    /// A burst that returned every frame it took leaves this where it was.
    #[cfg(test)]
    pub(crate) fn parked_frame_buffers(&self) -> usize {
        self.worker.parked_frame_buffers()
    }

    /// The flush's hash pass alone — `flush_display`'s refresh of the per-row
    /// hash baseline and the per-flush row captures — so an allocation oracle
    /// can attribute the one allocation this stage makes per dirty row (the
    /// `Arc<[CellRepr]>` capture, kept by design) separately from the peer flush
    /// behind it. Returns how many rows were re-captured.
    #[cfg(test)]
    pub(crate) fn hash_dirty_rows(&mut self) -> usize {
        let DisplayScratch {
            current_row_hashes,
            flush_row_capture,
            rows,
            ..
        } = &mut self.scratch;
        super::send::refresh_flush_row_captures(
            &mut self.terminal,
            current_row_hashes,
            &mut rows.dirty_captures,
            flush_row_capture,
        )
    }

    /// One peer's delta flush exactly as `flush_display` runs it after the hash
    /// pass — selection, capture, encode, burst, ACK bookkeeping — plus, when
    /// the flush was offloaded, the wait for its completion and the burst
    /// `finish_display_prepare` sends. Nothing of the harness's own bookkeeping
    /// runs inside, so an allocation window around this call measures the
    /// production path and the carrier's copy of what it admitted, and nothing
    /// else. `has_display_damage` is what `flush_display` read from the
    /// terminal before its hash pass cleared the damage.
    #[cfg(test)]
    pub(crate) async fn flush_peer_delta(&mut self, peer_id: &str, has_display_damage: bool) {
        let DisplayScratch {
            compressor,
            current_row_hashes,
            flush_row_capture,
            rows,
            prepare,
            ..
        } = &mut self.scratch;
        super::send::send_peer_datagram_delta_with_worker(
            &mut self.terminal,
            compressor,
            &mut self.worker,
            prepare,
            &mut self.peers,
            peer_id,
            self.now_ms,
            current_row_hashes,
            rows,
            flush_row_capture,
            has_display_damage,
            &mut self.perf,
            None,
        );
        self.finish_outstanding_prepares().await;
    }

    /// Advance to the next event. Ties use one explicit order: delivery, ACK,
    /// browser key origin, daemon input arrival, PTY read, flush timer. The two
    /// network/timer ties are pinned by focused tests below.
    ///
    /// `None` is the parked owner loop: the timer is not armed and neither a
    /// datagram nor an ACK is on its way, so production sits until a keystroke
    /// or a PTY read arrives. Every step is therefore a real wake, never a poll.
    pub(crate) async fn step(&mut self) -> Option<SimWake> {
        let next_at_ms = self.next_event_at_ms()?;
        let ack_at_ms = self.pending_acks.first().map(|ack| ack.release_at_ms);
        let browser_at_ms = self
            .pending_browser_keys
            .first()
            .map(|key| key.release_at_ms);
        let input_at_ms = self
            .pending_daemon_inputs
            .first()
            .map(|input| input.release_at_ms);
        let pty_at_ms = self
            .pending_pty_writes
            .first()
            .map(|write| write.release_at_ms);
        let datagram_at_ms = self
            .wire
            .get(self.delivery_cursor)
            .map(|frame| frame.deliver_at_ms);
        let reliable_at_ms = self
            .reliable
            .get(self.reliable_delivery_cursor)
            .map(|frame| frame.deliver_at_ms);
        let delivery_at_ms = match (datagram_at_ms, reliable_at_ms) {
            (Some(datagram), Some(reliable)) => Some(datagram.min(reliable)),
            (Some(at_ms), None) | (None, Some(at_ms)) => Some(at_ms),
            (None, None) => None,
        };

        if delivery_at_ms.is_some_and(|at_ms| at_ms <= next_at_ms) {
            let delivery_at_ms = delivery_at_ms.expect("delivery was present");
            self.now_ms = self.now_ms.max(delivery_at_ms);
            while self
                .wire
                .get(self.delivery_cursor)
                .is_some_and(|frame| frame.deliver_at_ms <= self.now_ms)
            {
                self.delivery_cursor += 1;
            }
            while self
                .reliable
                .get(self.reliable_delivery_cursor)
                .is_some_and(|frame| frame.deliver_at_ms <= self.now_ms)
            {
                self.reliable_delivery_cursor += 1;
            }
            return Some(SimWake::Delivery);
        }
        if ack_at_ms.is_some_and(|at_ms| at_ms <= next_at_ms) {
            let ack_at_ms = ack_at_ms.expect("acknowledgement was present");
            self.release_acks_through(ack_at_ms);
            return Some(SimWake::Ack);
        }
        if browser_at_ms.is_some_and(|at_ms| at_ms <= next_at_ms) {
            let key = self.pending_browser_keys.remove(0);
            self.now_ms = self.now_ms.max(key.release_at_ms);
            let release_at_ms = self.now_ms + key.uplink_delay_ms;
            let at = self
                .pending_daemon_inputs
                .partition_point(|input| input.release_at_ms <= release_at_ms);
            self.pending_daemon_inputs.insert(
                at,
                PendingDaemonInput {
                    release_at_ms,
                    peer_id: key.peer_id,
                    input_seq: key.input_seq,
                    input_bytes: key.input_bytes,
                    echo_bytes: key.echo_bytes,
                },
            );
            return Some(SimWake::BrowserKey);
        }
        if input_at_ms.is_some_and(|at_ms| at_ms <= next_at_ms) {
            let input = self.pending_daemon_inputs.remove(0);
            self.now_ms = self.now_ms.max(input.release_at_ms);
            self.write_input(&input.peer_id, input.input_seq, &input.input_bytes, true);
            self.enqueue_pty_write(
                0.0,
                PendingPtyWrite {
                    release_at_ms: 0.0,
                    bytes: input.echo_bytes,
                },
            );
            return Some(SimWake::Input);
        }
        if pty_at_ms.is_some_and(|at_ms| at_ms <= next_at_ms) {
            let write = self.pending_pty_writes.remove(0);
            self.now_ms = self.now_ms.max(write.release_at_ms);
            self.write_pty(&write.bytes);
            return Some(SimWake::Pty);
        }
        if let Some(timer_at_ms) = self.flush_due_at_ms {
            self.now_ms = self.now_ms.max(timer_at_ms);
            self.fire_flush_timer().await;
            return Some(SimWake::Timer);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_metadata(logical_seq: u32) -> SimDatagramMetadata {
        SimDatagramMetadata {
            generation: 7,
            wire_seq: logical_seq,
            logical_ordinal: u64::from(logical_seq),
            path: PeerTransport::Edge,
            role: SimDatagramRole::Data,
            role_index: 0,
            retransmit_attempt: 0,
        }
    }

    fn admitted_metadata(sim: &DisplaySim) -> Vec<(u64, SimDatagramMetadata)> {
        let mut admitted: Vec<_> = sim
            .wire
            .iter()
            .map(|frame| (frame.index, frame.metadata))
            .chain(
                sim.dropped_wire
                    .iter()
                    .map(|frame| (frame.index, frame.metadata)),
            )
            .collect();
        admitted.sort_unstable_by_key(|(index, _)| *index);
        admitted
    }

    /// The property the flaky wall-clock bound was reaching for, as an equality.
    ///
    /// Terminal damage produced at virtual time T must be emitted by the flush
    /// the production scheduler itself schedules next — not the one after it.
    /// No millisecond constant appears here, so no host can move the result.
    #[tokio::test(flavor = "current_thread")]
    async fn damage_is_emitted_by_the_next_scheduled_flush() {
        let mut sim = DisplaySim::new(80, 24);
        sim.write_full_screen(1);
        assert!(sim.has_dirty(), "a PTY write must leave damage to emit");

        let scheduled = sim
            .flush_due_in_ms()
            .expect("terminal damage arms the flush timer");
        let before = sim.delta_gate();
        let wrote_at = sim.now_ms();
        assert_eq!(
            sim.step().await,
            Some(SimWake::Timer),
            "the only event a fresh write leaves is the flush timer"
        );

        assert_eq!(
            sim.now_ms(),
            wrote_at + scheduled,
            "the harness must advance by exactly the deadline the PTY-read arm set"
        );
        assert!(
            !sim.has_dirty(),
            "damage survived its first scheduled flush, so the frame carrying it \
             waits at least one more coalescing interval"
        );
        // Without this the assertion above would hold for a pipeline that
        // cleared damage and emitted nothing.
        assert!(
            sim.built_datagram_count() > 0,
            "no datagram built.\n  before: {before}\n  after:  {}\n  scheduled delay: {scheduled}ms",
            sim.delta_gate()
        );
    }

    /// Pacing reaches a steady state instead of compounding.
    ///
    /// A pipeline that falls one flush further behind on each write still
    /// passes any single-shot check while its latency grows without bound.
    ///
    /// A flush that finds the datagram rate limiter closed defers, which is
    /// correct: the limiter paces sends by the path's network RTT while the
    /// flush scheduler wakes more often than that. What must never happen is
    /// deferral COMPOUNDING — each write waiting longer than the last while
    /// every individual flush still looks reasonable.
    ///
    /// The bound is the harness's own earlier observations rather than a
    /// predicted budget. Predicting one would mean reproducing the send path's
    /// row selection here, and a test that reimplements the code it checks
    /// stops being evidence about the code. Comparing later rounds against
    /// early ones needs no constant at all and is exactly what "compounding"
    /// means.
    #[tokio::test(flavor = "current_thread")]
    async fn pacing_reaches_a_steady_state_instead_of_compounding() {
        const WARMUP: usize = 4;
        const ROUNDS: usize = 40;

        let mut sim = DisplaySim::new(80, 24);
        let mut waits = Vec::with_capacity(ROUNDS);
        for round in 0..ROUNDS {
            sim.write_full_screen((round % 26) as u8);
            let waited = sim
                .step_until_emit(64)
                .await
                .unwrap_or_else(|| panic!("round {round} never reached the wire"));
            waits.push(waited);
        }

        let baseline = waits[..WARMUP]
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        for (round, waited) in waits.iter().enumerate().skip(WARMUP) {
            assert!(
                *waited <= baseline,
                "round {round} waited {waited}ms against a warmup maximum of {baseline}ms; \
                 deferral is compounding rather than holding a steady pace"
            );
        }
        assert!(
            sim.wire().len() >= ROUNDS,
            "every round must have put at least one frame on the wire"
        );
    }

    /// The same seed replays the same loss, a different seed does not.
    ///
    /// This is the property the existing `MERKUR_DROP_DATAGRAM_PCT` harness
    /// cannot offer: it samples the wall clock, so a pattern that breaks the
    /// daemon is gone the moment it is observed. Reproducibility is what makes
    /// a loss failure debuggable rather than a rumour.
    ///
    /// Asserted against the model rather than against a frame count. A session's
    /// frame count is *not* reproducible today, because `flush_display` folds
    /// real elapsed time into the virtual clock (see
    /// `a_session_agrees_with_its_own_loss_model` for the detail), so asserting
    /// two sessions land on the same total is asserting the machine was equally
    /// busy twice. The seed's reach into the decision is the real property.
    #[test]
    fn a_loss_pattern_is_reproducible_from_its_seed() {
        const LOSS_PCT: u32 = 30;
        const FRAMES: u64 = 4_096;

        let pattern = |seed: u64| -> Vec<u64> {
            (0..FRAMES)
                .filter(|index| frame_is_dropped(seed, &data_metadata(*index as u32), LOSS_PCT))
                .collect()
        };

        let first = pattern(0xC0FF_EE00_1234_5678);
        assert_eq!(
            first,
            pattern(0xC0FF_EE00_1234_5678),
            "the same seed must reproduce the same drop pattern, frame for frame"
        );

        let other = pattern(0x0BAD_F00D_DEAD_BEEF);
        assert_ne!(
            first, other,
            "two seeds dropped exactly the same frames, so the seed is not reaching \
             the decision"
        );

        // A 30% model over 4096 frames lands well inside this band; the point is
        // that the rate is honoured, not that it is exact.
        for (seed, dropped) in [
            (0xC0FF_EE00_1234_5678u64, first.len()),
            (0x0BAD_F00D_DEAD_BEEF, other.len()),
        ] {
            let rate = dropped as f64 / FRAMES as f64 * 100.0;
            assert!(
                (LOSS_PCT as f64 - 5.0..=LOSS_PCT as f64 + 5.0).contains(&rate),
                "seed {seed:#x} dropped {rate:.1}% against a requested {LOSS_PCT}%"
            );
        }
    }

    #[test]
    fn stable_loss_identity_ignores_unrelated_admission_and_distinguishes_retries() {
        let seed = 0xA11C_E5E1_55ED_0001;
        let target = data_metadata(41);
        let unrelated = SimDatagramMetadata {
            wire_seq: 40,
            logical_ordinal: 40,
            role: SimDatagramRole::Repair,
            ..target
        };
        let before = frame_loss_value(seed, &target);
        let _inserted_before_target = frame_loss_value(seed, &unrelated);
        assert_eq!(before, frame_loss_value(seed, &target));

        let retry = SimDatagramMetadata {
            retransmit_attempt: 1,
            ..target
        };
        assert_ne!(
            before,
            frame_loss_value(seed, &retry),
            "a retransmission must not inherit the first attempt's loss draw forever"
        );

        let baseline_second_data = SimDatagramMetadata {
            wire_seq: 42,
            logical_ordinal: 42,
            ..target
        };
        let baseline_second_repair = SimDatagramMetadata {
            role: SimDatagramRole::Repair,
            ..baseline_second_data
        };
        let _candidate_only_replica = frame_loss_value(
            seed,
            &SimDatagramMetadata {
                role: SimDatagramRole::Replica,
                ..target
            },
        );
        let _candidate_only_probe = frame_loss_value(
            seed,
            &SimDatagramMetadata {
                wire_seq: 42,
                logical_ordinal: 0,
                role: SimDatagramRole::Probe,
                ..target
            },
        );
        // A probe consumes a real display seq in the candidate, but not a data
        // ordinal. The same subsequent logical data and its repair therefore
        // retain their paired random draws.
        let candidate_second_data = SimDatagramMetadata {
            wire_seq: 43,
            ..baseline_second_data
        };
        let candidate_second_repair = SimDatagramMetadata {
            wire_seq: 43,
            ..baseline_second_repair
        };
        assert_eq!(
            frame_loss_value(seed, &baseline_second_data),
            frame_loss_value(seed, &candidate_second_data)
        );
        assert_eq!(
            frame_loss_value(seed, &baseline_second_repair),
            frame_loss_value(seed, &candidate_second_repair)
        );
    }

    /// A real session's drops are exactly the ones its own model predicts.
    ///
    /// This is the integration half of the property above, and it is stated so
    /// that it does not depend on how many frames the session produced. However
    /// many frames reach the transport, the ones the simulator recorded as lost
    /// must be precisely the ones `frame_is_dropped` names for their identities —
    /// no extra drop, none missed, none reordered.
    ///
    /// Stated this way on purpose. The obvious form — run the same seed twice
    /// and compare drop logs — is flaky, and that flake is a real finding rather
    /// than a bad test: `flush_display` mixes `Instant::elapsed()` into the
    /// caller's `now_ms` (`completion_ms_after_elapsed`) and gates peer deferral
    /// on real elapsed time (`display_owner_should_defer`). A busier machine
    /// therefore takes a different rate-limit branch and builds a different
    /// number of frames. Until that clock is injected rather than sampled, frame
    /// *counts* are not a deterministic observable and must not be asserted as
    /// one.
    #[tokio::test(flavor = "current_thread")]
    async fn a_session_agrees_with_its_own_loss_model() {
        const SEED: u64 = 0xC0FF_EE00_1234_5678;
        const LOSS_PCT: u32 = 30;

        let mut sim = DisplaySim::new(80, 24);
        sim.set_loss(LOSS_PCT, SEED);
        for round in 0..24u32 {
            sim.write_full_screen((round % 26) as u8);
            sim.step().await;
        }

        let observed = sim.drop_log().to_vec();
        let admitted = admitted_metadata(&sim);
        let frames = admitted.len();
        let predicted: Vec<u64> = admitted
            .iter()
            .filter(|(_, metadata)| frame_is_dropped(SEED, metadata, LOSS_PCT))
            .map(|(index, _)| *index)
            .collect();

        assert_eq!(
            observed, predicted,
            "over {frames} frames the session's drops diverged from the model its \
             own seed defines"
        );
        assert!(
            !observed.is_empty(),
            "a {LOSS_PCT}% loss model over {frames} frames dropped nothing"
        );
        assert_eq!(
            sim.dropped_count(),
            observed.len(),
            "the drop counter and the drop log disagree"
        );
    }

    /// Every row still reaches the wire under sustained loss.
    ///
    /// With frames disappearing after the daemon has counted them as sent, rows
    /// stay unacknowledged and only the resend and resync paths can recover
    /// them. A pipeline that stopped retrying would still pass every assertion
    /// above, because those only watch frames that were not dropped.
    #[tokio::test(flavor = "current_thread")]
    async fn sustained_loss_still_delivers_every_generation() {
        for seed in [1u64, 2, 3, 5, 8] {
            let mut sim = DisplaySim::new(80, 24);
            sim.set_loss(50, seed);
            let mut delivered_rounds = 0;
            for round in 0..24u32 {
                sim.write_full_screen((round % 26) as u8);
                if sim.step_until_emit(32).await.is_some() {
                    delivered_rounds += 1;
                }
            }
            assert!(
                sim.dropped_count() > 0,
                "seed {seed} dropped nothing, so this proves nothing about recovery"
            );
            assert_eq!(
                delivered_rounds, 24,
                "seed {seed} delivered only {delivered_rounds}/24 rounds under 50% loss; \
                 retry or resync is not recovering dropped frames"
            );
        }
    }

    /// A write lost on the wire is never stranded permanently.
    ///
    /// The loss test above re-writes the whole screen every round, so fresh
    /// terminal damage keeps the pipeline busy and recovery is never required.
    /// This writes once and then only advances time, so retry or the digest
    /// backstop is the only way the dropped rows can reach the wire.
    ///
    /// Scope, measured rather than assumed: this catches PERMANENT stranding,
    /// not a slow path. Deleting the `needs_full_diff` re-arm that
    /// `RateLimitOutcome::DeferTick` depends on leaves this green, because the
    /// digest backstop still delivers inside the step budget — the suite
    /// notices that mutation through the loss-pattern test instead. Separating
    /// "recovered by re-arm" from "recovered by backstop" needs a step budget
    /// tight enough to exclude the backstop, which would be exactly the kind of
    /// invented constant this module exists to avoid.
    #[tokio::test(flavor = "current_thread")]
    async fn a_write_lost_on_the_wire_is_never_stranded() {
        for seed in [11u64, 13, 17] {
            let mut sim = DisplaySim::new(80, 24);
            // Drop everything the first flush produces, then let it recover.
            sim.set_loss(100, seed);
            sim.write_full_screen(1);
            sim.step().await;
            let dropped_first = sim.dropped_count();
            assert!(
                dropped_first > 0,
                "seed {seed}: the first flush put nothing on the wire to drop"
            );

            // No further terminal writes from here: only retry can deliver.
            sim.set_loss(0, seed);
            let recovered = sim.step_until_emit(256).await;
            assert!(
                recovered.is_some(),
                "seed {seed}: rows dropped by the wire were never retried, so a lost \
                 frame strands until the digest backstop"
            );
            assert!(
                !sim.wire().is_empty(),
                "seed {seed}: recovery reported progress without a frame on the wire"
            );
        }
    }

    /// Run one simulated session and report what it did.
    ///
    /// Shared by the property tests below so each states only its property.
    fn run_session(seed: u64, loss_pct: u32, rounds: usize) -> SessionOutcome {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("current-thread runtime");
        runtime.block_on(async move {
            let mut sim = DisplaySim::new(80, 24);
            sim.set_loss(loss_pct, seed);
            let mut waits = Vec::with_capacity(rounds);
            for round in 0..rounds {
                sim.write_full_screen((round % 26) as u8);
                if let Some(waited) = sim.step_until_emit(64).await {
                    waits.push(waited);
                }
            }
            SessionOutcome {
                waits,
                wire: sim.wire().len(),
                dropped: sim.dropped_count(),
                drop_log: sim.drop_log().to_vec(),
                admitted: admitted_metadata(&sim),
            }
        })
    }

    struct SessionOutcome {
        waits: Vec<f64>,
        wire: usize,
        dropped: usize,
        drop_log: Vec<u64>,
        admitted: Vec<(u64, SimDatagramMetadata)>,
    }

    proptest::proptest! {
        // Each case runs a whole simulated session, so the case count is set for
        // the cost of that rather than left at the default 256.
        #![proptest_config(proptest::prelude::ProptestConfig {
            cases: 48,
            failure_persistence: None,
            ..proptest::prelude::ProptestConfig::default()
        })]

        /// No loss pattern strands a generation forever.
        ///
        /// The unit tests above pin three hand-picked seeds. This asks the same
        /// question of arbitrary ones, and shrinks a failure to the smallest
        /// (seed, loss) that still exhibits it instead of leaving a pattern to
        /// bisect by hand — which is the whole reason the loss model is seeded.
        #[test]
        fn every_round_reaches_the_wire_under_arbitrary_loss(
            seed in proptest::prelude::any::<u64>(),
            loss_pct in 0u32..=80,
        ) {
            let rounds = 12;
            let outcome = run_session(seed, loss_pct, rounds);
            proptest::prop_assert_eq!(
                outcome.waits.len(),
                rounds,
                "seed {} at {}% loss delivered {}/{} rounds",
                seed,
                loss_pct,
                outcome.waits.len(),
                rounds
            );
            // The harness's own bookkeeping, checked on every case: a drop
            // counter that disagreed with the log would make every loss claim
            // above unverifiable.
            proptest::prop_assert_eq!(
                outcome.dropped,
                outcome.drop_log.len(),
                "seed {} at {}% loss: drop counter and log disagree",
                seed,
                loss_pct
            );
        }

        /// Pacing holds a steady state across terminal shapes.
        ///
        /// Deliberately loss-free. Under loss a later round can legitimately
        /// wait longer than an early one, because a dropped frame has to be
        /// retried — that is recovery, not compounding, and proptest shrank a
        /// version of this that conflated the two to `loss_pct = 34`. Varying
        /// the terminal shape instead exercises the row-selection and batching
        /// paths that actually feed the pacer, while keeping the property exact.
        #[test]
        fn pacing_never_compounds_across_terminal_shapes(
            cols in 20u16..=200,
            rows in 8u16..=60,
        ) {
            const WARMUP: usize = 4;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("current-thread runtime");
            let waits = runtime.block_on(async move {
                let mut sim = DisplaySim::new(cols, rows);
                let mut waits = Vec::new();
                for round in 0..24u32 {
                    sim.write_full_screen((round % 26) as u8);
                    if let Some(waited) = sim.step_until_emit(64).await {
                        waits.push(waited);
                    }
                }
                waits
            });
            proptest::prop_assume!(waits.len() > WARMUP);
            let baseline = waits[..WARMUP]
                .iter()
                .copied()
                .fold(f64::NEG_INFINITY, f64::max);
            for (round, waited) in waits.iter().enumerate().skip(WARMUP) {
                proptest::prop_assert!(
                    *waited <= baseline,
                    "{}x{}: round {} waited {}ms against a warmup maximum of {}ms",
                    cols,
                    rows,
                    round,
                    waited,
                    baseline
                );
            }
        }

        /// A loss-free session drops nothing and still reaches the wire.
        ///
        /// This replaced an invariant that `wire + dropped <= built`, which
        /// proptest shrank to `seed = 0, loss = 0` — a true minimal
        /// counterexample to a FALSE property, not a defect. `built` counts
        /// prepare-worker completions, and a small delta is encoded inline on
        /// the owner loop and never reaches the worker, so it undercounts by
        /// construction and can be smaller than the wire.
        #[test]
        fn a_loss_free_session_drops_nothing(
            cols in 20u16..=200,
            rows in 8u16..=60,
        ) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("current-thread runtime");
            let (wire, dropped) = runtime.block_on(async move {
                let mut sim = DisplaySim::new(cols, rows);
                for round in 0..8u32 {
                    sim.write_full_screen((round % 26) as u8);
                    sim.step_until_emit(64).await;
                }
                (sim.wire().len(), sim.dropped_count())
            });
            proptest::prop_assert_eq!(dropped, 0, "{}x{} dropped without a loss model", cols, rows);
            proptest::prop_assert!(wire > 0, "{}x{} put nothing on the wire", cols, rows);
        }

        /// Every session agrees with the model its seed defines.
        ///
        /// Checked across arbitrary seeds and loss rates rather than the single
        /// pair the unit test pins. Stated as agreement-with-the-model rather
        /// than as replay-equality between two runs, because frame counts are
        /// not yet a deterministic observable — see
        /// `a_session_agrees_with_its_own_loss_model` for why.
        #[test]
        fn a_session_agrees_with_its_model_for_every_seed(
            seed in proptest::prelude::any::<u64>(),
            loss_pct in 1u32..=70,
        ) {
            let outcome = run_session(seed, loss_pct, 6);
            let frames = outcome.admitted.len();
            let predicted: Vec<u64> = outcome.admitted
                .iter()
                .filter(|(_, metadata)| frame_is_dropped(seed, metadata, loss_pct))
                .map(|(index, _)| *index)
                .collect();
            proptest::prop_assert_eq!(
                &outcome.drop_log, &predicted,
                "seed {} at {}% loss diverged from its own model over {} frames",
                seed, loss_pct, frames
            );
            proptest::prop_assert_eq!(
                outcome.dropped, outcome.drop_log.len(),
                "seed {} at {}% loss: drop counter and log disagree", seed, loss_pct
            );
        }
    }

    /// An application that declares its redraw with BSU/ESU hands the parser
    /// bytes it buffers whole until the ESU. Every one of those PTY reads still
    /// reaches the flush as cursor-cell damage, because `record_damage` marks
    /// the cursor on every read; none of them may leave the daemon, because
    /// none carries a header, an advertisement or an END the viewer lacks.
    /// Before this pin each buffered read cost one header-only datagram and
    /// one browser apply — eighteen per frame in the edge harness's TUI
    /// fixture.
    #[tokio::test(flavor = "current_thread")]
    async fn a_synchronized_update_emits_nothing_until_its_esu() {
        let mut sim = DisplaySim::new(80, 24);
        sim.write_pty(b"seed\r\n");
        sim.step().await;
        for _ in 0..4 {
            if sim.step().await.is_none() {
                break;
            }
        }
        let baseline = sim.wire().len();
        sim.write_pty(b"\x1b[?2026h\x1b[2J\x1b[H");
        sim.step().await;
        for i in 1..=6u32 {
            sim.write_pty(format!("\x1b[{i};1Hrow-{i}-xxxxxxxxxx").as_bytes());
            assert!(
                sim.terminal.pending_display_damage().any,
                "a buffered read still records cursor damage; the flush must reject it on its own"
            );
            sim.step().await;
            assert_eq!(
                sim.wire().len(),
                baseline,
                "a read the parser buffered behind BSU must put nothing on the wire"
            );
        }
        sim.write_pty(b"\x1b[?2026l");
        sim.step().await;
        let emitted: Vec<usize> = sim.wire()[baseline..].iter().map(|frame| frame.len).collect();
        assert!(
            !emitted.is_empty(),
            "the ESU releases the whole frame in one flush"
        );
        assert!(
            emitted.iter().all(|len| *len > 76),
            "every frame the ESU releases carries rows, not a bare header: {emitted:?}"
        );
    }

    /// Let the image worker validate the upload a synchronized drain is parked
    /// on, applying the rest of `update` each time a completion resumes it.
    async fn finish_paused_upload(sim: &mut DisplaySim, update: &[u8], accepted: &mut usize) {
        let wake = sim.terminal.graphics_wake();
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while sim.terminal.graphics_pending() {
                wake.notified().await;
                *accepted += sim.terminal.apply_bytes(&update[*accepted..]);
            }
        })
        .await
        .expect("image completion must resume the drain");
    }

    /// A synchronized update that pushes Kitty flags and then uploads an image
    /// parks its drain while the upload is validated, and nothing may be
    /// displayed until it finishes. A key admitted meanwhile is already encoded
    /// under the new flags, so the browser has to learn now that releases are
    /// reported, or it holds each one until the image is done. The routing word
    /// goes once on the control lane, and the header the drain commits brings
    /// nothing new.
    #[tokio::test(flavor = "current_thread")]
    async fn a_paused_drain_sends_the_input_routing_word_once() {
        use crate::display::viewer::SimViewers;
        use crate::network::input_record::build::{self, Key};
        use crate::pty::terminal::{DISPLAY_MODE_KEY_RELEASES, DISPLAY_MODE_MODIFIER_KEYS};

        const COLS: u16 = 40;
        const ROWS: u16 = 4;
        const RELEASE: u8 = 2;
        let reports = u32::from(DISPLAY_MODE_KEY_RELEASES | DISPLAY_MODE_MODIFIER_KEYS);
        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        // A committed header first, so the word the browser holds is known.
        sim.write_pty(b"$ ");
        sim.flush().await;
        viewers.pump(&sim);
        assert_eq!(viewers.viewer(&peer).terminal_mut().mouse_mode() & reports, 0);

        let update = b"\x1b[?2026h\x1b[>11u\x1b_Ga=t,f=24,s=1,v=1,i=31;AAAA\x1b\\drawn\x1b[?2026l";
        let mut accepted = sim.terminal.apply_bytes(update);
        assert!(sim.terminal.display_commit_pending(), "the upload holds the drain");

        let (mut writer, _completions) =
            crate::pty::PtyWriter::new(Box::new(Vec::<u8>::new())).expect("writer");
        let peer_id: Arc<str> = Arc::from(peer.as_str());
        let release = build::key(Key {
            event: RELEASE,
            key: u32::from('a'),
            ..Key::default()
        });
        for (seq, record) in [(1, build::press('a')), (2, release)] {
            assert_eq!(
                crate::admit_user_record(
                    &mut writer,
                    &mut sim.terminal,
                    &peer_id,
                    seq,
                    PeerTransport::WebTransport,
                    &record,
                    false,
                    None,
                ),
                Some(true),
                "record {seq} encodes to bytes under the flags the drain applied"
            );
        }

        sim.flush().await;
        viewers.pump(&sim);
        let viewer = viewers.viewer(&peer);
        assert_eq!(viewer.input_routing_seen, 1);
        assert_eq!(viewer.terminal_mut().mouse_mode() & reports, reports);
        assert!(sim.terminal.display_commit_pending(), "still before the image completes");

        sim.flush().await;
        viewers.pump(&sim);
        assert_eq!(
            viewers.viewer(&peer).input_routing_seen,
            1,
            "an unchanged word is not sent again"
        );

        finish_paused_upload(&mut sim, update, &mut accepted).await;
        assert_eq!(accepted, update.len());
        assert!(!sim.terminal.display_commit_pending());
        let committed_before = sim.wire().len();
        sim.flush().await;
        viewers.pump(&sim);
        assert!(
            sim.wire().len() > committed_before,
            "the committed update is displayed"
        );
        let viewer = viewers.viewer(&peer);
        assert_eq!(viewer.input_routing_seen, 1);
        assert_eq!(viewer.terminal_mut().mouse_mode() & reports, reports);

        // The committed header now carries the word: a pause that changes no
        // mode sends none.
        let quiet = b"\x1b[?2026h\x1b_Ga=t,f=24,s=1,v=1,i=32;AAAA\x1b\\\x1b[?2026l";
        accepted = sim.terminal.apply_bytes(quiet);
        assert!(sim.terminal.display_commit_pending());
        sim.flush().await;
        viewers.pump(&sim);
        assert_eq!(viewers.viewer(&peer).input_routing_seen, 1);
        finish_paused_upload(&mut sim, quiet, &mut accepted).await;
        sim.terminal.shutdown_graphics().await;
    }

    /// The rest of a paused transaction can turn the modes back off and leave
    /// nothing to redraw. Sending the routing word unset the admitted header,
    /// so the commit re-admits it and the browser's word follows the terminal
    /// back instead of keeping the paused one until some later header.
    #[tokio::test(flavor = "current_thread")]
    async fn a_commit_takes_back_a_routing_word_its_transaction_reverted() {
        use crate::display::viewer::SimViewers;
        use crate::pty::terminal::{DISPLAY_MODE_KEY_RELEASES, DISPLAY_MODE_MODIFIER_KEYS};

        const COLS: u16 = 40;
        const ROWS: u16 = 4;
        let reports = u32::from(DISPLAY_MODE_KEY_RELEASES | DISPLAY_MODE_MODIFIER_KEYS);
        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"$ ");
        sim.flush().await;
        viewers.pump(&sim);

        let update = b"\x1b[?2026h\x1b[>11u\x1b_Ga=t,f=24,s=1,v=1,i=31;AAAA\x1b\\\x1b[<u\x1b[?2026l";
        let mut accepted = sim.terminal.apply_bytes(update);
        assert!(sim.terminal.display_commit_pending(), "the upload holds the drain");
        sim.flush().await;
        viewers.pump(&sim);
        assert_eq!(viewers.viewer(&peer).input_routing_seen, 1);
        assert_eq!(
            viewers.viewer(&peer).terminal_mut().mouse_mode() & reports,
            reports
        );

        finish_paused_upload(&mut sim, update, &mut accepted).await;
        assert_eq!(accepted, update.len());
        assert_eq!(u32::from(sim.terminal.input_routing_word()) & reports, 0);
        sim.flush().await;
        viewers.pump(&sim);
        let viewer = viewers.viewer(&peer);
        assert_eq!(
            viewer.terminal_mut().mouse_mode() & reports,
            0,
            "the committed header takes the paused word back"
        );
        assert_eq!(viewer.input_routing_seen, 1);
        sim.terminal.shutdown_graphics().await;
    }

    /// Nothing orders the control lane against the display frames. A redraw
    /// sent just before the pause can land after the routing word (a datagram
    /// rebuilt by FEC, a stream retransmission, the other carrier), and its
    /// header carries the modes from before the pause. The word names its
    /// display position, so that header keeps the word's routing bits. Before,
    /// it took them back, and no header could restore them until the commit.
    #[tokio::test(flavor = "current_thread")]
    async fn a_frame_from_before_the_pause_does_not_take_back_the_routing_word() {
        use crate::display::viewer::SimViewers;
        use crate::pty::terminal::{DISPLAY_MODE_KEY_RELEASES, DISPLAY_MODE_MODIFIER_KEYS};

        const COLS: u16 = 40;
        const ROWS: u16 = 4;
        let reports = u32::from(DISPLAY_MODE_KEY_RELEASES | DISPLAY_MODE_MODIFIER_KEYS);
        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"$ ");
        sim.flush().await;
        viewers.pump(&sim);

        // A redraw still on the datagram lane when the pause begins.
        let redraw_before = sim.wire().len();
        sim.write_pty(b"x");
        sim.flush().await;
        assert!(sim.wire().len() > redraw_before, "the redraw rides the datagram lane");

        let update = b"\x1b[?2026h\x1b[>11u\x1b_Ga=t,f=24,s=1,v=1,i=31;AAAA\x1b\\drawn\x1b[?2026l";
        let mut accepted = sim.terminal.apply_bytes(update);
        assert!(sim.terminal.display_commit_pending(), "the upload holds the drain");
        sim.flush().await;

        // The control lane overtakes the redraw.
        viewers.pump_reliable(&sim);
        assert_eq!(viewers.viewer(&peer).input_routing_seen, 1);
        assert_eq!(
            viewers.viewer(&peer).terminal_mut().mouse_mode() & reports,
            reports
        );
        viewers.pump_datagrams(&sim);
        assert_eq!(
            viewers.viewer(&peer).terminal_mut().mouse_mode() & reports,
            reports,
            "a header from before the pause keeps the routing bits of the word sent after it"
        );

        // The committed header comes after the word and releases it, so the
        // next mode change reaches the viewer whole.
        finish_paused_upload(&mut sim, update, &mut accepted).await;
        sim.flush().await;
        viewers.pump(&sim);
        assert_eq!(
            viewers.viewer(&peer).terminal_mut().mouse_mode() & reports,
            reports
        );
        sim.write_pty(b"\x1b[<u");
        sim.flush().await;
        viewers.pump(&sim);
        let viewer = viewers.viewer(&peer);
        assert_eq!(viewer.terminal_mut().mouse_mode() & reports, 0);
        assert_eq!(viewer.input_routing_seen, 1);
        sim.terminal.shutdown_graphics().await;
    }

    /// The other crossing: the header the drain commits lands before the word
    /// the pause sent. That header was captured after the word, so the word is
    /// dropped instead of turning the viewer back to the paused modes, which
    /// here the rest of the transaction had already undone.
    #[tokio::test(flavor = "current_thread")]
    async fn a_routing_word_that_lands_after_the_committed_header_is_dropped() {
        use crate::display::viewer::SimViewers;
        use crate::pty::terminal::{DISPLAY_MODE_KEY_RELEASES, DISPLAY_MODE_MODIFIER_KEYS};

        const COLS: u16 = 40;
        const ROWS: u16 = 4;
        let reports = u32::from(DISPLAY_MODE_KEY_RELEASES | DISPLAY_MODE_MODIFIER_KEYS);
        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"$ ");
        sim.flush().await;
        viewers.pump(&sim);

        let update = b"\x1b[?2026h\x1b[>11u\x1b_Ga=t,f=24,s=1,v=1,i=31;AAAA\x1b\\\x1b[<u\x1b[?2026l";
        let mut accepted = sim.terminal.apply_bytes(update);
        assert!(sim.terminal.display_commit_pending(), "the upload holds the drain");
        sim.flush().await;
        finish_paused_upload(&mut sim, update, &mut accepted).await;
        assert_eq!(u32::from(sim.terminal.input_routing_word()) & reports, 0);
        let committed_before = sim.wire().len();
        sim.flush().await;
        assert!(
            sim.wire().len() > committed_before,
            "the committed header rides the datagram lane"
        );

        // The committed header overtakes the word.
        viewers.pump_datagrams(&sim);
        viewers.pump_reliable(&sim);
        let viewer = viewers.viewer(&peer);
        assert_eq!(viewer.input_routing_seen, 1);
        assert_eq!(
            viewer.terminal_mut().mouse_mode() & reports,
            0,
            "a word the committed header was captured after is dropped"
        );
        sim.terminal.shutdown_graphics().await;
    }

    /// Simulated time is the only clock: a whole session costs no real waiting.
    #[tokio::test(flavor = "current_thread")]
    async fn a_long_session_advances_virtual_time_without_sleeping() {
        let started = std::time::Instant::now();
        let mut sim = DisplaySim::new(120, 40);
        // 500 rows written back to back each leave in the turn that applied
        // them: there is no coalescing arm, so the harness's clock stays at
        // zero through the whole burst. What advances it afterwards is the
        // only wait left on the flush path — the unconfirmed rows' re-send
        // deadline, which no viewer here ever acknowledges.
        for round in 0..500u32 {
            sim.write_pty(format!("row {round}\r\n").as_bytes());
            sim.step().await;
        }
        assert_eq!(
            sim.now_ms(),
            0.0,
            "a producer that never drains is flushed at zero delay, never coalesced"
        );
        for _ in 0..8 {
            if sim.step().await.is_none() {
                break;
            }
        }
        assert!(
            sim.now_ms() > 0.0,
            "virtual time must advance across the session"
        );
        // Virtual time is the only clock, so every recorded flush must be
        // ordered by it — a harness that advanced out of order would make every
        // latency equality built on top of it meaningless.
        let mut previous = f64::NEG_INFINITY;
        for flush in sim.flushes() {
            assert!(
                flush.at_ms >= previous,
                "virtual time ran backwards: {} after {previous}",
                flush.at_ms
            );
            previous = flush.at_ms;
        }
        let recorded: usize = sim.flushes().iter().map(|flush| flush.datagrams).sum();
        assert_eq!(
            recorded,
            sim.wire().len(),
            "per-flush counts must account for every frame the session put on the wire"
        );
        assert!(
            sim.wire_bytes() > 0,
            "a session that wrote to the terminal must have put bytes on the wire"
        );
        for frame in sim.wire() {
            assert!(
                frame.at_ms <= sim.now_ms(),
                "a frame is stamped after the clock that admitted it"
            );
        }
        // The exact partition planner is deliberately exercised on each
        // virtual flush. Its own single-thread runtime oracle carries the
        // tight CPU bound; this wall-clock guard only detects an accidental
        // real timer and therefore leaves room for concurrent debug tests.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(15),
            "a virtual-time session must not spend real time waiting"
        );
    }
    /// A session now replays exactly, frame for frame.
    ///
    /// This property could not be asserted before the flush clock was injected.
    /// `flush_display` sampled `Instant::elapsed()` inside a flush its caller
    /// drove with virtual time, so a busier machine took a different rate-limit
    /// branch and built a different number of datagrams. Two runs of one seed
    /// disagreed about one run in three, and the tests had to be written against
    /// the loss model instead of against the session.
    ///
    /// With the clock injected there is no second time source, so the strong
    /// form holds: same seed, same wire, same drops, same count.
    #[test]
    fn a_session_replays_identically_from_its_seed() {
        for (seed, loss_pct) in [
            (0xC0FF_EE00_1234_5678u64, 30u32),
            (0x0BAD_F00D_DEAD_BEEF, 0),
            (0x1234_5678_9ABC_DEF0, 70),
        ] {
            let first = run_session(seed, loss_pct, 8);
            for attempt in 0..8 {
                let replay = run_session(seed, loss_pct, 8);
                assert_eq!(
                    first.wire, replay.wire,
                    "seed {seed:#x} at {loss_pct}% loss put a different number of \
                     frames on the wire on attempt {attempt}"
                );
                assert_eq!(
                    first.drop_log, replay.drop_log,
                    "seed {seed:#x} at {loss_pct}% loss dropped different frames on \
                     attempt {attempt}"
                );
                assert_eq!(
                    first.waits, replay.waits,
                    "seed {seed:#x} at {loss_pct}% loss paced differently on \
                     attempt {attempt}"
                );
            }
        }
    }

    /// No viewer starves when more peers are runnable than one flush may serve.
    ///
    /// `DISPLAY_PEERS_PER_FLUSH` caps a single owner turn at eight peers. With
    /// ten runnable viewers the cap must bite — and the peers it put off must
    /// come back, or a large session would permanently freeze whichever viewers
    /// sorted last.
    #[tokio::test(flavor = "current_thread")]
    async fn a_flush_serves_a_bounded_batch_and_starves_no_viewer() {
        const PEERS: usize = 10;
        const CAP: usize = 8;

        let mut sim = DisplaySim::with_peers(80, 24, PEERS);
        assert_eq!(sim.peer_count(), PEERS);

        let mut ever_served: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut capped_at_least_once = false;

        for round in 0..12u32 {
            sim.write_full_screen((round % 26) as u8);
            sim.step().await;
            let served = sim.delta_served_last_flush().to_vec();
            assert!(
                served.len() <= CAP,
                "round {round} served {} peers, over the {CAP} cap: {served:?}",
                served.len()
            );
            if served.len() == CAP {
                capped_at_least_once = true;
            }
            ever_served.extend(served);
        }

        assert!(
            capped_at_least_once,
            "ten runnable viewers never filled an eight-peer batch, so the cap was \
             not exercised and this test proves nothing"
        );
        assert_eq!(
            ever_served.len(),
            PEERS,
            "only {} of {PEERS} viewers were ever served; the deferred cohort is \
             starving rather than rotating",
            ever_served.len()
        );
    }

    /// A snapshot ends the turn: peers behind it are put back, not dropped.
    ///
    /// `display_owner_should_defer` treats an offered snapshot as reason enough
    /// to yield, whatever the turn budget says. This is the branch a
    /// single-peer harness could never reach, because the gate first requires a
    /// peer to have been offered.
    #[tokio::test(flavor = "current_thread")]
    async fn a_snapshot_defers_the_rest_of_the_turn() {
        const PEERS: usize = 4;
        let mut sim = DisplaySim::with_peers(80, 24, PEERS);

        sim.request_snapshot(&sim_peer_id(0));
        sim.write_full_screen(b'a');
        sim.step().await;

        // The snapshot itself was delivered on that turn, and reached the
        // reliable lane rather than merely clearing a flag.
        assert!(
            !sim.snapshot_pending(&sim_peer_id(0)),
            "the peer that asked for a snapshot did not receive one"
        );
        assert!(
            sim.reliable_frames() > 0,
            "the snapshot cleared its flag without committing anything to the \
             reliable lane"
        );

        let first = sim.delta_served_last_flush().to_vec();
        assert!(
            first.len() < PEERS - 1,
            "a snapshot flush went on to serve every remaining peer ({first:?}); \
             the deferral branch did not fire"
        );

        // The deferred viewers must come back on later turns rather than wait
        // for new terminal damage.
        let mut ever_served: std::collections::HashSet<String> = first.into_iter().collect();
        for _ in 0..8 {
            sim.step().await;
            ever_served.extend(sim.delta_served_last_flush().to_vec());
        }
        let expected: std::collections::HashSet<String> = (1..PEERS).map(sim_peer_id).collect();
        assert_eq!(
            ever_served, expected,
            "peers deferred behind a snapshot never came back"
        );
    }

    /// Peers put off by a full batch come back without new terminal damage.
    ///
    /// Distinct from the round-robin fairness above, and the distinction is the
    /// point. While damage keeps arriving, a fresh cohort supersedes the
    /// deferred one and rotation alone feeds every viewer. When damage stops,
    /// the deferred queue is the only thing that can still finish the redraw —
    /// so this drives one burst and then lets the session settle in silence.
    #[tokio::test(flavor = "current_thread")]
    async fn a_deferred_cohort_finishes_after_the_damage_stops() {
        const PEERS: usize = 10;

        let mut sim = DisplaySim::with_peers(80, 24, PEERS);
        sim.write_full_screen(b'a');

        let mut ever_served: std::collections::HashSet<String> = std::collections::HashSet::new();
        let first = {
            sim.step().await;
            sim.delta_served_last_flush().to_vec()
        };
        assert!(
            first.len() < PEERS,
            "the first flush served all {PEERS} viewers ({}), so nothing was \
             deferred and this test proves nothing",
            first.len()
        );
        // The next turn belongs to the peers that were put off, and to nobody
        // else.
        //
        // Note what this does NOT pin down. Deleting `cursor.deferred_peer_ids`
        // entirely — never requeueing a deferred peer — leaves every assertion
        // here passing, because a served peer's damage is cleared and the
        // ordinary eligibility scan then selects exactly the same remainder in
        // exactly the same order. The queue is not observably load-bearing at
        // this layer. That is recorded rather than acted on: it may still matter
        // under conditions this harness does not reproduce, and one harness's
        // blind spot is not a licence to delete production scheduling.
        let deferred: Vec<String> = (0..PEERS)
            .map(sim_peer_id)
            .filter(|peer_id| !first.contains(peer_id))
            .collect();
        sim.step().await;
        assert_eq!(
            sim.delta_served_last_flush(),
            deferred.as_slice(),
            "the turn after a capped flush must serve exactly the deferred \
             cohort, in order"
        );
        ever_served.extend(first);
        ever_served.extend(deferred);

        // No further writes: every remaining peer must be served from the
        // deferred queue alone.
        for _ in 0..16 {
            if sim.step().await.is_none() {
                break;
            }
            ever_served.extend(sim.delta_served_last_flush().to_vec());
        }

        assert_eq!(
            ever_served.len(),
            PEERS,
            "after the damage stopped, only {} of {PEERS} viewers finished the \
             redraw; the deferred cohort was dropped rather than requeued",
            ever_served.len()
        );
    }

    /// A flush that takes time yields the owner loop, and yields it sooner the
    /// longer it takes.
    ///
    /// This is `display_owner_should_defer`'s turn-budget branch — the last part
    /// of the fairness machinery that stayed unreachable. It needs three things
    /// at once: more than one peer (the gate first requires a peer to have been
    /// offered), no snapshot (or the other branch fires instead and proves
    /// nothing about time), and time that passes *inside* one flush. The last
    /// one is why the clock steps: sampling the real clock here would make the
    /// assertion a statement about how busy the machine is.
    #[tokio::test(flavor = "current_thread")]
    async fn a_slow_flush_yields_the_owner_loop_sooner() {
        const PEERS: usize = 6;

        async fn served_with_step(step_ms: f64) -> usize {
            let mut sim = DisplaySim::with_peers(80, 24, PEERS);
            sim.set_clock_step_ms(step_ms);
            sim.write_full_screen(b'a');
            sim.step().await;
            sim.delta_served_last_flush().len()
        }

        // An instantaneous flush never spends its budget, so every viewer is
        // served in one turn. Without this control the test below could pass on
        // a harness where nothing is ever served.
        let instant = served_with_step(0.0).await;
        assert_eq!(
            instant, PEERS,
            "a flush that costs no time still deferred: {instant} of {PEERS} served"
        );

        // A stepping clock is still a deterministic one: it advances by read
        // count, not by how long anything took. Repeating a step must land on
        // the same peer every time, or this whole branch is untestable again.
        for step_ms in [0.25f64, 0.5, 1.0] {
            let first = served_with_step(step_ms).await;
            for attempt in 0..4 {
                assert_eq!(
                    served_with_step(step_ms).await,
                    first,
                    "a {step_ms}ms-per-read flush served a different number of \
                     peers on attempt {attempt}"
                );
            }
        }

        // Each step is a whole `DISPLAY_OWNER_TURN_BUDGET_MS` divided further,
        // so a slower flush must reach the budget at an earlier peer.
        let mut previous = instant;
        for step_ms in [0.25f64, 0.5, 1.0] {
            let served = served_with_step(step_ms).await;
            assert!(
                served >= 1,
                "a {step_ms}ms-per-read flush served nobody at all"
            );
            assert!(
                served < previous,
                "a flush at {step_ms}ms per read served {served} peers, no fewer \
                 than the {previous} served by a faster one; the turn budget is \
                 not bounding the turn"
            );
            previous = served;
        }
    }

    /// A tight turn budget delays viewers; it must not strand them.
    #[tokio::test(flavor = "current_thread")]
    async fn a_budget_bounded_turn_still_serves_every_viewer() {
        const PEERS: usize = 6;
        let mut sim = DisplaySim::with_peers(80, 24, PEERS);
        // Well past the budget, so each turn serves as few peers as it can.
        sim.set_clock_step_ms(1.0);
        sim.write_full_screen(b'a');

        let mut ever_served: std::collections::HashSet<String> = std::collections::HashSet::new();
        for _ in 0..32 {
            if sim.step().await.is_none() {
                break;
            }
            ever_served.extend(sim.delta_served_last_flush().to_vec());
        }

        assert_eq!(
            ever_served.len(),
            PEERS,
            "under a turn budget that defers after one peer, only {} of {PEERS} \
             viewers were ever served",
            ever_served.len()
        );
    }

    /// Every keystroke of a typing session reaches the wire on the very next
    /// scheduled flush — exactly, not approximately.
    ///
    /// This is the equality `transport-latency.e2e.ts` cannot express. That test
    /// asks whether keystroke-to-display was under a millisecond bound, on a
    /// host where the same code measured 52 to 176 ms depending on how busy the
    /// machine was; the bound therefore measures the host, and a human has to
    /// interpret a red. Here the question is not "was it fast enough" but "did
    /// the frame wait longer than the scheduler said it would", which has one
    /// right answer at any clock speed.
    ///
    /// Asserted across typing cadences because the interesting cases are the
    /// ones where coalescing changes the answer: keystrokes faster than a flush
    /// interval share a frame, keystrokes slower than one get their own, and
    /// the equality has to hold either way.
    #[tokio::test(flavor = "current_thread")]
    async fn every_keystroke_is_emitted_by_the_next_scheduled_flush() {
        const KEYSTROKES: u32 = 24;

        for gap_ms in [0.0f64, 4.0, 16.0, 50.0] {
            for peers in [1usize, 3] {
                let mut sim = DisplaySim::with_peers(80, 24, peers);
                // Settle the session: the first frame of a fresh peer is not a
                // steady-state keystroke and would skew the first sample.
                sim.write_pty(b"x");
                sim.step_until_emit(8).await;

                let mut samples: Vec<(f64, f64)> = Vec::with_capacity(KEYSTROKES as usize);
                for index in 0..KEYSTROKES {
                    sim.advance_ms(gap_ms);
                    sim.write_pty(format!("{}", index % 10).as_bytes());

                    // The deadline the PTY-read arm just set is the claim under
                    // test. Reading it before the write would see a stale arm.
                    let scheduled = sim
                        .flush_due_in_ms()
                        .expect("a keystroke arms the flush timer");
                    let waited = sim.step_until_emit(16).await.unwrap_or_else(|| {
                        panic!(
                            "keystroke {index} at a {gap_ms}ms cadence with {peers} \
                             viewer(s) never reached the wire"
                        )
                    });
                    samples.push((scheduled, waited));
                }

                assert_eq!(
                    samples.len(),
                    KEYSTROKES as usize,
                    "not every keystroke produced a sample"
                );

                // The equality holds while the coalescing regime is stable. It
                // does not hold across the one keystroke where the scheduler
                // switches interval — see the regime-transition test below,
                // which pins that exception rather than hiding it here.
                let mut transitions = 0;
                for (index, window) in samples.windows(2).enumerate() {
                    let (scheduled, waited) = window[0];
                    let (next_scheduled, _) = window[1];
                    if scheduled != next_scheduled {
                        transitions += 1;
                        continue;
                    }
                    assert_eq!(
                        waited, scheduled,
                        "keystroke {index} at a {gap_ms}ms cadence with {peers} \
                         viewer(s) waited {waited}ms against a scheduled \
                         {scheduled}ms, with no regime change to explain it"
                    );
                }
                assert!(
                    transitions <= 1,
                    "a {gap_ms}ms cadence with {peers} viewer(s) changed coalescing \
                     regime {transitions} times in {KEYSTROKES} keystrokes; the \
                     interval is oscillating rather than settling"
                );
            }
        }
    }

    /// The interactive-to-coalescing switch costs at most one keystroke.
    ///
    /// Sustained typing eventually moves the flush interval off its 1ms
    /// interactive arm onto a ~10ms coalescing one. At that boundary the owner
    /// loop has already armed the short timer, wakes on it, and finds the peer's
    /// pacing interval can move underneath it — so one keystroke may wait
    /// materially longer than the scheduler predicted for it. With a measured
    /// high-refresh presentation period the two deadlines can also coincide,
    /// in which case the transition costs nothing.
    ///
    /// That is a real cost and this test states it rather than smoothing it
    /// away: zero or one keystroke, bounded, once per session. If the switch
    /// ever starts costing several keystrokes, or oscillating, this fails.
    #[tokio::test(flavor = "current_thread")]
    async fn the_coalescing_switch_costs_at_most_one_keystroke() {
        const KEYSTROKES: u32 = 40;
        /// Two coalescing intervals. Generous, and still far below the 52-176ms
        /// spread the wall-clock e2e assertion has to tolerate.
        const TRANSITION_BUDGET_MS: f64 = 32.0;

        let mut sim = DisplaySim::new(80, 24);
        // Sustained output: the regime switch this test is about only exists
        // when there is something to coalesce WITH. With the PTY drained the
        // interactive arm flushes immediately and the boundary never arises,
        // which is the point of the drain predicate, not a property to assert
        // here.
        sim.set_pty_output_pending(true);
        sim.write_pty(b"x");
        sim.step_until_emit(8).await;

        let mut overruns = Vec::new();
        for index in 0..KEYSTROKES {
            sim.advance_ms(4.0);
            sim.write_pty(format!("{}", index % 10).as_bytes());
            let scheduled = sim
                .flush_due_in_ms()
                .expect("a keystroke arms the flush timer");
            let waited = sim
                .step_until_emit(16)
                .await
                .unwrap_or_else(|| panic!("keystroke {index} never reached the wire"));
            if waited != scheduled {
                overruns.push((index, scheduled, waited));
            }
        }

        assert!(
            overruns.len() <= 1,
            "the coalescing switch may affect at most one of {KEYSTROKES} \
             keystrokes, saw {overruns:?}"
        );
        if let Some((index, scheduled, waited)) = overruns.first().copied() {
            assert!(
                waited <= TRANSITION_BUDGET_MS,
                "the coalescing switch at keystroke {index} held a frame for \
                 {waited}ms against a scheduled {scheduled}ms, over the \
                 {TRANSITION_BUDGET_MS}ms this boundary is allowed to cost"
            );
        }
    }

    /// A CTRL snapshot request is answered on the next scheduled flush, so the
    /// only wait it may incur is ordinary pacing. Anything approaching the
    /// snapshot backoff ladder (250ms doubling to 5s) is the stall itself.
    const SNAPSHOT_REQUEST_MAX_WAIT_MS: f64 = 100.0;

    /// A reconnecting browser that omits row hashes is saying its terminal
    /// grid did not survive. Even when the daemon retained an initialized cache
    /// with the same generation and dimensions, the only authoritative answer
    /// is a full reliable snapshot: a full-diff walk against the daemon's own
    /// acknowledged baseline can be empty and would leave the reset browser
    /// blank forever.
    #[tokio::test(flavor = "current_thread")]
    async fn a_claimless_same_cache_resume_commits_a_reliable_snapshot() {
        let mut sim = DisplaySim::new(80, 24);
        let peer = SIM_PEER_ID.to_string();

        sim.deliver_claimless_resume(&peer);

        assert!(
            sim.snapshot_pending(&peer),
            "matching daemon cache coordinates are not a browser grid claim"
        );
        assert!(
            sim.step().await.is_some(),
            "the resume must arm the owner loop"
        );
        assert!(
            !sim.snapshot_pending(&peer),
            "the claimless resume never completed its snapshot"
        );
        assert_eq!(
            sim.wire().len(),
            0,
            "a claimless resume must not masquerade as an incremental datagram diff"
        );
        assert!(
            sim.reliable().iter().any(|frame| frame.peer_id == peer
                && frame.channel_id == crate::network::protocol::CHANNEL_DISPLAY_COMMIT),
            "the real resume/scheduler/send path did not commit a reliable snapshot"
        );
    }

    /// A client snapshot request must be answered even when an earlier snapshot
    /// send left a failure backoff armed.
    ///
    /// This is the shape that froze real sessions. `needs_snapshot` excludes the
    /// peer from the delta loop and a future `snapshot_retry_at_ms` excludes it
    /// from the snapshot path, so with both set the daemon emits *nothing* for
    /// the length of the backoff — up to five seconds, exactly the interval the
    /// browser spends discarding every frame it receives and re-asking. Neither
    /// side is broken on its own; together they hold each other open.
    ///
    /// The request must therefore travel the real CTRL path.
    /// [`DisplaySim::request_snapshot`] pokes the flag directly and cannot
    /// observe this, which is why the harness never caught it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_ctrl_snapshot_request_is_answered_despite_a_send_failure_backoff() {
        let mut sim = DisplaySim::new(80, 24);
        let peer = SIM_PEER_ID.to_string();

        // Far enough out that nothing in this test can reach it by waiting.
        sim.arm_snapshot_backoff(&peer, 5_000.0, 3);
        sim.write_full_screen(b'a');

        sim.deliver_snapshot_request(&peer);

        // The harm is measured in elapsed time, not in eventual arrival. The
        // backoff is a scheduling term (`compute_next_flush_delay_ms`), so the
        // owner loop simply sleeps until the deadline and the snapshot does
        // land — after a wait the user sees as a frozen screen. Asserting the
        // snapshot arrives would pass with the bug present; asserting *when* is
        // what pins it.
        let before_ms = sim.now_ms();
        sim.step().await;
        let waited_ms = sim.now_ms() - before_ms;

        assert!(
            !sim.snapshot_pending(&peer),
            "the peer asked for a snapshot over CTRL and never received one"
        );
        assert!(
            sim.reliable_frames() > 0,
            "needs_snapshot cleared without committing a snapshot to the \
             reliable lane"
        );
        assert!(
            waited_ms < SNAPSHOT_REQUEST_MAX_WAIT_MS,
            "the CTRL snapshot request waited {waited_ms}ms behind a send-failure \
             backoff. Deltas are already gated by needs_snapshot, so this peer \
             received nothing at all for that whole interval — which is the \
             freeze, and it repeats because the browser re-asks on a timer"
        );
    }

    /// A follow-along viewer's write reaches the wire in the turn that applied
    /// it, hinted or not, on an 80 ms path.
    ///
    /// Both arms run the real `flush_display` and the real scheduler under the
    /// simulator's virtual clock, which advances only by
    /// `compute_next_flush_delay_ms`'s own answer — so the number is the
    /// scheduler's, not the harness's. The two pacing controllers this test
    /// used to compare — a 2-16 ms receiver hint and a 2-33 ms RTT-derived
    /// estimate — are both gone; a passive peer is paced by the carrier's
    /// admission and its receive-queue depth, never by a clock.
    #[tokio::test(flavor = "current_thread")]
    async fn a_passive_viewer_is_paced_by_nothing_but_admission() {
        async fn time_to_wire_ms(hinted: bool) -> f64 {
            let mut sim = DisplaySim::new(80, 24);
            let peer = SIM_PEER_ID.to_string();
            // Past the 120ms interactive window, so the passive arm governs.
            sim.advance_ms(500.0);
            sim.configure_passive_viewer(&peer, 80.0, hinted);
            let started_ms = sim.now_ms();
            let baseline_frames = sim.wire().len();
            sim.write_pty(b"x");
            for _ in 0..400 {
                if sim.wire().len() > baseline_frames {
                    break;
                }
                sim.step().await;
            }
            assert!(
                sim.wire().len() > baseline_frames,
                "the write never reached the wire"
            );
            sim.now_ms() - started_ms
        }

        let unhinted_ms = time_to_wire_ms(false).await;
        let hinted_ms = time_to_wire_ms(true).await;
        println!("@@pacing rtt=80ms passive: unhinted={unhinted_ms:.1}ms hinted={hinted_ms:.1}ms");

        for (label, elapsed_ms) in [("unhinted", unhinted_ms), ("hinted", hinted_ms)] {
            assert_eq!(
                elapsed_ms, 0.0,
                "a {label} passive viewer's write must leave in the turn that applied it, \
                 got {elapsed_ms:.1}ms"
            );
        }
    }
    /// Integrations that run the helper `bun run build:image-worker` builds.
    mod real_helper {
        use super::*;
        use crate::pty::{TerminalEvent, Viewport};
        use merkur_graphics::budget::Usage;
        use merkur_graphics::geometry::CellMetrics;

        const COLS: u16 = 80;
        const ROWS: u16 = 8;
        const WAKE_CAP: usize = 4_096;
        /// Placement moves, each flushed before the next.
        const MOVES: usize = 1_024;
        /// Storage left once the images are up: ample for the projection a move
        /// re-mints, and about sixteen moves' rows were superseded rows to stay
        /// charged while a viewer holds them.
        const FREE: Usage = Usage {
            bytes: 64 * 1024,
            objects: 64,
        };
        /// 71 over rows 0-1, and 72's one placement over rows 4-5.
        const SETUP: &[u8] = b"\x1b_Ga=T,f=24,s=1,v=1,i=71,c=2,r=2,C=1,q=2;AAAA\x1b\\\
            \x1b[5;1H\x1b_Ga=T,f=24,s=1,v=1,i=72,p=1,c=2,r=2,C=1,q=2;AQEB\x1b\\";
        /// An upload into what is left, then both originals placed once more.
        const FINISH: &[u8] = b"\x1b[8;1H\x1b_Ga=t,f=24,s=1,v=1,i=73;AgIC\x1b\\\
            \x1b_Ga=p,i=71,p=9,c=1,r=1,C=1\x1b\\\x1b_Ga=p,i=72,p=9,c=1,r=1,C=1\x1b\\";

        fn viewport() -> Viewport {
            Viewport {
                geometry_generation: 1,
                cols: COLS,
                rows: ROWS,
                seq: 1,
                cell: CellMetrics::new(8 << 16, 16 << 16),
                pixel_width: 640,
                pixel_height: 128,
            }
        }

        /// 72's placement moves between rows 2-3 and 4-5: every move supersedes
        /// two graphics rows and mints two, A to B and back to A.
        fn step(index: usize) -> Vec<u8> {
            let line = if index.is_multiple_of(2) { 3 } else { 5 };
            format!("\x1b[{line};1H\x1b_Ga=p,i=72,p=1,c=2,r=2,C=1,q=2\x1b\\").into_bytes()
        }

        /// `write_pty_resuming` on a bare terminal.
        async fn apply(terminal: &mut TerminalState, bytes: &[u8]) {
            let wake = terminal.graphics_wake();
            let mut accepted = terminal.apply_bytes(bytes);
            while terminal.graphics_pending() {
                tokio::time::timeout(std::time::Duration::from_secs(15), async {
                    match terminal.graphics_release() {
                        Some(release) => {
                            release.wait().await;
                            terminal.observe_graphics_release();
                        }
                        None => wake.notified().await,
                    }
                })
                .await
                .expect("the image helper completes or fails every job, and every release lands");
                accepted += terminal.apply_bytes(&bytes[accepted..]);
            }
            assert_eq!(accepted, bytes.len());
        }

        /// The storage a run holds after the moves, and every reply it wrote.
        async fn without_viewers() -> (Usage, Vec<Vec<u8>>) {
            let (tx, rx) = crossbeam_channel::unbounded();
            let mut terminal = TerminalState::new(COLS, ROWS, tx);
            terminal.use_built_image_worker();
            terminal.resize_viewport(viewport());
            apply(&mut terminal, SETUP).await;
            let pressure = terminal.leave_graphics_storage(FREE);
            for index in 0..MOVES {
                apply(&mut terminal, &step(index)).await;
            }
            let used = terminal.graphics_storage_used();
            apply(&mut terminal, FINISH).await;
            let replies = rx
                .try_iter()
                .filter_map(|event| match event {
                    TerminalEvent::PtyWrite(bytes) => Some(bytes),
                    _ => None,
                })
                .collect();
            drop(pressure);
            terminal.shutdown_graphics().await;
            (used, replies)
        }

        /// The same bytes under two viewers that never pump or acknowledge, so
        /// every capture the send path takes stays in their unacknowledged
        /// records until it ages out.
        async fn with_silent_viewers() -> (Usage, Vec<Vec<u8>>) {
            let mut sim = DisplaySim::with_peers(COLS, ROWS, 2);
            sim.use_built_image_worker();
            sim.commit_viewport(viewport());
            sim.write_pty_resuming(SETUP).await;
            sim.run_for_ms(64.0, WAKE_CAP, |_, _| {}).await;
            let pressure = sim.terminal.leave_graphics_storage(FREE);
            for index in 0..MOVES {
                sim.write_pty_resuming(&step(index)).await;
                sim.run_for_ms(4.0, WAKE_CAP, |_, _| {}).await;
            }
            assert!(
                (0..2).all(|index| sim.peer_has_unacked_rows(&sim_peer_id(index))),
                "every viewer is left holding unacknowledged rows"
            );
            let used = sim.terminal.graphics_storage_used();
            sim.write_pty_resuming(FINISH).await;
            let replies = sim.take_pty_replies();
            drop(pressure);
            sim.shutdown_graphics().await;
            (used, replies)
        }

        /// Captures a slow or silent viewer holds share row bytes and versions,
        /// never storage: the projector's charge alone decides what fits, so no
        /// viewer can make it evict an application's original.
        #[tokio::test(flavor = "current_thread")]
        #[ignore = "real helper: bun run build:image-worker"]
        async fn viewers_that_never_acknowledge_change_no_storage_and_no_reply() {
            let alone = without_viewers().await;
            let viewed = with_silent_viewers().await;
            assert_eq!(
                viewed.0, alone.0,
                "silent viewers' unacknowledged rows hold storage"
            );
            assert_eq!(viewed.1, alone.1);
            assert_eq!(
                alone.1,
                [
                    b"\x1b_Gi=73;OK\x1b\\".to_vec(),
                    b"\x1b_Gi=71,p=9;OK\x1b\\".to_vec(),
                    b"\x1b_Gi=72,p=9;OK\x1b\\".to_vec(),
                ]
            );
        }
    }
}
