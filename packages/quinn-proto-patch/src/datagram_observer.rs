//! Nonblocking diagnostic observations of queue admission and packet construction.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

/// Boundary observed; none of these is an OS socket transmission timestamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatagramObservationKind {
    /// Accepted into the outgoing queue.
    Queued,
    /// Encoded into a QUIC packet after congestion/pacer admission.
    Packetized,
    /// Peer acknowledged the containing packet.
    PacketAcknowledged,
    /// QUIC declared the containing packet lost.
    PacketLost,
}

/// Borrowed diagnostic evidence; payload is present only for queue/packetize.
pub struct DatagramObservation<'a> {
    /// Process-unique identity for the connection's datagram queue.
    pub connection: u64,
    /// Boundary observed.
    pub kind: DatagramObservationKind,
    /// Application-data packet number, absent before packet construction.
    pub packet: Option<u64>,
    /// Borrowed DATAGRAM payload. The observer must not retain it.
    pub payload: &'a [u8],
    /// Inline prefix encoded before `payload`, if the sender used segmented admission.
    pub prefix: Option<crate::VarInt>,
    /// Remaining queued memory, including entry overhead.
    pub queued_bytes: usize,
}

impl DatagramObservation<'_> {
    /// Complete DATAGRAM payload length, including a segmented prefix.
    pub fn payload_len(&self) -> usize {
        self.payload.len() + self.prefix.map_or(0, |prefix| prefix.size())
    }
}

/// Callback contract: no blocking, allocation, IO or retained payload references.
pub type DatagramObserver = for<'a> fn(DatagramObservation<'a>);
static OBSERVER: OnceLock<DatagramObserver> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);
static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

/// Install once; installation alone does not enable observation.
pub fn install_datagram_observer(observer: DatagramObserver) -> bool {
    OBSERVER.set(observer).is_ok()
}

/// Change diagnostic activity without changing any transport policy.
pub fn set_datagram_observer_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Release);
}

pub(crate) fn observe(
    connection: &mut u64,
    kind: DatagramObservationKind,
    packet: Option<u64>,
    payload: &[u8],
    prefix: Option<crate::VarInt>,
    queued_bytes: usize,
) {
    if !ENABLED.load(Ordering::Acquire) {
        return;
    }
    let Some(observer) = OBSERVER.get() else {
        return;
    };
    if *connection == 0 {
        *connection = NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed);
    }
    observer(DatagramObservation {
        connection: *connection,
        kind,
        packet,
        payload,
        prefix,
        queued_bytes,
    });
}
