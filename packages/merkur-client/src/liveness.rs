//! Whether the incumbent carrier still carries what we send, sans-IO.
//!
//! The port of `apps/web/src/session/session-heartbeat.ts` and
//! `packages/shared/src/rtt-estimator.ts`. Steady pings ride the heartbeat
//! interval (a bandwidth knob); detection is deadline-driven. Each ping arms a
//! pong deadline of one RTO. A lapse escalates to probes at RTO spacing and
//! reports [`Verdict::Escalated`], weak evidence that starts paying for a
//! candidate; the probe sent at the lapse going unanswered for an RTO of its own
//! reports [`Verdict::Failed`], the only fact that may take part in seating one.
//! There is no third fact: silence never proves whether a better path exists,
//! so the strike stands, and probing continues, until proof retracts it.
//!
//! Proof is a pong or an input ACK naming a sequence we emitted. Inbound
//! display or a daemon-originated ping proves only the downlink, and crediting
//! them made a dead uplink under a live downlink undetectable.
//!
//! The browser's ladder calls recovery back synchronously. Here verdicts are
//! queued and the owner reacts after the step, so recovery never retires the
//! ladder from inside one.

use std::collections::VecDeque;

use merkur_wire::protocol::{MSG_TYPE_HEARTBEAT_PING, encode_proto_frame};

/// Round trips below this are indistinguishable from timer noise; mirrored
/// from `RTO_FLOOR_MS` and the daemon's session policy.
pub const RTO_FLOOR_MS: f64 = 250.0;
/// A path slower than this is unusable for an interactive terminal.
pub const RTO_CEIL_MS: f64 = 3_000.0;
/// RFC 6298 §2.1: the RTO before any sample exists.
pub const RTO_INITIAL_MS: f64 = 1_000.0;
/// Ping send times are kept this many intervals, long enough for the slowest
/// expected path to answer on the same round.
const PING_RECORD_TTL_FACTOR: u64 = 4;

/// RFC 6298 (Jacobson/Karels) with α = 1/8, β = 1/4, K = 4.
#[derive(Clone, Debug, Default)]
pub struct RttEstimator {
    srtt: Option<f64>,
    rttvar: f64,
}

impl RttEstimator {
    pub fn observe(&mut self, rtt_ms: f64) {
        if !rtt_ms.is_finite() || rtt_ms < 0.0 {
            return;
        }
        match self.srtt {
            None => {
                self.srtt = Some(rtt_ms);
                self.rttvar = rtt_ms / 2.0;
            }
            Some(srtt) => {
                // §2.3: RTTVAR before SRTT, each from the prior SRTT.
                self.rttvar = 0.75 * self.rttvar + 0.25 * (srtt - rtt_ms).abs();
                self.srtt = Some(0.875 * srtt + 0.125 * rtt_ms);
            }
        }
    }

    pub fn srtt_ms(&self) -> Option<f64> {
        self.srtt
    }

    pub fn rto_ms(&self) -> f64 {
        match self.srtt {
            None => RTO_INITIAL_MS,
            Some(srtt) => (srtt + 4.0 * self.rttvar).clamp(RTO_FLOOR_MS, RTO_CEIL_MS),
        }
    }
}

/// What the ladder concluded, for the recovery owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// A pong deadline lapsed: start paying for a candidate, evict nothing.
    Escalated,
    /// The probe sent at the lapse was unanswered for a full RTO too. Reported
    /// once per ladder.
    Failed,
    /// A round trip or acknowledged progress ended the suspicion.
    Progress,
}

/// A carrier in whose sealed pings the ladder measures round trips, and the
/// input watermarks it reads.
pub trait LivenessLink {
    fn control_open(&self) -> bool;
    /// Seal and send one ping frame; false when no carrier admitted it. A local
    /// refusal is never an unanswered round trip.
    fn send_ping(&mut self, frame: &[u8]) -> bool;
    /// Highest input sequence the daemon acknowledged, or 0.
    fn progress_seq(&self) -> u32;
    /// Highest input sequence handed to a carrier, or 0 when none is
    /// outstanding.
    fn emit_top_seq(&self) -> u32;
}

/// One path's bit in a ping's per-path pong ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathKind {
    Relay = 1,
    Direct = 2,
}

struct PingRecord {
    token: u64,
    sent_at_ms: u64,
    recorded_for: u8,
}

struct Ladder {
    at_ms: u64,
    rto_ms: f64,
    armed_at_progress: u32,
    stage: Stage,
}

enum Stage {
    /// The pong deadline of the ping that armed the ladder.
    Deadline,
    Probing {
        progress_seq: u32,
        first: bool,
        admitted: bool,
    },
}

pub struct Heartbeat {
    interval_ms: u64,
    records: VecDeque<PingRecord>,
    rtt: RttEstimator,
    next_tick_ms: Option<u64>,
    ladder: Option<Ladder>,
    incumbent_failed: bool,
    last_token: Option<u64>,
    /// The emit outstanding when the live deadline was armed; 0 when none was.
    armed_emit_top_seq: u32,
    armed_progress_seq: u32,
    verdicts: VecDeque<Verdict>,
}

impl Heartbeat {
    pub fn new(interval_ms: u64) -> Self {
        Self {
            interval_ms,
            records: VecDeque::new(),
            rtt: RttEstimator::default(),
            next_tick_ms: None,
            ladder: None,
            incumbent_failed: false,
            last_token: None,
            armed_emit_top_seq: 0,
            armed_progress_seq: 0,
            verdicts: VecDeque::new(),
        }
    }

    pub fn poll_verdict(&mut self) -> Option<Verdict> {
        self.verdicts.pop_front()
    }

    pub fn start(&mut self, now_ms: u64, link: &mut impl LivenessLink) {
        self.stop();
        self.send_ping(now_ms, link);
        // The tick's own first run is immediate: a no-op once the ping above
        // armed a deadline, and a prompt retry when that ping was refused.
        self.send_ping(now_ms, link);
        self.next_tick_ms = Some(now_ms + self.interval_ms);
    }

    pub fn stop(&mut self) {
        self.cancel_ladder();
        self.next_tick_ms = None;
    }

    pub fn clear_tracking(&mut self) {
        self.records.clear();
        self.cancel_ladder();
    }

    /// Arm a deadline from real outbound traffic when none is armed, so
    /// detection is clocked by typing rather than by the next steady ping.
    pub fn arm_on_emit(&mut self, now_ms: u64, link: &mut impl LivenessLink) {
        self.send_ping(now_ms, link);
    }

    /// Restart the ladder for a known path change.
    pub fn send_immediate_ping(&mut self, now_ms: u64, link: &mut impl LivenessLink) {
        self.clear_tracking();
        self.send_ping(now_ms, link);
    }

    /// Probe on a connectivity hint without restarting an escalation: a
    /// restart would retract the strike exactly when its evidence grew.
    pub fn probe_without_resetting(&mut self, now_ms: u64, link: &mut impl LivenessLink) {
        if !link.control_open() {
            return;
        }
        if self.ladder.is_some() {
            self.send_ping_frame(now_ms, link);
            return;
        }
        self.send_ping(now_ms, link);
    }

    pub fn record_pong_proof(&mut self) {
        self.cancel_ladder();
        self.verdicts.push_back(Verdict::Progress);
    }

    /// An input ACK naming `seq`, delivered before the caller advances its
    /// progress watermark. It clears when it covers the arm-time emit or
    /// advances the arm-time watermark; a duplicate below both cannot.
    pub fn record_input_ack_proof(&mut self, seq: u32) {
        if self.armed_emit_top_seq != 0
            && seq < self.armed_emit_top_seq
            && seq <= self.armed_progress_seq
        {
            return;
        }
        self.cancel_ladder();
        self.verdicts.push_back(Verdict::Progress);
    }

    /// The round trip of a pong on `path`, once per (token, path).
    pub fn resolve_pong_rtt(&mut self, token: u64, path: PathKind, now_ms: u64) -> Option<f64> {
        let record = self
            .records
            .iter_mut()
            .find(|record| record.token == token)?;
        let bit = path as u8;
        if record.recorded_for & bit != 0 {
            return None;
        }
        record.recorded_for |= bit;
        let rtt_ms = now_ms.checked_sub(record.sent_at_ms)? as f64;
        self.rtt.observe(rtt_ms);
        Some(rtt_ms)
    }

    pub fn has_incumbent_failed(&self) -> bool {
        self.incumbent_failed
    }

    pub fn rto_ms(&self) -> f64 {
        self.rtt.rto_ms()
    }

    pub fn srtt_ms(&self) -> Option<f64> {
        self.rtt.srtt_ms()
    }

    pub fn pending_ping_count(&self) -> usize {
        self.records.len()
    }

    pub fn next_deadline(&self) -> Option<u64> {
        let ladder = self.ladder.as_ref().map(|ladder| ladder.at_ms);
        match (self.next_tick_ms, ladder) {
            (Some(tick), Some(ladder)) => Some(tick.min(ladder)),
            (tick, ladder) => tick.or(ladder),
        }
    }

    pub fn handle_timeout(&mut self, now_ms: u64, link: &mut impl LivenessLink) {
        if self
            .ladder
            .as_ref()
            .is_some_and(|ladder| ladder.at_ms <= now_ms)
        {
            self.ladder_step(now_ms, link);
        }
        if self.next_tick_ms.is_some_and(|at| at <= now_ms) {
            self.send_ping(now_ms, link);
            self.next_tick_ms = Some(now_ms + self.interval_ms);
        }
    }

    fn send_ping(&mut self, now_ms: u64, link: &mut impl LivenessLink) {
        // While a deadline or escalation runs, the probe loop owns the cadence:
        // our own traffic must not reset a strike only proof may retract.
        if !link.control_open() || self.ladder.is_some() {
            return;
        }
        if self.send_ping_frame(now_ms, link) {
            self.arm_deadline(now_ms, link);
        }
    }

    fn send_ping_frame(&mut self, now_ms: u64, link: &mut impl LivenessLink) -> bool {
        let cutoff = now_ms.saturating_sub(self.interval_ms * PING_RECORD_TTL_FACTOR);
        while self
            .records
            .front()
            .is_some_and(|record| record.sent_at_ms < cutoff)
        {
            self.records.pop_front();
        }
        // An opaque echo token to the daemon: monotonic microseconds, strictly
        // increasing even on a coarse clock.
        let candidate = now_ms.saturating_mul(1_000);
        let token = match self.last_token {
            Some(last) if candidate <= last => last + 1,
            _ => candidate,
        };
        self.last_token = Some(token);
        if !link.send_ping(&encode_proto_frame(
            MSG_TYPE_HEARTBEAT_PING,
            &token.to_be_bytes(),
        )) {
            return false;
        }
        self.records.push_back(PingRecord {
            token,
            sent_at_ms: now_ms,
            recorded_for: 0,
        });
        true
    }

    fn arm_deadline(&mut self, now_ms: u64, link: &impl LivenessLink) {
        self.cancel_ladder();
        let rto_ms = self.rtt.rto_ms();
        let armed_at_progress = link.progress_seq();
        self.armed_progress_seq = armed_at_progress;
        self.armed_emit_top_seq = link.emit_top_seq();
        self.ladder = Some(Ladder {
            at_ms: now_ms + rto_ms.ceil() as u64,
            rto_ms,
            armed_at_progress,
            stage: Stage::Deadline,
        });
    }

    fn ladder_step(&mut self, now_ms: u64, link: &mut impl LivenessLink) {
        let Some(ladder) = self.ladder.as_mut() else {
            return;
        };
        let progress = link.progress_seq();
        match &mut ladder.stage {
            Stage::Deadline => {
                // Acknowledged uplink progress while the deadline ran proves
                // the carrier carries our frames; the missing pong was lost.
                if progress != ladder.armed_at_progress {
                    return self.stand_down();
                }
                // The first probe goes out now; the next boundary asks
                // about its round trip.
                self.verdicts.push_back(Verdict::Escalated);
            }
            Stage::Probing {
                progress_seq,
                first,
                admitted,
            } => {
                if !*first {
                    // The lapse's own check, at every probe boundary.
                    if progress != *progress_seq {
                        return self.stand_down();
                    }
                    if *admitted && !self.incumbent_failed {
                        // Proof would have cancelled this ladder, so the probe
                        // sent at the lapse went unanswered too.
                        self.incumbent_failed = true;
                        self.verdicts.push_back(Verdict::Failed);
                    }
                }
            }
        }
        let admitted = link.control_open() && self.send_ping_frame(now_ms, link);
        let Some(ladder) = self.ladder.as_mut() else {
            return;
        };
        ladder.stage = Stage::Probing {
            progress_seq: progress,
            first: false,
            admitted,
        };
        ladder.at_ms = now_ms + ladder.rto_ms.ceil() as u64;
    }

    /// End the ladder on positive proof the uplink works, retracting any
    /// strike with it.
    fn stand_down(&mut self) {
        self.ladder = None;
        self.incumbent_failed = false;
        self.verdicts.push_back(Verdict::Progress);
    }

    fn cancel_ladder(&mut self) {
        self.ladder = None;
        self.incumbent_failed = false;
        self.armed_emit_top_seq = 0;
        self.armed_progress_seq = 0;
    }
}

#[cfg(test)]
mod tests;
