//! Idle cumulative-input retransmission, clocked by actual carrier admission.
//! Karn ambiguity and persistent backoff match the browser's delivery policy.
#[derive(Default)]
pub(super) struct Retry {
    attempt: i32,
    srtt: Option<f64>,
    sent: u32,
    timed: u32,
    timed_at: u64,
    deadline: Option<u64>,
}
impl Retry {
    fn delay(&self) -> u64 {
        (self.srtt.map_or(40.0, |rtt| rtt * 1.5).max(40.0) * 1.5f64.powi(self.attempt))
            .min(1_000.0)
            .ceil() as u64
    }
    pub(super) fn emitted(&mut self, now: u64, top: u32, unacknowledged: bool) {
        if top > self.sent {
            self.sent = top;
            self.timed = top;
            self.timed_at = now;
        } else if top >= self.timed {
            self.timed = 0;
        }
        self.deadline = unacknowledged.then(|| now.saturating_add(self.delay()));
    }
    pub(super) fn ack(&mut self, now: u64, sequence: u32, unacknowledged: bool) -> Option<f64> {
        let sample = (self.timed != 0 && sequence >= self.timed)
            .then(|| now.saturating_sub(self.timed_at) as f64);
        if let Some(sample) = sample {
            self.srtt = Some(
                self.srtt
                    .map_or(sample, |previous| previous + 0.2 * (sample - previous)),
            );
            self.timed = 0;
            self.attempt = 0;
        }
        if !unacknowledged {
            self.deadline = None;
        }
        sample
    }
    pub(super) fn fire(&mut self, now: u64) -> bool {
        if self.deadline.is_none_or(|at| at > now) {
            return false;
        }
        self.deadline = None;
        self.attempt = (self.attempt + 1).min(32);
        true
    }
    pub(super) fn restart(&mut self) {
        self.sent = 0;
        self.timed = 0;
        self.deadline = None;
    }
    pub(super) fn cancel(&mut self) {
        self.restart();
        self.attempt = 0;
    }
    pub(super) fn deadline(&self) -> Option<u64> {
        self.deadline
    }
    pub(super) fn srtt(&self) -> Option<f64> {
        self.srtt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quiet_suffix_retries_without_an_attempt_limit_or_multiple_deadlines() {
        let mut retry = Retry::default();
        retry.emitted(0, 1, true);
        assert!(!retry.fire(39));
        assert!(retry.fire(40));
        assert!(!retry.fire(40));
        retry.emitted(40, 1, true);
        assert_eq!(retry.deadline(), Some(100));
        for _ in 0..100 {
            let at = retry.deadline().unwrap();
            assert!(retry.fire(at));
            retry.emitted(at, 1, true);
        }
        let at = retry.deadline().unwrap();
        assert!(retry.fire(at));
        retry.emitted(at, 1, true);
        assert_eq!(retry.deadline(), Some(at + 1_000));
        assert_eq!(retry.ack(at + 1, 1, false), None);
        assert_eq!(retry.deadline(), None);
    }
    #[test]
    fn karn_ambiguity_does_not_collapse_the_estimate_and_new_input_keeps_backoff() {
        let mut retry = Retry::default();
        retry.emitted(0, 1, true);
        assert_eq!(retry.ack(100, 1, false), Some(100.0));
        assert_eq!(retry.srtt(), Some(100.0));
        retry.emitted(200, 2, true);
        assert_eq!(retry.deadline(), Some(350));
        assert!(retry.fire(350));
        retry.emitted(350, 2, true);
        assert_eq!(retry.ack(351, 2, false), None);
        assert_eq!(retry.srtt(), Some(100.0));
        retry.emitted(400, 3, true);
        assert_eq!(retry.deadline(), Some(625));
        assert_eq!(retry.ack(500, 3, false), Some(100.0));
        retry.emitted(600, 4, true);
        assert_eq!(retry.deadline(), Some(750));
    }
    #[test]
    fn a_new_emit_clocks_the_quiet_gap_and_only_the_newest_unambiguous_input() {
        let mut retry = Retry::default();
        retry.emitted(0, 1, true);
        retry.emitted(10, 2, true);
        assert_eq!(retry.deadline(), Some(50));
        assert_eq!(retry.ack(20, 1, true), None);
        assert_eq!(retry.ack(30, 2, false), Some(20.0));
        retry.emitted(40, 3, true);
        retry.emitted(45, 3, true);
        assert_eq!(retry.ack(60, 3, false), None);
    }
    #[test]
    fn sequence_restart_preserves_estimate_and_backoff_but_forgets_timing() {
        let mut retry = Retry::default();
        retry.emitted(0, 8, true);
        retry.ack(80, 8, false);
        retry.emitted(100, 9, true);
        assert!(retry.fire(220));
        retry.emitted(220, 9, true);
        retry.restart();
        assert_eq!(retry.deadline(), None);
        assert_eq!(retry.ack(230, 9, false), None);
        retry.emitted(240, 1, true);
        assert_eq!(retry.deadline(), Some(420));
        retry.cancel();
        retry.emitted(500, 2, true);
        assert_eq!(retry.deadline(), Some(620));
    }
}
