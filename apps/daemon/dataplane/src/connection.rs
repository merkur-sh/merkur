#[cfg(test)]
use std::collections::HashMap;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use merkur_codec::{CellRepr, GraphicsVersion};
use zeroize::Zeroize;

use crate::display::fec::FecEncoder;
use crate::display::policy::{
    DISPLAY_ACK_MASK_WINDOW, DISPLAY_ACK_MASK_WORDS, DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH,
};
use crate::display::policy::{
    DisplayPolicy, TRANSPORT_POLICY_CHUNK_TARGET_MAX_BYTES,
    TRANSPORT_POLICY_CHUNK_TARGET_MIN_BYTES, TRANSPORT_POLICY_SNAPSHOT_TARGET_DEFAULT_BYTES,
};
use crate::network::protocol::DataHandshakeGeneration;

const RTT_BASELINE_MS: f64 = 20.0;
const DEFAULT_CHUNK_TARGET_BYTES: usize = 16 * 1024;
/// Maximum number of independently admitted display sequences an incremental
/// resume repair may name. A repair is selected only when at most half of the
/// bounded 256-row grid diverged, so one sequence per repaired row is the
/// absolute worst case. Keeping this explicit makes the reliable completion
/// marker and its browser-side membership set bounded by construction.
pub(crate) const MAX_RESUME_REPAIR_MEMBERS: usize = merkur_codec::MAX_TERMINAL_ROWS / 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResumeRepairMember {
    pub row: u16,
    /// First successfully admitted display sequence for this repair row. A
    /// later sequence is also sufficient because row ordering is RFC1982 and a
    /// retry of current content supersedes the lost original.
    pub minimum_seq: u32,
}

/// EWMA of the delay between putting a display datagram on the wire and the
/// client's ACK for that exact datagram coming back, plus its mean absolute
/// deviation.
///
/// This is the quantity the row re-send deadline is predicting, and it is
/// deliberately NOT any of the RTTs on `PathHealth`. `network_rtt_ewma_ms` is a
/// heartbeat round trip, which excludes the browser's decode, apply and ACK
/// cadence; `rtt_ewma_ms` folds heartbeat PONGs in alongside display ACKs, so it
/// is pulled toward the network number by traffic that has nothing to do with
/// confirmation. Both under-report how long a row actually takes to be
/// confirmed, and a re-send deadline sized from either fires before the ACK can
/// physically arrive — every row then goes out several times, and the duplicates
/// spend the flush budget that new rows needed.
///
/// Feeding the measurement back into the deadline is self-correcting, not
/// self-reinforcing: a slower client lengthens the deadline, which removes
/// duplicates, which frees the link. That is the opposite of the datagram rate
/// limiter, where the same feedback compounds — see `network_rtt_ewma_ms`.
#[derive(Debug, Clone, Copy)]
pub struct DisplayConfirmDelay {
    pub ewma_ms: f64,
    pub jitter_ewma_ms: f64,
    samples: u64,
}

impl DisplayConfirmDelay {
    pub fn new() -> Self {
        Self {
            // Zero until the first sample lands: this estimate carries no
            // information before then, and `row_resend_interval_ms` takes the
            // larger of it and the path's measured round trip, so the round
            // trip alone paces the blind first round. A constant here was a
            // second guess at the same quantity and, at 20 ms, sat below one
            // round trip on every path but a LAN.
            ewma_ms: 0.0,
            jitter_ewma_ms: 0.0,
            samples: 0,
        }
    }

    /// Fold one confirmation sample in. The first sample REPLACES the blind
    /// baseline rather than blending with it, for the reason `seed_rtt` gives:
    /// a real measurement beats a constant immediately, and blending would make
    /// a fast peer look like a 20 ms one for its first several frames.
    pub fn record(&mut self, sample_ms: f64) {
        if !sample_ms.is_finite() || sample_ms <= 0.0 {
            return;
        }
        if self.samples == 0 {
            self.ewma_ms = sample_ms;
            self.jitter_ewma_ms = 0.0;
        } else {
            let deviation_ms = (sample_ms - self.ewma_ms).abs();
            self.ewma_ms = self.ewma_ms * 0.85 + sample_ms * 0.15;
            self.jitter_ewma_ms = self.jitter_ewma_ms * 0.8 + deviation_ms * 0.2;
        }
        self.samples = self.samples.saturating_add(1);
    }

    #[cfg(test)]
    pub(crate) fn sample_count(&self) -> u64 {
        self.samples
    }
}

impl Default for DisplayConfirmDelay {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerTransport {
    /// Direct browser-to-daemon WebTransport connection.
    WebTransport,
    /// Browser-facing WebTransport connection relayed through the anycast edge.
    ///
    /// This is deliberately distinct from `WebTransport`: the two carriers have
    /// independent queues, RTTs, failure lifecycles, and connection ownership.
    Edge,
}

/// Per-path liveness + RTT/jitter state. A peer holds one of these per browser
/// carrier (direct WebTransport and edge WebTransport). The display-layer path selector
/// `DisplayPolicy::pick_path` reads these to choose the lower-RTT path
/// for each flush and to fall through on send failure.
#[derive(Debug, Clone, Copy)]
pub struct PathHealth {
    /// True iff a recv-loop is bound to this path AND we haven't observed
    /// a clean close, send-failure burst, or heartbeat timeout.
    pub available: bool,
    pub rtt_ewma_ms: f64,
    /// RTT EWMA fed ONLY by heartbeat PONGs (pure network round-trip). Unlike
    /// `rtt_ewma_ms` (which also folds in display-ACK round-trips), this is not
    /// inflated by the browser's frame apply/render latency, so it reflects the
    /// path's true capacity. The datagram rate-limiter reads THIS to size its
    /// interval; using the ACK-inflated `rtt_ewma_ms` there created a
    /// self-reinforcing throttle (slow apply -> high ACK RTT -> aggressive rate
    /// cap -> dribbled display -> slower apply). See send.rs rate-limit sites.
    pub network_rtt_ewma_ms: f64,
    /// Mean absolute deviation of heartbeat RTT from its own network-only EWMA.
    /// Display confirmations never update it: their independently routed return
    /// and ACK cadence cannot describe forward-carrier uncertainty.
    pub network_jitter_ewma_ms: f64,
    pub jitter_ewma_ms: f64,
    /// Wallclock-ms (since `start_instant`) of the most recent ACK,
    /// PONG, or any other inbound message attributed to this path.
    /// Drives heartbeat-timeout liveness.
    pub last_ack_at_ms: f64,
    /// When the next per-path heartbeat ping should fire.
    pub last_heartbeat_sent_ms: f64,
    /// One owner-consumed exact-carrier probe request. Control-plane topology
    /// changes may request a measurement, but they must not manufacture an ACK
    /// or mark an unavailable data carrier healthy before E2E traffic returns.
    pub heartbeat_probe_requested: bool,
    /// Consecutive failed `try_send` attempts on this path. Resets on success.
    /// Triggers automatic Redundant dual-send when > 0 (we don't trust the
    /// primary while it's actively dropping our sends).
    pub consecutive_send_failures: u32,
    /// When the oldest currently-unanswered ack-eliciting send left, or 0.0
    /// when nothing is outstanding.
    ///
    /// The suspect point is otherwise dominated by `PATH_HEARTBEAT_INTERVAL_MS`:
    /// the daemon waits for its own 5 s clock to come round before it will even
    /// begin to doubt a path, however much traffic it has put on the wire in the
    /// meantime. This is the same wait-for-a-clock defect the browser's ladder
    /// had, and it takes the same fix — a path that is being TALKED to and is
    /// not answering is suspect on the traffic's schedule, not the timer's.
    ///
    /// Stamped only when nothing was already outstanding, so it names the
    /// OLDEST unanswered send rather than the newest, and cleared by
    /// `record_authenticated_activity` — the same event that already means
    /// "this carrier is carrying our frames".
    pub oldest_unanswered_send_ms: f64,
    /// The newest `input_run` liveness probe this carrier answered in the
    /// current Noise session. A token rides the emit's datagram and its
    /// reliable copy; the first arrival that answers it retires both.
    pub answered_input_probe: Option<u64>,
}

impl PathHealth {
    pub fn fresh_available(now_ms: f64) -> Self {
        Self {
            available: true,
            rtt_ewma_ms: RTT_BASELINE_MS,
            network_rtt_ewma_ms: RTT_BASELINE_MS,
            network_jitter_ewma_ms: 0.0,
            jitter_ewma_ms: 0.0,
            last_ack_at_ms: now_ms,
            last_heartbeat_sent_ms: 0.0,
            heartbeat_probe_requested: false,
            consecutive_send_failures: 0,
            oldest_unanswered_send_ms: 0.0,
            answered_input_probe: None,
        }
    }

    pub fn dormant() -> Self {
        Self {
            available: false,
            rtt_ewma_ms: RTT_BASELINE_MS,
            network_rtt_ewma_ms: RTT_BASELINE_MS,
            network_jitter_ewma_ms: 0.0,
            jitter_ewma_ms: 0.0,
            last_ack_at_ms: 0.0,
            last_heartbeat_sent_ms: 0.0,
            heartbeat_probe_requested: false,
            consecutive_send_failures: 0,
            oldest_unanswered_send_ms: 0.0,
            answered_input_probe: None,
        }
    }

    /// Fold one RTT sample into the path's RTT and jitter EWMAs. Callers
    /// must only feed samples that are genuinely attributable to this path
    /// (a datagram that was sent on it, or a PONG for a PING that rode it).
    pub fn record_rtt_sample(&mut self, rtt_sample_ms: f64) {
        let jitter_sample_ms = (rtt_sample_ms - self.rtt_ewma_ms).abs();
        self.rtt_ewma_ms = self.rtt_ewma_ms * 0.85 + rtt_sample_ms * 0.15;
        self.jitter_ewma_ms = self.jitter_ewma_ms * 0.8 + jitter_sample_ms * 0.2;
    }

    /// Replace the blind `RTT_BASELINE_MS` seed with a real measurement.
    ///
    /// A path created by `fresh_available` starts at a hardcoded baseline and is
    /// then blended at 0.15 by heartbeat probes alone, so a genuinely fast new
    /// carrier spends several heartbeat intervals looking like a 20 ms one and
    /// loses selection to a warm incumbent it should beat. Seeding replaces
    /// rather than blends, which is what the browser mux already does with its
    /// first sample. `rtt_ewma_ms` is seeded too: it will drift upward as
    /// display ACKs fold in their apply time, and starting it from a measured
    /// round trip is strictly better than starting it from a constant.
    pub fn seed_rtt(&mut self, rtt_sample_ms: f64) {
        if !rtt_sample_ms.is_finite() || rtt_sample_ms <= 0.0 {
            return;
        }
        self.rtt_ewma_ms = rtt_sample_ms;
        self.network_rtt_ewma_ms = rtt_sample_ms;
        self.network_jitter_ewma_ms = 0.0;
    }

    /// Fold one PURE-NETWORK RTT sample (a heartbeat PONG) into
    /// the network RTT and its own jitter. Only heartbeat round-trips may call this —
    /// display-ACK round-trips must not, or the rate-limiter feedback loop
    /// documented on `network_rtt_ewma_ms` returns.
    pub fn record_network_rtt_sample(&mut self, rtt_sample_ms: f64) {
        if !rtt_sample_ms.is_finite() || rtt_sample_ms <= 0.0 {
            return;
        }
        let jitter_sample_ms = (rtt_sample_ms - self.network_rtt_ewma_ms).abs();
        self.network_rtt_ewma_ms = self.network_rtt_ewma_ms * 0.85 + rtt_sample_ms * 0.15;
        self.network_jitter_ewma_ms = self.network_jitter_ewma_ms * 0.8 + jitter_sample_ms * 0.2;
    }

    /// Record a completed ROUND TRIP on this path: a heartbeat PONG, or a
    /// display ACK naming a sequence this daemon actually sent.
    ///
    /// Only those two may call this. Inbound traffic in general proves the
    /// downlink and says nothing about whether our own frames still arrive,
    /// which is the question `last_ack_at_ms` exists to answer — see
    /// [`Self::record_inbound_activity`].
    pub fn record_authenticated_activity(&mut self, now_ms: f64) {
        self.last_ack_at_ms = now_ms;
        self.available = true;
        self.heartbeat_probe_requested = false;
        self.consecutive_send_failures = 0;
        // Something we sent came back, so nothing outstanding is unanswered.
        self.oldest_unanswered_send_ms = 0.0;
    }

    /// Record inbound authenticated traffic on this path.
    ///
    /// Proof the DOWNLINK carries bytes, and nothing more. It revives
    /// availability and clears the send-failure count, because the path
    /// demonstrably delivered — but it deliberately does NOT touch
    /// `last_ack_at_ms` or `oldest_unanswered_send_ms`, which answer a different
    /// question: whether the frames WE send still arrive.
    ///
    /// Crediting inbound bytes there is exactly what made a dead uplink under a
    /// live downlink undetectable on the browser, fixed 2026-08-30 and stated in
    /// `docs/transport.md` as "only a completed round trip may clear that
    /// deadline". The daemon held the mirror image of that bug, and a worse
    /// version: clearing `oldest_unanswered_send_ms` also discarded the
    /// early-suspicion signal a typing user supplies, so the daemon fell back to
    /// its pure quiet clock exactly when it had the most evidence available.
    ///
    /// `heartbeat_probe_requested` is deliberately left alone: a probe was asked
    /// for because this path looked suspect, and an inbound frame does not
    /// answer it.
    pub fn record_inbound_activity(&mut self) {
        self.available = true;
        self.consecutive_send_failures = 0;
    }

    /// Note that an ack-eliciting frame just went out on this path.
    ///
    /// Idempotent while a send is already outstanding: the suspect point is
    /// measured from the OLDEST unanswered send, so a burst must not keep
    /// pushing the deadline forward. Cheap enough for the send path — one
    /// compare and, at most, one store.
    #[inline]
    pub fn note_unanswered_send(&mut self, now_ms: f64) {
        if self.oldest_unanswered_send_ms == 0.0 {
            self.oldest_unanswered_send_ms = now_ms;
        }
    }

    /// Live iff currently marked available AND we've heard from the path
    /// within the heartbeat-staleness threshold (or never armed it, i.e.
    /// freshly added; first heartbeat will set `last_ack_at_ms`).
    pub fn is_live(&self, now_ms: f64, stale_threshold_ms: f64) -> bool {
        if !self.available {
            return false;
        }
        // Path that has never logged an ack is treated as live for its
        // first heartbeat round-trip; otherwise enforce the staleness gate.
        if self.last_ack_at_ms == 0.0 {
            return true;
        }
        (now_ms - self.last_ack_at_ms) <= stale_threshold_ms
    }
}

/// Per-peer path set. Edge and direct WebTransport are separate carriers: a
/// healthy edge tunnel must never make a missing direct route look healthy (or
/// vice versa).
///
/// Add new transports by
/// extending this struct + the `PeerTransport` enum + the path-selection
/// match arms — no other code needs to change.
#[derive(Debug, Clone, Copy)]
pub struct PeerPaths {
    pub webtransport: PathHealth,
    pub edge: PathHealth,
}

impl PeerPaths {
    /// A new Noise session restarts the browser's probe tokens.
    pub fn forget_input_probes(&mut self) {
        for via in Self::ORDERED {
            self.get_mut(via).answered_input_probe = None;
        }
    }

    pub fn new(initial: PeerTransport, now_ms: f64) -> Self {
        let mut paths = PeerPaths {
            webtransport: PathHealth::dormant(),
            edge: PathHealth::dormant(),
        };
        *paths.get_mut(initial) = PathHealth::fresh_available(now_ms);
        paths
    }

    const ORDERED: [PeerTransport; 2] = [PeerTransport::WebTransport, PeerTransport::Edge];

    /// Rank live carriers by `network_rtt_ewma_ms`, never by `rtt_ewma_ms`.
    ///
    /// Ranking is a comparison BETWEEN paths, so both sides must measure the
    /// same quantity. `rtt_ewma_ms` folds in display-ACK round trips, and those
    /// land only on the carrier currently doing single-path display — so the
    /// incumbent is charged the browser's frame-apply time while the challenger
    /// is measured by heartbeat alone. Worse, the browser returns display ACKs
    /// on its own mux primary rather than on the carrier the datagram arrived
    /// on, so `rtt_ewma_ms` is not attributable to one path at all. Heartbeat
    /// PONGs echo on the carrier that carried the PING, which makes
    /// `network_rtt_ewma_ms` the only apples-to-apples number available here.
    fn best_two_live(
        &self,
        now_ms: f64,
        stale_threshold_ms: f64,
    ) -> (Option<PeerTransport>, Option<PeerTransport>) {
        let mut primary: Option<PeerTransport> = None;
        let mut secondary: Option<PeerTransport> = None;
        for transport in Self::ORDERED {
            if !self.get(transport).is_live(now_ms, stale_threshold_ms) {
                continue;
            }
            if primary.is_none_or(|current| {
                self.get(transport).network_rtt_ewma_ms < self.get(current).network_rtt_ewma_ms
            }) {
                secondary = primary;
                primary = Some(transport);
            } else if secondary.is_none_or(|current| {
                self.get(transport).network_rtt_ewma_ms < self.get(current).network_rtt_ewma_ms
            }) {
                secondary = Some(transport);
            }
        }
        (primary, secondary)
    }

    #[inline]
    pub fn get(&self, transport: PeerTransport) -> &PathHealth {
        match transport {
            PeerTransport::WebTransport => &self.webtransport,
            PeerTransport::Edge => &self.edge,
        }
    }

    #[inline]
    pub fn get_mut(&mut self, transport: PeerTransport) -> &mut PathHealth {
        match transport {
            PeerTransport::WebTransport => &mut self.webtransport,
            PeerTransport::Edge => &mut self.edge,
        }
    }

    /// Reports the path the daemon would currently pick as primary for a
    /// latency-sensitive send. Used for logging and pre-auth send decisions.
    /// Equal RTTs retain stable carrier order.
    pub fn primary_for_latency(&self, now_ms: f64, stale_threshold_ms: f64) -> PeerTransport {
        self.best_two_live(now_ms, stale_threshold_ms)
            .0
            .unwrap_or(PeerTransport::Edge)
    }

    /// Lowest-RTT live carrier other than `exclude`, used only after an
    /// immediate queue/send failure. This preserves failover without paying the
    /// steady-state cost of racing every frame.
    pub fn fallback_for(
        &self,
        exclude: PeerTransport,
        now_ms: f64,
        stale_threshold_ms: f64,
    ) -> Option<PeerTransport> {
        Self::ORDERED
            .into_iter()
            .filter(|transport| *transport != exclude)
            .filter(|transport| self.get(*transport).is_live(now_ms, stale_threshold_ms))
            .min_by(|left, right| {
                self.get(*left)
                    .network_rtt_ewma_ms
                    .total_cmp(&self.get(*right).network_rtt_ewma_ms)
            })
    }
}

/// Caller's hint to `pick_path` about what kind of send this is.
///   * `LatencySensitive` — small interactive frame; prefer lowest RTT; auto-dual
///     when the primary is showing degradation signals.
///   * `SinglePath`       — utility-ranked noncritical frame; exactly one live
///     carrier unless that carrier immediately rejects admission.
///   * `Reliable`         — outbound over CHANNEL_DISPLAY_COMMIT / CTRL etc.;
///     same selection as LatencySensitive (cheap to dual-send if needed).
///   * `Redundant`        — caller explicitly wants the two best paths (e.g., FEC repair
///     shards that benefit from cross-path delivery).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendIntent {
    LatencySensitive,
    SinglePath,
    Reliable,
    Redundant,
}

/// Path-selection result. `Single` means send only on the given transport;
/// `Dual(primary, secondary)` means send on both, with the first listed being
/// the preferred path (the one whose RTT samples drive pacing, etc).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathTargets {
    Single(PeerTransport),
    Dual(PeerTransport, PeerTransport),
}

impl PathTargets {
    pub fn primary(self) -> PeerTransport {
        match self {
            PathTargets::Single(t) | PathTargets::Dual(t, _) => t,
        }
    }

    pub fn iter(self) -> PathTargetsIter {
        PathTargetsIter {
            targets: self,
            index: 0,
        }
    }

    pub fn is_dual(self) -> bool {
        matches!(self, PathTargets::Dual(_, _))
    }
}

pub struct PathTargetsIter {
    targets: PathTargets,
    index: u8,
}

impl Iterator for PathTargetsIter {
    type Item = PeerTransport;
    fn next(&mut self) -> Option<PeerTransport> {
        let next = match (self.targets, self.index) {
            (PathTargets::Single(t), 0) | (PathTargets::Dual(t, _), 0) => Some(t),
            (PathTargets::Dual(_, s), 1) => Some(s),
            _ => None,
        };
        if next.is_some() {
            self.index += 1;
        }
        next
    }
}

/// Returns the ordered path target(s) to send on. For non-`Redundant` intents
/// the caller stops at the first successful send. For `Redundant`/dual results
/// the caller sends on both (partial failures are tolerated).
pub fn pick_path(
    paths: &PeerPaths,
    intent: SendIntent,
    now_ms: f64,
    stale_threshold_ms: f64,
) -> PathTargets {
    let (primary, secondary) = paths.best_two_live(now_ms, stale_threshold_ms);
    match (primary, secondary) {
        // Every issued session has an edge coordinate, so an unavailable path
        // set still makes its best-effort enqueue against the edge owner.
        (None, _) => PathTargets::Single(PeerTransport::Edge),
        (Some(primary), None) => PathTargets::Single(primary),
        (Some(primary), Some(secondary)) => {
            let primary_health = paths.get(primary);
            let secondary_health = paths.get(secondary);

            let auto_redundant = match intent {
                SendIntent::Redundant => true,
                SendIntent::SinglePath => false,
                SendIntent::LatencySensitive | SendIntent::Reliable => {
                    primary_health.consecutive_send_failures > 0
                        || primary_health.network_rtt_ewma_ms
                            > 2.0 * secondary_health.network_rtt_ewma_ms.max(1.0)
                }
            };

            if auto_redundant {
                PathTargets::Dual(primary, secondary)
            } else {
                PathTargets::Single(primary)
            }
        }
    }
}

pub struct AdaptiveTransportState {
    pub chunk_target_bytes: usize,
    /// Browser-measured active display period. It bounds the zero-progress
    /// admission retry: a refused burst is retried no later than the receiver
    /// could have presented it. Nothing coalesces against it.
    pub presentation_period_ms: f64,
    pub profile: u8,
    pub snapshot_target_bytes: usize,
    /// False until a validated browser transport hint has arrived.
    pub flush_hint_active: bool,
    /// Display datagrams the browser's receive queue holds, as the browser read
    /// it back after configuring it. Bounds one flush so a burst can never
    /// exceed the queue meant to receive it.
    pub receive_queue_datagrams: u16,
}

impl Default for AdaptiveTransportState {
    fn default() -> Self {
        Self {
            chunk_target_bytes: DEFAULT_CHUNK_TARGET_BYTES,
            // Fail fast before the browser's first hint: a cold 480Hz panel has
            // the narrowest legal frame budget Merkur supports.
            presentation_period_ms: 1_000.0 / 480.0,
            receive_queue_datagrams: DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH,
            profile: 0,
            snapshot_target_bytes: TRANSPORT_POLICY_SNAPSHOT_TARGET_DEFAULT_BYTES,
            flush_hint_active: false,
        }
    }
}

/// Which path(s) successfully carried a display datagram, recorded at send
/// time. The ACK handler attributes the round-trip RTT sample to the path
/// that actually carried the datagram — NOT the path the ACK returned on.
/// The client ACKs over its own lowest-RTT path, so the arrival path says
/// nothing about the outbound leg; charging the sample there let a slow
/// primary poison the other path's EWMA and freeze itself as primary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SentPaths {
    pub webtransport: bool,
    pub edge: bool,
}

impl SentPaths {
    pub fn single(transport: PeerTransport) -> Self {
        let mut paths = Self::default();
        paths.mark(transport);
        paths
    }

    pub fn mark(&mut self, transport: PeerTransport) {
        match transport {
            PeerTransport::WebTransport => self.webtransport = true,
            PeerTransport::Edge => self.edge = true,
        }
    }

    pub fn any(self) -> bool {
        self.webtransport || self.edge
    }

    /// The unambiguous carrier, if exactly one path carried the datagram.
    /// Dual-sent (raced) datagrams return None — the first copy to arrive
    /// wins and we can't tell which, so no RTT sample is attributable.
    pub fn sole_path(self) -> Option<PeerTransport> {
        match (self.webtransport, self.edge) {
            (true, false) => Some(PeerTransport::WebTransport),
            (false, true) => Some(PeerTransport::Edge),
            _ => None,
        }
    }
}

/// The ACK provenance of one row a datagram carried: the same immutable cells
/// the PTY owner hashed and diffed, so ACK bookkeeping never rereads live
/// terminal state, and the identity of the graphics section sent with them.
/// Never the graphics bytes: those are storage the projector charges, and a
/// record a viewer never acknowledges must not keep it.
#[derive(Clone)]
pub struct SentRow {
    pub row: u16,
    pub hash: u64,
    pub cells: Arc<[CellRepr]>,
    pub graphics: Option<GraphicsVersion>,
}

// The inline record size below is this.
const _: () = assert!(size_of::<SentRow>() == 40);

impl From<&crate::pty::CapturedRow> for SentRow {
    fn from(captured: &crate::pty::CapturedRow) -> Self {
        Self {
            row: captured.row,
            hash: captured.hash,
            cells: Arc::clone(&captured.cells),
            graphics: captured.graphics.version(),
        }
    }
}

/// Rows a datagram record holds without touching the heap.
///
/// Sized to a datagram batch. `SentRow` is 40 bytes (a fat `Arc` pointer, the
/// hash, the graphics version, the row index), so a record carries 320 bytes of
/// rows inline — about 300 bytes more than the `Vec` header it replaces, and
/// `SENT_DATAGRAM_MAX_ENTRIES` bounds how many records a peer retains.
pub const INLINE_SENT_ROWS: usize = 8;

/// The rows one datagram carried, kept as its acknowledgement provenance.
///
/// A datagram batch is a handful of rows and its record lives in
/// `sent_datagrams` until an acknowledgement resolves it, so a `Vec` here cost
/// one allocation on the send side and one free on the ACK side per datagram
/// — on the two hottest turns the owner loop takes. Up to `INLINE_SENT_ROWS`
/// rows live inside the record; a batch past that — a sparse repaint packing
/// many short rows into one datagram — spills to the heap exactly once, sized
/// for the whole batch when the count is known up front.
#[expect(
    clippy::large_enum_variant,
    reason = "the inline variant is large so the common case never touches the heap; boxing \
              it would put the allocation back"
)]
pub enum SentRows {
    Inline {
        len: u8,
        rows: [Option<SentRow>; INLINE_SENT_ROWS],
    },
    Heap(Vec<SentRow>),
}

impl SentRows {
    /// Room for `count` rows: inline when they fit, otherwise one heap
    /// allocation sized for all of them.
    pub fn with_capacity(count: usize) -> Self {
        if count <= INLINE_SENT_ROWS {
            Self::default()
        } else {
            Self::Heap(Vec::with_capacity(count))
        }
    }

    pub fn push(&mut self, row: SentRow) {
        match self {
            Self::Inline { len, rows } => {
                let index = usize::from(*len);
                if index < INLINE_SENT_ROWS {
                    rows[index] = Some(row);
                    *len += 1;
                    return;
                }
                let mut spilled = Vec::with_capacity(INLINE_SENT_ROWS * 2);
                spilled.extend(rows.iter_mut().map(|slot| {
                    slot.take()
                        .expect("every inline slot below the inline capacity is filled")
                }));
                spilled.push(row);
                *self = Self::Heap(spilled);
            }
            Self::Heap(rows) => rows.push(row),
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Self::Inline { len, .. } => usize::from(*len),
            Self::Heap(rows) => rows.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn iter(&self) -> SentRowsIter<'_> {
        match self {
            Self::Inline { len, rows } => {
                SentRowsIter::Inline(rows[..usize::from(*len)].iter().flatten())
            }
            Self::Heap(rows) => SentRowsIter::Heap(rows.iter()),
        }
    }

    /// Keep the rows `keep` accepts, in order, in place.
    pub fn retain(&mut self, mut keep: impl FnMut(&SentRow) -> bool) {
        match self {
            Self::Inline { len, rows } => {
                let count = usize::from(*len);
                let mut kept = 0usize;
                for index in 0..count {
                    if rows[index].as_ref().is_some_and(&mut keep) {
                        if index != kept {
                            rows[kept] = rows[index].take();
                        }
                        kept += 1;
                    } else {
                        rows[index] = None;
                    }
                }
                *len = kept as u8;
            }
            Self::Heap(rows) => rows.retain(|row| keep(row)),
        }
    }
}

impl Default for SentRows {
    fn default() -> Self {
        Self::Inline {
            len: 0,
            rows: Default::default(),
        }
    }
}

impl FromIterator<SentRow> for SentRows {
    fn from_iter<I: IntoIterator<Item = SentRow>>(iter: I) -> Self {
        let iter = iter.into_iter();
        let mut rows = Self::with_capacity(iter.size_hint().0);
        for row in iter {
            rows.push(row);
        }
        rows
    }
}

impl<'a> IntoIterator for &'a SentRows {
    type Item = &'a SentRow;
    type IntoIter = SentRowsIter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

pub enum SentRowsIter<'a> {
    Inline(std::iter::Flatten<std::slice::Iter<'a, Option<SentRow>>>),
    Heap(std::slice::Iter<'a, SentRow>),
}

impl<'a> Iterator for SentRowsIter<'a> {
    type Item = &'a SentRow;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Inline(rows) => rows.next(),
            Self::Heap(rows) => rows.next(),
        }
    }
}

pub struct SentDatagram {
    pub sent_at_ms: f64,
    pub rows: SentRows,
    /// Path(s) that carried this datagram; drives RTT-sample attribution
    /// in the ACK handler (see `SentPaths`). Empty only for a refused original
    /// made reconstructible by admitted FEC: its ACK still owns an exact row
    /// snapshot, but supplies no original-carrier loss/RTT evidence.
    pub sent_via: SentPaths,
    /// True when the frame rode CHANNEL_DISPLAY_COMMIT (reliable stream)
    /// rather than an unreliable datagram. Distinguishes a guaranteed-delivery
    /// send from a lossy one when attributing an ACK.
    pub reliable: bool,
    /// True when this datagram carried ONLY a header (cursor / input-seq
    /// update) and no row deltas — i.e. `rows` was empty at construction.
    /// Disambiguates a legitimately row-less send from a row-bearing entry
    /// whose rows were later emptied by `invalidate_rows`. Without this flag
    /// both look identical (`rows.is_empty()`)
    /// and every lost cursor-only datagram was silently misclassified as a
    /// duplicate — a loss-signal blind spot on idle, cursor-heavy workloads.
    pub header_only: bool,
    /// Protection actually admitted for this logical datagram. This is send
    /// provenance, not an inference from the ACK: a successful ACK for an
    /// exact k=1 replay cannot reveal which physical copy arrived.
    pub protection: DisplayDatagramProtection,
}

impl SentDatagram {
    /// The one carrier whose display-loss policy may consume this outcome.
    ///
    /// Records exist only after original or reconstructing-repair admission.
    /// Repair-only exposure has no original path to attribute. Reliable sends
    /// cannot be lost at the display-datagram layer, and a raced copy has no
    /// attributable carrier, so neither may enter a per-path loss denominator.
    pub(crate) fn outcome_path(&self) -> Option<PeerTransport> {
        (!self.reliable)
            .then(|| self.sent_via.sole_path())
            .flatten()
    }

    /// Path-local protection controller that owns this attempt's evidence.
    ///
    /// A cross-carrier k=1 pair has no attributable delivery path, but the
    /// controller that requested and paid for the second copy still needs to
    /// see loss/unknown outcomes (and a censored successful outcome). Keep that
    /// provenance distinct from `outcome_path`, which deliberately remains
    /// `None` for dual-path RTT/loss-denominator attribution and retirement.
    pub(crate) fn evidence_path(&self) -> Option<PeerTransport> {
        if self.reliable {
            return None;
        }
        match self.protection {
            DisplayDatagramProtection::K1Replicated { owner } => Some(owner),
            _ => self.sent_via.sole_path(),
        }
    }
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayDatagramProtection {
    #[default]
    Unprotected,
    Fec,
    K1Replicated {
        owner: PeerTransport,
    },
    K1Probe,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisplayDatagramOutcome {
    Received,
    Recovered,
    Lost,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum K1ProtectionDecision {
    Single,
    Replicate,
    ReplicateAndProbe,
}

const FEC_EVIDENCE_WINDOW: usize = 32;
const FEC_PROMOTION_WINDOW: usize = 16;
const FEC_RECOVERIES_TO_PROMOTE: u8 = 2;
const K1_REPLICATION_MIN_GROUPS: u16 = 32;
const K1_PROBE_INTERVAL_GROUPS: u16 = 16;
const K1_CLEAN_PROBES_TO_DISABLE: u8 = 32;

const FEC_EVENT_EMPTY: u8 = 0;
const FEC_EVENT_RECEIVED: u8 = 1;
const FEC_EVENT_RECOVERED: u8 = 2;
const FEC_EVENT_LOST: u8 = 3;
const FEC_EVENT_UNKNOWN: u8 = 4;
const FEC_EVENT_CENSORED: u8 = 5;

/// Rolling, path-local display-loss evidence and the k=1 replay controller.
///
/// The ring and every counter are fixed-size. ACK classification is the sole
/// writer, and send provenance decides whether an observation is usable; raw
/// sequence holes, reliable sends, refused sends and dual-path races never
/// enter this state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FecEvidence {
    events: [u8; FEC_EVIDENCE_WINDOW],
    next: u8,
    len: u8,
    received: u8,
    recovered: u8,
    lost: u8,
    unknown: u8,
    censored: u8,
    recent_recovered: u8,
    recent_lost: u8,
    replicate_k1: bool,
    replicated_groups: u16,
    groups_since_probe: u16,
    clean_probe_streak: u8,
}

impl Default for FecEvidence {
    fn default() -> Self {
        Self {
            events: [FEC_EVENT_EMPTY; FEC_EVIDENCE_WINDOW],
            next: 0,
            len: 0,
            received: 0,
            recovered: 0,
            lost: 0,
            unknown: 0,
            censored: 0,
            recent_recovered: 0,
            recent_lost: 0,
            replicate_k1: false,
            replicated_groups: 0,
            groups_since_probe: 0,
            clean_probe_streak: 0,
        }
    }
}

impl FecEvidence {
    fn adjust_full(&mut self, event: u8, add: bool) {
        let counter = match event {
            FEC_EVENT_RECEIVED => &mut self.received,
            FEC_EVENT_RECOVERED => &mut self.recovered,
            FEC_EVENT_LOST => &mut self.lost,
            FEC_EVENT_UNKNOWN => &mut self.unknown,
            FEC_EVENT_CENSORED => &mut self.censored,
            FEC_EVENT_EMPTY => return,
            _ => unreachable!("invalid FEC evidence event"),
        };
        *counter = if add {
            counter.saturating_add(1)
        } else {
            counter.saturating_sub(1)
        };
    }

    fn adjust_recent(&mut self, event: u8, add: bool) {
        let counter = match event {
            FEC_EVENT_RECOVERED => &mut self.recent_recovered,
            FEC_EVENT_LOST => &mut self.recent_lost,
            _ => return,
        };
        *counter = if add {
            counter.saturating_add(1)
        } else {
            counter.saturating_sub(1)
        };
    }

    fn push(&mut self, event: u8) {
        let next = usize::from(self.next);
        if usize::from(self.len) >= FEC_PROMOTION_WINDOW {
            let leaving_recent = self.events
                [(next + FEC_EVIDENCE_WINDOW - FEC_PROMOTION_WINDOW) % FEC_EVIDENCE_WINDOW];
            self.adjust_recent(leaving_recent, false);
        }
        if usize::from(self.len) == FEC_EVIDENCE_WINDOW {
            self.adjust_full(self.events[next], false);
        } else {
            self.len += 1;
        }
        self.events[next] = event;
        self.next = ((next + 1) % FEC_EVIDENCE_WINDOW) as u8;
        self.adjust_full(event, true);
        self.adjust_recent(event, true);
    }

    fn enable_replication(&mut self) {
        self.replicate_k1 = true;
        self.replicated_groups = 0;
        self.groups_since_probe = 0;
        self.clean_probe_streak = 0;
    }

    fn disable_replication(&mut self) {
        self.replicate_k1 = false;
        self.replicated_groups = 0;
        self.groups_since_probe = 0;
        self.clean_probe_streak = 0;
    }

    pub(crate) fn observe(
        &mut self,
        protection: DisplayDatagramProtection,
        outcome: DisplayDatagramOutcome,
    ) {
        let event = match (protection, outcome) {
            (DisplayDatagramProtection::K1Replicated { .. }, DisplayDatagramOutcome::Received) => {
                FEC_EVENT_CENSORED
            }
            (_, DisplayDatagramOutcome::Received) => FEC_EVENT_RECEIVED,
            (_, DisplayDatagramOutcome::Recovered) => FEC_EVENT_RECOVERED,
            (_, DisplayDatagramOutcome::Lost) => FEC_EVENT_LOST,
            (_, DisplayDatagramOutcome::Unknown) => FEC_EVENT_UNKNOWN,
        };
        self.push(event);
        if outcome == DisplayDatagramOutcome::Lost {
            self.enable_replication();
            return;
        }
        if self.replicate_k1
            && matches!(
                outcome,
                DisplayDatagramOutcome::Recovered | DisplayDatagramOutcome::Unknown
            )
        {
            // A clean probe streak describes an interval with no positive loss
            // evidence and complete attribution. Recovery proves an erasure;
            // unknown provenance makes the interval unmeasurable. Neither may
            // be bridged by successful probes on either side.
            self.clean_probe_streak = 0;
        }
        if !self.replicate_k1
            && (self.recent_lost > 0 || self.recent_recovered >= FEC_RECOVERIES_TO_PROMOTE)
        {
            self.enable_replication();
            return;
        }

        if protection == DisplayDatagramProtection::K1Probe && self.replicate_k1 {
            match outcome {
                DisplayDatagramOutcome::Received => {
                    self.clean_probe_streak = self.clean_probe_streak.saturating_add(1);
                    if self.clean_probe_streak >= K1_CLEAN_PROBES_TO_DISABLE {
                        self.disable_replication();
                    }
                }
                DisplayDatagramOutcome::Recovered
                | DisplayDatagramOutcome::Lost
                | DisplayDatagramOutcome::Unknown => {
                    self.clean_probe_streak = 0;
                }
            }
        }
    }

    pub(crate) fn decide_k1(&mut self) -> K1ProtectionDecision {
        if !self.replicate_k1 {
            return K1ProtectionDecision::Single;
        }
        if self.replicated_groups >= K1_REPLICATION_MIN_GROUPS
            && self.groups_since_probe >= K1_PROBE_INTERVAL_GROUPS
        {
            return K1ProtectionDecision::ReplicateAndProbe;
        }
        K1ProtectionDecision::Replicate
    }

    pub(crate) fn record_k1_replica_admitted(&mut self, probe_due: bool) {
        debug_assert!(self.replicate_k1);
        self.replicated_groups = self.replicated_groups.saturating_add(1);
        self.groups_since_probe = if probe_due {
            0
        } else {
            self.groups_since_probe.saturating_add(1)
        };
    }

    pub(crate) fn defer_probe(&mut self) {
        if self.replicate_k1 {
            self.groups_since_probe = K1_PROBE_INTERVAL_GROUPS;
        }
    }

    #[cfg(test)]
    pub(crate) fn replication_enabled(&self) -> bool {
        self.replicate_k1
    }

    #[cfg(test)]
    pub(crate) fn replication_progress(&self) -> (u16, u16, u8) {
        (
            self.replicated_groups,
            self.groups_since_probe,
            self.clean_probe_streak,
        )
    }
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FecEvidenceByPath {
    webtransport: FecEvidence,
    edge: FecEvidence,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SimDatagramRole {
    Data,
    Replica,
    Repair,
    Probe,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SimDatagramMetadata {
    pub(crate) generation: u32,
    /// Display sequence carried on the wire. Diagnostic only: probes consume
    /// this space, so random loss must never key from it.
    pub(crate) wire_seq: u32,
    /// Role-independent ordinal of the protected logical data datagram.
    /// Replica and repair traffic reuse the data ordinal; probes draw from a
    /// separate ordinal stream and therefore cannot shift later data faults.
    pub(crate) logical_ordinal: u64,
    pub(crate) path: PeerTransport,
    pub(crate) role: SimDatagramRole,
    pub(crate) role_index: u8,
    /// Number of earlier physical send attempts with this exact stable
    /// `(generation, logical_ordinal, path, role, role_index)` identity.
    /// A retry must get a fresh loss draw without letting unrelated traffic
    /// perturb it.
    pub(crate) retransmit_attempt: u32,
}

impl FecEvidenceByPath {
    pub(crate) fn get_mut(&mut self, path: PeerTransport) -> &mut FecEvidence {
        match path {
            PeerTransport::WebTransport => &mut self.webtransport,
            PeerTransport::Edge => &mut self.edge,
        }
    }

    #[cfg(test)]
    pub(crate) fn get(&self, path: PeerTransport) -> &FecEvidence {
        match path {
            PeerTransport::WebTransport => &self.webtransport,
            PeerTransport::Edge => &self.edge,
        }
    }

    pub(crate) fn reset(&mut self, path: PeerTransport) {
        *self.get_mut(path) = FecEvidence::default();
    }
}

/// Final selective-ACK outcomes for display datagrams attributable to one
/// carrier.
///
/// The three classified buckets are disjoint. `received + recovered_by_fec +
/// declared_lost` is the denominator for both pre-repair erasure and residual
/// loss. `outcome_unknown` is deliberately outside that denominator: it counts
/// eligible records whose bounded provenance expired or was pruned before the
/// receiver could classify them, making measurement coverage explicit.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayDatagramOutcomeCounters {
    pub received: u64,
    pub recovered_by_fec: u64,
    pub declared_lost: u64,
    pub outcome_unknown: u64,
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayDatagramOutcomes {
    pub webtransport: DisplayDatagramOutcomeCounters,
    pub edge: DisplayDatagramOutcomeCounters,
}

impl DisplayDatagramOutcomes {
    pub fn get(self, transport: PeerTransport) -> DisplayDatagramOutcomeCounters {
        match transport {
            PeerTransport::WebTransport => self.webtransport,
            PeerTransport::Edge => self.edge,
        }
    }

    pub fn get_mut(&mut self, transport: PeerTransport) -> &mut DisplayDatagramOutcomeCounters {
        match transport {
            PeerTransport::WebTransport => &mut self.webtransport,
            PeerTransport::Edge => &mut self.edge,
        }
    }
}

/// Wasted-display-work accounting, per peer, for the lifetime of the peer.
///
/// The whole display path is optimized for getting a frame out faster. Nothing
/// answers the prior question — whether the frame needed to go out at all — and
/// without that number there is no way to tell an efficient path from one that
/// is efficiently sending work the browser will never see.
///
/// The unit is a *row version*, not a frame. A frame is a bundle of rows chosen
/// by `classify_flush_rows`, so "was the frame superseded" has no answer; "was
/// this version of this row replaced by a newer one before the browser reported
/// applying it" does, and it is exactly the quantity a send-less policy would
/// act on.
///
/// Plain `u64`, no atomics: every field is written from the owner loop, which
/// is the only writer of `PerPeerDisplayCache`. These are counters, not a
/// control input — nothing reads them to make a send decision.
#[derive(Default, Clone, Copy, Debug)]
pub struct DisplayWasteCounters {
    /// Row versions put on the wire: sends where the row's content differed
    /// from what was last sent.
    ///
    /// The denominator for the two `superseded` counters below, which are
    /// incremented inside this same branch and so really are subsets of it.
    ///
    /// It is NOT the denominator for `row_resends_identical`, which is the
    /// *other* arm of the same `if`. The two are disjoint partitions of one
    /// event, so total row sends are their sum and the ratio
    /// `row_resends_identical / row_versions_sent` is duplicates *per new
    /// version* — unbounded above, and 1.0 means half of all row sends carried
    /// nothing new. Reading that ratio as a percentage of sends overstates the
    /// duplicate share roughly twofold; a fleet ratio of 0.965 is 49% of sends.
    pub row_versions_sent: u64,
    /// Row versions replaced by a newer version of the same row while the
    /// browser had still not reported applying the sequence that carried them.
    /// This is the "sent and never seen" number.
    pub row_versions_superseded_unapplied: u64,
    /// Row versions replaced after the browser had reported applying them.
    /// These were not wasted: the peer rendered them.
    pub row_versions_superseded_applied: u64,
    /// Re-sends of byte-identical content, paced by `sent_row_resend_after_ms`.
    /// These carry no new information by construction; they exist because
    /// there is no NACK and the resend deadline is the loss-recovery mechanism.
    pub row_resends_identical: u64,
    /// Frames prepared off the owner loop from terminal state that a later PTY
    /// read had already superseded by the time they were sent. They are sent
    /// anyway — `finish_display_prepare` only re-arms `needs_full_diff`
    /// afterwards — so this counts frames known-stale at their own send.
    pub stale_prepared_flushes_sent: u64,
    /// Paced bursts abandoned before their unsent tail reached a transport.
    /// Only reachable under receiver backpressure: an unpaced redraw is sent
    /// inline in one turn and never becomes a pending burst at all.
    pub bursts_abandoned: u64,
    /// Superseded bursts kept anyway because the sequence rewind was not
    /// provable. Distinguishes "nothing to abandon" from "could not".
    pub bursts_unsafe_to_rewind: u64,
    /// Datagram sends the transport refused outright. Incremented on the
    /// existing failure branch, which already formats a multi-field `warn!`, so
    /// the counter is free relative to the work already on that path.
    pub datagram_send_failures: u64,
    /// FEC repair frames emitted. Once per protected group, after a parity
    /// encode, a seal and a UDP write — not once per datagram.
    pub fec_repairs_sent: u64,
    /// Parity frames the transport refused.
    ///
    /// Separate from `fec_repairs_sent` because a refusal is the interesting
    /// case: it means the group most likely to need repair is the one that went
    /// unprotected. Without this the sent counter alone cannot distinguish "FEC
    /// is off" from "FEC is working".
    pub fec_repairs_refused: u64,
    /// Rows the browser asked to be resynchronised, from the hash-digest
    /// divergence backstop.
    pub resync_rows_requested: u64,
    /// Rows disowned because the datagram carrying them was declared lost.
    pub rows_declared_lost: u64,
}

impl DisplayWasteCounters {
    /// Fraction of row versions that went on the wire and were replaced before
    /// the browser reported rendering them. `None` until something was sent.
    pub fn superseded_unapplied_ratio(&self) -> Option<f64> {
        (self.row_versions_sent > 0)
            .then(|| self.row_versions_superseded_unapplied as f64 / self.row_versions_sent as f64)
    }
}

/// Whether one row is selected by a flush at `now_ms`: the per-row rule
/// `classify_flush_rows` applies, and the one the scheduler asks through
/// [`PerPeerDisplayCache::has_selectable_rows`], so scheduling and selection
/// are derived from the same state by the same function.
///
/// A row is skipped for exactly two reasons.
///
/// 1. The current sent content lineage was confirmed by an exact attempt ACK,
///    and it equals both the live and acknowledged content. Hash equality alone
///    is insufficient: after A → B → A, the old exact A baseline does not prove
///    the newly sent A arrived, and a late B must still be overwritten.
/// 2. This exact content is already in flight and has not had a round trip to
///    be acknowledged in. Re-sending it now cannot be a response to new
///    information; it would only re-occupy the link. This paces DUPLICATES
///    only — a row whose hash changed falls straight through, so interactive
///    echo is never delayed by it — and it is not a recovery timer: the row is
///    selected again the instant its deadline passes, with no event required.
///
/// Every other row is re-encoded against the acknowledged baseline on every
/// flush. That idempotent re-selection is what takes loss recovery out of the
/// display path: nothing needs a NACK, a repair, or a timer to bring a row
/// back.
#[inline]
pub(crate) fn display_row_is_selectable(
    current: u64,
    acked: u64,
    acked_exact: bool,
    sent: u64,
    current_content_confirmed: bool,
    latest_seq: u32,
    has_reliable_attempt: bool,
    resend_after_ms: f64,
    now_ms: f64,
) -> bool {
    if current_content_confirmed && acked_exact && current == acked && sent == acked {
        return false;
    }
    if sent != current || latest_seq == 0 {
        return true;
    }
    if has_reliable_attempt {
        return false;
    }
    // A later allocated sequence may never have entered a carrier. Only an
    // applied selective-ACK bit can resolve this attempt before its deadline.
    now_ms >= resend_after_ms
}

/// Exact bounded census for the scheduler's latency decision. A singleton
/// cursor row is the only row-bearing update whose eventual encoder
/// classification can be urgent; `Multiple` also covers one non-cursor row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SelectableRowShape {
    None,
    CursorOnly,
    Multiple,
}

#[inline]
fn shift_display_attempt_mask(mask: &mut [u32; DISPLAY_ACK_MASK_WORDS], distance: u32) {
    if distance == 0 {
        return;
    }
    if distance >= DISPLAY_ACK_MASK_WINDOW {
        *mask = [0; DISPLAY_ACK_MASK_WORDS];
        return;
    }
    let previous = *mask;
    let word_shift = (distance >> 5) as usize;
    let bit_shift = distance & 31;
    for target in (0..DISPLAY_ACK_MASK_WORDS).rev() {
        let mut value = if target >= word_shift {
            previous[target - word_shift] << bit_shift
        } else {
            0
        };
        if bit_shift != 0 && target > word_shift {
            value |= previous[target - word_shift - 1] >> (32 - bit_shift);
        }
        mask[target] = value;
    }
}

/// Which applied datagrams demonstrably traversed each sole physical carrier.
/// Retained after their heavier sent snapshots drain, so separate ACKs still
/// provide packet-threshold evidence. A global display displacement is not
/// evidence that a slower, different carrier lost its older original.
#[derive(Default)]
pub(crate) struct AppliedCarrierEvidence {
    head: u32,
    direct: [u32; DISPLAY_ACK_MASK_WORDS],
    edge: [u32; DISPLAY_ACK_MASK_WORDS],
}

impl AppliedCarrierEvidence {
    pub(crate) fn advance(&mut self, head: u32) {
        if head == 0 {
            return;
        }
        if self.head == 0 {
            self.head = head;
        } else {
            let distance = head.wrapping_sub(self.head);
            if distance != 0 && distance < 0x8000_0000 {
                shift_display_attempt_mask(&mut self.direct, distance);
                shift_display_attempt_mask(&mut self.edge, distance);
                self.head = head;
            }
        }
    }

    pub(crate) fn observe(&mut self, sequence: u32, path: PeerTransport) {
        let offset = self.head.wrapping_sub(sequence);
        if offset < DISPLAY_ACK_MASK_WINDOW {
            let mask = match path {
                PeerTransport::WebTransport => &mut self.direct,
                PeerTransport::Edge => &mut self.edge,
            };
            mask[(offset >> 5) as usize] |= 1u32 << (offset & 31);
        }
    }

    pub(crate) fn window(&self, path: PeerTransport) -> (u32, [u32; DISPLAY_ACK_MASK_WORDS]) {
        (
            self.head,
            match path {
                PeerTransport::WebTransport => self.direct,
                PeerTransport::Edge => self.edge,
            },
        )
    }
}

#[inline]
fn newest_display_attempt_offset(mask: &[u32; DISPLAY_ACK_MASK_WORDS]) -> Option<u32> {
    mask.iter().enumerate().find_map(|(word, &bits)| {
        (bits != 0).then(|| word as u32 * u32::BITS + bits.trailing_zeros())
    })
}

#[inline]
fn oldest_display_attempt_offset(mask: &[u32; DISPLAY_ACK_MASK_WORDS]) -> Option<u32> {
    mask.iter().enumerate().rev().find_map(|(word, &bits)| {
        (bits != 0).then(|| word as u32 * u32::BITS + (u32::BITS - 1 - bits.leading_zeros()))
    })
}

/// Re-anchor an attempt bitmap after its `distance` newest sequence slots were
/// retired. This is a cold carrier-replacement operation, so the direct and
/// readable fixed-window walk is preferable to a second word-shift primitive.
#[inline]
fn discard_newer_display_attempts(mask: &mut [u32; DISPLAY_ACK_MASK_WORDS], distance: u32) {
    if distance == 0 {
        return;
    }
    let previous = *mask;
    *mask = [0; DISPLAY_ACK_MASK_WORDS];
    for new_offset in 0..DISPLAY_ACK_MASK_WINDOW - distance {
        let old_offset = new_offset + distance;
        if previous[(old_offset >> 5) as usize] & (1u32 << (old_offset & 31)) != 0 {
            mask[(new_offset >> 5) as usize] |= 1u32 << (new_offset & 31);
        }
    }
}

pub struct PerPeerDisplayCache {
    pub cols: u16,
    pub rows: u16,
    pub initialized: bool,
    /// Canonical acknowledged cells, row-granular and immutable. Worker
    /// preparation retains a baseline with one refcount increment instead of
    /// allocating or copying a complete row for every peer delta.
    pub acked_row_cells: Vec<Arc<[CellRepr]>>,
    /// The graphics version each acknowledged row carried; `None` is the empty set.
    pub acked_row_graphics: Vec<Option<GraphicsVersion>>,
    /// Monotonic identity of the complete acknowledged-row state. Pointer
    /// identity alone cannot fence an off-loop prepare when loss or resync
    /// invalidates a row without replacing its immutable cell allocation.
    pub acked_row_revisions: Vec<u64>,
    pub acked_row_hashes: Vec<u64>,
    pub acked_row_seq: Vec<u32>,
    /// Whether the browser explicitly named this row's sequence in an ACK.
    /// A cumulative numeric high-water can cover older frames that crossed a
    /// different delivery lane; those baselines remain useful for compaction,
    /// but a later delta must be full-row until exact delivery is known.
    pub acked_row_exact: Vec<bool>,
    /// Rows an incremental resume still owes the client, and how many remain.
    ///
    /// A resume repair is the one time the browser is holding a screen it knows
    /// is wrong, so it holds its paint until the repair lands rather than
    /// showing the rows arriving one at a time. That needs an end marker, and
    /// the end is "every row this repair selected has reached a transport" —
    /// which is exactly what `record_sent_rows_on_lane` observes.
    pub repair_pending: Vec<bool>,
    pub repair_pending_rows: usize,
    /// Exact rows whose successful physical admission cleared
    /// `repair_pending`, paired with that first admitted sequence.
    ///
    /// A numeric high-water is insufficient: a later datagram can arrive while
    /// an earlier repair datagram is lost. The browser uses this bounded set to
    /// hold only presentation until every independently-applicable transform
    /// actually applied.
    pub repair_members: Vec<ResumeRepairMember>,
    /// Defensive fail-closed state. The half-screen repair rule proves the
    /// sequence set fits, but a future caller that violates that contract must
    /// force a snapshot rather than emit an incomplete completion marker.
    pub repair_member_overflow: bool,
    /// Browser-chosen authenticated-session token echoed by the completion
    /// marker. Display generation alone is intentionally preserved across a
    /// carrier rebind and cannot distinguish two consecutive repairs.
    pub repair_id: u32,
    /// Set while a repair is outstanding, so "nothing left to send" is
    /// distinguishable from "no repair was ever armed".
    pub repair_armed: bool,
    /// Delivery lane that supplied `acked_row_seq` for each row. A cumulative
    /// high-water ACK can overtake an older reliable frame on the datagram lane;
    /// this bit records which lane actually supplied the credit.
    pub acked_row_reliable: Vec<bool>,
    /// Highest display sequence the browser has reported applying in this
    /// generation. This compact high-water preserves enough provenance after
    /// `sent_datagrams` is drained to tell an obsolete delayed ACK from a
    /// genuinely unacknowledged send whose bounded history was pruned.
    /// Zero is the "no applied ACK yet" sentinel.
    pub last_applied_ack_seq: u32,
    pub(crate) applied_carrier_evidence: AppliedCarrierEvidence,
    /// Canonical sent-row provenance, reused when a selective ACK confirms any
    /// retained attempt of the current row version.
    pub sent_row_cells: Vec<Arc<[CellRepr]>>,
    pub sent_row_graphics: Vec<Option<GraphicsVersion>>,
    pub sent_row_hashes: Vec<u64>,
    /// Whether an exact ACK named an attempt of the current sent content
    /// lineage. This is distinct from hash equality with `acked_row_hashes`:
    /// after A -> B -> A, the old exact A baseline does not confirm the newly
    /// sent A, and a late B must still be overwritten by a full-row retry.
    pub sent_row_confirmed: Vec<bool>,
    /// A speculative older version existed when this content was sent, so
    /// every retry must remain baseline-independent until exact confirmation.
    pub sent_row_force_full_until_confirmed: Vec<bool>,
    /// First sequence that carried the current `sent_row_hashes` version.
    /// Kept for supersession accounting and as one endpoint of the bounded
    /// per-row attempt history below.
    pub sent_row_seq: Vec<u32>,
    /// Newest sequence that successfully carried the current row version.
    /// Loss is actionable only when this sequence, rather than an older retry,
    /// is proven absent.
    pub sent_row_latest_seq: Vec<u32>,
    /// Sequences in the selective-ACK window that carried the current row
    /// version, anchored at `sent_row_latest_seq` with the same bit ordering as
    /// `DisplayAck::received_mask`.
    pub sent_row_attempt_mask: Vec<[u32; DISPLAY_ACK_MASK_WORDS]>,
    /// Which current-content attempts rode each physical carrier. Carrier
    /// replacement retains only attempts that also rode the surviving path;
    /// attempts owned solely by the displaced carrier are requeued immediately.
    pub sent_row_attempt_direct_mask: Vec<[u32; DISPLAY_ACK_MASK_WORDS]>,
    pub sent_row_attempt_edge_mask: Vec<[u32; DISPLAY_ACK_MASK_WORDS]>,
    /// Which entries of `sent_row_attempt_mask` rode the reliable commit lane.
    /// A selective datagram hole is never proof that an ordered stream record
    /// was lost.
    pub sent_row_attempt_reliable_mask: Vec<[u32; DISPLAY_ACK_MASK_WORDS]>,
    /// Whether any attempt of the current content used the reliable lane.
    /// Unlike the bounded bitmap this survives aging beyond 128 sequences:
    /// an ordered stream send cannot become lost merely because datagram ACK
    /// history no longer describes its sequence.
    pub sent_row_has_reliable_attempt: Vec<bool>,
    /// Newest reliable current-content attempt carried by each path. Reliable
    /// records can age out of `sent_datagrams`, but their ordered delivery
    /// guarantee must still survive replacement of the unrelated carrier.
    pub sent_row_latest_direct_reliable_seq: Vec<u32>,
    pub sent_row_latest_edge_reliable_seq: Vec<u32>,
    /// First send time of the current `sent_row_hashes` version. Identical
    /// safety resends do not move it, allowing the digest backstop to run after
    /// a bounded deferral instead of being postponed forever.
    pub sent_row_first_sent_at_ms: Vec<f64>,
    /// Delivery lane paired with `sent_row_seq`. Like the seq, this remains
    /// pinned to the first send of identical content.
    pub sent_row_reliable: Vec<bool>,
    /// Delivery lane paired with `sent_row_latest_seq`.
    pub sent_row_latest_reliable: Vec<bool>,
    /// Earliest time this row's CURRENT content may go on the wire again.
    /// Set on every send from the path's RTT; see `row_resend_interval_ms`.
    pub sent_row_resend_after_ms: Vec<f64>,
    pub sent_datagrams: BTreeMap<u32, SentDatagram>,
    /// Never above the earliest `sent_at_ms` in `sent_datagrams`: inserts
    /// lower it, removals leave it, and each pruning pass sets it exactly. A
    /// record's send time is never rewritten, so a flush whose bound has not
    /// aged past the prune age knows nothing expired without visiting a record.
    oldest_sent_datagram_at_ms: f64,
    /// Final datagram outcomes split by the sole carrier that admitted them.
    /// Lifetime totals: generation changes clear retained records into the
    /// `outcome_unknown` bucket but do not clear these counters.
    pub datagram_outcomes: DisplayDatagramOutcomes,
    /// Allocation-free, path-local evidence used only by display protection.
    /// Unlike lifetime telemetry this is a rolling control window.
    pub(crate) fec_evidence: FecEvidenceByPath,
    pub fec_encoder: FecEncoder,
    /// The rows one `invalidate_rows` call is disowning, as a bitmask over row
    /// indices, sized by `resize`. Set and cleared inside that one call and
    /// retained between calls, so the walk over every retained datagram record
    /// tests membership in one load instead of against a set built per call.
    row_invalidation_mask: Vec<u64>,
    pub heartbeat_frames_since_last: u32,
    pub heartbeat_last_sent_ms: f64,
    /// Lifetime totals, deliberately not cleared by `resize`,
    /// `prime_from_snapshot`, or `reset_for_snapshot`: a generation change is
    /// part of what a session costs, so zeroing here would hide it.
    pub waste: DisplayWasteCounters,
    /// How many times `invalidate_rows` has run. An acknowledgement that
    /// declares several rows lost must disown them in one call, because each
    /// call walks every retained datagram record.
    #[cfg(test)]
    pub invalidate_calls: usize,
}

impl PerPeerDisplayCache {
    pub fn new() -> Self {
        Self {
            cols: 0,
            rows: 0,
            initialized: false,
            acked_row_cells: Vec::new(),
            acked_row_graphics: Vec::new(),
            acked_row_revisions: Vec::new(),
            acked_row_hashes: Vec::new(),
            acked_row_seq: Vec::new(),
            acked_row_exact: Vec::new(),
            repair_pending: Vec::new(),
            repair_pending_rows: 0,
            repair_members: Vec::with_capacity(MAX_RESUME_REPAIR_MEMBERS),
            repair_member_overflow: false,
            repair_id: 0,
            repair_armed: false,
            acked_row_reliable: Vec::new(),
            last_applied_ack_seq: 0,
            applied_carrier_evidence: AppliedCarrierEvidence::default(),
            sent_row_cells: Vec::new(),
            sent_row_graphics: Vec::new(),
            sent_row_hashes: Vec::new(),
            sent_row_confirmed: Vec::new(),
            sent_row_force_full_until_confirmed: Vec::new(),
            sent_row_seq: Vec::new(),
            sent_row_latest_seq: Vec::new(),
            sent_row_attempt_mask: Vec::new(),
            sent_row_attempt_direct_mask: Vec::new(),
            sent_row_attempt_edge_mask: Vec::new(),
            sent_row_attempt_reliable_mask: Vec::new(),
            sent_row_has_reliable_attempt: Vec::new(),
            sent_row_latest_direct_reliable_seq: Vec::new(),
            sent_row_latest_edge_reliable_seq: Vec::new(),
            sent_row_first_sent_at_ms: Vec::new(),
            sent_row_reliable: Vec::new(),
            sent_row_latest_reliable: Vec::new(),
            sent_row_resend_after_ms: Vec::new(),
            sent_datagrams: BTreeMap::new(),
            oldest_sent_datagram_at_ms: f64::INFINITY,
            datagram_outcomes: DisplayDatagramOutcomes::default(),
            fec_evidence: FecEvidenceByPath::default(),
            fec_encoder: FecEncoder::new(),
            row_invalidation_mask: Vec::new(),
            heartbeat_frames_since_last: 0,
            heartbeat_last_sent_ms: 0.0,
            waste: DisplayWasteCounters::default(),
            #[cfg(test)]
            invalidate_calls: 0,
        }
    }

    /// Resize the acknowledged baseline. Caller follows with a snapshot to re-prime it.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        let blank_row: Arc<[CellRepr]> = vec![CellRepr::BLANK; usize::from(cols)].into();
        self.acked_row_cells.clear();
        self.acked_row_graphics.clear();
        self.acked_row_graphics.resize(usize::from(rows), None);
        self.acked_row_cells
            .resize(usize::from(rows), Arc::clone(&blank_row));
        self.acked_row_revisions.clear();
        self.acked_row_revisions.resize(usize::from(rows), 0);
        self.acked_row_hashes.clear();
        self.acked_row_hashes.resize(usize::from(rows), 0);
        self.acked_row_seq.clear();
        self.acked_row_seq.resize(usize::from(rows), 0);
        self.acked_row_exact.clear();
        self.acked_row_exact.resize(usize::from(rows), false);
        self.repair_pending.clear();
        self.repair_pending.resize(usize::from(rows), false);
        self.repair_pending_rows = 0;
        self.repair_members.clear();
        self.repair_member_overflow = false;
        self.repair_id = 0;
        self.repair_armed = false;
        self.acked_row_reliable.clear();
        self.acked_row_reliable.resize(usize::from(rows), false);
        self.last_applied_ack_seq = 0;
        self.applied_carrier_evidence = AppliedCarrierEvidence::default();
        self.sent_row_cells.clear();
        self.sent_row_graphics.clear();
        self.sent_row_graphics.resize(usize::from(rows), None);
        self.sent_row_cells
            .resize(usize::from(rows), Arc::clone(&blank_row));
        self.sent_row_hashes.clear();
        self.sent_row_hashes.resize(usize::from(rows), 0);
        self.sent_row_confirmed.clear();
        self.sent_row_confirmed.resize(usize::from(rows), false);
        self.sent_row_force_full_until_confirmed.clear();
        self.sent_row_force_full_until_confirmed
            .resize(usize::from(rows), false);
        self.sent_row_seq.clear();
        self.sent_row_seq.resize(usize::from(rows), 0);
        self.sent_row_latest_seq.clear();
        self.sent_row_latest_seq.resize(usize::from(rows), 0);
        self.sent_row_attempt_mask.clear();
        self.sent_row_attempt_mask
            .resize(usize::from(rows), [0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_direct_mask.clear();
        self.sent_row_attempt_direct_mask
            .resize(usize::from(rows), [0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_edge_mask.clear();
        self.sent_row_attempt_edge_mask
            .resize(usize::from(rows), [0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_reliable_mask.clear();
        self.sent_row_attempt_reliable_mask
            .resize(usize::from(rows), [0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_has_reliable_attempt.clear();
        self.sent_row_has_reliable_attempt
            .resize(usize::from(rows), false);
        self.sent_row_latest_direct_reliable_seq.clear();
        self.sent_row_latest_direct_reliable_seq
            .resize(usize::from(rows), 0);
        self.sent_row_latest_edge_reliable_seq.clear();
        self.sent_row_latest_edge_reliable_seq
            .resize(usize::from(rows), 0);
        self.sent_row_first_sent_at_ms.clear();
        self.sent_row_first_sent_at_ms
            .resize(usize::from(rows), f64::NEG_INFINITY);
        self.sent_row_reliable.clear();
        self.sent_row_reliable.resize(usize::from(rows), false);
        self.sent_row_latest_reliable.clear();
        self.sent_row_latest_reliable
            .resize(usize::from(rows), false);
        self.sent_row_resend_after_ms.clear();
        self.sent_row_resend_after_ms.resize(usize::from(rows), 0.0);
        self.retire_all_sent_datagrams_unknown();
        self.row_invalidation_mask.clear();
        self.row_invalidation_mask
            .resize(usize::from(rows).div_ceil(u64::BITS as usize), 0);
        self.initialized = false;
    }

    /// Prime the acknowledged baseline from a freshly-sent snapshot.
    /// `grid` is row-major (rows * cols) and `hashes.len() == rows`.
    pub fn prime_from_snapshot(
        &mut self,
        grid: &[CellRepr],
        hashes: &[u64],
        graphics: &[Option<GraphicsVersion>],
    ) {
        assert!(graphics.len() <= usize::from(self.rows));
        self.acked_row_graphics.fill(None);
        self.sent_row_graphics.fill(None);
        self.acked_row_graphics[..graphics.len()].copy_from_slice(graphics);
        self.sent_row_graphics[..graphics.len()].copy_from_slice(graphics);
        debug_assert_eq!(
            grid.len(),
            usize::from(self.rows).saturating_mul(usize::from(self.cols))
        );
        debug_assert_eq!(hashes.len(), self.acked_row_hashes.len());
        let cols = usize::from(self.cols);
        for ((acked, sent), row) in self
            .acked_row_cells
            .iter_mut()
            .zip(&mut self.sent_row_cells)
            .zip(grid.chunks_exact(cols))
        {
            let cells: Arc<[CellRepr]> = row.into();
            *acked = Arc::clone(&cells);
            *sent = cells;
        }
        for revision in &mut self.acked_row_revisions {
            *revision = revision.wrapping_add(1);
        }
        self.acked_row_hashes.copy_from_slice(hashes);
        self.acked_row_seq.fill(0);
        self.acked_row_exact.fill(true);
        self.acked_row_reliable.fill(false);
        self.last_applied_ack_seq = 0;
        self.applied_carrier_evidence = AppliedCarrierEvidence::default();
        self.sent_row_hashes.copy_from_slice(hashes);
        self.sent_row_confirmed.fill(true);
        self.sent_row_force_full_until_confirmed.fill(false);
        self.sent_row_seq.fill(0);
        self.sent_row_latest_seq.fill(0);
        self.sent_row_attempt_mask.fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_direct_mask
            .fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_edge_mask
            .fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_reliable_mask
            .fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_has_reliable_attempt.fill(false);
        self.sent_row_latest_direct_reliable_seq.fill(0);
        self.sent_row_latest_edge_reliable_seq.fill(0);
        self.sent_row_first_sent_at_ms.fill(f64::NEG_INFINITY);
        self.sent_row_reliable.fill(false);
        self.sent_row_latest_reliable.fill(false);
        self.sent_row_resend_after_ms.fill(0.0);
        self.retire_all_sent_datagrams_unknown();
        self.initialized = true;
    }

    /// Mark rows as needing re-send AND arm the "prefer reliable" window so
    /// the next encode for these rows routes over CHANNEL_DISPLAY_COMMIT
    /// instead of datagrams. Called when the client requests a resync —
    /// strong evidence that prior datagram delivery silently failed.
    ///
    /// Also drops the invalidated rows from any in-flight `sent_datagrams`
    /// entries: otherwise a post-invalidate ACK datagram (for a send that was
    /// already in flight when the resync arrived) would walk the old
    /// `sent_row` snapshot and re-advance the acknowledged row cells/hashes
    /// for the very rows we just disowned, undoing the invalidate and
    /// leaving the daemon believing a still-divergent client is in sync.
    /// Forget the peer's acknowledged state for these rows.
    ///
    /// Recovery is just the ordinary idempotent re-send: the next flush sees
    /// `current != acked` and emits the rows complete. There is no deadline, no
    /// lane preference, and no repair frame — those existed only because a
    /// suppressed row had no other way back onto the wire.
    ///
    /// `acked_row_seq` is deliberately left alone. Together with the cleared
    /// `acked_row_exact` it is what makes `classify_flush_rows` widen the row to
    /// full width, so the re-send does not depend on the baseline we just
    /// disowned.
    ///
    /// Also drops the invalidated rows from any in-flight `sent_datagrams`
    /// entries: otherwise a post-invalidate ACK (for a send already in flight
    /// when the resync arrived) would walk the old snapshot and re-advance
    /// acknowledged cells for the very rows we just disowned.
    ///
    /// One call walks every retained datagram record once, whatever the number
    /// of rows: callers with several rows to disown — a lossy acknowledgement,
    /// a resync, a resume repair — pass them together rather than one at a
    /// time, and membership is tested against the retained row bitmask rather
    /// than a set built per call, so disowning allocates nothing.
    pub fn invalidate_rows(&mut self, rows: &[u16]) {
        #[cfg(test)]
        {
            self.invalidate_calls += 1;
        }
        let mut disowned = 0usize;
        for &row in rows {
            let r = usize::from(row);
            if r >= usize::from(self.rows) {
                continue;
            }
            if r < self.acked_row_hashes.len() {
                // Sentinel zero — any current hash will differ, forcing re-send.
                self.acked_row_hashes[r] = 0;
            }
            if let Some(revision) = self.acked_row_revisions.get_mut(r) {
                *revision = revision.wrapping_add(1);
            }
            if r < self.acked_row_exact.len() {
                self.acked_row_exact[r] = false;
            }
            if r < self.sent_row_hashes.len() {
                self.sent_row_hashes[r] = 0;
            }
            if r < self.sent_row_confirmed.len() {
                self.sent_row_confirmed[r] = false;
            }
            if r < self.sent_row_force_full_until_confirmed.len() {
                self.sent_row_force_full_until_confirmed[r] = true;
            }
            if r < self.sent_row_seq.len() {
                self.sent_row_seq[r] = 0;
            }
            if r < self.sent_row_latest_seq.len() {
                self.sent_row_latest_seq[r] = 0;
            }
            if r < self.sent_row_attempt_mask.len() {
                self.sent_row_attempt_mask[r] = [0; DISPLAY_ACK_MASK_WORDS];
            }
            if r < self.sent_row_attempt_direct_mask.len() {
                self.sent_row_attempt_direct_mask[r] = [0; DISPLAY_ACK_MASK_WORDS];
            }
            if r < self.sent_row_attempt_edge_mask.len() {
                self.sent_row_attempt_edge_mask[r] = [0; DISPLAY_ACK_MASK_WORDS];
            }
            if r < self.sent_row_attempt_reliable_mask.len() {
                self.sent_row_attempt_reliable_mask[r] = [0; DISPLAY_ACK_MASK_WORDS];
            }
            if r < self.sent_row_has_reliable_attempt.len() {
                self.sent_row_has_reliable_attempt[r] = false;
            }
            if r < self.sent_row_latest_direct_reliable_seq.len() {
                self.sent_row_latest_direct_reliable_seq[r] = 0;
            }
            if r < self.sent_row_latest_edge_reliable_seq.len() {
                self.sent_row_latest_edge_reliable_seq[r] = 0;
            }
            if r < self.sent_row_first_sent_at_ms.len() {
                self.sent_row_first_sent_at_ms[r] = f64::NEG_INFINITY;
            }
            if r < self.sent_row_reliable.len() {
                self.sent_row_reliable[r] = false;
            }
            if r < self.sent_row_latest_reliable.len() {
                self.sent_row_latest_reliable[r] = false;
            }
            if r < self.sent_row_resend_after_ms.len() {
                self.sent_row_resend_after_ms[r] = 0.0;
            }
            if let Some(word) = self.row_invalidation_mask.get_mut(r / u64::BITS as usize) {
                *word |= 1u64 << (r % u64::BITS as usize);
                disowned += 1;
            }
        }
        self.prune_marked_rows_from_sent_datagrams(disowned);
    }

    /// Drop every retained `SentDatagram`'s claim on the rows currently marked
    /// in `row_invalidation_mask`, then clear the mask. `marked` is how many
    /// bits the caller set, so a call that marked nothing costs neither the map
    /// walk nor the per-row bitmask test.
    ///
    /// A retained record naming a row is live evidence about that row:
    /// `advance_acked_rows_from_ack` walks it to credit cells and hashes, and
    /// the loss path walks it to re-send them. So any row whose baseline was
    /// just rewritten out from under those records — disowned by
    /// [`Self::invalidate_rows`], adopted by [`Self::adopt_peer_row`] — has to
    /// leave them too, or a later resolution of the stale record silently
    /// undoes the rewrite.
    fn prune_marked_rows_from_sent_datagrams(&mut self, marked: usize) {
        if marked > 0 && !self.sent_datagrams.is_empty() {
            let mask = &self.row_invalidation_mask;
            for sent in self.sent_datagrams.values_mut() {
                sent.rows.retain(|sent_row| {
                    let r = usize::from(sent_row.row);
                    mask.get(r / u64::BITS as usize)
                        .is_none_or(|word| word & (1u64 << (r % u64::BITS as usize)) == 0)
                });
            }
        }
        self.row_invalidation_mask.fill(0);
    }

    /// Disown every row whose newest send is still outstanding, and forget the
    /// in-flight datagram records that carried them.
    ///
    /// Called at a carrier boundary. No acknowledgement for these can ever
    /// arrive, and the reason is the browser rather than the network: its
    /// session-epoch fence clears `displayAckWindowByGeneration` on every
    /// authenticated session, so it will never again report a pre-rebind
    /// sequence as applied. The packet-threshold rule cannot resolve them
    /// either -- it needs three LATER sequences acknowledged above one, which
    /// that same cleared window guarantees will never happen. They are lost by
    /// evidence, not by deadline, and this is the one place that can say so.
    ///
    /// Without it a row stays recorded as sent-and-awaiting-ack forever, so
    /// `classify_flush_rows` skips it and the browser never sees the content
    /// that was in flight when the link broke — a permanently stale row on an
    /// otherwise healthy session.
    ///
    /// Deliberately the same `invalidate_rows` primitive a genuinely lost
    /// datagram takes in `advance_acked_rows_from_ack`, so a carrier break and
    /// a proven loss recover through one path rather than two.
    pub fn disown_outstanding_rows(&mut self) -> usize {
        let mut outstanding: Vec<u16> = Vec::new();
        for r in 0..usize::from(self.rows) {
            let sent_seq = match self.sent_row_latest_seq.get(r).copied() {
                Some(seq) if seq != 0 => seq,
                _ => continue,
            };
            let acked_seq = self.acked_row_seq.get(r).copied().unwrap_or(0);
            // Already acknowledged at this send or a newer one: nothing is in
            // flight for this row, so the carrier taking it down costs nothing.
            if acked_seq != 0
                && (acked_seq == sent_seq
                    || crate::display::recv::display_seq_is_older(sent_seq, acked_seq))
            {
                continue;
            }
            if let Ok(row) = u16::try_from(r) {
                outstanding.push(row);
            }
        }
        self.invalidate_rows(&outstanding);
        // `invalidate_rows` only prunes the disowned rows out of each record.
        // Every remaining record describes a send on the dead carrier too, so
        // the whole map is stale evidence and an ACK resolving any of it can no
        // longer arrive.
        self.retire_all_sent_datagrams_unknown();
        outstanding.len()
    }

    /// Adopt one row a returning peer proved it is already displaying.
    ///
    /// A resume claim naming a row's CURRENT hash is stronger evidence than any
    /// acknowledgement: the browser is describing the grid it has on screen,
    /// not a sequence it once received. That evidence is the only thing that can
    /// undo [`Self::disown_outstanding_rows`], which zeroes the acked hash of
    /// every row that was in flight when the carrier died — rows a repainting
    /// TUI holds by the screenful, and which would otherwise read as divergence
    /// and cost a full snapshot.
    ///
    /// The capture is what makes the adoption honest. Crediting
    /// `acked_row_hashes` alone would leave `acked_row_cells` holding the
    /// pre-outage version, and the next delta for this row would be diffed
    /// against cells the peer demonstrably no longer has. Installing the
    /// current capture on both baselines is exactly the per-row state
    /// [`Self::prime_from_snapshot`] establishes for the whole grid.
    ///
    /// Adoption must also leave the in-flight records, and nothing upstream
    /// guarantees they are already gone. A rebind reaches a resume through
    /// [`PeerDisplayState::carrier_boundary`], which disowns and retires
    /// everything; a full re-authentication reaches the very same resume
    /// through `splice_resumed_peer`, which arms the awaiting-resume gate with
    /// the cache — retained `sent_datagrams` included — untouched. A surviving
    /// pre-outage record still naming this row stays resolvable: after
    /// `LOSS_PACKET_THRESHOLD` applied successors the ACK path declares it lost
    /// and calls [`Self::invalidate_rows`], which would silently undo the
    /// adoption. So the row is pruned out of every retained record here, by the
    /// same primitive `invalidate_rows` prunes a disowned one with.
    ///
    /// [`Self::can_adopt_peer_row`] is the precondition, asserted rather than
    /// re-decided — the same contract [`Self::prime_from_snapshot`] has with
    /// its grid shape. The resume classifier answers it in the pass that
    /// decides between repair and snapshot, so the pass that credits has no
    /// second answer to branch on.
    pub fn adopt_peer_row(&mut self, captured: &crate::pty::CapturedRow) {
        debug_assert!(
            self.can_adopt_peer_row(captured),
            "adopt_peer_row requires can_adopt_peer_row"
        );
        let row = usize::from(captured.row);
        let semantic_baseline_changed = self
            .acked_row_cells
            .get(row)
            .is_none_or(|acked| !Arc::ptr_eq(acked, &captured.cells))
            || self.acked_row_graphics[row] != captured.graphics.version()
            || self.acked_row_exact.get(row).copied() != Some(true);
        let (Some(acked_cells), Some(sent_cells)) = (
            self.acked_row_cells.get_mut(row),
            self.sent_row_cells.get_mut(row),
        ) else {
            return;
        };
        *acked_cells = Arc::clone(&captured.cells);
        *sent_cells = Arc::clone(&captured.cells);
        self.acked_row_graphics[row] = captured.graphics.version();
        self.sent_row_graphics[row] = captured.graphics.version();
        // Nothing is outstanding for a row the peer already holds. This also
        // clears `sent_row_confirmed`, so it must run before the bits below.
        self.clear_current_sent_attempt(row);
        if let Some(slot) = self.acked_row_hashes.get_mut(row) {
            *slot = captured.hash;
        }
        // Seq-less and exact, like a snapshot-primed row: the proof is the
        // claim itself rather than a sequence either end can still resolve.
        if let Some(slot) = self.acked_row_seq.get_mut(row) {
            *slot = 0;
        }
        if let Some(slot) = self.acked_row_exact.get_mut(row) {
            *slot = true;
        }
        if let Some(slot) = self.acked_row_reliable.get_mut(row) {
            *slot = false;
        }
        if let Some(slot) = self.sent_row_hashes.get_mut(row) {
            *slot = captured.hash;
        }
        if let Some(slot) = self.sent_row_confirmed.get_mut(row) {
            *slot = true;
        }
        if let Some(slot) = self.sent_row_force_full_until_confirmed.get_mut(row) {
            *slot = false;
        }
        if let Some(slot) = self.sent_row_first_sent_at_ms.get_mut(row) {
            *slot = f64::NEG_INFINITY;
        }
        if semantic_baseline_changed && let Some(revision) = self.acked_row_revisions.get_mut(row) {
            *revision = revision.wrapping_add(1);
        }
        // The claim is now this row's baseline, so no retained record may still
        // speak for it.
        let mut marked = 0usize;
        if let Some(word) = self.row_invalidation_mask.get_mut(row / u64::BITS as usize) {
            *word |= 1u64 << (row % u64::BITS as usize);
            marked = 1;
        }
        self.prune_marked_rows_from_sent_datagrams(marked);
    }

    /// Whether [`Self::adopt_peer_row`] would accept this capture: it has to
    /// name a row this cache holds, at exactly this cache's width. Split out so
    /// a resume can classify a claimed row without mutating anything — the
    /// two-pass structure in `handle_display_resume` decides between repair and
    /// snapshot before it credits a single row.
    pub fn can_adopt_peer_row(&self, captured: &crate::pty::CapturedRow) -> bool {
        usize::from(captured.row) < usize::from(self.rows)
            && captured.cells.len() == usize::from(self.cols)
    }

    /// Arm the repair-completion marker over exactly the rows a resume will
    /// repair. An empty set completes immediately, which is the "nothing
    /// diverged" reconnect.
    pub fn begin_resume_repair(&mut self, repair_id: u32, rows: &[u16]) -> bool {
        self.repair_pending.clear();
        self.repair_pending.resize(usize::from(self.rows), false);
        self.repair_pending_rows = 0;
        self.repair_members.clear();
        self.repair_member_overflow = false;
        self.repair_id = repair_id;
        self.repair_armed = true;
        for &row in rows {
            let index = usize::from(row);
            if let Some(slot) = self.repair_pending.get_mut(index)
                && !*slot
            {
                *slot = true;
                self.repair_pending_rows += 1;
            }
        }
        if self.repair_pending_rows > MAX_RESUME_REPAIR_MEMBERS {
            self.abandon_resume_repair();
            return false;
        }
        true
    }

    /// Exact admitted membership for a complete repair. This deliberately does
    /// not consume the arming: only successful reliable marker admission may
    /// do that, so a refused carrier send can retry instead of losing the one
    /// message that opens the browser's presentation hold.
    pub fn completed_resume_repair(&self) -> Option<(u32, &[ResumeRepairMember])> {
        (self.repair_armed && self.repair_pending_rows == 0 && !self.repair_member_overflow)
            .then_some((self.repair_id, self.repair_members.as_slice()))
    }

    pub fn resume_repair_requires_snapshot(&self) -> bool {
        self.repair_armed && self.repair_pending_rows == 0 && self.repair_member_overflow
    }

    /// Retire a completed repair only after its exact-membership marker was
    /// admitted to a reliable carrier.
    pub fn finish_resume_repair_marker(&mut self) {
        debug_assert!(self.completed_resume_repair().is_some());
        self.repair_armed = false;
        self.repair_members.clear();
        self.repair_id = 0;
    }

    /// Abandon an outstanding repair without emitting its marker — a snapshot
    /// or generation rollover supersedes it.
    pub fn abandon_resume_repair(&mut self) {
        self.repair_armed = false;
        self.repair_pending_rows = 0;
        self.repair_pending.fill(false);
        self.repair_members.clear();
        self.repair_member_overflow = false;
        self.repair_id = 0;
    }

    /// Forget delivery attempts for the current sent content without
    /// discarding the receiver's last exact baseline. Used only when selective
    /// ACK evidence proves the newest unreliable attempt lost, or when that
    /// evidence has aged out of the bounded window.
    pub fn clear_current_sent_attempt(&mut self, row: usize) {
        if let Some(slot) = self.sent_row_seq.get_mut(row) {
            *slot = 0;
        }
        if let Some(slot) = self.sent_row_confirmed.get_mut(row) {
            *slot = false;
        }
        if let Some(slot) = self.sent_row_latest_seq.get_mut(row) {
            *slot = 0;
        }
        if let Some(slot) = self.sent_row_attempt_mask.get_mut(row) {
            *slot = [0; DISPLAY_ACK_MASK_WORDS];
        }
        if let Some(slot) = self.sent_row_attempt_direct_mask.get_mut(row) {
            *slot = [0; DISPLAY_ACK_MASK_WORDS];
        }
        if let Some(slot) = self.sent_row_attempt_edge_mask.get_mut(row) {
            *slot = [0; DISPLAY_ACK_MASK_WORDS];
        }
        if let Some(slot) = self.sent_row_attempt_reliable_mask.get_mut(row) {
            *slot = [0; DISPLAY_ACK_MASK_WORDS];
        }
        if let Some(slot) = self.sent_row_has_reliable_attempt.get_mut(row) {
            *slot = false;
        }
        if let Some(slot) = self.sent_row_latest_direct_reliable_seq.get_mut(row) {
            *slot = 0;
        }
        if let Some(slot) = self.sent_row_latest_edge_reliable_seq.get_mut(row) {
            *slot = 0;
        }
        if let Some(slot) = self.sent_row_reliable.get_mut(row) {
            *slot = false;
        }
        if let Some(slot) = self.sent_row_latest_reliable.get_mut(row) {
            *slot = false;
        }
        if let Some(slot) = self.sent_row_resend_after_ms.get_mut(row) {
            *slot = 0.0;
        }
    }

    /// Test-state builder for row-delivery cases that intentionally carry no
    /// transport provenance. Production sends must use
    /// [`Self::record_sent_rows_on_paths`].
    #[cfg(test)]
    pub fn record_sent_rows<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        now_ms: f64,
        resend_interval_ms: f64,
    ) {
        self.record_sent_rows_on_lane(
            seq,
            rows,
            now_ms,
            false,
            SentPaths::default(),
            resend_interval_ms,
        );
    }

    pub fn record_sent_rows_on_paths<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        now_ms: f64,
        sent_via: SentPaths,
        resend_interval_ms: f64,
    ) {
        self.record_sent_rows_on_lane(seq, rows, now_ms, false, sent_via, resend_interval_ms);
    }

    /// Test-state builder for reliable row-delivery cases that intentionally
    /// carry no transport provenance. Production sends must use
    /// [`Self::record_reliable_sent_rows_on_path`].
    #[cfg(test)]
    pub fn record_reliable_sent_rows<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        now_ms: f64,
        resend_interval_ms: f64,
    ) {
        self.record_sent_rows_on_lane(
            seq,
            rows,
            now_ms,
            true,
            SentPaths::default(),
            resend_interval_ms,
        );
    }

    pub fn record_reliable_sent_rows_on_path<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        now_ms: f64,
        sent_path: PeerTransport,
        resend_interval_ms: f64,
    ) {
        self.record_sent_rows_on_lane(
            seq,
            rows,
            now_ms,
            true,
            SentPaths::single(sent_path),
            resend_interval_ms,
        );
    }

    fn record_sent_rows_on_lane<'a>(
        &mut self,
        seq: u32,
        rows: impl IntoIterator<Item = &'a SentRow>,
        now_ms: f64,
        reliable: bool,
        sent_via: SentPaths,
        resend_interval_ms: f64,
    ) {
        let cols = usize::from(self.cols);
        let resend_after_ms = now_ms + resend_interval_ms;
        for sent in rows {
            let r = usize::from(sent.row);
            if r >= usize::from(self.rows) || sent.cells.len() != cols {
                continue;
            }
            if let Some(slot) = self.repair_pending.get_mut(r)
                && *slot
            {
                *slot = false;
                self.repair_pending_rows = self.repair_pending_rows.saturating_sub(1);
                if self.repair_members.len() < MAX_RESUME_REPAIR_MEMBERS {
                    self.repair_members.push(ResumeRepairMember {
                        row: sent.row,
                        minimum_seq: seq,
                    });
                } else {
                    self.repair_member_overflow = true;
                }
            }
            if let Some(slot) = self.sent_row_cells.get_mut(r) {
                *slot = Arc::clone(&sent.cells);
            } else {
                continue;
            }
            // Keep `sent_row_seq` pinned to the FIRST send of this content while
            // `sent_row_latest_seq` and the attempt masks track every resend.
            // That preserves the row version's initial provenance and lets a
            // selective ACK for any retained attempt confirm it; an identical
            // resend extends the attempt lineage rather than redefining the row
            // version. On a genuine content change we advance the seq as usual.
            let content_changed = self.sent_row_hashes.get(r).copied() != Some(sent.hash);
            self.sent_row_graphics[r] = sent.graphics;
            if r < self.sent_row_hashes.len() {
                self.sent_row_hashes[r] = sent.hash;
            }
            let starts_attempt_lineage =
                content_changed || self.sent_row_latest_seq.get(r).copied().unwrap_or(0) == 0;
            if content_changed {
                let supersedes_unconfirmed = self
                    .sent_row_confirmed
                    .get(r)
                    .is_some_and(|confirmed| !*confirmed);
                if let Some(slot) = self.sent_row_confirmed.get_mut(r) {
                    *slot = false;
                }
                if let Some(slot) = self.sent_row_force_full_until_confirmed.get_mut(r) {
                    *slot = supersedes_unconfirmed;
                }
                // `sent_row_seq[r]` still holds the seq of the version being
                // replaced, because it is only advanced below. Comparing it to
                // the browser's applied high-water is what separates a row
                // version the peer rendered from one it never saw. The
                // wrapping comparison matches the one that maintains the
                // high-water in `handle_display_ack`.
                self.waste.row_versions_sent += 1;
                let prior_seq = self.sent_row_seq.get(r).copied().unwrap_or(0);
                if prior_seq != 0 {
                    let applied = self.last_applied_ack_seq;
                    let seen = applied != 0
                        && (prior_seq == applied || applied.wrapping_sub(prior_seq) < 0x8000_0000);
                    if seen {
                        self.waste.row_versions_superseded_applied += 1;
                    } else {
                        self.waste.row_versions_superseded_unapplied += 1;
                    }
                }
                if let Some(slot) = self.sent_row_seq.get_mut(r) {
                    *slot = seq;
                }
                if let Some(slot) = self.sent_row_first_sent_at_ms.get_mut(r) {
                    *slot = now_ms;
                }
                if let Some(slot) = self.sent_row_reliable.get_mut(r) {
                    *slot = reliable;
                }
            } else {
                self.waste.row_resends_identical += 1;
            }
            if starts_attempt_lineage && !content_changed {
                if let Some(slot) = self.sent_row_seq.get_mut(r) {
                    *slot = seq;
                }
                if let Some(slot) = self.sent_row_reliable.get_mut(r) {
                    *slot = reliable;
                }
            }
            let previous_latest = self.sent_row_latest_seq.get(r).copied().unwrap_or(0);
            if let (
                Some(attempts),
                Some(direct_attempts),
                Some(edge_attempts),
                Some(reliable_attempts),
            ) = (
                self.sent_row_attempt_mask.get_mut(r),
                self.sent_row_attempt_direct_mask.get_mut(r),
                self.sent_row_attempt_edge_mask.get_mut(r),
                self.sent_row_attempt_reliable_mask.get_mut(r),
            ) {
                if starts_attempt_lineage {
                    *attempts = [0; DISPLAY_ACK_MASK_WORDS];
                    *direct_attempts = [0; DISPLAY_ACK_MASK_WORDS];
                    *edge_attempts = [0; DISPLAY_ACK_MASK_WORDS];
                    *reliable_attempts = [0; DISPLAY_ACK_MASK_WORDS];
                } else {
                    let distance = seq.wrapping_sub(previous_latest);
                    shift_display_attempt_mask(attempts, distance);
                    shift_display_attempt_mask(direct_attempts, distance);
                    shift_display_attempt_mask(edge_attempts, distance);
                    shift_display_attempt_mask(reliable_attempts, distance);
                }
                attempts[0] |= 1;
                if sent_via.webtransport {
                    direct_attempts[0] |= 1;
                }
                if sent_via.edge {
                    edge_attempts[0] |= 1;
                }
                if reliable {
                    reliable_attempts[0] |= 1;
                }
            }
            if let Some(slot) = self.sent_row_has_reliable_attempt.get_mut(r) {
                if starts_attempt_lineage {
                    *slot = reliable;
                } else {
                    *slot |= reliable;
                }
            }
            if starts_attempt_lineage {
                if let Some(slot) = self.sent_row_latest_direct_reliable_seq.get_mut(r) {
                    *slot = 0;
                }
                if let Some(slot) = self.sent_row_latest_edge_reliable_seq.get_mut(r) {
                    *slot = 0;
                }
            }
            if reliable
                && sent_via.webtransport
                && let Some(slot) = self.sent_row_latest_direct_reliable_seq.get_mut(r)
            {
                *slot = seq;
            }
            if let Some(slot) = self.sent_row_latest_edge_reliable_seq.get_mut(r)
                && reliable
                && sent_via.edge
            {
                *slot = seq;
            }
            if let Some(slot) = self.sent_row_latest_seq.get_mut(r) {
                *slot = seq;
            }
            if let Some(slot) = self.sent_row_latest_reliable.get_mut(r) {
                *slot = reliable;
            }
            // Set on EVERY send, including an identical re-send: the deadline
            // paces how often the same bytes may reoccupy the link.
            if let Some(slot) = self.sent_row_resend_after_ms.get_mut(r) {
                *slot = resend_after_ms;
            }
        }
    }

    pub fn insert_sent_datagram(&mut self, seq: u32, sent: SentDatagram) {
        self.oldest_sent_datagram_at_ms = self.oldest_sent_datagram_at_ms.min(sent.sent_at_ms);
        if let Some(replaced) = self.sent_datagrams.insert(seq, sent) {
            self.record_unknown_datagram(replaced);
        }
        while self.sent_datagrams.len() > DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES {
            // A sequence can wrap, and delayed completion/probes need not be
            // inserted in numeric order. Evict the oldest exposure (including
            // the repair admission timestamp of a reconstructible original);
            // serial order only breaks equal timestamps within this bounded
            // generation-local history (well below a half sequence range).
            let Some((&oldest_seq, _)) =
                self.sent_datagrams.iter().min_by(|(a_seq, a), (b_seq, b)| {
                    a.sent_at_ms.total_cmp(&b.sent_at_ms).then_with(|| {
                        if a_seq == b_seq {
                            std::cmp::Ordering::Equal
                        } else if a_seq.wrapping_sub(**b_seq) > 0x8000_0000 {
                            std::cmp::Ordering::Less
                        } else {
                            std::cmp::Ordering::Greater
                        }
                    })
                })
            else {
                break;
            };
            if let Some(evicted) = self.sent_datagrams.remove(&oldest_seq) {
                self.record_unknown_datagram(evicted);
            }
        }
    }

    pub(crate) fn record_datagram_outcome(
        &mut self,
        sent: &SentDatagram,
        outcome: DisplayDatagramOutcome,
    ) {
        Self::record_outcome_on_paths(
            &mut self.datagram_outcomes,
            &mut self.fec_evidence,
            sent,
            outcome,
        );
    }

    fn record_outcome_on_paths(
        datagram_outcomes: &mut DisplayDatagramOutcomes,
        fec_evidence: &mut FecEvidenceByPath,
        sent: &SentDatagram,
        outcome: DisplayDatagramOutcome,
    ) {
        if let Some(path) = sent.outcome_path() {
            let counters = datagram_outcomes.get_mut(path);
            match outcome {
                DisplayDatagramOutcome::Received => counters.received += 1,
                DisplayDatagramOutcome::Recovered => counters.recovered_by_fec += 1,
                DisplayDatagramOutcome::Lost => counters.declared_lost += 1,
                DisplayDatagramOutcome::Unknown => counters.outcome_unknown += 1,
            }
        }
        if let Some(path) = sent.evidence_path() {
            fec_evidence.get_mut(path).observe(sent.protection, outcome);
        }
    }

    /// Retire delivery attempts owned exclusively by one displaced carrier.
    ///
    /// Attempts that also rode the other path remain capable of producing valid
    /// delivery evidence and stay in the current display generation. Sole-path
    /// attempts can never be acknowledged once routing replaces their carrier,
    /// so their records become Unknown and rows with no surviving attempt are
    /// immediately selectable. The receiver's last exact baseline is retained.
    fn retire_path_attempts(&mut self, retired_path: PeerTransport) -> (usize, bool) {
        let row_count = self
            .sent_row_attempt_mask
            .len()
            .min(self.sent_row_attempt_direct_mask.len())
            .min(self.sent_row_attempt_edge_mask.len())
            .min(self.sent_row_attempt_reliable_mask.len())
            .min(self.sent_row_latest_direct_reliable_seq.len())
            .min(self.sent_row_latest_edge_reliable_seq.len());
        let mut requeued = 0usize;

        for row in 0..row_count {
            if self.sent_row_confirmed.get(row).copied().unwrap_or(false) {
                continue;
            }
            let has_attempt = self.sent_row_latest_seq.get(row).copied().unwrap_or(0) != 0
                || self.sent_row_attempt_mask[row]
                    .iter()
                    .any(|word| *word != 0)
                || self
                    .sent_row_has_reliable_attempt
                    .get(row)
                    .copied()
                    .unwrap_or(false);
            if !has_attempt {
                continue;
            }

            let (mut surviving, surviving_reliable_seq) = match retired_path {
                PeerTransport::WebTransport => (
                    self.sent_row_attempt_edge_mask[row],
                    self.sent_row_latest_edge_reliable_seq[row],
                ),
                PeerTransport::Edge => (
                    self.sent_row_attempt_direct_mask[row],
                    self.sent_row_latest_direct_reliable_seq[row],
                ),
            };
            let mut reliable = self.sent_row_attempt_reliable_mask[row];
            for word in 0..DISPLAY_ACK_MASK_WORDS {
                reliable[word] &= surviving[word];
            }
            match retired_path {
                PeerTransport::WebTransport => {
                    self.sent_row_latest_direct_reliable_seq[row] = 0;
                }
                PeerTransport::Edge => {
                    self.sent_row_latest_edge_reliable_seq[row] = 0;
                }
            }

            if surviving.iter().all(|word| *word == 0) {
                if surviving_reliable_seq == 0 {
                    self.clear_current_sent_attempt(row);
                    if let Some(slot) = self.sent_row_force_full_until_confirmed.get_mut(row) {
                        *slot = true;
                    }
                    requeued += 1;
                    continue;
                }
                // The reliable record aged out of the bounded datagram map, but
                // its surviving stream still guarantees delivery. Recreate the one
                // attempt needed to keep that durable evidence authoritative.
                surviving[0] = 1;
                reliable[0] = 1;
                self.sent_row_latest_seq[row] = surviving_reliable_seq;
            } else {
                let newest_offset = newest_display_attempt_offset(&surviving)
                    .expect("non-empty surviving display-attempt mask");
                self.sent_row_latest_seq[row] =
                    self.sent_row_latest_seq[row].wrapping_sub(newest_offset);
                discard_newer_display_attempts(&mut surviving, newest_offset);
                discard_newer_display_attempts(&mut reliable, newest_offset);
            }

            self.sent_row_attempt_mask[row] = surviving;
            match retired_path {
                PeerTransport::WebTransport => {
                    self.sent_row_attempt_direct_mask[row] = [0; DISPLAY_ACK_MASK_WORDS];
                    self.sent_row_attempt_edge_mask[row] = surviving;
                }
                PeerTransport::Edge => {
                    self.sent_row_attempt_direct_mask[row] = surviving;
                    self.sent_row_attempt_edge_mask[row] = [0; DISPLAY_ACK_MASK_WORDS];
                }
            }
            self.sent_row_attempt_reliable_mask[row] = reliable;
            self.sent_row_latest_reliable[row] = reliable[0] & 1 != 0;
            self.sent_row_has_reliable_attempt[row] = self.sent_row_latest_direct_reliable_seq[row]
                != 0
                || self.sent_row_latest_edge_reliable_seq[row] != 0
                || reliable.iter().any(|word| *word != 0);

            let oldest_offset = oldest_display_attempt_offset(&surviving)
                .expect("surviving display-attempt mask remains non-empty");
            self.sent_row_seq[row] = self.sent_row_latest_seq[row].wrapping_sub(oldest_offset);
            self.sent_row_reliable[row] =
                reliable[(oldest_offset >> 5) as usize] & (1u32 << (oldest_offset & 31)) != 0;
        }

        let mut sole_path_unknown = 0u64;
        let mut header_retired = false;
        self.sent_datagrams.retain(|_, sent| {
            let (rode_retired, rode_survivor) = match retired_path {
                PeerTransport::WebTransport => (sent.sent_via.webtransport, sent.sent_via.edge),
                PeerTransport::Edge => (sent.sent_via.edge, sent.sent_via.webtransport),
            };
            if !rode_retired || rode_survivor {
                return true;
            }
            if sent.outcome_path() == Some(retired_path) {
                sole_path_unknown += 1;
            }
            if sent.header_only {
                header_retired = true;
            }
            false
        });
        self.datagram_outcomes.get_mut(retired_path).outcome_unknown += sole_path_unknown;
        self.fec_evidence.reset(retired_path);
        (requeued, header_retired)
    }

    /// Drop every expired record in one bounded, allocation-free traversal.
    /// Numeric sequence order is neither age order across wrap nor admission
    /// order after delayed completion/replacement. A fresh numeric front must
    /// never strand expired records behind it.
    pub fn prune_expired_sent_datagrams(&mut self, now_ms: f64) {
        if now_ms - self.oldest_sent_datagram_at_ms <= DisplayPolicy::SENT_DATAGRAM_PRUNE_AGE_MS {
            return;
        }
        let outcomes = &mut self.datagram_outcomes;
        let evidence = &mut self.fec_evidence;
        let mut oldest = f64::INFINITY;
        for (_, expired) in self.sent_datagrams.extract_if(.., |_, sent| {
            let expired = now_ms - sent.sent_at_ms > DisplayPolicy::SENT_DATAGRAM_PRUNE_AGE_MS;
            if !expired {
                oldest = oldest.min(sent.sent_at_ms);
            }
            expired
        }) {
            Self::record_outcome_on_paths(
                outcomes,
                evidence,
                &expired,
                DisplayDatagramOutcome::Unknown,
            );
        }
        self.oldest_sent_datagram_at_ms = oldest;
    }

    fn record_unknown_datagram(&mut self, sent: SentDatagram) {
        self.record_datagram_outcome(&sent, DisplayDatagramOutcome::Unknown);
    }

    fn retire_all_sent_datagrams_unknown(&mut self) {
        let retired = std::mem::take(&mut self.sent_datagrams);
        self.oldest_sent_datagram_at_ms = f64::INFINITY;
        for sent in retired.values() {
            // Preserve protection provenance. In particular, an unresolved
            // rowless k=1 probe must break the clean-probe streak rather than
            // being relabelled as an ordinary unknown datagram.
            self.record_datagram_outcome(sent, DisplayDatagramOutcome::Unknown);
        }
    }

    /// Earliest pending re-send deadline, so the flush scheduler can sleep
    /// exactly until there is something new to put on the wire.
    pub fn next_row_resend_due_ms(&self, now_ms: f64) -> Option<f64> {
        let row_count = self
            .sent_row_hashes
            .len()
            .min(self.acked_row_hashes.len())
            .min(self.acked_row_exact.len())
            .min(self.sent_row_confirmed.len())
            .min(self.sent_row_latest_seq.len())
            .min(self.sent_row_has_reliable_attempt.len())
            .min(self.sent_row_resend_after_ms.len());
        let mut next: Option<f64> = None;
        for row in 0..row_count {
            let latest = self.sent_row_latest_seq[row];
            let due = self.sent_row_resend_after_ms[row];
            if !self.sent_row_confirmed[row]
                && latest != 0
                && !self.sent_row_has_reliable_attempt[row]
                && due > now_ms
            {
                next = Some(next.map_or(due, |current| current.min(due)));
            }
        }
        next
    }

    /// The row's newest admitted datagram send is unconfirmed past its measured
    /// re-send deadline, or selective ACK evidence retired its attempts. It
    /// repairs a screen state already admitted against a browser grant, so it
    /// needs no new grant
    /// (`display::credit`); a row that merely changed does.
    #[inline]
    pub(crate) fn row_repair_due(&self, row: usize, now_ms: f64) -> bool {
        (self.sent_row_latest_seq
            .get(row)
            .is_some_and(|&latest| latest != 0)
            // clear_current_sent_attempt preserves the admitted content's
            // first-send stamp and clears its deadline to zero. Invalidation
            // and snapshots clear that stamp, so never-sent work gets no credit.
            || self.sent_row_first_sent_at_ms
                .get(row)
                .is_some_and(|at| at.is_finite()))
            && self.sent_row_confirmed.get(row) == Some(&false)
            && self.sent_row_has_reliable_attempt.get(row) == Some(&false)
            && self
                .sent_row_resend_after_ms
                .get(row)
                .is_some_and(|&due| due <= now_ms)
    }

    /// Whether `classify_flush_rows` would select `row` at `now_ms`.
    pub(crate) fn row_selectable(&self, row: usize, current_row_hashes: &[u64], now_ms: f64) -> bool {
        let (
            Some(&current),
            Some(&acked),
            Some(&acked_exact),
            Some(&sent),
            Some(&confirmed),
            Some(&latest),
            Some(&reliable),
            Some(&resend_after),
        ) = (
            current_row_hashes.get(row),
            self.acked_row_hashes.get(row),
            self.acked_row_exact.get(row),
            self.sent_row_hashes.get(row),
            self.sent_row_confirmed.get(row),
            self.sent_row_latest_seq.get(row),
            self.sent_row_has_reliable_attempt.get(row),
            self.sent_row_resend_after_ms.get(row),
        )
        else {
            return false;
        };
        display_row_is_selectable(
            current,
            acked,
            acked_exact,
            sent,
            confirmed,
            latest,
            reliable,
            resend_after,
            now_ms,
        )
    }

    /// Any row [`Self::row_repair_due`] would admit at `now_ms`.
    pub(crate) fn has_repair_due_rows(&self, now_ms: f64) -> bool {
        (0..self.sent_row_latest_seq.len()).any(|row| self.row_repair_due(row, now_ms))
    }

    /// Any unconfirmed row that is allowed on the wire RIGHT NOW.
    ///
    /// This, not `has_unacked_rows`, is what `needs_full_diff` is re-derived
    /// from after a flush and after an ACK. On a high-RTT path almost every
    /// row is unconfirmed almost all the time, so re-arming on "unconfirmed"
    /// alone free-runs the flush loop: it wakes, finds every row paced, emits a
    /// header-only delta, and immediately rearms. "Unconfirmed AND past its
    /// re-send deadline" is the same deadline test `display_row_is_selectable`
    /// carries into scheduling, so the loop sleeps until there is genuinely
    /// something to send.
    pub fn has_sendable_rows(&self, now_ms: f64) -> bool {
        let row_count = self
            .sent_row_hashes
            .len()
            .min(self.acked_row_hashes.len())
            .min(self.acked_row_exact.len())
            .min(self.sent_row_confirmed.len())
            .min(self.sent_row_latest_seq.len())
            .min(self.sent_row_has_reliable_attempt.len())
            .min(self.sent_row_resend_after_ms.len());
        (0..row_count).any(|row| {
            let latest = self.sent_row_latest_seq[row];
            !self.sent_row_confirmed[row]
                && (latest == 0
                    || (!self.sent_row_has_reliable_attempt[row]
                        && self.sent_row_resend_after_ms[row] <= now_ms))
        })
    }

    /// Any row `classify_flush_rows` would select at `now_ms`.
    ///
    /// One fused pass over the five per-row arrays selection reads, through
    /// the same predicate, short-circuiting on the first hit. This is the
    /// scheduler's runnable term: it answers "would a flush right now put a
    /// row on the wire" with exactly the rule the flush applies, so the two
    /// cannot disagree. The pair it replaced could: `has_sendable_rows` missed
    /// a row whose in-flight version differs from the terminal's (A → B → A),
    /// and comparing the acknowledged baseline against the terminal woke the
    /// loop for a paced duplicate the flush was about to skip.
    ///
    /// It is a level, not an edge, and that matters for the remainder of a
    /// clipped flush: `terminal.has_dirty()` is consumed by the flush that
    /// clipped it, and the rows it did not send were never sent at all, so
    /// nothing else can bring them back.
    pub fn has_selectable_rows(&self, current_row_hashes: &[u64], now_ms: f64) -> bool {
        let row_count = current_row_hashes
            .len()
            .min(self.acked_row_hashes.len())
            .min(self.acked_row_exact.len())
            .min(self.sent_row_hashes.len())
            .min(self.sent_row_confirmed.len())
            .min(self.sent_row_latest_seq.len())
            .min(self.sent_row_has_reliable_attempt.len())
            .min(self.sent_row_resend_after_ms.len());
        (0..row_count).any(|row| {
            display_row_is_selectable(
                current_row_hashes[row],
                self.acked_row_hashes[row],
                self.acked_row_exact[row],
                self.sent_row_hashes[row],
                self.sent_row_confirmed[row],
                self.sent_row_latest_seq[row],
                self.sent_row_has_reliable_attempt[row],
                self.sent_row_resend_after_ms[row],
                now_ms,
            )
        })
    }

    /// Classify selectable cached rows without allocating or walking past the
    /// first proof that this is coherent work.
    pub(crate) fn selectable_row_shape(
        &self,
        current_row_hashes: &[u64],
        now_ms: f64,
        cursor_row: Option<u16>,
    ) -> SelectableRowShape {
        let row_count = current_row_hashes
            .len()
            .min(self.acked_row_hashes.len())
            .min(self.acked_row_exact.len())
            .min(self.sent_row_hashes.len())
            .min(self.sent_row_confirmed.len())
            .min(self.sent_row_latest_seq.len())
            .min(self.sent_row_has_reliable_attempt.len())
            .min(self.sent_row_resend_after_ms.len());
        let mut shape = SelectableRowShape::None;
        for (row, &current_row_hash) in current_row_hashes.iter().take(row_count).enumerate() {
            if !display_row_is_selectable(
                current_row_hash,
                self.acked_row_hashes[row],
                self.acked_row_exact[row],
                self.sent_row_hashes[row],
                self.sent_row_confirmed[row],
                self.sent_row_latest_seq[row],
                self.sent_row_has_reliable_attempt[row],
                self.sent_row_resend_after_ms[row],
                now_ms,
            ) {
                continue;
            }
            if shape != SelectableRowShape::None || cursor_row != Some(row as u16) {
                return SelectableRowShape::Multiple;
            }
            shape = SelectableRowShape::CursorOnly;
        }
        shape
    }

    /// Any row whose newest send the peer has not confirmed, whether or not it
    /// is allowed on the wire yet.
    ///
    /// The level that separates "quiet" from "parked" for the tests and the
    /// simulator: an unconfirmed row keeps a re-send deadline armed, so a peer
    /// holding one is still scheduled even when nothing is selectable now. The
    /// scheduler reads that deadline through `next_row_resend_due_ms` rather
    /// than this flag — a row past its deadline is selectable, one inside it
    /// is exactly the deadline the loop sleeps until — which is what closed
    /// the hole where a just-flushed peer, every sent row unconfirmed and
    /// paced, fell out of scheduling entirely and a lost datagram stranded its
    /// row until the digest backstop.
    #[cfg(test)]
    pub fn has_unacked_rows(&self) -> bool {
        self.sent_row_confirmed.iter().any(|confirmed| !*confirmed)
    }

    /// Hard reset before re-priming via snapshot (forced-snapshot path).
    pub fn reset_for_snapshot(&mut self) {
        self.acked_row_graphics.fill(None);
        self.sent_row_graphics.fill(None);
        self.retire_all_sent_datagrams_unknown();
        self.initialized = false;
        for revision in &mut self.acked_row_revisions {
            *revision = revision.wrapping_add(1);
        }
        for hash in &mut self.acked_row_hashes {
            *hash = 0;
        }
        self.acked_row_seq.fill(0);
        self.acked_row_exact.fill(false);
        self.acked_row_reliable.fill(false);
        self.last_applied_ack_seq = 0;
        self.applied_carrier_evidence = AppliedCarrierEvidence::default();
        self.sent_row_hashes.fill(0);
        self.sent_row_confirmed.fill(false);
        self.sent_row_force_full_until_confirmed.fill(false);
        self.sent_row_seq.fill(0);
        self.sent_row_latest_seq.fill(0);
        self.sent_row_attempt_mask.fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_direct_mask
            .fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_edge_mask
            .fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_attempt_reliable_mask
            .fill([0; DISPLAY_ACK_MASK_WORDS]);
        self.sent_row_has_reliable_attempt.fill(false);
        self.sent_row_latest_direct_reliable_seq.fill(0);
        self.sent_row_latest_edge_reliable_seq.fill(0);
        self.sent_row_first_sent_at_ms.fill(f64::NEG_INFINITY);
        self.sent_row_reliable.fill(false);
        self.sent_row_latest_reliable.fill(false);
        self.sent_row_resend_after_ms.fill(0.0);
    }
}

/// The owner loop's live peers, keyed by the identity each peer carries in
/// `PeerDisplayState::peer_id`. The key and the field are the same `Arc<str>`
/// (an insert clones the field), so every id that leaves this map — into the
/// flush cursor, the parked set, a send, a lifecycle event — is a refcount
/// bump rather than a fresh `String`. Lookups take `&str` through `Borrow`.
pub(crate) type PeerMap = std::collections::HashMap<Arc<str>, PeerDisplayState>;

/// Ciphertext that overtook Noise message 3 belongs to that exact responder.
/// Empty at setup (no allocation); discarded with failed/replaced handshakes.
/// Two maximum ingress records and 128 small records bound both byte and owner
/// retention while the existing handshake deadline bounds time.
pub struct PendingNoiseHandshake {
    pub handshake: crate::e2e::NoiseHandshake,
    pub frames: VecDeque<crate::network::peer::PeerMessage>,
    retained_bytes: usize,
}

impl PendingNoiseHandshake {
    pub fn new(handshake: crate::e2e::NoiseHandshake) -> Self {
        Self {
            handshake,
            frames: VecDeque::new(),
            retained_bytes: 0,
        }
    }

    pub fn retain(&mut self, msg: &mut crate::network::peer::PeerMessage) -> bool {
        if self.frames.len() >= 128
            || msg.payload.len()
                > 2 * crate::network::peer::MAX_INBOUND_FRAME_BYTES - self.retained_bytes
        {
            return false;
        }
        self.retained_bytes += msg.payload.len();
        self.frames.push_back(crate::network::peer::PeerMessage {
            input_permit: msg.input_permit.take(),
            peer_node_id: Arc::clone(&msg.peer_node_id),
            channel_id: msg.channel_id,
            payload: std::mem::take(&mut msg.payload),
            via_transport: msg.via_transport,
            delivery: msg.delivery,
            connection_id: msg.connection_id,
            edge_ingress: msg.edge_ingress.clone(),
        });
        true
    }
}

pub struct PeerDisplayState {
    pub peer_id: Arc<str>,
    /// Latest viewport intent, retained through carrier rebind; fresh auth resets it.
    /// Reliable streams on different carriers do not share delivery order.
    pub last_resize_seq: u32,
    pub(crate) geometry_reply: Option<Box<crate::geometry::Reply>>,
    pub authenticated: bool,
    pub(crate) pending_identity_signature:
        Option<Box<crate::session::auth_flow::PendingIdentitySignature>>,
    /// Whether this browser's terminal worker currently holds the compression
    /// dictionary. False until the terminal epoch signals readiness, and
    /// cleared again when a replacement worker takes over, so the daemon never
    /// compresses against bytes the peer no longer has.
    pub display_dictionary_ready: bool,
    /// Compression-dictionary lifecycle for this peer.
    pub dictionary: crate::display::compressor::PeerDictionaryState,
    /// Anchor generation last delivered to this peer, so an unchanged prompt
    /// costs nothing.
    pub last_editor_anchor_generation: u32,
    /// The input-routing word a paused synchronized drain last sent, and the
    /// carrier it rode. Sending it unsets `last_admitted_critical_header_signal`,
    /// so it describes the browser only while that stays zero; it is retired
    /// wherever that is zeroed for any other reason.
    pub(crate) input_routing_sent: Option<(u16, PeerTransport)>,
    /// Serial of the newest input-routing word sent to this peer, zero before
    /// the first. Words sent while no frame leaves share a display position, and
    /// can cross on different carriers; the browser orders them by this.
    pub(crate) input_routing_serial: u32,
    /// `(table generation, newest id)` of the link definitions last delivered
    /// to this peer. `None` means the peer must receive the whole live table:
    /// before its first delivery, after a snapshot is scheduled, and when a
    /// new Noise session makes anything still in flight on the old one
    /// unopenable.
    pub link_table_sent: Option<(u64, u32)>,
    /// Newest `merkur open` request id sent to this peer, 0 for none. Cleared
    /// with a new Noise session, whose predecessor may have lost what it sealed.
    pub open_url_sent: u32,
    pub terminal_title_sent: Option<u64>,
    pub terminal_ui_sent: Option<u64>,

    pub generation: u32,
    pub next_datagram_seq: u32,
    /// Highest seq actually sent as an UNRELIABLE datagram this generation.
    /// Tracked separately from `next_datagram_seq` because reliable-routed
    /// frames consume seqs from the same counter but are guaranteed delivery on
    /// CHANNEL_DISPLAY_COMMIT, so they were never at risk.
    pub last_datagram_seq: u32,
    /// Highest `input_seq` advertised to this peer on any admitted frame,
    /// header-only included: the browser's causal barrier release.
    pub last_advertised_input_seq: u32,
    /// Highest `input_seq` advertised with an admitted, changed cursor row.
    /// Header-only coverage, background rows and retransmitted pre-input rows
    /// must not consume the cursor-feedback exemption before the echo is read.
    /// This is scheduling evidence, not proof of PTY output causality.
    pub(crate) last_row_advertised_input_seq: u32,
    /// Explicit application sync-update completion captured by the newest
    /// original transform actually admitted for this peer. It is a local
    /// scheduling watermark only, never a browser/protocol correctness fence.
    pub(crate) last_admitted_sync_epoch: u64,
    /// Presentation-only predecessor of a later cursor/header. Row coverage
    /// retains every unresolved ancestor, not merely the immediate head.
    pub(crate) row_presentation_head: u32,
    pub(crate) unresolved_presentation_rows: [u64; 4],
    pub(crate) presentation_row_coverage_overflow: bool,
    /// Highest PTY input sequence from this peer the kernel has confirmed.
    ///
    /// This is the authoritative counterpart to `last_advertised_input_seq`:
    /// the writer advances it on every confirmed completion, and each display
    /// frame advertises it so the browser can release its causal prediction
    /// barrier. It lives on the peer rather than in a parallel peer-id map
    /// because its lifetime is exactly this struct's — parking carries it with
    /// the display cache, and dropping the peer drops it. The write site
    /// already holds `&mut PeerDisplayState`, so keeping it here removes a
    /// `String` allocation and a hash per confirmed keystroke, plus three hash
    /// lookups per display flush.
    pub latest_input_seq: u32,
    /// Terminal revision when that input write was confirmed. A prepared row
    /// from this revision or earlier cannot be its later PTY feedback.
    pub(crate) latest_input_display_revision: u64,
    /// The newest input of this peer queued for the PTY when the terminal last
    /// applied PTY output. Output applied then was read before any later input
    /// was queued, so no grid captured before the next application can show a
    /// program's answer to a later input. Every captured header carries it as
    /// `FrameHeader::echo_horizon`; unlike `latest_input_seq`, which a PTY
    /// write completion advances before the program has read the input.
    pub(crate) echo_horizon: u32,
    /// Highest seq exposed through an admitted original or reconstructing
    /// FEC repair this generation, across BOTH lanes. The display
    /// hash-digest heartbeat advertises this — not `next_datagram_seq - 1` —
    /// because a failed send without reconstructing repair cannot reach the client;
    /// advertising it wedges the client's digest gate (`upToSeq > maxApplied`
    /// forever), disabling the divergence backstop exactly when a loss just
    /// happened.
    pub last_display_seq_sent: u32,
    pub next_frame_id: u32,
    /// Last cursor/mode header admitted on a Critical or guaranteed-reliable
    /// cursor frame. Zero is the unsent sentinel (terminal dimensions make a
    /// real packed header signal non-zero).
    pub last_admitted_critical_header_signal: u128,
    /// A coherent non-END original was admitted and still needs a coherent
    /// END, even if subsequent terminal damage collapses to an unchanged grid.
    /// Pure obligation, no clock: it used to be a deadline that also carried a
    /// sender priority window, and the window existed only to waive coalescing
    /// and rate floors that no longer exist.
    pub(crate) presentation_end_owed: bool,
    /// Backoff after actual zero-progress carrier admission, distinct from the
    /// RTT-derived display rate estimate. Fresh causal/header feedback can
    /// attempt a smaller frame once without inheriting a failed bulk deadline.
    pub(crate) display_admission_retry: DisplayAdmissionRetry,
    /// Browser display grants for this generation: the only admission of a new
    /// screen state (`display::credit`).
    pub(crate) display_credit: crate::display::credit::DisplayCredit,
    /// Which carriers only probes can leave, and whether each already holds
    /// the one frame it takes while blocked.
    pub(crate) carrier_blocks: CarrierBlocks,

    pub needs_snapshot: bool,
    pub needs_full_diff: bool,
    pub backpressure_score: u32,
    /// How long this peer actually takes to confirm a display datagram.
    pub display_confirm: DisplayConfirmDelay,
    pub last_compression_ratio: f64,
    pub(crate) display_planning: crate::display::planner::PeerDisplayPlanningModel,
    pub last_wire_bytes: usize,

    pub last_input_at_ms: f64,
    /// The input ack this peer is owed by the end of the current owner-loop
    /// turn, newest-wins. Queued by a PTY write completion or a marked
    /// retransmission and taken by the flush at the bottom of the same turn, so
    /// it is `None` between turns. Living on the peer means a queue is one
    /// store — no id clone, no hash, no map — and a flush is one `take`.
    pub pending_input_ack: Option<PendingInputAck>,
    /// Holds packet construction on the carrier this turn's input ACK answers, the edge
    /// tunnel or the direct session, until the display flush has admitted the peer's
    /// header-only or echo frame, so the ACK, its reliable twin and that frame share a
    /// packet. Taken by `send_input_ack`, released by the flush before any work that is not
    /// that frame, and at the end of the turn in any case: `None` between turns.
    pub(crate) egress_hold: Option<wtransport::quinn::EgressHold>,
    pub(crate) reliable_inputs: crate::input::ReliableInputs,

    pub adaptive: AdaptiveTransportState,
    /// The current carrier has returned at least one authenticated display ACK.
    pub has_receiver_ack: bool,
    pub display_cache: PerPeerDisplayCache,
    /// Reused by selective display ACK processing to move covered immutable
    /// send snapshots out of `display_cache.sent_datagrams` before applying
    /// them. Keeping this beside (rather than inside) the cache lets the ACK
    /// loop mutably borrow the cache, path health, and flow controller while
    /// `drain(..)` retains this allocation for the next ACK.
    pub(crate) display_ack_drain_scratch: Vec<(u32, SentDatagram)>,
    /// Ciphertext-only pool. A buffer can be reused only after every physical
    /// carrier/replica drops its immutable owner; session retirement never
    /// invalidates bytes a displaced carrier still holds.
    pub(crate) datagram_wire_pool: crate::display::wire::WirePool,
    /// Sender-assigned physical-datagram identities consumed by the simulator.
    /// Production carries no parallel hot-path counters; the deterministic
    /// harness owns the exact role/path accounting it needs.
    #[cfg(test)]
    pub(crate) sim_datagram_metadata: VecDeque<SimDatagramMetadata>,
    #[cfg(test)]
    pub(crate) sim_datagram_attempts: HashMap<(u32, u64, u8, u8, u8), u32>,
    #[cfg(test)]
    pub(crate) sim_data_ordinals: HashMap<(u32, u32), u64>,
    #[cfg(test)]
    pub(crate) sim_next_data_ordinal: u64,
    #[cfg(test)]
    pub(crate) sim_next_probe_ordinal: u64,

    /// Per-transport liveness + RTT. The path-selection function reads this
    /// and returns one selected carrier or the two best carriers per flush;
    /// all carriers can stay armed simultaneously, with the rest as hot
    /// standbys.
    pub paths: PeerPaths,

    /// Previous-interval readings for the periodic telemetry emitter.
    ///
    /// Lives on the peer so it is pruned for free when the peer is removed —
    /// a side map keyed by peer id would need its own lifetime management and
    /// could outlive the thing it describes. Only the 10-second emitter reads or
    /// writes it; nothing on a send or receive path touches it.
    pub(crate) telemetry_cursor: crate::telemetry::PeerTelemetryCursor,

    /// Generation-tagged CPU preparation currently owned by the bounded
    /// display worker. While present, no second delta is prepared for this
    /// peer; terminal revisions that arrive meanwhile are reconciled when the
    /// completion returns.
    pub(crate) display_prepare_in_flight: Option<u64>,
    /// Lock-free cancellation epoch shared with off-owner display preparation.
    /// It is allocated once per authenticated peer; queued work clones only
    /// the Arc and can reject itself before compression after a carrier/session
    /// boundary, without an owner-thread channel hop.
    pub(crate) display_prepare_epoch: Arc<AtomicU64>,
    // Authentication state is completed atomically by the one-response hybrid
    // exchange. Only the watchdog deadline remains live until Noise completes.
    pub auth_timeout_at_ms: Option<f64>,
    pub signal_session_id: String,
    /// Native-only profiling owner; stale tokens fail closed after reauth/reset.
    pub(crate) perf_trace_token: Option<crate::perf_trace::TraceToken>,
    /// Root-certified browser delegation that authorized this hybrid session.
    pub delegation_id: String,
    /// Independently derived direct-WebTransport proof key for this exact
    /// hybrid session. Never parked or reused across a replacement carrier.
    pub upgrade_secret: Option<[u8; 32]>,
    /// The proven source address of the browser's committed signaling carrier,
    /// as the edge validated it on that QUIC connection: the address this
    /// peer's direct-path manifests are built for and their punches aimed at.
    /// `None` until the edge has reported one for the committed carrier, and
    /// no manifest is sent before it is known.
    pub browser_address: Option<std::net::IpAddr>,
    /// Orders this peer's manifests; a punch outcome names the one it belongs
    /// to. Incremented by every manifest, never reset within a peer.
    pub manifest_generation: u64,

    /// While `Some(deadline)`, the auto-snapshot sender
    /// is suppressed until either (a) the deadline passes (snapshot fires as
    /// safety net) or (b) the client's `MSG_TYPE_DISPLAY_RESUME` arrives and
    /// the resume handler clears it (delta-replay served instead). Set on
    /// token-resumed reconnect when the prior display cache is usable.
    pub awaiting_resume_until_ms: Option<f64>,
    /// A committed Noise successor has not delivered any authenticated DATA.
    /// Its resume budget cannot run merely because signaling or HELLO arrived.
    pub resume_waiting_for_data: bool,

    // Snapshot retry back-off — gates snapshot sends so a failing
    // peer doesn't busy-loop on the flush timer until heartbeat eviction.
    pub snapshot_retry_at_ms: f64,
    pub snapshot_consecutive_failures: u32,

    // Keystroke reorder buffer (for datagram input)
    /// Next sequence not yet accepted by the bounded PTY FIFO. This may run
    /// ahead of `keystroke_next_expected_seq`, which advances only after the
    /// writer confirms complete PTY delivery.
    pub keystroke_next_queued_seq: u32,
    pub keystroke_next_expected_seq: u32,
    pub keystroke_reorder_buf: std::collections::BTreeMap<u32, (Vec<u8>, bool)>,
    pub keystroke_reorder_bytes: usize,

    /// Noise_XXpsk3 responder handshake, alive only between the `session_auth`
    /// / `session_rebind` that carries message 1 and the completing
    /// `noise_final` for this connection. Cleared on completion (transport
    /// installed) and on every fresh connect / resume so no key material is
    /// ever reused across sessions.
    pub noise_handshake: Option<PendingNoiseHandshake>,
    /// Established E2E transport. `Some` exactly when the handshake finished;
    /// terminal channels are gated until then and every terminal frame is
    /// sealed/opened through this transport.
    pub noise: Option<crate::e2e::NoiseTransport>,
    pub(crate) graphics_requests: Option<Box<crate::assets::Requests>>,

    /// The direct WebTransport session the upgrade proof admitted, with its
    /// reliable-lane senders, installed with that admission and dropped where
    /// the direct carrier retires. Every direct send admits here, and the owner
    /// reads its delivery view (display quotes, datagram budget) and opens
    /// graphics streams on it, all without the registry's lock; a closed
    /// session is no carrier, as a registry without it would be.
    pub direct_session: Option<crate::webtransport::DirectSession>,

    /// Interactive data tunnel, linked only after its post-Noise nonce rendezvous.
    /// The network registry owns the durable connection independently of this
    /// browser-generation binding. Signaling never uses either data pointer.
    pub edge_tunnel: Option<Arc<crate::edge_tunnel::EdgeTunnel>>,
    /// Bulk-only edge tunnel (session id `<session>#bulk`), dedicated to
    /// reliable display frames (snapshots, jumbo, and loss-recovery commits). It
    /// rides its OWN WebTransport connection to the edge so a reliable-recovery
    /// burst can never head-of-line-block the interactive datagram lane on
    /// `edge_tunnel`. `None` until the bulk rendezvous completes (opportunistic: the
    /// interactive tunnel remains a reliable fallback if it never comes up). Like
    /// `edge_tunnel`, the binding is reset on a Noise cut; the durable connection survives.
    pub edge_tunnel_bulk: Option<Arc<crate::edge_tunnel::EdgeTunnel>>,
    /// Set true once the browser has CONFIRMED it received an inbound frame on
    /// bulk (the `<session>#bulk` connection) — reported via a `data_received`
    /// signaling message. `edge_tunnel_bulk.is_some()` only proves the daemon
    /// matched the attachment; it does NOT prove the daemon->browser direction
    /// delivers (some Safari builds link bulk but never receive on it). Until confirmed,
    /// reliable display rides interactive (`edge_tunnel`) — see `reliable_edge_tunnel`.
    /// Reset whenever `edge_tunnel_bulk` is re-linked or on a network change.
    pub bulk_delivery_confirmed: bool,
    /// Nonces claimed on signaling after the current Noise generation commits.
    /// Index 0 is interactive, index 1 is bulk; neither can authorize signaling.
    pub data_attachment_nonces: [Option<DataHandshakeGeneration>; 2],
    /// An authenticated attachment is waiting for its interactive data rendezvous.
    /// No data path has failed yet. The signaling owner's retirement or a
    /// matching data HELLO ends this state; elapsed time is not evidence of loss.
    pub data_rendezvous_pending: bool,

    /// Carrier-rebind chaining state.
    ///
    /// Deliberately NOT part of `clear_hybrid_secret_material`. Every other
    /// derived secret on this peer is bound to one carrier and must die with
    /// it; this one is the single output that has to survive a carrier gap so
    /// the browser can re-authenticate without the application server. Packing
    /// opposite lifetimes into one clear path is exactly how the wrong secret
    /// gets wiped, so this has its own field and its own
    /// [`Self::clear_rebind_material`].
    pub rebind: Option<RebindState>,
    /// Armed while this peer's browser is gone but its edge tunnel is being
    /// held for a rebind. It deliberately coexists with the incumbent Noise
    /// session (and possibly its last-known direct-path state) until a complete
    /// successor handshake commits. The liveness sweep must preserve that
    /// transactional recovery state rather than mistake it for a dead peer.
    pub edge_rebind: Option<EdgeRebindWindow>,
}

#[derive(Default)]
pub(crate) struct DisplayAdmissionRetry {
    pub(crate) until_ms: f64,
    pub(crate) failures: u32,
    pub(crate) input_seq: u32,
    pub(crate) header_signal: u128,
}

/// Display admission read from each carrier's exact capacity state.
///
/// A carrier is blocked while only probes may leave it: on the edge, either
/// hop, the daemon's own connection or the browser leg the edge quotes. A
/// blocked carrier takes one frame, which leaves when it reopens; the frames
/// after it coalesce in the display cache and go out once the acknowledgment
/// that reopens it arrives. A probe timeout alone changes nothing here: rows
/// on a carrier that stopped acknowledging move only through the display ACK
/// and repair machinery. Indexed direct, then edge.
///
/// Both bits belong to the connection they were read from. A replaced carrier
/// starts with neither: its successor may start open, and an open connection
/// never fires the reopening that would re-read a stale record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CarrierBlocks {
    blocked: [bool; 2],
    holding: [bool; 2],
}

impl CarrierBlocks {
    fn index(carrier: PeerTransport) -> usize {
        usize::from(carrier == PeerTransport::Edge)
    }

    /// Record `carrier`'s current state. Reopening releases its frame.
    pub(crate) fn observe(&mut self, carrier: PeerTransport, blocked: bool) {
        let index = Self::index(carrier);
        self.blocked[index] = blocked;
        self.holding[index] &= blocked;
    }

    pub(crate) fn is_blocked(&self, carrier: PeerTransport) -> bool {
        self.blocked[Self::index(carrier)]
    }

    /// Blocked and already holding its frame: it takes no more display.
    pub(crate) fn is_closed(&self, carrier: PeerTransport) -> bool {
        let index = Self::index(carrier);
        self.blocked[index] && self.holding[index]
    }

    /// `carrier` accepted display; while blocked, that was its one frame.
    pub(crate) fn admitted(&mut self, carrier: PeerTransport) {
        let index = Self::index(carrier);
        self.holding[index] |= self.blocked[index];
    }

    /// A new connection now serves `carrier`: it holds nothing yet, and its
    /// state is its own to read.
    pub(crate) fn replaced(&mut self, carrier: PeerTransport) {
        let index = Self::index(carrier);
        self.blocked[index] = false;
        self.holding[index] = false;
    }
}

/// Per-peer rebind lineage: the chaining secret, its generation, and the
/// attempt currently in flight.
pub struct RebindState {
    /// `RS_n`. Consumed by exactly one successful rebind, which derives its
    /// successor.
    pub secret: [u8; 64],
    /// Generation `n`. A request must name exactly this: a lower counter is a
    /// stale replay, a higher one a forgery.
    pub counter: u64,
    /// Ties every generation back to the ML-DSA-signed genesis exchange.
    pub lineage_digest: [u8; 64],
    /// Monotonic time of the genesis authentication, so the lineage can be
    /// aged out independently of any single carrier gap.
    pub genesis_at_ms: f64,
    pub authorization: crate::session::authorization_epoch::AuthorizationEpoch,
    /// The attempt awaiting its Noise handshake, if any.
    pub in_flight: Option<InFlightRebind>,
    /// One authenticated refusal awaiting a signaling lane; never unbounded history.
    pub pending_refusal: Option<Vec<u8>>,
}

/// One rebind attempt between a verified request and the handshake that
/// commits it.
pub struct InFlightRebind {
    pub(crate) candidate: Option<std::sync::Weak<crate::edge_candidate::CandidateReply>>,
    /// Identifies this exact attempt, so an exact retransmission (the
    /// lost-response case) is answered from the stored values instead of
    /// running a second ML-KEM exchange.
    pub request_digest: [u8; 64],
    pub daemon_nonce: [u8; 32],
    pub ciphertext: Box<[u8; 1568]>,
    /// Input resync point bound into the response transcript and successor KDF.
    /// The incumbent can finish PTY writes while this attempt is pending, so a
    /// replay must retain this value instead of sampling the live input state.
    pub next_expected_input_seq: u32,
    /// Successor secrets, derived at request time and installed only when the
    /// successor Noise handshake completes.
    pub successor: crate::e2e::SessionSecrets,
    /// Noise message 2, produced once and re-emitted verbatim on every repeat.
    ///
    /// The browser re-sends flight 1 verbatim when the edge announces the
    /// daemon attached, so the answer must be a pure function of stored state.
    /// A responder draws a fresh ephemeral on every build, so recomputing this
    /// would hand the browser a message 2 the retained responder cannot finish
    /// — failing the handshake on exactly the lossy path rebind exists to
    /// remove. `a_repeated_flight_is_answered_identically` pins it.
    pub noise_msg2: Vec<u8>,
    pub issued_at_ms: f64,
    /// The serialized `session_rebound` answer, held because there was no
    /// signaling lane to put it on.
    ///
    /// The failure this closes is a race, not a refusal: the request arrives
    /// over the edge, the daemon verifies it and derives the whole answer, and
    /// then `edge_interactive` has no entry for the peer because the old lane was
    /// removed and its replacement has not registered yet. The answer was
    /// simply dropped, and the browser — which reads silence as a refusal by
    /// design — spent its four one-second attempts and fell back to full
    /// re-authentication.
    ///
    /// Not secret. Every field in it (`daemon_nonce`, the ML-KEM ciphertext,
    /// the MAC) is what would have gone on the wire in the clear, and the
    /// ciphertext is encapsulated to the browser's one-use key, so holding it
    /// is worth nothing to anyone else. `RS_n` stays where it is and is still
    /// spent only by a completed successor handshake.
    pub pending_response: Option<Vec<u8>>,
}

/// The window during which a departed browser may still rebind in place.
#[derive(Clone, Copy, Debug)]
pub struct EdgeRebindWindow {
    /// Monotonic deadline. Set one heartbeat tick inside the edge's own
    /// half-paired expiry so the daemon gives up first and the slot empties
    /// cleanly, rather than racing the edge's prune.
    pub deadline_ms: f64,
    /// Rebinds already spent on this lineage.
    pub rebinds_used: u64,
}

impl Drop for RebindState {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

impl PeerDisplayState {
    /// Zeroize every root-derived per-session byte owner before replacing,
    /// parking, or dropping this peer. `Option::take` alone would only forget
    /// the stack bytes and is not a secret-destruction boundary.
    pub fn clear_hybrid_secret_material(&mut self) {
        self.pending_identity_signature = None;
        self.clear_noise_bootstrap_material();
        if let Some(mut secret) = self.upgrade_secret.take() {
            secret.zeroize();
        }
    }

    /// Destroy the rebind lineage.
    ///
    /// Separate from [`Self::clear_hybrid_secret_material`] on purpose: the two
    /// have opposite lifetimes, and entering a rebind window wipes the hybrid
    /// material while deliberately keeping this.
    pub fn clear_rebind_material(&mut self) {
        // `RebindState`'s Drop zeroizes the secret; taking the in-flight
        // successor first makes its own Drop run here rather than whenever the
        // peer happens to be dropped.
        if let Some(mut state) = self.rebind.take() {
            state.in_flight = None;
        }
        self.edge_rebind = None;
        self.data_rendezvous_pending = false;
    }

    /// True while this peer is holding its edge tunnel open for a browser that
    /// may still come back.
    pub fn is_rebinding(&self) -> bool {
        self.edge_rebind.is_some()
    }

    pub fn begin_resume_receive_budget(&mut self, now_ms: f64, via: PeerTransport) {
        if !self.resume_waiting_for_data {
            return;
        }
        self.resume_waiting_for_data = false;
        if self.awaiting_resume_until_ms.is_some() {
            let path = self.paths.get(via);
            self.awaiting_resume_until_ms = Some(
                now_ms
                    + crate::session::policy::SessionPolicy::awaiting_resume_timeout_ms(
                        path.rtt_ewma_ms,
                        path.jitter_ewma_ms,
                    ),
            );
        }
    }

    /// Whether anything this peer encodes can reach a browser.
    ///
    /// Availability alone is not the answer for the edge. A carrier-gap window
    /// is armed exactly when the daemon has concluded the browser left the
    /// splice and is holding the session for its return, and cleared exactly
    /// when it returns (`splice_rebound_peer`) or the sweep parks the peer —
    /// and while it is armed a background redial re-attaches and installs
    /// `PathHealth::fresh_available`, so the path reads available again with
    /// the splice's browser half still empty. Frames sealed into it are
    /// unopenable anyway: a rebind runs a fresh Noise handshake.
    ///
    /// The window is an EDGE-scoped statement, so it disqualifies only the edge
    /// path. A peer whose interactive edge lane closed while a direct
    /// WebTransport carrier is live has one armed regardless — the arming site
    /// does not consult `classify_counterpart_detach` — and that peer's browser
    /// is right there on the direct path.
    ///
    /// This is a scheduling term, not a send-path one: `flush_display` already
    /// accounts for a send no transport accepted. What it cannot do is decline
    /// to have been called, and being called at display cadence for a peer with
    /// no counterpart is a full screen diffed, compressed, sealed and dropped
    /// every flush interval for the length of the gap window.
    pub fn has_display_counterpart(&self) -> bool {
        self.paths.webtransport.available || (self.paths.edge.available && !self.is_rebinding())
    }

    /// The admitted direct session while it is open. A retired one closes as
    /// the registry drops it, so a closed session is exactly a registry
    /// without one. Lock-free: no registry lock, no connection-state lock.
    pub(crate) fn open_direct_session(&self) -> Option<&Arc<wtransport::Connection>> {
        self.direct_session
            .as_ref()
            .and_then(crate::webtransport::DirectSession::connection)
            .filter(|session| !session.is_closed())
    }

    /// Retire any predecessor handshake before a fresh one is installed.
    ///
    /// The peer no longer parks a PSK or a prologue digest between flights: the
    /// handshake is built in the same flight that derives them, so the material
    /// goes straight into Wasm-owned state and never has a peer-level copy to
    /// clear. Keeping one would have been a second place for key material to
    /// live for no reason.
    pub fn clear_noise_bootstrap_material(&mut self) {
        self.noise_handshake = None;
    }

    /// Path the daemon would currently pick as primary for a latency-sensitive
    /// send. Used by callers that need a single transport identity for logging
    /// or framing decisions (heartbeats, snapshots, etc.) where the choice is
    /// "best currently-live path".
    pub fn primary_path(&self, now_ms: f64) -> PeerTransport {
        self.paths.primary_for_latency(
            now_ms,
            crate::session::policy::SessionPolicy::PATH_STALE_THRESHOLD_MS,
        )
    }

    pub fn new(peer_id: Arc<str>, initial_transport: PeerTransport) -> Self {
        // Path health is initialized with `last_ack_at_ms = 0.0` so the
        // first heartbeat round-trip seeds the EWMA without prematurely
        // marking the path stale. We use 0.0 (instead of `now_ms`) because
        // PeerDisplayState::new is called from contexts that don't always
        // have a wallclock reference; the first ACK fills it.
        let paths = PeerPaths::new(initial_transport, 0.0);
        Self {
            peer_id,
            last_resize_seq: 0,
            geometry_reply: None,
            authenticated: false,
            pending_identity_signature: None,
            display_dictionary_ready: false,
            dictionary: crate::display::compressor::PeerDictionaryState::default(),
            last_editor_anchor_generation: 0,
            input_routing_sent: None,
            input_routing_serial: 0,
            link_table_sent: None,
            open_url_sent: 0,
            terminal_title_sent: None,
            terminal_ui_sent: None,
            generation: 1,
            next_datagram_seq: 1,
            last_datagram_seq: 0,
            last_advertised_input_seq: 0,
            last_row_advertised_input_seq: 0,
            last_admitted_sync_epoch: 0,
            row_presentation_head: 0,
            unresolved_presentation_rows: [0; 4],
            presentation_row_coverage_overflow: false,
            latest_input_seq: 0,
            latest_input_display_revision: 0,
            echo_horizon: 0,
            last_display_seq_sent: 0,
            next_frame_id: 1,
            last_admitted_critical_header_signal: 0,
            presentation_end_owed: false,
            display_admission_retry: DisplayAdmissionRetry::default(),
            display_credit: crate::display::credit::DisplayCredit::new(1),
            carrier_blocks: CarrierBlocks::default(),
            needs_snapshot: true,
            needs_full_diff: false,
            backpressure_score: 0,
            display_confirm: DisplayConfirmDelay::new(),
            last_compression_ratio: 1.0,
            display_planning: crate::display::planner::PeerDisplayPlanningModel::default(),
            last_wire_bytes: 0,
            last_input_at_ms: 0.0,
            pending_input_ack: None,
            egress_hold: None,
            reliable_inputs: crate::input::ReliableInputs::new(),
            adaptive: AdaptiveTransportState::default(),
            telemetry_cursor: crate::telemetry::PeerTelemetryCursor::default(),
            has_receiver_ack: false,
            display_cache: PerPeerDisplayCache::new(),
            display_ack_drain_scratch: Vec::new(),
            datagram_wire_pool: crate::display::wire::WirePool::default(),
            #[cfg(test)]
            sim_datagram_metadata: VecDeque::new(),
            #[cfg(test)]
            sim_datagram_attempts: HashMap::new(),
            #[cfg(test)]
            sim_data_ordinals: HashMap::new(),
            #[cfg(test)]
            sim_next_data_ordinal: 0,
            #[cfg(test)]
            sim_next_probe_ordinal: 0,
            paths,
            display_prepare_in_flight: None,
            display_prepare_epoch: Arc::new(AtomicU64::new(1)),
            auth_timeout_at_ms: None,
            signal_session_id: String::new(),
            perf_trace_token: None,
            delegation_id: String::new(),
            upgrade_secret: None,
            awaiting_resume_until_ms: None,
            resume_waiting_for_data: false,
            snapshot_retry_at_ms: 0.0,
            snapshot_consecutive_failures: 0,
            keystroke_next_queued_seq: 1,
            keystroke_next_expected_seq: 1,
            keystroke_reorder_buf: std::collections::BTreeMap::new(),
            keystroke_reorder_bytes: 0,
            browser_address: None,
            manifest_generation: 0,
            noise_handshake: None,
            noise: None,
            graphics_requests: None,
            direct_session: None,
            edge_tunnel: None,
            edge_tunnel_bulk: None,
            bulk_delivery_confirmed: false,
            data_attachment_nonces: [None; 2],
            data_rendezvous_pending: false,
            rebind: None,
            edge_rebind: None,
        }
    }

    /// Edge tunnel that reliable display frames (snapshots, jumbo, loss-recovery
    /// commits) should ride. Prefers the dedicated bulk connection (conn2) ONLY
    /// once the browser has confirmed conn2 delivers inbound
    /// (`bulk_delivery_confirmed`); otherwise falls back to the interactive
    /// connection (conn1, `edge_tunnel`),
    /// whose reliable uni-streams are proven to deliver even where conn2 does not
    /// (e.g. Safari over the edge relay). Reliable NEVER falls back to the lossy
    /// datagram lane — that routing choice lives in `classify_flush_rows`.
    /// Only open, paired tunnels are eligible; `None` means neither can deliver.
    pub fn reliable_edge_tunnel(&self) -> Option<Arc<crate::edge_tunnel::EdgeTunnel>> {
        let bulk = if self.bulk_delivery_confirmed {
            self.edge_tunnel_bulk
                .as_ref()
                .filter(|tunnel| tunnel.has_reliable_counterpart())
                .cloned()
        } else {
            None
        };
        let interactive = self
            .edge_tunnel
            .as_ref()
            .filter(|tunnel| tunnel.has_reliable_counterpart());
        match (bulk, interactive) {
            // A bulk tunnel only probes can leave yields its new transfers to
            // an interactive tunnel that can still send them.
            (Some(bulk), Some(interactive))
                if bulk.send_blocked() && !interactive.send_blocked() =>
            {
                Some(Arc::clone(interactive))
            }
            (bulk, interactive) => bulk.or_else(|| interactive.cloned()),
        }
    }

    /// True once the Noise handshake has completed and an E2E transport is
    /// installed. Terminal channels (PTY/CTRL/DISPLAY_*) are gated on this:
    /// inbound terminal frames are dropped and outbound seals return `None`
    /// until E2E is ready.
    pub fn is_e2e_ready(&self) -> bool {
        self.noise.is_some()
    }

    /// Seal a plaintext terminal frame for the reliable-stream sub-lane of
    /// `channel_id`. Returns `None` when E2E is not yet established or the
    /// channel owns no Noise lane (e.g. signaling) — callers must never emit
    /// unsealed terminal data, so a `None` result drops the send.
    pub fn seal_stream(&mut self, channel_id: u8, plaintext: &[u8]) -> Option<Vec<u8>> {
        let lane = crate::e2e::lane_for_channel(channel_id)?;
        let transport = self.noise.as_mut()?;
        transport.seal_stream(lane, plaintext).ok()
    }

    /// Seal a plaintext terminal frame for the datagram sub-lane of
    /// `channel_id`. Same gating contract as [`seal_stream`]; the datagram
    /// lane carries its own explicit counter in the framed output. Production
    /// seals datagrams into pooled wire owners (`seal_control_wire`,
    /// `seal_display_wire`); tests read the bare sealed frame through this.
    #[cfg(test)]
    pub fn seal_datagram(&mut self, channel_id: u8, plaintext: &[u8]) -> Option<Vec<u8>> {
        let lane = crate::e2e::lane_for_channel(channel_id)?;
        let transport = self.noise.as_mut()?;
        transport.seal_datagram(lane, plaintext).ok()
    }

    /// Seal a datagram directly into its final channel-framed wire bytes,
    /// `[channel_id || counter || ciphertext]`, inside the caller's reusable
    /// `wire` buffer. Returns the wire length; the sealed frame is
    /// `wire[..len]`. Display datagrams pass that one slice to every selected
    /// carrier, so a Redundant race borrows identical bytes without a second
    /// allocation.
    ///
    /// `wire` is grown to its high-water length and never truncated. Truncating
    /// to the exact frame would force the next call to `resize` back up and
    /// zero-fill bytes the AEAD immediately overwrites; keeping the length lets
    /// a steady display burst seal every datagram with no allocation and no
    /// memset. Callers must slice by the returned length rather than by
    /// `wire.len()`.
    #[cfg(test)]
    pub fn seal_datagram_wire_into(
        &mut self,
        wire: &mut Vec<u8>,
        channel_id: u8,
        plaintext: &[u8],
    ) -> Option<usize> {
        let lane = crate::e2e::lane_for_channel(channel_id)?;
        let transport = self.noise.as_mut()?;
        let required = 1 + plaintext.len() + crate::e2e::FRAME_OVERHEAD;
        if wire.len() < required {
            wire.resize(required, 0);
        }
        wire[0] = channel_id;
        let sealed_len = transport
            .seal_into(lane, true, plaintext, &mut wire[1..])
            .ok()?;
        Some(1 + sealed_len)
    }

    /// Seal once into an owner that can be queued on either carrier without
    /// copying. HTTP/3 prefixes are carrier-local metadata, not part of this
    /// shared `[channel || counter || ciphertext]` allocation.
    pub(crate) fn seal_display_wire(&mut self, plaintext: &[u8]) -> Option<bytes::Bytes> {
        self.seal_datagram_owned(
            crate::network::protocol::CHANNEL_DISPLAY_DATAGRAM,
            plaintext,
        )
    }

    /// [`Self::seal_display_wire`] for a control datagram on `channel_id`: an
    /// input-ACK twin, a pong, a heartbeat. Same pool, so a warm send allocates
    /// nothing and no carrier copies the bytes into its envelope.
    pub(crate) fn seal_control_wire(
        &mut self,
        channel_id: u8,
        plaintext: &[u8],
    ) -> Option<bytes::Bytes> {
        self.seal_datagram_owned(channel_id, plaintext)
    }

    fn seal_datagram_owned(&mut self, channel_id: u8, plaintext: &[u8]) -> Option<bytes::Bytes> {
        let lane = crate::e2e::lane_for_channel(channel_id)?;
        let transport = self.noise.as_mut()?;
        let required = 1 + plaintext.len() + crate::e2e::FRAME_OVERHEAD;
        let mut wire = self.datagram_wire_pool.take(required);
        wire[0] = channel_id;
        let len = transport
            .seal_into(lane, true, plaintext, &mut wire[1..])
            .ok()?;
        debug_assert_eq!(len + 1, required);
        let mut wire = wire.freeze();
        self.datagram_wire_pool.recycle(wire.clone());
        wire.truncate(required);
        Some(wire)
    }

    /// Seal a plaintext terminal frame for the reliable-stream sub-lane of
    /// `channel_id` into the caller's buffer, returning the sealed length. Same
    /// gating contract as [`seal_stream`]; `out` must hold at least
    /// `plaintext.len() + FRAME_OVERHEAD` bytes. This is how a fixed-size
    /// control record — the input ack — is sealed into a stack array without
    /// an allocation per send.
    pub fn seal_stream_into(
        &mut self,
        channel_id: u8,
        plaintext: &[u8],
        out: &mut [u8],
    ) -> Option<usize> {
        let lane = crate::e2e::lane_for_channel(channel_id)?;
        let transport = self.noise.as_mut()?;
        transport.seal_into(lane, false, plaintext, out).ok()
    }

    /// Allocating form of [`seal_datagram_wire_into`], retained for the
    /// archived wire-ownership benchmark arms that measure one allocation per
    /// frame. Production seals through the reusable buffer.
    #[cfg(test)]
    pub fn seal_datagram_wire(&mut self, channel_id: u8, plaintext: &[u8]) -> Option<Vec<u8>> {
        let mut wire = Vec::new();
        let sealed_len = self.seal_datagram_wire_into(&mut wire, channel_id, plaintext)?;
        wire.truncate(sealed_len);
        Some(wire)
    }

    /// Open an inbound terminal frame on `channel_id`, picking the Noise nonce
    /// sub-lane from `delivery` (stream vs datagram) so it matches the lane the
    /// sender sealed under. Returns `Err(OpenReject::Replay)` for a benign
    /// duplicate/reorder rejected by the per-lane window and `Err(OpenReject::Auth)`
    /// for a genuine failure (not E2E ready, no lane for the channel, malformed
    /// framing, or a tag mismatch) — the caller drops the frame in every `Err`
    /// case (no plaintext terminal data is ever accepted), but distinguishing
    /// the two keeps the inbound log quiet for routine multi-path dedup.
    /// Open one inbound terminal frame into `out`, returning the plaintext
    /// length; the frame is `out[..len]`.
    ///
    /// The plaintext is borrowed rather than owned because it never outlives
    /// the dispatch that consumes it. That removes the whole ownership dance an
    /// owned result required — the buffer handoff, its refcount traffic, and
    /// the message rebind that cloned the peer id and edge identity — and it
    /// lets `out` stay initialized at its high-water length, so a steady frame
    /// pays neither an allocation nor a zero-fill. `out` therefore grows and is
    /// never truncated; callers must slice by the returned length.
    #[inline]
    pub fn open_terminal_into(
        &mut self,
        channel_id: u8,
        delivery: crate::network::peer::DeliveryMode,
        ciphertext: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<usize, crate::e2e::OpenReject> {
        let Some(lane) = crate::e2e::lane_for_channel(channel_id) else {
            return Err(crate::e2e::OpenReject::Auth);
        };
        let Some(transport) = self.noise.as_mut() else {
            return Err(crate::e2e::OpenReject::Auth);
        };
        // `open_into` writes at most `ciphertext.len() - 8` bytes.
        let capacity = ciphertext.len().saturating_sub(8);
        if out.len() < capacity {
            out.resize(capacity, 0);
        }
        let datagram = matches!(delivery, crate::network::peer::DeliveryMode::Datagram);
        transport.open_into(lane, datagram, ciphertext, &mut out[..capacity])
    }

    pub fn next_datagram_seq(&mut self) -> u32 {
        // seq 0 is the "never sent / never acked" sentinel across the display
        // cache (sent_row_seq, acked_row_seq, ACK handling). Skip it on
        // wrap exactly like `next_frame_id`/`next_generation`, or a datagram
        // that happened to ride seq 0 would read as "never sent" forever.
        let seq = self.next_datagram_seq;
        self.next_datagram_seq = self.next_datagram_seq.wrapping_add(1);
        if self.next_datagram_seq == 0 {
            self.next_datagram_seq = 1;
        }
        seq
    }

    pub fn next_frame_id(&mut self) -> u32 {
        let id = self.next_frame_id;
        self.next_frame_id = self.next_frame_id.wrapping_add(1);
        if self.next_frame_id == 0 {
            self.next_frame_id = 1;
        }
        if id == 0 { self.next_frame_id() } else { id }
    }

    /// Record a deliverable display sequence (either lane, including an
    /// original made reconstructible by admitted FEC) for digest/ACK validity.
    /// Wrapping-aware so late exposure cannot move the mark backwards.
    pub fn note_display_seq_sent(&mut self, seq: u32) {
        let current = self.last_display_seq_sent;
        if current == 0 || (seq != current && seq.wrapping_sub(current) < 0x8000_0000) {
            self.last_display_seq_sent = seq;
        }
    }

    /// Retire the state that belonged to a carrier that just vanished, without
    /// opening a new display generation.
    ///
    /// The deliberate counterpart to `next_generation`, and the difference is
    /// the whole reason a carrier rebind can be cheap. A generation boundary
    /// says "forget the screen and start again"; a carrier boundary says "the
    /// same screen, over a different pipe". The browser's terminal worker, its
    /// grid, its row hashes, its FEC decoder and its compression dictionary all
    /// survive the swap, and its resume claim still names the generation it
    /// last applied — so bumping the generation here would make that claim
    /// unmatchable and force a full snapshot on every single reconnect. It did,
    /// for 27 of 31 measured reconnects.
    ///
    /// What is emphatically NOT reset, and why:
    ///
    /// - `generation`, so `handle_display_resume` can still match the browser's
    ///   claim and answer it with per-row repairs.
    /// - `next_datagram_seq`, `last_datagram_seq`, `last_display_seq_sent` and
    ///   `next_frame_id`. These are the sequence space the retained generation
    ///   names, and they must stay monotonic across the swap: restarting them
    ///   inside a live generation would read on the browser as a flood of
    ///   duplicate and wildly reordered frames. Keeping them monotonic is also
    ///   what makes an FEC group safe across the boundary — a repair is pinned
    ///   by `batch_start_seq`, which is now unique for the life of the session
    ///   rather than only within a generation.
    /// - The display cache baseline, which is the record of what the browser
    ///   actually has on screen. It is the input to the resume comparison.
    ///
    /// The compression dictionary now survives too, and the reasoning is worth
    /// stating because it used to be reset here.
    ///
    /// The browser's epoch fence keeps its dictionaries exactly when it
    /// preserves its display, and it publishes row hashes in its resume claim
    /// exactly when it preserves its display. So the daemon's repair path —
    /// which is reachable ONLY from a claim carrying row hashes — implies the
    /// peer still holds the dictionary. The unsafe direction, daemon keeps
    /// while browser discarded, is therefore unreachable: every snapshot
    /// decision calls `discard_dictionary_for_snapshot`, and nothing is sent
    /// while `awaiting_resume_until_ms` is armed, so there is no window in
    /// which the daemon could compress against bytes the peer threw away.
    ///
    /// The frame header's dictionary id remains the backstop. It is stamped on
    /// every compressed frame and both decoders reject a mismatch outright, so
    /// a divergence is refused rather than decoded into plausible garbage —
    /// which is why re-stating the id on the readiness signal would be
    /// redundant wire state rather than a second guarantee.
    /// Retire the dictionary because this peer is about to be repainted whole.
    ///
    /// The counterpart to keeping it across a carrier boundary. A snapshot means
    /// the browser's display did not survive — its epoch fence discarded the
    /// grid, and with it the dictionary slots — so ours describes bytes the peer
    /// no longer has. `next_id` deliberately survives, so the replacement
    /// carries an id the browser has never seen and a stale frame cannot be
    /// mistaken for a fresh one.
    pub fn discard_dictionary_for_snapshot(&mut self) {
        self.display_dictionary_ready = false;
        self.dictionary.reset();
    }

    /// Retire display work owned exclusively by one displaced carrier. Attempts
    /// that also rode the other path stay valid; sole-path rows and header state
    /// become immediately sendable on the survivor.
    pub fn retire_display_attempts(&mut self, path: PeerTransport) -> (usize, bool) {
        let (requeued_rows, header_retired) = self.display_cache.retire_path_attempts(path);
        if header_retired {
            self.last_admitted_critical_header_signal = 0;
        }
        if header_retired
            || self
                .input_routing_sent
                .is_some_and(|(_, routed)| routed == path)
        {
            self.input_routing_sent = None;
        }
        if requeued_rows > 0 || header_retired {
            // The displaced carrier's states may never arrive, so the browser
            // can hold a full window of grants for them while their rows wait.
            self.display_credit.bootstrap(self.generation);
            self.needs_full_diff = true;
        }
        (requeued_rows, header_retired)
    }

    /// Forget loss evidence when the physical carrier for `path` ends or is
    /// replaced. Display generation and resize are deliberately not carrier
    /// boundaries and must not call this.
    pub(crate) fn reset_fec_evidence(&mut self, path: PeerTransport) {
        self.display_cache.fec_evidence.reset(path);
    }

    pub fn carrier_boundary(&mut self) -> usize {
        // A CPU preparation completion is delivered only to the carrier that
        // requested it; the reply can never arrive now.
        self.cancel_display_prepare();
        self.display_admission_retry = DisplayAdmissionRetry::default();
        // Receiver-ack proof is a property of the carrier, not the generation:
        // the new one has not yet demonstrated it can deliver anything.
        self.has_receiver_ack = false;
        // Re-admit the critical header once on the new carrier. The browser
        // kept its own copy, so this costs one small frame and removes any
        // question of a header change that was in flight at the break. A
        // routing word in flight on the old carrier is resent on the same terms.
        self.last_admitted_critical_header_signal = 0;
        self.input_routing_sent = None;
        // Readiness is per-carrier and edge-triggered: the browser re-signals it
        // once its replacement terminal-worker lineage is live. The dictionary
        // itself is NOT dropped — see the note above — so a rebind that ends in
        // row repairs keeps compressing against a dictionary both ends still
        // hold, instead of paying a readiness/install/ack round trip and cold
        // compression on exactly the frames the user is waiting for.
        self.display_dictionary_ready = false;
        // Carrier delivery/loss evidence is attachment-scoped. A successor can
        // share the display generation and the edge's daemon-facing QUIC half,
        // but it does not share the browser-facing congestion/loss epoch (and
        // direct WebTransport is an entirely new connection). Start both
        // planner carriers cold; the next fenced quote repopulates them.
        self.display_planning.reset_carrier_observations(0);
        self.display_planning.reset_carrier_observations(1);
        // A repair set armed against the dead carrier can never complete: the
        // rows it is waiting on were in flight on it.
        self.display_cache.abandon_resume_repair();
        // Each carrier's blocked state and held frame were read from a dead
        // connection; the successors report their own.
        self.carrier_blocks = CarrierBlocks::default();
        // States in flight on the dead carrier never reach the browser, which
        // still counts their grants as outstanding.
        self.display_credit.bootstrap(self.generation);
        self.display_cache.disown_outstanding_rows()
    }

    pub fn next_generation(&mut self) -> u32 {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generation = 1;
        }
        self.next_datagram_seq = 1;
        self.last_datagram_seq = 0;
        self.last_display_seq_sent = 0;
        self.next_frame_id = 1;
        self.last_admitted_critical_header_signal = 0;
        self.input_routing_sent = None;
        self.presentation_end_owed = false;
        self.row_presentation_head = 0;
        self.unresolved_presentation_rows = [0; 4];
        self.presentation_row_coverage_overflow = false;
        self.display_admission_retry = DisplayAdmissionRetry::default();
        self.display_credit.reset_generation(self.generation);
        // A generation boundary invalidates every queued frame from the old
        // generation. Dropping it here also prevents an old Noise/display
        // sequence from being emitted after a snapshot.
        self.cancel_display_prepare();
        // A compression dictionary is scoped to `(peer, generation)`: its id is
        // only meaningful inside the generation it was installed in. Every
        // resize, resume, and snapshot boundary routes through here, so this is
        // the one place that has to drop it.
        self.dictionary.reset();
        self.has_receiver_ack = false;
        self.display_cache.abandon_resume_repair();
        self.display_cache.reset_for_snapshot();
        self.needs_snapshot = true;
        self.snapshot_retry_at_ms = 0.0;
        self.snapshot_consecutive_failures = 0;
        self.generation
    }

    /// Cancel exactly the off-owner preparation token this peer currently
    /// owns. The epoch advances only when there is work to fence, keeping the
    /// common no-work carrier bookkeeping to one branch and no atomic write.
    pub(crate) fn cancel_display_prepare(&mut self) -> bool {
        let had_work = self.display_prepare_in_flight.take().is_some();
        if had_work {
            self.display_prepare_epoch.fetch_add(1, Ordering::Release);
        }
        // A cancelled preparation never reaches a carrier; its grant is unspent.
        if let Some(prepared) = self.display_credit.take_prepare()
            && prepared.admission == crate::display::credit::DisplayAdmission::State
        {
            self.display_credit.refund(self.generation, prepared.stamp);
        }
        had_work
    }

    pub fn record_backpressure(&mut self, backpressured: bool) {
        if backpressured {
            self.backpressure_score = self
                .backpressure_score
                .min(DisplayPolicy::BACKPRESSURE_SCORE_MAX.saturating_sub(1))
                + 1;
        } else if self.backpressure_score > 0 {
            self.backpressure_score -= 1;
        }
    }

    pub fn is_recently_interactive(&self, now_ms: f64) -> bool {
        now_ms - self.last_input_at_ms <= 120.0
    }

    pub fn apply_transport_hint(&mut self, hint: TransportHint) {
        self.adaptive.profile = hint.profile;
        self.adaptive.presentation_period_ms =
            clamp_f64(hint.presentation_period_ms, 1_000.0 / 480.0, 65.535);
        self.adaptive.chunk_target_bytes = hint.chunk_bytes.clamp(
            TRANSPORT_POLICY_CHUNK_TARGET_MIN_BYTES,
            TRANSPORT_POLICY_CHUNK_TARGET_MAX_BYTES,
        );
        self.adaptive.snapshot_target_bytes = hint.snapshot_bytes.max(32 * 1024);
        // Zero means the browser could not read its own depth back; the shared
        // constant is the only honest answer then, and it is what the browser
        // asked for in any case.
        self.adaptive.receive_queue_datagrams = if hint.receive_queue_datagrams == 0 {
            DISPLAY_DATAGRAM_RECEIVE_QUEUE_DEPTH
        } else {
            hint.receive_queue_datagrams
        };
        self.adaptive.flush_hint_active = true;
    }

    /// Accept one keystroke through the shared single-frame/input-run dedup
    /// state machine. `enqueue` must return true only after the bytes entered
    /// the bounded PTY FIFO. Delivery and ACK state advance separately through
    /// `confirm_keystroke_delivery`.
    pub fn apply_keystroke<F>(
        &mut self,
        seq: u32,
        data: &[u8],
        shadow_modelled: bool,
        enqueue: &mut F,
    ) -> AppliedKeystroke
    where
        F: FnMut(u32, &[u8], bool) -> bool,
    {
        let ack_seq = self.keystroke_next_expected_seq.wrapping_sub(1);
        if seq_lt(seq, self.keystroke_next_expected_seq) {
            return AppliedKeystroke::idle(ack_seq); // duplicate / already delivered
        }
        if seq_lt(seq, self.keystroke_next_queued_seq) {
            return AppliedKeystroke::idle(ack_seq); // duplicate already in the FIFO
        }
        if seq == self.keystroke_next_queued_seq {
            if !enqueue(seq, data, shadow_modelled) {
                return AppliedKeystroke {
                    ack_seq,
                    advanced: false,
                    backpressured: true,
                };
            }
            self.keystroke_next_queued_seq = seq.wrapping_add(1);
            let backpressured = self.drain_keystroke_reorder(enqueue);
            AppliedKeystroke {
                ack_seq,
                advanced: true,
                backpressured,
            }
        } else if !self.keystroke_reorder_buf.contains_key(&seq)
            && self.keystroke_reorder_buf.len() < KEYSTROKE_REORDER_CAP
            && data.len()
                <= KEYSTROKE_REORDER_MAX_BYTES.saturating_sub(self.keystroke_reorder_bytes)
        {
            self.keystroke_reorder_bytes += data.len();
            self.keystroke_reorder_buf
                .insert(seq, (data.to_vec(), shadow_modelled));
            AppliedKeystroke::idle(ack_seq)
        } else {
            AppliedKeystroke::idle(ack_seq)
        }
    }

    /// Move buffered contiguous entries into the PTY FIFO until either the gap
    /// returns or the queue rejects an entry. A rejected entry is restored and
    /// neither queued sequence state nor byte accounting advances.
    pub fn drain_keystroke_reorder<F>(&mut self, enqueue: &mut F) -> bool
    where
        F: FnMut(u32, &[u8], bool) -> bool,
    {
        loop {
            let seq = self.keystroke_next_queued_seq;
            let Some((buffered, shadow_modelled)) = self.keystroke_reorder_buf.remove(&seq) else {
                return false;
            };
            if !enqueue(seq, &buffered, shadow_modelled) {
                self.keystroke_reorder_buf
                    .insert(seq, (buffered, shadow_modelled));
                return true;
            }
            self.keystroke_reorder_bytes =
                self.keystroke_reorder_bytes.saturating_sub(buffered.len());
            self.keystroke_next_queued_seq = seq.wrapping_add(1);
        }
    }

    /// Commit one FIFO completion. Completions must be in per-peer sequence
    /// order; a mismatch is rejected rather than moving the cumulative ACK.
    pub fn confirm_keystroke_delivery(&mut self, seq: u32) -> Option<u32> {
        if seq != self.keystroke_next_expected_seq || !seq_lt(seq, self.keystroke_next_queued_seq) {
            return None;
        }
        self.keystroke_next_expected_seq = seq.wrapping_add(1);
        Some(seq)
    }

    /// Whether a later record of this peer is in the PTY FIFO, unconfirmed.
    /// Its completion will acknowledge and advertise everything before it.
    pub fn has_unconfirmed_keystrokes(&self) -> bool {
        self.keystroke_next_expected_seq != self.keystroke_next_queued_seq
    }

    /// Queue the input ack this peer is owed by the end of the current owner
    /// turn. Newest wins: the ack is cumulative, so several completions in one
    /// turn coalesce into the one record that covers all of them, and the
    /// carrier of the most recent confirmation is the one the ack is routed on.
    pub fn queue_input_ack(&mut self, ack_seq: u32, via_transport: PeerTransport) {
        self.pending_input_ack = Some(PendingInputAck {
            ack_seq,
            via_transport,
        });
    }

    /// Whether every seq up to and including `seq` is in the PTY FIFO or already
    /// delivered. A reorder gap, a backpressured refusal or retained reliable
    /// input leaves the FIFO's next seq at or below it, and then no completion
    /// will acknowledge `seq` until the gap fills or the PTY takes more.
    pub fn has_queued_through(&self, seq: u32) -> bool {
        seq_lt(seq, self.keystroke_next_queued_seq)
    }

    /// Accept a fully validated input_run (`base_seq` + per-entry payloads where
    /// entry i has seq `base_seq + i`). Each entry shares `apply_keystroke`
    /// dedup and FIFO admission. Stops only at queue backpressure.
    pub fn apply_input_run<'a, F>(
        &mut self,
        base_seq: u32,
        entries: impl Iterator<Item = (&'a [u8], bool)>,
        enqueue: &mut F,
    ) -> AppliedRun
    where
        F: FnMut(u32, &[u8], bool) -> bool,
    {
        let mut index: u32 = 0;
        let mut advanced = false;
        let mut backpressured = false;
        for (data, shadow_modelled) in entries {
            let seq = base_seq.wrapping_add(index);
            let applied = self.apply_keystroke(seq, data, shadow_modelled, enqueue);
            advanced |= applied.advanced;
            if applied.backpressured {
                backpressured = true;
                break;
            }
            index = index.wrapping_add(1);
        }
        AppliedRun {
            ack_seq: self.keystroke_next_expected_seq.wrapping_sub(1),
            advanced,
            backpressured,
        }
    }
}

impl Drop for PeerDisplayState {
    fn drop(&mut self) {
        self.clear_hybrid_secret_material();
    }
}

/// One input ack owed to a peer, held on the peer until the owner turn that
/// queued it ends. There is deliberately no deadline in here: the ack is
/// flushed on the turn it was queued in, never on a clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingInputAck {
    pub ack_seq: u32,
    pub via_transport: PeerTransport,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppliedKeystroke {
    pub ack_seq: u32,
    pub advanced: bool,
    pub backpressured: bool,
}

impl AppliedKeystroke {
    fn idle(ack_seq: u32) -> Self {
        Self {
            ack_seq,
            advanced: false,
            backpressured: false,
        }
    }
}

/// Outcome of accepting an input_run. `ack_seq` covers delivered input only;
/// `advanced` means at least one entry entered the PTY FIFO.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppliedRun {
    pub ack_seq: u32,
    pub advanced: bool,
    pub backpressured: bool,
}

/// Wrap-correct "is `a` strictly behind `b`" over the u32 seq space (signed
/// difference). The unacked window is tiny, so the i32 wrap window always
/// holds; this replaces a raw `<` that mis-handled the u32 boundary.
pub fn seq_lt(a: u32, b: u32) -> bool {
    (a.wrapping_sub(b) as i32) < 0
}

/// Keystroke reorder buffer cap (entries). Cumulative-suffix datagrams self-
/// fill gaps, so this is rarely approached; it bounds a pathological gap.
pub const KEYSTROKE_REORDER_CAP: usize = 64;
pub const KEYSTROKE_REORDER_MAX_BYTES: usize = 256 * 1024;

pub struct TransportHint {
    pub profile: u8,
    pub chunk_bytes: usize,
    pub snapshot_bytes: usize,
    /// Display datagrams the browser's receive queue actually holds. Zero when
    /// the browser exposes no readable depth.
    pub receive_queue_datagrams: u16,
    /// Browser-measured active display period, in milliseconds.
    pub presentation_period_ms: f64,
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.clamp(min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STALE_MS: f64 = 15_000.0;

    /// The pending ack lives on the peer, so one busy viewer cannot touch
    /// another viewer's slot, and within a turn the newest confirmation wins
    /// both the seq and the carrier it is answered on.
    #[test]
    fn a_queued_input_ack_is_per_peer_and_keeps_the_newest_seq() {
        let mut peer_a = PeerDisplayState::new("browser-a".into(), PeerTransport::Edge);
        let mut peer_b = PeerDisplayState::new("browser-b".into(), PeerTransport::Edge);
        assert_eq!(peer_a.pending_input_ack, None);
        assert_eq!(peer_b.pending_input_ack, None);

        peer_a.queue_input_ack(7, PeerTransport::Edge);
        peer_b.queue_input_ack(11, PeerTransport::WebTransport);
        peer_b.queue_input_ack(12, PeerTransport::Edge);

        assert_eq!(
            peer_a.pending_input_ack,
            Some(PendingInputAck {
                ack_seq: 7,
                via_transport: PeerTransport::Edge,
            })
        );
        assert_eq!(
            peer_b.pending_input_ack,
            Some(PendingInputAck {
                ack_seq: 12,
                via_transport: PeerTransport::Edge,
            }),
            "several confirmations in one turn coalesce to the newest seq on its carrier"
        );
        assert_eq!(
            peer_b
                .pending_input_ack
                .take()
                .map(|pending| pending.ack_seq),
            Some(12)
        );
        assert_eq!(peer_b.pending_input_ack, None, "a flush is one take");
        assert_eq!(
            peer_a.pending_input_ack.map(|pending| pending.ack_seq),
            Some(7),
            "taking one peer's ack leaves the other's untouched"
        );
    }

    /// The peer holds exactly ONE hybrid-derived secret now.
    ///
    /// The PSK and the prologue digest used to be parked here between the auth
    /// flight and a separate `noise_init`. Fusing the handshake into the auth
    /// flight removed that gap, so both go straight into Wasm-owned handshake
    /// state and never have a peer-level copy to clear — one fewer place for key
    /// material to live. The direct-upgrade secret genuinely outlives the
    /// handshake and so genuinely lives here.
    #[test]
    fn hybrid_secret_cleanup_removes_every_peer_level_owner() {
        let mut peer = PeerDisplayState::new("browser".into(), PeerTransport::Edge);
        peer.upgrade_secret = Some([2u8; 32]);

        peer.clear_hybrid_secret_material();

        assert!(peer.upgrade_secret.is_none());
        assert!(
            peer.noise_handshake.is_none(),
            "a predecessor handshake must not survive into a successor session"
        );
    }

    fn live_paths(edge_rtt: f64, wt_rtt: f64) -> PeerPaths {
        let mut paths = PeerPaths::new(PeerTransport::Edge, 0.0);
        paths.edge.available = true;
        paths.edge.rtt_ewma_ms = edge_rtt;
        paths.edge.network_rtt_ewma_ms = edge_rtt;
        paths.edge.last_ack_at_ms = 1.0;
        paths.webtransport.available = true;
        paths.webtransport.rtt_ewma_ms = wt_rtt;
        paths.webtransport.network_rtt_ewma_ms = wt_rtt;
        paths.webtransport.last_ack_at_ms = 1.0;
        paths
    }

    #[test]
    fn pick_path_picks_lower_rtt_when_both_alive() {
        let paths = live_paths(20.0, 80.0);
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        assert_eq!(t, PathTargets::Single(PeerTransport::Edge));

        let paths = live_paths(80.0, 20.0);
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        assert_eq!(t, PathTargets::Single(PeerTransport::WebTransport));
    }

    #[test]
    fn pick_path_returns_only_live_path_when_other_unavailable() {
        let mut paths = live_paths(20.0, 20.0);
        paths.webtransport.available = false;
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        assert_eq!(t, PathTargets::Single(PeerTransport::Edge));

        let mut paths = live_paths(20.0, 20.0);
        paths.edge.available = false;
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        assert_eq!(t, PathTargets::Single(PeerTransport::WebTransport));
    }

    #[test]
    fn edge_and_direct_webtransport_are_independent_selected_routes() {
        let mut paths = PeerPaths::new(PeerTransport::Edge, 1.0);
        paths.edge.rtt_ewma_ms = 35.0;
        assert_eq!(
            pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS,),
            PathTargets::Single(PeerTransport::Edge),
            "an edge-only peer must not probe the direct-WT route",
        );

        paths.webtransport = PathHealth::fresh_available(1.0);
        paths.webtransport.rtt_ewma_ms = 12.0;
        assert_eq!(
            pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS,),
            PathTargets::Single(PeerTransport::WebTransport),
            "two healthy carriers still use one selected latency route",
        );
        assert_eq!(
            pick_path(&paths, SendIntent::Redundant, 100.0, STALE_MS),
            PathTargets::Dual(PeerTransport::WebTransport, PeerTransport::Edge),
            "loss-triggered redundancy is bounded to the two best live carriers",
        );

        paths.webtransport.available = false;
        assert_eq!(
            paths.fallback_for(PeerTransport::WebTransport, 100.0, STALE_MS),
            Some(PeerTransport::Edge),
        );
    }

    #[test]
    fn pick_path_dual_sends_when_primary_has_send_failures() {
        let mut paths = live_paths(20.0, 80.0);
        paths.edge.consecutive_send_failures = 1;
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        assert_eq!(
            t,
            PathTargets::Dual(PeerTransport::Edge, PeerTransport::WebTransport)
        );
    }

    #[test]
    fn pick_path_dual_sends_when_primary_rtt_is_much_worse_than_secondary() {
        // Wait — pick_path picks the LOWER RTT as primary. If primary RTT
        // is much worse than secondary, that's contradictory by construction.
        // The auto-dual rule is "primary RTT > 2× secondary RTT" — which can
        // only happen if there's a measurement skew. Simulate it by forcing
        // a primary whose own RTT exceeds 2× the other's. The tie-break
        // picks Edge when equal; force Edge as primary with high RTT.
        let mut paths = live_paths(30.0, 100.0);
        // Edge = 30 ≤ WT = 100 → Edge is primary. Primary.rtt(30) > 2×secondary.rtt(100)?
        // No, 30 > 200 is false. The condition isn't met. So single-send. Good.
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        assert_eq!(t, PathTargets::Single(PeerTransport::Edge));

        // Now force the primary path's RTT to exceed 2× the other's. This is
        // weird (we'd normally pick the OTHER) but defends the condition.
        paths.edge.network_rtt_ewma_ms = 250.0;
        paths.webtransport.network_rtt_ewma_ms = 100.0;
        // WT becomes primary now (250 > 100). WT.rtt=100 > 2×Edge.rtt=500? No.
        // So single-send WT.
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        assert_eq!(t, PathTargets::Single(PeerTransport::WebTransport));
    }

    #[test]
    fn pick_path_single_path_never_dual_sends() {
        let mut paths = live_paths(20.0, 80.0);
        paths.edge.consecutive_send_failures = 5;
        let t = pick_path(&paths, SendIntent::SinglePath, 100.0, STALE_MS);
        assert_eq!(t, PathTargets::Single(PeerTransport::Edge));
    }

    /// Selection must not react to display-ACK inflation.
    ///
    /// `rtt_ewma_ms` folds in the browser's frame-apply time and is charged only
    /// to whichever carrier is currently doing single-path display, so letting it
    /// rank paths means the busy incumbent loses to an idle challenger purely for
    /// being the one doing the work.
    #[test]
    fn selection_ignores_ack_inflated_rtt() {
        let mut paths = live_paths(20.0, 80.0);
        assert_eq!(
            pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS),
            PathTargets::Single(PeerTransport::Edge)
        );

        // The edge is carrying display, so its ACK round trips balloon while the
        // network underneath is unchanged. Selection must not move.
        paths.edge.rtt_ewma_ms = 400.0;
        assert_eq!(
            pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS),
            PathTargets::Single(PeerTransport::Edge)
        );
        assert_eq!(
            paths.fallback_for(PeerTransport::WebTransport, 100.0, STALE_MS),
            Some(PeerTransport::Edge)
        );
    }

    /// A freshly upgraded path is ranked on its measured round trip, not on the
    /// blind baseline that used to lose it several heartbeats of selection.
    #[test]
    fn a_seeded_path_outranks_a_slower_incumbent_immediately() {
        let mut paths = PeerPaths::new(PeerTransport::Edge, 0.0);
        paths.edge.available = true;
        paths.edge.rtt_ewma_ms = 60.0;
        paths.edge.network_rtt_ewma_ms = 60.0;
        paths.edge.last_ack_at_ms = 1.0;

        // Without a seed the new carrier carries RTT_BASELINE_MS.
        paths.webtransport = PathHealth::fresh_available(1.0);
        assert_eq!(paths.webtransport.network_rtt_ewma_ms, RTT_BASELINE_MS);

        // The challenge->proof round trip is the real number and replaces it.
        paths.webtransport.seed_rtt(4.0);
        assert_eq!(paths.webtransport.network_rtt_ewma_ms, 4.0);
        assert_eq!(
            pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS),
            PathTargets::Single(PeerTransport::WebTransport)
        );

        // A nonsensical measurement must not poison the path.
        let before = paths.webtransport.network_rtt_ewma_ms;
        paths.webtransport.seed_rtt(-1.0);
        paths.webtransport.seed_rtt(f64::NAN);
        assert_eq!(paths.webtransport.network_rtt_ewma_ms, before);
    }

    #[test]
    fn network_jitter_is_heartbeat_owned_and_resets_with_the_path() {
        let mut path = PathHealth::fresh_available(1.0);
        path.seed_rtt(50.0);
        path.record_network_rtt_sample(100.0);
        assert_eq!(path.network_rtt_ewma_ms, 57.5);
        assert_eq!(path.network_jitter_ewma_ms, 10.0);
        for sample in [200.0, 80.0, 400.0] {
            path.record_rtt_sample(sample);
        }
        assert!(path.jitter_ewma_ms > 0.0);
        assert_eq!(path.network_rtt_ewma_ms, 57.5);
        assert_eq!(path.network_jitter_ewma_ms, 10.0);
        for sample in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            path.record_network_rtt_sample(sample);
            path.seed_rtt(sample);
        }
        assert_eq!(path.network_rtt_ewma_ms, 57.5);
        assert_eq!(path.network_jitter_ewma_ms, 10.0);

        path.seed_rtt(5.0);
        assert_eq!(path.network_rtt_ewma_ms, 5.0);
        assert_eq!(path.network_jitter_ewma_ms, 0.0);
        for replacement in [PathHealth::fresh_available(2.0), PathHealth::dormant()] {
            assert_eq!(replacement.network_rtt_ewma_ms, RTT_BASELINE_MS);
            assert_eq!(replacement.network_jitter_ewma_ms, 0.0);
        }
    }

    #[test]
    fn pick_path_redundant_always_dual_sends_when_both_alive() {
        let paths = live_paths(20.0, 20.0);
        let t = pick_path(&paths, SendIntent::Redundant, 100.0, STALE_MS);
        assert!(t.is_dual());
    }

    #[test]
    fn pick_path_falls_back_to_edge_when_all_paths_down() {
        let mut paths = live_paths(20.0, 20.0);
        paths.edge.available = false;
        paths.webtransport.available = false;
        let t = pick_path(&paths, SendIntent::LatencySensitive, 100.0, STALE_MS);
        // Every issued session owns edge coordinates, so best-effort uses Edge.
        assert_eq!(t, PathTargets::Single(PeerTransport::Edge));
    }

    #[test]
    fn path_is_live_respects_staleness_threshold() {
        let mut p = PathHealth::fresh_available(100.0);
        p.last_ack_at_ms = 100.0;
        assert!(p.is_live(200.0, STALE_MS));
        // Past the threshold: stale.
        assert!(!p.is_live(100.0 + STALE_MS + 1.0, STALE_MS));
        // Never armed (last_ack=0): treated as live for first heartbeat round-trip.
        let p2 = PathHealth::fresh_available(100.0);
        assert!(p2.is_live(200.0, STALE_MS));
    }

    /// Inbound traffic proves the DOWNLINK and must not advance the round-trip
    /// clock.
    ///
    /// `record_authenticated_activity` was called for any authenticated inbound
    /// frame and for a browser-originated PING, which is the mirror of the
    /// browser bug fixed 2026-08-30 — and worse, because it also cleared
    /// `oldest_unanswered_send_ms`. A typing user therefore erased the daemon's
    /// early-suspicion signal on every keystroke, so a blackholed downlink
    /// reverted to the pure quiet clock exactly when the daemon had the most
    /// evidence available.
    #[test]
    fn inbound_activity_proves_the_downlink_without_clearing_the_round_trip_clock() {
        let mut path = PathHealth::dormant();
        path.consecutive_send_failures = 3;
        path.last_ack_at_ms = 100.0;
        path.note_unanswered_send(500.0);
        path.heartbeat_probe_requested = true;

        path.record_inbound_activity();

        // What inbound genuinely proves: the path carried bytes.
        assert!(path.available, "a delivered frame revives the path");
        assert_eq!(path.consecutive_send_failures, 0);
        // What it does not prove: that anything WE sent arrived.
        assert_eq!(
            path.last_ack_at_ms, 100.0,
            "inbound traffic must not advance the round-trip clock, or a dead \
             downlink under a live uplink is undetectable"
        );
        assert_eq!(
            path.oldest_unanswered_send_ms, 500.0,
            "inbound traffic must not discard the outstanding send that makes \
             this path suspect early"
        );
        assert!(
            path.heartbeat_probe_requested,
            "a probe was requested because this path looked suspect, and an \
             inbound frame does not answer it"
        );

        // A completed round trip clears both, which is the whole distinction.
        path.record_authenticated_activity(900.0);
        assert_eq!(path.last_ack_at_ms, 900.0);
        assert_eq!(path.oldest_unanswered_send_ms, 0.0);
        assert!(!path.heartbeat_probe_requested);
    }

    #[test]
    fn authenticated_activity_revives_only_the_proven_path_state() {
        let mut path = PathHealth::dormant();
        path.consecutive_send_failures = 3;
        path.heartbeat_probe_requested = true;
        path.record_authenticated_activity(321.0);

        assert!(path.available);
        assert_eq!(path.last_ack_at_ms, 321.0);
        assert!(!path.heartbeat_probe_requested);
        assert_eq!(path.consecutive_send_failures, 0);
    }

    #[test]
    fn awaiting_resume_field_defaults_to_none() {
        // Regression guard: peer state must not auto-arm the gate; only
        // the token-resumed auth path with a usable cache should set it.
        let peer = PeerDisplayState::new("p".into(), PeerTransport::Edge);
        assert_eq!(peer.awaiting_resume_until_ms, None);
        assert!(peer.needs_snapshot, "fresh peer needs snapshot");
    }

    #[test]
    fn cache_preservation_invariants() {
        // The token-resumed reuse path relies on display_cache.initialized
        // being false on a freshly-constructed peer (so reuse never happens
        // with empty cache) and true after prime_from_snapshot.
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(4, 2);
        assert!(!cache.initialized);

        let grid = vec![CellRepr::BLANK; 8];
        let hashes = vec![0xaa, 0xbb];
        cache.prime_from_snapshot(&grid, &hashes, &[]);
        assert!(cache.initialized);
        assert_eq!(cache.cols, 4);
        assert_eq!(cache.rows, 2);
        // The immutable acknowledged rows are the canonical baseline for
        // delta-replay resume — they MUST survive a token-resumed auth where the daemon
        // splices the cache through.
        assert_eq!(cache.acked_row_cells.len(), 2);
        assert_eq!(
            cache
                .acked_row_cells
                .iter()
                .map(|row| row.len())
                .sum::<usize>(),
            8
        );
        assert!(
            cache
                .acked_row_cells
                .iter()
                .zip(&cache.sent_row_cells)
                .all(|(acked, sent)| Arc::ptr_eq(acked, sent)),
            "snapshot priming stores one immutable row allocation, not flat-grid mirrors"
        );
        assert_eq!(cache.acked_row_hashes, vec![0xaa, 0xbb]);
    }

    #[test]
    fn invalidate_rows_drops_invalidated_rows_from_in_flight_sent_datagrams() {
        // Reproduces the post-invalidate ACK race: an ACK datagram for an
        // in-flight send arrives AFTER the client requested resync; without
        // this cleanup, advance_acked_rows would walk the old SentRow snapshot
        // and undo the invalidate by re-writing acknowledged cells/hashes
        // for the very rows we just disowned.
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(2, 2);
        cache.sent_datagrams.insert(
            10,
            SentDatagram {
                sent_at_ms: 0.0,
                rows: SentRows::from_iter([
                    SentRow {
                        graphics: None,
                        row: 0,
                        hash: 0xdead,
                        cells: vec![cell('x'), cell('x')].into(),
                    },
                    SentRow {
                        graphics: None,
                        row: 1,
                        hash: 0xbeef,
                        cells: vec![cell(' '), cell(' ')].into(),
                    },
                ]),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );

        cache.invalidate_rows(&[0]);

        let sent = cache.sent_datagrams.get(&10).expect("entry preserved");
        // Row 0 (invalidated) removed; row 1 (not invalidated) retained.
        assert_eq!(sent.rows.len(), 1);
        assert_eq!(sent.rows.iter().next().map(|row| row.row), Some(1));
    }

    /// The same race, reached from the other direction: adoption rewrites a
    /// row's acknowledged baseline to the browser's claim, so a retained record
    /// must stop speaking for it.
    ///
    /// These records genuinely survive into a resume. Only the rebind path
    /// clears them (`carrier_boundary`); a full re-authentication splices the
    /// cache back and arms the awaiting-resume gate with `sent_datagrams`
    /// intact. Left alone, a pre-outage record naming an adopted row is still
    /// resolvable — three applied successors declare it lost, and the loss path
    /// calls `invalidate_rows`, undoing the adoption and costing the very
    /// re-send the adoption existed to avoid.
    #[test]
    fn adopting_a_row_drops_it_from_in_flight_sent_datagrams() {
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(2, 2);
        cache.sent_datagrams.insert(
            10,
            SentDatagram {
                sent_at_ms: 0.0,
                rows: SentRows::from_iter([
                    SentRow {
                        graphics: None,
                        row: 0,
                        hash: 0xdead,
                        cells: vec![cell('x'), cell('x')].into(),
                    },
                    SentRow {
                        graphics: None,
                        row: 1,
                        hash: 0xbeef,
                        cells: vec![cell(' '), cell(' ')].into(),
                    },
                ]),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );

        cache.adopt_peer_row(&crate::pty::CapturedRow {
            graphics: merkur_codec::PreparedGraphics::EMPTY,
            row: 0,
            hash: 0xfeed,
            cells: vec![cell('y'), cell('y')].into(),
        });

        let sent = cache.sent_datagrams.get(&10).expect("entry preserved");
        // Row 0 (adopted) removed; row 1 (untouched) retained.
        assert_eq!(sent.rows.len(), 1);
        assert_eq!(sent.rows.iter().next().map(|row| row.row), Some(1));
    }

    /// Exact allocation oracle for the rows a datagram record carries.
    ///
    /// A datagram batch is at most a handful of rows, and its record lives in
    /// `sent_datagrams` until the acknowledgement retires it, so the row list
    /// used to cost one allocation on the send side and one free on the ACK
    /// side per datagram. Eight rows fit inline; the ninth spills to the heap
    /// in exactly one allocation.
    ///
    /// Ignored because the counting allocator is process-wide: run it alone,
    /// in release, with `--exact --nocapture`.
    #[test]
    #[ignore = "exact allocation oracle; the counting allocator is process-wide"]
    fn sent_rows_inline_covers_a_datagram_batch_and_spills_past_eight() {
        use crate::edge_tunnel::test_allocations;
        let cells: Arc<[CellRepr]> = vec![cell('x'), cell('y')].into();
        let row = |index: u16| SentRow {
            graphics: None,
            row: index,
            hash: u64::from(index),
            cells: Arc::clone(&cells),
        };
        let build = |count: u16| {
            test_allocations::begin();
            let mut rows = SentRows::default();
            for index in 0..count {
                rows.push(row(index));
            }
            let tally = test_allocations::end();
            (rows, tally)
        };
        let indices = |rows: &SentRows| rows.iter().map(|row| row.row).collect::<Vec<u16>>();

        let (mut eight, eight_tally) = build(8);
        assert_eq!(eight.len(), 8);
        assert!(matches!(eight, SentRows::Inline { .. }));
        assert_eq!(
            eight_tally.allocations, 0,
            "eight rows — a datagram batch — must fit inline"
        );
        let (mut nine, nine_tally) = build(9);
        assert_eq!(nine.len(), 9);
        assert!(matches!(nine, SentRows::Heap(_)));
        assert_eq!(
            nine_tally.allocations, 1,
            "the ninth row spills to the heap exactly once"
        );
        // Sized up front, a large batch also costs exactly one allocation.
        test_allocations::begin();
        let sized: SentRows = (0..20u16).map(row).collect();
        let sized_tally = test_allocations::end();
        assert_eq!(sized.len(), 20);
        assert_eq!(
            sized_tally.allocations, 1,
            "a pre-sized spill is one allocation"
        );

        // Both shapes retain in order and in place: an invalidation walks
        // every retained record with this.
        test_allocations::begin();
        eight.retain(|row| row.row % 2 == 1);
        nine.retain(|row| row.row % 2 == 1);
        let retain_tally = test_allocations::end();
        assert_eq!(retain_tally.allocations, 0, "retain must not allocate");
        assert_eq!(indices(&eight), vec![1, 3, 5, 7]);
        assert_eq!(indices(&nine), vec![1, 3, 5, 7]);
        eight.retain(|_| false);
        assert!(eight.is_empty());
        assert_eq!(indices(&eight), Vec::<u16>::new());

        println!(
            "sent rows: {} allocations for 8 rows, {} for 9; SentRows is {} bytes, \
             SentDatagram {} bytes, Vec<SentRow> {} bytes",
            eight_tally.allocations,
            nine_tally.allocations,
            std::mem::size_of::<SentRows>(),
            std::mem::size_of::<SentDatagram>(),
            std::mem::size_of::<Vec<SentRow>>(),
        );
    }

    #[test]
    fn sent_rows_share_cell_snapshots_across_datagrams() {
        // One flush tick captures a row once and shares the refcounted
        // snapshot across every datagram that carries it. The snapshot
        // is never mutated after capture, so an ACK for either datagram
        // advances the exact same bytes (the exact-snapshot invariant).
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(2, 1);
        let shared = SentRow {
            graphics: None,
            row: 0,
            hash: 7,
            cells: vec![cell('x'), cell('y')].into(),
        };
        cache.sent_datagrams.insert(
            1,
            SentDatagram {
                sent_at_ms: 0.0,
                rows: SentRows::from_iter([shared.clone()]),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );
        cache.sent_datagrams.insert(
            2,
            SentDatagram {
                sent_at_ms: 1.0,
                rows: SentRows::from_iter([shared.clone()]),
                sent_via: SentPaths::single(PeerTransport::Edge),
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );

        let first = cache
            .sent_datagrams
            .get(&1)
            .unwrap()
            .rows
            .iter()
            .next()
            .unwrap();
        let second = cache
            .sent_datagrams
            .get(&2)
            .unwrap()
            .rows
            .iter()
            .next()
            .unwrap();
        assert!(Arc::ptr_eq(&first.cells, &second.cells));

        cache.record_sent_rows(
            1,
            &[shared],
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        assert_eq!(cache.sent_row_cells[0].as_ref(), &[cell('x'), cell('y')]);
    }

    #[test]
    fn sent_datagram_history_has_a_hard_entry_bound() {
        let mut cache = PerPeerDisplayCache::new();
        let extra = 7u32;
        let total = DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES as u32 + extra;
        for seq in 1..=total {
            cache.insert_sent_datagram(
                seq,
                SentDatagram {
                    sent_at_ms: f64::from(seq),
                    rows: SentRows::default(),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: true,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }

        assert_eq!(
            cache.sent_datagrams.len(),
            DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES
        );
        assert!(!cache.sent_datagrams.contains_key(&extra));
        assert!(cache.sent_datagrams.contains_key(&(extra + 1)));
        assert!(cache.sent_datagrams.contains_key(&total));
        assert_eq!(
            cache.datagram_outcomes.edge.outcome_unknown,
            u64::from(extra),
            "each eligible capacity eviction is one censored outcome"
        );
    }

    #[test]
    fn pruning_and_reset_count_unknown_outcomes_once_with_path_provenance() {
        let mut cache = PerPeerDisplayCache::new();
        for (seq, sent_via, reliable) in [
            (1, SentPaths::single(PeerTransport::Edge), false),
            (2, SentPaths::single(PeerTransport::WebTransport), false),
            (
                3,
                SentPaths {
                    webtransport: true,
                    edge: true,
                },
                false,
            ),
            (4, SentPaths::single(PeerTransport::Edge), true),
        ] {
            cache.insert_sent_datagram(
                seq,
                SentDatagram {
                    sent_at_ms: 1.0,
                    rows: SentRows::default(),
                    sent_via,
                    header_only: true,
                    reliable,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }

        cache.prune_expired_sent_datagrams(DisplayPolicy::SENT_DATAGRAM_PRUNE_AGE_MS + 2.0);
        assert_eq!(cache.datagram_outcomes.edge.outcome_unknown, 1);
        assert_eq!(cache.datagram_outcomes.webtransport.outcome_unknown, 1);
        assert!(cache.sent_datagrams.is_empty());

        cache.insert_sent_datagram(
            5,
            SentDatagram {
                sent_at_ms: 2.0,
                rows: SentRows::default(),
                sent_via: SentPaths::single(PeerTransport::WebTransport),
                header_only: true,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );
        cache.resize(1, 1);
        cache.resize(1, 1);
        assert_eq!(cache.datagram_outcomes.edge.outcome_unknown, 1);
        assert_eq!(cache.datagram_outcomes.webtransport.outcome_unknown, 2);
    }

    #[test]
    fn sent_history_capacity_uses_admission_age_across_wrap_and_replacement() {
        let mut cache = PerPeerDisplayCache::new();
        let sent = |at| SentDatagram {
            sent_at_ms: at,
            rows: SentRows::default(),
            sent_via: SentPaths::single(PeerTransport::Edge),
            header_only: true,
            reliable: false,
            protection: DisplayDatagramProtection::Unprotected,
        };
        let oldest = u32::MAX - 511;
        let mut sequence = oldest;
        for _ in 0..DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES {
            cache.insert_sent_datagram(sequence, sent(1.0));
            sequence = sequence.wrapping_add(1).max(1);
        }
        // Replacing the oldest key is one Unknown outcome, but its new actual
        // admission is fresh. Numeric order and original insertion order both
        // give the wrong eviction after this replacement.
        cache.insert_sent_datagram(oldest, sent(3.0));
        cache.insert_sent_datagram(sequence, sent(2.0));
        assert_eq!(
            cache.sent_datagrams.len(),
            DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES
        );
        assert!(cache.sent_datagrams.contains_key(&oldest));
        assert!(cache.sent_datagrams.contains_key(&1));
        assert!(cache.sent_datagrams.contains_key(&sequence));
        assert!(!cache.sent_datagrams.contains_key(&(oldest + 1)));
        assert_eq!(cache.datagram_outcomes.edge.outcome_unknown, 2);
    }

    #[test]
    fn age_pruning_visits_expired_records_behind_fresh_keys_and_ack_holes() {
        let mut cache = PerPeerDisplayCache::new();
        for (seq, at) in [
            (1, 100.0),
            (2, 1.0),
            (3, 100.0),
            (u32::MAX - 1, 100.0),
            (u32::MAX, 1.0),
        ] {
            cache.insert_sent_datagram(
                seq,
                SentDatagram {
                    sent_at_ms: at,
                    rows: SentRows::default(),
                    sent_via: SentPaths::single(PeerTransport::Edge),
                    header_only: true,
                    reliable: false,
                    protection: DisplayDatagramProtection::Unprotected,
                },
            );
        }
        cache.sent_datagrams.remove(&3); // Independently ACK-drained hole.
        let now = DisplayPolicy::SENT_DATAGRAM_PRUNE_AGE_MS + 2.0;
        cache.prune_expired_sent_datagrams(now);
        assert_eq!(
            cache.sent_datagrams.keys().copied().collect::<Vec<_>>(),
            [1, u32::MAX - 1]
        );
        assert_eq!(cache.datagram_outcomes.edge.outcome_unknown, 2);
        cache.prune_expired_sent_datagrams(now);
        assert_eq!(cache.datagram_outcomes.edge.outcome_unknown, 2);
    }

    /// Measures steady full-history pressure, not only an isolated oldest scan.
    /// Fixtures carry no rows so the reported allocations are BTree ownership,
    /// not terminal capture. Setup and distribution storage are outside timing.
    #[test]
    #[ignore = "exclusive retained-history CPU/allocation profile"]
    fn bounded_sent_history_pressure_benchmark() {
        use crate::edge_tunnel::test_allocations;
        use std::hint::black_box;
        use std::time::Instant;
        const SAMPLES: usize = 1000;
        const BATCH: usize = 32;
        let sent = |at| SentDatagram {
            sent_at_ms: at,
            rows: SentRows::default(),
            sent_via: SentPaths::single(PeerTransport::Edge),
            header_only: true,
            reliable: false,
            protection: DisplayDatagramProtection::Unprotected,
        };
        for (stage, depth) in [
            ("insert-full", DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES),
            ("prune-fresh", 0),
            ("prune-fresh", 32),
            ("prune-fresh", DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES),
            ("prune-expired", DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES),
        ] {
            let mut cache = PerPeerDisplayCache::new();
            let mut seq = u32::MAX - 511;
            for _ in 0..depth {
                cache.insert_sent_datagram(seq, sent(1.0));
                seq = seq.wrapping_add(1).max(1);
            }
            let mut elapsed = Vec::with_capacity(SAMPLES);
            let mut allocations = Vec::with_capacity(SAMPLES);
            let mut allocated_bytes = Vec::with_capacity(SAMPLES);
            for sample in 0..SAMPLES + 10 {
                if stage == "prune-expired" && cache.sent_datagrams.is_empty() {
                    for _ in 0..depth {
                        cache.insert_sent_datagram(seq, sent(1.0));
                        seq = seq.wrapping_add(1).max(1);
                    }
                }
                let batch = if stage == "prune-expired" { 1 } else { BATCH };
                test_allocations::begin();
                let started = Instant::now();
                for item in 0..batch {
                    match stage {
                        "insert-full" => {
                            cache.insert_sent_datagram(
                                seq,
                                sent((sample * BATCH + item + 2) as f64),
                            );
                            seq = seq.wrapping_add(1).max(1);
                        }
                        "prune-fresh" => cache.prune_expired_sent_datagrams(black_box(2.0)),
                        "prune-expired" => cache.prune_expired_sent_datagrams(black_box(
                            DisplayPolicy::SENT_DATAGRAM_PRUNE_AGE_MS + 2.0,
                        )),
                        _ => unreachable!(),
                    }
                }
                let duration = started.elapsed().as_secs_f64() * 1e6 / batch as f64;
                let tally = test_allocations::end();
                if sample >= 10 {
                    elapsed.push(duration);
                    allocations.push(tally.allocations as f64 / batch as f64);
                    allocated_bytes.push(tally.allocated_bytes as f64 / batch as f64);
                }
            }
            assert_eq!(
                cache.sent_datagrams.len(),
                if stage == "prune-expired" { 0 } else { depth }
            );
            for (metric, mut values) in [
                ("us", elapsed),
                ("allocations", allocations),
                ("allocated_bytes", allocated_bytes),
            ] {
                values.sort_by(f64::total_cmp);
                let q = |p: f64| values[(p * SAMPLES as f64).ceil() as usize - 1];
                eprintln!(
                    "SENT_HISTORY stage={stage} depth={depth} samples={SAMPLES} metric={metric} p50={:.6} p95={:.6} p99={:.6} max={:.6}",
                    q(0.5),
                    q(0.95),
                    q(0.99),
                    values[SAMPLES - 1]
                );
            }
        }
    }

    fn cell(c: char) -> CellRepr {
        CellRepr {
            codepoint: c as u32,
            ..CellRepr::BLANK
        }
    }

    #[test]
    fn record_sent_rows_pins_seq_to_first_send_of_identical_content() {
        // Regression for the co-located display freeze: during continuous
        // output the daemon resends identical row content as a loss safety
        // net. An identical resend must extend the row's selective-attempt
        // lineage rather than redefine its version around the newest seq;
        // otherwise render-cadence ACKs for earlier retained attempts can
        // never confirm it and the acknowledged row never catches up — a perpetual
        // full-screen resend (frozen output with the wire byte counter
        // climbing). Seq stays pinned to the FIRST send of a given content and
        // advances only on a genuine change.
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(2, 1);
        let cells: Arc<[CellRepr]> = Arc::from(vec![cell('a'), cell('b')]);

        let first = SentRow {
            graphics: None,
            row: 0,
            hash: 0x1234,
            cells: Arc::clone(&cells),
        };
        cache.record_sent_rows(
            1,
            std::slice::from_ref(&first),
            0.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        assert_eq!(cache.sent_row_seq[0], 1, "first send records its seq");
        assert_eq!(cache.sent_row_latest_seq[0], 1);
        assert_eq!(cache.sent_row_attempt_mask[0], [1, 0, 0, 0]);

        // Identical-content resend at a later seq must NOT bump the seq.
        let resend = SentRow {
            graphics: None,
            row: 0,
            hash: 0x1234,
            cells: Arc::clone(&cells),
        };
        cache.record_sent_rows(
            5,
            std::slice::from_ref(&resend),
            100.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        assert_eq!(
            cache.sent_row_seq[0], 1,
            "identical-content resend must keep seq pinned to the first send",
        );
        assert_eq!(cache.sent_row_latest_seq[0], 5);
        assert_eq!(
            cache.sent_row_attempt_mask[0],
            [0b1_0001, 0, 0, 0],
            "the fixed-width history retains both attempts at their ACK offsets"
        );

        // A genuine content change DOES advance the seq.
        let changed = SentRow {
            graphics: None,
            row: 0,
            hash: 0x9999,
            cells: Arc::from(vec![cell('c'), cell('d')]),
        };
        cache.record_sent_rows(
            9,
            std::slice::from_ref(&changed),
            200.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        assert_eq!(
            cache.sent_row_seq[0], 9,
            "a real content change advances the seq",
        );
        assert_eq!(cache.sent_row_latest_seq[0], 9);
        assert_eq!(
            cache.sent_row_attempt_mask[0],
            [1, 0, 0, 0],
            "a new content version starts a fresh attempt lineage"
        );
    }

    #[test]
    fn resume_repair_records_exact_successfully_admitted_sequence_membership() {
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(1, 4);
        const REPAIR_ID: u32 = 71;
        assert!(cache.begin_resume_repair(REPAIR_ID, &[0, 1, 2]));
        let sent = |row: u16, hash: u64| SentRow {
            graphics: None,
            row,
            hash,
            cells: Arc::from(vec![cell(char::from(b'a' + row as u8))]),
        };

        // One datagram may satisfy several rows and dual-path bookkeeping may
        // report the same sequence twice; the marker names that transform once.
        let first = [sent(0, 10), sent(2, 12)];
        cache.record_sent_rows(104, &first, 0.0, DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS);
        cache.record_sent_rows(104, &first, 0.0, DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS);
        assert_eq!(
            cache.repair_members,
            vec![
                ResumeRepairMember {
                    row: 0,
                    minimum_seq: 104,
                },
                ResumeRepairMember {
                    row: 2,
                    minimum_seq: 104,
                },
            ]
        );
        assert!(cache.completed_resume_repair().is_none());

        // Unrelated output is not a repair member even when it interleaves.
        let unrelated = sent(3, 13);
        cache.record_sent_rows(
            105,
            std::slice::from_ref(&unrelated),
            1.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        assert_eq!(cache.repair_members.len(), 2);

        let last = sent(1, 11);
        cache.record_sent_rows(
            106,
            std::slice::from_ref(&last),
            2.0,
            DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
        );
        assert_eq!(
            cache.completed_resume_repair(),
            Some((
                REPAIR_ID,
                &[
                    ResumeRepairMember {
                        row: 0,
                        minimum_seq: 104,
                    },
                    ResumeRepairMember {
                        row: 2,
                        minimum_seq: 104,
                    },
                    ResumeRepairMember {
                        row: 1,
                        minimum_seq: 106,
                    },
                ][..]
            ))
        );
        // Reading completion cannot consume it before reliable admission.
        assert!(cache.completed_resume_repair().is_some());
        cache.finish_resume_repair_marker();
        assert!(cache.completed_resume_repair().is_none());
        assert!(cache.repair_members.is_empty());
        assert_eq!(cache.repair_id, 0);
    }

    #[test]
    fn oversized_resume_repair_fails_closed_before_any_marker_can_be_armed() {
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(1, merkur_codec::MAX_TERMINAL_ROWS as u16);
        let too_many = (0..=MAX_RESUME_REPAIR_MEMBERS)
            .map(|row| row as u16)
            .collect::<Vec<_>>();

        assert!(!cache.begin_resume_repair(72, &too_many));
        assert!(!cache.repair_armed);
        assert!(cache.completed_resume_repair().is_none());
        assert!(cache.repair_members.is_empty());
    }

    #[test]
    fn superseded_row_versions_split_on_the_browser_applied_high_water() {
        let mut cache = PerPeerDisplayCache::new();
        cache.resize(2, 1);
        let send = |cache: &mut PerPeerDisplayCache, seq: u32, hash: u64, now_ms: f64| {
            let row = SentRow {
                graphics: None,
                row: 0,
                hash,
                cells: Arc::from(vec![cell('a'), cell('b')]),
            };
            cache.record_sent_rows(
                seq,
                std::slice::from_ref(&row),
                now_ms,
                DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
            );
        };

        // First version of a row supersedes nothing: there is no prior send.
        send(&mut cache, 1, 0xaa, 0.0);
        assert_eq!(cache.waste.row_versions_sent, 1);
        assert_eq!(cache.waste.row_versions_superseded_unapplied, 0);
        assert_eq!(cache.waste.row_versions_superseded_applied, 0);

        // Replacing it while the browser has reported nothing applied is the
        // wasted case: seq 1 occupied the link and was never rendered.
        send(&mut cache, 2, 0xbb, 10.0);
        assert_eq!(cache.waste.row_versions_sent, 2);
        assert_eq!(cache.waste.row_versions_superseded_unapplied, 1);
        assert_eq!(cache.waste.row_versions_superseded_applied, 0);

        // Once the browser confirms seq 2, replacing that version is not waste.
        cache.last_applied_ack_seq = 2;
        send(&mut cache, 3, 0xcc, 20.0);
        assert_eq!(cache.waste.row_versions_superseded_unapplied, 1);
        assert_eq!(cache.waste.row_versions_superseded_applied, 1);

        // An identical resend is neither: it is the loss safety net, and it
        // must not be counted as a new version or the denominator inflates.
        send(&mut cache, 4, 0xcc, 200.0);
        assert_eq!(cache.waste.row_versions_sent, 3);
        assert_eq!(cache.waste.row_resends_identical, 1);
        assert_eq!(cache.waste.row_versions_superseded_unapplied, 1);
        assert_eq!(cache.waste.row_versions_superseded_applied, 1);
    }

    /// How much of what the daemon sends is replaced before the browser can
    /// render it, as a function of how fast the terminal is changing.
    ///
    /// This is the measurement the display path never had. Every existing
    /// benchmark asks how fast a frame is produced; none asks whether it needed
    /// to be produced. Mosh answers the second question by refusing to send
    /// while a frame is in flight, discarding the intermediate states outright.
    /// Before adopting anything like that, the rate has to be known — and it is
    /// not one number, it is a curve in the output rate, which is why this
    /// reports named cadences rather than a single figure.
    ///
    /// The model is deliberately thin, because the quantity is: a row version
    /// is wasted exactly when a newer version of that row is sent before the
    /// browser's applied high-water reaches the seq that carried it. Send
    /// cadence comes from `DisplayPolicy`; the browser applies a frame one
    /// one-way delay after it is sent and its ACK lands one more later, so the
    /// high-water at daemon time `t` is the newest seq sent at or before
    /// `t - 2 * one_way`.
    ///
    /// Diagnostic only. The absolute ratio for a real session depends on what
    /// the shell is doing, which is why the daemon also carries these counters
    /// into `MERKUR_PERF_LOG=1` output.
    #[test]
    #[ignore = "production performance workload"]
    fn display_waste_across_output_cadences() {
        const COLS: u16 = 120;
        const ROWS: u16 = 40;
        const ONE_WAY_MS: f64 = 25.0;
        const DURATION_MS: f64 = 10_000.0;

        // (label, rows changed per flush, milliseconds between content changes)
        // The streaming cadences are the reader thread's read spacing, not a
        // coalescing arm: there is none, so a flush follows every read.
        let workloads: [(&str, u16, f64); 4] = [
            ("typing-10cps", 1, 100.0),
            ("spinner", 1, 80.0),
            ("stream-10ms-reads", ROWS, 10.0),
            ("stream-1ms-reads", ROWS, 1.0),
        ];

        for (label, changed_rows, interval_ms) in workloads {
            let mut cache = PerPeerDisplayCache::new();
            cache.resize(COLS, ROWS);

            // (send time, seq) in send order, so the applied high-water can be
            // resolved by walking forward rather than searching.
            let mut sent: Vec<(f64, u32)> = Vec::new();
            let mut applied_index = 0usize;
            let mut seq = 1u32;
            let mut now_ms = 0.0f64;
            let mut version = 0u64;
            let mut rows_scratch: Vec<SentRow> = Vec::new();

            while now_ms < DURATION_MS {
                // Advance the browser's applied high-water to everything that
                // left more than a round trip ago.
                while applied_index < sent.len()
                    && sent[applied_index].0 <= now_ms - 2.0 * ONE_WAY_MS
                {
                    cache.last_applied_ack_seq = sent[applied_index].1;
                    applied_index += 1;
                }

                version += 1;
                rows_scratch.clear();
                for row in 0..changed_rows {
                    rows_scratch.push(SentRow {
                        graphics: None,
                        row,
                        hash: version
                            .wrapping_mul(0x9e37_79b9_7f4a_7c15)
                            .wrapping_add(u64::from(row)),
                        cells: Arc::from(vec![CellRepr::BLANK; usize::from(COLS)]),
                    });
                }
                cache.record_sent_rows(
                    seq,
                    &rows_scratch,
                    now_ms,
                    DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
                );
                sent.push((now_ms, seq));
                seq = seq.wrapping_add(1).max(1);
                now_ms += interval_ms;
            }

            let waste = cache.waste;
            println!(
                "@@waste {label}: sent={} superseded_unapplied={} superseded_applied={} \
                 unapplied_ratio={:.4} interval_ms={interval_ms} rows_per_flush={changed_rows}",
                waste.row_versions_sent,
                waste.row_versions_superseded_unapplied,
                waste.row_versions_superseded_applied,
                waste.superseded_unapplied_ratio().unwrap_or(0.0),
            );
        }
    }

    #[test]
    fn next_datagram_seq_skips_zero_on_wrap() {
        let mut peer = PeerDisplayState::new("b".into(), PeerTransport::Edge);
        peer.next_datagram_seq = u32::MAX;
        // Emits MAX, then wraps past the 0 sentinel straight to 1.
        assert_eq!(peer.next_datagram_seq(), u32::MAX);
        assert_eq!(peer.next_datagram_seq(), 1);
        assert_eq!(peer.next_datagram_seq(), 2);
    }

    // ── Keystroke apply / input_run ────────────────────────────────────────
    use crate::network::input_record::build;
    use crate::network::protocol::{
        CHANNEL_DISPLAY_ACK, CHANNEL_DISPLAY_DATAGRAM, CHANNEL_PTY, CHANNEL_SIGNALING,
        PROTO_HEADER_BYTES, encode_input_run, parse_input_run,
    };

    fn new_peer() -> PeerDisplayState {
        PeerDisplayState::new("peer".into(), PeerTransport::Edge)
    }

    /// Builds an input_run body and captures entries accepted into a fake FIFO.
    ///
    /// Sequencing does not look inside a record, so each entry travels as the
    /// text record of its bytes and the fake FIFO records the text back out.
    fn apply_run(
        peer: &mut PeerDisplayState,
        base: u32,
        entries: &[&[u8]],
    ) -> (AppliedRun, Vec<(u32, Vec<u8>)>) {
        let records: Vec<Vec<u8>> = entries
            .iter()
            .map(|entry| build::text(std::str::from_utf8(entry).expect("test text is UTF-8")))
            .collect();
        let unmodelled: Vec<(&[u8], bool)> = records
            .iter()
            .map(|record| (record.as_slice(), false))
            .collect();
        let frame = encode_input_run(base, false, &unmodelled);
        let body = frame[PROTO_HEADER_BYTES..].to_vec();
        let (header, iter) = parse_input_run(&body).expect("header parses");
        let mut queued = Vec::new();
        let mut enqueue = |seq: u32, record: &[u8], _shadow_modelled: bool| {
            queued.push((seq, record[1..].to_vec()));
            true
        };
        let applied = peer.apply_input_run(
            header.base_seq,
            iter.map(|entry| (entry.payload, entry.shadow_modelled)),
            &mut enqueue,
        );
        (applied, queued)
    }

    fn queued_bytes(queued: &[(u32, Vec<u8>)]) -> Vec<u8> {
        queued
            .iter()
            .flat_map(|(_, bytes)| bytes.iter().copied())
            .collect()
    }

    fn confirm_all(peer: &mut PeerDisplayState, queued: &[(u32, Vec<u8>)]) {
        for (seq, _) in queued {
            assert_eq!(peer.confirm_keystroke_delivery(*seq), Some(*seq));
        }
    }

    #[test]
    fn input_run_queues_contiguously_then_commits_delivery() {
        let mut peer = new_peer(); // next_expected starts at 1
        let (applied, queued) = apply_run(&mut peer, 1, &[b"a", b"b", b"c"]);
        assert_eq!(queued_bytes(&queued), b"abc");
        assert_eq!(peer.keystroke_next_queued_seq, 4);
        assert_eq!(peer.keystroke_next_expected_seq, 1);
        assert_eq!(applied.ack_seq, 0);
        assert!(applied.advanced && !applied.backpressured);

        confirm_all(&mut peer, &queued);
        assert_eq!(peer.keystroke_next_expected_seq, 4);
    }

    #[test]
    fn input_run_skips_already_delivered_prefix() {
        let mut peer = new_peer();
        peer.keystroke_next_expected_seq = 3;
        peer.keystroke_next_queued_seq = 3;
        let (applied, queued) = apply_run(&mut peer, 1, &[b"a", b"b", b"c", b"d"]);
        assert_eq!(queued_bytes(&queued), b"cd");
        assert_eq!(applied.ack_seq, 2);
        confirm_all(&mut peer, &queued);
        assert_eq!(peer.keystroke_next_expected_seq, 5);
    }

    #[test]
    fn input_run_all_duplicate_reacks_top() {
        let mut peer = new_peer();
        peer.keystroke_next_expected_seq = 5;
        peer.keystroke_next_queued_seq = 5;
        let (applied, queued) = apply_run(&mut peer, 1, &[b"a", b"b", b"c", b"d"]);
        assert!(queued.is_empty());
        assert_eq!(peer.keystroke_next_expected_seq, 5);
        assert_eq!(applied.ack_seq, 4); // next_expected - 1
        assert!(!applied.advanced);
    }

    #[test]
    fn input_run_gap_buffers_then_single_drains() {
        let mut peer = new_peer(); // expects 1
        let (applied, queued) = apply_run(&mut peer, 3, &[b"c", b"d"]);
        assert!(queued.is_empty());
        assert_eq!(peer.keystroke_reorder_buf.len(), 2);
        assert_eq!(applied.ack_seq, 0); // next_expected(1) - 1
        let mut drained = Vec::new();
        let mut enqueue = |seq: u32, record: &[u8], _shadow_modelled: bool| {
            drained.push((seq, record[1..].to_vec()));
            true
        };
        peer.apply_keystroke(1, &build::text("a"), false, &mut enqueue);
        peer.apply_keystroke(2, &build::text("b"), false, &mut enqueue);
        assert_eq!(queued_bytes(&drained), b"abcd");
        assert_eq!(peer.keystroke_next_queued_seq, 5);
        confirm_all(&mut peer, &drained);
        assert_eq!(peer.keystroke_next_expected_seq, 5);
    }

    /// The input-probe answer keys its reliable twin on this: a run is queued
    /// through its last seq only when nothing of it waits on a gap or the FIFO.
    #[test]
    fn a_run_is_queued_through_its_top_only_when_the_fifo_took_all_of_it() {
        let mut peer = new_peer(); // expects 1
        apply_run(&mut peer, 1, &[b"a", b"b"]);
        assert!(peer.has_queued_through(2), "a queued run");
        assert!(peer.has_queued_through(1), "an older, delivered prefix");
        assert!(!peer.has_queued_through(3));

        apply_run(&mut peer, 4, &[b"d"]);
        assert!(
            !peer.has_queued_through(4),
            "seq 3 is missing: 4 waits on the gap"
        );

        let mut refused = new_peer();
        let applied = refused.apply_input_run(
            1,
            [(&b"a"[..], false), (&b"b"[..], false)].into_iter(),
            &mut |seq, _, _| seq == 1,
        );
        assert!(applied.backpressured);
        assert!(refused.has_queued_through(1));
        assert!(!refused.has_queued_through(2), "the FIFO refused seq 2");
    }

    #[test]
    fn shadow_provenance_survives_reorder_buffer_drain() {
        let mut peer = new_peer();
        let mut queued = Vec::new();
        let mut enqueue = |seq: u32, bytes: &[u8], shadow_modelled: bool| {
            queued.push((seq, bytes.to_vec(), shadow_modelled));
            true
        };

        // Seq 2 arrives first and must retain its authenticated bit while
        // parked. Seq 1 closes the gap and drains both in order.
        peer.apply_keystroke(2, b"b", true, &mut enqueue);
        peer.apply_keystroke(1, b"a", false, &mut enqueue);

        assert_eq!(
            queued,
            vec![(1, b"a".to_vec(), false), (2, b"b".to_vec(), true)]
        );
    }

    #[test]
    fn malformed_input_run_is_rejected_before_peer_mutation() {
        // base=1, count=2, entry0 len=1 "a", entry1 len=2 but only 1 byte.
        let body = [
            0x00, 0x00, 0x00, 0x01, 0x02, 0x00, 0x01, b'a', 0x00, 0x02, b'b',
        ];
        assert!(parse_input_run(&body).is_none());
    }

    #[test]
    fn input_run_reorder_cap_respected() {
        let mut peer = new_peer(); // expects 1
        // A gap run far ahead with >64 entries; all buffer, cap holds.
        let entries: Vec<&[u8]> = (0..70).map(|_| b"x".as_slice()).collect();
        let (_applied, queued) = apply_run(&mut peer, 100, &entries);
        assert!(queued.is_empty());
        assert_eq!(peer.keystroke_reorder_buf.len(), KEYSTROKE_REORDER_CAP);
        // Each parked entry is the two-byte text record of `x`.
        assert_eq!(peer.keystroke_reorder_bytes, 2 * KEYSTROKE_REORDER_CAP);
    }

    #[test]
    fn input_run_wraparound() {
        let mut peer = new_peer();
        peer.keystroke_next_expected_seq = u32::MAX;
        peer.keystroke_next_queued_seq = u32::MAX;
        let (applied, queued) = apply_run(&mut peer, u32::MAX, &[b"a", b"b", b"c"]);
        assert_eq!(queued_bytes(&queued), b"abc");
        assert_eq!(peer.keystroke_next_queued_seq, 2);
        assert_eq!(applied.ack_seq, u32::MAX - 1);
        confirm_all(&mut peer, &queued);
        assert_eq!(peer.keystroke_next_expected_seq, 2);
    }

    #[test]
    fn single_keystroke_and_run_share_counter() {
        let mut peer = new_peer();
        let mut queued = Vec::new();
        let mut enqueue = |seq: u32, bytes: &[u8], _shadow_modelled: bool| {
            queued.push((seq, bytes.to_vec()));
            true
        };
        peer.apply_keystroke(1, b"a", false, &mut enqueue);
        // run base=1: entry 1 is a duplicate, 2 and 3 are new.
        let (applied, run_queued) = apply_run(&mut peer, 1, &[b"a", b"b", b"c"]);
        queued.extend(run_queued);
        assert_eq!(queued_bytes(&queued), b"abc");
        assert_eq!(peer.keystroke_next_queued_seq, 4);
        assert_eq!(applied.ack_seq, 0);
        confirm_all(&mut peer, &queued);
        assert_eq!(peer.keystroke_next_expected_seq, 4);
    }

    #[test]
    fn full_fifo_does_not_advance_or_drop_the_expected_sequence() {
        let mut peer = new_peer();
        let mut reject = |_seq: u32, _bytes: &[u8], _shadow_modelled: bool| false;

        let applied = peer.apply_keystroke(1, b"command\r", false, &mut reject);

        assert!(applied.backpressured);
        assert!(!applied.advanced);
        assert_eq!(peer.keystroke_next_queued_seq, 1);
        assert_eq!(peer.keystroke_next_expected_seq, 1);
        assert_eq!(applied.ack_seq, 0);
    }

    #[test]
    fn burst_mixed_single_and_run_frames_queues_each_sequence_once_in_order() {
        let mut peer = new_peer();
        let payloads: Vec<Vec<u8>> = (1..=180)
            .map(|seq| format!("burst_{seq}='{}'; printf M{seq}\\n\r", "x".repeat(32)).into_bytes())
            .collect();
        assert!(payloads.iter().map(Vec::len).sum::<usize>() > 10 * 1024);
        let refs: Vec<&[u8]> = payloads.iter().map(Vec::as_slice).collect();
        let (first, mut queued) = apply_run(&mut peer, 1, &refs[..90]);
        assert!(first.advanced);

        let mut duplicate = |_seq: u32, _bytes: &[u8], _shadow_modelled: bool| {
            panic!("an already queued single frame must not enter the FIFO twice")
        };
        peer.apply_keystroke(45, &payloads[44], false, &mut duplicate);

        let (second, suffix) = apply_run(&mut peer, 80, &refs[79..]);
        assert!(second.advanced);
        queued.extend(suffix);

        assert_eq!(queued.len(), 180);
        assert!(
            queued
                .iter()
                .enumerate()
                .all(|(index, (seq, bytes))| *seq == index as u32 + 1 && bytes == &payloads[index])
        );
        confirm_all(&mut peer, &queued);
        assert_eq!(peer.keystroke_next_expected_seq, 181);
    }

    #[test]
    fn seq_lt_handles_wraparound() {
        assert!(seq_lt(u32::MAX, 0)); // MAX is "behind" 0 across the wrap
        assert!(!seq_lt(0, u32::MAX));
        assert!(seq_lt(4, 5));
        assert!(!seq_lt(5, 5));
    }

    /// Builds a `(browser_initiator, daemon_responder)` established transport
    /// pair through the public e2e handshake API — the same calls the live
    /// handshake handlers make — so the connection-level seal/open helpers can
    /// be exercised against a real Noise transport.
    /// Exact allocation oracle for the inbound terminal open.
    ///
    /// The superseded shape allocated and freed one plaintext buffer per frame.
    /// Production splits the plaintext off a retained per-peer buffer, which is
    /// reclaimed because the owner loop dispatches a message and drops it
    /// before opening the next frame.
    ///
    /// Ignored because the counting allocator is process-wide: run it alone.
    #[test]
    #[ignore = "exact allocation oracle; the counting allocator is process-wide"]
    fn inbound_open_reuses_one_plaintext_buffer() {
        use crate::edge_tunnel::test_allocations;
        const SAMPLES: usize = 500;
        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_ACK).unwrap();
        let plaintext = vec![0x5Au8; 1100];

        let seal_frames = |count: usize| {
            let (mut browser, daemon) = established_e2e_pair();
            let frames: Vec<Vec<u8>> = (0..count)
                .map(|_| browser.seal_datagram(lane, &plaintext).expect("seal"))
                .collect();
            (daemon, frames)
        };

        // Production: borrowed output into an owner-loop scratch, warmed once
        // so first-touch growth is not attributed to steady state.
        let (daemon, frames) = seal_frames(SAMPLES + 1);
        let mut peer = new_peer();
        peer.noise = Some(daemon);
        let mut scratch: Vec<u8> = Vec::new();
        peer.open_terminal_into(
            CHANNEL_DISPLAY_ACK,
            crate::network::peer::DeliveryMode::Datagram,
            &frames[0],
            &mut scratch,
        )
        .expect("warm open");
        test_allocations::begin();
        for frame in &frames[1..] {
            let opened_len = peer
                .open_terminal_into(
                    CHANNEL_DISPLAY_ACK,
                    crate::network::peer::DeliveryMode::Datagram,
                    frame,
                    &mut scratch,
                )
                .expect("open");
            std::hint::black_box(&scratch[..opened_len]);
        }
        let retained = test_allocations::end();

        // Superseded: a fresh zeroed buffer per frame.
        let (mut legacy_transport, legacy_frames) = seal_frames(SAMPLES);
        test_allocations::begin();
        for frame in &legacy_frames {
            let opened = legacy_transport.open_datagram(lane, frame).expect("open");
            std::hint::black_box(&opened);
            drop(opened);
        }
        let legacy = test_allocations::end();

        println!(
            "inbound open allocations/frame: {:.3} -> {:.3}; bytes/frame: {:.1} -> {:.1}",
            legacy.allocations as f64 / SAMPLES as f64,
            retained.allocations as f64 / SAMPLES as f64,
            legacy.allocated_bytes as f64 / SAMPLES as f64,
            retained.allocated_bytes as f64 / SAMPLES as f64,
        );
        assert_eq!(retained.allocations, 0, "retained open must not allocate");
        assert!(legacy.allocations >= SAMPLES);
    }

    /// Cost of opening one inbound terminal frame.
    ///
    /// The owner loop opens every inbound PTY, CTRL, and display-ACK frame at a
    /// single dispatch point. The superseded shape allocated and zero-filled a
    /// fresh plaintext buffer per frame (`vec![0u8; ciphertext.len() - 8]`) and
    /// freed it once the message was dispatched; production now splits the
    /// plaintext off a retained per-peer buffer. Sizes span what this path
    /// actually carries: an 8-byte display ACK, a 64-byte input run, and a
    /// 1,100-byte control/resync frame.
    ///
    /// Both arms run in one process, alternating order, each on its own Noise
    /// pair — opening advances the lane replay window, so they cannot share
    /// sealed frames.
    #[test]
    #[ignore = "production performance workload"]
    fn production_inbound_open_benchmark() {
        let samples = std::env::var("BENCH_SAMPLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(100);
        let batch_size = std::env::var("BENCH_BATCH_SIZE")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(256);
        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_ACK).unwrap();
        let mut checksum = 0usize;

        for plaintext_len in [8usize, 64, 1100] {
            let plaintext = vec![0x5Au8; plaintext_len];
            let mut legacy_samples = Vec::with_capacity(samples);
            let mut retained_samples = Vec::with_capacity(samples);
            let mut borrowed_scratch: Vec<u8> = Vec::new();
            let mut detached_samples = Vec::with_capacity(samples);
            let mut detached_scratch: Vec<u8> = Vec::new();
            let mut ceiling_samples = Vec::with_capacity(samples);
            // Initialised once, outside every timed region.
            let mut ceiling_scratch = vec![0u8; plaintext_len + 64];

            for sample in 0..samples {
                // Setup is outside every timed region.
                let seal_batch = || {
                    let (mut browser, daemon) = established_e2e_pair();
                    let sealed: Vec<Vec<u8>> = (0..batch_size)
                        .map(|_| {
                            browser
                                .seal_datagram(lane, &plaintext)
                                .expect("benchmark seal")
                        })
                        .collect();
                    (daemon, sealed)
                };
                let (mut legacy_transport, legacy_frames) = seal_batch();
                let (retained_daemon, retained_frames) = seal_batch();
                let (mut ceiling_transport, ceiling_frames) = seal_batch();
                let (mut detached_transport, detached_frames) = seal_batch();
                let mut peer = new_peer();
                peer.noise = Some(retained_daemon);

                if sample % 2 == 0 {
                    legacy_samples.push(time_legacy_opens(
                        &mut legacy_transport,
                        lane,
                        &legacy_frames,
                        &mut checksum,
                    ));
                    retained_samples.push(time_borrowed_opens(
                        &mut peer,
                        &retained_frames,
                        &mut borrowed_scratch,
                        &mut checksum,
                    ));
                } else {
                    retained_samples.push(time_borrowed_opens(
                        &mut peer,
                        &retained_frames,
                        &mut borrowed_scratch,
                        &mut checksum,
                    ));
                    legacy_samples.push(time_legacy_opens(
                        &mut legacy_transport,
                        lane,
                        &legacy_frames,
                        &mut checksum,
                    ));
                }
                detached_samples.push(time_detached_opens(
                    &mut detached_transport,
                    CHANNEL_DISPLAY_ACK,
                    &detached_frames,
                    &mut detached_scratch,
                    &mut checksum,
                ));
                ceiling_samples.push(time_ceiling_opens(
                    &mut ceiling_transport,
                    lane,
                    &ceiling_frames,
                    &mut ceiling_scratch,
                    &mut checksum,
                ));
            }

            emit_open_metric(
                &format!("display-inbound-open-legacy-{plaintext_len}b"),
                &mut legacy_samples,
                samples,
            );
            emit_open_metric(
                &format!("display-inbound-open-borrowed-{plaintext_len}b"),
                &mut retained_samples,
                samples,
            );
            emit_open_metric(
                &format!("display-inbound-open-detached-{plaintext_len}b"),
                &mut detached_samples,
                samples,
            );
            emit_open_metric(
                &format!("display-inbound-open-uninit-ceiling-{plaintext_len}b"),
                &mut ceiling_samples,
                samples,
            );
        }
        std::hint::black_box(checksum);
    }

    /// Superseded shape: one fresh zeroed plaintext buffer per frame, freed
    /// after dispatch.
    fn time_legacy_opens(
        transport: &mut crate::e2e::NoiseTransport,
        lane: usize,
        frames: &[Vec<u8>],
        checksum: &mut usize,
    ) -> f64 {
        let started = std::time::Instant::now();
        for frame in frames {
            let plaintext = transport
                .open_datagram(lane, frame)
                .expect("benchmark open");
            *checksum ^= plaintext.len();
            // Every arm barriers on the plaintext BYTES, not on a length or a
            // container handle. Production reads the opened bytes, so a weaker
            // barrier lets the optimiser elide stores a real implementation
            // must make, and silently flatters whichever arm has it.
            std::hint::black_box(&plaintext[..]);
        }
        started.elapsed().as_nanos() as f64 / frames.len() as f64
    }

    /// Production shape: the plaintext is opened into an owner-loop scratch and
    /// dispatched borrowed, so there is no owned handoff and no per-frame
    /// zero-fill once the scratch has reached its high-water length.
    fn time_borrowed_opens(
        peer: &mut PeerDisplayState,
        frames: &[Vec<u8>],
        scratch: &mut Vec<u8>,
        checksum: &mut usize,
    ) -> f64 {
        let started = std::time::Instant::now();
        for frame in frames {
            let plaintext_len = peer
                .open_terminal_into(
                    CHANNEL_DISPLAY_ACK,
                    crate::network::peer::DeliveryMode::Datagram,
                    frame,
                    scratch,
                )
                .expect("benchmark open");
            *checksum ^= plaintext_len;
            std::hint::black_box(&scratch[..plaintext_len]);
        }
        started.elapsed().as_nanos() as f64 / frames.len() as f64
    }

    /// Upper bound on what removing the per-frame output initialisation could
    /// ever buy. The buffer is initialised ONCE outside the timed region and
    /// reused in place, so this arm pays no `resize` memset and also skips the
    /// owned handoff entirely. It is deliberately not a shippable shape — the
    /// opened plaintext is never handed to a caller — it exists only to bound
    /// the ceiling before deciding whether an uninitialised-output refactor is
    /// worth its complexity.
    fn time_ceiling_opens(
        transport: &mut crate::e2e::NoiseTransport,
        lane: usize,
        frames: &[Vec<u8>],
        scratch: &mut [u8],
        checksum: &mut usize,
    ) -> f64 {
        let started = std::time::Instant::now();
        for frame in frames {
            let plaintext_len = transport
                .open_into(
                    lane,
                    true,
                    frame,
                    &mut scratch[..frame.len().saturating_sub(8)],
                )
                .expect("benchmark open");
            *checksum ^= plaintext_len;
            std::hint::black_box(&scratch[..plaintext_len]);
        }
        started.elapsed().as_nanos() as f64 / frames.len() as f64
    }

    /// Diagnostic: byte-for-byte the body of `open_terminal_into`, but against a
    /// free-standing `NoiseTransport` instead of one living inside a
    /// `PeerDisplayState`. Splits the candidate's remaining gap to the ceiling
    /// into "the function's own bookkeeping" (ceiling -> detached) and
    /// "reaching the Noise state through the peer struct" (detached ->
    /// borrowed).
    fn time_detached_opens(
        transport: &mut crate::e2e::NoiseTransport,
        channel_id: u8,
        frames: &[Vec<u8>],
        scratch: &mut Vec<u8>,
        checksum: &mut usize,
    ) -> f64 {
        let started = std::time::Instant::now();
        for frame in frames {
            let lane = crate::e2e::lane_for_channel(channel_id).expect("lane");
            let capacity = frame.len().saturating_sub(8);
            if scratch.len() < capacity {
                scratch.resize(capacity, 0);
            }
            let plaintext_len = transport
                .open_into(lane, true, frame, &mut scratch[..capacity])
                .expect("benchmark open");
            *checksum ^= plaintext_len;
            std::hint::black_box(&scratch[..plaintext_len]);
        }
        started.elapsed().as_nanos() as f64 / frames.len() as f64
    }

    fn emit_open_metric(name: &str, samples: &mut [f64], sample_size: usize) {
        samples.sort_by(f64::total_cmp);
        let percentile = |ratio: f64| {
            let index = ((samples.len() as f64 * ratio).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len().saturating_sub(1));
            samples[index]
        };
        for ratio in [0.50, 0.95, 0.99] {
            let value = percentile(ratio);
            println!(
                "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value},\"unit\":\"ns/op\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{sample_size}}}"
            );
        }
    }

    fn established_e2e_pair() -> (crate::e2e::NoiseTransport, crate::e2e::NoiseTransport) {
        let psk = [7u8; 32];
        let prologue = crate::e2e::derive_prologue("sess", "daemon", &[0x42; 64]);
        let (browser_static, _) = crate::e2e::generate_static_keypair().unwrap();
        let (daemon_static, _) = crate::e2e::generate_static_keypair().unwrap();
        let mut init =
            crate::e2e::NoiseHandshake::new_initiator(&browser_static, &psk, &prologue).unwrap();
        let mut resp =
            crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue).unwrap();
        resp.read_message(&init.write_message(b"").unwrap())
            .unwrap();
        init.read_message(&resp.write_message(b"").unwrap())
            .unwrap();
        resp.read_message(&init.write_message(b"").unwrap())
            .unwrap();
        (
            init.into_transport().unwrap(),
            resp.into_transport().unwrap(),
        )
    }

    #[test]
    fn seal_and_open_helpers_gate_on_e2e_readiness() {
        let mut peer = new_peer();
        // Before E2E: not ready; every seal returns None (callers drop the send
        // rather than emit plaintext terminal data).
        assert!(!peer.is_e2e_ready());
        assert!(peer.seal_stream(CHANNEL_PTY, b"x").is_none());
        assert!(peer.seal_datagram(CHANNEL_DISPLAY_DATAGRAM, b"x").is_none());
        assert!(
            peer.seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, b"x")
                .is_none()
        );

        // Install a daemon-side transport (as `handle_noise_final` does) and a
        // matching browser side to produce real ciphertext to open.
        let (mut browser, daemon) = established_e2e_pair();
        peer.noise = Some(daemon);
        assert!(peer.is_e2e_ready());

        // Daemon seals a PTY stream frame; the browser opens it on the same lane.
        let sealed = peer
            .seal_stream(CHANNEL_PTY, b"ack")
            .expect("e2e ready -> Some");
        let lane = crate::e2e::lane_for_channel(CHANNEL_PTY).unwrap();
        assert_eq!(browser.open_stream(lane, &sealed).unwrap(), b"ack");

        // A channel with no lane (signaling) is never sealed.
        assert!(peer.seal_stream(CHANNEL_SIGNALING, b"x").is_none());
    }

    #[test]
    fn channel_framed_datagram_seal_is_exact_and_advances_once() {
        let mut peer = new_peer();
        let (mut browser, daemon) = established_e2e_pair();
        peer.noise = Some(daemon);
        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();

        let first = peer
            .seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, b"first")
            .expect("established transport");
        assert_eq!(first[0], CHANNEL_DISPLAY_DATAGRAM);
        assert_eq!(u64::from_be_bytes(first[1..9].try_into().unwrap()), 0);
        assert_eq!(browser.open_datagram(lane, &first[1..]).unwrap(), b"first");
        assert_eq!(
            browser.open_datagram(lane, &first[1..]),
            Err(crate::e2e::OpenReject::Replay)
        );

        let second = peer
            .seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, b"second")
            .expect("established transport");
        assert_eq!(second[0], CHANNEL_DISPLAY_DATAGRAM);
        assert_eq!(u64::from_be_bytes(second[1..9].try_into().unwrap()), 1);
        assert_eq!(
            browser.open_datagram(lane, &second[1..]).unwrap(),
            b"second"
        );
        assert!(
            peer.seal_datagram_wire(CHANNEL_SIGNALING, b"unmapped")
                .is_none()
        );
    }

    #[test]
    fn reused_wire_buffer_seals_exactly_and_never_reallocates() {
        // The retained buffer keeps its high-water length, so a small frame
        // sealed after a large one leaves the previous frame's tail in place.
        // The returned length is the only valid bound: `wire[..len]` must open
        // cleanly, and the residue past `len` must not be part of the frame.
        let mut peer = new_peer();
        let (mut browser, daemon) = established_e2e_pair();
        peer.noise = Some(daemon);
        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();

        let mut wire = Vec::new();
        let large = vec![0xA5u8; 900];
        let large_len = peer
            .seal_datagram_wire_into(&mut wire, CHANNEL_DISPLAY_DATAGRAM, &large)
            .expect("established transport");
        assert_eq!(large_len, 1 + large.len() + crate::e2e::FRAME_OVERHEAD);
        assert_eq!(wire.len(), large_len);
        assert_eq!(
            browser.open_datagram(lane, &wire[1..large_len]).unwrap(),
            large
        );

        let high_water = wire.len();
        let capacity = wire.capacity();
        let residue_probe = wire[high_water - 32..].to_vec();
        let small_len = peer
            .seal_datagram_wire_into(&mut wire, CHANNEL_DISPLAY_DATAGRAM, b"small")
            .expect("established transport");
        // No regrowth, no truncation: the second frame reuses the same bytes.
        assert_eq!(wire.len(), high_water);
        assert_eq!(wire.capacity(), capacity);
        assert!(small_len < high_water);
        assert_eq!(wire[0], CHANNEL_DISPLAY_DATAGRAM);
        assert_eq!(u64::from_be_bytes(wire[1..9].try_into().unwrap()), 1);
        // The small seal wrote only its own prefix: the previous frame's tail
        // is still sitting past `small_len`. That residue is exactly why the
        // returned length is the sole valid bound, and why an AEAD-clean open
        // of `wire[1..small_len]` is the proof that none of it leaked inside
        // the frame — a single wrong byte there fails the tag.
        assert_eq!(wire[high_water - 32..], residue_probe[..]);
        assert_eq!(
            browser.open_datagram(lane, &wire[1..small_len]).unwrap(),
            b"small"
        );

        // A channel with no Noise lane leaves the buffer untouched and burns no
        // counter, so the next real frame still advances by exactly one.
        assert!(
            peer.seal_datagram_wire_into(&mut wire, CHANNEL_SIGNALING, b"unmapped")
                .is_none()
        );
        assert_eq!(wire.len(), high_water);
        let next_len = peer
            .seal_datagram_wire_into(&mut wire, CHANNEL_DISPLAY_DATAGRAM, b"next")
            .expect("established transport");
        assert_eq!(u64::from_be_bytes(wire[1..9].try_into().unwrap()), 2);
        assert_eq!(
            browser.open_datagram(lane, &wire[1..next_len]).unwrap(),
            b"next"
        );
    }

    #[test]
    fn open_terminal_picks_sub_lane_from_delivery_mode() {
        let mut peer = new_peer();
        let (mut browser, daemon) = established_e2e_pair();
        peer.noise = Some(daemon);
        let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_ACK).unwrap();

        // Datagram delivery opens on the datagram sub-lane. The scratch is
        // sliced by the returned length, never by its own len: it keeps the
        // high-water length so a steady frame pays no zero-fill.
        let mut scratch: Vec<u8> = Vec::new();
        let framed = browser.seal_datagram(lane, b"dgram").unwrap();
        let opened = peer
            .open_terminal_into(
                CHANNEL_DISPLAY_ACK,
                crate::network::peer::DeliveryMode::Datagram,
                &framed,
                &mut scratch,
            )
            .expect("datagram sub-lane opens");
        assert_eq!(&scratch[..opened], b"dgram");

        // A shorter following frame must not inherit the previous plaintext's
        // tail: the returned length is the only valid bound.
        let high_water = scratch.len();
        let framed_short = browser.seal_datagram(lane, b"hi").unwrap();
        let opened_short = peer
            .open_terminal_into(
                CHANNEL_DISPLAY_ACK,
                crate::network::peer::DeliveryMode::Datagram,
                &framed_short,
                &mut scratch,
            )
            .expect("short frame opens");
        assert_eq!(&scratch[..opened_short], b"hi");
        assert_eq!(scratch.len(), high_water, "scratch must not shrink");

        // Opening the same datagram bytes as a stream fails (disjoint sub-lane).
        let framed2 = browser.seal_datagram(lane, b"dgram2").unwrap();
        assert!(
            peer.open_terminal_into(
                CHANNEL_DISPLAY_ACK,
                crate::network::peer::DeliveryMode::Stream,
                &framed2,
                &mut scratch,
            )
            .is_err()
        );

        // Not-ready peer opens nothing.
        let mut fresh = new_peer();
        assert!(
            fresh
                .open_terminal_into(
                    CHANNEL_DISPLAY_ACK,
                    crate::network::peer::DeliveryMode::Datagram,
                    &framed,
                    &mut scratch,
                )
                .is_err()
        );
    }

    #[test]
    fn reliable_edge_tunnel_prefers_conn1_until_conn2_confirmed() {
        let (tx1, _rx1) = tokio::sync::mpsc::unbounded_channel();
        let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
        let conn1 = Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx1));
        let conn2 = Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx2));

        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::WebTransport);
        peer.edge_tunnel = Some(conn1.clone());
        peer.edge_tunnel_bulk = Some(conn2.clone());

        // Unconfirmed conn2 → reliable rides conn1 (proven-delivering lane).
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &conn1));

        // Confirmed conn2 → reliable rides conn2 (off the datagram lane).
        // There is no longer a suspect-lane override: its only arming signal
        // was a NACK naming a bulk-lane seq.
        peer.bulk_delivery_confirmed = true;
        assert!(Arc::ptr_eq(&peer.reliable_edge_tunnel().unwrap(), &conn2));

        // No edge at all → None (peer not relayed).
        peer.edge_tunnel = None;
        peer.edge_tunnel_bulk = None;
        assert!(peer.reliable_edge_tunnel().is_none());
    }

    #[test]
    fn k1_replication_demotes_only_after_thirty_two_successful_probes() {
        let mut evidence = FecEvidence::default();
        assert_eq!(evidence.decide_k1(), K1ProtectionDecision::Single);

        evidence.observe(
            DisplayDatagramProtection::Unprotected,
            DisplayDatagramOutcome::Lost,
        );
        assert!(evidence.replication_enabled());

        // Clean ordinary and coded traffic is not a k=1 experiment and cannot
        // bypass the explicit probe criterion.
        for _ in 0..64 {
            evidence.observe(
                DisplayDatagramProtection::Fec,
                DisplayDatagramOutcome::Received,
            );
        }
        assert!(evidence.replication_enabled());

        for _ in 0..31 {
            evidence.observe(
                DisplayDatagramProtection::K1Probe,
                DisplayDatagramOutcome::Received,
            );
        }
        assert!(evidence.replication_enabled());
        evidence.observe(
            DisplayDatagramProtection::K1Probe,
            DisplayDatagramOutcome::Received,
        );
        assert!(!evidence.replication_enabled());
    }

    #[test]
    fn failed_probe_breaks_the_clean_streak_and_replicated_ack_is_censored() {
        let mut evidence = FecEvidence::default();
        evidence.observe(
            DisplayDatagramProtection::Unprotected,
            DisplayDatagramOutcome::Lost,
        );
        evidence.observe(
            DisplayDatagramProtection::K1Replicated {
                owner: PeerTransport::Edge,
            },
            DisplayDatagramOutcome::Received,
        );
        assert_eq!(evidence.censored, 1);
        assert_eq!(evidence.received, 0);

        for _ in 0..31 {
            evidence.observe(
                DisplayDatagramProtection::K1Probe,
                DisplayDatagramOutcome::Received,
            );
        }
        evidence.observe(
            DisplayDatagramProtection::K1Probe,
            DisplayDatagramOutcome::Unknown,
        );
        for _ in 0..31 {
            evidence.observe(
                DisplayDatagramProtection::K1Probe,
                DisplayDatagramOutcome::Received,
            );
        }
        assert!(evidence.replication_enabled());

        evidence.observe(
            DisplayDatagramProtection::Fec,
            DisplayDatagramOutcome::Recovered,
        );
        for _ in 0..31 {
            evidence.observe(
                DisplayDatagramProtection::K1Probe,
                DisplayDatagramOutcome::Received,
            );
        }
        assert!(
            evidence.replication_enabled(),
            "FEC recovery is adverse evidence and must break the clean interval"
        );
    }

    #[test]
    fn dual_k1_loss_reaches_its_owner_and_breaks_the_clean_probe_streak() {
        let owner = PeerTransport::Edge;
        let mut peer = new_peer();
        peer.display_cache.fec_evidence.get_mut(owner).observe(
            DisplayDatagramProtection::Unprotected,
            DisplayDatagramOutcome::Lost,
        );
        for _ in 0..31 {
            peer.display_cache.fec_evidence.get_mut(owner).observe(
                DisplayDatagramProtection::K1Probe,
                DisplayDatagramOutcome::Received,
            );
        }
        assert_eq!(
            peer.display_cache
                .fec_evidence
                .get(owner)
                .replication_progress()
                .2,
            31,
        );

        let dual = SentDatagram {
            sent_at_ms: 1.0,
            rows: SentRows::default(),
            sent_via: SentPaths {
                webtransport: true,
                edge: true,
            },
            reliable: false,
            header_only: true,
            protection: DisplayDatagramProtection::K1Replicated { owner },
        };
        assert_eq!(dual.outcome_path(), None);
        assert_eq!(dual.evidence_path(), Some(owner));
        peer.display_cache
            .record_datagram_outcome(&dual, DisplayDatagramOutcome::Lost);
        let evidence = peer.display_cache.fec_evidence.get(owner);
        assert!(evidence.replication_enabled());
        assert_eq!(evidence.replication_progress(), (0, 0, 0));

        for _ in 0..31 {
            peer.display_cache.fec_evidence.get_mut(owner).observe(
                DisplayDatagramProtection::K1Probe,
                DisplayDatagramOutcome::Received,
            );
        }
        assert!(
            peer.display_cache
                .fec_evidence
                .get(owner)
                .replication_enabled(),
            "the pre-loss clean streak must not bridge the owned dual loss"
        );
        peer.display_cache.fec_evidence.get_mut(owner).observe(
            DisplayDatagramProtection::K1Probe,
            DisplayDatagramOutcome::Received,
        );
        assert!(
            !peer
                .display_cache
                .fec_evidence
                .get(owner)
                .replication_enabled()
        );
    }

    #[test]
    fn path_evidence_survives_display_resize_and_resets_independently() {
        let mut peer = new_peer();
        for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
            peer.display_cache.fec_evidence.get_mut(path).observe(
                DisplayDatagramProtection::Unprotected,
                DisplayDatagramOutcome::Lost,
            );
        }
        peer.display_cache.resize(80, 24);
        assert!(
            peer.display_cache
                .fec_evidence
                .get(PeerTransport::WebTransport)
                .replication_enabled()
        );
        assert!(
            peer.display_cache
                .fec_evidence
                .get(PeerTransport::Edge)
                .replication_enabled()
        );

        peer.reset_fec_evidence(PeerTransport::WebTransport);
        assert!(
            !peer
                .display_cache
                .fec_evidence
                .get(PeerTransport::WebTransport)
                .replication_enabled()
        );
        assert!(
            peer.display_cache
                .fec_evidence
                .get(PeerTransport::Edge)
                .replication_enabled()
        );
        peer.reset_fec_evidence(PeerTransport::Edge);
        assert!(
            !peer
                .display_cache
                .fec_evidence
                .get(PeerTransport::Edge)
                .replication_enabled()
        );
    }
}
