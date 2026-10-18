//! Authenticated provider ranking: each provider's propagation floor, the lowest datagram
//! heartbeat round trip within the last `FLOOR_WINDOW_MS`.
use crate::liveness::PathKind;

/// A budget from measured inputs: the window outlasts the longest delay a sample carries that
/// the path itself does not (a sleeping cellular radio's paging wake, about 1–2 s; a display
/// burst queued ahead of the pong) and stays short enough to follow a re-route. Five paired
/// rounds at `HEARTBEAT_INTERVAL_MS`; BBR's min-RTT filter uses the same 10 s.
pub(super) const FLOOR_WINDOW_MS: u64 = 5 * super::HEARTBEAT_INTERVAL_MS;
/// The readout's smoothing; selection never reads it.
const RTT_EWMA_ALPHA: f64 = 0.3;

/// Kathleen Nichols' windowed minimum (Linux `win_minmax`) over `(at_ms, rtt_ms)`: the best,
/// second and third best samples of the window, so a minimum that leaves it hands over without
/// storing every sample.
#[derive(Clone, Copy, Default)]
struct Floor { samples: [(u64, u64); 3], measured: bool }

impl Floor {
    fn observe(&mut self, now_ms: u64, rtt_ms: u64) {
        let sample = (now_ms, rtt_ms);
        if !self.measured || rtt_ms <= self.samples[0].1 || now_ms.saturating_sub(self.samples[2].0) > FLOOR_WINDOW_MS {
            self.samples = [sample; 3];
            self.measured = true;
            return;
        }
        if rtt_ms <= self.samples[1].1 {
            self.samples[1] = sample;
            self.samples[2] = sample;
        } else if rtt_ms <= self.samples[2].1 {
            self.samples[2] = sample;
        }
        let age = now_ms.saturating_sub(self.samples[0].0);
        if age > FLOOR_WINDOW_MS {
            self.samples = [self.samples[1], self.samples[2], sample];
            if now_ms.saturating_sub(self.samples[0].0) > FLOOR_WINDOW_MS {
                self.samples = [self.samples[1], self.samples[2], sample];
            }
        } else if self.samples[1].0 == self.samples[0].0 && age > FLOOR_WINDOW_MS / 4 {
            self.samples[1] = sample;
            self.samples[2] = sample;
        } else if self.samples[2].0 == self.samples[1].0 && age > FLOOR_WINDOW_MS / 2 {
            self.samples[2] = sample;
        }
    }

    /// Drop what left the window by `now_ms` without adding a sample, so floors compared at
    /// one instant cover the same window. A provider silent for a whole window keeps its newest
    /// sample; liveness, not the floor, retires it.
    fn expire(&mut self, now_ms: u64) {
        for _ in 0..2 {
            if !self.measured || now_ms.saturating_sub(self.samples[0].0) <= FLOOR_WINDOW_MS {
                return;
            }
            self.samples = [self.samples[1], self.samples[2], self.samples[2]];
        }
    }

    fn value(&self) -> Option<u64> { self.measured.then_some(self.samples[0].1) }
}

#[derive(Clone, Copy, Default)]
struct Provider { order: Option<u64>, rtt_ms: Option<f64>, floor: Floor }

#[derive(Default)]
pub(super) struct Selection { providers: [Provider; 2], next_order: u64 }

impl Selection {
    fn index(path: PathKind) -> usize { usize::from(path == PathKind::Direct) }

    pub fn register(&mut self, path: PathKind) {
        let provider = &mut self.providers[Self::index(path)];
        if provider.order.is_none() {
            provider.order = Some(self.next_order);
            self.next_order += 1;
        }
    }

    pub fn retire(&mut self, path: PathKind) { self.providers[Self::index(path)] = Provider::default(); }

    /// The network under every provider changed: no floor measured on the old one stands.
    pub fn restart_floors(&mut self) {
        for provider in &mut self.providers {
            provider.floor = Floor::default();
        }
    }

    /// One datagram pong's round trip, in the whole milliseconds the host clock gives.
    pub fn observe(&mut self, path: PathKind, now_ms: u64, rtt_ms: u64) {
        let provider = &mut self.providers[Self::index(path)];
        if provider.order.is_none() { return; }
        let raw_ms = rtt_ms as f64;
        provider.rtt_ms = Some(provider.rtt_ms.map_or(raw_ms, |prior| prior * (1.0 - RTT_EWMA_ALPHA) + raw_ms * RTT_EWMA_ALPHA));
        provider.floor.observe(now_ms, rtt_ms);
        // A paired round's pongs land apart: the one still in flight must not be judged on
        // a minimum its partner's window already dropped.
        for provider in &mut self.providers {
            provider.floor.expire(now_ms);
        }
    }

    /// The smoothed round trip the readout shows.
    pub fn rtt_ms(&self, path: PathKind) -> Option<f64> { self.providers[Self::index(path)].rtt_ms }

    /// The provider's propagation floor, while it is registered and measured.
    pub fn floor_ms(&self, path: PathKind) -> Option<u64> {
        let provider = self.providers[Self::index(path)];
        provider.order.and(provider.floor.value())
    }

    /// The lower floor carries the session; an exact tie goes to direct, a measured provider
    /// outranks an unmeasured one, and with neither measured the first registered leads.
    pub fn primary(&self) -> Option<PathKind> {
        let [relay, direct] = self.providers;
        match (relay.order, direct.order) {
            (None, None) => None,
            (Some(_), None) => Some(PathKind::Relay),
            (None, Some(_)) => Some(PathKind::Direct),
            (Some(relay_order), Some(direct_order)) => Some(match (relay.floor.value(), direct.floor.value()) {
                (Some(relay_ms), Some(direct_ms)) if relay_ms < direct_ms => PathKind::Relay,
                (Some(_), Some(_)) => PathKind::Direct,
                (Some(_), None) => PathKind::Relay,
                (None, Some(_)) => PathKind::Direct,
                (None, None) if relay_order < direct_order => PathKind::Relay,
                (None, None) => PathKind::Direct,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEARTBEAT: u64 = super::super::HEARTBEAT_INTERVAL_MS;

    fn both() -> Selection {
        let mut selection = Selection::default();
        selection.register(PathKind::Relay);
        selection.register(PathKind::Direct);
        selection
    }

    /// One paired probe round: both providers answer the same token.
    fn round(selection: &mut Selection, now_ms: u64, relay: u64, direct: u64) {
        selection.observe(PathKind::Relay, now_ms, relay);
        selection.observe(PathKind::Direct, now_ms, direct);
    }

    #[test]
    fn the_lower_floor_wins_and_an_exact_tie_goes_to_direct() {
        let mut selection = both();
        round(&mut selection, 0, 180, 195);
        assert_eq!(selection.primary(), Some(PathKind::Relay));
        let mut selection = both();
        round(&mut selection, 0, 40, 4);
        assert_eq!(selection.primary(), Some(PathKind::Direct));
        let mut selection = both();
        round(&mut selection, 0, 30, 30);
        assert_eq!(selection.primary(), Some(PathKind::Direct));
    }

    /// The roaming-LTE samples measured on 2026-10-18: a sleeping radio's wake spikes either
    /// path for a round, and the averages crossed at random. The floor never moves for them.
    #[test]
    fn wake_spikes_never_move_the_choice() {
        let mut selection = both();
        let samples = [
            (175, 740), (672, 768), (172, 537), (632, 179),
            (710, 476), (275, 1_448), (454, 205), (403, 201),
        ];
        let mut now_ms = 0;
        for (relay, direct) in samples {
            round(&mut selection, now_ms, relay, direct);
            now_ms += HEARTBEAT;
            assert_eq!(selection.primary(), Some(PathKind::Relay));
        }
        assert_eq!(selection.floor_ms(PathKind::Relay), Some(172));
        assert_eq!(selection.floor_ms(PathKind::Direct), Some(179));
    }

    #[test]
    fn a_route_that_really_slowed_rises_once_its_minimum_leaves_the_window() {
        let mut selection = both();
        round(&mut selection, 0, 40, 10);
        assert_eq!(selection.primary(), Some(PathKind::Direct));
        // The direct route slows for good; until its fast round leaves the window it stands.
        let mut now_ms = HEARTBEAT;
        while now_ms <= FLOOR_WINDOW_MS {
            round(&mut selection, now_ms, 40, 90);
            assert_eq!(selection.primary(), Some(PathKind::Direct), "at {now_ms}");
            now_ms += HEARTBEAT;
        }
        round(&mut selection, now_ms, 40, 90);
        assert_eq!(selection.floor_ms(PathKind::Direct), Some(90));
        assert_eq!(selection.primary(), Some(PathKind::Relay));
    }

    /// Measured 2026-10-18: the relay's pong landed 20 ms before direct's, its window dropped
    /// an old minimum, and direct, still holding one its own window had dropped, won for those
    /// 20 ms. Both floors now cover the same window whenever either moves.
    #[test]
    fn the_first_pong_of_a_round_never_wins_on_its_partners_expired_minimum() {
        let mut selection = both();
        round(&mut selection, 0, 170, 190);
        let mut now_ms = HEARTBEAT;
        while now_ms <= FLOOR_WINDOW_MS {
            round(&mut selection, now_ms, 200, 215);
            now_ms += HEARTBEAT;
        }
        assert_eq!(selection.primary(), Some(PathKind::Relay));
        selection.observe(PathKind::Relay, now_ms, 197);
        assert_eq!(selection.floor_ms(PathKind::Relay), Some(197));
        assert_eq!(selection.floor_ms(PathKind::Direct), Some(215));
        assert_eq!(selection.primary(), Some(PathKind::Relay));
        selection.observe(PathKind::Direct, now_ms + 20, 216);
        assert_eq!(selection.primary(), Some(PathKind::Relay));
    }

    #[test]
    fn a_measured_provider_outranks_an_unmeasured_one_and_registration_breaks_the_rest() {
        let mut selection = both();
        assert_eq!(selection.primary(), Some(PathKind::Relay));
        selection.observe(PathKind::Direct, 0, 900);
        assert_eq!(selection.primary(), Some(PathKind::Direct));
        selection.retire(PathKind::Direct);
        selection.register(PathKind::Direct);
        assert_eq!(selection.floor_ms(PathKind::Direct), None);
        assert_eq!(selection.primary(), Some(PathKind::Relay));
    }

    #[test]
    fn a_network_change_restarts_every_floor() {
        let mut selection = both();
        round(&mut selection, 0, 40, 5);
        selection.restart_floors();
        assert_eq!(selection.floor_ms(PathKind::Relay), None);
        assert_eq!(selection.floor_ms(PathKind::Direct), None);
        round(&mut selection, 1, 180, 195);
        assert_eq!(selection.primary(), Some(PathKind::Relay));
    }

    #[test]
    fn the_readout_keeps_its_smoothing_apart_from_the_floor() {
        let mut selection = both();
        selection.observe(PathKind::Relay, 0, 20);
        selection.observe(PathKind::Relay, 1, 120);
        assert_eq!(selection.rtt_ms(PathKind::Relay), Some(50.0));
        assert_eq!(selection.floor_ms(PathKind::Relay), Some(20));
    }
}
