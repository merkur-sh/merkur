//! Network path changes from the operating system, as recovery hints.
//!
//! A hint proves nothing about a carrier: the session adds a probe and races
//! one candidate on it, and only the daemon's answers decide. The watcher
//! drops the snapshot `IfWatcher` queues when it is created, ignores loopback
//! and link-local churn, and coalesces a burst into one hint once it has been
//! quiet, so a candidate is not dialled mid-transition on an interface that is
//! going away. Route notifications are independent of address changes: a VPN
//! can replace the route while every interface retains its existing address.
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
        let watcher = if_watch::tokio::IfWatcher::new().ok();
        let routes = routes::open().ok();
        if watcher.is_none() && routes.is_none() {
            return None;
        }
        let address_hints = hints.clone();
        let route_hints = hints.clone();
        Some(tokio::spawn(supervise(
            async move {
                if let Some(watcher) = watcher {
                    run(watcher, address_hints).await;
                }
            },
            async move {
                if let Some(routes) = routes {
                    routes.run(route_hints).await;
                }
            },
            hints,
        )))
    }
}

/// Both sources live in this future, so cancellation closes both subscriptions
/// rather than leaving a detached reader holding a stale network generation.
async fn supervise(
    addresses: impl Future<Output = ()>,
    routes: impl Future<Output = ()>,
    hints: mpsc::Sender<()>,
) {
    tokio::select! {
        () = hints.closed() => {}
        _ = async { tokio::join!(addresses, routes); } => {}
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
    coalesce(
        events.map(|event| event.map(|event| routable(&event))),
        hints,
    )
    .await;
}

async fn coalesce<S>(mut events: S, hints: mpsc::Sender<()>)
where
    S: Stream<Item = io::Result<bool>> + Unpin,
{
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
            Some(Ok(true)) => {
                let now = Instant::now();
                burst = Some(burst.map_or((now, now), |(first, _)| (first, now)));
            }
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return,
        }
    }
}

#[cfg(all(not(merkur_sim), any(target_os = "macos", target_os = "linux")))]
mod routes {
    use std::os::fd::AsRawFd;

    #[cfg(target_os = "linux")]
    use socket2::Protocol;
    use socket2::{Domain, Socket, Type};
    use tokio::io::unix::AsyncFd;

    use super::*;

    pub(super) struct Routes(AsyncFd<Socket>);

    /// Subscribe without requesting a route dump, so the first packet is a
    /// change event rather than a snapshot that could mask a real transition.
    pub(super) fn open() -> io::Result<Routes> {
        #[cfg(target_os = "macos")]
        let socket = Socket::new(Domain::from(libc::PF_ROUTE), Type::RAW, None)?;
        #[cfg(target_os = "linux")]
        let socket = {
            let socket = Socket::new(
                Domain::from(libc::AF_NETLINK),
                Type::RAW,
                Some(Protocol::from(libc::NETLINK_ROUTE)),
            )?;
            // SAFETY: sockaddr_nl contains integer fields; zero initializes
            // its reserved padding and asks the kernel to allocate our port id.
            let mut address: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
            address.nl_family = libc::AF_NETLINK as libc::sa_family_t;
            address.nl_groups =
                (libc::RTMGRP_IPV4_ROUTE | libc::RTMGRP_IPV6_ROUTE | libc::RTMGRP_IPV4_RULE) as u32
                    | (1 << (libc::RTNLGRP_IPV6_RULE - 1));
            // SAFETY: address is a fully initialized sockaddr_nl, and its
            // pointer and exact length remain valid for this bind call.
            let result = unsafe {
                libc::bind(
                    socket.as_raw_fd(),
                    (&raw const address).cast(),
                    std::mem::size_of_val(&address) as libc::socklen_t,
                )
            };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            socket
        };
        socket.set_nonblocking(true)?;
        // SAFETY: Socket owns this open descriptor, cannot change its identity
        // through a shared reference, and remains owned by AsyncFd until drop.
        let socket =
            unsafe { AsyncFd::register_with_interest(socket, tokio::io::Interest::READABLE) }
                .map_err(io::Error::from)?;
        Ok(Routes(socket))
    }

    impl Routes {
        pub(super) async fn run(self, hints: mpsc::Sender<()>) {
            let events = futures::stream::unfold(self, |routes| async move {
                let result = routes.next().await;
                Some((result, routes))
            });
            coalesce(Box::pin(events), hints).await;
        }

        async fn next(&self) -> io::Result<bool> {
            // BSD routing messages carry a u16 length. Linux may batch
            // netlink messages; MSG_TRUNC reports a larger datagram as loss.
            let mut buffer = [0; 65_536];
            loop {
                let mut ready = self.0.readable().await?;
                let read = ready.try_io(|socket| receive(socket.get_ref(), &mut buffer));
                match read {
                    Ok(Ok(Received::Kernel(len))) => {
                        return Ok(changed(&buffer[..len]));
                    }
                    #[cfg(target_os = "linux")]
                    Ok(Ok(Received::Other)) => {}
                    #[cfg(target_os = "linux")]
                    Ok(Ok(Received::Lost)) => return Ok(true),
                    Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
                    Ok(Err(error)) if error.raw_os_error() == Some(libc::ENOBUFS) => {
                        // The kernel reports missed notifications. Re-resolve
                        // the route instead of assuming the old binding held.
                        return Ok(true);
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(_) => {}
                }
            }
        }
    }

    enum Received {
        Kernel(usize),
        #[cfg(target_os = "linux")]
        Other,
        #[cfg(target_os = "linux")]
        Lost,
    }

    fn receive(socket: &Socket, buffer: &mut [u8]) -> io::Result<Received> {
        #[cfg(target_os = "linux")]
        {
            // SAFETY: every sockaddr_nl field is an integer; zero is valid.
            let mut sender: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of_val(&sender) as libc::socklen_t;
            // SAFETY: buffer is writable for its stated length; sender and
            // size are initialized, valid output storage for recvfrom.
            let len = unsafe {
                libc::recvfrom(
                    socket.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    libc::MSG_TRUNC,
                    (&raw mut sender).cast(),
                    &raw mut size,
                )
            };
            if len < 0 {
                return Err(io::Error::last_os_error());
            }
            if sender.nl_pid != 0 || size as usize != std::mem::size_of_val(&sender) {
                return Ok(Received::Other);
            }
            let len = len as usize;
            Ok(if len > buffer.len() {
                Received::Lost
            } else {
                Received::Kernel(len)
            })
        }
        #[cfg(target_os = "macos")]
        {
            // SAFETY: buffer is initialized, writable storage for its exact
            // stated length, and this task owns the routing socket.
            let len = unsafe {
                libc::recv(
                    socket.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    0,
                )
            };
            if len < 0 {
                Err(io::Error::last_os_error())
            } else if len == 0 {
                Err(io::Error::from(io::ErrorKind::UnexpectedEof))
            } else {
                Ok(Received::Kernel(len.cast_unsigned()))
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn changed(packet: &[u8]) -> bool {
        let Some(header) = packet.get(..std::mem::size_of::<libc::rt_msghdr>()) else {
            return false;
        };
        let read_i32 = |offset: usize| {
            header
                .get(offset..offset + 4)
                .and_then(|bytes| bytes.try_into().ok())
                .map(i32::from_ne_bytes)
        };
        let length = u16::from_ne_bytes([header[0], header[1]]) as usize;
        if length != packet.len()
            || i32::from(header[2]) != libc::RTM_VERSION
            || !matches!(
                i32::from(header[3]),
                libc::RTM_ADD | libc::RTM_DELETE | libc::RTM_CHANGE | libc::RTM_REDIRECT
            )
            || read_i32(std::mem::offset_of!(libc::rt_msghdr, rtm_errno)) != Some(0)
        {
            return false;
        }
        let Some(flags) = read_i32(std::mem::offset_of!(libc::rt_msghdr, rtm_flags)) else {
            return false;
        };
        flags
            & (libc::RTF_LLINFO
                | libc::RTF_WASCLONED
                | libc::RTF_LOCAL
                | libc::RTF_BROADCAST
                | libc::RTF_MULTICAST)
            == 0
    }

    #[cfg(target_os = "linux")]
    fn changed(mut packet: &[u8]) -> bool {
        // nlmsghdr and rtmsg are fixed UAPI records, native byte order. A
        // datagram can contain several aligned messages; inspect each one.
        while let Some(header) = packet.get(..16) {
            let len = u32::from_ne_bytes([header[0], header[1], header[2], header[3]]) as usize;
            let kind = u16::from_ne_bytes([header[4], header[5]]);
            if kind == libc::NLMSG_OVERRUN as u16 {
                return true;
            }
            if len < 16 || len > packet.len() {
                return false;
            }
            if matches!(
                kind,
                libc::RTM_NEWROUTE | libc::RTM_DELROUTE | libc::RTM_NEWRULE | libc::RTM_DELRULE
            ) && let Some(route) = packet.get(16..len).and_then(|body| body.get(..12))
                && matches!(i32::from(route[0]), libc::AF_INET | libc::AF_INET6)
            {
                if matches!(kind, libc::RTM_NEWRULE | libc::RTM_DELRULE) {
                    return true;
                }
                let flags = u32::from_ne_bytes([route[8], route[9], route[10], route[11]]);
                if matches!(
                    route[7],
                    libc::RTN_UNICAST
                        | libc::RTN_BLACKHOLE
                        | libc::RTN_UNREACHABLE
                        | libc::RTN_PROHIBIT
                        | libc::RTN_THROW
                ) && flags & libc::RTM_F_CLONED == 0
                {
                    return true;
                }
            }
            let aligned = (len + 3) & !3;
            let Some(rest) = packet.get(aligned..) else {
                return false;
            };
            packet = rest;
        }
        false
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[cfg(target_os = "macos")]
        fn route(kind: i32, flags: i32) -> Vec<u8> {
            let mut packet = vec![0; std::mem::size_of::<libc::rt_msghdr>()];
            let len = u16::try_from(packet.len()).unwrap();
            packet[..2].copy_from_slice(&len.to_ne_bytes());
            packet[2] = u8::try_from(libc::RTM_VERSION).unwrap();
            packet[3] = u8::try_from(kind).unwrap();
            let offset = std::mem::offset_of!(libc::rt_msghdr, rtm_flags);
            packet[offset..offset + 4].copy_from_slice(&flags.to_ne_bytes());
            packet
        }

        #[cfg(target_os = "linux")]
        fn route(kind: u16, route_type: u8, flags: u32) -> Vec<u8> {
            let mut packet = vec![0; 28];
            packet[..4].copy_from_slice(&28u32.to_ne_bytes());
            packet[4..6].copy_from_slice(&kind.to_ne_bytes());
            packet[16] = libc::AF_INET as u8;
            packet[23] = route_type;
            packet[24..28].copy_from_slice(&flags.to_ne_bytes());
            packet
        }

        #[test]
        fn route_changes_are_distinct_from_queries_and_neighbor_cache_churn() {
            #[cfg(target_os = "macos")]
            {
                for kind in [libc::RTM_ADD, libc::RTM_DELETE, libc::RTM_CHANGE] {
                    assert!(changed(&route(kind, libc::RTF_GATEWAY)));
                }
                assert!(!changed(&route(libc::RTM_GET, libc::RTF_GATEWAY)));
                assert!(!changed(&route(
                    libc::RTM_ADD,
                    libc::RTF_LLINFO | libc::RTF_WASCLONED
                )));
                let mut failed = route(libc::RTM_CHANGE, libc::RTF_GATEWAY);
                let offset = std::mem::offset_of!(libc::rt_msghdr, rtm_errno);
                failed[offset..offset + 4].copy_from_slice(&libc::ESRCH.to_ne_bytes());
                assert!(!changed(&failed));
            }
            #[cfg(target_os = "linux")]
            {
                assert!(changed(&route(libc::RTM_NEWROUTE, libc::RTN_UNICAST, 0)));
                assert!(changed(&route(libc::RTM_DELROUTE, libc::RTN_BLACKHOLE, 0)));
                assert!(changed(&route(libc::RTM_NEWRULE, libc::RTN_UNSPEC, 0)));
                assert!(!changed(&route(libc::RTM_GETROUTE, libc::RTN_UNICAST, 0)));
                assert!(!changed(&route(
                    libc::RTM_NEWROUTE,
                    libc::RTN_UNICAST,
                    libc::RTM_F_CLONED
                )));
                assert!(!changed(&route(libc::RTM_NEWROUTE, libc::RTN_LOCAL, 0)));
                let mut batch = route(libc::RTM_GETROUTE, libc::RTN_UNICAST, 0);
                batch.extend(route(libc::RTM_NEWROUTE, libc::RTN_UNICAST, 0));
                assert!(changed(&batch));
            }
            assert!(!changed(&[]));
            assert!(!changed(&[0; 4]));
        }
    }
}

#[cfg(all(not(merkur_sim), not(any(target_os = "macos", target_os = "linux"))))]
mod routes {
    use super::*;

    pub(super) struct Routes;

    pub(super) fn open() -> io::Result<Routes> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    impl Routes {
        pub(super) fn run(self, _hints: mpsc::Sender<()>) -> impl Future<Output = ()> {
            std::future::ready(())
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

    #[tokio::test]
    async fn aborting_the_owner_drops_both_notification_sources() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        struct Source(Arc<AtomicUsize>);
        impl Drop for Source {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let source = |owner: Source| async move {
            std::future::pending::<()>().await;
            drop(owner);
        };
        let (hints, _received) = mpsc::channel(1);
        let task = tokio::spawn(supervise(
            source(Source(dropped.clone())),
            source(Source(dropped.clone())),
            hints,
        ));
        tokio::task::yield_now().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn route_changes_need_no_address_snapshot_before_they_are_observed() {
        let (events, mut received_events) = mpsc::unbounded_channel();
        let stream = Box::pin(futures::stream::poll_fn(move |context| {
            received_events.poll_recv(context)
        }));
        let (hints, mut received) = mpsc::channel(1);
        let task = tokio::spawn(coalesce(stream, hints));
        events.send(Ok(true)).unwrap();
        tokio::time::sleep(Duration::from_millis(QUIET_MS + 1)).await;
        assert!(received.try_recv().is_ok());
        assert!(received.try_recv().is_err());
        drop(events);
        task.await.unwrap();
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
