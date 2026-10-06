//! Authenticated discovery on the live QUIC socket, with one receive owner.
//!
//! Ordinary QUIC batches retain their buffers, metadata, and GRO/GSO capability.
//! Only a STUN-shaped packet consults the bounded transaction table. An invalid
//! MAC cannot consume a transaction; cancellation drops its registration.

use std::io::{self, IoSliceMut};
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use merkur_stun_protocol::message::verify_integrity;
use ring::hmac;
use tokio::sync::oneshot;
use tokio::time::Instant;
use wtransport::quinn::{AsyncUdpSocket, Runtime, TokioRuntime, UdpPoller, udp};

const MAX_PENDING: usize = 8;
pub(super) const MAX_DISCOVERY_DATAGRAM: usize = 1200;
const STUN_COOKIE: [u8; 4] = 0x2112_A442u32.to_be_bytes();

#[derive(Clone, Copy, Debug)]
pub(super) enum ResponseSource {
    Exact(SocketAddr),
    AuthenticatedSelf,
    ChangedPort(SocketAddr),
    ChangedAddress(SocketAddr),
}

impl ResponseSource {
    fn accepts(self, source: SocketAddr) -> bool {
        let source = canonical_addr(source);
        match self {
            Self::AuthenticatedSelf => true,
            Self::Exact(expected) => source == canonical_addr(expected),
            Self::ChangedPort(original) => {
                let original = canonical_addr(original);
                source.ip() == original.ip() && source.port() != original.port()
            }
            Self::ChangedAddress(original) => {
                let original = canonical_addr(original);
                source.is_ipv4() == original.is_ipv4()
                    && source.ip() != original.ip()
                    && source.port() != original.port()
            }
        }
    }
}

pub(super) fn canonical_addr(addr: SocketAddr) -> SocketAddr {
    SocketAddr::new(addr.ip().to_canonical(), addr.port())
}

#[derive(Debug)]
pub(super) struct DiscoveryResponse {
    pub source: SocketAddr,
    pub bytes: [u8; MAX_DISCOVERY_DATAGRAM],
    pub len: usize,
}

struct Pending {
    transaction: [u8; 12],
    source: ResponseSource,
    key: Arc<hmac::Key>,
    deadline: Instant,
    sender: oneshot::Sender<DiscoveryResponse>,
}

pub(crate) struct DiscoverySocket {
    inner: Arc<dyn AsyncUdpSocket>,
    pending: Mutex<[Option<Pending>; MAX_PENDING]>,
    contacts: Mutex<([Option<SocketAddr>; 64], bool)>,
}

impl std::fmt::Debug for DiscoverySocket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiscoverySocket")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

impl DiscoverySocket {
    pub fn new(socket: std::net::UdpSocket) -> io::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            inner: TokioRuntime.wrap_udp_socket(socket)?,
            pending: Mutex::new(std::array::from_fn(|_| None)),
            contacts: Mutex::new(([None; 64], false)),
        }))
    }

    // Discovery observers are reserved infrastructure, never application peers.
    // The ledger is socket-lifetime scoped and fails closed when full: eviction
    // could turn a familiar source into a false filtering pass.
    pub fn record_discovery_contact(&self, addr: SocketAddr) {
        let addr = canonical_addr(addr);
        if let Ok(mut contacts) = self.contacts.lock() {
            if contacts.0.contains(&Some(addr)) {
                return;
            }
            if let Some(slot) = contacts.0.iter_mut().find(|entry| entry.is_none()) {
                *slot = Some(addr);
            } else {
                contacts.1 = true;
            }
        }
    }

    pub fn contacted_discovery_ip(&self, ip: IpAddr) -> bool {
        self.contacts.lock().map_or(true, |contacts| {
            contacts.1
                || contacts
                    .0
                    .iter()
                    .flatten()
                    .any(|addr| addr.ip() == ip.to_canonical())
        })
    }

    pub fn contacted_discovery_endpoint(&self, addr: SocketAddr) -> bool {
        self.contacts.lock().map_or(true, |contacts| {
            contacts.1 || contacts.0.contains(&Some(canonical_addr(addr)))
        })
    }

    /// Registration precedes send, including on loopback. The caller's future
    /// owns the guard, so timeout/interruption cannot leave an occupied slot.
    pub(super) fn register(
        self: &Arc<Self>,
        transaction: [u8; 12],
        source: ResponseSource,
        key: Arc<hmac::Key>,
        deadline: Instant,
    ) -> io::Result<(Registration, oneshot::Receiver<DiscoveryResponse>)> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| io::Error::other("discovery lock poisoned"))?;
        let now = Instant::now();
        for slot in pending.iter_mut() {
            if slot
                .as_ref()
                .is_some_and(|entry| entry.deadline <= now || entry.sender.is_closed())
            {
                *slot = None;
            }
        }
        if deadline <= now
            || pending
                .iter()
                .flatten()
                .any(|entry| entry.transaction == transaction)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expired or duplicate discovery transaction",
            ));
        }
        let index = pending.iter().position(Option::is_none).ok_or_else(|| {
            io::Error::new(io::ErrorKind::WouldBlock, "discovery transaction capacity")
        })?;
        let (sender, receiver) = oneshot::channel();
        pending[index] = Some(Pending {
            transaction,
            source,
            key,
            deadline,
            sender,
        });
        Ok((
            Registration {
                socket: Arc::clone(self),
                index,
                transaction,
            },
            receiver,
        ))
    }

    pub async fn send(&self, destination: SocketAddr, bytes: &[u8]) -> io::Result<()> {
        let destination = if self.inner.local_addr()?.is_ipv6() {
            match destination {
                SocketAddr::V4(addr) => {
                    SocketAddr::new(IpAddr::V6(addr.ip().to_ipv6_mapped()), addr.port())
                }
                other => other,
            }
        } else {
            destination
        };
        let mut writable = Arc::clone(&self.inner).create_io_poller();
        std::future::poll_fn(|cx| {
            loop {
                match self.inner.try_send(&udp::Transmit {
                    destination,
                    ecn: None,
                    contents: bytes,
                    segment_size: None,
                    src_ip: None,
                }) {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::task::ready!(writable.as_mut().poll_writable(cx))?;
                    }
                    result => return Poll::Ready(result),
                }
            }
        })
        .await
    }

    fn receive_discovery(&self, packet: &[u8], meta: &udp::RecvMeta) {
        // Exact message length, final full-length integrity attribute, and an
        // outstanding unpredictable transaction are all required before HMAC.
        if packet.len() < 56
            || packet.len() > MAX_DISCOVERY_DATAGRAM
            || packet[0..2] != [0x01, 0x01]
            || usize::from(u16::from_be_bytes([packet[2], packet[3]])) + 20 != packet.len()
            || !packet.len().is_multiple_of(4)
        {
            return;
        }
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
        let Some(index) = pending.iter().position(|entry| {
            entry.as_ref().is_some_and(|entry| {
                packet[8..20] == entry.transaction
                    && entry.source.accepts(meta.addr)
                    && entry.deadline > Instant::now()
            })
        }) else {
            return;
        };
        let Some(entry) = pending[index].as_ref() else {
            return;
        };
        if !verify_integrity(packet, &entry.key) {
            return;
        }
        let Some(entry) = pending[index].take() else {
            return;
        };
        drop(pending);
        let mut response = DiscoveryResponse {
            source: canonical_addr(meta.addr),
            bytes: [0; MAX_DISCOVERY_DATAGRAM],
            len: packet.len(),
        };
        response.bytes[..packet.len()].copy_from_slice(packet);
        let _ = entry.sender.send(response);
    }

    /// Compacts only a GRO buffer containing discovery. Pure QUIC takes no
    /// copies, allocation, locking, or cryptographic work. Keeping zero-length
    /// receive entries lets Quinn retain its original batch buffers and count.
    fn filter_batch(&self, bufs: &mut [IoSliceMut<'_>], meta: &mut [udp::RecvMeta], count: usize) {
        for (buffer, metadata) in bufs.iter_mut().zip(meta).take(count) {
            let len = metadata.len;
            let stride = metadata.stride.max(1);
            let mut retained = 0;
            for start in (0..len).step_by(stride) {
                let end = (start + stride).min(len);
                let packet = &buffer[start..end];
                if packet.len() >= 20 && packet[0] & 0xc0 == 0 && packet[4..8] == STUN_COOKIE {
                    self.receive_discovery(packet, metadata);
                } else {
                    if retained != start {
                        buffer.copy_within(start..end, retained);
                    }
                    retained += end - start;
                }
            }
            metadata.len = retained;
        }
    }
}

pub(super) struct Registration {
    socket: Arc<DiscoverySocket>,
    index: usize,
    transaction: [u8; 12],
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.socket.pending.lock()
            && pending[self.index]
                .as_ref()
                .is_some_and(|entry| entry.transaction == self.transaction)
        {
            pending[self.index] = None;
        }
    }
}

impl AsyncUdpSocket for DiscoverySocket {
    fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
        Arc::clone(&self.inner).create_io_poller()
    }
    fn try_send(&self, transmit: &udp::Transmit) -> io::Result<()> {
        self.inner.try_send(transmit)
    }
    fn poll_recv(
        &self,
        cx: &mut Context,
        bufs: &mut [IoSliceMut<'_>],
        meta: &mut [udp::RecvMeta],
    ) -> Poll<io::Result<usize>> {
        let count = std::task::ready!(self.inner.poll_recv(cx, bufs, meta))?;
        self.filter_batch(bufs, meta, count);
        Poll::Ready(Ok(count))
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
    }
    fn max_transmit_segments(&self) -> usize {
        self.inner.max_transmit_segments()
    }
    fn max_receive_segments(&self) -> usize {
        self.inner.max_receive_segments()
    }
    fn may_fragment(&self) -> bool {
        self.inner.may_fragment()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(transaction: [u8; 12], key: &hmac::Key) -> Vec<u8> {
        let mut packet = vec![1, 1, 0, 36];
        packet.extend_from_slice(&STUN_COOKIE);
        packet.extend_from_slice(&transaction);
        let tag = hmac::sign(key, &packet);
        packet.extend_from_slice(&[0, 0x1c, 0, 32]);
        packet.extend_from_slice(tag.as_ref());
        packet
    }

    fn metadata(addr: SocketAddr, len: usize, stride: usize) -> udp::RecvMeta {
        udp::RecvMeta {
            addr,
            len,
            stride,
            ecn: Some(udp::EcnCodepoint::Ect0),
            dst_ip: Some(addr.ip()),
        }
    }

    #[tokio::test]
    async fn only_the_authenticated_expected_source_can_consume_a_transaction() {
        let socket =
            DiscoverySocket::new(std::net::UdpSocket::bind("127.0.0.1:0").unwrap()).unwrap();
        let key = Arc::new(hmac::Key::new(hmac::HMAC_SHA256, b"pending-only"));
        let addr = "192.0.2.1:3478".parse().unwrap();
        let (_guard, mut response) = socket
            .register(
                [7; 12],
                ResponseSource::Exact(addr),
                key.clone(),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        let authentic = packet([7; 12], &key);
        let mut forged = authentic.clone();
        forged[55] ^= 1;
        socket.receive_discovery(&forged, &metadata(addr, 56, 56));
        socket.receive_discovery(
            &authentic,
            &metadata("192.0.2.2:3478".parse().unwrap(), 56, 56),
        );
        assert!(matches!(
            response.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        socket.receive_discovery(&authentic, &metadata(addr, 56, 56));
        assert_eq!(response.await.unwrap().bytes[..56], authentic);
        assert!(socket.pending.lock().unwrap().iter().all(Option::is_none));
    }

    use tokio::time::Duration;

    #[tokio::test]
    async fn cancellation_and_capacity_are_bounded_without_nonce_reuse() {
        let socket =
            DiscoverySocket::new(std::net::UdpSocket::bind("127.0.0.1:0").unwrap()).unwrap();
        let key = Arc::new(hmac::Key::new(hmac::HMAC_SHA256, b"key"));
        let addr = "192.0.2.1:3478".parse().unwrap();
        let mut registrations = Vec::new();
        for i in 0..MAX_PENDING {
            registrations.push(
                socket
                    .register(
                        [i as u8; 12],
                        ResponseSource::Exact(addr),
                        key.clone(),
                        Instant::now() + Duration::from_secs(2),
                    )
                    .unwrap(),
            );
        }
        assert!(
            socket
                .register(
                    [99; 12],
                    ResponseSource::Exact(addr),
                    key.clone(),
                    Instant::now() + Duration::from_secs(2)
                )
                .is_err()
        );
        registrations.pop();
        assert!(
            socket
                .register(
                    [99; 12],
                    ResponseSource::Exact(addr),
                    key,
                    Instant::now() + Duration::from_secs(2)
                )
                .is_ok()
        );
        drop(registrations);
        assert!(socket.pending.lock().unwrap().iter().all(Option::is_none));
    }

    #[tokio::test]
    async fn mixed_gro_preserves_quic_order_metadata_and_short_final_segment() {
        let socket =
            DiscoverySocket::new(std::net::UdpSocket::bind("127.0.0.1:0").unwrap()).unwrap();
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"key");
        let stun = packet([1; 12], &key);
        let quic = [0xc0; 56];
        let tail = [0x40; 13];
        let mut mixed = [quic.as_slice(), stun.as_slice(), quic.as_slice(), &tail].concat();
        let mut all_stun = stun;
        let mut pure_quic = quic;
        let pure_before = pure_quic;
        let addr = "192.0.2.1:3478".parse().unwrap();
        let mut meta = [
            metadata(addr, mixed.len(), 56),
            metadata(addr, 56, 56),
            metadata(addr, 56, 56),
        ];
        let mut bufs = [
            IoSliceMut::new(&mut mixed),
            IoSliceMut::new(&mut all_stun),
            IoSliceMut::new(&mut pure_quic),
        ];
        let pointer = bufs[2].as_ptr();
        socket.filter_batch(&mut bufs, &mut meta, 3);
        assert_eq!(
            &bufs[0][..meta[0].len],
            [quic.as_slice(), quic.as_slice(), &tail].concat()
        );
        assert_eq!(meta[0].stride, 56);
        assert_eq!(meta[0].addr, addr);
        assert_eq!(meta[0].dst_ip, Some(addr.ip()));
        assert_eq!(meta[0].ecn, Some(udp::EcnCodepoint::Ect0));
        assert_eq!(meta[1].len, 0);
        assert_eq!(bufs[2].as_ptr(), pointer);
        assert_eq!(bufs[2].as_ref(), pure_before);
    }

    #[tokio::test]
    async fn integrity_rejects_trailing_attributes_and_truncation() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"key");
        let authentic = packet([3; 12], &key);
        assert!(verify_integrity(&authentic, &key));
        for len in 0..authentic.len() {
            assert!(!verify_integrity(&authentic[..len], &key));
        }
        let mut trailing = authentic;
        trailing.extend_from_slice(&[0x80, 0x01, 0, 0]);
        trailing[3] = 40;
        assert!(!verify_integrity(&trailing, &key));
    }
}
