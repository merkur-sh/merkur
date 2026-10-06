use std::collections::VecDeque;

use bytes::Bytes;
use thiserror::Error;
use tracing::{debug, trace};

use super::Connection;
use crate::datagram_observer::{self, DatagramObservationKind};
use crate::{
    frame::{Datagram, FrameStruct},
    TransportError, DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD,
};

/// API to control datagram traffic
pub struct Datagrams<'a> {
    pub(super) conn: &'a mut Connection,
}

impl Datagrams<'_> {
    /// Queue an unreliable, unordered datagram for immediate transmission
    ///
    /// If `drop` is true, previously queued datagrams which are still unsent may be discarded to
    /// make space for this datagram, in order of oldest to newest. If `drop` is false, and there
    /// isn't enough space due to previously queued datagrams, this function will return
    /// `SendDatagramError::Blocked`. `Event::DatagramsUnblocked` will be emitted once datagrams
    /// have been sent.
    ///
    /// Returns `Err` iff a `len`-byte datagram cannot currently be sent.
    pub fn send(&mut self, data: Bytes, drop: bool) -> Result<(), SendDatagramError> {
        self.send_inner(data, None, drop)
    }

    /// Queue a varint application prefix and shared payload without assembling
    /// another buffer. The exact combined length owns one admission.
    pub fn send_with_prefix(
        &mut self,
        prefix: crate::VarInt,
        data: Bytes,
        drop: bool,
    ) -> Result<(), SendDatagramError> {
        self.send_inner(data, Some(prefix), drop)
    }

    fn send_inner(
        &mut self,
        data: Bytes,
        prefix: Option<crate::VarInt>,
        drop: bool,
    ) -> Result<(), SendDatagramError> {
        let payload_len = data
            .len()
            .checked_add(prefix.map_or(0, |p| p.size()))
            .ok_or(SendDatagramError::TooLarge)?;
        if self.conn.config.datagram_receive_buffer_size.is_none() {
            return Err(SendDatagramError::Disabled);
        }
        let max = self
            .max_size()
            .ok_or(SendDatagramError::UnsupportedByPeer)?;
        if payload_len > max {
            return Err(SendDatagramError::TooLarge);
        }
        let send_buffer_size = self.conn.config.datagram_send_buffer_size;
        // A datagram that cannot fit in an empty queue will never become
        // sendable. Classify it as too large instead of evicting every older
        // datagram (`drop = true`) or parking `send_datagram_wait` forever
        // (`drop = false`).
        if !DatagramBuffer::payload_fits_empty(payload_len, send_buffer_size) {
            return Err(SendDatagramError::TooLarge);
        }
        if drop {
            let admitted = self.conn.datagrams.outgoing.evict_oldest_until_space(
                payload_len,
                send_buffer_size,
                |previous| {
                    trace!(len = previous.data.len(), "dropping outgoing datagram");
                },
            );
            debug_assert!(admitted, "empty-queue fit was checked above");
        } else if !self
            .conn
            .datagrams
            .outgoing
            .has_space_for(payload_len, send_buffer_size)
        {
            self.conn.datagrams.send_blocked = true;
            return Err(SendDatagramError::Blocked(data));
        }
        self.conn
            .datagrams
            .observe_prefixed(DatagramObservationKind::Queued, None, &data, prefix);
        self.conn
            .datagrams
            .outgoing
            .push_back(Datagram { data, prefix });
        Ok(())
    }

    /// Compute the maximum size of datagrams that may passed to `send_datagram`
    ///
    /// Returns `None` if datagrams are unsupported by the peer or disabled locally.
    ///
    /// This may change over the lifetime of a connection according to variation in the path MTU
    /// estimate. The peer can also enforce an arbitrarily small fixed limit, but if the peer's
    /// limit is large this is guaranteed to be a little over a kilobyte at minimum.
    ///
    /// Not necessarily the maximum size of received datagrams.
    pub fn max_size(&self) -> Option<usize> {
        // We use the conservative overhead bound for any packet number, reducing the budget by at
        // most 3 bytes, so that PN size fluctuations don't cause users sending maximum-size
        // datagrams to suffer avoidable packet loss.
        let max_size = self.conn.path.current_mtu() as usize
            - self.conn.predict_1rtt_overhead(None)
            - Datagram::SIZE_BOUND;
        let limit = self
            .conn
            .peer_params
            .max_datagram_frame_size?
            .into_inner()
            .saturating_sub(Datagram::SIZE_BOUND as u64);
        Some(limit.min(max_size as u64) as usize)
    }

    /// Receive an unreliable, unordered datagram
    pub fn recv(&mut self) -> Option<Bytes> {
        self.conn.datagrams.recv()
    }

    /// Take the oldest matching buffered datagram without moving or dropping others.
    /// The predicate runs under the connection lock and must not block.
    pub fn recv_matching(&mut self, predicate: impl FnMut(&Bytes) -> bool) -> Option<Bytes> {
        self.conn.datagrams.selective_readers = true;
        self.conn
            .datagrams
            .incoming
            .remove_matching(predicate)
            .map(|d| d.data)
    }

    /// Length of the datagram [`recv`](Self::recv) would return next, without taking it
    pub fn peek_len(&self) -> Option<usize> {
        self.conn.datagrams.incoming.front_len()
    }

    /// Discard every queued datagram that has not been sent, returning how many were dropped
    ///
    /// For datagrams a newer one supersedes, whose repair comes from later state rather than
    /// from this copy: once only loss probes may leave, what is queued can only go stale.
    pub fn clear_queued(&mut self) -> usize {
        let dropped = self.conn.datagrams.outgoing.clear();
        if dropped != 0 && std::mem::take(&mut self.conn.datagrams.send_blocked) {
            self.conn.events.push_back(super::Event::DatagramsUnblocked);
        }
        dropped
    }

    /// Bytes available in the outgoing datagram buffer
    ///
    /// When greater than zero, [`send`](Self::send)ing a datagram of at most this size is
    /// guaranteed not to cause older datagrams to be dropped.
    pub fn send_buffer_space(&self) -> usize {
        self.conn.datagram_send_buffer_space()
    }
}

impl Connection {
    /// [`Datagrams::send_buffer_space`] without the `&mut` borrow, for
    /// [`Connection::delivery_state`]
    pub(super) fn datagram_send_buffer_space(&self) -> usize {
        self.config
            .datagram_send_buffer_size
            .saturating_sub(self.datagrams.outgoing.memory_used())
            .saturating_sub(DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD)
    }
}

#[derive(Default)]
pub(super) struct DatagramState {
    trace_connection: u64,
    pub(super) incoming: DatagramBuffer,
    pub(super) outgoing: DatagramBuffer,
    pub(super) send_blocked: bool,
    selective_readers: bool,
}

impl DatagramState {
    pub(super) fn observe(
        &mut self,
        kind: DatagramObservationKind,
        packet: Option<u64>,
        payload: &[u8],
    ) {
        self.observe_prefixed(kind, packet, payload, None);
    }

    fn observe_prefixed(
        &mut self,
        kind: DatagramObservationKind,
        packet: Option<u64>,
        payload: &[u8],
        prefix: Option<crate::VarInt>,
    ) {
        datagram_observer::observe(
            &mut self.trace_connection,
            kind,
            packet,
            payload,
            prefix,
            self.outgoing.memory_used(),
        );
    }

    pub(super) fn received(
        &mut self,
        datagram: Datagram,
        window: &Option<usize>,
    ) -> Result<bool, TransportError> {
        let window = match window {
            None => {
                return Err(TransportError::PROTOCOL_VIOLATION(
                    "unexpected DATAGRAM frame",
                ));
            }
            Some(x) => *x,
        };

        let size_with_overhead = datagram
            .data
            .len()
            .saturating_add(DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD);

        if size_with_overhead > window {
            return Err(TransportError::PROTOCOL_VIOLATION("oversized datagram"));
        }

        let was_empty = self.incoming.is_empty();
        while self
            .incoming
            .memory_used()
            .saturating_add(size_with_overhead)
            > window
        {
            debug!("dropping stale datagram");
            self.recv();
        }

        self.incoming.push_back(datagram);
        // A selective reader can be waiting while unmatched packets remain.
        Ok(was_empty || self.selective_readers)
    }

    /// Discard outgoing datagrams with a payload larger than `max_payload` bytes
    ///
    /// Used to ensure that reductions in MTU don't get us stuck in a state where we have a datagram
    /// queued but can't send it.
    pub(super) fn drop_oversized(&mut self, max_payload: usize) {
        self.outgoing.queue.retain(|datagram| {
            let result = datagram.payload_len() <= max_payload;
            if !result {
                trace!(
                    "dropping {} byte datagram violating {} byte limit",
                    datagram.data.len(),
                    max_payload
                );
                self.outgoing.payload_bytes -= datagram.payload_len();
            }
            result
        });
    }

    /// Attempt to write a datagram frame into `buf`, consuming it from `self.outgoing`
    ///
    /// Returns whether a frame was written. At most `max_size` bytes will be written, including
    /// framing.
    pub(super) fn write(&mut self, buf: &mut Vec<u8>, max_size: usize, packet: u64) -> bool {
        let datagram = match self.outgoing.pop_front() {
            Some(x) => x,
            None => return false,
        };

        if buf.len() + datagram.size(true) > max_size {
            // Future work: we could be more clever about cramming small datagrams into
            // mostly-full packets when a larger one is queued first
            self.outgoing.push_front(datagram);
            return false;
        }

        trace!(len = datagram.data.len(), "DATAGRAM");
        datagram.encode(true, buf);
        self.observe_prefixed(
            DatagramObservationKind::Packetized,
            Some(packet),
            &datagram.data,
            datagram.prefix,
        );
        true
    }

    pub(super) fn recv(&mut self) -> Option<Bytes> {
        let x = self.incoming.pop_front()?.data;
        Some(x)
    }
}

#[derive(Default)]
pub(super) struct DatagramBuffer {
    queue: VecDeque<Datagram>,
    payload_bytes: usize,
}

impl DatagramBuffer {
    #[inline]
    fn payload_fits_empty(payload_len: usize, capacity: usize) -> bool {
        payload_len
            .checked_add(DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD)
            .is_some_and(|required| required <= capacity)
    }

    #[inline]
    fn has_space_for(&self, payload_len: usize, capacity: usize) -> bool {
        self.available_payload_space(capacity)
            .is_some_and(|free_payload| payload_len <= free_payload)
    }

    #[inline]
    fn available_payload_space(&self, capacity: usize) -> Option<usize> {
        capacity
            .checked_sub(self.memory_used())
            .and_then(|free| free.checked_sub(DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD))
    }

    fn evict_oldest_until_space(
        &mut self,
        payload_len: usize,
        capacity: usize,
        mut on_evict: impl FnMut(&Datagram),
    ) -> bool {
        // Do not destroy useful queued datagrams for a prospective unit that
        // cannot fit even after every eviction.
        if !Self::payload_fits_empty(payload_len, capacity) {
            return false;
        }
        while !self.has_space_for(payload_len, capacity) {
            let Some(previous) = self.pop_front() else {
                return false;
            };
            on_evict(&previous);
        }
        true
    }

    fn remove_matching(&mut self, mut predicate: impl FnMut(&Bytes) -> bool) -> Option<Datagram> {
        let index = self
            .queue
            .iter()
            .position(|datagram| predicate(&datagram.data))?;
        let datagram = self.queue.remove(index)?;
        self.payload_bytes -= datagram.payload_len();
        Some(datagram)
    }

    fn push_back(&mut self, datagram: Datagram) {
        self.payload_bytes += datagram.payload_len();
        self.queue.push_back(datagram);
    }

    fn pop_front(&mut self) -> Option<Datagram> {
        let datagram = self.queue.pop_front()?;
        self.payload_bytes -= datagram.payload_len();
        Some(datagram)
    }

    fn push_front(&mut self, datagram: Datagram) {
        self.payload_bytes += datagram.payload_len();
        self.queue.push_front(datagram);
    }

    fn clear(&mut self) -> usize {
        let dropped = self.queue.len();
        self.queue.clear();
        self.payload_bytes = 0;
        dropped
    }

    fn memory_used(&self) -> usize {
        self.payload_bytes.saturating_add(
            self.queue
                .len()
                .saturating_mul(DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD),
        )
    }

    pub(super) fn can_send_1rtt(&self, max_size: usize) -> bool {
        self.queue.front().is_some_and(|x| x.size(true) <= max_size)
    }

    /// Payload bytes waiting to be sent
    pub(super) fn payload_bytes(&self) -> usize {
        self.payload_bytes
    }

    pub(super) fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    fn front_len(&self) -> Option<usize> {
        self.queue.front().map(Datagram::payload_len)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Observed {
        connection: u64,
        kind: DatagramObservationKind,
        packet: Option<u64>,
        payload_len: usize,
        payload_prefix: [u8; 16],
        queued_bytes: usize,
    }

    // Only this module's single observer test installs/enables the callback.
    // Other concurrently executing tests may call it, but their thread-local
    // slot is disabled. The callback neither allocates nor blocks, and retains
    // no payload references, matching the production callback contract.
    thread_local! {
        static OBSERVATIONS: RefCell<Option<([Option<Observed>; 16], usize)>> = const { RefCell::new(None) };
    }

    fn record_observation(event: crate::datagram_observer::DatagramObservation<'_>) {
        OBSERVATIONS.with(|observations| {
            let mut observations = observations.borrow_mut();
            let Some((slots, count)) = observations.as_mut() else {
                return;
            };
            let mut payload_prefix = [0; 16];
            let len = event.payload.len().min(payload_prefix.len());
            payload_prefix[..len].copy_from_slice(&event.payload[..len]);
            slots[*count] = Some(Observed {
                connection: event.connection,
                kind: event.kind,
                packet: event.packet,
                payload_len: event.payload_len(),
                payload_prefix,
                queued_bytes: event.queued_bytes,
            });
            *count += 1;
        });
    }

    #[test]
    fn observer_preserves_packet_bytes_fifo_and_blocked_write_state() {
        use crate::datagram_observer::{install_datagram_observer, set_datagram_observer_enabled};

        struct DisableOnDrop;
        impl Drop for DisableOnDrop {
            fn drop(&mut self) {
                set_datagram_observer_enabled(false);
                OBSERVATIONS.with(|observations| *observations.borrow_mut() = None);
            }
        }
        assert!(install_datagram_observer(record_observation));
        let _reset = DisableOnDrop;
        OBSERVATIONS.with(|observations| *observations.borrow_mut() = Some(([None; 16], 0)));
        let mut disabled = DatagramState::default();
        let mut enabled = DatagramState::default();
        for byte in [1, 2] {
            let data = datagram(byte, 16);
            disabled.observe(DatagramObservationKind::Queued, None, &data.data);
            disabled.outgoing.push_back(data);
        }
        let mut without_observer = Vec::with_capacity(128);
        assert!(disabled.write(&mut without_observer, 128, 41));
        assert!(disabled.write(&mut without_observer, 128, 42));
        assert_eq!(
            disabled.trace_connection, 0,
            "disabled path must not allocate an identity"
        );
        OBSERVATIONS.with(|observations| assert_eq!(observations.borrow().as_ref().unwrap().1, 0));

        set_datagram_observer_enabled(true);
        for byte in [1, 2] {
            let data = datagram(byte, 16);
            enabled.observe(DatagramObservationKind::Queued, None, &data.data);
            enabled.outgoing.push_back(data);
        }
        let connection = enabled.trace_connection;
        assert_ne!(connection, 0);
        let memory_before = enabled.outgoing.memory_used();
        let mut with_observer = Vec::with_capacity(128);
        assert!(!enabled.write(&mut with_observer, 0, 40));
        assert!(with_observer.is_empty());
        assert_eq!(enabled.outgoing.memory_used(), memory_before);
        OBSERVATIONS.with(|observations| assert_eq!(observations.borrow().as_ref().unwrap().1, 2));
        assert!(enabled.write(&mut with_observer, 128, 41));
        assert!(enabled.write(&mut with_observer, 128, 42));
        assert!(!enabled.write(&mut with_observer, 128, 43));
        assert_eq!(with_observer, without_observer);
        assert_eq!(with_observer.capacity(), 128);
        assert!(enabled.outgoing.is_empty());
        enabled.observe(DatagramObservationKind::PacketAcknowledged, Some(41), &[]);
        enabled.observe(DatagramObservationKind::PacketLost, Some(42), &[]);
        OBSERVATIONS.with(|observations| {
            let observations = observations.borrow();
            let (slots, count) = observations.as_ref().unwrap();
            assert_eq!(*count, 6);
            let events = slots[..*count]
                .iter()
                .map(|event| event.unwrap())
                .collect::<Vec<_>>();
            assert!(events.iter().all(|event| event.connection == connection));
            assert_eq!(events[0].kind, DatagramObservationKind::Queued);
            assert_eq!(events[0].packet, None);
            assert_eq!(events[0].queued_bytes, 0);
            assert_eq!(
                events[1].queued_bytes,
                16 + DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD
            );
            for (index, packet) in [(2, 41), (3, 42)] {
                assert_eq!(events[index].kind, DatagramObservationKind::Packetized);
                assert_eq!(events[index].packet, Some(packet));
                assert_eq!(events[index].payload_len, 16);
                assert_eq!(events[index].payload_prefix, [index as u8 - 1; 16]);
                assert_eq!(
                    events[index].payload_prefix,
                    events[index - 2].payload_prefix
                );
            }
            assert_eq!(events[3].queued_bytes, 0);
            assert_eq!(events[4].kind, DatagramObservationKind::PacketAcknowledged);
            assert_eq!(events[4].packet, Some(41));
            assert_eq!(events[5].kind, DatagramObservationKind::PacketLost);
            assert_eq!(events[5].packet, Some(42));
            assert_eq!(events[4].payload_len, 0);
            assert_eq!(events[5].payload_len, 0);
        });
        let mut second = DatagramState::default();
        second.observe(DatagramObservationKind::Queued, None, b"new");
        assert_ne!(second.trace_connection, connection);
        set_datagram_observer_enabled(false);
        enabled.observe(DatagramObservationKind::PacketLost, Some(99), &[]);
        OBSERVATIONS.with(|observations| assert_eq!(observations.borrow().as_ref().unwrap().1, 7));
    }

    fn datagram(byte: u8, len: usize) -> Datagram {
        Datagram {
            data: Bytes::from(vec![byte; len]),
            prefix: None,
        }
    }

    #[test]
    fn shared_payloads_with_distinct_prefixes_encode_identically_and_charge_exactly() {
        use crate::{coding::BufMutExt, VarInt};

        let payload = Bytes::from(vec![0x5a; 97]);
        for value in [
            0,
            63,
            64,
            16383,
            16384,
            (1 << 30) - 1,
            1 << 30,
            (1 << 62) - 1,
        ] {
            let prefix = VarInt::from_u64(value).unwrap();
            let segmented = Datagram {
                data: payload.clone(),
                prefix: Some(prefix),
            };
            assert_eq!(segmented.data.as_ptr(), payload.as_ptr());
            let mut contiguous = Vec::new();
            contiguous.write(prefix);
            contiguous.extend_from_slice(&payload);
            let original = Datagram {
                data: contiguous.into(),
                prefix: None,
            };
            for explicit_len in [false, true] {
                let mut actual = Vec::new();
                let mut expected = Vec::new();
                segmented.encode(explicit_len, &mut actual);
                original.encode(explicit_len, &mut expected);
                assert_eq!(actual, expected);
                assert_eq!(segmented.size(explicit_len), actual.len());
            }
            let mut state = DatagramState::default();
            let len = segmented.payload_len();
            let frame_len = segmented.size(true);
            state.outgoing.push_back(segmented);
            let cost = len + DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
            assert_eq!(state.outgoing.memory_used(), cost);
            assert!(!state.outgoing.has_space_for(0, cost));
            let mut packet = Vec::new();
            assert!(!state.write(&mut packet, frame_len - 1, 1));
            assert!(packet.is_empty());
            assert_eq!(state.outgoing.memory_used(), cost);
            state.drop_oversized(len);
            assert_eq!(state.outgoing.memory_used(), cost);
            assert!(state.write(&mut packet, frame_len, 2));
            assert_eq!(state.outgoing.memory_used(), 0);
            state.outgoing.push_back(Datagram {
                data: payload.clone(),
                prefix: Some(prefix),
            });
            state.drop_oversized(len - 1);
            assert_eq!(state.outgoing.memory_used(), 0);
        }
        assert!(payload.is_unique());
    }

    #[test]
    fn buffer_space_accounts_for_every_queued_datagram_header() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let mut buffer = DatagramBuffer::default();
        buffer.push_back(datagram(1, 11));
        buffer.push_back(datagram(2, 23));

        assert_eq!(buffer.memory_used(), 34 + 2 * overhead);
        assert!(buffer.has_space_for(7, 41 + 3 * overhead));
        assert!(!buffer.has_space_for(8, 41 + 3 * overhead));
    }

    #[test]
    fn selective_readers_are_notified_when_unmatched_datagrams_are_already_buffered() {
        let mut state = DatagramState::default();
        let window = Some(1024);
        assert!(state.received(datagram(3, 11), &window).unwrap());
        assert!(!state.received(datagram(3, 17), &window).unwrap());
        state.selective_readers = true;
        assert!(state.received(datagram(1, 4), &window).unwrap());
        let before = state.incoming.memory_used();
        assert_eq!(
            state
                .incoming
                .remove_matching(|bytes| bytes[0] == 1)
                .unwrap()
                .data
                .len(),
            4
        );
        assert_eq!(
            state.incoming.memory_used(),
            before - 4 - DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD
        );
        assert_eq!(state.recv().unwrap().len(), 11);
        assert_eq!(state.recv().unwrap().len(), 17);
    }

    #[test]
    fn selective_dequeue_keeps_blocked_packets_and_charges_the_removed_unit_once() {
        let mut buffer = DatagramBuffer::default();
        buffer.push_back(datagram(3, 11));
        buffer.push_back(datagram(3, 17));
        buffer.push_back(datagram(1, 4));
        let before = buffer.memory_used();
        assert!(buffer.remove_matching(|bytes| bytes[0] == 2).is_none());
        assert_eq!(buffer.memory_used(), before);
        assert_eq!(
            buffer
                .remove_matching(|bytes| bytes[0] == 1)
                .unwrap()
                .data
                .len(),
            4
        );
        assert_eq!(
            buffer.memory_used(),
            before - 4 - DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD
        );
        assert_eq!(buffer.pop_front().unwrap().data.len(), 11);
        assert_eq!(buffer.pop_front().unwrap().data.len(), 17);
        assert_eq!(buffer.memory_used(), 0);
    }

    #[test]
    fn pop_front_updates_accounting_once_and_preserves_fifo_order() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let mut buffer = DatagramBuffer::default();
        buffer.push_back(datagram(1, 11));
        buffer.push_back(datagram(2, 23));

        let first = buffer.pop_front().expect("first datagram");
        assert_eq!(first.data[0], 1);
        assert_eq!(buffer.memory_used(), 23 + overhead);
        let second = buffer.pop_front().expect("second datagram");
        assert_eq!(second.data[0], 2);
        assert_eq!(buffer.memory_used(), 0);
        assert!(buffer.pop_front().is_none());
    }

    #[test]
    fn prospective_datagram_must_fit_even_when_queue_is_empty() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let buffer = DatagramBuffer::default();
        assert!(buffer.has_space_for(31, 31 + overhead));
        assert!(!buffer.has_space_for(32, 31 + overhead));
        assert!(!buffer.has_space_for(usize::MAX, usize::MAX));
    }

    #[test]
    fn eviction_drops_the_minimum_oldest_prefix_for_the_prospective_send() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let mut buffer = DatagramBuffer::default();
        buffer.push_back(datagram(1, 11));
        buffer.push_back(datagram(2, 17));
        buffer.push_back(datagram(3, 23));
        let capacity = 50 + 3 * overhead;
        let mut evicted = Vec::new();

        assert!(buffer.evict_oldest_until_space(20, capacity, |previous| {
            evicted.push(previous.data[0]);
        }));
        assert_eq!(evicted, vec![1, 2]);
        assert_eq!(buffer.queue.front().unwrap().data[0], 3);
        assert_eq!(buffer.memory_used(), 23 + overhead);
        assert!(buffer.has_space_for(20, capacity));
    }

    #[test]
    fn impossible_prospective_datagram_preserves_every_queued_unit() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let mut buffer = DatagramBuffer::default();
        buffer.push_back(datagram(1, 11));
        let mut evictions = 0;

        assert!(!buffer.evict_oldest_until_space(65, 64 + overhead, |_| {
            evictions += 1;
        }));
        assert_eq!(evictions, 0);
        assert_eq!(buffer.queue.len(), 1);
        assert_eq!(buffer.queue.front().unwrap().data[0], 1);
        assert_eq!(buffer.memory_used(), 11 + overhead);
    }

    #[test]
    fn advertised_payload_space_matches_variable_queue_occupancy() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let capacity = 100 + 4 * overhead;
        let mut buffer = DatagramBuffer::default();
        assert_eq!(
            buffer.available_payload_space(capacity),
            Some(100 + 3 * overhead)
        );

        for len in [7, 19, 31] {
            buffer.push_back(datagram(len as u8, len));
            let expected = capacity
                .checked_sub(buffer.memory_used())
                .and_then(|free| free.checked_sub(overhead));
            assert_eq!(buffer.available_payload_space(capacity), expected);
        }
    }

    #[test]
    fn mtu_revalidation_keeps_an_exact_maximum_payload() {
        let mut state = DatagramState::default();
        state.outgoing.push_back(datagram(1, 1_199));
        state.outgoing.push_back(datagram(2, 1_200));
        state.outgoing.push_back(datagram(3, 1_201));

        state.drop_oversized(1_200);

        assert_eq!(state.outgoing.queue.len(), 2);
        assert_eq!(state.outgoing.queue[0].data.len(), 1_199);
        assert_eq!(state.outgoing.queue[1].data.len(), 1_200);
        assert_eq!(state.outgoing.payload_bytes, 2_399);
    }

    #[test]
    fn exact_capacity_boundary_admits_equal_and_rejects_one_more() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let capacity = 97 + overhead;

        assert!(DatagramBuffer::payload_fits_empty(97, capacity));
        assert!(!DatagramBuffer::payload_fits_empty(98, capacity));

        let mut buffer = DatagramBuffer::default();
        assert!(buffer.evict_oldest_until_space(97, capacity, |_| {
            panic!("empty exact-capacity admission must not evict")
        }));
        buffer.push_back(datagram(7, 97));
        assert_eq!(buffer.memory_used(), capacity);
        assert!(!buffer.has_space_for(0, capacity));
    }

    #[test]
    fn exhaustive_non_dropping_admission_matches_the_capacity_oracle() {
        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;

        for capacity in 0..=(3 * overhead + 24) {
            for first_len in 0..=8 {
                for second_len in 0..=8 {
                    let mut buffer = DatagramBuffer::default();
                    let initial_cost = first_len + second_len + 2 * overhead;
                    if initial_cost <= capacity {
                        buffer.push_back(datagram(1, first_len));
                        buffer.push_back(datagram(2, second_len));
                    }
                    let before_memory = buffer.memory_used();
                    let before_payload = buffer.payload_bytes;
                    let before_ids = buffer
                        .queue
                        .iter()
                        .map(|value| value.data.first().copied())
                        .collect::<Vec<_>>();

                    for prospective_len in 0..=16 {
                        let expected = before_memory
                            .checked_add(overhead)
                            .and_then(|used| used.checked_add(prospective_len))
                            .is_some_and(|used| used <= capacity);
                        assert_eq!(
                            buffer.has_space_for(prospective_len, capacity),
                            expected,
                            "capacity={capacity} first={first_len} second={second_len} prospective={prospective_len}",
                        );
                        assert_eq!(buffer.memory_used(), before_memory);
                        assert_eq!(buffer.payload_bytes, before_payload);
                        assert_eq!(
                            buffer
                                .queue
                                .iter()
                                .map(|value| value.data.first().copied())
                                .collect::<Vec<_>>(),
                            before_ids,
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn every_concurrent_producer_interleaving_preserves_accepted_fifo() {
        fn permutations(values: &mut [usize], at: usize, output: &mut Vec<Vec<usize>>) {
            if at == values.len() {
                output.push(values.to_vec());
                return;
            }
            for index in at..values.len() {
                values.swap(at, index);
                permutations(values, at + 1, output);
                values.swap(at, index);
            }
        }

        let overhead = DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let capacity = 31 + 3 * overhead;
        let payloads = [11, 13, 17, 19];
        let mut order = [0, 1, 2, 3];
        let mut interleavings = Vec::new();
        permutations(&mut order, 0, &mut interleavings);

        for interleaving in interleavings {
            let mut buffer = DatagramBuffer::default();
            let mut accepted = Vec::new();
            for producer in interleaving {
                let payload_len = payloads[producer];
                if buffer.has_space_for(payload_len, capacity) {
                    buffer.push_back(datagram(producer as u8, payload_len));
                    accepted.push(producer as u8);
                } else {
                    let memory_before = buffer.memory_used();
                    let ids_before = buffer
                        .queue
                        .iter()
                        .map(|queued| queued.data[0])
                        .collect::<Vec<_>>();
                    assert!(!buffer.has_space_for(payload_len, capacity));
                    assert_eq!(buffer.memory_used(), memory_before);
                    assert_eq!(
                        buffer
                            .queue
                            .iter()
                            .map(|queued| queued.data[0])
                            .collect::<Vec<_>>(),
                        ids_before,
                    );
                }
            }
            assert_eq!(
                buffer
                    .queue
                    .iter()
                    .map(|queued| queued.data[0])
                    .collect::<Vec<_>>(),
                accepted,
            );
            assert!(buffer.memory_used() <= capacity);
        }
    }
}

/// Errors that can arise when sending a datagram
#[derive(Debug, Error, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum SendDatagramError {
    /// The peer does not support receiving datagram frames
    #[error("datagrams not supported by peer")]
    UnsupportedByPeer,
    /// Datagram support is disabled locally
    #[error("datagram support disabled")]
    Disabled,
    /// The datagram is larger than the connection can currently accommodate
    ///
    /// Indicates that the path MTU minus overhead or the limit advertised by the peer has been
    /// exceeded.
    #[error("datagram too large")]
    TooLarge,
    /// Send would block
    #[error("datagram send blocked")]
    Blocked(Bytes),
}
