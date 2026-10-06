use crate::SessionId;
use bytes::Buf;
use bytes::Bytes;
use std::ops::Deref;
use wtransport_proto::datagram::Datagram as H3Datagram;
use wtransport_proto::error::ErrorCode;
use wtransport_proto::ids::QStreamId;

/// An application Datagram.
#[derive(Debug)]
pub struct Datagram {
    quic_dgram: Bytes,
    payload_offset: usize,
    session_id: SessionId,
}

impl Datagram {
    /// Returns the datagram payload.
    #[inline(always)]
    pub fn payload(&self) -> Bytes {
        self.quic_dgram.slice(self.payload_offset..)
    }

    /// The datagram payload, taken without a reference-count round trip.
    #[inline(always)]
    pub(crate) fn into_payload(self) -> Bytes {
        let mut payload = self.quic_dgram;
        payload.advance(self.payload_offset);
        payload
    }

    pub(crate) fn read(quic_dgram: Bytes) -> Result<Self, ErrorCode> {
        let h3dgram = H3Datagram::read(&quic_dgram)?;
        let payload_offset = quic_dgram.len() - h3dgram.payload().len();
        let session_id = h3dgram.qstream_id().into_session_id();

        Ok(Self {
            quic_dgram,
            payload_offset,
            session_id,
        })
    }

    pub(crate) fn write(session_id: SessionId, payload: &[u8]) -> Self {
        let h3dgram = H3Datagram::new(QStreamId::from_session_id(session_id), payload);

        let mut buffer = vec![0; h3dgram.write_size()].into_boxed_slice();
        h3dgram.write(&mut buffer).expect("Preallocated capacity");

        let quic_dgram = Bytes::from(buffer);

        let payload_offset = quic_dgram.len() - payload.len();

        Self {
            quic_dgram,
            payload_offset,
            session_id,
        }
    }

    #[inline(always)]
    pub(crate) fn header_size(session_id: SessionId) -> usize {
        H3Datagram::header_size(QStreamId::from_session_id(session_id))
    }

    /// Returns the associated [`SessionId`].
    #[inline(always)]
    pub fn session_id(&self) -> SessionId {
        self.session_id
    }

    #[inline(always)]
    pub(crate) fn into_quic_bytes(self) -> Bytes {
        self.quic_dgram
    }
}

impl Deref for Datagram {
    type Target = [u8];

    #[inline(always)]
    fn deref(&self) -> &Self::Target {
        &self.quic_dgram[self.payload_offset..]
    }
}

/// Most datagrams one [`Connection::receive_datagrams`](crate::Connection::receive_datagrams)
/// returns. A resource bound: a batch lives inline, and this many small datagrams (input
/// ACKs, heartbeat pongs, header-only frames) fill a packet long before it runs out.
pub const DATAGRAM_BATCH_CAPACITY: usize = 8;

/// Most bytes a batch takes after its first datagram, which is taken whatever its size. A
/// resource bound: one Ethernet payload, more than any QUIC packet on a 1500-byte path carries,
/// so a batch that holds one received packet's datagrams holds no more than a packet.
pub const DATAGRAM_BATCH_MAX_BYTES: usize = 1500;

/// Datagram payloads one read took together, inline and in arrival order. The datagrams a
/// packet carried are received together, so they stay together through a relay that forwards
/// the batch as one unit.
#[derive(Clone, Debug, Default)]
pub struct DatagramBatch {
    payloads: [Bytes; DATAGRAM_BATCH_CAPACITY],
    len: usize,
}

impl DatagramBatch {
    /// A batch of one payload, as a relay that is handed one datagram forwards it.
    pub fn single(payload: Bytes) -> Self {
        let mut batch = Self::default();
        batch.push(payload);
        batch
    }

    /// The payloads, in arrival order.
    #[inline(always)]
    pub fn payloads(&self) -> &[Bytes] {
        &self.payloads[..self.len]
    }

    /// How many payloads the batch holds.
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether the batch holds no payload.
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Takes the payloads out in arrival order, leaving the batch empty, so a relay forwards
    /// each without a reference-count round trip.
    pub fn drain(&mut self) -> impl Iterator<Item = Bytes> + '_ {
        let len = std::mem::take(&mut self.len);
        self.payloads[..len].iter_mut().map(std::mem::take)
    }

    pub(crate) fn clear(&mut self) {
        for payload in &mut self.payloads[..self.len] {
            *payload = Bytes::new();
        }
        self.len = 0;
    }

    pub(crate) fn push(&mut self, payload: Bytes) {
        self.payloads[self.len] = payload;
        self.len += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::size_of;
    use wtransport_proto::ids::StreamId;
    use wtransport_proto::varint::VarInt;

    fn session_id(stream_id: u64) -> SessionId {
        SessionId::try_from_session_stream(StreamId::new(
            VarInt::try_from_u64(stream_id).expect("test stream id is a QUIC varint"),
        ))
        .expect("test stream is client-initiated and bidirectional")
    }

    #[test]
    fn reported_header_size_matches_every_varint_boundary() {
        // Session stream IDs are four times the HTTP/3 quarter-stream ID.
        for stream_id in [0, 4 * 63, 4 * 64, 4 * 16_383, 4 * 16_384] {
            let session_id = session_id(stream_id);
            for payload_len in [0, 1, 63, 64, 1_200] {
                let payload = vec![0xa5; payload_len];
                let encoded = Datagram::write(session_id, &payload).into_quic_bytes();
                assert_eq!(
                    encoded.len() - payload_len,
                    Datagram::header_size(session_id),
                    "stream_id={stream_id} payload_len={payload_len}",
                );
            }
        }
    }

    #[test]
    fn quinn_entry_charge_matches_the_vendored_datagram_layout() {
        assert_eq!(
            quinn_proto::DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD,
            size_of::<quinn_proto::Datagram>(),
        );
    }
}
