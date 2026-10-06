//! Delivery model for an egress group, derived from draft-ietf-ccwg-bbr-06
//! (BBRv3). This is a distinct control law, with these explicit departures:
//!
//! * All member connections share one delivery ledger. Application limits,
//!   reservations, in-flight bytes and interactive demand are ledger facts.
//! * Interactive packets retain cwnd admission and bypass the bulk pacer. Bulk
//!   repays their pacing debt and stops probing as soon as input is admitted.
//! * Bulk's cruising window is the measured low-load pipe plus one packetization
//!   quantum and at most one quantum of measured ACK aggregation. A delayed ACK
//!   cannot permanently turn a large receive-side burst into a network queue.
//!   The ordinary congestion window still accommodates stretched ACKs.
//! * An UP probe spends at most one quantum of excess before waiting for a
//!   round of delivery growth. REFILL starts only while interactive work is
//!   absent. It releases a queue-derived rate limit to test available capacity,
//!   but retains a limit established by explicit congestion notification.
//! * Drain admits no bulk until flight fits the measured pipe. ProbeRTT holds
//!   bulk to half a pipe for 200 ms and a round, using only RTT observations of
//!   packets sent after that low-load interval began. An empty-flight sample
//!   also refreshes the low-load measurement without a scheduled probe.
//! * The path generation retains its peak observed capacity. Queue and CE
//!   bounds constrain the current rate independently; our own pacing limit does
//!   not repeatedly age the capacity estimate downward. A later unloaded RTT
//!   can retract a queue inference without removing an explicit CE bound.
//! * Loss bounds non-growing Startup/UP flights and persistent congestion.
//!   Cruising loss headroom cannot shrink below the measured pipe; ordinary
//!   erasure does not repeatedly reduce bandwidth on an unqueued link.
//!
//! The one-millisecond quantum bounds local bursts, not timer resolution. The
//! runtime wakes at the next packet's deadline. Neither pacing nor a flight
//! window can preempt other traffic or prevent downstream packet compression.

use rand::{RngExt, SeedableRng};
use rand_pcg::Pcg32;

use super::bbr::min_max::MinMax;
use super::delivery::{PacketRate, RateSample};
use crate::{Duration, Instant};

/// Startup's pacing gain, 4·ln 2: doubles delivery per round.
const STARTUP_PACING_GAIN: f64 = 2.77;
/// Every phase's cwnd gain: two BDP absorb delayed and stretched ACKs.
const CWND_GAIN: f64 = 2.0;
/// ProbeBW_UP's pacing gain.
const UP_PACING_GAIN: f64 = 1.25;
/// The pacer runs 1% under the model's rate, so its own queue drains.
const PACING_MARGIN: f64 = 0.99;
/// Multiplicative decrease of the short-term bounds on loss or CE.
const BETA: f64 = 0.7;
/// Headroom left under the long-term bound while cruising.
const HEADROOM: f64 = 0.15;
/// Loss above this share of a flight marks it too high.
const LOSS_THRESH: f64 = 0.02;
/// Startup's loss exit needs this many lost ranges in the round.
const STARTUP_FULL_LOSS_COUNT: u64 = 6;
/// Rounds of less than 25% growth that fill the pipe.
const FULL_BW_COUNT: u32 = 3;
const FULL_BW_GROWTH: f64 = 1.25;
/// The extra-acked filter spans ten rounds.
const EXTRA_ACKED_FILTER_ROUNDS: u64 = 10;
const MIN_RTT_FILTER: Duration = Duration::from_secs(10);
const PROBE_RTT_INTERVAL: Duration = Duration::from_secs(5);
const PROBE_RTT_DURATION: Duration = Duration::from_millis(200);
/// ProbeRTT holds bulk to half a BDP.
const PROBE_RTT_CWND_GAIN: f64 = 0.5;
/// A pacing quantum is one millisecond of the pacing rate.
const QUANTUM_INTERVAL: Duration = Duration::from_millis(1);
/// ...and at most one 64 KiB GSO batch.
const MAX_QUANTUM: u64 = 64 * 1024;
/// The draft's randomized probe wait: two seconds plus up to one more.
const PROBE_WAIT_BASE: Duration = Duration::from_secs(2);
const PROBE_WAIT_SPREAD_MS: u64 = 1_000;
/// Reno coexistence caps the rounds between probes.
const MAX_RENO_ROUNDS: u64 = 63;

/// Where the control law is. Numbered for the wire (`MSG_TYPE_PERF_EGRESS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EgressPhase {
    /// Doubling delivery per round, once per path generation. Ungated.
    Startup = 0,
    /// Startup's queue draining: no bulk until flight is down to `bw·RTprop`.
    Drain = 1,
    /// A probe's queue draining, the same way.
    Down = 2,
    /// Pacing at `bw`, with a bounded ACK and packetization allowance.
    Cruise = 3,
    /// Re-testing a queue bound, pacing at `bw` until a quiet round start.
    Refill = 4,
    /// Probing at 1.25·bw, only from a quiet round start.
    Up = 5,
    /// Bulk held to half a BDP to re-measure RTprop.
    ProbeRtt = 6,
}

/// Cumulative event counts over the model's life.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EgressModelCounters {
    /// REFILL round starts that could not probe: interactive work was in
    /// flight, reserved or ready.
    pub probes_gated: u64,
    /// UP phases an interactive admission ended.
    pub probes_aborted: u64,
    /// Interactive admissions while the group intended a queue: Startup,
    /// Drain, UP, or DOWN's drain.
    pub interactive_in_probe: u64,
    /// Short-term cuts to measured delivery after a round of queue growth.
    pub queue_growth_cuts: u64,
    /// Non-application-limited Cruise rounds that observed loss.
    pub loss_rounds: u64,
    /// Rounds whose CE marks lowered the short-term bounds.
    pub ce_rounds: u64,
    /// ProbeRTT phases run (not the quiescent samples that pre-empted them).
    pub probe_rtts: u64,
}

/// One acknowledgment-frame RTT sample, adjusted for the peer's ACK delay as
/// RFC 9002 does, and whether its packet had any of the group's flight ahead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RttSample {
    pub(crate) sent: Instant,
    pub(crate) rtt: Duration,
    pub(crate) quiescent: bool,
}

/// What one round saw, for the round-end rules.
#[derive(Clone, Copy, Debug)]
struct Round {
    /// Every rate sample in the round was application limited.
    app_limited: bool,
    /// The peak delivery rate when the round started.
    max_bw_at_start: u64,
    min_rtt: Option<Duration>,
    lost_bytes: u64,
    loss_ranges: u64,
    ce: bool,
    /// A lost packet whose flight lost more than LossThresh of it, with that
    /// packet's flight.
    too_high: Option<u64>,
}

impl Round {
    fn new(max_bw: u64) -> Self {
        Self {
            app_limited: true,
            max_bw_at_start: max_bw,
            min_rtt: None,
            lost_bytes: 0,
            loss_ranges: 0,
            ce: false,
            too_high: None,
        }
    }
}

/// The group's model and its control outputs.
#[derive(Clone, Debug)]
pub(crate) struct EgressModel {
    mtu: u64,
    phase: EgressPhase,
    filled_pipe: bool,
    // Bandwidth.
    peak_bw: u64,
    /// Before any sample: the interactive connection's cwnd/srtt.
    seed_bw: u64,
    bw: u64,
    bw_latest: u64,
    inflight_latest: u64,
    bw_shortterm: Option<u64>,
    queue_bw: Option<u64>,
    inflight_shortterm: Option<u64>,
    inflight_longterm: Option<u64>,
    // Rounds.
    round_count: u64,
    next_round_delivered: u64,
    round_start: bool,
    round: Round,
    /// `inflight_latest` of the last growth round in UP.
    growth_inflight: Option<u64>,
    /// Rounds UP has ended. The first measured packets sent before the probe.
    up_rounds: u32,
    /// Bulk bytes allowed at the UP rate before waiting for delivery growth.
    up_bytes_left: u64,
    // RTprop and ProbeRTT.
    min_rtt: Duration,
    /// RTTs observed without any of our packets ahead include propagation
    /// variation. A standing queue must exceed that measured envelope, not
    /// merely the least propagation sample ever seen on this path.
    queue_rtt: Duration,
    /// Minimum RTT from the latest low-load measurement, including queues
    /// maintained by other flows that our own drain cannot remove.
    pipe_rtt: Duration,
    probe_max: Duration,
    /// RTT evidence for the queue-derived bound, independent of CE.
    queue_cut_rtt: Option<Duration>,
    min_rtt_stamp: Instant,
    /// The least sample since the last quiescent sample or ProbeRTT.
    probe_min: Duration,
    /// The last quiescent sample or completed ProbeRTT.
    probe_rtt_stamp: Instant,
    probe_rtt_started: Option<Instant>,
    probe_rtt_done: Option<Instant>,
    probe_rtt_round_done: bool,
    probe_rtt_saved_cwnd: u64,
    // ACK aggregation.
    extra_acked: MinMax,
    extra_acked_start: Instant,
    extra_acked_delivered: u64,
    // Full bandwidth in Startup.
    full_bw: u64,
    full_bw_count: u32,
    // ProbeBW cycle.
    cycle_stamp: Instant,
    rounds_since_probe: u64,
    probe_wait: Duration,
    probe_up_rounds: u32,
    probe_up_acks: u64,
    probe_up_cnt: u64,
    // Recovery, for Startup's loss exit.
    recovery_round: Option<u64>,
    // Outputs.
    cwnd: u64,
    pacing_rate: u64,
    quantum: u64,
    /// Bulk admits nothing until flight is down to `bw·RTprop` (Δ5, Δ7).
    draining: bool,
    /// A standing-queue cut may fire; re-armed when a round fits a pacing burst.
    cut_armed: bool,
    /// Delivery frontier covering packets outstanding at the first queue cut.
    /// Only their remaining feedback can refine that cut; a competing flow's
    /// standing queue must not repeatedly ratchet our bandwidth downward.
    queue_refinement_until: Option<u64>,
    rng: Pcg32,
    counters: EgressModelCounters,
}

impl EgressModel {
    /// A model for a fresh path generation, seeded from the interactive
    /// connection: its minimum RTT, congestion window and smoothed RTT.
    pub(crate) fn new(
        now: Instant,
        mtu: u16,
        min_rtt: Duration,
        cwnd: u64,
        srtt: Duration,
        seed: u64,
    ) -> Self {
        let mtu = u64::from(mtu);
        let seed_bw = rate(cwnd, srtt.max(Duration::from_micros(1)));
        let mut rng = Pcg32::seed_from_u64(seed);
        let probe_wait =
            PROBE_WAIT_BASE + Duration::from_millis(rng.random_range(0..PROBE_WAIT_SPREAD_MS));
        let mut model = Self {
            mtu,
            phase: EgressPhase::Startup,
            filled_pipe: false,
            peak_bw: 0,
            seed_bw,
            bw: seed_bw,
            bw_latest: 0,
            inflight_latest: 0,
            bw_shortterm: None,
            queue_bw: None,
            inflight_shortterm: None,
            inflight_longterm: None,
            round_count: 0,
            next_round_delivered: 0,
            round_start: false,
            round: Round::new(0),
            growth_inflight: None,
            up_rounds: 0,
            up_bytes_left: 0,
            min_rtt,
            queue_rtt: min_rtt.max(srtt),
            pipe_rtt: min_rtt,
            probe_max: Duration::ZERO,
            queue_cut_rtt: None,
            min_rtt_stamp: now,
            probe_min: min_rtt,
            probe_rtt_stamp: now,
            probe_rtt_started: None,
            probe_rtt_done: None,
            probe_rtt_round_done: false,
            probe_rtt_saved_cwnd: 0,
            extra_acked: MinMax::new(EXTRA_ACKED_FILTER_ROUNDS),
            extra_acked_start: now,
            extra_acked_delivered: 0,
            full_bw: 0,
            full_bw_count: 0,
            cycle_stamp: now,
            rounds_since_probe: 0,
            probe_wait,
            probe_up_rounds: 0,
            probe_up_acks: 0,
            probe_up_cnt: u64::MAX,
            recovery_round: None,
            cwnd: cwnd.max(4 * mtu),
            pacing_rate: 0,
            quantum: mtu,
            draining: false,
            cut_armed: true,
            queue_refinement_until: None,
            rng,
            counters: EgressModelCounters::default(),
        };
        model.pacing_rate = scale(seed_bw, STARTUP_PACING_GAIN * PACING_MARGIN);
        model.update_quantum();
        model
    }

    pub(crate) fn is_measurement_limited(&self) -> bool {
        self.draining || self.phase == EgressPhase::ProbeRtt
    }

    pub(crate) fn phase(&self) -> EgressPhase {
        self.phase
    }

    pub(crate) fn counters(&self) -> EgressModelCounters {
        self.counters
    }

    /// The model's bandwidth, bytes per second.
    pub(crate) fn bw(&self) -> u64 {
        self.bw
    }

    pub(crate) fn min_rtt(&self) -> Duration {
        self.min_rtt
    }

    /// Bytes per second the group's pacer admits bulk at.
    pub(crate) fn pacing_rate(&self) -> u64 {
        self.pacing_rate
    }

    /// One pacing burst: a millisecond of the pacing rate, within one MTU and
    /// one GSO batch.
    pub(crate) fn quantum(&self) -> u64 {
        self.quantum
    }

    /// The window interactive packets answer to: the draft's cwnd, without
    /// ProbeRTT's reduction, which is bulk's alone.
    pub(crate) fn cwnd(&self) -> u64 {
        self.cwnd
    }

    /// The flight bulk may bring the group to.
    pub(crate) fn bulk_cap(&self) -> u64 {
        let bdp = bytes_in(self.bw, self.pipe_rtt);
        let floor = self.min_pipe_cwnd();
        let cap = match self.phase {
            EgressPhase::Startup => self.cwnd,
            EgressPhase::ProbeRtt => self.probe_rtt_cwnd(),
            _ if self.draining => bdp.max(floor),
            // Packetization needs one quantum. ACK bunching gets at most one
            // more; the full ACK aggregation allowance belongs to cwnd.
            _ => bdp
                .saturating_add(self.quantum)
                .saturating_add(self.extra_acked.get().min(self.quantum)),
        };
        cap.max(floor).min(self.cwnd)
    }

    /// The image bytes a member may hold unacknowledged: bulk's cap and the
    /// quantum being paced out.
    pub(crate) fn image_window(&self) -> u64 {
        self.bulk_cap().saturating_add(self.quantum)
    }

    pub(crate) fn on_mtu_update(&mut self, mtu: u16) {
        self.mtu = u64::from(mtu);
        self.update_quantum();
    }

    /// An interactive packet was admitted. A probe's queue is the only one
    /// bulk means to build, so UP ends at once and drains.
    pub(crate) fn interactive_admitted(&mut self, now: Instant) {
        match self.phase {
            EgressPhase::Up => {
                self.counters.interactive_in_probe += 1;
                self.counters.probes_aborted += 1;
                self.start_down(now);
            }
            EgressPhase::Startup | EgressPhase::Drain => {
                self.counters.interactive_in_probe += 1;
            }
            EgressPhase::Down if self.draining => self.counters.interactive_in_probe += 1,
            _ => {}
        }
    }

    /// A lost packet (the largest of a detection batch) sent with `rate`;
    /// `lost_total` includes `bytes`, and `ranges` counts the batch's
    /// discontiguous losses.
    pub(crate) fn on_loss(
        &mut self,
        bytes: u64,
        rate: &PacketRate,
        lost_total: u64,
        ranges: u64,
        persistent: bool,
    ) {
        self.round.lost_bytes += bytes;
        self.round.loss_ranges += ranges;
        let lost = rate.lost_since(lost_total);
        let tx_in_flight = rate.tx_in_flight();
        if lost as f64 > tx_in_flight.max(1) as f64 * LOSS_THRESH {
            self.round.too_high = Some(
                self.round
                    .too_high
                    .map_or(tx_in_flight, |flight| flight.max(tx_in_flight)),
            );
        }
        // Recovery opens in this round; Startup's loss exit needs it open
        // across a whole earlier round.
        self.recovery_round.get_or_insert(self.round_count);
        if persistent {
            // RFC 9002 §7.6: collapse to the minimum window.
            self.cwnd = self.min_pipe_cwnd();
        }
    }

    /// The peer's CE count rose.
    pub(crate) fn on_ce(&mut self) {
        self.round.ce = true;
    }

    /// One acknowledgment frame, after its packets retired: its rate sample
    /// (if valid), its RTT sample, the group's flight now, whether the ledger
    /// shows no interactive work, and the group's delivered total.
    pub(crate) fn on_end_acks(
        &mut self,
        now: Instant,
        sample: Option<RateSample>,
        rtt: Option<RttSample>,
        flight: u64,
        quiet: bool,
        delivered: u64,
    ) {
        if let Some(sample) = sample {
            self.bw_latest = self.bw_latest.max(sample.delivery_rate);
            self.inflight_latest = self.inflight_latest.max(sample.delivered);
            self.round_start = sample.prior_delivered >= self.next_round_delivered;
            if self.round_start {
                self.next_round_delivered = delivered;
                self.round_count += 1;
                self.rounds_since_probe += 1;
                self.end_round(now, flight);
                if self
                    .queue_refinement_until
                    .is_some_and(|until| sample.prior_delivered >= until)
                {
                    self.queue_refinement_until = None;
                }
                self.round = Round::new(self.peak_bw);
            }
            self.round.app_limited &= sample.app_limited;
            self.peak_bw = self.peak_bw.max(sample.delivery_rate);
            if self.phase == EgressPhase::Up {
                for bound in [&mut self.bw_shortterm, &mut self.queue_bw] {
                    if bound.is_some_and(|bound| sample.delivery_rate > bound) {
                        *bound = Some(sample.delivery_rate);
                    }
                }
            }
            self.update_ack_aggregation(now, sample.newly_acked);
            self.check_full_bw(&sample);
        } else {
            self.round_start = false;
        }
        if let Some(rtt) = rtt {
            self.observe_rtt(now, rtt);
        }
        self.bound_bw();
        self.check_drain(now, flight);
        self.update_probe_bw(now, sample.as_ref(), flight, quiet, delivered);
        self.check_probe_rtt(now, flight, delivered);
        if let Some(sample) = sample.filter(|_| self.round_start) {
            // The next round's latest signals start from this sample.
            self.bw_latest = sample.delivery_rate;
            self.inflight_latest = sample.delivered;
        }
        self.bound_bw();
        self.update_pacing_rate();
        self.update_quantum();
        self.update_cwnd(sample.map_or(0, |sample| sample.newly_acked), delivered);
    }

    // ------------------------------------------------------------------
    // Rounds (Δ6, Δ7)
    // ------------------------------------------------------------------

    /// The round that just ended, read once: growth, loss, CE, queue growth.
    fn end_round(&mut self, now: Instant, flight: u64) {
        let round = self.round;
        // The round being read is the one before the round that just started.
        let ended = self.round_count - 1;
        let growth = !round.app_limited && self.bw_latest > round.max_bw_at_start;
        let lossy = round.lost_bytes > 0;
        let recovering_since_earlier_round =
            self.recovery_round.is_some_and(|started| started < ended);
        if !lossy {
            self.recovery_round = None;
        }
        match self.phase {
            EgressPhase::Startup => {
                // Δ6: loss is congestion only where delivery stopped growing.
                if !growth
                    && !round.app_limited
                    && round.loss_ranges >= STARTUP_FULL_LOSS_COUNT
                    && round.too_high.is_some()
                    && recovering_since_earlier_round
                {
                    self.filled_pipe = true;
                    let bdp = self.bdp(self.peak_bw, 1.0);
                    self.inflight_longterm = Some(bdp.max(self.inflight_latest));
                }
            }
            EgressPhase::Up => {
                self.up_rounds += 1;
                if self.up_rounds == 1 {
                    // This round ended when the first packet UP paced was
                    // acknowledged: its samples measured the pace before it.
                } else if growth {
                    self.arm_up_budget();
                    self.growth_inflight = Some(self.inflight_latest);
                } else if !round.app_limited {
                    // Δ6: the probe overflowed nothing while delivery kept
                    // rising; it ends at the first round that did not.
                    if let (Some(longterm), Some(grown)) =
                        (self.inflight_longterm, self.growth_inflight)
                    {
                        self.inflight_longterm = Some(longterm.max(grown));
                    }
                    if let Some(tx_in_flight) = round.too_high {
                        let target = scale(self.bdp(self.bw, 1.0), BETA);
                        self.inflight_longterm = Some(tx_in_flight.max(target));
                    }
                    self.start_down(now);
                }
            }
            // REFILL must replenish the window without importing a reduction
            // from the preceding Cruise round.
            EgressPhase::Refill => {}
            EgressPhase::Cruise if !round.app_limited => {
                // A single burst is expected pacing, not a standing queue.
                if let Some(minimum) = round.min_rtt {
                    let burst_time = Duration::from_nanos(
                        (u128::from(self.quantum) * 1_000_000_000)
                            .div_ceil(u128::from(self.bw.max(1))) as u64,
                    );
                    if minimum > self.queue_rtt.saturating_add(burst_time) {
                        if (self.cut_armed || self.queue_refinement_until.is_some())
                            && self.bw_latest < self.bw
                        {
                            if self.cut_armed {
                                self.cut_armed = false;
                                self.counters.queue_growth_cuts += 1;
                                self.queue_refinement_until =
                                    Some(self.next_round_delivered.saturating_add(flight));
                            }
                            // Refine from a whole round's maximum rate, never a
                            // single delayed ACK. The initial round can contain
                            // deliveries from before a bottleneck changed.
                            self.queue_bw = Some(self.bw_latest);
                            self.queue_cut_rtt = Some(minimum);
                            self.start_draining(flight);
                        }
                    } else {
                        self.cut_armed = true;
                        self.queue_refinement_until = None;
                    }
                }
                // With a near-BDP bulk window, loss reduces ACK throughput even
                // on an uncongested path. Feeding that reduction back every
                // round compounds it. Loss still bounds probes and collapses
                // persistent congestion in on_loss().
                if lossy {
                    self.counters.loss_rounds += 1;
                }
                if !growth && round.ce {
                    self.counters.ce_rounds += 1;
                    let bw = self.bw_shortterm.unwrap_or(self.peak_bw);
                    let inflight = self.inflight_shortterm.unwrap_or(self.cwnd);
                    self.bw_shortterm = Some(self.bw_latest.max(scale(bw, BETA)));
                    self.inflight_shortterm = Some(self.inflight_latest.max(scale(inflight, BETA)));
                    self.start_draining(flight);
                }
            }
            _ => {}
        }
    }

    fn start_draining(&mut self, flight: u64) {
        self.bound_bw();
        self.draining = flight > self.bdp(self.bw, 1.0).max(self.min_pipe_cwnd());
    }

    // ------------------------------------------------------------------
    // RTprop and ProbeRTT (Δ2)
    // ------------------------------------------------------------------

    fn observe_rtt(&mut self, now: Instant, sample: RttSample) {
        let rtt = sample.rtt;
        let low_load = self.phase == EgressPhase::ProbeRtt
            && self
                .probe_rtt_started
                .is_some_and(|start| sample.sent >= start);
        if low_load {
            self.probe_max = self.probe_max.max(rtt);
            self.probe_min = self.probe_min.min(rtt);
        }
        self.round.min_rtt = Some(self.round.min_rtt.map_or(rtt, |minimum| minimum.min(rtt)));
        if sample.quiescent {
            // Nothing of the group's was ahead of this packet: a completed
            // ProbeRTT, without holding bulk back.
            self.probe_rtt_stamp = now;
            self.probe_min = rtt;
            self.queue_rtt = self.queue_rtt.max(rtt);
            self.pipe_rtt = self.pipe_rtt.min(rtt);
            self.reconcile_queue_bound();
        } else if self.phase != EgressPhase::ProbeRtt {
            self.probe_min = self.probe_min.min(rtt);
        }
        if rtt < self.min_rtt {
            self.min_rtt = rtt;
            self.min_rtt_stamp = now;
        } else if self.probe_min < Duration::MAX
            && now.saturating_duration_since(self.min_rtt_stamp) > MIN_RTT_FILTER
        {
            // The window aged out: the least recent re-measurement stands.
            self.min_rtt = self.probe_min;
            self.queue_rtt = self.queue_rtt.max(self.min_rtt);
            self.min_rtt_stamp = now;
        }
    }

    fn check_probe_rtt(&mut self, now: Instant, flight: u64, delivered: u64) {
        if self.phase != EgressPhase::ProbeRtt
            && now.saturating_duration_since(self.probe_rtt_stamp) > PROBE_RTT_INTERVAL
        {
            self.probe_rtt_saved_cwnd = self.cwnd;
            self.phase = EgressPhase::ProbeRtt;
            self.probe_rtt_started = None;
            self.probe_rtt_done = None;
            self.probe_rtt_round_done = false;
            self.probe_min = Duration::MAX;
            self.probe_max = Duration::ZERO;
            self.counters.probe_rtts += 1;
        }
        if self.phase != EgressPhase::ProbeRtt {
            return;
        }
        match self.probe_rtt_done {
            None if flight <= self.probe_rtt_cwnd() => {
                // Hold for 200 ms and one whole round from here.
                self.probe_rtt_started = Some(now);
                self.probe_rtt_done = Some(now + PROBE_RTT_DURATION);
                self.probe_rtt_round_done = false;
                self.next_round_delivered = delivered;
            }
            Some(done) => {
                if self.round_start {
                    self.probe_rtt_round_done = true;
                }
                if self.probe_rtt_round_done && now >= done && self.probe_min < Duration::MAX {
                    self.probe_rtt_stamp = now;
                    if self.probe_min < Duration::MAX {
                        self.min_rtt = self.probe_min;
                        self.pipe_rtt = self.probe_min;
                        self.queue_rtt = self.queue_rtt.max(self.probe_max).max(self.probe_min);
                        self.reconcile_queue_bound();
                        self.min_rtt_stamp = now;
                    }
                    // Preserve the rate bound learned before ProbeRTT. Clearing
                    // it would restore an obsolete max_bw while input prevents
                    // a new bandwidth probe. Probe-limited samples are tagged
                    // at the shared delivery ledger and cannot lower this bound.
                    self.cwnd = self.cwnd.max(self.probe_rtt_saved_cwnd);
                    if self.filled_pipe {
                        self.start_down(now);
                        self.phase = EgressPhase::Cruise;
                        self.draining = false;
                    } else {
                        self.phase = EgressPhase::Startup;
                    }
                }
            }
            None => {}
        }
    }

    fn reconcile_queue_bound(&mut self) {
        // A later low-load observation can disprove the earlier queue inference:
        // propagation variation or another flow caused the same delay without
        // our flight ahead of it. Do not retract a bound established by CE.
        let burst = Duration::from_nanos(
            (u128::from(self.quantum) * 1_000_000_000).div_ceil(u128::from(self.bw.max(1))) as u64,
        );
        if self
            .queue_cut_rtt
            .is_some_and(|rtt| rtt <= self.queue_rtt.saturating_add(burst))
        {
            self.queue_bw = None;
            self.queue_cut_rtt = None;
            self.queue_refinement_until = None;
        }
    }

    fn probe_rtt_cwnd(&self) -> u64 {
        self.bdp(self.bw, PROBE_RTT_CWND_GAIN)
            .max(self.min_pipe_cwnd())
    }

    // ------------------------------------------------------------------
    // Startup, Drain and ProbeBW (Δ4, Δ5)
    // ------------------------------------------------------------------

    fn check_full_bw(&mut self, sample: &RateSample) {
        if self.filled_pipe || !self.round_start || sample.app_limited {
            return;
        }
        let max_bw = self.peak_bw;
        if max_bw as f64 >= self.full_bw as f64 * FULL_BW_GROWTH {
            self.full_bw = max_bw;
            self.full_bw_count = 0;
            return;
        }
        self.full_bw_count += 1;
        if self.full_bw_count >= FULL_BW_COUNT {
            self.filled_pipe = true;
        }
    }

    fn check_drain(&mut self, now: Instant, flight: u64) {
        if self.phase == EgressPhase::Startup && self.filled_pipe {
            self.phase = EgressPhase::Drain;
            self.draining = true;
        }
        if self.phase == EgressPhase::Drain
            && flight <= self.bdp(self.bw, 1.0).max(self.min_pipe_cwnd())
        {
            self.start_down_at(now);
            self.phase = EgressPhase::Cruise;
            self.draining = false;
        }
    }

    fn update_probe_bw(
        &mut self,
        now: Instant,
        sample: Option<&RateSample>,
        flight: u64,
        quiet: bool,
        delivered: u64,
    ) {
        if !self.filled_pipe {
            return;
        }
        // A drain after a cut or a loss round ends where DOWN's does.
        if self.draining
            && !matches!(self.phase, EgressPhase::Drain | EgressPhase::ProbeRtt)
            && flight <= self.bdp(self.bw, 1.0).max(self.min_pipe_cwnd())
        {
            self.draining = false;
            if self.phase == EgressPhase::Down {
                self.phase = EgressPhase::Cruise;
            }
        }
        match self.phase {
            EgressPhase::Down | EgressPhase::Cruise => {
                if quiet {
                    self.check_time_to_probe(now, delivered);
                }
            }
            EgressPhase::Refill => {
                if self.round_start {
                    if quiet {
                        self.start_up(sample, delivered);
                    } else {
                        // Δ4: pace at gain 1 until a round starts quiet.
                        self.counters.probes_gated += 1;
                    }
                }
            }
            EgressPhase::Up => self.probe_inflight_longterm_upward(sample, flight),
            _ => {}
        }
    }

    fn check_time_to_probe(&mut self, now: Instant, delivered: u64) {
        let reno_rounds = (self.bdp(self.bw, 1.0) / self.mtu.max(1)).min(MAX_RENO_ROUNDS);
        if now.saturating_duration_since(self.cycle_stamp) >= self.probe_wait
            || self.rounds_since_probe >= reno_rounds
        {
            self.start_refill(delivered);
        }
    }

    fn start_down(&mut self, now: Instant) {
        self.start_down_at(now);
    }

    /// Δ5: DOWN admits no bulk until flight is down to `bw·RTprop`, then
    /// cruises. The next probe waits a randomized 2–3 s from here.
    fn start_down_at(&mut self, now: Instant) {
        self.probe_up_cnt = u64::MAX;
        self.probe_wait =
            PROBE_WAIT_BASE + Duration::from_millis(self.rng.random_range(0..PROBE_WAIT_SPREAD_MS));
        self.rounds_since_probe = self.rng.random_range(0..2);
        self.cycle_stamp = now;
        self.growth_inflight = None;
        self.phase = EgressPhase::Down;
        self.draining = true;
    }

    /// Only a quiet ledger permits REFILL. Re-test the queue-derived limit,
    /// preserving explicit CE evidence until delivery proves a higher rate.
    fn start_refill(&mut self, delivered: u64) {
        self.queue_bw = None;
        self.queue_cut_rtt = None;
        self.queue_refinement_until = None;
        self.inflight_shortterm = None;
        self.probe_up_rounds = 0;
        self.probe_up_acks = 0;
        self.phase = EgressPhase::Refill;
        self.draining = false;
        // REFILL refills for at least one whole round from here.
        self.next_round_delivered = delivered;
    }

    fn start_up(&mut self, sample: Option<&RateSample>, delivered: u64) {
        self.full_bw = sample.map_or(0, |sample| sample.delivery_rate);
        self.full_bw_count = 0;
        self.growth_inflight = None;
        self.up_rounds = 0;
        self.phase = EgressPhase::Up;
        self.arm_up_budget();
        self.next_round_delivered = delivered;
        self.raise_inflight_longterm_slope();
    }

    fn arm_up_budget(&mut self) {
        // At gain g, (g - 1) / g of the sent bytes exceed the model rate.
        // Permit one pacing quantum of excess, then await measured growth.
        self.up_bytes_left = scale(self.quantum, UP_PACING_GAIN / (UP_PACING_GAIN - 1.0));
    }

    pub(crate) fn on_bulk_sent(&mut self, bytes: u64) {
        if self.phase != EgressPhase::Up || self.up_bytes_left == 0 {
            return;
        }
        self.up_bytes_left = self.up_bytes_left.saturating_sub(bytes);
        if self.up_bytes_left == 0 {
            self.update_pacing_rate();
            self.update_quantum();
        }
    }

    /// The draft's slope: the long-term bound may grow by `2^rounds` packets
    /// per round of acknowledgments while UP is window limited.
    fn raise_inflight_longterm_slope(&mut self) {
        let growth_packets = 1u64 << self.probe_up_rounds.min(30);
        self.probe_up_rounds = (self.probe_up_rounds + 1).min(30);
        self.probe_up_cnt = (self.cwnd / growth_packets).max(1);
    }

    fn probe_inflight_longterm_upward(&mut self, sample: Option<&RateSample>, flight: u64) {
        let Some(longterm) = self.inflight_longterm else {
            return;
        };
        // Only a window-limited probe tests the bound.
        if flight.saturating_add(self.mtu) < self.cwnd || self.cwnd < longterm {
            return;
        }
        let Some(sample) = sample else {
            return;
        };
        self.probe_up_acks += sample.newly_acked;
        if self.probe_up_acks >= self.probe_up_cnt {
            let packets = self.probe_up_acks / self.probe_up_cnt;
            self.probe_up_acks -= packets * self.probe_up_cnt;
            self.inflight_longterm = Some(longterm.saturating_add(packets * self.mtu));
        }
        if self.round_start {
            self.raise_inflight_longterm_slope();
        }
    }

    // ------------------------------------------------------------------
    // Estimates and outputs (Δ3, Δ8)
    // ------------------------------------------------------------------

    fn update_ack_aggregation(&mut self, now: Instant, newly_acked: u64) {
        let interval = now.saturating_duration_since(self.extra_acked_start);
        let mut expected = bytes_in(self.bw, interval);
        if self.extra_acked_delivered <= expected {
            self.extra_acked_delivered = 0;
            self.extra_acked_start = now;
            expected = 0;
        }
        self.extra_acked_delivered += newly_acked;
        let extra = self
            .extra_acked_delivered
            .saturating_sub(expected)
            .min(self.cwnd);
        self.extra_acked.update_max(self.round_count, extra);
    }

    fn bound_bw(&mut self) {
        let max_bw = self.peak_bw;
        let model = if max_bw == 0 { self.seed_bw } else { max_bw };
        self.bw = model
            .min(self.bw_shortterm.unwrap_or(u64::MAX))
            .min(self.queue_bw.unwrap_or(u64::MAX));
    }

    fn pacing_gain(&self) -> f64 {
        match self.phase {
            EgressPhase::Startup => STARTUP_PACING_GAIN,
            EgressPhase::Up if self.up_bytes_left != 0 => UP_PACING_GAIN,
            _ => 1.0,
        }
    }

    fn update_pacing_rate(&mut self) {
        let rate = scale(self.bw, self.pacing_gain() * PACING_MARGIN).max(1);
        // Before the pipe fills, pacing only rises: the seed stands until a
        // sample beats it.
        if self.filled_pipe || rate > self.pacing_rate {
            self.pacing_rate = rate;
        }
    }

    fn update_quantum(&mut self) {
        self.quantum = bytes_in(self.pacing_rate, QUANTUM_INTERVAL).clamp(self.mtu, MAX_QUANTUM);
    }

    fn update_cwnd(&mut self, newly_acked: u64, delivered: u64) {
        let target = self
            .bdp(self.bw, CWND_GAIN)
            .saturating_add(self.extra_acked.get())
            .max(3 * self.quantum)
            .saturating_add(if self.phase == EgressPhase::Up {
                2 * self.mtu
            } else {
                0
            });
        if self.filled_pipe {
            self.cwnd = self.cwnd.saturating_add(newly_acked).min(target);
        } else if self.cwnd < target || delivered < 10 * self.mtu {
            self.cwnd = self.cwnd.saturating_add(newly_acked);
        }
        self.cwnd = self.cwnd.max(self.min_pipe_cwnd());
        // The model's bounds; ProbeRTT and recovery reductions are bulk's.
        let mut cap = match self.phase {
            EgressPhase::Down | EgressPhase::Refill | EgressPhase::Up => {
                self.inflight_longterm.unwrap_or(u64::MAX)
            }
            EgressPhase::Cruise | EgressPhase::ProbeRtt => self.inflight_with_headroom(),
            EgressPhase::Startup | EgressPhase::Drain => u64::MAX,
        };
        cap = cap.min(self.inflight_shortterm.unwrap_or(u64::MAX));
        cap = cap.max(self.min_pipe_cwnd());
        self.cwnd = self.cwnd.min(cap);
    }

    fn inflight_with_headroom(&self) -> u64 {
        match self.inflight_longterm {
            None => u64::MAX,
            Some(longterm) => {
                let headroom = scale(longterm, HEADROOM).max(self.mtu);
                longterm
                    .saturating_sub(headroom)
                    .max(self.bdp(self.bw, 1.0))
                    .max(self.min_pipe_cwnd())
            }
        }
    }

    fn min_pipe_cwnd(&self) -> u64 {
        4 * self.mtu
    }

    /// `gain` bandwidth-delay products over the last measured low-load RTT.
    fn bdp(&self, bw: u64, gain: f64) -> u64 {
        scale(bytes_in(bw, self.pipe_rtt), gain)
    }
}

/// Bytes a rate of `bytes_per_second` carries in `interval`.
fn bytes_in(bytes_per_second: u64, interval: Duration) -> u64 {
    u64::try_from(u128::from(bytes_per_second) * interval.as_nanos() / 1_000_000_000)
        .unwrap_or(u64::MAX)
}

/// `bytes` over `interval`, in bytes per second.
fn rate(bytes: u64, interval: Duration) -> u64 {
    u64::try_from(u128::from(bytes) * 1_000_000_000 / interval.as_nanos().max(1))
        .unwrap_or(u64::MAX)
}

fn scale(value: u64, gain: f64) -> u64 {
    (value as f64 * gain) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    const MTU: u16 = 1_200;
    const MS: Duration = Duration::from_millis(1);

    fn model(now: Instant) -> EgressModel {
        // A 100 ms path whose interactive connection holds 12 KB.
        EgressModel::new(now, MTU, MS * 100, 12_000, MS * 100, 7)
    }

    fn sample(prior_delivered: u64, rate: u64, delivered: u64, app_limited: bool) -> RateSample {
        RateSample {
            delivery_rate: rate,
            delivered,
            interval: MS * 100,
            prior_delivered,
            app_limited,
            tx_in_flight: delivered,
            // One round's deliveries arrive over the round's ACK frames.
            newly_acked: delivered / 2,
        }
    }

    /// Drives one round per call: a sample whose packet was sent at the
    /// previous round's end, so it starts a new round.
    struct Driver {
        model: EgressModel,
        now: Instant,
        delivered: u64,
    }

    impl Driver {
        fn new() -> Self {
            let now = Instant::now();
            Self {
                model: model(now),
                now,
                delivered: 0,
            }
        }

        fn round(&mut self, rate: u64, app_limited: bool, rtts: &[u64], flight: u64, quiet: bool) {
            self.now += MS * 100;
            let prior = self.delivered;
            let bytes = rate / 10;
            self.delivered += bytes;
            let first = sample(prior, rate, bytes, app_limited);
            self.model.on_end_acks(
                self.now,
                Some(first),
                rtts.first().map(|rtt| RttSample {
                    sent: self.now - MS * *rtt as u32,
                    rtt: MS * *rtt as u32,
                    quiescent: false,
                }),
                flight,
                quiet,
                self.delivered,
            );
            for rtt in rtts.iter().skip(1) {
                // Later samples in the same round do not start another.
                let within = sample(prior + 1, rate, bytes, app_limited);
                self.model.on_end_acks(
                    self.now,
                    Some(within),
                    Some(RttSample {
                        sent: self.now - MS * *rtt as u32,
                        rtt: MS * *rtt as u32,
                        quiescent: false,
                    }),
                    flight,
                    quiet,
                    self.delivered,
                );
            }
        }
    }

    #[test]
    fn a_seeded_model_paces_startup_from_the_interactive_window() {
        let now = Instant::now();
        let model = model(now);
        assert_eq!(model.phase(), EgressPhase::Startup);
        // 12 KB per 100 ms is 120 KB/s; Startup paces 2.77 times that, less 1%.
        assert_eq!(model.pacing_rate(), (120_000.0 * 2.77 * 0.99) as u64);
        assert_eq!(model.quantum(), 1_200, "a quantum is at least one MTU");
        assert_eq!(model.cwnd(), 12_000);
        assert_eq!(
            model.bulk_cap(),
            12_000,
            "Startup's bulk cap is the draft cwnd"
        );
    }

    /// Three rounds without 25% growth fill the pipe, and Drain holds bulk to
    /// `bw·RTprop` until the flight is down to it.
    #[test]
    fn startup_fills_on_a_plateau_and_drains_to_the_bdp_before_cruising() {
        let mut driver = Driver::new();
        for rate in [
            200_000, 400_000, 800_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000,
        ] {
            driver.round(rate, false, &[100, 100], 500_000, true);
        }
        assert!(driver.model.filled_pipe);
        assert_eq!(driver.model.phase(), EgressPhase::Drain);
        // bw·RTprop is 100 KB: bulk may not add to a 500 KB flight.
        assert_eq!(driver.model.bulk_cap(), 100_000);
        driver.round(1_000_000, false, &[100], 90_000, true);
        assert_eq!(driver.model.phase(), EgressPhase::Cruise);
        assert_eq!(driver.model.bulk_cap(), 102_400);
    }

    fn cruising() -> Driver {
        let mut driver = Driver::new();
        for rate in [400_000, 800_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000] {
            driver.round(rate, false, &[100, 100], 50_000, true);
        }
        driver.round(1_000_000, false, &[100, 100], 50_000, true);
        assert_eq!(driver.model.phase(), EgressPhase::Cruise);
        driver
    }

    #[test]
    fn pacing_bursts_do_not_cut_rate_but_a_standing_queue_does() {
        let mut driver = cruising();
        // A 1 ms pacing burst at this rate can move individual RTT samples.
        for _ in 0..3 {
            driver.round(900_000, false, &[100, 101], 150_000, true);
        }
        assert_eq!(driver.model.counters().queue_growth_cuts, 0);
        driver.round(900_000, false, &[110, 120], 150_000, true);
        driver.round(900_000, false, &[120, 130], 150_000, true);
        assert_eq!(driver.model.counters().queue_growth_cuts, 1);
        assert_eq!(driver.model.bw(), 900_000);
        assert!(driver.model.draining);
        // No new cut merely because a competing flow keeps a queue present.
        driver.round(900_000, false, &[130, 140], 150_000, true);
        assert_eq!(driver.model.counters().queue_growth_cuts, 1);
        // A round without a standing queue re-arms the detector.
        driver.round(900_000, false, &[100, 100], 50_000, true);
        driver.round(700_000, false, &[110, 120], 150_000, true);
        driver.round(700_000, false, &[120, 120], 50_000, true);
        assert_eq!(driver.model.counters().queue_growth_cuts, 2);
    }

    #[test]
    fn unqueued_rtt_variation_is_not_a_standing_queue() {
        let mut driver = cruising();
        driver.model.on_end_acks(
            driver.now,
            None,
            Some(RttSample {
                sent: driver.now - MS * 115,
                rtt: MS * 115,
                quiescent: true,
            }),
            0,
            false,
            driver.delivered,
        );
        for _ in 0..3 {
            driver.round(900_000, false, &[110, 115], 150_000, false);
        }
        assert_eq!(driver.model.bw(), 1_000_000);
        assert_eq!(driver.model.counters().queue_growth_cuts, 0);
        // A queue beyond that observed variation still cuts the rate.
        driver.round(900_000, false, &[125, 130], 150_000, false);
        driver.round(900_000, false, &[125, 130], 150_000, false);
        assert_eq!(driver.model.bw(), 900_000);
        assert_eq!(driver.model.counters().queue_growth_cuts, 1);
    }

    #[test]
    fn draining_uses_round_feedback_and_stops_refining_after_the_cut_flight() {
        let mut driver = cruising();
        driver.round(900_000, false, &[120, 120], 150_000, false);
        driver.round(900_000, false, &[120, 120], 150_000, false);
        assert_eq!(driver.model.bw(), 900_000);
        // A delayed ACK within this round must not compound the queue cut.
        driver.model.on_end_acks(
            driver.now,
            Some(sample(driver.delivered - 1, 100_000, 1_200, false)),
            None,
            150_000,
            false,
            driver.delivered,
        );
        assert_eq!(driver.model.bw(), 900_000);
        for _ in 0..4 {
            driver.round(900_000, false, &[120, 120], 150_000, false);
        }
        assert_eq!(driver.model.queue_refinement_until, None);
        // Later traffic belongs to the reduced window, not the flight that
        // established this queue episode. A competitor cannot ratchet it down.
        for _ in 0..3 {
            driver.round(300_000, false, &[120, 120], 150_000, false);
        }
        assert_eq!(driver.model.bw(), 900_000);
        assert_eq!(driver.model.counters().queue_growth_cuts, 1);
    }

    #[test]
    fn cruise_ack_aggregation_is_bounded_despite_slow_unloaded_samples() {
        let mut driver = cruising();
        driver
            .model
            .extra_acked
            .update_max(driver.model.round_count, 80_000);
        assert_eq!(driver.model.bulk_cap(), 102_400);
        driver.model.observe_rtt(
            driver.now,
            RttSample {
                sent: driver.now - MS * 115,
                rtt: MS * 115,
                quiescent: true,
            },
        );
        assert_eq!(driver.model.bulk_cap(), 102_400);
        driver.model.draining = true;
        assert_eq!(driver.model.bulk_cap(), 100_000);
    }

    #[test]
    fn a_probe_waits_for_delivery_growth_after_one_quantum_of_excess() {
        let mut driver = cruising();
        driver.model.start_up(None, driver.delivered);
        driver.model.update_pacing_rate();
        assert_eq!(driver.model.pacing_gain(), UP_PACING_GAIN);
        let budget = driver.model.up_bytes_left;
        driver.model.on_bulk_sent(budget - 1);
        assert_eq!(driver.model.pacing_gain(), UP_PACING_GAIN);
        driver.model.on_bulk_sent(1);
        assert_eq!(driver.model.pacing_gain(), 1.0);
        assert_eq!(driver.model.pacing_rate(), 990_000);
        // ACKs without delivery growth must not reload the probe allowance.
        driver.round(1_000_000, false, &[100], 100_000, true);
        assert_eq!(driver.model.pacing_gain(), 1.0);
        driver.round(1_200_000, false, &[100], 120_000, true);
        assert_eq!(driver.model.pacing_gain(), UP_PACING_GAIN);
    }

    /// Δ7: application-limited rounds never lower a bound.
    #[test]
    fn an_app_limited_lossy_round_lowers_nothing() {
        let mut driver = cruising();
        let cwnd = driver.model.cwnd();
        let bw = driver.model.bw();
        driver.round(20_000, true, &[100, 180], 2_400, false);
        let rate = PacketRate::for_test(2_400, 0, true);
        driver.model.on_loss(1_200, &rate, 1_200, 1, false);
        driver.round(20_000, true, &[180, 200], 2_400, false);
        driver.round(20_000, true, &[200, 220], 2_400, false);
        assert_eq!(driver.model.bw(), bw);
        assert!(driver.model.cwnd() >= cwnd, "acknowledgments only grow it");
        assert_eq!(driver.model.counters().loss_rounds, 0);
        assert_eq!(driver.model.counters().queue_growth_cuts, 0);
    }

    /// Random loss must not compound a lower rate on an unqueued path.
    #[test]
    fn a_lossy_cruise_round_does_not_mistake_erasure_for_lower_capacity() {
        let mut driver = cruising();
        // A round that delivers 950 KB/s and loses a packet.
        driver.round(950_000, false, &[100, 100], 100_000, true);
        let rate = PacketRate::for_test(100_000, 0, false);
        driver.model.on_loss(1_200, &rate, 1_200, 1, false);
        driver.round(950_000, false, &[100, 100], 100_000, true);
        assert_eq!(driver.model.counters().loss_rounds, 1);
        assert_eq!(driver.model.bw(), 1_000_000);
    }

    /// Δ4: UP starts only at a quiet round start; REFILL waits at gain 1, and
    /// an interactive admission during UP ends it at once.
    #[test]
    fn up_is_gated_on_a_quiet_round_and_aborted_by_interactive_work() {
        let mut driver = cruising();
        // Passing the probe wait cannot reset the bound while input is active.
        driver.now += Duration::from_secs(3);
        driver.round(1_000_000, false, &[100, 100], 50_000, false);
        assert_eq!(driver.model.phase(), EgressPhase::Cruise);
        driver.round(1_000_000, false, &[100, 100], 50_000, true);
        assert_eq!(driver.model.phase(), EgressPhase::Refill);
        driver.round(1_000_000, false, &[100, 100], 50_000, false);
        assert_eq!(driver.model.phase(), EgressPhase::Refill);
        assert!(driver.model.counters().probes_gated >= 1);
        assert_eq!(driver.model.pacing_gain(), 1.0);
        driver.round(1_000_000, false, &[100, 100], 50_000, true);
        assert_eq!(driver.model.phase(), EgressPhase::Up);
        assert_eq!(driver.model.pacing_gain(), 1.25);
        driver.model.interactive_admitted(driver.now);
        assert_eq!(driver.model.phase(), EgressPhase::Down);
        assert!(driver.model.draining);
        assert_eq!(driver.model.counters().probes_aborted, 1);
        assert_eq!(driver.model.counters().interactive_in_probe, 1);
    }

    /// Δ6: UP keeps probing while delivery keeps rising, whatever the loss,
    /// and ends at the first round that does not grow.
    #[test]
    fn up_ends_at_the_first_round_without_growth() {
        let mut driver = cruising();
        driver.now += Duration::from_secs(3);
        driver.round(1_000_000, false, &[100, 100], 50_000, true);
        driver.round(1_000_000, false, &[100, 100], 50_000, true);
        assert_eq!(driver.model.phase(), EgressPhase::Up);
        let rate = PacketRate::for_test(100_000, 0, false);
        // UP's first round measured what was sent before it and is never
        // read; 3% loss in rounds that still grow is not congestion.
        driver.round(1_200_000, false, &[100, 100], 120_000, true);
        driver.model.on_loss(3_000, &rate, 3_000, 3, false);
        driver.round(1_300_000, false, &[100, 100], 120_000, true);
        driver.model.on_loss(3_000, &rate, 6_000, 3, false);
        driver.round(1_250_000, false, &[100, 100], 120_000, true);
        assert_eq!(driver.model.phase(), EgressPhase::Up);
        assert_eq!(driver.model.counters().loss_rounds, 0);
        // The round that stopped growing ends the probe, whose queue then
        // drains: 160 KB is above the 130 KB the model now holds.
        driver.round(1_250_000, false, &[100, 100], 160_000, true);
        assert_eq!(driver.model.phase(), EgressPhase::Down);
        assert_eq!(driver.model.bulk_cap(), 130_000);
    }

    /// Δ2: a quiescent sample is a completed ProbeRTT; without one for five
    /// seconds bulk alone is held to half a BDP for 200 ms and a round.
    #[test]
    fn quiescent_samples_pre_empt_probe_rtt_which_bounds_bulk_only() {
        let mut driver = cruising();
        let cwnd = driver.model.cwnd();
        for _ in 0..20 {
            driver.round(1_000_000, false, &[100, 100], 50_000, true);
            driver.model.on_end_acks(
                driver.now,
                None,
                Some(RttSample {
                    sent: driver.now - MS * 100,
                    rtt: MS * 100,
                    quiescent: true,
                }),
                0,
                true,
                driver.delivered,
            );
        }
        assert_eq!(driver.model.counters().probe_rtts, 0);
        // Continuous flight: no quiescent sample for more than five seconds.
        for _ in 0..52 {
            driver.round(1_000_000, false, &[100, 100], 100_000, true);
        }
        assert_eq!(driver.model.counters().probe_rtts, 1);
        assert_eq!(driver.model.phase(), EgressPhase::ProbeRtt);
        assert_eq!(driver.model.bulk_cap(), 50_000);
        assert!(driver.model.cwnd() >= cwnd);
        assert!(
            driver.model.cwnd() > driver.model.bulk_cap(),
            "interactive keeps its window during ProbeRTT"
        );
        for _ in 0..4 {
            driver.round(1_000_000, false, &[100, 100], 40_000, true);
        }
        assert_eq!(driver.model.phase(), EgressPhase::Cruise);
        assert_eq!(driver.model.counters().probe_rtts, 1);
    }

    #[test]
    fn the_quantum_is_one_millisecond_of_the_pacing_rate_within_bounds() {
        let mut driver = cruising();
        // 1 MB/s cruising: 990 bytes a millisecond is under one MTU.
        assert_eq!(driver.model.quantum(), 1_200);
        for rate in [10_000_000, 20_000_000, 40_000_000, 80_000_000] {
            driver.now += Duration::from_secs(3);
            driver.round(rate, false, &[100, 100], 50_000, true);
        }
        assert!(driver.model.quantum() > 1_200);
        assert!(driver.model.quantum() <= 64 * 1024);
    }

    #[test]
    fn revising_a_queue_inference_preserves_explicit_congestion() {
        let mut driver = cruising();
        driver.round(800_000, false, &[100, 100], 150_000, false);
        driver.model.on_ce();
        driver.round(800_000, false, &[100, 100], 150_000, false);
        assert_eq!(driver.model.bw(), 800_000);
        driver.round(700_000, false, &[120, 120], 150_000, false);
        driver.round(700_000, false, &[120, 120], 150_000, false);
        assert_eq!(driver.model.bw(), 700_000);
        // A packet with no preceding flight experiences the same delay. That
        // revises the queue inference, but the peer's CE signal remains valid.
        driver.model.on_end_acks(
            driver.now,
            None,
            Some(RttSample {
                sent: driver.now - MS * 125,
                rtt: MS * 125,
                quiescent: true,
            }),
            0,
            false,
            driver.delivered,
        );
        assert_eq!(driver.model.bw(), 800_000);
        // Even the quiet bandwidth probe must preserve that explicit evidence.
        driver.model.start_refill(driver.delivered);
        driver.model.bound_bw();
        assert_eq!(driver.model.bw(), 800_000);
    }

    #[test]
    fn probe_rtt_ignores_packets_sent_before_the_low_load_interval() {
        let mut driver = cruising();
        let started = driver.now + Duration::from_secs(6);
        driver.model.check_probe_rtt(started, 0, driver.delivered);
        assert_eq!(driver.model.phase(), EgressPhase::ProbeRtt);
        // Old flight arriving during the probe is not an unloaded measurement.
        driver.model.observe_rtt(
            started + MS * 100,
            RttSample {
                sent: started - MS * 400,
                rtt: MS * 500,
                quiescent: false,
            },
        );
        assert_eq!(driver.model.probe_min, Duration::MAX);
        assert_eq!(driver.model.probe_max, Duration::ZERO);
        driver.model.round_start = true;
        driver
            .model
            .check_probe_rtt(started + MS * 300, 0, driver.delivered);
        assert_eq!(driver.model.phase(), EgressPhase::ProbeRtt);
        driver.model.observe_rtt(
            started + MS * 310,
            RttSample {
                sent: started + MS * 200,
                rtt: MS * 110,
                quiescent: false,
            },
        );
        driver
            .model
            .check_probe_rtt(started + MS * 310, 0, driver.delivered);
        assert_eq!(driver.model.phase(), EgressPhase::Cruise);
        assert_eq!(driver.model.min_rtt(), MS * 110);
        assert_eq!(driver.model.queue_rtt, MS * 110);
    }

    #[test]
    fn persistent_congestion_collapses_the_window() {
        let mut driver = cruising();
        let rate = PacketRate::for_test(100_000, 0, false);
        driver.model.on_loss(100_000, &rate, 100_000, 10, true);
        assert_eq!(driver.model.cwnd(), 4 * 1_200);
    }
}
