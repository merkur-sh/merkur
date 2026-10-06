//! The browser half of the display loop, driven natively.
//!
//! # Why this exists
//!
//! [`super::sim`] proves a frame *left* the daemon on time. It cannot prove the
//! viewer saw the right thing — every property it asserts (emission, pacing,
//! deferral, per-keystroke latency) is a proxy for the one that matters:
//! **the viewer's grid agrees with the daemon's.**
//!
//! That is assertable because the browser's terminal is ordinary Rust. This
//! module opens the sealed bytes the send path admitted with the browser half of
//! the same Noise session, feeds them to the real [`term_wasm::Terminal`], and
//! compares row hashes. Both ends call the same `merkur_codec::row_hash`;
//! term-wasm's own `row_hash` exists to compare against the daemon's
//! `display_hash_digest` heartbeats and detect divergence. This asserts the
//! invariant production already relies on — deterministically, and at every
//! flush rather than periodically.
//!
//! Nothing here reimplements a code path. The frame header is read with the
//! daemon's own [`super::encoder::parse_stream_header`], the message types come
//! from `merkur_codec`, and application goes through term-wasm's real staging
//! path.
//!
//! # What it covers that it once did not
//!
//! The first two were listed as gaps here long after they were closed, so they
//! are stated positively rather than deleted.
//!
//! - **FEC repair.** `0x21` frames are decoded through `merkur_fec::repair` —
//!   the shared framing *and* the GF(2^8) solve, the same code the daemon
//!   encodes with — so nothing is forked to make repair testable.
//!   `recovered_by_fec` is asserted non-zero at the higher loss rates, so a
//!   regression in repair cannot hide behind the daemon re-sending.
//! - **Display ACKs.** The viewer acknowledges the newest applied seq with
//!   the selective bitmap below it through the client core's own `AckWindow`,
//!   so the daemon's cache retires rows the way a live session's does instead
//!   of sitting permanently unacked. Each ACK takes [`SIM_ACK_DELAY_MS`] of
//!   virtual time to come back — one per change, the browser's own dedupe —
//!   and is delivered by the simulator at that instant, so the confirmation
//!   delay the daemon measures is the one the viewer modelled. A viewer can
//!   be made slow ([`SIM_SLOW_ACK_DELAY_MS`], the production p90), never
//!   instantaneous: an ACK delivered inside the flush that earned it is a
//!   session no browser has, and it is the one the old harness measured.
//! - **The owner loop's timer.** The simulator holds the armed deadline
//!   between steps and re-arms it from the same sites production does, so a
//!   test can see what the timer does across an ACK or a keystroke that lands
//!   while it is armed — including a parked loop (`run_for_ms` reports
//!   `parked_at_ms`) and a spinning one (its wake cap).
//! - **The generation gate.** A delta from an older generation is dropped, one
//!   from a newer generation waits for the snapshot it overtook, and every
//!   accepted snapshot first resets per-cell ordering, as the terminal worker
//!   does. Once units can arrive late, a harness without it applies deltas
//!   across a lineage no browser would let them reach.
//! - **Disturbed display units.** [`SimViewers::disturb_display_units`] loses,
//!   duplicates and reorders opened units above the transport, the anomalies
//!   wire loss alone cannot produce, and classifies the rows the disturbed
//!   units carried.
//!
//! # What it does not cover
//!
//! - **Queue admission, rendering.** Browser policy, not display-stream
//!   semantics.

use std::collections::{HashMap, HashSet};

use merkur_client::viewer::ack_window::AckWindow;
use merkur_client::viewer::display_serial_is_newer;
use merkur_client::viewer::input_routing::InputRoutingHold;
use merkur_codec::{
    FrameHeader, FrameKind, MSG_TYPE_DISPLAY_FEC_REPAIR, MSG_TYPE_DISPLAY_PATCH,
    STREAM_HEADER_BYTES, parse_frame_header_and_rows_start, parse_stream_header,
};

use super::sim::{DisplaySim, ScheduleRun, frame_loss_value, sim_peer_id};
use crate::connection::{PeerTransport, SimDatagramMetadata, SimDatagramRole};
use crate::display::policy::DisplayPolicy;
use crate::network::protocol::{CHANNEL_DISPLAY_COMMIT, CHANNEL_DISPLAY_DATAGRAM};

/// How long a viewer's acknowledgement takes to reach the daemon, in virtual
/// milliseconds.
///
/// Below `ROW_RESEND_MIN_MS`, so on the default viewer the re-send floor is
/// what binds and an acknowledged row is confirmed before its deadline passes
/// — the steady state a healthy session lives in. Asserted at compile time
/// because nothing at runtime would notice the floor slipping under the
/// delay: every repaint would simply start re-sending rows once before their
/// ACK, and the oracles would measure that as pacing.
pub(crate) const SIM_ACK_DELAY_MS: f64 = 20.0;
const _: () = assert!(SIM_ACK_DELAY_MS < DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS);

/// The production p90 confirmation delay: a viewer slow enough that the
/// measured re-send interval, not the floor, governs — asserted at compile
/// time, or the slow viewer is the default one wearing a different name.
pub(crate) const SIM_SLOW_ACK_DELAY_MS: f64 = 88.7;
const _: () = assert!(SIM_SLOW_ACK_DELAY_MS > DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SimFrameTally {
    pub(crate) packets: usize,
    pub(crate) bytes: usize,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SimDatagramRoleCounters {
    pub(crate) data: SimFrameTally,
    pub(crate) replica: SimFrameTally,
    pub(crate) repair: SimFrameTally,
    pub(crate) probe: SimFrameTally,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SimDatagramPathCounters {
    pub(crate) admitted: SimDatagramRoleCounters,
    pub(crate) delivered: SimDatagramRoleCounters,
    pub(crate) dropped: SimDatagramRoleCounters,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SimTransportCounters {
    pub(crate) admitted_datagram_data: SimFrameTally,
    pub(crate) admitted_datagram_replica: SimFrameTally,
    pub(crate) admitted_datagram_repair: SimFrameTally,
    pub(crate) admitted_datagram_probe: SimFrameTally,
    /// Logical data counts each `(generation, seq)` once even when the sender
    /// physically races it over both paths.
    pub(crate) admitted_logical_datagram_data: SimFrameTally,
    pub(crate) admitted_reliable_data: SimFrameTally,
    pub(crate) admitted_reliable_repair: SimFrameTally,
    pub(crate) delivered_datagram_data: SimFrameTally,
    pub(crate) delivered_datagram_replica: SimFrameTally,
    pub(crate) delivered_datagram_repair: SimFrameTally,
    pub(crate) delivered_datagram_probe: SimFrameTally,
    pub(crate) delivered_reliable_data: SimFrameTally,
    pub(crate) delivered_reliable_repair: SimFrameTally,
    pub(crate) dropped_datagram_data: SimFrameTally,
    pub(crate) dropped_datagram_replica: SimFrameTally,
    pub(crate) dropped_datagram_repair: SimFrameTally,
    pub(crate) dropped_datagram_probe: SimFrameTally,
    pub(crate) webtransport: SimDatagramPathCounters,
    pub(crate) edge: SimDatagramPathCounters,
}

/// A chunk parked until its whole frame has arrived.
struct StagedChunk {
    handle: u32,
    chunk_index: u16,
    seq: u32,
    generation: u32,
    input_seq: u32,
    rows: u16,
    snapshot: bool,
}

/// Allocation-free-in-the-drain instrumentation for browser-visible input.
///
/// `expected_row_hashes[n]` is the exact cumulative typed-row state after
/// input sequence `n + 1`. A display high-water mark alone is insufficient:
/// header-only frames carry it too, and comparing against the daemon's latest
/// row after a whole socket drain turns every key into burst-tail latency.
struct TypingVisibilityProbe {
    row: u16,
    input_origin_ms: Vec<f64>,
    expected_row_hashes: Vec<u64>,
    input_to_apply_ms: Vec<f64>,
}

/// One simulated browser: the real terminal plus the browser half of its Noise
/// session.
pub(crate) struct SimViewer {
    terminal: term_wasm::Terminal,
    transport: crate::e2e::NoiseTransport,
    logical_datagrams: HashSet<(u32, u64)>,
    pending: HashMap<(u32, u32), Vec<StagedChunk>>,
    pub(crate) applied_frames: usize,
    pub(crate) applied_chunks: usize,
    pub(crate) applied_bytes: usize,
    pub(crate) rejected: usize,
    pub(crate) skipped_repair: usize,
    pub(crate) compressed_seen: usize,
    /// Frames that arrived compressed against an installed dictionary.
    pub(crate) dictionary_seen: usize,
    pub(crate) multi_chunk_seen: usize,
    /// Snapshots this viewer applied. Deltas and snapshots are written by
    /// different row encoders, so a test that only ever converges on deltas
    /// leaves half the wire untested.
    pub(crate) snapshots_applied: usize,
    /// Validated staged frames whose application was rejected.
    pub(crate) apply_rejected: usize,
    /// FEC-protected frame plaintexts by display generation and seq, so a
    /// repair can rebuild the ones that never arrived. Every generation
    /// restarts its seqs, and a repair names its own generation, so a
    /// seq-only key would rebuild a new group from an old generation's frames.
    /// Bounded to the retention window below.
    retained: std::collections::BTreeMap<(u32, u32), Vec<u8>>,
    pub(crate) recovered_by_fec: usize,
    /// The client core's selective acknowledgement window over the applied
    /// sequences of `ack_generation`: anchored at the newest and counting down,
    /// so a hole is reported as a hole rather than papered over by a
    /// cumulative high-water mark. Seq space resets per generation.
    ack: AckWindow,
    ack_generation: u32,
    /// Whether the window changed since the last acknowledgement was sent.
    /// The browser sends one ACK per change, not one per frame and not one
    /// per drain, so `acknowledge` enqueues only when this is set.
    ack_pending: bool,
    /// How long this viewer's acknowledgements take to reach the daemon.
    ack_delay_ms: f64,
    /// Hash-digest bodies received on the control lane, awaiting comparison.
    digests: Vec<Vec<u8>>,
    /// Digests this viewer has ever been sent. `digests` is drained by
    /// `answer_digests`, so it cannot answer "did the backstop fire at all" —
    /// which is the only question that separates a backstop that agreed with
    /// the viewer from one that was never emitted.
    pub(crate) digests_seen: usize,
    /// Frame plaintexts, recorded only when a diagnostic asks for them.
    pub(crate) captured: Vec<Vec<u8>>,
    /// Sealed wire bytes split by message type, for parity accounting.
    pub(crate) rows_applied: usize,
    pub(crate) patch_wire_bytes: usize,
    pub(crate) replica_wire_bytes: usize,
    pub(crate) repair_wire_bytes: usize,
    pub(crate) probe_wire_bytes: usize,
    pub(crate) patch_wire_datagrams: usize,
    pub(crate) replica_wire_datagrams: usize,
    pub(crate) repair_wire_datagrams: usize,
    pub(crate) probe_wire_datagrams: usize,
    pub(crate) transport_counters: SimTransportCounters,
    /// Scratch for `recover_batch_into`, kept so recovery allocates nothing per
    /// repair — the same property the browser needs draining a socket.
    fec_padded: Vec<u8>,
    fec_output: Vec<u8>,
    /// Dictionary ids this viewer's terminal actually installed, awaiting
    /// the acknowledgement the browser would send.
    installed_dictionaries: Vec<u32>,
    /// Exact finalized bytes used to inspect dictionary-compressed frames in
    /// the native harness. Bounded to the same current+previous lifetime as
    /// term-wasm's dictionary slots.
    dictionary_bytes: std::collections::BTreeMap<u32, Vec<u8>>,
    /// Highest input sequence any applied frame said authority covers — the
    /// worker's `authoritativeInputHighWater`, read from the same field.
    pub(crate) authoritative_input_seq: u32,
    /// Highest echo horizon any applied frame carried — the worker's
    /// `authoritativeEchoHorizon`.
    pub(crate) authoritative_echo_horizon: u32,
    /// Optional exact-row milestone recorder used by the link profiles. Its
    /// vectors are sized before traffic begins; successful applies only hash
    /// one row and append into reserved capacity.
    typing_visibility_probe: Option<TypingVisibilityProbe>,
    /// Prompt anchors the daemon published on the control lane, and the last
    /// one adopted. Only the count is a test signal; the anchor itself goes
    /// straight into the terminal, as `handleEditorAnchor` does.
    pub(crate) editor_anchors_seen: usize,
    /// Generation of the snapshot lineage deltas apply in: the terminal
    /// worker's `displayEpoch.generation`. Seeded from the primed peer, whose
    /// blank grid this viewer starts out holding.
    display_generation: u32,
    /// Deltas that overtook their own generation's snapshot, replayed in
    /// arrival order once it applies, as the worker's ahead-delta buffer is.
    ahead: Vec<Vec<u8>>,
    /// Refusals the terminal worker answers by abandoning its lineage and
    /// requesting a snapshot (`beginDisplayResync`): every validation or apply
    /// refusal except `display_dimensions_mismatch`, which it drops without one.
    pub(crate) display_resyncs: usize,
    /// Deltas refused as `display_dimensions_mismatch`: in flight across a
    /// local resize, never acknowledged, and re-sent by the daemon.
    pub(crate) dimension_mismatches: usize,
    /// Deltas that arrived on the reliable lane: jumbo rows, too large for
    /// any datagram, which the daemon commits atomically instead of splitting.
    pub(crate) reliable_deltas: usize,
    /// Display units the disturbance model holds back, each with the number of
    /// later arrivals it still waits behind.
    held: Vec<(u32, Vec<u8>)>,
    /// What the disturbance model did to this viewer's display units.
    pub(crate) disturbed: UnitDisturbanceTally,
    /// The graphics section the latest opened unit carried for each
    /// `(generation, row)`, which is what classifies a disturbed unit's rows.
    unit_graphics: HashMap<(u32, u16), Vec<u8>>,
    /// Input-routing words the daemon sent on the control lane. A word the
    /// viewer takes goes straight into the terminal's mode word, as
    /// `handleInputRouting` does.
    pub(crate) input_routing_seen: usize,
    /// The client core's hold on the routing word over the headers of frames
    /// sent before it.
    input_routing: InputRoutingHold,
    /// Display demand read from applied frames.
    demand: SimDemandObservation,
    /// The worker's complete-screen rule, run against this terminal.
    pub(crate) closure: ClosurePresentation,
    /// The worker's presentation release rule: every renderer commit.
    pub(crate) presentation: presentation::SimPresentation,
    /// Applied delta frames that carried no row: a header on its own.
    pub(crate) header_only_applied: usize,
}

/// The worker's complete-screen presentation rule, run against the real
/// terminal: only the newest applied sequence's closure claim speaks for the
/// grid, and a claimed screen is published only once the grid digests to it.
/// Every publication keeps the exact rows it showed, so a test compares them
/// with screens the daemon actually held rather than trusting the digest.
///
/// `end_published` is the causal control: the rows the ordinary advisory rule
/// would expose when a presentation group's END applies. It needs no claim, and
/// under loss or clipping it is the partial screen the claim exists to hide.
#[derive(Default)]
pub(crate) struct ClosurePresentation {
    generation: u32,
    seq: u32,
    claim: u64,
    /// A claim is live and the grid does not digest to it.
    pub(crate) pending: bool,
    /// `(claim, row hashes)` of every screen published because its claim matched.
    pub(crate) published: Vec<(u64, Vec<u64>)>,
    /// Row hashes an END-quiet publication would have shown, in order.
    pub(crate) end_published: Vec<Vec<u64>>,
    /// Applies that left the newest claim unmet: state the rule kept offscreen.
    pub(crate) held_applies: usize,
    /// Applies whose newest frame claimed nothing (ordinary output).
    pub(crate) unclaimed_applies: usize,
    /// Distinct claims the newest applied frame carried.
    pub(crate) claims_seen: usize,
    /// ACK windows this viewer sent while a claim was unmet.
    pub(crate) acks_while_pending: usize,
    /// Lose the next claimed frame that carries END, once: the final member
    /// of a synchronized redraw never arrives as sent.
    pub(crate) lose_next_claimed_end: bool,
    /// Claimed END frames lost that way.
    pub(crate) claimed_ends_lost: usize,
}

/// The first applied datagram of one display state, as the browser's demand
/// controller sees it arrive.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SimDemandArrival {
    pub(crate) at_ms: f64,
    pub(crate) generation: u32,
    pub(crate) serial: u32,
    pub(crate) limited: bool,
    pub(crate) prompt: bool,
}

/// The newest demand serial a viewer has applied, every state arrival, and
/// every applied datagram's demand fields in order: the browser's controller
/// reads each one (a repeated serial still carries the limited flag), so a
/// model of it needs them all.
#[derive(Clone, Debug, Default)]
pub(crate) struct SimDemandObservation {
    pub(crate) generation: u32,
    pub(crate) seen: u32,
    pub(crate) limited: bool,
    pub(crate) arrivals: Vec<SimDemandArrival>,
    pub(crate) applied: Vec<SimDemandArrival>,
}

/// Seeded disturbance of display units where a browser's display layer meets
/// them: after its transport opened the datagram. A unit is lost, delivered
/// twice, or held behind later arrivals. The fate is a pure function of the
/// sender's stable datagram identity, through the same [`frame_loss_value`] the
/// wire loss model uses, so inserting unrelated traffic cannot move it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct UnitDisturbance {
    pub(crate) seed: u64,
    pub(crate) loss_pct: u32,
    pub(crate) duplicate_pct: u32,
    pub(crate) reorder_pct: u32,
}

enum UnitFate {
    Deliver,
    Lose,
    /// Delivered now, and again after this many later arrivals.
    Duplicate(u32),
    /// Delivered after this many later arrivals.
    Reorder(u32),
}

impl UnitDisturbance {
    fn fate(self, metadata: &SimDatagramMetadata) -> UnitFate {
        let value = frame_loss_value(self.seed, metadata);
        let draw = |shift: u32| (value >> shift) % 100;
        let distance = 1 + ((value >> 48) % 4) as u32;
        if draw(0) < u64::from(self.loss_pct) {
            UnitFate::Lose
        } else if draw(16) < u64::from(self.duplicate_pct) {
            UnitFate::Duplicate(distance)
        } else if draw(32) < u64::from(self.reorder_pct) {
            UnitFate::Reorder(distance)
        } else {
            UnitFate::Deliver
        }
    }
}

/// Disturbed display units, and how many carried the row shapes graphics
/// recovery depends on. A disturbance that never touched those shapes proves
/// nothing about them.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DisturbedUnits {
    pub(crate) units: usize,
    /// Units carrying a graphics-only row change: the one-cell text span at
    /// column zero the daemon sends with a changed graphics replacement.
    pub(crate) graphics_only: usize,
    /// Units carrying an explicit empty graphics set for a row whose previous
    /// unit carried graphics.
    pub(crate) empty_replacements: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct UnitDisturbanceTally {
    /// Every opened unit, whatever its fate: the population the three
    /// disturbances below were drawn from.
    pub(crate) arrived: DisturbedUnits,
    pub(crate) lost: DisturbedUnits,
    pub(crate) duplicated: DisturbedUnits,
    pub(crate) reordered: DisturbedUnits,
}

/// The row shapes one display unit carries.
#[derive(Clone, Copy, Default)]
struct UnitShape {
    graphics_only: bool,
    empty_replacement: bool,
}

impl DisturbedUnits {
    fn count(&mut self, shape: UnitShape) {
        self.units += 1;
        self.graphics_only += usize::from(shape.graphics_only);
        self.empty_replacements += usize::from(shape.empty_replacement);
    }
}

/// How many recent FEC-protected frames a viewer keeps for repair. A batch is
/// at most `FEC_MAX_DATA` frames and repairs follow their batch immediately, so
/// this is generous; it exists to bound the map, not to tune recovery.
const FEC_RETENTION: usize = 64;

impl SimViewer {
    fn arm_typing_visibility_probe(
        &mut self,
        row: u16,
        input_origin_ms: Vec<f64>,
        expected_row_hashes: Vec<u64>,
    ) {
        assert_eq!(input_origin_ms.len(), expected_row_hashes.len());
        let input_to_apply_ms = Vec::with_capacity(expected_row_hashes.len());
        self.typing_visibility_probe = Some(TypingVisibilityProbe {
            row,
            input_origin_ms,
            expected_row_hashes,
            input_to_apply_ms,
        });
    }

    fn typing_visibility_complete(&self) -> bool {
        self.typing_visibility_probe
            .as_ref()
            .is_some_and(|probe| probe.input_to_apply_ms.len() == probe.expected_row_hashes.len())
    }

    fn take_typing_visibility_latencies(&mut self) -> Vec<f64> {
        self.typing_visibility_probe
            .take()
            .expect("typing visibility probe is armed")
            .input_to_apply_ms
    }

    fn typing_row_hash(&mut self) -> Option<u64> {
        let row = self.typing_visibility_probe.as_ref()?.row;
        Some(self.terminal.row_hash(row))
    }

    /// Record milestones only at the apply that visibly advances the probed
    /// row to the exact state advertised by this frame's input high-water.
    /// Calling this exclusively from successful, row-bearing apply branches
    /// excludes rejected and header-only frames by construction.
    fn note_typing_visibility(
        &mut self,
        input_seq: u32,
        now_ms: f64,
        row_count: u16,
        row_hash_before: Option<u64>,
    ) {
        if row_count == 0 {
            return;
        }
        let Some(row_hash_before) = row_hash_before else {
            return;
        };
        let Some(probe) = self.typing_visibility_probe.as_ref() else {
            return;
        };
        let covered = usize::try_from(input_seq)
            .unwrap_or(usize::MAX)
            .min(probe.expected_row_hashes.len());
        if covered <= probe.input_to_apply_ms.len() {
            return;
        }
        let row = probe.row;
        let expected = probe.expected_row_hashes[covered - 1];
        let row_hash_after = self.terminal.row_hash(row);
        if row_hash_after == row_hash_before || row_hash_after != expected {
            return;
        }

        let probe = self
            .typing_visibility_probe
            .as_mut()
            .expect("probe was present above");
        while probe.input_to_apply_ms.len() < covered {
            let index = probe.input_to_apply_ms.len();
            probe
                .input_to_apply_ms
                .push(now_ms - probe.input_origin_ms[index]);
        }
    }

    /// Record the display demand an applied datagram carried, exactly as the
    /// browser's demand controller reads it (`display-demand.ts`).
    fn note_demand(
        &mut self,
        generation: u32,
        serial: u32,
        limited: bool,
        prompt: bool,
        now_ms: f64,
    ) {
        if generation != self.demand.generation {
            self.demand.generation = generation;
            self.demand.seen = 0;
            self.demand.limited = false;
        }
        self.demand.applied.push(SimDemandArrival {
            at_ms: now_ms,
            generation,
            serial,
            limited,
            prompt,
        });
        if serial == 0 {
            return;
        }
        if serial == self.demand.seen {
            self.demand.limited = limited;
            return;
        }
        if !display_serial_is_newer(serial, self.demand.seen) {
            return;
        }
        self.demand.seen = serial;
        self.demand.limited = limited;
        self.demand.arrivals.push(SimDemandArrival {
            at_ms: now_ms,
            generation,
            serial,
            limited,
            prompt,
        });
    }

    /// Demand this viewer has observed on applied frames.
    pub(crate) fn demand(&self) -> &SimDemandObservation {
        &self.demand
    }

    /// Note an applied sequence in the acknowledgement window; an ACK is owed
    /// only when that changed the window.
    fn note_applied(&mut self, seq: u32, generation: u32, recovered: bool) {
        if generation != self.ack_generation {
            self.ack_generation = generation;
            self.ack.reset();
        }
        let window = |ack: &AckWindow| (ack.largest(), ack.received(), ack.recovered());
        let before = window(&self.ack);
        self.ack.note(seq, recovered);
        self.ack_pending |= window(&self.ack) != before;
    }

    /// Make this viewer's acknowledgements take `delay_ms` to come back.
    ///
    /// Zero is refused. An ACK delivered inside the flush that earned it is
    /// a session no browser has — every row is confirmed before the scheduler
    /// is ever asked — and it is exactly the session the old harness measured
    /// while the clipped-repaint pacing defect stayed invisible.
    pub(crate) fn set_ack_delay_ms(&mut self, delay_ms: f64) {
        assert!(
            delay_ms > 0.0 && delay_ms.is_finite(),
            "a viewer's acknowledgement takes time to come back; {delay_ms} ms is not a delay"
        );
        self.ack_delay_ms = delay_ms;
    }

    /// The browser's terminal, for the half of the browser this module does
    /// not itself model: speculative echo is driven by the worker's control
    /// loop, which lives in `cursor_lab`.
    pub(crate) fn terminal_mut(&mut self) -> &mut term_wasm::Terminal {
        &mut self.terminal
    }

    /// Attempt to open bytes under this viewer's session. Used only to prove
    /// cross-viewer isolation.
    pub(crate) fn open_for_test(
        &mut self,
        lane: usize,
        framed: &[u8],
    ) -> Result<Vec<u8>, crate::e2e::OpenReject> {
        self.transport.open_datagram(lane, framed)
    }

    fn row_hashes(&mut self, rows: u16) -> Vec<u64> {
        (0..rows).map(|row| self.terminal.row_hash(row)).collect()
    }

    /// Run the worker's release rule over one applied frame of `generation`,
    /// its newest sequence `seq` carrying `rows` rows, committing the grid when
    /// it releases in this task.
    fn note_presentation(
        &mut self,
        header: &FrameHeader,
        generation: u32,
        seq: u32,
        rows: u32,
        snapshot: bool,
        now_ms: f64,
    ) {
        self.header_only_applied += usize::from(!snapshot && rows == 0);
        if snapshot {
            self.presentation.root(generation);
        }
        let visual = self.terminal.last_apply_visually_changed();
        if let Some(reason) = self
            .presentation
            .applied(header, generation, seq, rows, visual, now_ms)
        {
            let screen = self.row_hashes(self.terminal.rows());
            self.presentation.commit(now_ms, reason, true, screen);
        }
    }

    /// One animation frame of this viewer's worker: the frame rule's commit.
    pub(crate) fn present_frame(&mut self, frame_ms: f64) {
        if let Some(reason) = self.presentation.frame(frame_ms) {
            let screen = self.row_hashes(self.terminal.rows());
            self.presentation.commit(frame_ms, reason, false, screen);
        }
    }

    /// Run the worker's closure rule after a frame of `generation`/`seq`
    /// applied carrying `header`: adopt its claim only if it is the newest
    /// sequence, then publish the grid exactly when it digests to that claim.
    fn note_closure(&mut self, generation: u32, seq: u32, snapshot: bool, header: &FrameHeader) {
        let rows = self.terminal.rows();
        let model = &mut self.closure;
        if snapshot || generation != model.generation {
            model.generation = generation;
            model.seq = 0;
            model.claim = 0;
        }
        if !snapshot && (model.seq == 0 || display_serial_is_newer(seq, model.seq)) {
            model.seq = seq;
            if header.closure_digest != 0 && header.closure_digest != model.claim {
                model.claims_seen += 1;
            }
            model.claim = header.closure_digest;
        }
        if header.presentation_end {
            let screen = self.row_hashes(rows);
            self.closure.end_published.push(screen);
        }
        let claim = self.closure.claim;
        if claim == 0 {
            self.closure.pending = false;
            self.closure.unclaimed_applies += 1;
            return;
        }
        let matched = self
            .terminal
            .closure_digest_matches((claim >> 32) as u32, claim as u32);
        if matched {
            let screen = self.row_hashes(rows);
            let model = &mut self.closure;
            if model.published.last() != Some(&(claim, screen.clone())) {
                model.published.push((claim, screen));
            }
        } else {
            self.closure.held_applies += 1;
        }
        self.closure.pending = !matched;
    }
}

/// Every viewer in a session, pumped together from the shared wire.
pub(crate) struct SimViewers {
    viewers: HashMap<String, SimViewer>,
    wire_cursor: usize,
    dropped_cursor: usize,
    reliable_cursor: usize,
    rows: u16,
    disturbance: Option<UnitDisturbance>,
}

impl SimViewers {
    /// Attach one viewer per simulated peer, taking each peer's browser
    /// transport out of the session.
    pub(crate) fn attach(sim: &mut DisplaySim, cols: u16, rows: u16) -> Self {
        let mut viewers = HashMap::new();
        for index in 0..sim.peer_count() {
            let peer_id = sim_peer_id(index);
            let transport = sim
                .take_browser(&peer_id)
                .expect("every simulated peer has a browser transport");
            let display_generation = sim.peer_generation(&peer_id);
            viewers.insert(
                peer_id,
                SimViewer {
                    terminal: term_wasm::Terminal::new_headless(cols, rows),
                    transport,
                    logical_datagrams: HashSet::new(),
                    pending: HashMap::new(),
                    applied_frames: 0,
                    applied_chunks: 0,
                    applied_bytes: 0,
                    rejected: 0,
                    skipped_repair: 0,
                    compressed_seen: 0,
                    dictionary_seen: 0,
                    multi_chunk_seen: 0,
                    snapshots_applied: 0,
                    apply_rejected: 0,
                    retained: std::collections::BTreeMap::new(),
                    recovered_by_fec: 0,
                    ack: AckWindow::default(),
                    ack_generation: 0,
                    ack_pending: false,
                    ack_delay_ms: SIM_ACK_DELAY_MS,
                    digests: Vec::new(),
                    digests_seen: 0,
                    captured: Vec::new(),
                    rows_applied: 0,
                    patch_wire_bytes: 0,
                    replica_wire_bytes: 0,
                    repair_wire_bytes: 0,
                    probe_wire_bytes: 0,
                    patch_wire_datagrams: 0,
                    replica_wire_datagrams: 0,
                    repair_wire_datagrams: 0,
                    probe_wire_datagrams: 0,
                    transport_counters: SimTransportCounters::default(),
                    fec_padded: Vec::new(),
                    fec_output: Vec::new(),
                    installed_dictionaries: Vec::new(),
                    dictionary_bytes: std::collections::BTreeMap::new(),
                    authoritative_input_seq: 0,
                    authoritative_echo_horizon: 0,
                    typing_visibility_probe: None,
                    editor_anchors_seen: 0,
                    display_generation,
                    ahead: Vec::new(),
                    display_resyncs: 0,
                    dimension_mismatches: 0,
                    reliable_deltas: 0,
                    held: Vec::new(),
                    disturbed: UnitDisturbanceTally::default(),
                    unit_graphics: HashMap::new(),
                    input_routing_seen: 0,
                    input_routing: InputRoutingHold::default(),
                    demand: SimDemandObservation::default(),
                    closure: ClosurePresentation::default(),
                    presentation: presentation::SimPresentation::new(display_generation),
                    header_only_applied: 0,
                },
            );
        }
        Self {
            viewers,
            wire_cursor: 0,
            dropped_cursor: 0,
            reliable_cursor: 0,
            rows,
            disturbance: None,
        }
    }

    /// Disturb every display unit these viewers open from now on. Wire loss
    /// (`DisplaySim::set_loss`) models physical datagrams and never opens them;
    /// this models what a display layer sees above a transport that delivered
    /// them late, twice, or not at all.
    pub(crate) fn disturb_display_units(&mut self, disturbance: UnitDisturbance) {
        self.disturbance = Some(disturbance);
    }

    pub(crate) fn viewer(&mut self, peer_id: &str) -> &mut SimViewer {
        self.viewers.get_mut(peer_id).expect("viewer exists")
    }

    pub(crate) fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.viewers.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Deliver everything admitted since the last pump, in wire order.
    ///
    /// A failure to open or apply is a hard failure, never a silent skip. A
    /// harness that swallows those is precisely how a convergence test becomes a
    /// tautology.
    pub(crate) fn pump(&mut self, sim: &DisplaySim) {
        self.pump_datagrams(sim);
        self.pump_reliable(sim);
    }

    /// Deliver the datagram lane alone. Nothing orders it against the reliable
    /// streams, so a test may deliver either first.
    pub(crate) fn pump_datagrams(&mut self, sim: &DisplaySim) {
        // Inspect sender-admitted datagrams in their original sequence.
        // Dropped frames are classified entirely from sender metadata and never
        // opened, matching a real receiver's Noise replay state exactly.
        loop {
            let next_wire = sim.wire().get(self.wire_cursor);
            let next_dropped = sim.dropped_wire().get(self.dropped_cursor);
            if next_dropped
                .is_some_and(|dropped| next_wire.is_none_or(|wire| dropped.index < wire.index))
            {
                let frame = next_dropped.expect("dropped frame was present");
                self.dropped_cursor += 1;
                let Some(viewer) = self.viewers.get_mut(&frame.peer_id) else {
                    continue;
                };
                Self::process_datagram(
                    viewer,
                    &frame.bytes,
                    frame.len,
                    &frame.metadata,
                    false,
                    &frame.peer_id,
                    self.rows,
                    sim.now_ms(),
                    self.disturbance,
                );
                continue;
            }
            let Some(frame) = next_wire else {
                break;
            };
            if frame.deliver_at_ms > sim.now_ms() {
                break;
            }
            self.wire_cursor += 1;
            assert_eq!(
                frame.bytes.first().copied(),
                Some(CHANNEL_DISPLAY_DATAGRAM),
                "a datagram reached the wire on an unexpected channel"
            );
            let Some(viewer) = self.viewers.get_mut(&frame.peer_id) else {
                continue;
            };
            Self::process_datagram(
                viewer,
                &frame.bytes,
                frame.len,
                &frame.metadata,
                true,
                &frame.peer_id,
                self.rows,
                sim.now_ms(),
                self.disturbance,
            );
        }
    }

    /// Deliver the reliable lanes alone, control and display commit, in send
    /// order.
    pub(crate) fn pump_reliable(&mut self, sim: &DisplaySim) {
        while self.reliable_cursor < sim.reliable().len() {
            let frame = &sim.reliable()[self.reliable_cursor];
            if frame.deliver_at_ms > sim.now_ms() {
                break;
            }
            self.reliable_cursor += 1;
            // The control lane carries the hash-digest backstop.
            if frame.channel_id == crate::network::protocol::CHANNEL_CTRL {
                let lane = crate::e2e::lane_for_channel(crate::network::protocol::CHANNEL_CTRL)
                    .expect("ctrl lane");
                let Some(viewer) = self.viewers.get_mut(&frame.peer_id) else {
                    continue;
                };
                if let Ok(plain) = viewer.transport.open_stream(lane, &frame.bytes) {
                    // [msg_type:1][len_be24:3][body...]
                    if plain.len() > 4
                        && plain[0] == crate::network::protocol::MSG_TYPE_DISPLAY_HASH_DIGEST
                    {
                        viewer.digests.push(plain[4..].to_vec());
                        viewer.digests_seen += 1;
                    } else if plain[0] == crate::network::protocol::MSG_TYPE_DISPLAY_DICT_INSTALL {
                        Self::install_dictionary(viewer, &plain);
                    } else if plain[0] == crate::network::protocol::MSG_TYPE_EDITOR_ANCHOR {
                        Self::adopt_editor_anchor(viewer, &plain);
                    } else if plain[0] == crate::network::protocol::MSG_TYPE_INPUT_ROUTING {
                        Self::adopt_input_routing(viewer, &plain);
                    }
                }
                continue;
            }
            if frame.channel_id != CHANNEL_DISPLAY_COMMIT {
                continue;
            }
            let lane =
                crate::e2e::lane_for_channel(CHANNEL_DISPLAY_COMMIT).expect("display commit lane");
            let Some(viewer) = self.viewers.get_mut(&frame.peer_id) else {
                continue;
            };
            let plain = viewer
                .transport
                .open_stream(lane, &frame.bytes)
                .unwrap_or_else(|error| {
                    panic!(
                        "viewer {} could not open a reliable frame sealed for it: {error:?}",
                        frame.peer_id
                    )
                });
            let repair = parse_stream_header(&plain)
                .is_some_and(|header| header.msg_type == MSG_TYPE_DISPLAY_FEC_REPAIR);
            Self::count_reliable(viewer, repair, frame.len);
            viewer.reliable_deltas += usize::from(
                !repair
                    && parse_frame_header_and_rows_start(&plain)
                        .is_ok_and(|(header, _)| matches!(header.kind, FrameKind::Delta)),
            );
            // A reliable frame is never disturbed, but it is a row's latest
            // version all the same, so it moves what the next unit is judged by.
            if self.disturbance.is_some() {
                Self::classify_unit(viewer, &plain);
            }
            Self::deliver(viewer, &plain, self.rows, false, sim.now_ms());
        }
    }

    fn add(tally: &mut SimFrameTally, bytes: usize) {
        tally.packets += 1;
        tally.bytes += bytes;
    }

    fn process_datagram(
        viewer: &mut SimViewer,
        bytes: &[u8],
        byte_len: usize,
        metadata: &SimDatagramMetadata,
        delivered: bool,
        peer_id: &str,
        rows: u16,
        now_ms: f64,
        disturbance: Option<UnitDisturbance>,
    ) {
        assert_eq!(
            bytes.first().copied(),
            Some(CHANNEL_DISPLAY_DATAGRAM),
            "a datagram reached the wire on an unexpected channel"
        );
        Self::count_datagram(viewer, metadata, byte_len, delivered);
        if !delivered {
            return;
        }

        let lane =
            crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).expect("display datagram lane");
        let plain = match viewer.transport.open_datagram(lane, &bytes[1..]) {
            Ok(plain) => plain,
            Err(crate::e2e::OpenReject::Replay) if metadata.role == SimDatagramRole::Replica => {
                Self::count_wire_datagram(viewer, metadata.role, byte_len);
                return;
            }
            Err(error) => {
                panic!("viewer {peer_id} could not open a datagram sealed for it: {error:?}")
            }
        };
        let repair = parse_stream_header(&plain)
            .is_some_and(|header| header.msg_type == MSG_TYPE_DISPLAY_FEC_REPAIR);
        assert_eq!(
            repair,
            metadata.role == SimDatagramRole::Repair,
            "sender role metadata disagrees with the admitted display message"
        );
        Self::count_wire_datagram(viewer, metadata.role, byte_len);
        match disturbance {
            Some(disturbance) => Self::arrive(viewer, plain, metadata, disturbance, rows, now_ms),
            None => Self::deliver(viewer, &plain, rows, false, now_ms),
        }
    }

    /// Hand an opened unit to the display layer through the disturbance model:
    /// lose it, deliver it twice, or hold it behind later arrivals. Units held
    /// earlier count this arrival first, and any it releases land after it,
    /// which is what makes a hold a reordering rather than a delay.
    fn arrive(
        viewer: &mut SimViewer,
        plain: Vec<u8>,
        metadata: &SimDatagramMetadata,
        disturbance: UnitDisturbance,
        rows: u16,
        now_ms: f64,
    ) {
        for (remaining, _) in &mut viewer.held {
            *remaining -= 1;
        }
        let shape = Self::classify_unit(viewer, &plain);
        viewer.disturbed.arrived.count(shape);
        match disturbance.fate(metadata) {
            UnitFate::Deliver => Self::deliver(viewer, &plain, rows, false, now_ms),
            UnitFate::Lose => viewer.disturbed.lost.count(shape),
            UnitFate::Duplicate(after) => {
                viewer.disturbed.duplicated.count(shape);
                Self::deliver(viewer, &plain, rows, false, now_ms);
                viewer.held.push((after, plain));
            }
            UnitFate::Reorder(after) => {
                viewer.disturbed.reordered.count(shape);
                viewer.held.push((after, plain));
            }
        }
        while let Some(index) = viewer
            .held
            .iter()
            .position(|(remaining, _)| *remaining == 0)
        {
            let (_, unit) = viewer.held.remove(index);
            Self::deliver(viewer, &unit, rows, false, now_ms);
        }
    }

    /// The row shapes a unit carries, judged against the latest version of
    /// each row any earlier unit carried, which this then records.
    ///
    /// A graphics-only change is the one-cell span at column zero the daemon
    /// sends beside a changed graphics replacement; an empty replacement is an
    /// explicit empty set where the row's previous unit carried graphics.
    fn classify_unit(viewer: &mut SimViewer, plain: &[u8]) -> UnitShape {
        let mut shape = UnitShape::default();
        let Some(stream) = parse_stream_header(plain) else {
            return shape;
        };
        if stream.msg_type != MSG_TYPE_DISPLAY_PATCH {
            return shape;
        }
        let (header, rows_start) = parse_frame_header_and_rows_start(plain)
            .unwrap_or_else(|error| panic!("a unit with an unreadable frame header: {error:?}"));
        assert_eq!(
            stream.flags & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
            0,
            "unit classification reads plain zstd only; this session installed a dictionary"
        );
        let decompressed;
        let (rows, start) = if stream.flags & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD != 0
        {
            decompressed = crate::display::compressor::decode_display_payload(plain, None)
                .expect("the daemon compressed a well-formed row payload");
            (decompressed.as_slice(), 0)
        } else {
            (plain, rows_start)
        };
        for entry in merkur_codec::iter_rows_at(rows, start, header.row_count) {
            let entry = entry.expect("the daemon encodes well-formed rows");
            let key = (stream.generation, entry.row_index);
            let previous = viewer.unit_graphics.get(&key);
            shape.empty_replacement |=
                entry.graphics.is_empty() && previous.is_some_and(|graphics| !graphics.is_empty());
            shape.graphics_only |= (entry.left, entry.right) == (0, 0)
                && previous.map_or(!entry.graphics.is_empty(), |graphics| {
                    graphics.as_slice() != entry.graphics
                });
            viewer.unit_graphics.insert(key, entry.graphics.to_vec());
        }
        shape
    }

    fn count_wire_datagram(viewer: &mut SimViewer, role: SimDatagramRole, bytes: usize) {
        match role {
            SimDatagramRole::Data => {
                viewer.patch_wire_bytes += bytes;
                viewer.patch_wire_datagrams += 1;
            }
            SimDatagramRole::Replica => {
                viewer.replica_wire_bytes += bytes;
                viewer.replica_wire_datagrams += 1;
            }
            SimDatagramRole::Repair => {
                viewer.repair_wire_bytes += bytes;
                viewer.repair_wire_datagrams += 1;
            }
            SimDatagramRole::Probe => {
                viewer.probe_wire_bytes += bytes;
                viewer.probe_wire_datagrams += 1;
            }
        }
    }

    fn role_tally(
        counters: &mut SimDatagramRoleCounters,
        role: SimDatagramRole,
    ) -> &mut SimFrameTally {
        match role {
            SimDatagramRole::Data => &mut counters.data,
            SimDatagramRole::Replica => &mut counters.replica,
            SimDatagramRole::Repair => &mut counters.repair,
            SimDatagramRole::Probe => &mut counters.probe,
        }
    }

    fn count_datagram(
        viewer: &mut SimViewer,
        metadata: &SimDatagramMetadata,
        bytes: usize,
        delivered: bool,
    ) {
        if metadata.role == SimDatagramRole::Data
            && viewer
                .logical_datagrams
                .insert((metadata.generation, metadata.logical_ordinal))
        {
            Self::add(
                &mut viewer.transport_counters.admitted_logical_datagram_data,
                bytes,
            );
        }
        let counters = &mut viewer.transport_counters;
        Self::add(
            match metadata.role {
                SimDatagramRole::Data => &mut counters.admitted_datagram_data,
                SimDatagramRole::Replica => &mut counters.admitted_datagram_replica,
                SimDatagramRole::Repair => &mut counters.admitted_datagram_repair,
                SimDatagramRole::Probe => &mut counters.admitted_datagram_probe,
            },
            bytes,
        );
        Self::add(
            match (metadata.role, delivered) {
                (SimDatagramRole::Data, true) => &mut counters.delivered_datagram_data,
                (SimDatagramRole::Replica, true) => &mut counters.delivered_datagram_replica,
                (SimDatagramRole::Repair, true) => &mut counters.delivered_datagram_repair,
                (SimDatagramRole::Probe, true) => &mut counters.delivered_datagram_probe,
                (SimDatagramRole::Data, false) => &mut counters.dropped_datagram_data,
                (SimDatagramRole::Replica, false) => &mut counters.dropped_datagram_replica,
                (SimDatagramRole::Repair, false) => &mut counters.dropped_datagram_repair,
                (SimDatagramRole::Probe, false) => &mut counters.dropped_datagram_probe,
            },
            bytes,
        );
        let path = match metadata.path {
            PeerTransport::WebTransport => &mut counters.webtransport,
            PeerTransport::Edge => &mut counters.edge,
        };
        Self::add(Self::role_tally(&mut path.admitted, metadata.role), bytes);
        Self::add(
            Self::role_tally(
                if delivered {
                    &mut path.delivered
                } else {
                    &mut path.dropped
                },
                metadata.role,
            ),
            bytes,
        );
    }

    fn count_reliable(viewer: &mut SimViewer, repair: bool, bytes: usize) {
        let counters = &mut viewer.transport_counters;
        if repair {
            Self::add(&mut counters.admitted_reliable_repair, bytes);
            Self::add(&mut counters.delivered_reliable_repair, bytes);
        } else {
            Self::add(&mut counters.admitted_reliable_data, bytes);
            Self::add(&mut counters.delivered_reliable_data, bytes);
        }
    }

    /// Adopt a prompt anchor, as the worker's `handleEditorAnchor` does.
    ///
    /// Body: `[msg_type:1][len_be24:3][generation:4][row:2][col:2][flags:2]`.
    /// Only the open bit carries meaning; the model must not be handed a flag
    /// it does not understand.
    fn adopt_editor_anchor(viewer: &mut SimViewer, plain: &[u8]) {
        const BODY: usize = 4 + 2 + 2 + 2;
        assert_eq!(
            plain.len(),
            4 + BODY,
            "an editor anchor reached a viewer with a body of {} bytes",
            plain.len().saturating_sub(4)
        );
        let field16 = |at: usize| u16::from_be_bytes(plain[at..at + 2].try_into().expect("u16"));
        let generation = u32::from_be_bytes(plain[4..8].try_into().expect("u32"));
        let flags = field16(12);
        let open = flags & crate::network::protocol::EDITOR_ANCHOR_FLAG_OPEN;
        viewer
            .terminal
            .set_editor_anchor(generation, field16(8), field16(10), u32::from(open));
        viewer.editor_anchors_seen += 1;
    }

    /// Adopt an input-routing word, as the worker's `handleInputRouting` does:
    /// held over the headers of frames sent before it, and dropped when a newer
    /// word is held or a header sent after it has already applied.
    ///
    /// Body: `[msg_type:1][len_be24:3][generation:4][after_seq:4][serial:4][word:2]`.
    fn adopt_input_routing(viewer: &mut SimViewer, plain: &[u8]) {
        const BODY: usize = 4 + 4 + 4 + 2;
        assert_eq!(
            plain.len(),
            4 + BODY,
            "an input-routing word reached a viewer with a body of {} bytes",
            plain.len().saturating_sub(4)
        );
        let field = |at: usize| u32::from_be_bytes(plain[at..at + 4].try_into().expect("u32"));
        let (generation, after_seq, serial) = (field(4), field(8), field(12));
        let word = u16::from_be_bytes(plain[16..18].try_into().expect("u16"));
        assert_eq!(
            word & !crate::network::protocol::INPUT_ROUTING_MASK,
            0,
            "an input-routing word carried a bit that is not routing"
        );
        viewer.input_routing_seen += 1;
        let (applied_generation, applied_seq) = (viewer.ack_generation, viewer.ack.largest());
        if viewer.input_routing.admit(
            generation,
            after_seq,
            serial,
            applied_generation,
            applied_seq,
        ) {
            viewer.terminal.set_input_routing(u32::from(word));
        }
    }

    /// A frame at `(generation, seq)` applied. The first past the held routing
    /// word's position releases it to that frame's header.
    fn settle_input_routing(viewer: &mut SimViewer, generation: u32, seq: u32) {
        if viewer.input_routing.note_applied(generation, seq) {
            viewer.terminal.release_input_routing();
        }
    }

    /// Install a dictionary in the viewer's real terminal.
    ///
    /// The harness used to forge the acknowledgement without ever installing
    /// anything, so the daemon compressed against a dictionary no viewer held
    /// and the hash-verify path — the only thing between a diverged dictionary
    /// and a wrongly decoded screen — went untested.
    ///
    /// Body: `[msg_type:1][len_be24:3][generation:4][id:4][hash:4][len:2][bytes]`.
    fn install_dictionary(viewer: &mut SimViewer, plain: &[u8]) {
        const HEADER: usize = 4 + 4 + 4 + 4 + 2;
        assert!(
            plain.len() >= HEADER,
            "a dictionary install reached a viewer without a complete header"
        );
        let field =
            |at: usize| u32::from_be_bytes(plain[at..at + 4].try_into().expect("four byte field"));
        let generation = field(4);
        let id = field(8);
        let hash = field(12);
        let bytes_len = usize::from(u16::from_be_bytes(
            plain[16..18].try_into().expect("length field"),
        ));
        assert_eq!(
            plain.len(),
            HEADER + bytes_len,
            "a dictionary install declared {bytes_len} bytes but carried {}",
            plain.len() - HEADER
        );
        assert!(
            viewer
                .terminal
                .install_display_dictionary(generation, id, hash, &plain[HEADER..]),
            "the viewer refused a dictionary the daemon installed: \
             generation={generation} id={id} hash={hash} bytes={bytes_len}"
        );
        while viewer.dictionary_bytes.len() >= 2 {
            let oldest = *viewer
                .dictionary_bytes
                .keys()
                .next()
                .expect("dictionary map is non-empty");
            viewer.dictionary_bytes.remove(&oldest);
        }
        viewer.dictionary_bytes.insert(id, plain[HEADER..].to_vec());
        viewer.installed_dictionaries.push(id);
    }

    /// Acknowledge exactly the dictionaries viewers installed, as the browser's
    /// dict-ack does. Unlike forging the acknowledgement, this cannot confirm a
    /// dictionary no viewer holds.
    pub(crate) fn acknowledge_dictionaries(&mut self, sim: &mut DisplaySim) -> usize {
        let mut acknowledged = 0usize;
        for (peer_id, viewer) in self.viewers.iter_mut() {
            for id in viewer.installed_dictionaries.drain(..) {
                if sim.acknowledge_dictionary(peer_id, id) {
                    acknowledged += 1;
                }
            }
        }
        acknowledged
    }

    fn deliver(viewer: &mut SimViewer, plain: &[u8], _rows: u16, recovered: bool, now_ms: f64) {
        let Some(stream) = parse_stream_header(plain) else {
            panic!("a frame reached a viewer with no readable stream header");
        };
        if stream.msg_type == MSG_TYPE_DISPLAY_FEC_REPAIR {
            Self::recover_from_repair(viewer, plain, now_ms);
            return;
        }
        assert_eq!(
            stream.msg_type, MSG_TYPE_DISPLAY_PATCH,
            "only patch and FEC repair ride the display lanes"
        );

        let (header, _rows_start) = parse_frame_header_and_rows_start(plain)
            .unwrap_or_else(|error| panic!("viewer could not parse a frame header: {error:?}"));
        if viewer.closure.lose_next_claimed_end
            && header.presentation_end
            && header.closure_digest != 0
            && !recovered
        {
            viewer.closure.lose_next_claimed_end = false;
            viewer.closure.claimed_ends_lost += 1;
            return;
        }
        let snapshot = matches!(header.kind, FrameKind::Snapshot);
        // The terminal worker's generation gate. Every generation begins with
        // a snapshot, so an older generation is stale and dropped unapplied,
        // and a newer generation's delta overtook the snapshot that roots it
        // (datagrams have no order against the reliable lane) and waits for it.
        if snapshot {
            if stream.generation != viewer.display_generation
                && !display_serial_is_newer(stream.generation, viewer.display_generation)
            {
                return;
            }
        } else if stream.generation != viewer.display_generation {
            if display_serial_is_newer(stream.generation, viewer.display_generation) {
                viewer.ahead.push(plain.to_vec());
            }
            return;
        }
        if stream.flags & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD != 0 {
            viewer.compressed_seen += 1;
        }
        if stream.flags & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT != 0 {
            viewer.dictionary_seen += 1;
        }
        if header.chunk_count > 1 {
            viewer.multi_chunk_seen += 1;
        }
        viewer.rows_applied += usize::from(header.row_count);
        if std::env::var("CAPTURE_FRAMES").is_ok() {
            viewer.captured.push(plain.to_vec());
        }
        if std::env::var("DIAG_ROWS").is_ok() {
            let (_h, rows_start) = parse_frame_header_and_rows_start(plain).expect("header");
            let carried: Vec<u16> = merkur_codec::iter_rows_at(plain, rows_start, header.row_count)
                .filter_map(|entry| entry.ok().map(|row| row.row_index))
                .collect();
            println!(
                "DIAGROWS seq={} rows={:?}..{:?} n={}",
                stream.seq,
                carried.first(),
                carried.last(),
                carried.len()
            );
        }

        // Retain protected frames so a following repair can rebuild the ones
        // that never arrived. Parity is computed over these plaintexts, so this
        // is exactly what the FEC batch expects to be given.
        if stream.flags & merkur_codec::DISPLAY_HEADER_FLAG_FEC_PROTECTED != 0 {
            viewer
                .retained
                .insert((stream.generation, stream.seq), plain.to_vec());
            while viewer.retained.len() > FEC_RETENTION {
                let oldest = *viewer.retained.keys().next().expect("map is non-empty");
                viewer.retained.remove(&oldest);
            }
        }

        // Stage every frame. `apply_staged_frame` falls through to the same
        // `apply_frame` the direct path runs when nothing was prevalidated, so
        // staging is a strict superset: faithful for compressed and multi-chunk
        // frames, and behaviourally identical for a plain single-chunk one.
        let handle = viewer.terminal.stage_display_frame_bytes(plain);
        assert_ne!(
            handle,
            0,
            "staging rejected a frame the daemon sent: {:?}",
            viewer.terminal.take_last_error()
        );
        viewer.applied_bytes += plain.len();

        if header.chunk_count <= 1 {
            let typing_row_before = viewer.typing_row_hash();
            let applied = if snapshot {
                // As the worker does before every accepted snapshot: a
                // snapshot is seq 0, and it must replace cells a delta of
                // any older seq wrote.
                viewer.terminal.reset_display_ordering();
                viewer.terminal.apply_staged_state_seq(handle, stream.seq)
            } else {
                viewer.terminal.apply_staged_delta_seq(handle, stream.seq)
            };
            viewer.terminal.release_staged_frame(handle);
            if applied {
                viewer.applied_frames += 1;
                viewer.applied_chunks += 1;
                viewer.authoritative_input_seq =
                    viewer.authoritative_input_seq.max(stream.input_seq);
                viewer.authoritative_echo_horizon =
                    viewer.authoritative_echo_horizon.max(header.echo_horizon);
                viewer.note_applied(stream.seq, stream.generation, recovered);
                viewer.note_demand(
                    stream.generation,
                    header.demand_serial,
                    header.demand_limited,
                    header.demand_prompt,
                    now_ms,
                );
                Self::settle_input_routing(viewer, stream.generation, stream.seq);
                viewer.note_typing_visibility(
                    stream.input_seq,
                    now_ms,
                    header.row_count,
                    typing_row_before,
                );
                viewer.note_closure(stream.generation, stream.seq, snapshot, &header);
                viewer.note_presentation(
                    &header,
                    stream.generation,
                    stream.seq,
                    u32::from(header.row_count),
                    snapshot,
                    now_ms,
                );
                if snapshot {
                    Self::root_snapshot(viewer, stream.generation, now_ms);
                }
            } else {
                Self::refuse_apply(viewer);
            }
            return;
        }

        // Multi-chunk: mirror the browser's atomicity barrier — hold every
        // chunk, validate them all, then apply in chunk order.
        let key = (header.frame_id, u32::from(header.chunk_count));
        let slot = viewer.pending.entry(key).or_default();
        slot.push(StagedChunk {
            handle,
            chunk_index: header.chunk_index,
            seq: stream.seq,
            generation: stream.generation,
            input_seq: stream.input_seq,
            rows: header.row_count,
            snapshot,
        });
        if slot.len() < usize::from(header.chunk_count) {
            return;
        }
        let mut chunks = viewer.pending.remove(&key).expect("slot just checked");
        chunks.sort_by_key(|chunk| chunk.chunk_index);
        let all_valid = chunks
            .iter()
            .all(|chunk| viewer.terminal.validate_staged_frame(chunk.handle));
        if !all_valid {
            for chunk in &chunks {
                viewer.terminal.release_staged_frame(chunk.handle);
            }
            viewer.rejected += 1;
            // `frame_validation_rejected`.
            viewer.display_resyncs += 1;
            return;
        }
        if snapshot {
            viewer.terminal.reset_display_ordering();
        }
        for chunk in &chunks {
            let typing_row_before = viewer.typing_row_hash();
            let applied = if chunk.snapshot {
                viewer
                    .terminal
                    .apply_staged_state_seq(chunk.handle, chunk.seq)
            } else {
                viewer
                    .terminal
                    .apply_staged_delta_seq(chunk.handle, chunk.seq)
            };
            viewer.terminal.release_staged_frame(chunk.handle);
            if applied {
                viewer.applied_chunks += 1;
                viewer.authoritative_input_seq =
                    viewer.authoritative_input_seq.max(chunk.input_seq);
                viewer.authoritative_echo_horizon =
                    viewer.authoritative_echo_horizon.max(header.echo_horizon);
                viewer.note_applied(chunk.seq, chunk.generation, recovered);
                Self::settle_input_routing(viewer, chunk.generation, chunk.seq);
                viewer.note_typing_visibility(
                    chunk.input_seq,
                    now_ms,
                    header.row_count,
                    typing_row_before,
                );
            } else {
                Self::refuse_apply(viewer);
            }
        }
        viewer.applied_frames += 1;
        if let Some(last) = chunks.last() {
            let rows = chunks.iter().map(|chunk| u32::from(chunk.rows)).sum();
            viewer.note_closure(stream.generation, last.seq, snapshot, &header);
            viewer.note_presentation(&header, stream.generation, last.seq, rows, snapshot, now_ms);
        }
        if snapshot {
            Self::root_snapshot(viewer, stream.generation, now_ms);
        }
    }

    /// Count a refused apply the way the terminal worker answers it: a delta
    /// for another grid is dropped for the daemon to re-send, and anything
    /// else abandons the lineage for a snapshot (`apply_rejected`).
    fn refuse_apply(viewer: &mut SimViewer) {
        viewer.rejected += 1;
        viewer.apply_rejected += 1;
        if viewer.terminal.take_last_error().as_deref() == Some("display_dimensions_mismatch") {
            viewer.dimension_mismatches += 1;
        } else {
            viewer.display_resyncs += 1;
        }
    }

    /// A snapshot applied: its generation now roots deltas, and the ones that
    /// overtook it replay in arrival order. Older ones are stale by then, and
    /// newer ones go on waiting for their own snapshot.
    fn root_snapshot(viewer: &mut SimViewer, generation: u32, now_ms: f64) {
        viewer.snapshots_applied += 1;
        viewer.display_generation = generation;
        for unit in std::mem::take(&mut viewer.ahead) {
            Self::deliver(viewer, &unit, 0, false, now_ms);
        }
    }

    /// Rebuild whatever this repair can, and apply it.
    ///
    /// The framing and the Reed-Solomon solve both come from `merkur-fec`, so
    /// nothing about the repair format is reimplemented here. What stays local
    /// is which seqs the viewer happens to hold — receiver policy, which differs
    /// between a browser draining a socket and a harness replaying a transcript.
    fn recover_from_repair(viewer: &mut SimViewer, plain: &[u8], now_ms: f64) {
        let Some((header, body)) = merkur_fec::repair::parse_repair(plain) else {
            viewer.skipped_repair += 1;
            return;
        };
        let data_shards = usize::from(header.data_shards);
        let shard_size = usize::from(header.shard_size);

        let mut seq = header.batch_start_seq;
        let held: Vec<Option<Vec<u8>>> = (0..data_shards)
            .map(|_| {
                let held = viewer.retained.get(&(header.generation, seq)).cloned();
                // Match browser addDisplaySequence: display allocation skips
                // zero, although the selective ACK bitmap counts that slot.
                seq = seq.wrapping_add(1).max(1);
                held
            })
            .collect();
        if held.iter().all(|shard| shard.is_some()) {
            // Nothing was lost; the repair is redundant, which is the common case.
            viewer.skipped_repair += 1;
            return;
        }

        let span = data_shards * shard_size;
        if viewer.fec_padded.len() < span {
            viewer.fec_padded.resize(span, 0);
        }
        if viewer.fec_output.len() < span {
            viewer.fec_output.resize(span, 0);
        }
        let received: Vec<Option<&[u8]>> = held
            .iter()
            .map(|shard| shard.as_ref().map(|bytes| bytes.as_slice()))
            .collect();
        let restored = merkur_fec::repair::recover_batch_into(
            &header,
            &received,
            body,
            &mut viewer.fec_padded,
            &mut viewer.fec_output,
        );
        if restored == 0 {
            viewer.skipped_repair += 1;
            return;
        }

        for index in 0..data_shards {
            if restored & (1 << index) == 0 {
                continue;
            }
            let shard = &viewer.fec_output[index * shard_size..(index + 1) * shard_size];
            // A rebuilt shard is zero-padded to shard_size; the frame's own
            // header says how much of it is real.
            let Some(rebuilt) = parse_stream_header(shard) else {
                continue;
            };
            let len = STREAM_HEADER_BYTES + rebuilt.body_len as usize;
            if len > shard.len() || rebuilt.msg_type != MSG_TYPE_DISPLAY_PATCH {
                continue;
            }
            let frame = shard[..len].to_vec();
            viewer.recovered_by_fec += 1;
            Self::deliver(viewer, &frame, 0, true, now_ms);
        }
    }

    /// Answer any hash digest the daemon sent, naming the rows that disagree.
    ///
    /// This is the backstop the harness was missing. The browser compares the
    /// digest against its own row hashes and asks for the rows that differ; the
    /// daemon disowns them and the next flush re-sends them complete. Without
    /// it a harness can only recover through FEC and idempotent re-selection,
    /// and so cannot tell a sound acknowledgement from one that claims rows the
    /// viewer never received.
    pub(crate) fn answer_digests(&mut self, sim: &mut DisplaySim) -> usize {
        let mut asked = 0usize;
        for (peer_id, viewer) in self.viewers.iter_mut() {
            let mut generation = 0u32;
            let mut disagreed: Vec<u16> = Vec::new();
            for digest in viewer.digests.drain(..) {
                // [generation:4][up_to_seq:4][row_count:2][(row:2, hash:8)...]
                if digest.len() < 10 {
                    continue;
                }
                generation = u32::from_be_bytes(digest[0..4].try_into().expect("4 bytes"));
                let count = u16::from_be_bytes(digest[8..10].try_into().expect("2 bytes"));
                for index in 0..usize::from(count) {
                    let off = 10 + index * 10;
                    if off + 10 > digest.len() {
                        break;
                    }
                    let row = u16::from_be_bytes(digest[off..off + 2].try_into().expect("2 bytes"));
                    let hash =
                        u64::from_be_bytes(digest[off + 2..off + 10].try_into().expect("8 bytes"));
                    if viewer.terminal.row_hash(row) != hash {
                        disagreed.push(row);
                    }
                }
            }
            if !disagreed.is_empty() {
                disagreed.sort_unstable();
                disagreed.dedup();
                asked += disagreed.len();
                sim.deliver_resync(peer_id, generation, &disagreed);
            }
        }
        asked
    }

    /// Reflow every viewer's grid to new dimensions, the way the browser does
    /// on a local resize — before the daemon has said anything about it.
    #[cfg(test)]
    pub(crate) fn resize(&mut self, cols: u16, rows: u16) {
        self.rows = rows;
        for viewer in self.viewers.values_mut() {
            viewer.terminal.resize(cols, rows);
        }
    }

    /// Send every viewer's selective ACK back towards the daemon.
    ///
    /// A live browser does this after every change to its window; without it
    /// the daemon's cache never retires a row and its re-send behaviour is
    /// permanently that of a session whose viewer has gone silent. One ACK
    /// per change: a viewer whose window has not moved since its last
    /// acknowledgement sends nothing, as the browser sends nothing. The ACK
    /// is queued with the viewer's delay and delivered by the simulator at
    /// that instant, never here.
    pub(crate) fn acknowledge(&mut self, sim: &mut DisplaySim) {
        for (peer_id, viewer) in self.viewers.iter_mut() {
            if !viewer.ack.has_applied() || !viewer.ack_pending {
                continue;
            }
            viewer.ack_pending = false;
            viewer.closure.acks_while_pending += usize::from(viewer.closure.pending);
            sim.enqueue_ack(
                peer_id,
                viewer.ack_generation,
                viewer.ack.largest(),
                viewer.ack.received(),
                viewer.ack.recovered(),
                viewer.ack_delay_ms,
            );
        }
    }

    /// Run the owner loop for `budget_ms`, pumping and acknowledging on every
    /// wake, so the viewers behave as a browser draining its socket would.
    pub(crate) async fn run_for_ms(
        &mut self,
        sim: &mut DisplaySim,
        budget_ms: f64,
        wake_cap: usize,
    ) -> ScheduleRun {
        sim.run_for_ms(budget_ms, wake_cap, |sim, _wake| {
            self.pump(sim);
            self.acknowledge(sim);
        })
        .await
    }

    /// Drive the session until `peer` is settled: its grid agrees with the
    /// daemon's, every row it holds is confirmed, and no acknowledgement is
    /// still in flight. Returns the virtual milliseconds that took.
    ///
    /// This is the state the fixed setup loops used to reach by stepping a
    /// parked session for 64 turns; it is now the state itself, reached as
    /// soon as it holds and not a turn later. Convergence alone is not it: a
    /// converged screen with an ACK in flight still has a re-send deadline
    /// armed, and a test that measured from there would be measuring its own
    /// setup.
    pub(crate) async fn settle(&mut self, sim: &mut DisplaySim, peer: &str, budget_ms: f64) -> f64 {
        let started_ms = sim.now_ms();
        let mut daemon = Vec::new();
        // A same-instant timer wake that changes nothing is the owner loop
        // spinning at zero delay; virtual time would never reach the budget,
        // so bound the wakes at one instant explicitly.
        const SAME_INSTANT_WAKE_CAP: usize = 64;
        let mut same_instant_wakes = 0usize;
        let mut last_wake_at_ms = f64::NAN;
        loop {
            self.pump(sim);
            self.acknowledge(sim);
            sim.terminal_row_hashes(&mut daemon);
            if self.diverged_rows(peer, &daemon).is_empty()
                && !sim.peer_has_unacked_rows(peer)
                && !sim.has_pending_acks()
                && !sim.has_pending_deliveries()
            {
                return sim.now_ms() - started_ms;
            }
            assert!(
                sim.now_ms() - started_ms <= budget_ms,
                "viewer {peer} did not settle inside {budget_ms} ms: {} rows diverged, \
                 unacked={}, acks in flight={}",
                self.diverged_rows(peer, &daemon).len(),
                sim.peer_has_unacked_rows(peer),
                sim.has_pending_acks()
            );
            let before_ms = sim.now_ms();
            assert!(
                sim.step().await.is_some(),
                "viewer {peer} cannot settle: the owner loop parked with {} rows diverged \
                 and unacked={}",
                self.diverged_rows(peer, &daemon).len(),
                sim.peer_has_unacked_rows(peer)
            );
            if sim.now_ms() == before_ms && before_ms == last_wake_at_ms {
                same_instant_wakes += 1;
            } else {
                same_instant_wakes = 0;
            }
            last_wake_at_ms = sim.now_ms();
            assert!(
                same_instant_wakes < SAME_INSTANT_WAKE_CAP,
                "viewer {peer}: the owner loop woke {same_instant_wakes} times at {} ms without \
                 advancing; next delay {:?}; gate: {}",
                sim.now_ms(),
                sim.next_flush_delay_ms(),
                sim.delta_gate(),
            );
        }
    }

    /// Rows where a viewer disagrees with the daemon's current grid.
    pub(crate) fn diverged_rows(&mut self, peer_id: &str, daemon: &[u64]) -> Vec<u16> {
        let rows = self.rows;
        let viewer = self.viewer(peer_id);
        let theirs = viewer.row_hashes(rows);
        (0..rows)
            .filter(|row| {
                let index = usize::from(*row);
                theirs.get(index) != daemon.get(index)
            })
            .collect()
    }

    /// The graphics `peer_id` presents once its received rows commit: the
    /// `(row, descriptor)` export the render owner reads, copied out.
    pub(crate) fn graphics_export(&mut self, peer_id: &str, out: &mut Vec<u8>) {
        let terminal = &mut self.viewer(peer_id).terminal;
        terminal.commit_presentation_state();
        let len = terminal.graphics_len();
        out.clear();
        if len != 0 {
            // SAFETY: `graphics_ptr` addresses the `len`-byte export the
            // terminal owns, and nothing mutates it before this copy ends.
            out.extend_from_slice(unsafe {
                std::slice::from_raw_parts(terminal.graphics_ptr(), len)
            });
        }
    }

    /// Drop the digests awaiting comparison. A browser compares a digest only
    /// at the exact sequence it describes and skips one it has applied past,
    /// so a check of the digest a settled screen emits discards older ones
    /// first rather than comparing grids they no longer describe.
    pub(crate) fn discard_digests(&mut self) {
        for viewer in self.viewers.values_mut() {
            viewer.digests.clear();
        }
    }

    /// Digests every viewer has been sent, cumulative and never drained.
    pub(crate) fn digests_seen(&self) -> usize {
        self.viewers
            .values()
            .map(|viewer| viewer.digests_seen)
            .sum()
    }

    /// Every viewer's totals, for vacuity control.
    pub(crate) fn totals(&self) -> (usize, usize, usize, usize) {
        self.viewers.values().fold((0, 0, 0, 0), |acc, viewer| {
            (
                acc.0 + viewer.applied_frames,
                acc.1 + viewer.applied_chunks,
                acc.2 + viewer.applied_bytes,
                acc.3 + viewer.rejected,
            )
        })
    }

    pub(crate) fn distinct(hashes: &[u64]) -> usize {
        hashes.iter().collect::<HashSet<_>>().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::sim::SimWake;

    /// Virtual time at which a fresh session's viewer is a follow-along one.
    ///
    /// A fresh peer reads as interactive: `last_input_at_ms` starts at 0 and
    /// so does the clock, and `is_recently_interactive` holds for 120 ms after
    /// the last input. An interactive peer's repaint batches are classified
    /// `Interactive` — a small fraction of the screen each — and an
    /// `Interactive` frame never reaches the compressor. The repaint oracles
    /// below are claims about a follow-along viewer's packing and pacing, so
    /// they move past that window first. They used to get there by accident:
    /// the setup loops kept stepping a session with nothing scheduled at
    /// `NORMAL_FLUSH_MS` and burned 640 ms before measuring, which the
    /// simulator no longer does once it parks like the owner loop.
    const FOLLOW_ALONG_AFTER_MS: f64 = 500.0;

    /// Virtual time a settle may take before it is a finding of its own.
    const SETTLE_BUDGET_MS: f64 = 5_000.0;

    /// Drive the session until `peer`'s grid agrees with the daemon's, pumping
    /// and acknowledging on every wake. Returns `(paints, elapsed_ms)`: a paint
    /// is a flush that put datagrams on the wire — a timer fire with nothing to
    /// send is not one, and neither is an acknowledgement arriving. `None` if
    /// the budget ran out or the owner loop parked first.
    async fn paints_to_convergence(
        sim: &mut DisplaySim,
        viewers: &mut SimViewers,
        peer: &str,
        budget_ms: f64,
    ) -> Option<(usize, f64)> {
        let started_ms = sim.now_ms();
        let mut daemon = Vec::new();
        let mut paints = 0usize;
        let mut wakeups = 0usize;
        while sim.now_ms() - started_ms <= budget_ms && wakeups < 64 {
            let flushes_before = sim.flushes().len();
            sim.step().await?;
            wakeups += 1;
            paints += sim.flushes()[flushes_before..]
                .iter()
                .filter(|flush| flush.datagrams > 0)
                .count();
            viewers.pump(sim);
            viewers.acknowledge(sim);
            sim.terminal_row_hashes(&mut daemon);
            if viewers.diverged_rows(peer, &daemon).is_empty() {
                return Some((paints, sim.now_ms() - started_ms));
            }
        }
        None
    }

    /// Drive through visual convergence, delayed acknowledgement, and every
    /// intervening re-send timer until the daemon has confirmation for the
    /// viewer's rows. A convergence-only oracle censors precisely the timer
    /// interval whose duplicate work this helper exists to measure.
    async fn paints_to_settle(
        sim: &mut DisplaySim,
        viewers: &mut SimViewers,
        peer: &str,
        budget_ms: f64,
    ) -> Option<(usize, f64)> {
        let started_ms = sim.now_ms();
        let mut daemon = Vec::new();
        let mut paints = 0usize;
        while sim.now_ms() - started_ms <= budget_ms {
            sim.terminal_row_hashes(&mut daemon);
            if viewers.diverged_rows(peer, &daemon).is_empty()
                && !sim.peer_has_unacked_rows(peer)
                && !sim.has_pending_acks()
                && !sim.has_pending_deliveries()
            {
                return Some((paints, sim.now_ms() - started_ms));
            }
            let flushes_before = sim.flushes().len();
            sim.step().await?;
            paints += sim.flushes()[flushes_before..]
                .iter()
                .filter(|flush| flush.datagrams > 0)
                .count();
            viewers.pump(sim);
            viewers.acknowledge(sim);
        }
        None
    }

    /// Flush the session until the viewer agrees with the daemon, returning how
    /// many flushes that took. `None` means it never agreed within the budget.
    async fn flushes_to_convergence(
        sim: &mut DisplaySim,
        viewers: &mut SimViewers,
        peer: &str,
        budget: usize,
    ) -> Option<usize> {
        let mut daemon = Vec::new();
        for flush in 1..=budget {
            sim.step().await;
            viewers.pump(sim);
            viewers.acknowledge(sim);
            sim.terminal_row_hashes(&mut daemon);
            if viewers.diverged_rows(peer, &daemon).is_empty() {
                return Some(flush);
            }
        }
        None
    }

    /// A viewer converges on the daemon's grid, row for row.
    ///
    /// This is the property the whole simulator was a proxy for. Everything else
    /// it asserts — emission, pacing, deferral, keystroke latency — is a
    /// statement about the *sender*. This is the first assertion about what the
    /// person at the terminal actually sees.
    #[tokio::test(flavor = "current_thread")]
    async fn a_viewer_converges_on_the_daemon_grid() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);

        let mut blank = Vec::new();
        sim.terminal_row_hashes(&mut blank);

        for round in 0..4u64 {
            sim.write_noisy_screen(round + 1);
            let flushes = flushes_to_convergence(&mut sim, &mut viewers, &peer, 64)
                .await
                .unwrap_or_else(|| panic!("round {round} never converged"));
            assert!(
                flushes <= 8,
                "round {round} took {flushes} flushes to converge"
            );
        }

        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);

        // Controls. A blank grid converges trivially, and a row-independent hash
        // would satisfy equality while proving nothing, so both are ruled out
        // before the equality above is allowed to mean anything.
        assert_ne!(daemon, blank, "the terminal still holds its blank grid");
        assert_eq!(
            SimViewers::distinct(&daemon),
            usize::from(ROWS),
            "the daemon's rows are not all distinct, so row equality proves less \
             than it appears to"
        );
        let (frames, chunks, bytes, rejected) = viewers.totals();
        assert!(
            frames > 0 && chunks > 0 && bytes > 0,
            "no content reached the viewer"
        );
        assert_eq!(rejected, 0, "the viewer rejected a frame the daemon sent");
        assert!(sim.built_datagram_count() > 0, "the daemon built nothing");
        assert!(
            frames > 1,
            "the fixture produced {frames} frame(s), so nothing here exercises a \
             redraw spanning several independently-applicable datagrams"
        );
        assert_eq!(
            viewers.viewer(&peer).multi_chunk_seen,
            0,
            "a multi-chunk frame reached the datagram lane; every datagram must be \
             applicable on its own, or losing one strands the rest of the redraw"
        );
    }

    /// Flush until the viewer applies a snapshot.
    ///
    /// Deltas and snapshots go through different row writers —
    /// `encode_captured_rows` builds a frame through the codec, the snapshot
    /// path writes row prefixes by hand — and a resize forces a snapshot, so
    /// the frame a browser's rewrap is judged against is always the
    /// hand-written one. Measuring after the snapshot is what tells them apart:
    /// a snapshot that drops a field is invisible in a settled session, because
    /// the receiver's per-cell ordering gate refuses the stale cells and the
    /// old ones survive. A resize clears those versions, so the snapshot lands
    /// whole — which is exactly when a dropped field bites.
    async fn pump_until_snapshot_applied(
        sim: &mut DisplaySim,
        viewers: &mut SimViewers,
        peer: &str,
    ) {
        let before = viewers.viewer(peer).snapshots_applied;
        sim.request_snapshot(peer);
        for _ in 0..64 {
            sim.step().await;
            viewers.pump(sim);
            if viewers.viewer(peer).snapshots_applied > before {
                return;
            }
        }
        panic!("no snapshot reached the viewer");
    }

    /// Write `count` lines that are each wider than the terminal, so the
    /// daemon's grid holds genuinely wrapped rows rather than rows that merely
    /// happen to be full.
    fn write_wrapping_lines(sim: &mut DisplaySim, cols: u16, count: usize) {
        let mut out = Vec::new();
        // splitmix64 over the whole stream, so no two slices of it repeat and
        // the reflowed rows below stay distinguishable from one another.
        let mut state = 0x5eed_u64;
        for line in 0..count {
            let width = usize::from(cols) + 7 + line * 3;
            for _ in 0..width {
                state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = state;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^= z >> 31;
                out.push(b'!' + (z % 90) as u8);
            }
            out.extend_from_slice(b"\r\n");
        }
        sim.write_pty(&out);
    }

    /// A viewer that reflows on its own lands on the daemon's grid, exactly,
    /// before the daemon has sent a byte about the resize.
    ///
    /// This is the claim the row wrap bit exists for, and it is asserted in two
    /// halves. Convergence *before* the resize is the first half: `row_hash`
    /// digests the wrap bit, so a viewer whose rows are wrapped differently
    /// from the daemon's cannot converge at all — the bit has to have crossed
    /// the wire correctly for the loop below to terminate. The reflow after it
    /// is the second: the bit is not just carried but actionable, and acting on
    /// it produces the grid the daemon is about to send rather than an
    /// approximation of it.
    ///
    /// Narrowing is the direction that is exactly answerable. Widening rejoins
    /// rows and pulls scrollback down into the space; the viewer holds no
    /// scrollback to pull, so it can only get the rows below the join right.
    #[tokio::test(flavor = "current_thread")]
    async fn a_viewer_reflows_a_narrowing_resize_onto_the_daemon_grid() {
        const COLS: u16 = 80;
        const NARROW: u16 = 47;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);

        // More wrapped lines than the screen holds, so no row is left blank and
        // every one of the equalities below is about real content.
        write_wrapping_lines(&mut sim, COLS, usize::from(ROWS));
        flushes_to_convergence(&mut sim, &mut viewers, &peer, 64)
            .await
            .expect("the session converges on the wrapped screen");
        assert!(
            sim.wrapped_row_count() > 0,
            "nothing on screen wraps, so this says nothing about wrapped rows",
        );

        let mut before = Vec::new();
        sim.terminal_row_hashes(&mut before);

        // Both ends reflow independently. Nothing crosses the wire in between.
        sim.resize_terminal(NARROW, ROWS);
        viewers.resize(NARROW, ROWS);

        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);
        assert_eq!(
            viewers.diverged_rows(&peer, &daemon),
            Vec::<u16>::new(),
            "the viewer's own reflow disagreed with the daemon's",
        );

        // Controls: the resize has to have rewrapped something, and the rows
        // have to be distinct enough that agreeing on them means anything.
        assert_ne!(daemon, before, "the narrowing left the grid unchanged");
        assert_eq!(
            SimViewers::distinct(&daemon),
            usize::from(ROWS),
            "the reflowed rows are not distinct, so row equality proves little",
        );

        // And the authoritative frame that follows a resize agrees too. It
        // arrives through the snapshot row writer, onto a grid whose per-cell
        // versions the resize just cleared, so every field it carries — or
        // drops — lands whole.
        pump_until_snapshot_applied(&mut sim, &mut viewers, &peer).await;
        sim.terminal_row_hashes(&mut daemon);
        assert_eq!(
            viewers.diverged_rows(&peer, &daemon),
            Vec::<u16>::new(),
            "the snapshot that followed the resize did not leave the viewer on \
             the daemon's grid",
        );
    }

    /// What the viewer cannot answer: the leading fragment.
    ///
    /// The topmost visible row is usually the middle of a logical line whose
    /// start is in scrollback the viewer does not hold. Narrowing rewraps that
    /// line differently at each end — the daemon splits the whole line, the
    /// viewer splits the fragment as though it began at column zero — so those
    /// rows cannot agree, and no wrap bit fixes that. This bounds the damage:
    /// the reflow is bottom-anchored, so the disagreement stays at the top
    /// instead of shifting every row below it.
    ///
    /// The geometry of a real browser session, and the same content its e2e
    /// spec prints.
    #[tokio::test(flavor = "current_thread")]
    async fn a_narrowing_reflow_disagrees_only_where_scrollback_is_missing() {
        const COLS: u16 = 117;
        const NARROW: u16 = 110;
        const ROWS: u16 = 36;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);

        // Far more content than the viewport holds, so the visible top really
        // is a fragment and the daemon really does hold the rest.
        let mut out = Vec::new();
        for line in 0..40 {
            out.extend_from_slice(format!("wrap-{line:03}-{}\r\n", "x".repeat(300)).as_bytes());
        }
        sim.write_pty(&out);
        flushes_to_convergence(&mut sim, &mut viewers, &peer, 128)
            .await
            .expect("the session converges on the wrapped screen");
        sim.resize_terminal(NARROW, ROWS);
        viewers.resize(NARROW, ROWS);

        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);
        let diverged = viewers.diverged_rows(&peer, &daemon);
        assert!(
            diverged.len() <= 2,
            "{} of {ROWS} rows diverged ({diverged:?}); the reflow is no longer \
             bottom-anchored, or the leading fragment is shifting the rows below it",
            diverged.len(),
        );
        assert!(
            diverged.iter().all(|row| *row < 4),
            "divergence reached past the leading fragment: {diverged:?}",
        );
    }

    /// The oracle detects a viewer that missed a frame.
    ///
    /// Without this, every convergence assertion above could be a tautology —
    /// two grids that are equal because nothing ever changed either of them.
    #[tokio::test(flavor = "current_thread")]
    async fn a_viewer_that_misses_a_frame_visibly_diverges() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);

        // Converge once so the divergence below is caused by the withheld
        // frames alone, not by a cold start.
        sim.write_noisy_screen(1);
        flushes_to_convergence(&mut sim, &mut viewers, &peer, 64)
            .await
            .expect("the session converges before anything is withheld");

        // Now write again and never deliver it.
        sim.write_noisy_screen(2);
        for _ in 0..8 {
            sim.step().await;
        }

        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);
        let diverged = viewers.diverged_rows(&peer, &daemon);
        assert!(
            !diverged.is_empty(),
            "a viewer that was never delivered the second screen still matched \
             the daemon, so the oracle cannot see a missing frame"
        );
    }

    /// Every viewer in a multi-viewer session converges, and none is starved.
    #[tokio::test(flavor = "current_thread")]
    async fn every_viewer_in_a_session_converges() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        const PEERS: usize = 4;

        let mut sim = DisplaySim::with_peers(COLS, ROWS, PEERS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);

        sim.write_noisy_screen(7);
        let mut daemon = Vec::new();
        let mut converged = None;
        for flush in 1..=128usize {
            sim.step().await;
            viewers.pump(&sim);
            sim.terminal_row_hashes(&mut daemon);
            if viewers
                .ids()
                .iter()
                .all(|peer| viewers.diverged_rows(peer, &daemon).is_empty())
            {
                converged = Some(flush);
                break;
            }
        }
        assert!(converged.is_some(), "not every viewer converged");

        // A starved viewer must not pass by inheriting a blank grid that happens
        // to match; each one has to have been sent something.
        for peer in viewers.ids() {
            assert!(
                viewers.viewer(&peer).applied_frames > 0,
                "viewer {peer} converged without ever applying a frame"
            );
        }
    }

    /// A frame sealed for one viewer cannot be opened by another.
    ///
    /// Proves the per-peer Noise sessions the harness claims are real, and that
    /// the pump routes by peer rather than broadcasting.
    #[tokio::test(flavor = "current_thread")]
    async fn a_frame_sealed_for_one_viewer_does_not_open_under_another() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::with_peers(COLS, ROWS, 2);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        sim.write_noisy_screen(3);
        sim.step().await;
        viewers.pump(&sim);

        let first = sim_peer_id(0);
        let frame = sim
            .wire()
            .iter()
            .find(|frame| frame.peer_id == first)
            .expect("the first viewer was sent something")
            .clone();
        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).expect("display lane");
        let other = viewers.viewer(&sim_peer_id(1));
        assert!(
            other.open_for_test(lane, &frame.bytes[1..]).is_err(),
            "a datagram sealed for one viewer opened under another's session"
        );
    }

    /// A viewer converges under sustained datagram loss, and the cost of
    /// recovering scales with the loss rate rather than diverging.
    ///
    /// Two mechanisms recover here and both are real production code: FEC
    /// repair rebuilds a lost frame from parity within its own batch, and the
    /// daemon re-sends any row that stays unacked. Retransmission alone
    /// converged in 3/9/23 flushes at 10/30/50% loss; with FEC decode wired in
    /// it is 2/3/5. The bound below is set from the measured figures with
    /// headroom, so a regression in either mechanism fails it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_viewer_converges_under_sustained_loss() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        const SEED: u64 = 0xC0FF_EE00_1234_5678;

        let mut worst_by_loss = Vec::new();
        for loss in [0u32, 10, 30, 50] {
            let mut sim = DisplaySim::new(COLS, ROWS);
            sim.set_loss(loss, SEED);
            let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
            let peer = sim_peer_id(0);

            let mut worst = 0usize;
            for round in 0..4u64 {
                sim.write_noisy_screen(round + 1);
                let flushes = flushes_to_convergence(&mut sim, &mut viewers, &peer, 256)
                    .await
                    .unwrap_or_else(|| panic!("round {round} at {loss}% loss never converged"));
                worst = worst.max(flushes);
            }

            // Control: a loss rate that drops nothing proves nothing about loss.
            if loss > 0 {
                assert!(
                    sim.dropped_count() > 0,
                    "a {loss}% loss model dropped no frames"
                );
            } else {
                assert_eq!(sim.dropped_count(), 0, "a loss-free session dropped frames");
            }
            assert_eq!(
                viewers.totals().3,
                0,
                "the viewer rejected a frame at {loss}% loss"
            );
            worst_by_loss.push((loss, worst));
        }

        // Recovery cost must grow with loss. A flat profile would mean the loss
        // model is not reaching the viewer at all.
        let loss_free = worst_by_loss[0].1;
        let heaviest = worst_by_loss[worst_by_loss.len() - 1].1;
        assert!(
            heaviest > loss_free,
            "convergence under 50% loss ({heaviest} flushes) was no worse than \
             loss-free ({loss_free}); the loss is not reaching the viewer: \
             {worst_by_loss:?}"
        );
        // ...and must stay bounded. Measured worst is 5 flushes at 50% loss;
        // 12 leaves room for scheduling noise while still failing if FEC or the
        // re-send path stops working.
        assert!(
            heaviest <= 12,
            "convergence under 50% loss took {heaviest} flushes: {worst_by_loss:?}"
        );
    }

    /// Cost of the direct apply path against the staged one, for the frame
    /// shape that dominates interactive use: single-chunk and uncompressed.
    ///
    /// This is the measurement that decides whether the browser can be moved to
    /// stage every frame. `requiresOwnedDisplayFrameStaging` currently routes
    /// only compressed or multi-chunk frames through staging, so keystroke echo
    /// takes the direct path; binding TypeScript to a Rust parser would mean
    /// staging everything, and that is only acceptable if the extra copy and
    /// bookkeeping are free at this size.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "benchmark"]
    async fn bench_direct_versus_staged_apply() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        const SAMPLES: usize = 20_000;

        // Capture one real single-chunk keystroke-sized frame.
        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"x");
        flushes_to_convergence(&mut sim, &mut viewers, &peer, 32)
            .await
            .expect("converges");
        sim.write_pty(b"y");
        sim.step().await;

        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).expect("lane");
        // The wire carries FEC repairs alongside patches; take the last patch.
        let plain = {
            let viewer = viewers.viewer(&peer);
            let mut found = None;
            for frame in sim.wire().iter().rev() {
                let Ok(opened) = viewer.open_for_test(lane, &frame.bytes[1..]) else {
                    continue;
                };
                if parse_stream_header(&opened)
                    .is_some_and(|header| header.msg_type == MSG_TYPE_DISPLAY_PATCH)
                {
                    found = Some(opened);
                    break;
                }
            }
            found.expect("a display patch reached the wire")
        };

        let mut direct = term_wasm::Terminal::new_headless(COLS, ROWS);
        let mut staged = term_wasm::Terminal::new_headless(COLS, ROWS);

        // Warm both paths before timing.
        for seq in 1..=64u32 {
            direct.apply_delta_seq(&plain, seq);
            let handle = staged.stage_display_frame_bytes(&plain);
            staged.apply_staged_delta_seq(handle, seq);
            staged.release_staged_frame(handle);
        }

        let mut direct_ns = Vec::with_capacity(SAMPLES);
        let mut staged_ns = Vec::with_capacity(SAMPLES);
        for index in 0..SAMPLES {
            let seq = 1_000 + index as u32;

            let started = std::time::Instant::now();
            std::hint::black_box(direct.apply_delta_seq(&plain, seq));
            direct_ns.push(started.elapsed().as_nanos() as f64);

            // Release each handle, as the browser does — without it the staging
            // queue grows without bound and the benchmark measures a leak.
            let started = std::time::Instant::now();
            let handle = staged.stage_display_frame_bytes(&plain);
            std::hint::black_box(staged.apply_staged_delta_seq(handle, seq));
            staged.release_staged_frame(handle);
            staged_ns.push(started.elapsed().as_nanos() as f64);
        }

        for (label, mut samples) in [("direct", direct_ns), ("staged", staged_ns)] {
            samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN"));
            let n = samples.len();
            println!(
                "APPLYBENCH {label}: n={n} median={:.0}ns p95={:.0}ns wire={}B",
                samples[n / 2],
                samples[n * 95 / 100],
                plain.len()
            );
        }
    }

    /// A full repaint costs a bounded number of flushes however rarely the
    /// viewer acknowledges.
    ///
    /// This is the property that was broken. Ranking put already-sent rows
    /// alongside never-sent ones, so a screen larger than one flush budget spent
    /// every flush re-sending the same prefix, and the rows past the budget were
    /// only reached as ACKs retired that prefix — about one row per round trip.
    /// Convergence therefore scaled linearly with ACK latency: measured at 21,
    /// 41, 81, 161, 321 and 1281 flushes for ACKs every 1, 2, 4, 8, 16 and 64
    /// flushes, and no convergence at all every 256. Bandwidth scaled with it,
    /// from 288 KB to 17.6 MB for one 200x50 repaint whose content is 27 KB.
    ///
    /// Ranking unsent rows first decouples the two: every row is offered once
    /// before any is offered twice, so a repaint costs one pass over the screen
    /// no matter when the ACKs arrive.
    #[tokio::test(flavor = "current_thread")]
    async fn a_repaint_costs_the_same_however_rarely_a_viewer_acknowledges() {
        const COLS: u16 = 200;
        const ROWS: u16 = 50;
        /// One pass over the screen plus a little slack. The measured figure is
        /// 2 flushes at every cadence; this fails long before the old linear
        /// behaviour would look acceptable.
        const FLUSH_BUDGET: usize = 8;

        let mut results = Vec::new();
        for ack_every in [1usize, 8, 64, 256] {
            let mut sim = DisplaySim::new(COLS, ROWS);
            let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
            let peer = sim_peer_id(0);

            // Converge a first screen, then measure a *repaint*. This is not
            // incidental: on a repaint every row has been sent before, so a
            // ranking that only distinguishes never-sent rows gives no
            // discrimination and the old one-row-per-round-trip behaviour comes
            // straight back. Measuring only the cold paint hid exactly that.
            sim.write_noisy_screen(1);
            viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;
            sim.write_noisy_screen(2);

            // Acknowledge every `ack_every`-th paint, where a paint is a flush
            // that put datagrams on the wire; a timer fire with nothing to send
            // and an acknowledgement arriving are steps, not paints.
            let mut daemon = Vec::new();
            let mut paints = 0usize;
            let mut converged = None;
            for _ in 1..=2048usize {
                let flushes_before = sim.flushes().len();
                if sim.step().await.is_none() {
                    break;
                }
                let painted = sim.flushes()[flushes_before..]
                    .iter()
                    .filter(|flush| flush.datagrams > 0)
                    .count();
                viewers.pump(&sim);
                if painted > 0 {
                    paints += painted;
                    if paints.is_multiple_of(ack_every) {
                        viewers.acknowledge(&mut sim);
                    }
                }
                sim.terminal_row_hashes(&mut daemon);
                if viewers.diverged_rows(&peer, &daemon).is_empty() {
                    converged = Some(paints);
                    break;
                }
            }

            let flushes = converged.unwrap_or_else(|| {
                panic!("a repaint never converged with ACKs every {ack_every} flushes")
            });
            assert!(
                flushes <= FLUSH_BUDGET,
                "a repaint took {flushes} flushes with ACKs every {ack_every}; \
                 convergence is scaling with ACK latency again"
            );

            // Control: the screen really is bigger than one flush budget, or
            // this test is about nothing. `FLUSH_ROW_BUDGET_BYTES` is 12 KiB.
            assert!(
                sim.wire_bytes() > 12 * 1024,
                "the repaint fit in a single flush budget ({}B), so the \
                 multi-flush path was never exercised",
                sim.wire_bytes()
            );
            results.push((ack_every, flushes, sim.wire_bytes()));
        }

        // Bandwidth must not scale with ACK cadence either. Before the fix the
        // rarest-ACK case moved 60x the bytes of the most frequent.
        let cheapest = results.iter().map(|entry| entry.2).min().expect("results");
        let dearest = results.iter().map(|entry| entry.2).max().expect("results");
        assert!(
            dearest <= cheapest * 2,
            "bytes on the wire scale with ACK cadence: {results:?}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "diagnostic"]
    async fn diag_realistic_repaint() {
        for (cols, rows) in [(80u16, 24u16), (120, 40), (200, 50), (240, 60)] {
            for label in ["code", "colored", "random"] {
                let mut sim = DisplaySim::new(cols, rows);
                let mut viewers = SimViewers::attach(&mut sim, cols, rows);
                if std::env::var("SIM_DICT").is_ok() {
                    sim.enable_display_dictionary();
                }
                let peer = sim_peer_id(0);
                match label {
                    "random" => sim.write_noisy_screen(1),
                    "colored" => sim.write_colored_screen(1),
                    _ => sim.write_code_screen(1),
                }
                let mut dict_acked = 0usize;
                for _ in 0..64 {
                    sim.step().await;
                    viewers.pump(&sim);
                    viewers.acknowledge(&mut sim);
                    dict_acked += viewers.acknowledge_dictionaries(&mut sim);
                }
                let before = sim.wire_bytes();
                let before_datagrams = sim.built_datagram_count();
                let started_ms = sim.now_ms();
                match label {
                    "random" => sim.write_noisy_screen(2),
                    "colored" => sim.write_colored_screen(7),
                    _ => sim.write_code_screen(3),
                }
                let mut daemon = Vec::new();
                let mut increments = 0usize;
                for _ in 1..=256usize {
                    sim.step().await;
                    viewers.pump(&sim);
                    viewers.acknowledge(&mut sim);
                    sim.terminal_row_hashes(&mut daemon);
                    increments += 1;
                    if viewers.diverged_rows(&peer, &daemon).is_empty() {
                        break;
                    }
                }
                println!(
                    "DIAG {cols}x{rows} {label}: paints={increments} elapsed={:.0}ms repaint_bytes={}B datagrams={} dict_acked={dict_acked}",
                    sim.now_ms() - started_ms,
                    sim.wire_bytes() - before,
                    sim.built_datagram_count() - before_datagrams
                );
            }
        }
    }

    /// Does compressing one whole frame beat compressing its chunks separately?
    ///
    /// The daemon compresses each ~1 KB datagram independently, which gives zstd
    /// almost no window to work with. This measures what a single frame-wide
    /// compression would have achieved over the same bytes.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "diagnostic"]
    async fn diag_compression_granularity() {
        for (cols, rows) in [(120u16, 40u16), (200, 50), (240, 60)] {
            let mut sim = DisplaySim::new(cols, rows);
            let mut viewers = SimViewers::attach(&mut sim, cols, rows);
            let peer = sim_peer_id(0);
            sim.write_colored_screen(1);
            for _ in 0..64 {
                sim.step().await;
                viewers.pump(&sim);
                viewers.acknowledge(&mut sim);
            }
            viewers.viewer(&peer).captured.clear();
            sim.write_colored_screen(7);
            for _ in 0..64 {
                sim.step().await;
                viewers.pump(&sim);
                viewers.acknowledge(&mut sim);
            }
            let frames: Vec<Vec<u8>> = viewers.viewer(&peer).captured.clone();
            if frames.is_empty() {
                println!("DIAG {cols}x{rows}: no frames captured");
                continue;
            }

            let raw: usize = frames.iter().map(|f| f.len()).sum();
            let level = crate::display::compressor::DISPLAY_COMPRESSION_LEVEL;
            let per_chunk: usize = frames
                .iter()
                .map(|f| zstd::bulk::compress(f, level).expect("compress").len())
                .sum();
            let concatenated: Vec<u8> = frames.concat();
            let whole = zstd::bulk::compress(&concatenated, level)
                .expect("compress")
                .len();
            println!(
                "DIAG {cols}x{rows}: frames={} raw={raw}B per_chunk={per_chunk}B whole_frame={whole}B ratio={:.2}x",
                frames.len(),
                per_chunk as f64 / whole as f64
            );
        }
    }

    /// A clipped repaint is not paced by the row-resend interval.
    ///
    /// When the flush budget clips a repaint, the rows it dropped have never
    /// been sent and are immediately sendable. They used to wait anyway:
    /// `compute_next_flush_delay_ms` took `.max(resend_delay)`, and
    /// `next_row_resend_due_ms` reports the deadline of rows *already* on the
    /// wire and inside their pacing window. So a screen too large for one budget
    /// advanced one budget per `ROW_RESEND_MIN_MS` — which is what a person sees
    /// as the screen filling in blocks.
    ///
    /// The assertion is that completion is not a multiple of that interval.
    /// Measured at 240x60 with coloured content: 110 ms across 5 paints before,
    /// 45 ms across 4 after.
    ///
    /// The content is high-entropy and the terminal is far larger than a real
    /// one, because the clipped path has become hard to reach on purpose. That
    /// is the same path, exercised by the only shape that still takes it.
    ///
    /// The viewer acknowledges with a delay, as a browser does. That is what
    /// lets this see the defect at all: with acknowledgements delivered inside
    /// the flush that earned them, no row was ever unconfirmed when the
    /// scheduler was asked, and the resend arm had nothing to stretch.
    #[tokio::test(flavor = "current_thread")]
    async fn a_clipped_repaint_is_not_paced_by_the_resend_interval() {
        let (paints, elapsed_ms) = clipped_repaint(SIM_ACK_DELAY_MS).await;

        // The property: the *spacing between paints* is not the resend floor.
        //
        // Comparing totals is too weak — a resend-paced repaint lands just under
        // `paints * ROW_RESEND_MIN_MS` and would pass. Mean spacing is the
        // discriminator: 22 ms per paint when paced (essentially the 25 ms
        // floor), 11 ms when not. Spacing is per interval, `paints - 1` of
        // them: the first paint is at zero, so dividing by `paints` read a
        // 25 ms cadence as 12.5 once the flush budget grew and this screen
        // came to cost two paints instead of five.
        let floor_ms = crate::display::policy::DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS;
        let mean_spacing_ms = elapsed_ms / ((paints - 1) as f64);
        assert!(
            mean_spacing_ms < floor_ms * 0.75,
            "paints were {mean_spacing_ms:.1}ms apart across {paints} paints \
             ({elapsed_ms}ms total), which is the {floor_ms}ms row-resend floor; \
             the scheduler is sleeping rows that are already sendable"
        );
    }

    /// The same repaint for a viewer whose acknowledgements take the
    /// production p90 to come back.
    ///
    /// Here the measured confirmation delay, not the floor, sets the re-send
    /// interval — 88.7 ms — so a scheduler that sleeps a clipped remainder
    /// until the paced rows' deadline paints once per 88.7 ms rather than
    /// once per 25. The bound is the same: the remainder has never been sent
    /// and owes nothing to any row's pacing, slow viewer or not.
    #[tokio::test(flavor = "current_thread")]
    async fn a_slow_viewer_does_not_pace_a_clipped_repaint() {
        let (paints, elapsed_ms) = clipped_repaint(SIM_SLOW_ACK_DELAY_MS).await;
        let floor_ms = crate::display::policy::DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS;
        let mean_spacing_ms = elapsed_ms / ((paints - 1) as f64);
        assert!(
            mean_spacing_ms < floor_ms * 0.75,
            "paints were {mean_spacing_ms:.1}ms apart across {paints} paints \
             ({elapsed_ms}ms total) for a viewer confirming at {SIM_SLOW_ACK_DELAY_MS} ms; \
             the scheduler is sleeping a clipped remainder until the paced rows' deadline"
        );
    }

    /// Converge a 480x160 incompressible screen with a viewer confirming at
    /// `ack_delay_ms`, repaint it, and report `(paints, elapsed_ms)` for the
    /// repaint. Panics unless the repaint really clipped.
    async fn clipped_repaint(ack_delay_ms: f64) -> (usize, f64) {
        const COLS: u16 = 480;
        const ROWS: u16 = 160;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        viewers.viewer(&peer).set_ack_delay_ms(ack_delay_ms);
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);

        sim.write_noisy_screen(1);
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;
        // Control: the viewer's delay, not the floor, is what a slow viewer's
        // rows are paced by — otherwise the slow arm measures the fast one.
        let interval_ms = sim.peer_row_resend_interval_ms(&peer);
        let floor_ms = sim.peer_round_trip_floor_ms(&peer);
        if ack_delay_ms > floor_ms {
            assert!(
                interval_ms > floor_ms,
                "a viewer confirming at {ack_delay_ms} ms is still paced at the \
                 {floor_ms} ms floor ({interval_ms} ms)"
            );
        } else {
            assert_eq!(interval_ms, floor_ms);
        }

        let before_bytes = sim.wire_bytes();
        sim.write_noisy_screen(7);
        let (paints, elapsed_ms) =
            paints_to_convergence(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
                .await
                .expect("the repaint converges");

        // Control: this screen must actually exceed one flush budget, or the
        // clipped path was never taken and the test proves nothing.
        assert!(
            paints > 1,
            "a {COLS}x{ROWS} incompressible repaint fit in one flush ({} bytes); \
             the clipped path was not exercised",
            sim.wire_bytes() - before_bytes
        );
        (paints, elapsed_ms)
    }

    /// The deadline armed after a clipped flush is the flush interval, not the
    /// paced rows' re-send deadline.
    ///
    /// The direct form of the pacing oracle above: one clipped flush, then
    /// read what the timer-fire arm re-armed. The rows it did send are
    /// unconfirmed and inside their window; the rows it did not send have
    /// never been sent and are due at the coalescing delay.
    #[tokio::test(flavor = "current_thread")]
    async fn a_clipped_flush_remainder_is_not_slept_through() {
        const COLS: u16 = 480;
        const ROWS: u16 = 160;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);
        sim.write_noisy_screen(1);
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;

        sim.write_noisy_screen(7);
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);

        // Control: the flush really clipped, so a remainder is owed.
        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);
        assert!(
            !viewers.diverged_rows(&peer, &daemon).is_empty(),
            "the repaint fit in one flush; nothing was clipped"
        );
        assert!(
            sim.peer_has_unacked_rows(&peer),
            "the rows the flush sent must still be unconfirmed for the resend arm to bite"
        );

        let due_ms = sim
            .flush_due_in_ms()
            .expect("a clipped remainder keeps the flush timer armed");
        assert_eq!(
            due_ms, 0.0,
            "the remainder of a clipped flush was slept {due_ms} ms — the paced rows' \
             re-send deadline — instead of going out on the next turn"
        );
    }

    /// A keystroke that changes nothing visible releases the browser's
    /// prediction barrier on the next flush, not after the echoed row's
    /// re-send deadline.
    ///
    /// The advertisement of `latest_input_seq` is a header-only reason to
    /// emit, and the row the previous keystroke echoed is unconfirmed and
    /// paced. Nothing about that row is a reason to hold the advertisement.
    #[tokio::test(flavor = "current_thread")]
    async fn a_stale_input_seq_advertisement_is_not_slept_through() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"x");
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;

        // The echo of one keystroke: sent, unconfirmed, and paced for a full
        // re-send interval.
        sim.write_pty(b"y");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);
        assert!(
            sim.peer_has_unacked_rows(&peer),
            "the echoed row must be unconfirmed for the resend arm to bite"
        );
        sim.advance_ms(5.0);

        // The next keystroke the line editor swallows.
        sim.note_keystroke(&peer, 1);
        let due_ms = sim
            .flush_due_in_ms()
            .expect("a stale input_seq advertisement arms the flush timer");
        assert_eq!(
            due_ms, 0.0,
            "the barrier release was slept {due_ms} ms behind the echoed row's re-send \
             deadline; a keystroke that changes nothing visible is still local-echo dead \
             for that long"
        );
    }

    /// A carrier can disappear after admitting a header-only input-sequence
    /// barrier. That record owns no rows and therefore no row re-send deadline;
    /// retirement itself must wake the flush scheduler or the replacement
    /// remains parked until unrelated terminal activity.
    #[tokio::test(flavor = "current_thread")]
    async fn direct_carrier_replacement_wakes_a_parked_header_only_barrier() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"x");
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;
        assert!(
            viewers
                .run_for_ms(&mut sim, 1_000.0, 4)
                .await
                .parked_at_ms
                .is_some(),
            "the control session must be parked before the lifecycle edge",
        );

        // Keep the first carrier's admitted frame in flight so the replacement
        // timer wins the next simulated select, just as an exact owner handoff
        // makes the retired transport unable to deliver it in production.
        sim.set_downlink_delay_ms(100.0);
        let barrier_before = sim.wire().len();
        sim.note_keystroke(&peer, 1);
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        assert_eq!(
            sim.wire().len(),
            barrier_before + 1,
            "the swallowed key emits one barrier",
        );
        assert!(
            !sim.peer_has_unacked_rows(&peer),
            "the admitted barrier must be header-only and own no row deadline",
        );
        assert_eq!(
            sim.flush_due_in_ms(),
            None,
            "a header-only in-flight attempt leaves the flush timer parked",
        );

        sim.replace_direct_carrier(&peer);
        assert_eq!(
            sim.flush_due_in_ms(),
            Some(0.0),
            "retirement must arm the requeued barrier immediately",
        );
        let before = sim.wire().len();
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        assert_eq!(
            sim.wire().len(),
            before + 1,
            "the replacement carrier must emit exactly one requeued frame",
        );
        assert_eq!(
            sim.wire().last().expect("replacement frame").metadata.path,
            PeerTransport::WebTransport,
        );
    }

    /// A settled session parks its flush timer rather than polling.
    ///
    /// The spin guard for the scheduler rewrite: `None` from the scheduler is
    /// the owner loop parking, and a settled screen must reach it. A loop that
    /// re-armed at `NORMAL_FLUSH_MS` forever, or at zero, fails this through
    /// `parked_at_ms` or the wake cap respectively.
    #[tokio::test(flavor = "current_thread")]
    async fn an_idle_session_parks_instead_of_spinning() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"x");
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;

        let run = viewers.run_for_ms(&mut sim, 1_000.0, 4).await;
        assert!(
            run.parked_at_ms.is_some(),
            "a settled session never parked its flush timer: {run:?}"
        );
        // At most the deadline armed before the last acknowledgement landed,
        // which fires once, finds nothing runnable, and parks.
        assert!(run.flushes <= 1, "a settled session kept flushing: {run:?}");
    }

    /// A row inside its pacing window does not wake the owner loop early.
    ///
    /// The other half of the pacing contract: the resend deadline is the ONE
    /// wake a paced, unconfirmed row earns, and the loop must sleep until it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_paced_row_does_not_spin_the_owner_loop() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        sim.write_pty(b"x");
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;

        sim.write_pty(b"y");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);
        assert!(sim.peer_has_unacked_rows(&peer), "the echoed row is paced");

        // Shorter than both the acknowledgement's return and the re-send
        // deadline: nothing may wake the loop in here.
        let window_ms = SIM_ACK_DELAY_MS * 0.75;
        let run = viewers.run_for_ms(&mut sim, window_ms, 1).await;
        assert_eq!(
            run.wakeups, 0,
            "the owner loop woke inside a paced row's window: {run:?}"
        );
        assert_eq!(run.flushes, 0);
    }

    /// Harness: an acknowledgement lands exactly its modelled delay after the
    /// flush that earned it, and the daemon measures that delay exactly.
    ///
    /// With no jitter in the model the first sample replaces the blind
    /// baseline and the EWMA IS the delay; the re-send interval is then its
    /// clamp, which for the default viewer is the floor.
    #[tokio::test(flavor = "current_thread")]
    async fn an_acknowledgement_lands_exactly_its_delay_after_the_flush() {
        let mut sim = DisplaySim::new(80, 24);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        let peer = sim_peer_id(0);

        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        let flushed_at_ms = sim.now_ms();
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);
        assert!(
            sim.has_pending_acks(),
            "the viewer applied a frame and owes an ACK"
        );

        assert_eq!(sim.step().await, Some(SimWake::Ack));
        assert_eq!(sim.now_ms(), flushed_at_ms + SIM_ACK_DELAY_MS);
        assert_eq!(sim.display_confirm_ewma_ms(&peer), SIM_ACK_DELAY_MS);
        // The default viewer confirms no slower than the path's round trip, so
        // the physical floor binds, not the measured confirmation.
        assert!(SIM_ACK_DELAY_MS <= sim.peer_round_trip_floor_ms(&peer));
        assert_eq!(
            sim.peer_row_resend_interval_ms(&peer),
            sim.peer_round_trip_floor_ms(&peer),
            "on the default viewer the round-trip floor binds"
        );

        // One ACK per change: nothing new applied, nothing new owed.
        viewers.acknowledge(&mut sim);
        assert!(
            !sim.has_pending_acks(),
            "an unchanged window was acknowledged twice"
        );
    }

    /// Harness: a slow viewer lifts the re-send interval to its own delay.
    #[tokio::test(flavor = "current_thread")]
    async fn a_slow_viewer_lifts_the_resend_interval_to_its_delay() {
        let mut sim = DisplaySim::new(80, 24);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        let peer = sim_peer_id(0);
        viewers
            .viewer(&peer)
            .set_ack_delay_ms(SIM_SLOW_ACK_DELAY_MS);

        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);
        // The paced row's deadline (the floor) falls before this viewer's
        // acknowledgement; an advance passes it over and delivers the ACK at
        // its own instant.
        sim.advance_ms(SIM_SLOW_ACK_DELAY_MS);
        assert!(!sim.has_pending_acks());

        assert_eq!(sim.display_confirm_ewma_ms(&peer), SIM_SLOW_ACK_DELAY_MS);
        assert_eq!(
            sim.peer_row_resend_interval_ms(&peer),
            SIM_SLOW_ACK_DELAY_MS
        );
    }

    /// Cold start begins from the conservative re-send floor, so a viewer whose
    /// first confirmation arrives later legitimately sees a bounded number of
    /// identical sends while the estimator learns the path. The old
    /// convergence-only oracle returned before any of these timers fired and
    /// reported zero by construction.
    #[tokio::test(flavor = "current_thread")]
    async fn cold_start_duplicates_are_visible_and_bounded() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        viewers
            .viewer(&peer)
            .set_ack_delay_ms(SIM_SLOW_ACK_DELAY_MS);

        sim.write_code_screen(1);
        let (_, elapsed_ms) = paints_to_settle(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
            .await
            .expect("a lossless session settles");

        let waste = sim.peer_waste(&peer);
        let max_resends_per_row = (SIM_SLOW_ACK_DELAY_MS
            / crate::display::policy::DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS)
            .ceil() as u64;
        assert!(
            waste.row_resends_identical > 0,
            "the oracle censored the cold-start re-send timers: {waste:?}"
        );
        assert!(
            waste.row_resends_identical <= waste.row_versions_sent * max_resends_per_row,
            "cold start took {elapsed_ms} ms and exceeded {max_resends_per_row} duplicates per \
             row version: {waste:?}"
        );

        let cold_duplicates = waste.row_resends_identical;
        let before_warm_repaint = waste;
        sim.write_code_screen(2);
        paints_to_settle(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
            .await
            .expect("the warmed repaint settles");
        let after_warm_repaint = sim.peer_waste(&peer);
        let warm_duplicates =
            after_warm_repaint.row_resends_identical - before_warm_repaint.row_resends_identical;
        assert!(
            warm_duplicates < cold_duplicates,
            "estimator warm-up did not reduce duplicates: cold={cold_duplicates} \
             warm={warm_duplicates}"
        );
    }

    /// Once the confirmation estimator has learned a stationary, lossless
    /// path, an unchanged row is confirmed no later than its measured re-send
    /// deadline. ACK-before-timer ordering therefore makes every identical
    /// re-send unnecessary and the exact steady-state count is zero.
    #[tokio::test(flavor = "current_thread")]
    async fn a_warmed_lossless_link_sends_no_identical_rows() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        viewers
            .viewer(&peer)
            .set_ack_delay_ms(SIM_SLOW_ACK_DELAY_MS);

        sim.write_pty(b"warm up estimator");
        paints_to_settle(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
            .await
            .expect("estimator warm-up settles");
        assert!(
            (sim.display_confirm_ewma_ms(&peer) - SIM_SLOW_ACK_DELAY_MS).abs()
                < f64::EPSILON * 256.0
        );
        let before = sim.peer_waste(&peer);

        sim.write_code_screen(1);
        paints_to_settle(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
            .await
            .expect("stationary lossless repaint settles");
        let after = sim.peer_waste(&peer);
        assert!(after.row_versions_sent > before.row_versions_sent);
        assert_eq!(
            after.row_resends_identical - before.row_resends_identical,
            0,
            "a warmed stationary lossless path resent identical rows: before={before:?} \
             after={after:?}"
        );
    }

    /// Losing the first ACK after estimator warm-up leaves a quiet tail with no
    /// later sequence to prove loss. One deadline-driven re-send must recover
    /// it, and the replacement ACK must then stop the timer rather than permit
    /// an unbounded duplicate loop.
    #[tokio::test(flavor = "current_thread")]
    async fn one_lost_ack_recovers_with_a_bounded_duplicate_tail() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        viewers
            .viewer(&peer)
            .set_ack_delay_ms(SIM_SLOW_ACK_DELAY_MS);
        sim.write_pty(b"warm up estimator");
        paints_to_settle(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
            .await
            .expect("estimator warm-up settles");
        let before = sim.peer_waste(&peer);

        sim.drop_next_acks(1);
        sim.write_code_screen(7);
        paints_to_settle(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
            .await
            .expect("the quiet tail recovers from one lost ACK");

        let after = sim.peer_waste(&peer);
        let versions = after.row_versions_sent - before.row_versions_sent;
        let duplicates = after.row_resends_identical - before.row_resends_identical;
        assert_eq!(sim.dropped_ack_count(), 1);
        assert!(duplicates > 0, "the lost ACK exercised no tail re-send");
        assert!(
            duplicates <= versions,
            "one lost ACK caused more than one duplicate per row version: versions={versions} \
             duplicates={duplicates}"
        );
    }

    /// Harness: a datagram is unreadable until its one-way delivery delay has
    /// elapsed, and that instant wakes the browser side of the model.
    #[tokio::test(flavor = "current_thread")]
    async fn a_datagram_arrives_on_its_delivery_wake() {
        const DOWNLINK_MS: f64 = 10.0;

        let mut sim = DisplaySim::new(80, 24);
        sim.set_downlink_delay_ms(DOWNLINK_MS);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);

        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        let sent_at_ms = sim.now_ms();
        viewers.pump(&sim);
        assert_eq!(
            viewers.totals().0,
            0,
            "the viewer read a datagram before its delivery instant"
        );

        assert_eq!(sim.step().await, Some(SimWake::Delivery));
        assert_eq!(sim.now_ms(), sent_at_ms + DOWNLINK_MS);
        viewers.pump(&sim);
        assert!(viewers.totals().0 > 0, "the delivery wake exposed no frame");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_unpredicted_key_pays_uplink_and_downlink_before_apply() {
        const ORIGIN_MS: f64 = 7.0;
        const UPLINK_MS: f64 = 31.0;
        const DOWNLINK_MS: f64 = 29.0;

        let mut sim = DisplaySim::new(80, 24);
        sim.set_downlink_delay_ms(DOWNLINK_MS);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        let peer = sim_peer_id(0);
        sim.schedule_input_echo(
            ORIGIN_MS,
            UPLINK_MS,
            &peer,
            1,
            vec![b'x'],
            b"\x1b[1;1Hx".to_vec(),
        );

        assert_eq!(sim.step().await, Some(SimWake::BrowserKey));
        assert_eq!(sim.now_ms(), ORIGIN_MS);
        assert_eq!(sim.step().await, Some(SimWake::Input));
        assert_eq!(sim.now_ms(), ORIGIN_MS + UPLINK_MS);
        assert_eq!(sim.step().await, Some(SimWake::Pty));
        assert_eq!(sim.now_ms(), ORIGIN_MS + UPLINK_MS);
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        assert_eq!(viewers.viewer(&peer).authoritative_input_seq, 0);
        loop {
            let wake = sim.step().await.expect("a display delivery remains due");
            viewers.pump(&sim);
            if wake == SimWake::Delivery {
                break;
            }
            assert_eq!(viewers.viewer(&peer).authoritative_input_seq, 0);
        }
        assert_eq!(viewers.viewer(&peer).authoritative_input_seq, 1);
        assert!(sim.now_ms() >= ORIGIN_MS + UPLINK_MS + DOWNLINK_MS);
    }

    /// Harness: when a datagram reaches the viewer exactly as its row's
    /// re-send timer expires, delivery is observed first. The ACK still takes
    /// its configured return delay, so the timer remains independently due.
    #[tokio::test(flavor = "current_thread")]
    async fn delivery_wins_a_tie_with_the_flush_timer() {
        let mut sim = DisplaySim::new(80, 24);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        // The row's re-send timer is the blind round-trip floor; land the
        // datagram exactly on it.
        let floor_ms = sim.peer_round_trip_floor_ms(&sim_peer_id(0));
        sim.set_downlink_delay_ms(floor_ms);

        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        assert_eq!(viewers.totals().0, 0);

        assert_eq!(sim.step().await, Some(SimWake::Delivery));
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);
        assert!(viewers.totals().0 > 0);
        assert_eq!(sim.step().await, Some(SimWake::Timer));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_reliable_snapshot_pays_the_same_one_way_delivery_delay() {
        const DOWNLINK_MS: f64 = 17.0;

        let mut sim = DisplaySim::new(200, 50);
        sim.set_downlink_delay_ms(DOWNLINK_MS);
        let mut viewers = SimViewers::attach(&mut sim, 200, 50);
        let peer = sim_peer_id(0);
        sim.write_noisy_screen(1);
        sim.request_snapshot(&peer);

        assert_eq!(sim.step().await, Some(SimWake::Timer));
        let sent_at_ms = sim.now_ms();
        assert!(
            sim.reliable_frames() > 0,
            "snapshot admitted no reliable records"
        );
        viewers.pump(&sim);
        assert_eq!(viewers.viewer(&peer).snapshots_applied, 0);

        assert_eq!(sim.step().await, Some(SimWake::Delivery));
        assert_eq!(sim.now_ms(), sent_at_ms + DOWNLINK_MS);
        viewers.pump(&sim);
        assert!(viewers.viewer(&peer).snapshots_applied > 0);
        assert!(
            sim.reliable()
                .windows(2)
                .all(|frames| { frames[0].deliver_at_ms <= frames[1].deliver_at_ms })
        );
    }

    #[tokio::test(flavor = "current_thread")]
    #[should_panic(expected = "cannot change downlink delay while frames are in flight")]
    async fn downlink_delay_cannot_change_with_a_frame_in_flight() {
        let mut sim = DisplaySim::new(80, 24);
        sim.set_downlink_delay_ms(10.0);
        let _viewers = SimViewers::attach(&mut sim, 80, 24);
        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        sim.set_downlink_delay_ms(20.0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fec_recovery_looks_up_nonzero_sequences_across_wrap() {
        use crate::display::{encoder::patch_stream_header, fec::FecEncoder};
        use merkur_codec::{CellRepr, FrameHeader, RowRef, encode_frame_into, row_hash};

        const COLS: u16 = 8;
        // Explicit identities keep the oracle independent of the lookup's
        // arithmetic. One parity shard must recover any one missing original,
        // including when the only retained originals follow MAX -> 1.
        for sequences in [
            &[u32::MAX, 1][..],
            &[u32::MAX - 1, u32::MAX, 1][..],
            &[u32::MAX - 1, u32::MAX, 1, 2][..],
        ] {
            let rows = sequences.len() as u16;
            let mut frames = Vec::new();
            let mut expected_hashes = Vec::new();
            for (index, &seq) in sequences.iter().enumerate() {
                let mut cells = vec![CellRepr::BLANK; usize::from(COLS)];
                for (col, cell) in cells.iter_mut().enumerate() {
                    cell.codepoint = u32::from(b'A') + (index * 8 + col) as u32;
                    cell.attrs = cell
                        .attrs
                        .with(merkur_codec::CellAttrs::BOLD, index % 2 == 0);
                    cell.set_wrapped(col + 1 == usize::from(COLS) && index + 1 < sequences.len());
                }
                expected_hashes.push(row_hash(&cells));
                let header = FrameHeader {
                    memory_only: false,
                    kind: FrameKind::Delta,
                    cols: COLS,
                    rows,
                    cursor_col: 0,
                    cursor_row: 0,
                    cursor_shape: 1,
                    cursor_visible: 1,
                    mode_flags: 0,
                    row_count: 1,
                    frame_id: index as u32 + 1,
                    presentation_id: 91,
                    presentation_member_index: index as u16,
                    presentation_member_count: rows,
                    row_predecessor_presentation_id: 0,
                    presentation_coherent: true,
                    presentation_end: index + 1 == sequences.len(),
                    chunk_index: 0,
                    chunk_count: 1,
                    demand_serial: 0,
                    demand_limited: false,
                    demand_prompt: false,
                    demand_awaits_grant: false,
                    closure_digest: 0,
                    scroll_serial: 0,
                    echo_horizon: 0,
                };
                let mut frame = Vec::new();
                encode_frame_into(
                    &mut frame,
                    &header,
                    std::iter::once(RowRef {
                        graphics: &[],
                        row_index: index as u16,
                        left: 0,
                        cells: &cells,
                    }),
                );
                patch_stream_header(
                    &mut frame,
                    seq,
                    1,
                    0,
                    header.frame_id,
                    91,
                    true,
                    header.presentation_end,
                    0,
                    1,
                    index as u16,
                    rows,
                )
                .unwrap();
                frame[1] |= merkur_codec::DISPLAY_HEADER_FLAG_FEC_PROTECTED;
                frames.push(frame);
            }
            let payloads: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
            let repair = FecEncoder::new()
                .encode_borrowed_group(1, sequences[0], &payloads, 1)
                .expect("the actual encoder protects the wrapped sequence group");

            for missing in (0..sequences.len()).map(Some).chain(std::iter::once(None)) {
                for reverse in [false, true] {
                    let mut sim = DisplaySim::new(COLS, rows);
                    let mut viewers = SimViewers::attach(&mut sim, COLS, rows);
                    let viewer = viewers.viewer(&sim_peer_id(0));
                    for ordinal in 0..sequences.len() {
                        let index = if reverse {
                            sequences.len() - 1 - ordinal
                        } else {
                            ordinal
                        };
                        if missing != Some(index) {
                            SimViewers::deliver(viewer, &frames[index], rows, false, 1.0);
                        }
                    }
                    SimViewers::deliver(viewer, &repair, rows, false, 2.0);
                    assert_eq!(
                        viewer.recovered_by_fec,
                        usize::from(missing.is_some()),
                        "sequences={sequences:?} missing={missing:?} reverse={reverse}"
                    );
                    assert_eq!(viewer.applied_frames, sequences.len());
                    assert_eq!(viewer.apply_rejected, 0);
                    assert_eq!(viewer.row_hashes(rows), expected_hashes);
                    assert!(!viewer.retained.contains_key(&(1, 0)));
                    let newest = *sequences.last().unwrap();
                    assert_eq!(viewer.ack.largest(), newest);
                    let mut expected_ack = [0; crate::display::policy::DISPLAY_ACK_MASK_WORDS];
                    let mut expected_recovered =
                        [0; crate::display::policy::DISPLAY_ACK_MASK_WORDS];
                    for (index, &seq) in sequences.iter().enumerate() {
                        assert_eq!(viewer.retained.get(&(1, seq)), Some(&frames[index]));
                        // ACK displacement deliberately includes the zero slot;
                        // only the FEC group's allocated identities skip zero.
                        let offset = newest.wrapping_sub(seq);
                        expected_ack[(offset >> 5) as usize] |= 1 << (offset & 31);
                        if missing == Some(index) {
                            expected_recovered[(offset >> 5) as usize] |= 1 << (offset & 31);
                        }
                    }
                    assert_eq!(viewer.ack.received(), expected_ack);
                    assert_eq!(viewer.ack.recovered(), expected_recovered);
                    assert_eq!(viewer.skipped_repair, usize::from(missing.is_none()));
                    // Once all originals are held, parity must not manufacture
                    // another recovery merely because the group crossed zero.
                    SimViewers::deliver(viewer, &repair, rows, false, 3.0);
                    assert_eq!(viewer.recovered_by_fec, usize::from(missing.is_some()));
                    assert_eq!(viewer.applied_frames, sequences.len());
                    assert_eq!(viewer.skipped_repair, 1 + usize::from(missing.is_none()));
                }
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn explicit_faults_drop_both_data_and_repair_datagrams() {
        // Discover the roles from a lossless run instead of pinning physical
        // indices. Packet-shape changes are exactly what this harness exists
        // to compare, so a hard-coded "repair is index 6" oracle immediately
        // becomes a data/data test when the grouping policy changes.
        let mut oracle = DisplaySim::new(200, 50);
        let _oracle_viewers = SimViewers::attach(&mut oracle, 200, 50);
        oracle.write_noisy_screen(1);
        assert_eq!(oracle.step().await, Some(SimWake::Timer));
        let repair = oracle
            .wire()
            .iter()
            .find(|frame| frame.metadata.role == SimDatagramRole::Repair)
            .expect("the full redraw emits a repair");
        let repair_index = repair.index;
        let protected_ordinal = repair.metadata.logical_ordinal;
        let data_index = oracle
            .wire()
            .iter()
            .find(|frame| {
                frame.metadata.role == SimDatagramRole::Data
                    && frame.metadata.logical_ordinal == protected_ordinal
            })
            .expect("repair names an admitted data group")
            .index;

        // Losing just that protected data datagram must exercise the real
        // browser recovery path. This exact fault is the deterministic FEC
        // oracle; a percentage-loss seed is allowed to hit several shards in
        // one group and therefore is not evidence that FEC itself regressed.
        let mut recovery_sim = DisplaySim::new(200, 50);
        let mut recovery_viewers = SimViewers::attach(&mut recovery_sim, 200, 50);
        let recovery_peer = sim_peer_id(0);
        recovery_sim.set_drop_indices(&[data_index]);
        recovery_sim.write_noisy_screen(1);
        flushes_to_convergence(
            &mut recovery_sim,
            &mut recovery_viewers,
            &recovery_peer,
            512,
        )
        .await
        .expect("one protected data loss converges through FEC");
        assert!(
            recovery_viewers.viewer(&recovery_peer).recovered_by_fec > 0,
            "a delivered repair did not reconstruct its one missing data shard"
        );

        let mut sim = DisplaySim::new(200, 50);
        let mut viewers = SimViewers::attach(&mut sim, 200, 50);
        let peer = sim_peer_id(0);
        let faults = vec![data_index, repair_index];
        sim.set_drop_indices(&faults);
        sim.write_noisy_screen(1);
        flushes_to_convergence(&mut sim, &mut viewers, &peer, 512)
            .await
            .expect("explicit-fault session converges");

        let counters = viewers.viewer(&peer).transport_counters;
        assert!(counters.dropped_datagram_data.packets > 0, "{counters:?}");
        assert!(counters.dropped_datagram_repair.packets > 0, "{counters:?}");
        assert_eq!(sim.drop_log(), faults);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn scalar_replication_converges_when_one_or_both_physical_copies_are_lost() {
        for faults in [&[0u64][..], &[0u64, 1][..]] {
            let mut sim = DisplaySim::new(80, 24);
            let mut viewers = SimViewers::attach(&mut sim, 80, 24);
            let peer = sim_peer_id(0);
            sim.promote_k1_replication(&peer, PeerTransport::WebTransport);
            sim.set_drop_indices(faults);
            sim.write_pty(b"x");
            flushes_to_convergence(&mut sim, &mut viewers, &peer, 512)
                .await
                .unwrap_or_else(|| panic!("k=1 loss schedule {faults:?} did not converge"));

            let counters = viewers.viewer(&peer).transport_counters;
            assert_counter_balance(counters);
            assert!(
                counters.dropped_datagram_data.packets > 0,
                "{faults:?}: {counters:?}"
            );
            if faults.len() == 1 {
                assert!(
                    counters.delivered_datagram_replica.packets > 0,
                    "the surviving replica did not deliver: {counters:?}"
                );
            } else {
                assert!(
                    counters.dropped_datagram_replica.packets > 0,
                    "the second physical copy was not classified as a replica: {counters:?}"
                );
                assert!(
                    counters.admitted_datagram_data.packets > 1,
                    "losing both copies did not exercise ordinary resend convergence: {counters:?}"
                );
            }
            assert_eq!(sim.drop_log(), faults);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn clean_rowless_probes_eventually_disable_scalar_replication() {
        const GROUPS: usize = 560;

        let mut sim = DisplaySim::new(80, 24);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        let peer = sim_peer_id(0);
        sim.promote_k1_replication(&peer, PeerTransport::WebTransport);

        for group in 0..GROUPS {
            let cell = if group & 1 == 0 { 'x' } else { 'y' };
            sim.write_pty(format!("\x1b[1;1H{cell}").as_bytes());
            flushes_to_convergence(&mut sim, &mut viewers, &peer, 64)
                .await
                .unwrap_or_else(|| panic!("scalar group {group} did not converge"));
            // Convergence observes the downlink apply. Give the ACK its own
            // return leg before producing the next independent sample.
            viewers.run_for_ms(&mut sim, 25.0, 64).await;
        }

        let replicas_before_demoted_send = {
            let viewer = viewers.viewer(&peer);
            assert_eq!(viewer.rejected, 0, "a rowless probe was not a valid patch");
            assert_eq!(
                viewer.transport_counters.admitted_datagram_probe.packets, 32,
                "the controller must collect exactly 32 successful experiments before demotion"
            );
            assert_eq!(
                viewer.transport_counters.delivered_datagram_probe.packets, 32,
                "every lossless probe must reach the ACK window"
            );
            viewer.transport_counters.admitted_datagram_replica.packets
        };
        assert!(
            !sim.k1_replication_enabled(&peer, PeerTransport::WebTransport),
            "32 clean rowless probes did not disable scalar replication"
        );

        sim.write_pty(b"\x1b[1;1Hz");
        flushes_to_convergence(&mut sim, &mut viewers, &peer, 64)
            .await
            .expect("post-demotion scalar group converges");
        assert_eq!(
            viewers
                .viewer(&peer)
                .transport_counters
                .admitted_datagram_replica
                .packets,
            replicas_before_demoted_send,
            "the first scalar group after demotion was still replicated"
        );
    }

    #[derive(Debug)]
    struct LinkProfileOutcome {
        round_trip_ms: f64,
        loss_pct: u32,
        elapsed_ms: f64,
        paints: usize,
        dropped: usize,
        waste: crate::connection::DisplayWasteCounters,
        patch_wire_bytes: usize,
        replica_wire_bytes: usize,
        repair_wire_bytes: usize,
        recovered_by_fec: usize,
        counters: SimTransportCounters,
    }

    fn tally_delta(after: SimFrameTally, before: SimFrameTally) -> SimFrameTally {
        SimFrameTally {
            packets: after.packets - before.packets,
            bytes: after.bytes - before.bytes,
        }
    }

    fn role_counter_delta(
        after: SimDatagramRoleCounters,
        before: SimDatagramRoleCounters,
    ) -> SimDatagramRoleCounters {
        SimDatagramRoleCounters {
            data: tally_delta(after.data, before.data),
            replica: tally_delta(after.replica, before.replica),
            repair: tally_delta(after.repair, before.repair),
            probe: tally_delta(after.probe, before.probe),
        }
    }

    fn path_counter_delta(
        after: SimDatagramPathCounters,
        before: SimDatagramPathCounters,
    ) -> SimDatagramPathCounters {
        SimDatagramPathCounters {
            admitted: role_counter_delta(after.admitted, before.admitted),
            delivered: role_counter_delta(after.delivered, before.delivered),
            dropped: role_counter_delta(after.dropped, before.dropped),
        }
    }

    fn counter_delta(
        after: SimTransportCounters,
        before: SimTransportCounters,
    ) -> SimTransportCounters {
        SimTransportCounters {
            admitted_datagram_data: tally_delta(
                after.admitted_datagram_data,
                before.admitted_datagram_data,
            ),
            admitted_datagram_replica: tally_delta(
                after.admitted_datagram_replica,
                before.admitted_datagram_replica,
            ),
            admitted_datagram_repair: tally_delta(
                after.admitted_datagram_repair,
                before.admitted_datagram_repair,
            ),
            admitted_datagram_probe: tally_delta(
                after.admitted_datagram_probe,
                before.admitted_datagram_probe,
            ),
            admitted_logical_datagram_data: tally_delta(
                after.admitted_logical_datagram_data,
                before.admitted_logical_datagram_data,
            ),
            admitted_reliable_data: tally_delta(
                after.admitted_reliable_data,
                before.admitted_reliable_data,
            ),
            admitted_reliable_repair: tally_delta(
                after.admitted_reliable_repair,
                before.admitted_reliable_repair,
            ),
            delivered_datagram_data: tally_delta(
                after.delivered_datagram_data,
                before.delivered_datagram_data,
            ),
            delivered_datagram_replica: tally_delta(
                after.delivered_datagram_replica,
                before.delivered_datagram_replica,
            ),
            delivered_datagram_repair: tally_delta(
                after.delivered_datagram_repair,
                before.delivered_datagram_repair,
            ),
            delivered_datagram_probe: tally_delta(
                after.delivered_datagram_probe,
                before.delivered_datagram_probe,
            ),
            delivered_reliable_data: tally_delta(
                after.delivered_reliable_data,
                before.delivered_reliable_data,
            ),
            delivered_reliable_repair: tally_delta(
                after.delivered_reliable_repair,
                before.delivered_reliable_repair,
            ),
            dropped_datagram_data: tally_delta(
                after.dropped_datagram_data,
                before.dropped_datagram_data,
            ),
            dropped_datagram_replica: tally_delta(
                after.dropped_datagram_replica,
                before.dropped_datagram_replica,
            ),
            dropped_datagram_repair: tally_delta(
                after.dropped_datagram_repair,
                before.dropped_datagram_repair,
            ),
            dropped_datagram_probe: tally_delta(
                after.dropped_datagram_probe,
                before.dropped_datagram_probe,
            ),
            webtransport: path_counter_delta(after.webtransport, before.webtransport),
            edge: path_counter_delta(after.edge, before.edge),
        }
    }

    fn assert_counter_balance(counters: SimTransportCounters) {
        for (admitted, delivered, dropped) in [
            (
                counters.admitted_datagram_data,
                counters.delivered_datagram_data,
                counters.dropped_datagram_data,
            ),
            (
                counters.admitted_datagram_replica,
                counters.delivered_datagram_replica,
                counters.dropped_datagram_replica,
            ),
            (
                counters.admitted_datagram_repair,
                counters.delivered_datagram_repair,
                counters.dropped_datagram_repair,
            ),
            (
                counters.admitted_datagram_probe,
                counters.delivered_datagram_probe,
                counters.dropped_datagram_probe,
            ),
        ] {
            assert_eq!(admitted.packets, delivered.packets + dropped.packets);
            assert_eq!(admitted.bytes, delivered.bytes + dropped.bytes);
        }
        for path in [counters.webtransport, counters.edge] {
            for (admitted, delivered, dropped) in [
                (path.admitted.data, path.delivered.data, path.dropped.data),
                (
                    path.admitted.replica,
                    path.delivered.replica,
                    path.dropped.replica,
                ),
                (
                    path.admitted.repair,
                    path.delivered.repair,
                    path.dropped.repair,
                ),
                (
                    path.admitted.probe,
                    path.delivered.probe,
                    path.dropped.probe,
                ),
            ] {
                assert_eq!(admitted.packets, delivered.packets + dropped.packets);
                assert_eq!(admitted.bytes, delivered.bytes + dropped.bytes);
            }
        }
        assert_eq!(
            counters.admitted_reliable_data, counters.delivered_reliable_data,
            "the modelled reliable stream is ordered and lossless"
        );
        assert_eq!(
            counters.admitted_reliable_repair, counters.delivered_reliable_repair,
            "the modelled reliable stream is ordered and lossless"
        );
    }

    /// Measure one deterministic impaired link with asymmetric one-way delay.
    /// Four full repaint rounds exercise recovery and account for both FEC and
    /// identical row re-sends. Packet grouping follows measured planner costs,
    /// so a seeded physical loss does not prescribe which mechanism wins.
    async fn measure_link_profile(round_trip_ms: f64, loss_pct: u32) -> LinkProfileOutcome {
        const COLS: u16 = 200;
        const ROWS: u16 = 50;
        const PROFILE_SETTLE_BUDGET_MS: f64 = 7_000.0;
        // This seed drops indices 16, 24, and 36 even at 1%, so every matrix
        // arm actually enters the loss regime within this bounded workload.
        const SEED: u64 = 8;

        // Deliberately asymmetric, so profile traffic does not manufacture a
        // downlink/timer tie. Exact ACK/timer ties remain production-consistent
        // and are pinned independently below.
        let downlink_ms = round_trip_ms * 0.47;
        let uplink_ms = round_trip_ms - downlink_ms;
        let mut sim = DisplaySim::new(COLS, ROWS);
        sim.set_downlink_delay_ms(downlink_ms);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        viewers.viewer(&peer).set_ack_delay_ms(uplink_ms);
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);
        sim.warm_confirmation_estimator(round_trip_ms);
        sim.set_loss(loss_pct, SEED);

        let mut paints = 0usize;
        let started_ms = sim.now_ms();
        for round in 0..4u64 {
            sim.write_noisy_screen(round + 1);
            let (round_paints, _) =
                paints_to_convergence(&mut sim, &mut viewers, &peer, PROFILE_SETTLE_BUDGET_MS)
                    .await
                    .unwrap_or_else(|| {
                        panic!("{round_trip_ms} ms profile did not converge in round {round}")
                    });
            paints += round_paints;
            viewers
                .run_for_ms(&mut sim, round_trip_ms * 3.0, 4_096)
                .await;
        }

        let viewer = viewers.viewer(&peer);
        LinkProfileOutcome {
            round_trip_ms,
            loss_pct,
            elapsed_ms: sim.now_ms() - started_ms,
            paints,
            dropped: sim.dropped_count(),
            waste: sim.peer_waste(&peer),
            patch_wire_bytes: viewer.patch_wire_bytes,
            replica_wire_bytes: viewer.replica_wire_bytes,
            repair_wire_bytes: viewer.repair_wire_bytes,
            recovered_by_fec: viewer.recovered_by_fec,
            counters: viewer.transport_counters,
        }
    }

    fn assert_link_profile_is_instrumented(outcome: &LinkProfileOutcome) {
        let waste = outcome.waste;
        assert!(outcome.round_trip_ms > 0.0);
        assert!(matches!(outcome.loss_pct, 0 | 1 | 5 | 10));
        assert!(outcome.elapsed_ms >= outcome.round_trip_ms);
        assert!(outcome.paints > 0, "the profile ran no paint: {outcome:?}");
        assert_counter_balance(outcome.counters);
        assert_eq!(
            outcome.counters.admitted_reliable_repair,
            SimFrameTally::default(),
            "FEC repair must never fall back to the reliable lane: {outcome:?}"
        );
        assert!(waste.row_versions_sent > 0, "no row versions: {outcome:?}");
        if outcome.loss_pct == 0 {
            assert_eq!(
                outcome.dropped, 0,
                "a lossless profile dropped data: {outcome:?}"
            );
            assert_eq!(
                waste.rows_declared_lost, 0,
                "a lossless profile declared rows lost: {outcome:?}"
            );
        } else {
            assert!(
                outcome.dropped > 0,
                "seeded loss dropped nothing: {outcome:?}"
            );
            assert!(
                waste.rows_declared_lost > 0 || outcome.recovered_by_fec > 0,
                "neither selective ACK nor FEC resolved a dropped frame: {outcome:?}"
            );
        }
        assert!(
            waste.fec_repairs_sent > 0,
            "FEC emitted no repair: {outcome:?}"
        );
        assert_eq!(
            waste.fec_repairs_refused, 0,
            "the in-memory carrier refused FEC: {outcome:?}"
        );
        assert!(
            outcome.patch_wire_bytes > 0,
            "no patch bytes arrived: {outcome:?}"
        );
        if outcome.loss_pct == 0 {
            assert_eq!(
                outcome.replica_wire_bytes, 0,
                "lossless traffic must not pay scalar replication: {outcome:?}"
            );
        }
        assert!(
            outcome.repair_wire_bytes > 0,
            "no repair bytes arrived: {outcome:?}"
        );
        // Percentage loss can hit an unprotected packet or exhaust a group's
        // parity. Convergence and the loss/FEC evidence above cover that case;
        // explicit_faults_drop_both_data_and_repair_datagrams independently
        // requires FEC recovery after losing exactly one protected data shard.
    }

    async fn assert_link_profile_matrix(round_trip_ms: f64) {
        for loss_pct in [0, 1, 5, 10] {
            let outcome = measure_link_profile(round_trip_ms, loss_pct).await;
            println!("LINK_PROFILE {outcome:?}");
            assert_link_profile_is_instrumented(&outcome);
        }
    }

    #[derive(Debug)]
    struct TypingProfileOutcome {
        round_trip_ms: f64,
        loss_pct: u32,
        during_output: bool,
        input_to_apply_ms: Vec<f64>,
        patch_datagrams_per_key: f64,
        replica_datagrams_per_key: f64,
        repair_datagrams_per_key: f64,
        patch_bytes_per_key: f64,
        replica_bytes_per_key: f64,
        repair_bytes_per_key: f64,
        dropped: usize,
        counters: SimTransportCounters,
    }

    /// Precompute the exact cumulative typed-row states, schedule the complete
    /// browser-origin -> uplink -> daemon -> PTY path, and arm the viewer-side
    /// probe before virtual time advances. All vectors and queued payloads are
    /// allocated here, outside the display drain being measured.
    fn schedule_typing_visibility_probe(
        sim: &mut DisplaySim,
        viewers: &mut SimViewers,
        peer: &str,
        dimensions: (u16, u16),
        keys: usize,
        inter_key_ms: f64,
        uplink_ms: f64,
    ) {
        let (cols, rows) = dimensions;
        let started_ms = sim.now_ms();
        let mut input_origin_ms = Vec::with_capacity(keys);
        let mut expected_row_hashes = Vec::with_capacity(keys);
        let mut oracle_hashes = Vec::with_capacity(usize::from(rows));
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut oracle = crate::pty::TerminalState::new(cols, rows, event_tx);

        for index in 0..keys {
            let delay_ms = index as f64 * inter_key_ms;
            input_origin_ms.push(started_ms + delay_ms);
            let echo_bytes = format!(
                "\x1b[1;{}H{}",
                index + 1,
                char::from(b'a' + (index % 26) as u8)
            )
            .into_bytes();
            oracle.apply_bytes(&echo_bytes);
            oracle.current_row_hashes_into(&mut oracle_hashes);
            expected_row_hashes.push(oracle_hashes[0]);

            sim.schedule_input_echo(
                delay_ms,
                uplink_ms,
                peer,
                (index + 1) as u32,
                vec![b'a' + (index % 26) as u8],
                echo_bytes,
            );
        }
        viewers
            .viewer(peer)
            .arm_typing_visibility_probe(0, input_origin_ms, expected_row_hashes);
    }

    /// Run a fixed-cadence input stream through the virtual event queue. Input
    /// sequence advertisement identifies which scheduled keystrokes an applied
    /// frame covers. The viewer records only a successful row-bearing apply
    /// whose row hash is the exact precomputed cumulative state for that high
    /// water; it never infers per-key latency from final convergence.
    async fn measure_typing_profile(
        round_trip_ms: f64,
        loss_pct: u32,
        during_output: bool,
    ) -> TypingProfileOutcome {
        measure_typing_profile_arm(round_trip_ms, loss_pct, during_output, false, 8).await
    }

    async fn measure_typing_profile_arm(
        round_trip_ms: f64,
        loss_pct: u32,
        during_output: bool,
        replicate_from_start: bool,
        loss_seed: u64,
    ) -> TypingProfileOutcome {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        const KEYS: usize = 24;
        const INTER_KEY_MS: f64 = 19.3;
        const PROFILE_SETTLE_BUDGET_MS: f64 = 7_000.0;
        let downlink_ms = round_trip_ms * 0.47;
        let uplink_ms = round_trip_ms - downlink_ms;
        let mut sim = DisplaySim::new(COLS, ROWS);
        sim.set_downlink_delay_ms(downlink_ms);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        viewers.viewer(&peer).set_ack_delay_ms(uplink_ms);
        sim.warm_confirmation_estimator(round_trip_ms);
        sim.set_loss(loss_pct, loss_seed);
        if replicate_from_start {
            sim.promote_k1_replication(&peer, PeerTransport::WebTransport);
        }

        schedule_typing_visibility_probe(
            &mut sim,
            &mut viewers,
            &peer,
            (COLS, ROWS),
            KEYS,
            INTER_KEY_MS,
            uplink_ms,
        );
        if during_output {
            // Output lands on rows below the typed line at twice the key
            // cadence, keeping the producer active without invalidating row
            // zero's version oracle.
            for index in 0..KEYS * 2 {
                let row = 2 + (index % (usize::from(ROWS) - 1));
                sim.schedule_pty_write(
                    index as f64 * (INTER_KEY_MS / 2.0),
                    format!("\x1b[{row};1Houtput-{index:03}-xxxxxxxxxxxxxxxx\x1b[K").into_bytes(),
                );
            }
        }

        let before = {
            let viewer = viewers.viewer(&peer);
            (
                viewer.patch_wire_datagrams,
                viewer.replica_wire_datagrams,
                viewer.repair_wire_datagrams,
                viewer.patch_wire_bytes,
                viewer.replica_wire_bytes,
                viewer.repair_wire_bytes,
                viewer.transport_counters,
            )
        };
        for _ in 0..20_000 {
            let Some(_wake) = sim.step().await else {
                break;
            };
            viewers.pump(&sim);
            viewers.acknowledge(&mut sim);

            if viewers.viewer(&peer).typing_visibility_complete() && !sim.has_pending_pty_writes() {
                break;
            }
        }
        let input_to_apply_ms = viewers.viewer(&peer).take_typing_visibility_latencies();
        assert_eq!(
            input_to_apply_ms.len(),
            KEYS,
            "not every scheduled key reached row zero at {round_trip_ms} ms/{loss_pct}% loss"
        );
        paints_to_convergence(&mut sim, &mut viewers, &peer, PROFILE_SETTLE_BUDGET_MS)
            .await
            .expect("typing profile tail converges");

        let after = {
            let viewer = viewers.viewer(&peer);
            (
                viewer.patch_wire_datagrams,
                viewer.replica_wire_datagrams,
                viewer.repair_wire_datagrams,
                viewer.patch_wire_bytes,
                viewer.replica_wire_bytes,
                viewer.repair_wire_bytes,
                viewer.transport_counters,
            )
        };
        let keys = KEYS as f64;
        let counters = counter_delta(after.6, before.6);
        TypingProfileOutcome {
            round_trip_ms,
            loss_pct,
            during_output,
            input_to_apply_ms,
            patch_datagrams_per_key: (after.0 - before.0) as f64 / keys,
            replica_datagrams_per_key: (after.1 - before.1) as f64 / keys,
            repair_datagrams_per_key: (after.2 - before.2) as f64 / keys,
            patch_bytes_per_key: (after.3 - before.3) as f64 / keys,
            replica_bytes_per_key: (after.4 - before.4) as f64 / keys,
            repair_bytes_per_key: (after.5 - before.5) as f64 / keys,
            dropped: sim.dropped_count(),
            counters,
        }
    }

    fn assert_typing_profile(outcome: &TypingProfileOutcome) {
        assert_eq!(outcome.input_to_apply_ms.len(), 24);
        assert!(outcome.patch_datagrams_per_key > 0.0, "{outcome:?}");
        assert!(outcome.patch_bytes_per_key > 0.0, "{outcome:?}");
        assert!(outcome.replica_datagrams_per_key >= 0.0);
        assert!(outcome.replica_bytes_per_key >= 0.0);
        assert!(outcome.repair_datagrams_per_key >= 0.0);
        assert!(outcome.repair_bytes_per_key >= 0.0);
        assert_counter_balance(outcome.counters);
        assert!(outcome.input_to_apply_ms.iter().all(|latency_ms| {
            latency_ms.is_finite() && *latency_ms >= outcome.round_trip_ms - 1e-9
        }));
        if outcome.loss_pct == 0 {
            assert_eq!(outcome.dropped, 0);
        }
        let mut distribution = outcome.input_to_apply_ms.clone();
        distribution.sort_by(f64::total_cmp);
        let p50 = distribution[distribution.len() / 2];
        let p90 = distribution[distribution.len() * 9 / 10];
        println!(
            "TYPING_PROFILE rtt_ms={} loss_pct={} during_output={} \
             latency_min/p50/p90/max={:.1}/{p50:.1}/{p90:.1}/{:.1} \
             patch_datagrams/key={:.3} replica_datagrams/key={:.3} repair_datagrams/key={:.3} \
             patch_bytes/key={:.1} replica_bytes/key={:.1} repair_bytes/key={:.1} \
             admitted_data_packets/bytes={}/{} admitted_replica_packets/bytes={}/{} admitted_repair_packets/bytes={}/{} \
             reliable_data_packets/bytes={}/{} reliable_repair_packets/bytes={}/{} \
             delivered_data_packets/bytes={}/{} delivered_replica_packets/bytes={}/{} delivered_repair_packets/bytes={}/{} \
             dropped_data_packets/bytes={}/{} dropped_replica_packets/bytes={}/{} dropped_repair_packets/bytes={}/{} dropped={}",
            outcome.round_trip_ms,
            outcome.loss_pct,
            outcome.during_output,
            distribution[0],
            distribution[distribution.len() - 1],
            outcome.patch_datagrams_per_key,
            outcome.replica_datagrams_per_key,
            outcome.repair_datagrams_per_key,
            outcome.patch_bytes_per_key,
            outcome.replica_bytes_per_key,
            outcome.repair_bytes_per_key,
            outcome.counters.admitted_datagram_data.packets,
            outcome.counters.admitted_datagram_data.bytes,
            outcome.counters.admitted_datagram_replica.packets,
            outcome.counters.admitted_datagram_replica.bytes,
            outcome.counters.admitted_datagram_repair.packets,
            outcome.counters.admitted_datagram_repair.bytes,
            outcome.counters.admitted_reliable_data.packets,
            outcome.counters.admitted_reliable_data.bytes,
            outcome.counters.admitted_reliable_repair.packets,
            outcome.counters.admitted_reliable_repair.bytes,
            outcome.counters.delivered_datagram_data.packets,
            outcome.counters.delivered_datagram_data.bytes,
            outcome.counters.delivered_datagram_replica.packets,
            outcome.counters.delivered_datagram_replica.bytes,
            outcome.counters.delivered_datagram_repair.packets,
            outcome.counters.delivered_datagram_repair.bytes,
            outcome.counters.dropped_datagram_data.packets,
            outcome.counters.dropped_datagram_data.bytes,
            outcome.counters.dropped_datagram_replica.packets,
            outcome.counters.dropped_datagram_replica.bytes,
            outcome.counters.dropped_datagram_repair.packets,
            outcome.counters.dropped_datagram_repair.bytes,
            outcome.dropped,
        );
    }

    async fn assert_typing_profile_matrix(round_trip_ms: f64) {
        for loss_pct in [0, 1, 5, 10] {
            let solo = measure_typing_profile(round_trip_ms, loss_pct, false).await;
            assert_typing_profile(&solo);
            let contention = measure_typing_profile(round_trip_ms, loss_pct, true).await;
            assert_typing_profile(&contention);
            assert!(
                contention.counters.admitted_datagram_data.bytes
                    > solo.counters.admitted_datagram_data.bytes,
                "typing-during-output admitted no additional data bytes: \
                 solo={solo:?} contention={contention:?}"
            );
            assert!(
                contention.patch_bytes_per_key > solo.patch_bytes_per_key,
                "contention did not increase delivered bytes/key: \
                 solo={solo:?} contention={contention:?}"
            );
        }
    }

    fn admitted_datagram_bytes(counters: SimTransportCounters) -> usize {
        counters.admitted_datagram_data.bytes
            + counters.admitted_datagram_replica.bytes
            + counters.admitted_datagram_repair.bytes
            + counters.admitted_datagram_probe.bytes
    }

    fn profile_percentile(outcome: &TypingProfileOutcome, numerator: usize) -> f64 {
        let mut distribution = outcome.input_to_apply_ms.clone();
        distribution.sort_by(f64::total_cmp);
        distribution[distribution.len() * numerator / 10]
    }

    /// Paired experiment for the adaptive scalar policy. Both arms run the
    /// production send/apply/ACK path and use the same sender-stable data-loss
    /// identities; the control differs only by entering the already-proven
    /// replication state before the first key. The 24-key profile is shorter
    /// than the 32-probe demotion interval, so that arm is the superseded
    /// unconditional replay policy rather than a second adaptive run.
    #[tokio::test(flavor = "current_thread")]
    async fn adaptive_k1_replication_is_a_paired_wire_win_without_p90_regression() {
        const INTER_KEY_MS: f64 = 19.3;

        for round_trip_ms in [50.0, 120.0, 200.0] {
            for loss_pct in [0, 1, 5, 10] {
                for during_output in [false, true] {
                    let adaptive = measure_typing_profile_arm(
                        round_trip_ms,
                        loss_pct,
                        during_output,
                        false,
                        8,
                    )
                    .await;
                    let unconditional =
                        measure_typing_profile_arm(round_trip_ms, loss_pct, during_output, true, 8)
                            .await;
                    let adaptive_bytes = admitted_datagram_bytes(adaptive.counters);
                    let unconditional_bytes = admitted_datagram_bytes(unconditional.counters);
                    let adaptive_p90 = profile_percentile(&adaptive, 9);
                    let unconditional_p90 = profile_percentile(&unconditional, 9);
                    let adaptive_max = adaptive
                        .input_to_apply_ms
                        .iter()
                        .copied()
                        .fold(0.0, f64::max);
                    let unconditional_max = unconditional
                        .input_to_apply_ms
                        .iter()
                        .copied()
                        .fold(0.0, f64::max);

                    println!(
                        "PAIRED_K1 rtt_ms={round_trip_ms} loss_pct={loss_pct} \
                         during_output={during_output} bytes={adaptive_bytes}/{unconditional_bytes} \
                         p90_ms={adaptive_p90}/{unconditional_p90} \
                         max_ms={adaptive_max}/{unconditional_max}"
                    );
                    assert!(
                        adaptive_bytes < unconditional_bytes,
                        "adaptive replay saved no wire bytes: adaptive={adaptive:?} \
                         unconditional={unconditional:?}"
                    );
                    assert!(
                        adaptive_p90 <= unconditional_p90 + 1e-9,
                        "adaptive replay regressed p90: adaptive={adaptive:?} \
                         unconditional={unconditional:?}"
                    );
                    assert!(
                        adaptive_max <= unconditional_max + INTER_KEY_MS + 1e-9,
                        "adaptive discovery cost more than one key cadence: \
                         adaptive={adaptive:?} unconditional={unconditional:?}"
                    );
                }
            }
        }
    }

    /// Slow statistical companion to the fixed-seed acceptance test above.
    /// It stays ignored in the ordinary suite: each cell executes both policy
    /// arms for 64 sender-stable loss seeds and pools all 1,536 key samples.
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "64-seed paired transport profile"]
    async fn profile_adaptive_k1_replication_over_64_paired_loss_seeds() {
        const INTER_KEY_MS: f64 = 19.3;
        const SEEDS: u64 = 64;
        const KEYS_PER_SEED: usize = 24;

        for round_trip_ms in [50.0, 120.0, 200.0] {
            for loss_pct in [1, 5, 10] {
                for during_output in [false, true] {
                    let mut adaptive_bytes = 0usize;
                    let mut unconditional_bytes = 0usize;
                    let mut adaptive_latencies = Vec::with_capacity(SEEDS as usize * KEYS_PER_SEED);
                    let mut unconditional_latencies =
                        Vec::with_capacity(SEEDS as usize * KEYS_PER_SEED);

                    for loss_seed in 0..SEEDS {
                        let adaptive = measure_typing_profile_arm(
                            round_trip_ms,
                            loss_pct,
                            during_output,
                            false,
                            loss_seed,
                        )
                        .await;
                        let unconditional = measure_typing_profile_arm(
                            round_trip_ms,
                            loss_pct,
                            during_output,
                            true,
                            loss_seed,
                        )
                        .await;
                        adaptive_bytes += admitted_datagram_bytes(adaptive.counters);
                        unconditional_bytes += admitted_datagram_bytes(unconditional.counters);
                        adaptive_latencies.extend(adaptive.input_to_apply_ms);
                        unconditional_latencies.extend(unconditional.input_to_apply_ms);
                    }

                    adaptive_latencies.sort_by(f64::total_cmp);
                    unconditional_latencies.sort_by(f64::total_cmp);
                    let percentile_index = adaptive_latencies.len() * 95 / 100;
                    let adaptive_p95 = adaptive_latencies[percentile_index];
                    let unconditional_p95 = unconditional_latencies[percentile_index];
                    let adaptive_max = adaptive_latencies.last().copied().unwrap_or_default();
                    let unconditional_max =
                        unconditional_latencies.last().copied().unwrap_or_default();

                    println!(
                        "PAIRED_K1_64_SEEDS rtt_ms={round_trip_ms} loss_pct={loss_pct} \
                         during_output={during_output} bytes={adaptive_bytes}/{unconditional_bytes} \
                         p95_ms={adaptive_p95}/{unconditional_p95} \
                         max_ms={adaptive_max}/{unconditional_max}"
                    );
                    assert!(
                        adaptive_bytes < unconditional_bytes,
                        "adaptive replay saved no aggregate wire bytes"
                    );
                    assert!(
                        adaptive_p95 <= unconditional_p95 + INTER_KEY_MS + 1e-9,
                        "adaptive replay cost more than one key cadence at p95"
                    );
                }
            }
        }
    }

    /// When keys are closer together than the RTT, the daemon row is already
    /// ahead of an arriving frame. Comparing the viewer with that latest row
    /// delays every sample until the burst tail, producing a descending
    /// staircase. Exact apply-time milestones keep every lossless key at its
    /// own RTT instead.
    #[tokio::test(flavor = "current_thread")]
    async fn typing_latency_is_attributed_to_each_visible_apply_not_final_convergence() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        const KEYS: usize = 8;
        const INTER_KEY_MS: f64 = 19.3;
        const ROUND_TRIP_MS: f64 = 120.0;

        let downlink_ms = ROUND_TRIP_MS * 0.47;
        let uplink_ms = ROUND_TRIP_MS - downlink_ms;
        let mut sim = DisplaySim::new(COLS, ROWS);
        sim.set_downlink_delay_ms(downlink_ms);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        viewers.viewer(&peer).set_ack_delay_ms(uplink_ms);
        sim.warm_confirmation_estimator(ROUND_TRIP_MS);
        schedule_typing_visibility_probe(
            &mut sim,
            &mut viewers,
            &peer,
            (COLS, ROWS),
            KEYS,
            INTER_KEY_MS,
            uplink_ms,
        );

        for _ in 0..2_000 {
            let Some(_wake) = sim.step().await else {
                break;
            };
            viewers.pump(&sim);
            viewers.acknowledge(&mut sim);
            if viewers.viewer(&peer).typing_visibility_complete() {
                break;
            }
        }
        let latencies = viewers.viewer(&peer).take_typing_visibility_latencies();
        assert_eq!(latencies.len(), KEYS, "{latencies:?}");
        assert!(
            latencies
                .iter()
                .all(|latency| (*latency - ROUND_TRIP_MS).abs() < 1e-9),
            "lossless per-key applies should each cost exactly one RTT: {latencies:?}"
        );
        assert!(
            latencies[0] < ROUND_TRIP_MS + INTER_KEY_MS,
            "the first key was incorrectly held until final-row convergence: {latencies:?}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn link_profile_50_ms_exposes_display_waste_and_recovery() {
        assert_link_profile_matrix(50.0).await;
        assert_typing_profile_matrix(50.0).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn link_profile_120_ms_exposes_display_waste_and_recovery() {
        assert_link_profile_matrix(120.0).await;
        assert_typing_profile_matrix(120.0).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn link_profile_200_ms_exposes_display_waste_and_recovery() {
        assert_link_profile_matrix(200.0).await;
        assert_typing_profile_matrix(200.0).await;
    }

    /// Harness: acknowledgements release in order of their instants, each
    /// delivered at its own instant, with the flush timer interleaved where it
    /// falls; at a tie the acknowledgement goes first.
    #[tokio::test(flavor = "current_thread")]
    async fn acknowledgements_release_in_order_each_at_its_own_instant() {
        const PEERS: usize = 3;

        let mut sim = DisplaySim::with_peers(80, 24, PEERS);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        let delays = [30.0, 10.0, 20.0];
        for (index, delay_ms) in delays.iter().enumerate() {
            viewers
                .viewer(&sim_peer_id(index))
                .set_ack_delay_ms(*delay_ms);
        }

        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        let flushed_at_ms = sim.now_ms();
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);

        // Queued out of instant order, released in it — with the paced rows'
        // re-send deadline (the blind round-trip floor) landing on the second
        // acknowledgement's instant, where the tie rule puts the ACK first.
        let floor_ms = sim.peer_round_trip_floor_ms(&sim_peer_id(0));
        assert_eq!(
            floor_ms, 20.0,
            "the fixture's second viewer confirms at the floor"
        );
        let mut wakes = Vec::new();
        for _ in 0..4 {
            let wake = sim.step().await.expect("an event is due");
            wakes.push((wake, sim.now_ms() - flushed_at_ms));
        }
        assert_eq!(
            wakes,
            vec![
                (SimWake::Ack, 10.0),
                (SimWake::Ack, 20.0),
                (SimWake::Timer, floor_ms),
                (SimWake::Ack, 30.0),
            ]
        );
        for (index, delay_ms) in delays.iter().enumerate() {
            assert_eq!(
                sim.display_confirm_ewma_ms(&sim_peer_id(index)),
                *delay_ms,
                "viewer {index} was not delivered at its own instant"
            );
        }

        // A tie: an ACK due exactly when the timer is due goes first.
        let mut sim = DisplaySim::new(80, 24);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        let peer = sim_peer_id(0);
        viewers.viewer(&peer).set_ack_delay_ms(floor_ms);
        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);
        assert_eq!(
            sim.flush_due_in_ms(),
            Some(floor_ms),
            "the paced row's deadline is armed"
        );
        assert_eq!(
            sim.step().await,
            Some(SimWake::Ack),
            "at a tie the ACK is delivered first"
        );
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        assert_eq!(
            sim.step().await,
            None,
            "the timer found the row confirmed and parked"
        );
    }

    /// Harness: `advance_ms` delivers every acknowledgement it passes over at
    /// its own instant, not at the end of the advance.
    #[tokio::test(flavor = "current_thread")]
    async fn an_advance_delivers_acknowledgements_at_their_own_instants() {
        let mut sim = DisplaySim::with_peers(80, 24, 2);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        viewers.viewer(&sim_peer_id(0)).set_ack_delay_ms(20.0);
        viewers.viewer(&sim_peer_id(1)).set_ack_delay_ms(30.0);

        sim.write_pty(b"x");
        assert_eq!(sim.step().await, Some(SimWake::Timer));
        viewers.pump(&sim);
        viewers.acknowledge(&mut sim);

        sim.advance_ms(100.0);
        assert!(!sim.has_pending_acks());
        assert_eq!(sim.display_confirm_ewma_ms(&sim_peer_id(0)), 20.0);
        assert_eq!(sim.display_confirm_ewma_ms(&sim_peer_id(1)), 30.0);
    }

    /// Harness: a viewer that acknowledges inside the flush that earned it is
    /// no viewer, and the harness refuses to model one.
    #[tokio::test(flavor = "current_thread")]
    #[should_panic(expected = "takes time to come back")]
    async fn a_zero_acknowledgement_delay_is_refused() {
        let mut sim = DisplaySim::new(80, 24);
        let mut viewers = SimViewers::attach(&mut sim, 80, 24);
        viewers.viewer(&sim_peer_id(0)).set_ack_delay_ms(0.0);
    }

    /// The dictionary must be installed, acknowledged, and then actually used.
    ///
    /// Every dictionary figure in PERF.md depends on this path running, and it
    /// did not: the harness forged the acknowledgement without the viewer ever
    /// installing anything, so the daemon compressed against a dictionary no
    /// viewer held. This asserts the whole loop — the install reaches a real
    /// terminal, the terminal accepts it after verifying its hash, the
    /// acknowledgement names that id, and frames afterwards carry the
    /// dictionary flag and still decode to the daemon's grid.
    #[tokio::test(flavor = "current_thread")]
    async fn a_dictionary_is_installed_acknowledged_and_used() {
        const COLS: u16 = 200;
        const ROWS: u16 = 50;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        sim.enable_display_dictionary();
        let peer = sim_peer_id(0);
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);

        let mut acknowledged = 0usize;
        for round in 0..8u64 {
            sim.write_colored_screen(round);
            for _ in 0..16 {
                sim.step().await;
                viewers.pump(&sim);
                viewers.acknowledge(&mut sim);
                acknowledged += viewers.acknowledge_dictionaries(&mut sim);
            }
        }
        assert!(
            acknowledged > 0,
            "no dictionary was ever installed and acknowledged, so the dictionary \
             path never ran"
        );
        assert!(
            sim.active_dictionary_id(&peer).is_some(),
            "an acknowledged dictionary must remain active for compression"
        );

        let before = viewers.viewer(&peer).dictionary_seen;
        sim.write_colored_screen(42);
        let mut daemon = Vec::new();
        for _ in 0..64 {
            sim.step().await;
            viewers.pump(&sim);
            viewers.acknowledge(&mut sim);
            viewers.acknowledge_dictionaries(&mut sim);
            sim.terminal_row_hashes(&mut daemon);
            if viewers.diverged_rows(&peer, &daemon).is_empty() {
                break;
            }
        }

        let (compressed_seen, dictionary_seen) = {
            let viewer = viewers.viewer(&peer);
            (viewer.compressed_seen, viewer.dictionary_seen)
        };
        assert!(
            dictionary_seen > before,
            "the repaint carried no dictionary-compressed frame after {acknowledged} \
             acknowledged dictionaries (compressed={}, dictionary={}, datagrams={})",
            compressed_seen,
            dictionary_seen,
            sim.built_datagram_count(),
        );
        sim.terminal_row_hashes(&mut daemon);
        assert!(
            viewers.diverged_rows(&peer, &daemon).is_empty(),
            "the viewer did not converge on the daemon grid through the dictionary path"
        );
    }

    /// A coloured full-screen repaint must land as ONE paint.
    ///
    /// This is the user-reported symptom stated as an equality: large screen
    /// updates arrived "line by line or per blocks". At 240x60 a coloured
    /// screen encodes to roughly 41 KB of rows, which exceeded
    /// `FLUSH_ROW_BUDGET_BYTES` and was therefore cut across several flushes,
    /// each spaced by datagram pacing.
    #[tokio::test(flavor = "current_thread")]
    async fn a_coloured_repaint_lands_in_one_paint() {
        for (cols, rows) in [(200u16, 50u16), (240, 60)] {
            let (paints, datagrams) = coloured_repaint(cols, rows).await;
            assert_eq!(
                paints, 1,
                "a {cols}x{rows} coloured repaint took {paints} paints; the rows \
                 are being charged against the flush budget at a size the \
                 transport never carries"
            );
            assert!(datagrams > 1, "control failed: repaint fit one datagram");
        }
    }

    /// Repaint a full coloured screen; returns the steps to convergence and the
    /// datagrams selected by the production planner.
    async fn coloured_repaint(cols: u16, rows: u16) -> (usize, usize) {
        let mut sim = DisplaySim::new(cols, rows);
        let mut viewers = SimViewers::attach(&mut sim, cols, rows);
        let peer = sim_peer_id(0);
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);

        sim.write_colored_screen(1);
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;

        let before_datagrams = sim.built_datagram_count();
        sim.write_colored_screen(7);
        let (paints, _) = paints_to_convergence(&mut sim, &mut viewers, &peer, SETTLE_BUDGET_MS)
            .await
            .expect("the coloured repaint converges");
        (paints, sim.built_datagram_count() - before_datagrams)
    }

    /// Both scroll directions remain independent literal transformations.
    #[tokio::test(flavor = "current_thread")]
    async fn scrolls_use_independent_single_chunk_frames() {
        for (cols, rows, lines, reverse) in [
            (120, 37, 1, false),
            (120, 80, 1, false),
            (240, 60, 8, false),
            (120, 37, 1, true),
            (120, 80, 1, true),
        ] {
            let shape = scroll_shape(cols, rows, lines, reverse).await;
            assert!(shape.datagrams > 0);
            assert_eq!(shape.multi_chunk_seen, 0);
            assert_eq!(shape.apply_rejected, 0);
            assert!(shape.converged, "{cols}x{rows} reverse={reverse}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn promoted_header_keeps_scroll_datagrams_independent() {
        for (cols, rows) in [(120, 40), (240, 60)] {
            let shape = promotion_during_scroll(cols, rows).await;
            assert_eq!(shape.apply_rejected, 0);
            assert_eq!(shape.multi_chunk_seen, 0);
            assert!(shape.converged);
        }
    }

    async fn promotion_during_scroll(cols: u16, rows: u16) -> ScrollShape {
        const PALETTE: [u8; 6] = [31, 32, 33, 34, 35, 36];
        const WORDS: [&str; 9] = [
            "pub", "fn", "resolve", "entries", "Option", "self", "filter", "enabled", "buffer",
        ];
        let coloured = |seed: u64| -> Vec<u8> {
            let mut out = Vec::new();
            let mut state = seed | 1;
            let mut used = 0usize;
            while used + 8 < usize::from(cols) {
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
            out
        };

        let mut sim = DisplaySim::new(cols, rows);
        let mut viewers = SimViewers::attach(&mut sim, cols, rows);
        let peer = sim_peer_id(0);
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);

        // Distinct live content above a settled region exercises promotion
        // when only the header changes at the cursor.
        let region = rows / 2;
        let mut setup = Vec::new();
        for row in 0..rows {
            setup.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
            setup.extend_from_slice(&coloured(u64::from(row) * 2 + 11));
        }
        // DECSTBM homes the cursor, so set the region first and park after.
        setup.extend_from_slice(format!("\x1b[1;{region}r").as_bytes());
        setup.extend_from_slice(format!("\x1b[{};1H", region + 5).as_bytes());
        sim.write_pty(&setup);
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;

        {
            let viewer = viewers.viewer(&peer);
            viewer.multi_chunk_seen = 0;
            viewer.apply_rejected = 0;
        }
        let before_datagrams = sim.built_datagram_count();

        // Scroll the region, then move the cursor into an unchanged row.
        // Header promotion cannot create a cross-datagram dependency.
        let mut scroll = Vec::new();
        scroll.extend_from_slice(format!("\x1b[{region};1H\n").as_bytes());
        scroll.extend_from_slice(format!("\x1b[{};1H", region + 6).as_bytes());
        sim.write_pty(&scroll);

        let mut daemon = Vec::new();
        let mut converged = false;
        for _ in 0..256usize {
            sim.step().await;
            viewers.pump(&sim);
            viewers.acknowledge(&mut sim);
            sim.terminal_row_hashes(&mut daemon);
            if viewers.diverged_rows(&peer, &daemon).is_empty() {
                converged = true;
                break;
            }
        }
        let datagrams = sim.built_datagram_count() - before_datagrams;
        let viewer = viewers.viewer(&peer);
        ScrollShape {
            multi_chunk_seen: viewer.multi_chunk_seen,
            apply_rejected: viewer.apply_rejected,
            datagrams,
            converged,
        }
    }

    struct ScrollShape {
        multi_chunk_seen: usize,
        apply_rejected: usize,
        datagrams: usize,
        converged: bool,
    }

    /// Converge a coloured screen, then scroll it and report what the scroll
    /// alone cost under the production planner.
    async fn scroll_shape(cols: u16, rows: u16, lines: u16, reverse: bool) -> ScrollShape {
        let mut sim = DisplaySim::new(cols, rows);
        let mut viewers = SimViewers::attach(&mut sim, cols, rows);
        let peer = sim_peer_id(0);
        sim.advance_ms(FOLLOW_ALONG_AFTER_MS);

        sim.write_colored_screen(1);
        viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;

        // Everything before the scroll is setup, not evidence.
        {
            let viewer = viewers.viewer(&peer);
            viewer.multi_chunk_seen = 0;
            viewer.apply_rejected = 0;
        }
        let before_datagrams = sim.built_datagram_count();

        if reverse {
            sim.reverse_scroll_colored_lines(7, lines);
        } else {
            sim.scroll_colored_lines(7, lines);
        }
        let mut daemon = Vec::new();
        let mut converged = false;
        for _ in 0..256usize {
            sim.step().await;
            viewers.pump(&sim);
            viewers.acknowledge(&mut sim);
            sim.terminal_row_hashes(&mut daemon);
            if viewers.diverged_rows(&peer, &daemon).is_empty() {
                converged = true;
                break;
            }
        }
        let datagrams = sim.built_datagram_count() - before_datagrams;
        let viewer = viewers.viewer(&peer);
        ScrollShape {
            multi_chunk_seen: viewer.multi_chunk_seen,
            apply_rejected: viewer.apply_rejected,
            datagrams,
            converged,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "diagnostic"]
    async fn diag_parity_fraction() {
        for (cols, rows) in [(120u16, 40u16), (200, 50), (240, 60)] {
            let mut sim = DisplaySim::new(cols, rows);
            let mut viewers = SimViewers::attach(&mut sim, cols, rows);
            let peer = sim_peer_id(0);
            sim.write_colored_screen(1);
            for _ in 0..64 {
                sim.step().await;
                viewers.pump(&sim);
                viewers.acknowledge(&mut sim);
            }
            let before_counters = viewers.viewer(&peer).transport_counters;
            {
                let v = viewers.viewer(&peer);
                v.patch_wire_bytes = 0;
                v.replica_wire_bytes = 0;
                v.repair_wire_bytes = 0;
                v.rows_applied = 0;
            }
            sim.write_colored_screen(7);
            let mut daemon = Vec::new();
            for flush in 1..=64usize {
                let before_rows = viewers.viewer(&peer).rows_applied;
                sim.step().await;
                viewers.pump(&sim);
                viewers.acknowledge(&mut sim);
                let sent = viewers.viewer(&peer).rows_applied - before_rows;
                if sent > 0 {
                    println!("  DIAGFLUSH {cols}x{rows} flush={flush} rows={sent}");
                }
                sim.terminal_row_hashes(&mut daemon);
                if viewers.diverged_rows(&peer, &daemon).is_empty() {
                    break;
                }
            }
            let v = viewers.viewer(&peer);
            let counters = counter_delta(v.transport_counters, before_counters);
            let data =
                counters.admitted_datagram_data.bytes + counters.admitted_reliable_data.bytes;
            let replica = counters.admitted_datagram_replica.bytes;
            let datagram_repair = counters.admitted_datagram_repair.bytes;
            let reliable_repair = counters.admitted_reliable_repair.bytes;
            let protection = replica + datagram_repair + reliable_repair;
            let total = data + protection;
            println!(
                "DIAG {cols}x{rows}: physical_total={total}B data={data}B replica={replica}B datagram_repair={datagram_repair}B reliable_repair={reliable_repair}B protection_share={:.0}% protection/data={:.2} rows_sent={} screen_rows={rows} redundancy={:.2}x",
                (protection as f64 / total.max(1) as f64) * 100.0,
                protection as f64 / data.max(1) as f64,
                v.rows_applied,
                v.rows_applied as f64 / f64::from(rows)
            );
        }
    }

    /// A row lost on the wire still arrives when nothing further changes.
    ///
    /// This is the test that makes the acknowledged point's *contiguity* matter.
    /// The daemon marks every row at or below the ACK exact, and an exact row
    /// whose content has not changed is skipped forever. So an ACK that names a
    /// seq the viewer never actually applied strands those rows permanently.
    ///
    /// Every other loss test here rewrites the screen each round, which changes
    /// every row's hash and re-sends it regardless — masking the bug completely.
    /// This one writes once, drops frames, and then goes quiet: the only way to
    /// converge is for the daemon to still consider the lost rows outstanding.
    #[tokio::test(flavor = "current_thread")]
    async fn a_row_lost_on_the_wire_arrives_without_new_content() {
        const COLS: u16 = 200;
        const ROWS: u16 = 50;

        for seed in [0xA5A5_1234_u64, 0x1357_9BDF, 0x2468_ACE0] {
            let mut sim = DisplaySim::new(COLS, ROWS);
            sim.set_loss(50, seed);
            let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
            let peer = sim_peer_id(0);

            // One screen, then silence. No further writes may rescue a
            // wrongly-confirmed row.
            sim.write_colored_screen(3);

            let mut daemon = Vec::new();
            let mut converged = None;
            for flush in 1..=512usize {
                sim.step().await;
                sim.tick_heartbeat().await;
                viewers.pump(&sim);
                viewers.acknowledge(&mut sim);
                viewers.answer_digests(&mut sim);
                sim.terminal_row_hashes(&mut daemon);
                if viewers.diverged_rows(&peer, &daemon).is_empty() {
                    converged = Some(flush);
                    break;
                }
            }

            // Control: the loss model must actually have dropped something, or
            // this is a loss-free session wearing a loss test's name.
            assert!(
                sim.dropped_count() > 0,
                "seed {seed:#x} dropped nothing at 30% loss"
            );
            assert!(
                converged.is_some(),
                "seed {seed:#x}: {} rows never arrived after {} drops, with no \
                 further writes to rescue them — the daemon believes rows the \
                 viewer never received are confirmed",
                viewers.diverged_rows(&peer, &daemon).len(),
                sim.dropped_count()
            );
        }
    }

    /// A quiet, fully acknowledged session still has a hash digest due, and the
    /// digest does not depend on a flush to carry it.
    ///
    /// `send_heartbeat_if_due` used to have exactly one call site: the tail of
    /// the per-peer loop inside `flush_display`. Once a screen is quiet and every
    /// row is exactly acknowledged, `peer_has_runnable_display_work` goes false
    /// and `compute_next_flush_delay_ms` returns `None` — the closing assertions
    /// of `an_unacked_row_stays_schedulable_and_becomes_runnable_at_its_deadline`
    /// pin that end state directly — so the owner loop parks its flush timer and
    /// `flush_display` is never called again. The digest that `display/recv.rs`
    /// calls "the ONLY loss signal that needs handling" was therefore unreachable
    /// in exactly the state it exists to protect.
    ///
    /// Inspection settled the call graph. What it could not settle is whether
    /// anything was actually lost there, and that is what this test establishes:
    /// the digest is genuinely DUE in the parked state, with rows settled past
    /// `DIGEST_ROW_SETTLE_MS`. What production lost was a function, not a no-op —
    /// which is what justified giving the tick a call to it.
    ///
    /// The parked state is run for real: `run_for_ms` drives the owner loop
    /// until its timer and the acknowledgement queue are both empty and reports
    /// where that happened, so the assertion below is about the digest arriving
    /// with no flush available to carry it in exactly that state.
    /// `session::liveness`'s own test covers the production tick call; this one
    /// covers the property that call has to deliver.
    #[tokio::test(flavor = "current_thread")]
    async fn a_quiet_acknowledged_session_still_has_a_digest_due() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        let heartbeat_ms = crate::display::policy::DisplayPolicy::HEARTBEAT_TIME_INTERVAL_MS;
        let settle_ms = crate::display::policy::DisplayPolicy::DIGEST_ROW_SETTLE_MS;

        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);

        sim.write_colored_screen(7);

        // Settle completely: content agreed AND every row confirmed AND no
        // acknowledgement in flight. The confirmation is what makes this the
        // parked state rather than a merely quiet one — an unconfirmed row
        // keeps a re-send deadline in `compute_next_flush_delay_ms` and the
        // owner loop would wake for it on its own.
        let settled_ms = viewers.settle(&mut sim, &peer, SETTLE_BUDGET_MS).await;
        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);

        // Controls: a uniform grid would make every row hash agree by
        // construction, and a session that applied nothing proves nothing about
        // a backstop over it.
        assert!(
            SimViewers::distinct(&daemon) > 1,
            "a uniform grid makes the digest trivial"
        );
        assert!(viewers.totals().0 > 0, "the session applied no frames");
        assert_eq!(viewers.totals().3, 0, "the viewer rejected a frame");

        // Baseline after settling: whatever the flush-site call emitted while the
        // screen was still changing is not what this test is about.
        let baseline = viewers.digests_seen();

        // The parked state, reached and held: the owner loop has nothing left
        // to wake it, so no flush runs and the flush-site call cannot be
        // reached.
        let quiet_ms = 4.0 * heartbeat_ms;
        let run = viewers.run_for_ms(&mut sim, quiet_ms, 4).await;
        assert!(
            run.parked_at_ms.is_some(),
            "the owner loop never parked on a settled screen: {run:?}"
        );
        assert_eq!(run.flushes, 0, "a flush ran on a settled screen: {run:?}");
        assert_eq!(
            viewers.digests_seen(),
            baseline,
            "a digest reached the viewer with no flush to carry it"
        );

        // ...and yet it was due for most of that time. This call has no
        // production counterpart, which is precisely the finding.
        sim.tick_heartbeat().await;
        viewers.pump(&sim);
        assert!(
            viewers.digests_seen() > baseline,
            "no digest was due after {quiet_ms:.0} ms of quiet with every row \
             settled past DIGEST_ROW_SETTLE_MS ({settle_ms:.0} ms) — if nothing \
             is ever due here then the parked state costs nothing and this \
             finding is a no-op (settled in {settled_ms:.0} ms)"
        );
    }

    /// Allocations the in-memory carrier makes for one admitted datagram: it
    /// clones the peer id and the wire bytes (`DirectSession::new_capture`).
    /// This is the harness's stand-in for wtransport's own
    /// internal copy of every datagram it sends, which production pays and
    /// `PERF.md` records as the one allocation the send path cannot remove.
    const CARRIER_COPY_ALLOCATIONS: usize = 2;

    /// One measured round of the two allocation oracles below: the hash pass
    /// and the peer flush are bracketed separately, then the harness drains,
    /// delivers and acknowledges outside both windows.
    struct FlushRoundTally {
        captured_rows: usize,
        hash: crate::edge_tunnel::test_allocations::Tally,
        flush: crate::edge_tunnel::test_allocations::Tally,
        admitted: usize,
    }

    fn measure_flush_round(
        runtime: &tokio::runtime::Runtime,
        sim: &mut DisplaySim,
        viewers: &mut SimViewers,
        peer: &str,
    ) -> FlushRoundTally {
        use crate::edge_tunnel::test_allocations;
        let has_display_damage = sim.has_dirty();
        assert!(has_display_damage, "every round writes the terminal");

        test_allocations::begin();
        let captured_rows = sim.hash_dirty_rows();
        let hash = test_allocations::end();

        test_allocations::begin();
        runtime.block_on(sim.flush_peer_delta(peer, has_display_damage));
        let flush = test_allocations::end();

        let admitted = sim.drain_wire();
        viewers.pump(sim);
        viewers.acknowledge(sim);
        FlushRoundTally {
            captured_rows,
            hash,
            flush,
            admitted,
        }
    }

    /// Exact allocation oracle for the owner loop's keystroke echo: one dirty
    /// row, flushed inline, sealed, sent, parity behind it, acknowledged by
    /// the viewer, 200 times after warm-up.
    ///
    /// Two windows, because the flush has exactly two allocation sources left
    /// and they belong to different decisions. The hash pass captures each
    /// dirty row into a fresh `Arc<[CellRepr]>` — pooling that was measured and
    /// rejected (`PERF.md`, the `CellRepr` layout entry) — so its window must
    /// count exactly one allocation per captured row. The peer flush — capture,
    /// encode, batch, seal, send, parity, ACK bookkeeping — must allocate only
    /// what the carrier copies: `CARRIER_COPY_ALLOCATIONS` per admitted
    /// datagram, and nothing for the frame, its row list, the parity frame or
    /// the burst itself, all of which are pooled or inline.
    ///
    /// Ignored because the counting allocator is process-wide: run it alone,
    /// in release, with `--exact --nocapture`.
    #[test]
    #[ignore = "exact allocation oracle; the counting allocator is process-wide"]
    fn keystroke_flush_allocates_only_the_carrier_copy() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        // Past two tokio mpsc blocks of the prepare completion channel, so its
        // block list has reached its steady state — the push of message 32
        // allocates a second block before the receiver has reclaimed the
        // first, after which the two alternate — and every pooled buffer has
        // grown to its high-water size before anything is counted.
        const WARM_UP: usize = 64;
        const ROUNDS: usize = 200;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");
        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        let mut flush_allocations = 0usize;
        let mut flush_bytes = 0usize;
        let mut admitted_total = 0usize;

        for round in 0..WARM_UP + ROUNDS {
            // Far enough apart that the passive-viewer rate interval never
            // defers the flush, so every round is one echo and nothing else.
            sim.advance_ms(100.0);
            // One keystroke echo: the shell rewrites the cursor row with the
            // new glyph. `\r` keeps the cursor on one row so the line never
            // wraps, and the glyph changes every round so the row's hash moves.
            sim.write_pty(&[b'\r', b'a' + (round % 26) as u8]);
            let tally = measure_flush_round(&runtime, &mut sim, &mut viewers, &peer);
            if round < WARM_UP {
                continue;
            }
            assert_eq!(
                tally.captured_rows, 1,
                "a keystroke echo dirties exactly the cursor row"
            );
            assert_eq!(
                tally.hash.allocations, tally.captured_rows,
                "the hash pass allocates exactly one row capture per dirty row"
            );
            assert_eq!(
                tally.admitted, 2,
                "one delta datagram and the parity shard behind it"
            );
            assert_eq!(
                tally.flush.allocations,
                tally.admitted * CARRIER_COPY_ALLOCATIONS,
                "the keystroke flush must allocate only the carrier's copy of each \
                 admitted datagram (round {round})"
            );
            flush_allocations += tally.flush.allocations;
            flush_bytes += tally.flush.allocated_bytes;
            admitted_total += tally.admitted;
        }

        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);
        assert!(
            viewers.diverged_rows(&peer, &daemon).is_empty(),
            "the viewer must agree with the daemon after every echo"
        );
        println!(
            "keystroke flush: {:.3} allocations/flush, {:.1} bytes/flush, {} datagrams/flush, \
             all of it the carrier copy ({} allocations per admitted datagram)",
            flush_allocations as f64 / ROUNDS as f64,
            flush_bytes as f64 / ROUNDS as f64,
            admitted_total / ROUNDS,
            CARRIER_COPY_ALLOCATIONS,
        );
    }

    /// Exact allocation oracle for the offloaded arm: a four-row flush rides the
    /// interactive lane to `merkur-display-prepare`, comes back as a
    /// completion, and bursts from the owner loop, 200 times after warm-up.
    ///
    /// The prepare thread's allocations count too — the allocator is
    /// process-wide — so a frame, a row list, a compressed output or a repair
    /// built fresh on that thread shows up here. After warm-up the flush must
    /// allocate only the carrier's copy of each admitted datagram, and every
    /// frame buffer the thread took must be back in the pool once the burst is
    /// on the wire, round after round.
    ///
    /// Ignored because the counting allocator is process-wide: run it alone,
    /// in release, with `--exact --nocapture`.
    #[test]
    #[ignore = "exact allocation oracle; the counting allocator is process-wide"]
    fn offloaded_flush_recycles_its_prepare_shell() {
        const COLS: u16 = 80;
        const ROWS: u16 = 24;
        // Past two tokio mpsc blocks of the prepare completion channel, so its
        // block list has reached its steady state — the push of message 32
        // allocates a second block before the receiver has reclaimed the
        // first, after which the two alternate — and every pooled buffer has
        // grown to its high-water size before anything is counted.
        const WARM_UP: usize = 64;
        const ROUNDS: usize = 200;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime");
        let mut sim = DisplaySim::new(COLS, ROWS);
        let mut viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        let mut flush_allocations = 0usize;
        let mut flush_bytes = 0usize;
        let mut admitted_total = 0usize;
        let mut parked_frames = None;

        for round in 0..WARM_UP + ROUNDS {
            sim.advance_ms(100.0);
            // Four rows rewritten from the home position with a new glyph each
            // round: enough rows to leave the owner loop, few enough for the
            // interactive lane.
            let glyph = b'a' + (round % 26) as u8;
            sim.write_pty(&[
                0x1b, b'[', b'H', glyph, b'\r', b'\n', glyph, b'\r', b'\n', glyph, b'\r', b'\n',
                glyph, b'\r', b'\n',
            ]);
            let tally = measure_flush_round(&runtime, &mut sim, &mut viewers, &peer);
            assert!(
                sim.built_datagram_count() > 0,
                "a four-row flush must be prepared off the owner loop"
            );
            if round < WARM_UP {
                continue;
            }
            // Every frame the thread took is parked again once the burst is
            // sealed: the pool neither grows (a frame allocated fresh) nor
            // shrinks (a frame dropped) from one round to the next.
            let parked = sim.parked_frame_buffers();
            assert!(
                parked >= tally.admitted,
                "the burst's frames must be back in the pool"
            );
            match parked_frames {
                None => parked_frames = Some(parked),
                Some(expected) => assert_eq!(
                    parked, expected,
                    "every frame the prepare thread took must return (round {round})"
                ),
            }
            assert_eq!(
                tally.captured_rows, 5,
                "four rewritten rows, plus the cursor's row, which the terminal damages \
                 whenever the cursor moves off it"
            );
            assert_eq!(
                tally.hash.allocations, tally.captured_rows,
                "the hash pass allocates exactly one row capture per dirty row"
            );
            assert!(tally.admitted >= 2, "at least one datagram and its parity");
            assert_eq!(
                tally.flush.allocations,
                tally.admitted * CARRIER_COPY_ALLOCATIONS,
                "the offloaded flush must allocate only the carrier's copy of each \
                 admitted datagram (round {round})"
            );
            flush_allocations += tally.flush.allocations;
            flush_bytes += tally.flush.allocated_bytes;
            admitted_total += tally.admitted;
        }

        let mut daemon = Vec::new();
        sim.terminal_row_hashes(&mut daemon);
        assert!(
            viewers.diverged_rows(&peer, &daemon).is_empty(),
            "the viewer must agree with the daemon after every flush"
        );
        println!(
            "offloaded flush: {:.3} allocations/flush, {:.1} bytes/flush, {} datagrams/flush, \
             all of it the carrier copy ({} allocations per admitted datagram)",
            flush_allocations as f64 / ROUNDS as f64,
            flush_bytes as f64 / ROUNDS as f64,
            admitted_total / ROUNDS,
            CARRIER_COPY_ALLOCATIONS,
        );
    }
}

#[cfg(test)]
#[path = "viewer/closure_tests.rs"]
mod closure_tests;

#[path = "viewer/presentation.rs"]
pub(crate) mod presentation;
