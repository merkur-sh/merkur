//! Ported from `apps/web/src/session/session-heartbeat.test.ts`: the same
//! schedule on an explicit clock. The RTO floor is 250 ms, so after one low
//! sample the lapse lands at 250 ms and the strike at 500 ms.

use super::*;

#[derive(Default)]
struct Link {
    closed: bool,
    refuses: bool,
    frames: Vec<Vec<u8>>,
    emit_top: u32,
    acked: u32,
}

impl LivenessLink for Link {
    fn control_open(&self) -> bool {
        !self.closed
    }
    fn send_ping(&mut self, frame: &[u8]) -> bool {
        if self.refuses {
            return false;
        }
        self.frames.push(frame.to_vec());
        true
    }
    fn progress_seq(&self) -> u32 {
        self.acked
    }
    fn emit_top_seq(&self) -> u32 {
        self.emit_top
    }
}

struct Harness {
    heartbeat: Heartbeat,
    link: Link,
    now: u64,
    verdicts: Vec<Verdict>,
}

impl Harness {
    fn new() -> Self {
        Self {
            heartbeat: Heartbeat::new(10_000),
            link: Link::default(),
            now: 1_000,
            verdicts: Vec::new(),
        }
    }

    fn drain(&mut self) {
        while let Some(verdict) = self.heartbeat.poll_verdict() {
            self.verdicts.push(verdict);
        }
    }

    fn advance(&mut self, ms: u64) {
        let target = self.now + ms;
        while let Some(at) = self.heartbeat.next_deadline().filter(|at| *at <= target) {
            self.now = at.max(self.now);
            self.heartbeat.handle_timeout(self.now, &mut self.link);
            self.drain();
        }
        self.now = target;
    }

    fn count(&self, verdict: Verdict) -> usize {
        self.verdicts
            .iter()
            .filter(|seen| **seen == verdict)
            .count()
    }

    fn immediate(&mut self) {
        self.heartbeat.send_immediate_ping(self.now, &mut self.link);
        self.drain();
    }

    fn emit(&mut self) {
        self.heartbeat.arm_on_emit(self.now, &mut self.link);
        self.drain();
    }

    fn hint(&mut self) {
        self.heartbeat
            .probe_without_resetting(self.now, &mut self.link);
        self.drain();
    }

    fn pong(&mut self) {
        self.heartbeat.record_pong_proof();
        self.drain();
    }

    fn ack(&mut self, seq: u32) {
        self.heartbeat.record_input_ack_proof(seq);
        self.drain();
    }

    fn last_token(&self) -> u64 {
        let frame = self.link.frames.last().expect("a ping was sent");
        u64::from_be_bytes(frame[frame.len() - 8..].try_into().unwrap())
    }

    /// One low sample drops the RTO to its floor.
    fn feed_rtt(&mut self, rtt_ms: u64) {
        self.immediate();
        let token = self.last_token();
        self.now += rtt_ms;
        assert_eq!(
            self.heartbeat
                .resolve_pong_rtt(token, PathKind::Relay, self.now),
            Some(rtt_ms as f64)
        );
    }

    fn primed() -> Self {
        let mut harness = Self::new();
        harness.feed_rtt(20);
        harness.pong();
        harness.verdicts.clear();
        harness
    }
}

#[test]
fn the_estimator_follows_rfc_6298_within_its_clamp() {
    let mut rtt = RttEstimator::default();
    assert_eq!(rtt.rto_ms(), RTO_INITIAL_MS);
    rtt.observe(100.0);
    assert_eq!(rtt.srtt_ms(), Some(100.0));
    assert_eq!(rtt.rto_ms(), 300.0);
    rtt.observe(200.0);
    assert_eq!(rtt.srtt_ms(), Some(112.5));
    assert_eq!(rtt.rto_ms(), 112.5 + 4.0 * 62.5);
    rtt.observe(-1.0);
    rtt.observe(f64::NAN);
    assert_eq!(rtt.srtt_ms(), Some(112.5));
    let mut slow = RttEstimator::default();
    slow.observe(5_000.0);
    assert_eq!(slow.rto_ms(), RTO_CEIL_MS);
    let mut fast = RttEstimator::default();
    fast.observe(1.0);
    assert_eq!(fast.rto_ms(), RTO_FLOOR_MS);
}

#[test]
fn escalation_starts_exactly_at_the_estimated_pong_deadline() {
    let mut h = Harness::new();
    h.feed_rtt(20);
    h.heartbeat.clear_tracking();
    h.emit();
    h.advance(249);
    assert_eq!(h.count(Verdict::Escalated), 0);
    h.advance(1);
    assert_eq!(h.count(Verdict::Escalated), 1);
}

#[test]
fn a_local_refusal_creates_neither_a_record_nor_a_deadline() {
    let mut h = Harness::new();
    h.feed_rtt(20);
    h.heartbeat.clear_tracking();
    h.link.refuses = true;
    h.emit();
    assert_eq!(h.heartbeat.pending_ping_count(), 0);
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 0);
    // Refusal does not occupy the deadline slot: later traffic retries at once.
    h.link.refuses = false;
    h.emit();
    assert_eq!(h.heartbeat.pending_ping_count(), 1);
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 1);
}

#[test]
fn start_sends_one_tracked_ping_and_a_closed_channel_sends_none() {
    let mut h = Harness::new();
    h.heartbeat.start(h.now, &mut h.link);
    assert_eq!(h.link.frames.len(), 1);
    assert_eq!(h.heartbeat.pending_ping_count(), 1);
    h.immediate();
    h.immediate();
    assert_eq!(h.heartbeat.pending_ping_count(), 1);
    h.heartbeat.clear_tracking();
    assert_eq!(h.heartbeat.pending_ping_count(), 0);

    let mut closed = Harness::new();
    closed.link.closed = true;
    closed.heartbeat.start(closed.now, &mut closed.link);
    assert!(closed.link.frames.is_empty());
}

#[test]
fn each_path_gets_one_sample_per_ping() {
    let mut h = Harness::new();
    h.immediate();
    let token = h.last_token();
    assert_eq!(
        h.heartbeat
            .resolve_pong_rtt(token, PathKind::Relay, h.now + 10),
        Some(10.0)
    );
    assert_eq!(
        h.heartbeat
            .resolve_pong_rtt(token, PathKind::Direct, h.now + 25),
        Some(25.0)
    );
    assert_eq!(
        h.heartbeat
            .resolve_pong_rtt(token, PathKind::Relay, h.now + 30),
        None
    );
    assert_eq!(
        h.heartbeat.resolve_pong_rtt(123, PathKind::Relay, h.now),
        None
    );
}

#[test]
fn tokens_stay_unique_on_a_coarse_clock() {
    let mut h = Harness::new();
    h.immediate();
    let first = h.last_token();
    h.immediate();
    assert_eq!(h.last_token(), first + 1);
}

#[test]
fn probing_continues_after_the_one_strike_for_as_long_as_nothing_answers() {
    let mut h = Harness::primed();
    h.immediate();
    h.advance(900);
    assert_eq!(h.count(Verdict::Failed), 1);
    assert!(h.heartbeat.has_incumbent_failed());
    let frames = h.link.frames.len();
    h.advance(900);
    assert_eq!(h.count(Verdict::Failed), 1);
    assert!(h.heartbeat.has_incumbent_failed());
    assert!(h.link.frames.len() >= frames + 3);
}

#[test]
fn a_round_trip_proof_ends_the_ladder() {
    let mut h = Harness::primed();
    h.immediate();
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 1);
    h.pong();
    let frames = h.link.frames.len();
    h.advance(900);
    assert_eq!(h.count(Verdict::Failed), 0);
    assert!(!h.heartbeat.has_incumbent_failed());
    assert_eq!(h.link.frames.len(), frames);
}

#[test]
fn a_refused_probe_cannot_supply_the_second_strike() {
    let mut h = Harness::primed();
    h.immediate();
    h.link.refuses = true;
    h.advance(800);
    assert_eq!(h.count(Verdict::Escalated), 1);
    assert_eq!(h.count(Verdict::Failed), 0);
    h.link.refuses = false;
    let frames = h.link.frames.len();
    while h.link.frames.len() == frames {
        h.advance(5);
    }
    assert!(!h.heartbeat.has_incumbent_failed());
    h.advance(300);
    assert_eq!(h.count(Verdict::Failed), 1);
}

#[test]
fn the_strike_comes_one_rto_after_the_lapse_and_only_once() {
    let mut h = Harness::primed();
    h.immediate();
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 1);
    assert_eq!(h.count(Verdict::Failed), 0);
    h.advance(300);
    assert_eq!(h.count(Verdict::Failed), 1);
    h.advance(300);
    assert_eq!(h.count(Verdict::Failed), 1);
}

#[test]
fn a_pong_between_the_strikes_prevents_the_second() {
    let mut h = Harness::primed();
    h.immediate();
    h.advance(400);
    h.pong();
    h.advance(500);
    assert_eq!(h.count(Verdict::Failed), 0);
}

#[test]
fn progress_after_the_lapse_prevents_the_strike() {
    let mut h = Harness::primed();
    h.link.emit_top = 5;
    h.link.acked = 1;
    h.emit();
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 1);
    h.link.acked = 4;
    h.advance(300);
    assert_eq!(h.count(Verdict::Failed), 0);
}

#[test]
fn progress_between_probes_stands_the_whole_ladder_down() {
    let mut h = Harness::primed();
    h.link.emit_top = 5;
    h.link.acked = 1;
    h.emit();
    h.advance(400);
    let frames = h.link.frames.len();
    h.link.acked = 2;
    h.advance(1_000);
    assert_eq!(h.count(Verdict::Failed), 0);
    assert_eq!(h.link.frames.len(), frames);
}

#[test]
fn progress_after_the_strike_retracts_it() {
    let mut h = Harness::primed();
    h.link.emit_top = 5;
    h.link.acked = 1;
    h.emit();
    h.advance(650);
    assert_eq!(h.count(Verdict::Failed), 1);
    let frames = h.link.frames.len();
    h.link.acked = 2;
    h.advance(800);
    assert!(!h.heartbeat.has_incumbent_failed());
    assert_eq!(h.count(Verdict::Failed), 1);
    assert_eq!(h.link.frames.len(), frames);
}

#[test]
fn every_teardown_clears_the_strike() {
    let mut h = Harness::primed();
    h.immediate();
    h.advance(700);
    assert!(h.heartbeat.has_incumbent_failed());
    h.pong();
    assert!(!h.heartbeat.has_incumbent_failed());
    h.immediate();
    h.advance(700);
    assert!(h.heartbeat.has_incumbent_failed());
    h.heartbeat.clear_tracking();
    assert!(!h.heartbeat.has_incumbent_failed());
    h.immediate();
    h.advance(700);
    assert!(h.heartbeat.has_incumbent_failed());
    h.heartbeat.stop();
    assert!(!h.heartbeat.has_incumbent_failed());
}

#[test]
fn a_hint_adds_a_probe_without_restarting_the_ladder() {
    let mut h = Harness::primed();
    h.immediate();
    h.advance(100);
    let frames = h.link.frames.len();
    h.hint();
    h.hint();
    assert_eq!(h.link.frames.len(), frames + 2);
    // Still one RTO after the original lapse, not after the last hint.
    h.advance(550);
    assert_eq!(h.count(Verdict::Escalated), 1);
    assert_eq!(h.count(Verdict::Failed), 1);
}

#[test]
fn an_ack_covering_the_arm_time_emit_clears_a_deadline_newer_emits_outlived() {
    let mut h = Harness::primed();
    h.link.emit_top = 1;
    h.emit();
    h.link.emit_top = 2;
    h.emit();
    h.link.emit_top = 3;
    h.emit();
    h.ack(1);
    h.link.acked = 1;
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 0);
}

#[test]
fn a_duplicate_ack_below_the_arm_time_emit_does_not_clear() {
    let mut h = Harness::primed();
    h.link.emit_top = 5;
    h.link.acked = 3;
    h.emit();
    h.ack(3);
    assert_eq!(h.count(Verdict::Progress), 0);
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 1);
}

#[test]
fn progress_during_the_deadline_suppresses_escalation() {
    let mut h = Harness::primed();
    h.link.emit_top = 5;
    h.link.acked = 1;
    h.emit();
    h.link.acked = 3;
    h.advance(400);
    assert_eq!(h.count(Verdict::Escalated), 0);
    assert!(!h.heartbeat.has_incumbent_failed());
}

#[test]
fn local_cleanup_is_not_proof() {
    let mut h = Harness::new();
    h.emit();
    h.immediate();
    h.heartbeat.clear_tracking();
    h.heartbeat.stop();
    h.drain();
    assert_eq!(h.count(Verdict::Progress), 0);
}

#[test]
fn an_emit_during_a_live_deadline_sends_nothing() {
    let mut h = Harness::primed();
    h.link.emit_top = 1;
    h.emit();
    let frames = h.link.frames.len();
    h.emit();
    h.emit();
    assert_eq!(h.link.frames.len(), frames);
}

#[test]
fn the_steady_tick_sends_one_ping_per_interval_until_stopped() {
    let mut h = Harness::new();
    h.heartbeat.start(h.now, &mut h.link);
    assert_eq!(h.link.frames.len(), 1);
    for tick in 1..=3 {
        h.pong();
        h.advance(9_999);
        assert_eq!(h.link.frames.len(), tick);
        h.advance(1);
        assert_eq!(h.link.frames.len(), 1 + tick);
    }
    h.pong();
    h.heartbeat.stop();
    h.advance(30_000);
    assert_eq!(h.link.frames.len(), 4);
}
