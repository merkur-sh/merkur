//! Network path changes from the operating system, as recovery hints.
//!
//! A hint proves nothing about a carrier: the session adds a probe and races
//! one candidate on it, and only the daemon's answers decide. The watcher
//! drops the snapshot `IfWatcher` queues when it is created, ignores loopback
//! and link-local churn, and coalesces a burst into one hint once it has been
//! quiet, so a candidate is not dialled mid-transition on an interface that is
//! going away.
// Under the network simulator the operating-system watcher is not started.
#![cfg_attr(merkur_sim, allow(dead_code, unused_imports))]

use std::io;
use std::net::IpAddr;
use std::time::Duration;

use futures::{Stream, StreamExt};
use if_watch::IfEvent;
use tokio::sync::mpsc;
use tokio::time::Instant;

/// A burst of path events is one change once this long passes without
/// another; mirrored from the browser's `TRANSPORT_PROBE_DEDUPE_MS`.
const QUIET_MS: u64 = 250;
/// A flapping interface still yields a hint this soon after its first event.
const MAX_DELAY_MS: u64 = 1_000;
/// `IfWatcher::new()` queues one `Up` per existing address: the status quo.
const INITIAL_SNAPSHOT_QUIET_MS: u64 = 250;

/// Starts the watcher. Without one there are no hints, and recovery rests on
/// carrier evidence alone. A network simulator host has no operating-system
/// network to watch; its scenario announces path changes instead ([`sim`]).
pub fn spawn(hints: mpsc::Sender<()>) -> Option<tokio::task::JoinHandle<()>> {
    #[cfg(merkur_sim)]
    return Some(tokio::spawn(sim::forward(hints)));
    #[cfg(not(merkur_sim))]
    {
        let watcher = if_watch::tokio::IfWatcher::new().ok()?;
        Some(tokio::spawn(run(watcher, hints)))
    }
}

/// The path changes a network simulator scenario announces (`tools/sim`),
/// each one already settled, as a coalesced burst is.
#[cfg(merkur_sim)]
pub mod sim {
    use std::sync::LazyLock;

    use tokio::sync::{Notify, mpsc};

    static CHANGES: LazyLock<Notify> = LazyLock::new(Notify::new);

    /// Every running client hears one path change.
    pub fn network_changed() {
        CHANGES.notify_waiters();
    }

    pub(super) async fn forward(hints: mpsc::Sender<()>) {
        loop {
            CHANGES.notified().await;
            if hints.send(()).await.is_err() {
                return;
            }
        }
    }
}

async fn run<S>(mut events: S, hints: mpsc::Sender<()>)
where
    S: Stream<Item = io::Result<IfEvent>> + Unpin,
{
    loop {
        match tokio::time::timeout(
            Duration::from_millis(INITIAL_SNAPSHOT_QUIET_MS),
            events.next(),
        )
        .await
        {
            Ok(Some(Ok(_))) => continue,
            Ok(_) => return,
            Err(_) => break,
        }
    }
    // The first event of the burst being coalesced, and its last.
    let mut burst: Option<(Instant, Instant)> = None;
    loop {
        let due = burst.map(|(first, last)| {
            (last + Duration::from_millis(QUIET_MS))
                .min(first + Duration::from_millis(MAX_DELAY_MS))
        });
        let event = match due {
            Some(due) => tokio::select! {
                biased;
                () = tokio::time::sleep_until(due) => {
                    burst = None;
                    match hints.try_send(()) {
                        Ok(()) | Err(mpsc::error::TrySendError::Full(())) => {},
                        Err(mpsc::error::TrySendError::Closed(())) => return,
                    }
                    continue;
                }
                event = events.next() => event,
            },
            None => events.next().await,
        };
        match event {
            Some(Ok(event)) if routable(&event) => {
                let now = Instant::now();
                burst = Some(burst.map_or((now, now), |(first, _)| (first, now)));
            }
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return,
        }
    }
}

/// Whether the change could move this host's route to the edge.
fn routable(event: &IfEvent) -> bool {
    let (IfEvent::Up(net) | IfEvent::Down(net)) = event;
    match net.addr() {
        IpAddr::V4(address) => !address.is_loopback() && !address.is_link_local(),
        IpAddr::V6(address) => !address.is_loopback() && !address.is_unicast_link_local(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(address: &str) -> IfEvent {
        IfEvent::Up(address.parse().unwrap())
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_after_the_snapshot_is_one_hint_and_local_churn_none() {
        let (events, stream) = mpsc::unbounded_channel();
        let (hints, mut received) = mpsc::channel(1);
        events.send(Ok(up("192.168.1.10/24"))).unwrap();
        let task = tokio::spawn(run(tokio_stream_from(stream), hints));
        // The snapshot passes without a hint.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(received.try_recv().is_err());

        // Link-local and loopback churn is not a path change.
        events.send(Ok(up("fe80::1/64"))).unwrap();
        events.send(Ok(up("127.0.0.2/8"))).unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(received.try_recv().is_err());

        // A move: down, up, up within the quiet window is one hint.
        events
            .send(Ok(IfEvent::Down("192.168.1.10/24".parse().unwrap())))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        events.send(Ok(up("10.0.0.7/24"))).unwrap();
        events.send(Ok(up("2001:db8::7/64"))).unwrap();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(received.try_recv().is_ok());
        assert!(received.try_recv().is_err());
        drop(events);
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn unread_route_changes_keep_one_exact_pending_probe_signal() {
        let (events, stream) = mpsc::unbounded_channel();
        let (hints, mut received) = mpsc::channel(1);
        let task = tokio::spawn(run(tokio_stream_from(stream), hints));
        tokio::time::sleep(Duration::from_millis(600)).await;
        for subnet in 1..10 {
            events.send(Ok(up(&format!("10.0.{subnet}.7/24")))).unwrap();
            tokio::time::sleep(Duration::from_millis(600)).await;
            assert_eq!(received.len(), 1);
        }
        assert!(received.try_recv().is_ok());
        assert!(received.try_recv().is_err());
        drop(events);
        task.await.unwrap();
    }

    fn tokio_stream_from(
        mut receiver: mpsc::UnboundedReceiver<io::Result<IfEvent>>,
    ) -> impl Stream<Item = io::Result<IfEvent>> + Unpin {
        Box::pin(futures::stream::poll_fn(move |context| {
            receiver.poll_recv(context)
        }))
    }
}
