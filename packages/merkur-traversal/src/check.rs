//! Authenticated checks on Quinn's socket, outside terminal scheduling.

use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::{StreamExt, stream::FuturesUnordered};
use merkur_stun_protocol::message::{self, ResponseWriter};
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use tokio::sync::{Notify, Semaphore, mpsc};
use tokio::time::{Instant, timeout_at};

use crate::discovery_socket::{DiscoverySocket, ResponseSource};
use crate::transaction;

/// Resource bounds: 64 live peers, eight outstanding checks per peer.
const MAX_CONTEXTS: usize = 64 * 10;
const MAX_INCOMING: usize = 16;
pub const MAX_CHECKS_PER_PEER: usize = 8;
/// Two ten-candidate sets and one learned endpoint per pair bound cold state.
const MAX_PAIRS: usize = 2 * 10 * 10;

pub(crate) struct Context {
    socket: std::sync::Weak<DiscoverySocket>,
    username: [u8; 34],
    incoming: mpsc::Sender<Incoming>,
    incoming_key: Arc<hmac::Key>,
    revoked: AtomicBool,
    send_gate: Mutex<()>,
    revoked_notify: Notify,
    checking: AtomicBool,
    incoming_count: AtomicUsize,
}

impl Context {
    pub(crate) fn live(&self) -> bool {
        !self.revoked.load(Ordering::Acquire)
    }

    pub(crate) fn try_send(&self, send: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
        let _guard = self
            .send_gate
            .lock()
            .map_err(|error| io::Error::other(format!("check send authority: {error}")))?;
        if !self.live() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "check authority retired",
            ));
        }
        send()
    }

    async fn cancelled(&self) {
        let notified = self.revoked_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.live() {
            notified.await;
        }
    }
}

/// The owner revokes before aborting an async executor. Receive authority and
/// outstanding sends therefore do not depend on when the reactor drops it.
#[derive(Clone)]
pub struct Authority(Arc<Context>);

impl Authority {
    pub fn is_live(&self) -> bool {
        self.0.live()
    }

    /// Exact outstanding check/answer work, including authenticated packets
    /// already queued by the socket but not yet consumed by the executor.
    pub fn is_checking(&self) -> bool {
        self.0.live()
            && (self.0.checking.load(Ordering::Acquire)
                || self.0.incoming_count.load(Ordering::Acquire) != 0)
    }

    pub fn revoke(&self) {
        let barrier = self.0.send_gate.lock();
        self.0.revoked.store(true, Ordering::Release);
        drop(barrier);
        if let Some(socket) = self.0.socket.upgrade() {
            socket.revoke_checks(&self.0);
        }
        self.0.revoked_notify.notify_waiters();
    }
}

pub struct Incoming {
    pub source: SocketAddr,
    local_ip: Option<std::net::IpAddr>,
    transaction: [u8; 12],
    request_len: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Checking,
    Verified(SocketAddr),
    /// The current outbound transactions all completed. This is not a verdict
    /// about the network; the authenticated responder remains installed.
    Exhausted,
}

/// Dropping this owner removes its receive authority; the socket stores Weak.
pub struct Binding {
    socket: Arc<DiscoverySocket>,
    context: Arc<Context>,
    outgoing_username: [u8; 34],
    outgoing_key: Arc<hmac::Key>,
    incoming: mpsc::Receiver<Incoming>,
    slots: Arc<Semaphore>,
}

fn username(id: &[u8; 16], client: bool) -> [u8; 34] {
    let mut out = [0; 34];
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for (pair, byte) in out[..32].as_chunks_mut::<2>().0.iter_mut().zip(id) {
        pair[0] = HEX[usize::from(byte >> 4)];
        pair[1] = HEX[usize::from(byte & 15)];
    }
    out[32] = b':';
    out[33] = if client { b'c' } else { b'd' };
    out
}

pub(crate) fn receive(
    socket: &DiscoverySocket,
    packet: &[u8],
    source: SocketAddr,
    local_ip: Option<std::net::IpAddr>,
) {
    let Ok(request) = message::parse_binding_request(packet) else {
        return;
    };
    if request.change_request.is_some() || request.request_receipt {
        return;
    }
    let Ok(contexts) = socket.checks.lock() else {
        return;
    };
    let Some(context) = contexts
        .iter()
        .filter_map(std::sync::Weak::upgrade)
        .find(|context| context.live() && context.username == request.username)
    else {
        return;
    };
    drop(contexts);
    if request.verify_integrity(packet, &context.incoming_key) && context.live() {
        context.incoming_count.fetch_add(1, Ordering::AcqRel);
        if context
            .incoming
            .try_send(Incoming {
                source,
                local_ip,
                transaction: *request.transaction_id,
                request_len: packet.len(),
            })
            .is_err()
        {
            context.incoming_count.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

impl Binding {
    pub fn install(
        socket: Arc<DiscoverySocket>,
        id: [u8; 16],
        client_key: &[u8; 32],
        daemon_key: &[u8; 32],
        client: bool,
        quota: Arc<Semaphore>,
    ) -> io::Result<Self> {
        let (incoming, receiver) = mpsc::channel(MAX_INCOMING);
        let (outgoing_key, incoming_key) = if client {
            (client_key, daemon_key)
        } else {
            (daemon_key, client_key)
        };
        let context = Arc::new(Context {
            socket: Arc::downgrade(&socket),
            username: username(&id, !client),
            incoming,
            incoming_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, incoming_key)),
            revoked: AtomicBool::new(false),
            send_gate: Mutex::new(()),
            revoked_notify: Notify::new(),
            checking: AtomicBool::new(false),
            incoming_count: AtomicUsize::new(0),
        });
        {
            let mut contexts = socket
                .checks
                .lock()
                .map_err(|error| io::Error::other(format!("check registry: {error}")))?;
            contexts.retain(|entry| entry.upgrade().is_some_and(|context| context.live()));
            if contexts.len() >= MAX_CONTEXTS
                || contexts
                    .iter()
                    .filter_map(std::sync::Weak::upgrade)
                    .any(|entry| entry.username == context.username)
            {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "check context capacity or duplicate",
                ));
            }
            contexts.push(Arc::downgrade(&context));
        }
        Ok(Self {
            socket,
            context,
            outgoing_username: username(&id, client),
            outgoing_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, outgoing_key)),
            incoming: receiver,
            slots: quota,
        })
    }

    pub async fn answer(&self, request: &Incoming) -> io::Result<()> {
        if !self.context.live() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "check authority retired",
            ));
        }
        let mut response = ResponseWriter::new(&request.transaction);
        if !response.push_address(
            message::ATTR_XOR_MAPPED_ADDRESS,
            request.source,
            &request.transaction,
            true,
        ) || !response.finish_in_place(&self.context.incoming_key)
            || response.as_bytes().len() > request.request_len
        {
            return Err(io::Error::other("check response encoding"));
        }
        tokio::select! {
            biased;
            () = self.context.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "check authority retired")),
            result = self.socket.send_checked(request.source, response.as_bytes(), request.local_ip, &self.context) => result,
        }
    }

    pub fn authority(&self) -> Authority {
        Authority(self.context.clone())
    }

    async fn publish(&self, events: &mpsc::Sender<Event>, event: Event) -> bool {
        tokio::select! {
            biased;
            () = self.context.cancelled() => false,
            result = events.send(event) => result.is_ok(),
        }
    }

    fn check(
        &self,
        target: SocketAddr,
        allows: Arc<dyn Fn(SocketAddr) -> bool + Send + Sync>,
    ) -> impl std::future::Future<Output = Option<SocketAddr>> + Send + 'static {
        let (socket, key, slots, username) = (
            self.socket.clone(),
            self.outgoing_key.clone(),
            self.slots.clone(),
            self.outgoing_username,
        );
        let context = self.context.clone();
        async move {
            tokio::select! {
                biased;
                () = context.cancelled() => None,
                result = async {
            let _permit = slots.acquire().await.ok()?;
            let mut transaction = [0; 12];
            SystemRandom::new().fill(&mut transaction).ok()?;
            let deadline = Instant::now() + transaction::BUDGET;
            let (_registration, mut response) = socket
                .register_peer(
                    transaction,
                    ResponseSource::Exact(target),
                    key.clone(),
                    deadline,
                    Arc::downgrade(&context),
                )
                .ok()?;
            let request = message::binding_request(&transaction, &username, 0, &key)?;
            for attempt in 0..transaction::SENDS {
                if !allows(target) { return None; }
                timeout_at(deadline, socket.send_checked(target, request.as_bytes(), None, &context)).await.ok()?.ok()?;
                match timeout_at((Instant::now() + transaction::wait(attempt)).min(deadline), &mut response).await
                {
                    Ok(Ok(response)) => {
                        message::parse_success(&response.bytes[..response.len], &transaction)?;
                        return Some(target);
                    }
                    Ok(Err(_)) => return None,
                    Err(_) => {}
                }
            }
            None
                } => result,
            }
        }
    }

    /// Checks each named endpoint once, with bounded retransmissions. Verified
    /// requests may add exact peer-reflexive endpoints, never a port search.
    pub async fn run(
        mut self,
        initial: Vec<SocketAddr>,
        allows: impl Fn(SocketAddr) -> bool + Send + Sync + 'static,
        responds: impl Fn(SocketAddr) -> bool + Send + Sync + 'static,
        verified: mpsc::Sender<Event>,
    ) {
        let allows: Arc<dyn Fn(SocketAddr) -> bool + Send + Sync> = Arc::new(allows);
        let mut seen = Vec::new();
        let mut pending = FuturesUnordered::new();
        for target in initial.into_iter().take(MAX_PAIRS) {
            if allows(target) && !seen.contains(&target) {
                seen.push(target);
                pending.push(self.check(target, allows.clone()));
            }
        }
        let mut exhausted_reported = false;
        self.context
            .checking
            .store(!pending.is_empty(), Ordering::Release);
        loop {
            if !self.context.live() {
                break;
            }
            if pending.is_empty()
                && !exhausted_reported
                && self.context.incoming_count.load(Ordering::Acquire) == 0
            {
                self.context.checking.store(false, Ordering::Release);
                if !self.publish(&verified, Event::Exhausted).await {
                    break;
                }
                exhausted_reported = true;
            }
            tokio::select! {
                () = self.context.cancelled() => break,
                request = self.incoming.recv() => {
                    let Some(request) = request else { break };
                    self.context.checking.store(true, Ordering::Release);
                    self.context.incoming_count.fetch_sub(1, Ordering::AcqRel);
                    exhausted_reported = false;
                    if !self.publish(&verified, Event::Checking).await { break; }
                    if !responds(request.source) { continue; }
                    if let Err(error) = self.answer(&request).await {
                        tracing::debug!(%error, "peer check response failed");
                    }
                    if allows(request.source) && seen.len() < MAX_PAIRS && !seen.contains(&request.source) {
                        seen.push(request.source);
                        exhausted_reported = false;
                        pending.push(self.check(request.source, allows.clone()));
                    }
                }
                result = pending.next(), if !pending.is_empty() => {
                    if let Some(Some(target)) = result && self.context.live()
                        && !self.publish(&verified, Event::Verified(target)).await { break; }
                }
                () = verified.closed() => break,
            }
        }
    }
}

impl Drop for Binding {
    fn drop(&mut self) {
        self.authority().revoke();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Duration;
    use wtransport::quinn::{AsyncUdpSocket, TokioRuntime};

    fn endpoint() -> (
        wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>,
        Arc<DiscoverySocket>,
        SocketAddr,
    ) {
        let raw = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        raw.set_nonblocking(true).unwrap();
        let socket = DiscoverySocket::new(raw).unwrap();
        let address = socket.local_addr().unwrap();
        let config = wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new([0; 32])])
            .build();
        let endpoint = wtransport::Endpoint::client_with_socket(
            config,
            socket.clone(),
            Arc::new(TokioRuntime),
        )
        .unwrap();
        (endpoint, socket, address)
    }

    #[tokio::test]
    async fn both_peers_check_on_the_same_live_quinn_socket() {
        let (_client_endpoint, client, client_address) = endpoint();
        let (_daemon_endpoint, daemon, daemon_address) = endpoint();
        let client_binding = Binding::install(
            client.clone(),
            [7; 16],
            &[3; 32],
            &[4; 32],
            true,
            Arc::new(Semaphore::new(MAX_CHECKS_PER_PEER)),
        )
        .unwrap();
        let daemon_binding = Binding::install(
            daemon.clone(),
            [7; 16],
            &[3; 32],
            &[4; 32],
            false,
            Arc::new(Semaphore::new(MAX_CHECKS_PER_PEER)),
        )
        .unwrap();
        let (client_verified, mut at_client) = mpsc::channel(1);
        let (daemon_verified, mut at_daemon) = mpsc::channel(1);
        let client_task = tokio::spawn(client_binding.run(
            vec![daemon_address],
            |_| true,
            |_| true,
            client_verified,
        ));
        let daemon_task =
            tokio::spawn(daemon_binding.run(Vec::new(), |_| true, |_| true, daemon_verified));
        let results = tokio::time::timeout(Duration::from_secs(2), async {
            let (mut client, mut daemon) = (None, None);
            while client.is_none() || daemon.is_none() {
                tokio::select! {
                    event = at_client.recv() => {
                        if let Some(Event::Verified(address)) = event { client = Some(address); }
                    }
                    event = at_daemon.recv() => {
                        if let Some(Event::Verified(address)) = event { daemon = Some(address); }
                    }
                }
            }
            (client, daemon)
        })
        .await
        .unwrap();
        assert_eq!(results, (Some(daemon_address), Some(client_address)));
        assert_eq!(client.local_addr().unwrap(), client_address);
        assert_eq!(daemon.local_addr().unwrap(), daemon_address);
        drop(at_client);
        drop(at_daemon);
        client_task.await.unwrap();
        daemon_task.await.unwrap();
        assert!(client.pending_is_empty());
        assert!(daemon.pending_is_empty());
    }

    #[test]
    fn a_context_cannot_be_replaced_until_its_owner_retires() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _runtime = runtime.enter();
        let (_endpoint, socket, _) = endpoint();
        let quota = Arc::new(Semaphore::new(MAX_CHECKS_PER_PEER));
        let first = Binding::install(
            socket.clone(),
            [7; 16],
            &[3; 32],
            &[4; 32],
            true,
            quota.clone(),
        )
        .unwrap();
        assert!(
            Binding::install(
                socket.clone(),
                [7; 16],
                &[9; 32],
                &[8; 32],
                true,
                quota.clone()
            )
            .is_err()
        );
        drop(first);
        assert!(Binding::install(socket, [7; 16], &[9; 32], &[8; 32], true, quota).is_ok());
    }

    #[tokio::test]
    async fn synchronous_revocation_reclaims_pending_checks_without_retiring_a_successor() {
        let (_endpoint, socket, _) = endpoint();
        let sink = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let target = sink.local_addr().unwrap();
        let quota = Arc::new(Semaphore::new(MAX_CHECKS_PER_PEER));
        let old = Binding::install(
            socket.clone(),
            [7; 16],
            &[3; 32],
            &[4; 32],
            true,
            quota.clone(),
        )
        .unwrap();
        let authority = old.authority();
        let old_check = tokio::spawn(old.check(target, Arc::new(|_| true)));
        let mut packet = [0; 512];
        tokio::time::timeout(Duration::from_secs(2), sink.recv_from(&mut packet))
            .await
            .unwrap()
            .unwrap();
        assert!(!socket.pending_is_empty());
        authority.revoke();
        assert!(
            socket.pending_is_empty(),
            "revocation reclaims its slots synchronously"
        );
        assert_eq!(old_check.await.unwrap(), None);
        assert!(
            old.context
                .try_send(|| panic!("retired authority cannot dispatch"))
                .is_err()
        );

        let next =
            Binding::install(socket.clone(), [7; 16], &[9; 32], &[8; 32], true, quota).unwrap();
        let next_check = tokio::spawn(next.check(target, Arc::new(|_| true)));
        tokio::time::timeout(Duration::from_secs(2), sink.recv_from(&mut packet))
            .await
            .unwrap()
            .unwrap();
        drop(old);
        authority.revoke();
        assert!(
            !socket.pending_is_empty(),
            "retiring an old owner preserves successor transactions"
        );
        next.authority().revoke();
        assert!(socket.pending_is_empty());
        assert_eq!(next_check.await.unwrap(), None);
    }
}
