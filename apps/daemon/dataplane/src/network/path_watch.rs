//! OS-level network path change detection.
//!
//! The daemon used to learn that its network moved only by waiting out a
//! heartbeat deadline. This watches the OS instead — `SCDynamicStore` on Apple,
//! rtnetlink on Linux — and publishes a single coalesced edge per transition.
//!
//! The policy is deliberately separated from the OS stream so it can be tested
//! against a scripted stream rather than real interface churn.

use std::io;
use std::time::Duration;

use futures::{Stream, StreamExt};
use if_watch::IfEvent;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{error, info, warn};

use crate::webtransport::{AddressClass, classify_interface_net};

/// A Wi-Fi association settles DHCPv4 plus RA/SLAAC within a few hundred ms, so
/// waiting this long after the last event usually yields one edge per move.
pub const DEBOUNCE_QUIET_MS: u64 = 750;
/// Never delay an edge longer than this, however long churn continues. Without
/// it a permanently flapping interface would starve the consumer entirely.
pub const DEBOUNCE_MAX_MS: u64 = 3_000;
/// Hard ceiling independent of debounce restarts. This is what bounds NAT-probe
/// cost, since each published edge can trigger a full STUN/UPnP/PCP cycle.
pub const MIN_PUBLISH_INTERVAL_MS: u64 = 5_000;
/// `IfWatcher::new()` resynchronises and queues one `Up` per existing address.
/// That burst describes the status quo, not a change, so it is discarded.
pub const INITIAL_SNAPSHOT_QUIET_MS: u64 = 250;

/// One coalesced network path transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkPathEdge {
    /// How many OS events collapsed into this edge. Diagnostic only.
    pub coalesced_events: u32,
}

/// Trailing debounce with a maximum delay and a hard rate ceiling.
///
/// Trailing alone would starve under continuous churn; a plain rate limit would
/// publish a mid-transition address set. Both bounds are needed.
#[derive(Debug)]
pub struct NetworkPathDebouncer {
    first_at: Option<Instant>,
    last_at: Option<Instant>,
    last_publish_at: Option<Instant>,
    pending: u32,
}

impl NetworkPathDebouncer {
    pub fn new() -> Self {
        Self {
            first_at: None,
            last_at: None,
            last_publish_at: None,
            pending: 0,
        }
    }

    pub fn observe(&mut self, now: Instant) {
        if self.first_at.is_none() {
            self.first_at = Some(now);
        }
        self.last_at = Some(now);
        self.pending = self.pending.saturating_add(1);
    }

    /// Earliest instant a publication could become due, or `None` when idle.
    pub fn next_deadline(&self) -> Option<Instant> {
        let first_at = self.first_at?;
        let last_at = self.last_at?;
        let quiet = last_at + Duration::from_millis(DEBOUNCE_QUIET_MS);
        let capped = first_at + Duration::from_millis(DEBOUNCE_MAX_MS);
        let due = quiet.min(capped);
        Some(match self.last_publish_at {
            Some(published) => due.max(published + Duration::from_millis(MIN_PUBLISH_INTERVAL_MS)),
            None => due,
        })
    }

    /// Returns an edge when one is due at `now`, clearing the pending state.
    pub fn take_due(&mut self, now: Instant) -> Option<NetworkPathEdge> {
        let deadline = self.next_deadline()?;
        if now < deadline {
            return None;
        }
        let edge = NetworkPathEdge {
            coalesced_events: self.pending.max(1),
        };
        self.first_at = None;
        self.last_at = None;
        self.pending = 0;
        self.last_publish_at = Some(now);
        Some(edge)
    }
}

impl Default for NetworkPathDebouncer {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether an address change could alter the candidate set we publish.
///
/// Uses the same predicate as `collect_local_candidates`, so link-local and
/// self-assigned churn — which that collector already filters out — cannot
/// produce an edge here. On macOS this alone removes most Wi-Fi transition
/// noise.
fn is_routable_change(event: &IfEvent) -> bool {
    let net = match event {
        IfEvent::Up(net) | IfEvent::Down(net) => net,
    };
    !matches!(
        classify_interface_net(net),
        AddressClass::Loopback | AddressClass::NonRoutable
    )
}

/// Drives a network-path stream into coalesced edges.
///
/// Generic over the stream so tests can supply a scripted one. Exits when the
/// stream ends or errors; the caller treats that as "no watcher", never as a
/// reason to poll.
pub async fn run_network_path_watcher<S>(events: S, tx: mpsc::Sender<NetworkPathEdge>)
where
    S: Stream<Item = io::Result<IfEvent>> + Unpin,
{
    let mut events = events;

    // Consume the constructor's snapshot burst before arming the debouncer.
    loop {
        match tokio::time::timeout(
            Duration::from_millis(INITIAL_SNAPSHOT_QUIET_MS),
            events.next(),
        )
        .await
        {
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(error))) => {
                error!(
                    ?error,
                    "network path watcher failed during initial snapshot"
                );
                return;
            }
            Ok(None) => return,
            Err(_) => break,
        }
    }

    let mut debouncer = NetworkPathDebouncer::new();
    loop {
        let next_deadline = debouncer.next_deadline();
        let event = match next_deadline {
            Some(deadline) => {
                tokio::select! {
                    biased;
                    () = tokio::time::sleep_until(deadline) => {
                        if let Some(edge) = debouncer.take_due(Instant::now()) {
                            // Capacity-1 channel: a full one already carries an
                            // unread edge, and "the path changed recently" is
                            // idempotent, so dropping is correct and never blocks.
                            let _ = tx.try_send(edge);
                        }
                        continue;
                    }
                    event = events.next() => event,
                }
            }
            None => events.next().await,
        };

        match event {
            Some(Ok(event)) => {
                if is_routable_change(&event) {
                    debouncer.observe(Instant::now());
                }
            }
            Some(Err(error)) => {
                error!(?error, "network path watcher failed");
                return;
            }
            None => return,
        }
    }
}

/// Spawns the OS watcher, or `None` when this platform cannot provide one.
///
/// A missing watcher is not an error path with a fallback: the daemon simply
/// keeps the timeout-driven behaviour it had before. Polling here would defeat
/// the purpose of moving to OS notifications. A network simulator host has no
/// OS network to watch (`crate::sim`).
pub fn spawn_network_path_watcher(
    tx: mpsc::Sender<NetworkPathEdge>,
) -> Option<tokio::task::JoinHandle<()>> {
    if cfg!(merkur_sim) {
        return None;
    }
    match if_watch::tokio::IfWatcher::new() {
        Ok(watcher) => {
            info!("network path watcher started");
            Some(tokio::spawn(run_network_path_watcher(watcher, tx)))
        }
        Err(error) => {
            warn!(
                ?error,
                "network path watcher unavailable; falling back to heartbeat-driven detection"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use if_watch::{IpNet, Ipv4Net, Ipv6Net};
    use tokio_stream::wrappers::ReceiverStream;

    use super::*;

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpNet {
        IpNet::V4(Ipv4Net::new(Ipv4Addr::new(a, b, c, d), 24).expect("valid v4 net"))
    }

    fn link_local_v6() -> IpNet {
        IpNet::V6(
            Ipv6Net::new(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1), 64).expect("valid v6 net"),
        )
    }

    /// Delivers `events` the way a real notifier would: after the constructor's
    /// snapshot window has gone quiet. A stream that yields everything up front
    /// would be entirely consumed by the snapshot drain, which is exactly what
    /// that drain is for.
    async fn drive(events: Vec<io::Result<IfEvent>>) -> Vec<NetworkPathEdge> {
        let (edge_tx, mut edge_rx) = mpsc::channel(1);
        let (event_tx, event_rx) = mpsc::channel(64);
        let task = tokio::spawn(run_network_path_watcher(
            ReceiverStream::new(event_rx),
            edge_tx,
        ));

        tokio::time::sleep(Duration::from_millis(INITIAL_SNAPSHOT_QUIET_MS * 2)).await;
        for event in events {
            event_tx.send(event).await.expect("watcher is running");
        }
        // Past both debounce bounds, so anything that will publish has.
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MAX_MS + DEBOUNCE_QUIET_MS)).await;

        let mut edges = Vec::new();
        while let Ok(edge) = edge_rx.try_recv() {
            edges.push(edge);
        }
        task.abort();
        edges
    }

    #[tokio::test(start_paused = true)]
    async fn loopback_and_link_local_churn_publishes_nothing() {
        let edges = drive(vec![
            Ok(IfEvent::Up(link_local_v6())),
            Ok(IfEvent::Up(v4(127, 0, 0, 1))),
            Ok(IfEvent::Up(v4(169, 254, 1, 2))),
            Ok(IfEvent::Down(link_local_v6())),
        ])
        .await;
        assert!(
            edges.is_empty(),
            "unroutable churn cannot change the published candidate set"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_routable_burst_collapses_into_one_edge() {
        let mut events = vec![Ok(IfEvent::Up(v4(192, 168, 1, 10)))];
        for octet in 11..=16 {
            events.push(Ok(IfEvent::Up(v4(192, 168, 1, octet))));
        }
        let edges = drive(events).await;
        assert_eq!(edges.len(), 1, "a single move must not fan out");
        assert!(edges[0].coalesced_events >= 1);
    }

    /// The same prefix rule as the candidate collector: a subnet ID never
    /// changes the published set, a `.0` host in a wider pool does.
    #[test]
    fn only_the_interface_prefix_decides_a_subnet_address() {
        let up = |net: &str| IfEvent::Up(net.parse().expect("valid net"));
        assert!(!is_routable_change(&up("192.168.97.0/24")));
        assert!(!is_routable_change(&up("192.168.97.255/24")));
        assert!(is_routable_change(&up("100.64.1.0/16")));
    }

    #[tokio::test(start_paused = true)]
    async fn a_notifier_error_stops_the_watcher_without_publishing() {
        let edges = drive(vec![Err(io::Error::other("notifier failed"))]).await;
        assert!(edges.is_empty());
    }

    #[test]
    fn the_debouncer_waits_for_quiet_but_not_past_the_max_delay() {
        let start = Instant::now();
        let mut debouncer = NetworkPathDebouncer::new();
        debouncer.observe(start);
        let quiet_deadline = debouncer.next_deadline().expect("armed");
        assert_eq!(
            quiet_deadline,
            start + Duration::from_millis(DEBOUNCE_QUIET_MS)
        );

        // Continuous churn keeps restarting the quiet window, so the max delay
        // is what stops it starving.
        let mut churning = NetworkPathDebouncer::new();
        churning.observe(start);
        for step in 1..=10 {
            churning.observe(start + Duration::from_millis(step * 500));
        }
        assert_eq!(
            churning.next_deadline().expect("armed"),
            start + Duration::from_millis(DEBOUNCE_MAX_MS)
        );
    }

    #[test]
    fn a_published_edge_holds_the_rate_ceiling() {
        let start = Instant::now();
        let mut debouncer = NetworkPathDebouncer::new();
        debouncer.observe(start);
        let first = debouncer
            .take_due(start + Duration::from_millis(DEBOUNCE_QUIET_MS))
            .expect("first edge is due");
        assert_eq!(first.coalesced_events, 1);

        // A second transition immediately afterwards cannot re-trigger the
        // expensive NAT/STUN cycle until the ceiling elapses.
        let published_at = start + Duration::from_millis(DEBOUNCE_QUIET_MS);
        debouncer.observe(published_at);
        assert!(debouncer.take_due(published_at).is_none());
        assert_eq!(
            debouncer.next_deadline().expect("armed"),
            published_at + Duration::from_millis(MIN_PUBLISH_INTERVAL_MS)
        );
    }
}
