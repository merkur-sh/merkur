//! Diagnostic measurements only; no sample below authorizes recovery.
use crate::liveness::PathKind;
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct Quality {
    path: Option<PathKind>,
    samples: VecDeque<(u64, f64)>,
    latest_rtt: Option<f64>,
    rtt_revision: u32,
    ack_local: u32,
    ack_at: u64,
    sent_local: u32,
    sent_at: u64,
    input_ack: Option<f64>,
    input_sample_seq: u32,
    resync_at: Option<u64>,
    resync_count: u32,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub rtt_ms: Option<f64>,
    pub network_rtt_ms: Option<f64>,
    pub input_ack_rtt_ms: Option<f64>,
    pub input_ack_ms: Option<f64>,
    pub input_ack_seq: u32,
    pub resync_count: u32,
    pub degraded: bool,
}
impl Quality {
    pub(super) fn path(&mut self, path: PathKind) {
        if self.path != Some(path) {
            self.path = Some(path);
            self.samples.clear();
        }
    }
    pub(super) fn rtt(&mut self, now: u64, path: PathKind, sample: f64) {
        self.path(path);
        self.latest_rtt = Some(sample);
        self.rtt_revision = self.rtt_revision.wrapping_add(1);
        while self
            .samples
            .front()
            .is_some_and(|(at, _)| *at < now.saturating_sub(8_000))
        {
            self.samples.pop_front();
        }
        self.samples.push_back((now, sample));
    }
    pub(super) fn floor(&self, path: PathKind) -> Option<f64> {
        (self.path == Some(path))
            .then(|| self.samples.iter().map(|(_, rtt)| *rtt).reduce(f64::min))
            .flatten()
    }
    pub(super) fn rtt_revision(&self) -> u32 {
        self.rtt_revision
    }
    pub(super) fn acknowledged(&mut self, now: u64, local: u32) {
        self.ack_local = local;
        self.ack_at = now;
    }
    pub(super) fn sent(&mut self, now: u64, local: u32) {
        self.sent_local = local;
        self.sent_at = now;
    }
    pub(super) fn ack_projection(&self) -> (u32, u64) {
        (self.ack_local, self.ack_at)
    }
    pub(super) fn sent_projection(&self) -> (u32, u64) {
        (self.sent_local, self.sent_at)
    }
    pub(super) fn input_ack(&mut self, sample: f64) {
        self.input_ack = Some(sample);
        self.input_sample_seq = self.input_sample_seq.wrapping_add(1);
    }
    pub(super) fn resync(&mut self, now: u64) {
        self.resync_at = Some(now);
        self.resync_count = self.resync_count.saturating_add(1);
    }
    pub(super) fn snapshot(&self, now: u64, input_ack_rtt_ms: Option<f64>) -> Snapshot {
        Snapshot {
            rtt_ms: self.latest_rtt,
            network_rtt_ms: self
                .samples
                .iter()
                .map(|(_, sample)| *sample)
                .reduce(f64::min),
            input_ack_rtt_ms,
            input_ack_ms: self.input_ack,
            input_ack_seq: self.input_sample_seq,
            resync_count: self.resync_count,
            degraded: self
                .resync_at
                .is_some_and(|at| now.saturating_sub(at) < 5_000),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_changes_clear_floor_and_raw_sample_remains_distinct() {
        let mut quality = Quality::default();
        quality.rtt(0, PathKind::Relay, 20.0);
        quality.rtt(2_000, PathKind::Relay, 100.0);
        let snapshot = quality.snapshot(2_000, None);
        assert_eq!(snapshot.rtt_ms, Some(100.0));
        assert_eq!(snapshot.network_rtt_ms, Some(20.0));
        quality.rtt(9_000, PathKind::Relay, 50.0);
        assert_eq!(quality.snapshot(9_000, None).network_rtt_ms, Some(50.0));
        quality.path(PathKind::Direct);
        assert_eq!(quality.snapshot(9_000, None).network_rtt_ms, None);
    }
    #[test]
    fn input_samples_and_display_recovery_have_exact_observation_counters() {
        let mut quality = Quality::default();
        quality.input_ack(30.0);
        quality.input_ack(40.0);
        quality.resync(100);
        let snapshot = quality.snapshot(101, Some(32.0));
        assert_eq!(snapshot.input_ack_seq, 2);
        assert_eq!(snapshot.input_ack_ms, Some(40.0));
        assert_eq!(snapshot.input_ack_rtt_ms, Some(32.0));
        assert_eq!(snapshot.resync_count, 1);
        assert!(snapshot.degraded);
        assert!(!quality.snapshot(5_100, None).degraded);
    }
}
