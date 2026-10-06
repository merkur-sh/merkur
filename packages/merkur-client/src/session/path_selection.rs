//! Authenticated provider ranking: the browser mux's measured RTT policy.
use crate::liveness::PathKind;

pub(super) const DIRECT_PREFERENCE_GRACE_MS: f64 = 12.0;
const RTT_EWMA_ALPHA: f64 = 0.3;

#[derive(Clone, Copy, Default)]
struct Provider { order: Option<u64>, rtt_ms: Option<f64> }

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

    pub fn observe(&mut self, path: PathKind, raw_ms: f64) {
        let provider = &mut self.providers[Self::index(path)];
        if provider.order.is_none() || !raw_ms.is_finite() || raw_ms < 0.0 { return; }
        provider.rtt_ms = Some(provider.rtt_ms.map_or(raw_ms, |prior| prior * (1.0 - RTT_EWMA_ALPHA) + raw_ms * RTT_EWMA_ALPHA));
    }

    pub fn rtt_ms(&self, path: PathKind) -> Option<f64> { self.providers[Self::index(path)].rtt_ms }

    pub fn primary(&self) -> Option<PathKind> {
        let [relay, direct] = self.providers;
        match (relay.order, direct.order) {
            (None, None) => None,
            (Some(_), None) => Some(PathKind::Relay),
            (None, Some(_)) => Some(PathKind::Direct),
            (Some(relay_order), Some(direct_order)) => Some(match (relay.rtt_ms, direct.rtt_ms) {
                (Some(relay_ms), Some(direct_ms)) if relay_ms + DIRECT_PREFERENCE_GRACE_MS < direct_ms => PathKind::Relay,
                (Some(relay_ms), Some(direct_ms)) if relay_ms + DIRECT_PREFERENCE_GRACE_MS > direct_ms => PathKind::Direct,
                (Some(_), None) => PathKind::Relay,
                (None, Some(_)) => PathKind::Direct,
                _ if relay_order < direct_order => PathKind::Relay,
                _ => PathKind::Direct,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn measured(relay: f64, direct: f64) -> Selection {
        let mut selection = Selection::default();
        selection.register(PathKind::Relay);
        selection.register(PathKind::Direct);
        selection.observe(PathKind::Relay, relay);
        selection.observe(PathKind::Direct, direct);
        selection
    }
    #[test]
    fn a_direct_path_wins_within_the_bias_but_a_clearly_faster_relay_wins() {
        assert_eq!(measured(10.0, 21.0).primary(), Some(PathKind::Direct));
        assert_eq!(measured(10.0, 23.0).primary(), Some(PathKind::Relay));
        assert_eq!(measured(10.0, 22.0).primary(), Some(PathKind::Relay));
    }
    #[test]
    fn measurement_then_registration_order_rank_exact_ties_without_a_ttl() {
        let mut selection = Selection::default();
        selection.register(PathKind::Relay);
        selection.register(PathKind::Direct);
        assert_eq!(selection.primary(), Some(PathKind::Relay));
        selection.observe(PathKind::Direct, 20.0);
        assert_eq!(selection.primary(), Some(PathKind::Direct));
        selection.observe(PathKind::Relay, 5.0);
        assert_eq!(selection.primary(), Some(PathKind::Relay));
        selection.observe(PathKind::Relay, 105.0);
        // The exact 0.3 EWMA is 35ms; relay's biased 47ms loses to direct20.
        assert_eq!(selection.providers[0].rtt_ms, Some(35.0));
        assert_eq!(selection.primary(), Some(PathKind::Direct));
        selection.retire(PathKind::Direct);
        selection.register(PathKind::Direct);
        assert_eq!(selection.providers[1].rtt_ms, None);
        assert_eq!(selection.primary(), Some(PathKind::Relay));
    }
}
