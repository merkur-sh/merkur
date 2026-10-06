//! Careful Resume (RFC 9959): a connection that succeeds another on the same
//! path starts from the capacity its predecessor demonstrated, and validates
//! that capacity before it keeps it.
//!
//! Every connection observes the most bytes one round trip delivered while its
//! window, not the application, bounded the round. A successor on the same
//! path consumes that observation once. It sends under its initial window
//! until its first flight is acknowledged (Reconnaissance), jumps to half the
//! observed capacity, paced, once more data waits than its whole window holds
//! (Unvalidated), keeps the flight that jump put on the path until it is
//! acknowledged (Validating), and halves the pipe it validated if any of it
//! was lost (Safe Retreat).
//!
//! The observation is the predecessor's own congestion state, handed over at
//! succession. It never outlives the window the predecessor itself would
//! send with, so no lifetime applies beyond the predecessor's.

use std::net::IpAddr;

use crate::connection::RttEstimator;
use crate::{Duration, Instant};

/// The capacity one connection demonstrated on its path, for one successor on
/// the same path. A connection gives at most one, and a successor consumes it.
#[derive(Debug)]
pub struct CarefulResumeObservation {
    pub(crate) saved_cwnd: u64,
    pub(crate) saved_rtt: Duration,
    pub(crate) local_ip: Option<IpAddr>,
    pub(crate) remote_ip: IpAddr,
}

impl CarefulResumeObservation {
    /// The most bytes one round delivered while the window bounded it, no
    /// more than the window when the observation was taken
    pub fn saved_cwnd(&self) -> u64 {
        self.saved_cwnd
    }

    /// The path's minimum round-trip time
    pub fn saved_rtt(&self) -> Duration {
        self.saved_rtt
    }
}

/// A window Careful Resume hands back to the congestion controller at a phase
/// boundary
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeWindow {
    /// Continue from this window
    Set(u64),
    /// The safe retreat ended having validated `pipe` bytes: the slow-start
    /// threshold becomes the controller's own loss reduction of it
    /// (RFC 9959 §3.5), and the window stays where the retreat put it
    Retreated {
        /// Bytes acknowledged since the jump, counting the flight before it
        pipe: u64,
    },
}

/// Delivery rounds: the most bytes one round acknowledged while some packet of
/// it found the window full
#[derive(Debug, Default)]
pub(crate) struct Observer {
    /// An acknowledged packet numbered at or above this ends the round
    round_end: u64,
    delivered: u64,
    window_limited: bool,
    best: u64,
}

impl Observer {
    /// One of the connection's own in-flight packets was acknowledged;
    /// `next_pn` is the number the connection sends next.
    pub(crate) fn on_acked(&mut self, pn: u64, bytes: u64, window_limited: bool, next_pn: u64) {
        self.delivered += bytes;
        self.window_limited |= window_limited;
        if pn >= self.round_end {
            if self.window_limited {
                self.best = self.best.max(self.delivered);
            }
            self.round_end = next_pn;
            self.delivered = 0;
            self.window_limited = false;
        }
    }

    pub(crate) fn best(&self) -> u64 {
        self.best
    }
}

/// What a detected congestion signal means while resuming
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Congestion {
    /// The controller reacts as it normally would
    Forward,
    /// Retreat: the controller continues from this window, and hears nothing
    /// of the signal itself
    Retreat(ResumeWindow),
    /// Losses of the drained jump: the retreat already reacted to them
    Absorb,
}

/// One connection's use of one observation
#[derive(Debug)]
pub(crate) struct CarefulResume {
    saved_cwnd: u64,
    saved_rtt: Duration,
    initial_window: u64,
    phase: Phase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Under the initial window until `confirm`, the last packet sent before
    /// resuming, is acknowledged
    Reconnaissance {
        confirm: u64,
        confirmed: bool,
    },
    /// Sending into `jump`, paced; `pipe` is the flight at the jump plus every
    /// byte acknowledged since
    Unvalidated {
        entered: Instant,
        jump: u64,
        first: Option<u64>,
        last: u64,
        pipe: u64,
    },
    /// Waiting for the last unvalidated packet's acknowledgment
    Validating {
        last_unvalidated: u64,
        last_sent: u64,
        pipe: u64,
    },
    /// Draining the jump under half the validated pipe until the last packet
    /// sent before the retreat is acknowledged
    SafeRetreat {
        last: u64,
        pipe: u64,
    },
    Done,
}

impl CarefulResume {
    /// Reconnaissance from `observation`; `confirm` is the last packet number
    /// the connection sent before resuming.
    pub(crate) fn new(
        observation: CarefulResumeObservation,
        initial_window: u64,
        confirm: u64,
    ) -> Self {
        Self {
            saved_cwnd: observation.saved_cwnd,
            saved_rtt: observation.saved_rtt,
            initial_window,
            phase: Phase::Reconnaissance {
                confirm,
                confirmed: false,
            },
        }
    }

    /// Whether the connection is still resuming
    pub(crate) fn active(&self) -> bool {
        self.phase != Phase::Done
    }

    /// The controller refused a window: it never resumes.
    pub(crate) fn abandon(&mut self) {
        self.phase = Phase::Done;
    }

    /// Whether acknowledgments may grow the controller's window. An
    /// unvalidated jump and a safe retreat hold it where they set it.
    pub(crate) fn forwards_acks(&self) -> bool {
        !matches!(
            self.phase,
            Phase::Unvalidated { .. } | Phase::SafeRetreat { .. }
        )
    }

    /// The jump to pace while it is unvalidated
    pub(crate) fn unvalidated_jump(&self) -> Option<u64> {
        match self.phase {
            Phase::Unvalidated { jump, .. } => Some(jump),
            _ => None,
        }
    }

    /// Whether the path is confirmed and the jump waits for data
    pub(crate) fn awaits_jump(&self) -> bool {
        matches!(
            self.phase,
            Phase::Reconnaissance {
                confirmed: true,
                ..
            }
        )
    }

    /// The window holds back data the sender has. RFC 9959 §3.2 defers the
    /// jump to when more is waiting than the controller would permit: a
    /// `backlog` beyond the whole window, which this round cannot carry. A
    /// jump taken on less expires one round trip later before the data it was
    /// for arrives. The jump also needs a confirmed path whose round trip
    /// matches the observation (§4.2.1). Any other answer ends the resume,
    /// except an unconfirmed path or a smaller backlog, which keep waiting.
    pub(crate) fn jump(
        &mut self,
        now: Instant,
        flight: u64,
        window: u64,
        backlog: u64,
        rtt: &RttEstimator,
    ) -> Option<ResumeWindow> {
        if !self.awaits_jump() || backlog <= window {
            return None;
        }
        let jump = self.saved_cwnd / 2;
        if !self.rtt_matches(rtt) || jump <= window {
            self.phase = Phase::Done;
            return None;
        }
        self.phase = Phase::Unvalidated {
            entered: now,
            jump,
            first: None,
            last: 0,
            pipe: flight,
        };
        Some(ResumeWindow::Set(jump))
    }

    /// One of the connection's own in-flight packets left, with `flight` now
    /// in flight under `window`.
    pub(crate) fn on_sent(
        &mut self,
        now: Instant,
        pn: u64,
        flight: u64,
        window: u64,
        mtu: u64,
        rtt: &RttEstimator,
    ) -> Option<ResumeWindow> {
        match &mut self.phase {
            Phase::Unvalidated {
                entered,
                first,
                last,
                ..
            } => {
                first.get_or_insert(pn);
                *last = pn;
                // The jump is spent once less than a full packet of it is
                // left, or after one round trip (RFC 9959 §3.3).
                if window.saturating_sub(flight) < mtu || now - *entered > rtt.get() {
                    return self.leave_unvalidated(flight);
                }
                None
            }
            Phase::Validating { last_sent, .. } => {
                *last_sent = pn;
                None
            }
            _ => None,
        }
    }

    /// One of the connection's own in-flight packets was acknowledged.
    pub(crate) fn on_acked(&mut self, bytes: u64) {
        match &mut self.phase {
            Phase::Unvalidated { pipe, .. }
            | Phase::Validating { pipe, .. }
            | Phase::SafeRetreat { pipe, .. } => *pipe += bytes,
            _ => {}
        }
    }

    /// An acknowledgment frame was processed, its losses included, leaving
    /// `flight` in flight; `largest_acked` is the largest packet number ever
    /// acknowledged.
    pub(crate) fn on_ack_frame(
        &mut self,
        now: Instant,
        largest_acked: u64,
        flight: u64,
        mtu: u64,
        rtt: &RttEstimator,
    ) -> Option<ResumeWindow> {
        match &mut self.phase {
            Phase::Reconnaissance { confirm, confirmed } => {
                *confirmed |= largest_acked >= *confirm;
                None
            }
            Phase::Unvalidated { entered, first, .. } => {
                let entered = *entered;
                let first_acked = first.is_some_and(|first| largest_acked >= first);
                if !self.rtt_matches(rtt) {
                    // The path changed under the jump (RFC 9959 §3.3).
                    return self.retreat(mtu);
                }
                if first_acked || now - entered > rtt.get() {
                    return self.leave_unvalidated(flight);
                }
                None
            }
            Phase::Validating {
                last_unvalidated, ..
            } => {
                if largest_acked >= *last_unvalidated {
                    self.phase = Phase::Done;
                }
                None
            }
            Phase::SafeRetreat { last, pipe } => {
                if largest_acked < *last {
                    return None;
                }
                let pipe = *pipe;
                self.phase = Phase::Done;
                Some(ResumeWindow::Retreated { pipe })
            }
            Phase::Done => None,
        }
    }

    /// Loss of, or a congestion mark on, the connection's own packets
    pub(crate) fn on_congestion(&mut self, persistent: bool, mtu: u64) -> Congestion {
        if persistent {
            // RFC 9959 §3.6: persistent congestion ends the resume and the
            // controller collapses as it would anyway.
            self.phase = Phase::Done;
            return Congestion::Forward;
        }
        match self.phase {
            Phase::Reconnaissance { .. } => {
                self.phase = Phase::Done;
                Congestion::Forward
            }
            Phase::Unvalidated { .. } | Phase::Validating { .. } => match self.retreat(mtu) {
                Some(window) => Congestion::Retreat(window),
                None => Congestion::Forward,
            },
            Phase::SafeRetreat { .. } => Congestion::Absorb,
            Phase::Done => Congestion::Forward,
        }
    }

    /// The connection moved to another path. A jumped window leaves with the
    /// windows a retreat would have left (RFC 9959 §3.3): whatever the
    /// controller carried over continues from them.
    pub(crate) fn on_path_change(&mut self, mtu: u64) -> Option<[ResumeWindow; 2]> {
        let pipe = match self.phase {
            Phase::Unvalidated { pipe, .. }
            | Phase::Validating { pipe, .. }
            | Phase::SafeRetreat { pipe, .. } => Some(pipe),
            Phase::Reconnaissance { .. } | Phase::Done => None,
        };
        self.phase = Phase::Done;
        pipe.map(|pipe| {
            [
                ResumeWindow::Set(retreat_window(pipe, mtu)),
                ResumeWindow::Retreated { pipe },
            ]
        })
    }

    /// RFC 9959 §4.2.1: a minimum RTT at or below half the saved one, or a
    /// current one above ten times it, is another path.
    fn rtt_matches(&self, rtt: &RttEstimator) -> bool {
        rtt.min() > self.saved_rtt / 2 && rtt.latest() <= self.saved_rtt * 10
    }

    /// RFC 9959 §3.3, "check flight_size": a sender that did not use the jump
    /// keeps what it validated; one that did keeps its flight to validate it.
    fn leave_unvalidated(&mut self, flight: u64) -> Option<ResumeWindow> {
        let Phase::Unvalidated { last, pipe, .. } = self.phase else {
            return None;
        };
        if flight < self.initial_window || flight <= pipe {
            self.phase = Phase::Done;
            return Some(ResumeWindow::Set(pipe.max(self.initial_window)));
        }
        self.phase = Phase::Validating {
            last_unvalidated: last,
            last_sent: last,
            pipe,
        };
        Some(ResumeWindow::Set(flight))
    }

    fn retreat(&mut self, mtu: u64) -> Option<ResumeWindow> {
        let (last, pipe) = match self.phase {
            Phase::Unvalidated { last, pipe, .. } => (last, pipe),
            Phase::Validating {
                last_sent, pipe, ..
            } => (last_sent, pipe),
            _ => return None,
        };
        self.phase = Phase::SafeRetreat { last, pipe };
        Some(ResumeWindow::Set(retreat_window(pipe, mtu)))
    }
}

/// RFC 9959 §3.5: no more than half the validated pipe, and never below
/// QUIC's two-packet minimum.
fn retreat_window(pipe: u64, mtu: u64) -> u64 {
    (pipe / 2).max(2 * mtu)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    const IW: u64 = 12_000;
    const MTU: u64 = 1_200;
    const SAVED: u64 = 160_000;
    /// Data waiting beyond any window these tests jump from
    const BACKLOG: u64 = 100_000;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    fn rtt(min: u64, latest: u64) -> RttEstimator {
        let mut rtt = RttEstimator::new(ms(333));
        rtt.update(Duration::ZERO, ms(min));
        rtt.update(Duration::ZERO, ms(latest));
        rtt
    }

    fn resume() -> CarefulResume {
        CarefulResume::new(
            CarefulResumeObservation {
                saved_cwnd: SAVED,
                saved_rtt: ms(60),
                local_ip: None,
                remote_ip: Ipv4Addr::LOCALHOST.into(),
            },
            IW,
            10,
        )
    }

    /// Confirmed, then jumped at `now` with 6,000 bytes in flight.
    fn jumped(now: Instant) -> CarefulResume {
        let mut resume = resume();
        resume.on_ack_frame(now, 10, 0, MTU, &rtt(60, 60));
        assert_eq!(
            resume.jump(now, 6_000, IW, BACKLOG, &rtt(60, 60)),
            Some(ResumeWindow::Set(SAVED / 2))
        );
        resume
    }

    #[test]
    fn rounds_count_only_when_the_window_bounded_them() {
        let mut observer = Observer::default();
        // The first acknowledgment opens the first round, which ends at 10.
        observer.on_acked(0, 1_000, false, 10);
        // That round, packets 1..=10, was application-limited: nothing saved.
        for pn in 1..=10 {
            observer.on_acked(pn, 1_000, false, 20);
        }
        assert_eq!(observer.best(), 0);
        // The next round, packets 11..=20, found the window full once.
        for pn in 11..=20 {
            observer.on_acked(pn, 1_000, pn == 15, 40);
        }
        assert_eq!(observer.best(), 10_000);
        // A smaller later round never lowers the best.
        for pn in 21..=40 {
            observer.on_acked(pn, 100, true, 60);
        }
        assert_eq!(observer.best(), 10_000);
    }

    #[test]
    fn an_unconfirmed_path_waits_and_a_confirmed_one_jumps_to_half() {
        let now = Instant::now();
        let mut resume = resume();
        assert_eq!(resume.jump(now, 6_000, IW, BACKLOG, &rtt(60, 60)), None);
        assert!(resume.active(), "waiting for the first flight's ACK");
        resume.on_ack_frame(now, 9, 0, MTU, &rtt(60, 60));
        assert_eq!(resume.jump(now, 6_000, IW, BACKLOG, &rtt(60, 60)), None);
        resume.on_ack_frame(now, 10, 0, MTU, &rtt(60, 60));
        assert_eq!(
            resume.jump(now, 6_000, IW, BACKLOG, &rtt(60, 60)),
            Some(ResumeWindow::Set(80_000))
        );
        assert_eq!(resume.unvalidated_jump(), Some(80_000));
        assert!(!resume.forwards_acks());
    }

    #[test]
    fn a_backlog_the_window_covers_keeps_waiting() {
        let now = Instant::now();
        let mut resume = resume();
        resume.on_ack_frame(now, 10, 0, MTU, &rtt(60, 60));
        // An echo filling the initial window is not the redraw behind it.
        assert_eq!(resume.jump(now, 11_000, IW, 1_200, &rtt(60, 60)), None);
        assert_eq!(resume.jump(now, 11_000, IW, IW, &rtt(60, 60)), None);
        assert!(resume.awaits_jump());
        assert_eq!(
            resume.jump(now, 11_000, IW, IW + 1, &rtt(60, 60)),
            Some(ResumeWindow::Set(SAVED / 2))
        );
    }

    #[test]
    fn an_rtt_outside_the_gates_ends_the_resume() {
        let now = Instant::now();
        for (min, latest) in [(30, 60), (20, 20), (60, 601)] {
            let mut resume = resume();
            resume.on_ack_frame(now, 10, 0, MTU, &rtt(min, latest));
            assert_eq!(
                resume.jump(now, 6_000, IW, BACKLOG, &rtt(min, latest)),
                None
            );
            assert!(!resume.active(), "min {min} latest {latest}");
        }
        // Just inside both gates.
        let mut resume = resume();
        resume.on_ack_frame(now, 10, 0, MTU, &rtt(31, 600));
        assert!(
            resume
                .jump(now, 6_000, IW, BACKLOG, &rtt(31, 600))
                .is_some()
        );
    }

    #[test]
    fn a_window_already_past_the_jump_ends_the_resume() {
        let now = Instant::now();
        let mut resume = resume();
        resume.on_ack_frame(now, 10, 0, MTU, &rtt(60, 60));
        assert_eq!(
            resume.jump(now, 6_000, SAVED / 2, BACKLOG, &rtt(60, 60)),
            None
        );
        assert!(!resume.active());
    }

    #[test]
    fn a_spent_jump_validates_its_flight_then_ends_at_its_last_ack() {
        let now = Instant::now();
        let mut resume = jumped(now);
        let rtt = rtt(60, 60);
        assert_eq!(resume.on_sent(now, 11, 30_000, 80_000, MTU, &rtt), None);
        // Less than a packet of the jump is left.
        assert_eq!(
            resume.on_sent(now, 70, 79_000, 80_000, MTU, &rtt),
            Some(ResumeWindow::Set(79_000))
        );
        assert!(resume.forwards_acks(), "validating grows by slow start");
        assert_eq!(resume.on_sent(now, 71, 80_000, 82_000, MTU, &rtt), None);
        assert_eq!(resume.on_ack_frame(now, 69, 10_000, MTU, &rtt), None);
        assert!(resume.active());
        assert_eq!(resume.on_ack_frame(now, 70, 9_000, MTU, &rtt), None);
        assert!(!resume.active());
    }

    #[test]
    fn the_first_unvalidated_ack_ends_the_jump() {
        let now = Instant::now();
        let mut resume = jumped(now);
        let rtt = rtt(60, 60);
        resume.on_sent(now, 11, 20_000, 80_000, MTU, &rtt);
        resume.on_sent(now, 30, 40_000, 80_000, MTU, &rtt);
        resume.on_acked(1_200);
        assert_eq!(
            resume.on_ack_frame(now, 11, 38_800, MTU, &rtt),
            Some(ResumeWindow::Set(38_800))
        );
        assert!(resume.forwards_acks());
    }

    #[test]
    fn a_jump_held_past_one_rtt_ends() {
        let now = Instant::now();
        let mut resume = jumped(now);
        let rtt = rtt(60, 60);
        resume.on_sent(now, 11, 20_000, 80_000, MTU, &rtt);
        assert_eq!(
            resume.on_sent(now + ms(61), 12, 21_200, 80_000, MTU, &rtt),
            Some(ResumeWindow::Set(21_200))
        );
    }

    #[test]
    fn an_unused_jump_keeps_only_what_was_validated() {
        let now = Instant::now();
        let mut resume = jumped(now);
        let rtt = rtt(60, 60);
        resume.on_sent(now, 11, 7_200, 80_000, MTU, &rtt);
        resume.on_acked(6_000);
        // The flight fell below the initial window: rate limited.
        assert_eq!(
            resume.on_ack_frame(now + ms(61), 10, 1_200, MTU, &rtt),
            Some(ResumeWindow::Set(IW))
        );
        assert!(!resume.active());
        // A flight within the pipe ends the same way, at the pipe.
        let mut resume = jumped(now);
        resume.on_sent(now, 11, 20_000, 80_000, MTU, &rtt);
        resume.on_acked(30_000);
        assert_eq!(
            resume.on_ack_frame(now + ms(61), 10, 20_000, MTU, &rtt),
            Some(ResumeWindow::Set(36_000))
        );
        assert!(!resume.active());
    }

    #[test]
    fn loss_retreats_to_half_the_pipe_and_leaves_with_its_threshold() {
        let now = Instant::now();
        let mut resume = jumped(now);
        let rtt = rtt(60, 60);
        resume.on_sent(now, 11, 40_000, 80_000, MTU, &rtt);
        resume.on_sent(now, 40, 70_000, 80_000, MTU, &rtt);
        resume.on_acked(10_000);
        assert_eq!(
            resume.on_congestion(false, MTU),
            Congestion::Retreat(ResumeWindow::Set(8_000))
        );
        assert!(!resume.forwards_acks(), "a retreat never grows");
        assert_eq!(resume.on_congestion(false, MTU), Congestion::Absorb);
        resume.on_acked(20_000);
        assert_eq!(resume.on_ack_frame(now, 39, 30_000, MTU, &rtt), None);
        assert_eq!(
            resume.on_ack_frame(now, 40, 10_000, MTU, &rtt),
            Some(ResumeWindow::Retreated { pipe: 36_000 })
        );
        assert!(!resume.active());
    }

    #[test]
    fn a_validating_loss_retreats_until_its_last_sent_packet() {
        let now = Instant::now();
        let mut resume = jumped(now);
        let rtt = rtt(60, 60);
        resume.on_sent(now, 70, 79_000, 80_000, MTU, &rtt);
        resume.on_sent(now, 90, 100_000, 120_000, MTU, &rtt);
        assert_eq!(
            resume.on_congestion(false, MTU),
            Congestion::Retreat(ResumeWindow::Set(3_000.max(2 * MTU)))
        );
        assert_eq!(resume.on_ack_frame(now, 70, 50_000, MTU, &rtt), None);
        assert!(resume.on_ack_frame(now, 90, 0, MTU, &rtt).is_some());
    }

    #[test]
    fn reconnaissance_loss_and_persistent_congestion_go_to_the_controller() {
        let now = Instant::now();
        let mut resume = resume();
        assert_eq!(resume.on_congestion(false, MTU), Congestion::Forward);
        assert!(!resume.active());
        let mut resume = jumped(now);
        assert_eq!(resume.on_congestion(true, MTU), Congestion::Forward);
        assert!(!resume.active());
    }

    #[test]
    fn an_rtt_change_under_the_jump_retreats() {
        let now = Instant::now();
        let mut resume = jumped(now);
        resume.on_sent(now, 11, 40_000, 80_000, MTU, &rtt(60, 60));
        assert_eq!(
            resume.on_ack_frame(now, 10, 40_000, MTU, &rtt(60, 700)),
            Some(ResumeWindow::Set(3_000.max(2 * MTU)))
        );
        assert!(!resume.forwards_acks());
    }

    #[test]
    fn a_path_change_leaves_with_the_retreat_windows() {
        let now = Instant::now();
        let mut resume = resume();
        assert_eq!(resume.on_path_change(MTU), None);
        assert!(!resume.active());
        let mut resume = jumped(now);
        resume.on_acked(30_000);
        assert_eq!(
            resume.on_path_change(MTU),
            Some([
                ResumeWindow::Set(18_000),
                ResumeWindow::Retreated { pipe: 36_000 }
            ])
        );
        assert!(!resume.active());
    }
}
