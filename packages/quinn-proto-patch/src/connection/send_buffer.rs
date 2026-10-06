use std::{collections::VecDeque, ops::Range};

use bytes::{Buf, Bytes};

use crate::{range_set::RangeSet, VarInt};

// Retain at most 256 bytes of segment handles when a stream drains (on 64-bit
// targets). Payloads still drop immediately. Persistent interactive streams
// should not free and reallocate their queue for every acknowledged record.
const RETAINED_SEGMENTS: usize = 8;

/// Buffer of outgoing retransmittable stream data
#[derive(Default, Debug)]
pub(super) struct SendBuffer {
    /// Data queued by the application but not yet acknowledged. May or may not have been sent.
    unacked_segments: VecDeque<Bytes>,
    /// Total size of `unacked_segments`
    unacked_len: usize,
    /// The first offset that hasn't been written by the application, i.e. the offset past the end of `unacked`
    offset: u64,
    /// The first offset that hasn't been sent
    ///
    /// Always lies in (offset - unacked.len())..offset
    unsent: u64,
    /// Acknowledged ranges which couldn't be discarded yet as they don't include the earliest
    /// offset in `unacked`
    // TODO: Recover storage from these by compacting (#700)
    acks: RangeSet,
    /// Previously transmitted ranges deemed lost
    retransmits: RangeSet,
}

impl SendBuffer {
    /// Construct an empty buffer at the initial offset
    pub(super) fn new() -> Self {
        Self::default()
    }

    /// Append application data to the end of the stream
    pub(super) fn write(&mut self, data: Bytes) {
        self.unacked_len += data.len();
        self.offset += data.len() as u64;
        self.unacked_segments.push_back(data);
    }

    /// Discard a range of acknowledged stream data, returning how many of its
    /// bytes were not acknowledged before
    ///
    /// A range is acknowledged twice when a packet declared lost is delivered
    /// after its retransmission left, and both are acknowledged.
    pub(super) fn ack(&mut self, mut range: Range<u64>) -> u64 {
        // Clamp the range to data which is still tracked
        let base_offset = self.offset - self.unacked_len as u64;
        range.start = base_offset.max(range.start);
        range.end = base_offset.max(range.end);

        let mut newly_acked = range.end - range.start;
        for acked in self.acks.iter() {
            newly_acked -= acked
                .end
                .min(range.end)
                .saturating_sub(acked.start.max(range.start));
        }
        // Acknowledged data queued for retransmission (declared lost, then
        // delivered after all) needs no retransmission.
        if !self.retransmits.is_empty() {
            self.retransmits.remove(range.clone());
        }
        self.acks.insert(range);

        while self.acks.min() == Some(self.offset - self.unacked_len as u64) {
            let prefix = self.acks.pop_min().unwrap();
            let mut to_advance = (prefix.end - prefix.start) as usize;

            self.unacked_len -= to_advance;
            if self.unacked_len == 0 {
                // A fully acknowledged burst needs no per-segment length walk.
                // Clear drops payload owners while retaining the queue storage.
                self.unacked_segments.clear();
                continue;
            }
            while to_advance > 0 {
                let front = self
                    .unacked_segments
                    .front_mut()
                    .expect("Expected buffered data");

                if front.len() <= to_advance {
                    to_advance -= front.len();
                    self.unacked_segments.pop_front();
                } else {
                    front.advance(to_advance);
                    to_advance = 0;
                }
            }
        }
        // Shrink once after the entire ACK, not once per discarded segment.
        // Large bursts return their excess capacity without cooling small lanes.
        if self.unacked_segments.capacity() > RETAINED_SEGMENTS
            && self.unacked_segments.len() < self.unacked_segments.capacity() / 4
        {
            self.unacked_segments.shrink_to(RETAINED_SEGMENTS);
        }
        newly_acked
    }

    /// Compute the next range to transmit on this stream and update state to account for that
    /// transmission.
    ///
    /// `max_len` here includes the space which is available to transmit the
    /// offset and length of the data to send. The caller has to guarantee that
    /// there is at least enough space available to write maximum-sized metadata
    /// (8 byte offset + 8 byte length).
    ///
    /// The method returns a tuple:
    /// - The first return value indicates the range of data to send
    /// - The second return value indicates whether the length needs to be encoded
    ///   in the STREAM frames metadata (`true`), or whether it can be omitted
    ///   since the selected range will fill the whole packet.
    pub(super) fn poll_transmit(&mut self, mut max_len: usize) -> (Range<u64>, bool) {
        debug_assert!(max_len >= 8 + 8);
        let mut encode_length = false;

        if let Some(range) = self.retransmits.pop_min() {
            // Retransmit sent data

            // When the offset is known, we know how many bytes are required to encode it.
            // Offset 0 requires no space
            if range.start != 0 {
                max_len -= VarInt::size(unsafe { VarInt::from_u64_unchecked(range.start) });
            }
            if range.end - range.start < max_len as u64 {
                encode_length = true;
                max_len -= 8;
            }

            let end = range.end.min((max_len as u64).saturating_add(range.start));
            if end != range.end {
                self.retransmits.insert(end..range.end);
            }
            return (range.start..end, encode_length);
        }

        // Transmit new data

        // When the offset is known, we know how many bytes are required to encode it.
        // Offset 0 requires no space
        if self.unsent != 0 {
            max_len -= VarInt::size(unsafe { VarInt::from_u64_unchecked(self.unsent) });
        }
        if self.offset - self.unsent < max_len as u64 {
            encode_length = true;
            max_len -= 8;
        }

        let end = self
            .offset
            .min((max_len as u64).saturating_add(self.unsent));
        let result = self.unsent..end;
        self.unsent = end;
        (result, encode_length)
    }

    /// Returns data which is associated with a range
    ///
    /// This function can return a subset of the range, if the data is stored
    /// in noncontiguous fashion in the send buffer. In this case callers
    /// should call the function again with an incremented start offset to
    /// retrieve more data.
    pub(super) fn get(&self, offsets: Range<u64>) -> &[u8] {
        let base_offset = self.offset - self.unacked_len as u64;

        let mut segment_offset = base_offset;
        for segment in self.unacked_segments.iter() {
            if offsets.start >= segment_offset
                && offsets.start < segment_offset + segment.len() as u64
            {
                let start = (offsets.start - segment_offset) as usize;
                let end = (offsets.end - segment_offset) as usize;

                return &segment[start..end.min(segment.len())];
            }
            segment_offset += segment.len() as u64;
        }

        &[]
    }

    /// Queue a range of sent data to be retransmitted, less what is already acknowledged
    ///
    /// A packet declared lost can be delivered after all and acknowledged while its
    /// retransmission is in flight; if that retransmission is then lost, its data is
    /// acknowledged, possibly already discarded, and must not be sent again.
    pub(super) fn retransmit(&mut self, range: Range<u64>) {
        debug_assert!(range.end <= self.unsent, "unsent data can't be lost");
        let base_offset = self.offset - self.unacked_len as u64;
        let range = base_offset.max(range.start)..range.end;
        if range.is_empty() {
            return;
        }
        self.retransmits.insert(range.clone());
        for acked in self.acks.iter() {
            if acked.start < range.end && range.start < acked.end {
                self.retransmits
                    .remove(acked.start.max(range.start)..acked.end.min(range.end));
            }
        }
    }

    pub(super) fn retransmit_all_for_0rtt(&mut self) {
        debug_assert_eq!(self.offset, self.unacked_len as u64);
        self.unsent = 0;
    }

    /// First stream offset unwritten by the application, i.e. the offset that the next write will
    /// begin at
    pub(super) fn offset(&self) -> u64 {
        self.offset
    }

    /// Whether all sent data has been acknowledged
    pub(super) fn is_fully_acked(&self) -> bool {
        self.unacked_len == 0
    }

    /// Whether there's data to send
    ///
    /// There may be sent unacknowledged data even when this is false.
    pub(super) fn has_unsent_data(&self) -> bool {
        self.unsent != self.offset || !self.retransmits.is_empty()
    }

    /// Bytes waiting to be sent: new data, and data queued for retransmission
    pub(super) fn unsent_len(&self) -> u64 {
        self.offset - self.unsent
            + self
                .retransmits
                .iter()
                .map(|range| range.end - range.start)
                .sum::<u64>()
    }

    /// Compute the amount of data that hasn't been acknowledged
    pub(super) fn unacked(&self) -> u64 {
        self.unacked_len as u64 - self.acks.iter().map(|x| x.end - x.start).sum::<u64>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exact pre-retention ACK loop, only for the paired benchmark below.
    fn ack_shrinking(buf: &mut SendBuffer, mut range: Range<u64>) {
        let base = buf.offset - buf.unacked_len as u64;
        range.start = base.max(range.start);
        range.end = base.max(range.end);
        buf.acks.insert(range);
        while buf.acks.min() == Some(buf.offset - buf.unacked_len as u64) {
            let prefix = buf.acks.pop_min().unwrap();
            let mut advance = (prefix.end - prefix.start) as usize;
            buf.unacked_len -= advance;
            while advance > 0 {
                let front = buf.unacked_segments.front_mut().unwrap();
                if front.len() <= advance {
                    advance -= front.len();
                    buf.unacked_segments.pop_front();
                    if buf.unacked_segments.len() * 4 < buf.unacked_segments.capacity() {
                        buf.unacked_segments.shrink_to_fit();
                    }
                } else {
                    front.advance(advance);
                    advance = 0;
                }
            }
        }
    }

    #[test]
    fn acknowledged_data_queued_for_retransmission_is_not_retransmitted() {
        let mut buf = SendBuffer::new();
        buf.write(Bytes::from_static(b"0123456789"));
        assert_eq!(buf.poll_transmit(100).0, 0..10);
        buf.write(Bytes::from_static(b"abc"));
        buf.retransmit(0..10);
        assert_eq!(buf.ack(0..10), 10);
        // Only the new data is left to send, and a second ACK counts nothing.
        assert_eq!(buf.poll_transmit(100).0, 10..13);
        assert!(!buf.has_unsent_data());
        assert_eq!(buf.ack(0..10), 0);
        assert_eq!(buf.ack(10..13), 3);
        assert!(buf.is_fully_acked());
    }

    #[test]
    fn a_lost_retransmission_of_acknowledged_data_queues_nothing() {
        let mut buf = SendBuffer::new();
        buf.write(Bytes::from_static(b"0123456789"));
        assert_eq!(buf.poll_transmit(100).0, 0..10);
        // Declared lost, retransmitted...
        buf.retransmit(0..10);
        assert_eq!(buf.poll_transmit(100).0, 0..10);
        // ...the original delivered after all, then the retransmission lost.
        assert_eq!(buf.ack(0..10), 10);
        buf.retransmit(0..10);
        assert!(!buf.has_unsent_data());
        buf.write(Bytes::from_static(b"abc"));
        assert_eq!(buf.poll_transmit(100).0, 10..13);
    }

    #[test]
    #[ignore = "paired release-mode persistent-stream queue profile"]
    fn retained_segments_profile() {
        use std::{hint::black_box, time::Instant};
        const CALLS: usize = 10_000;
        for segments in [1, 4, 8, 32, 256] {
            let mut retained = SendBuffer::new();
            let mut shrinking = SendBuffer::new();
            let batch = |buf: &mut SendBuffer, keep: bool| {
                let start = buf.offset();
                for _ in 0..segments {
                    buf.write(black_box(Bytes::from_static(b"persistent stream record")));
                }
                let end = buf.offset();
                black_box(buf.get(start..end));
                if keep {
                    buf.ack(start..end);
                } else {
                    ack_shrinking(buf, start..end);
                }
                assert!(buf.is_fully_acked());
            };
            for _ in 0..1000 {
                batch(&mut retained, true);
                batch(&mut shrinking, false);
            }
            for round in 0..12 {
                for keep in if round % 2 == 0 {
                    [false, true, true, false]
                } else {
                    [true, false, false, true]
                } {
                    let buf = if keep { &mut retained } else { &mut shrinking };
                    let started = Instant::now();
                    for _ in 0..CALLS {
                        batch(buf, keep);
                    }
                    println!("queue-time segments={segments} retained={keep} round={round} ns={} idle_capacity={}", started.elapsed().as_nanos() / CALLS as u128, buf.unacked_segments.capacity());
                }
            }
        }
    }

    #[test]
    fn small_bursts_reuse_segment_storage_and_large_bursts_release_excess() {
        let mut buf = SendBuffer::new();
        for _ in 0..RETAINED_SEGMENTS {
            buf.write(Bytes::from_static(b"record"));
        }
        let capacity = buf.unacked_segments.capacity();
        let pointer = buf.unacked_segments.as_slices().0.as_ptr();
        buf.ack(0..buf.offset());
        for _ in 0..1024 {
            let start = buf.offset();
            for _ in 0..RETAINED_SEGMENTS {
                buf.write(Bytes::from_static(b"record"));
            }
            assert_eq!(buf.unacked_segments.capacity(), capacity);
            assert_eq!(buf.unacked_segments.as_slices().0.as_ptr(), pointer);
            buf.ack(start..buf.offset());
            assert!(buf.is_fully_acked());
            assert_eq!(buf.unacked_segments.capacity(), capacity);
        }
        let start = buf.offset();
        for _ in 0..4096 {
            buf.write(Bytes::from_static(b"record"));
        }
        buf.ack(start + 6..buf.offset());
        assert_eq!(buf.get(start..start + 6), b"record");
        buf.ack(start..start + 6);
        assert!(buf.is_fully_acked());
        assert_eq!(buf.unacked_segments.capacity(), RETAINED_SEGMENTS);
    }

    #[test]
    fn fragment_with_length() {
        let mut buf = SendBuffer::new();
        const MSG: &[u8] = b"Hello, world!";
        buf.write(MSG.into());
        // 0 byte offset => 19 bytes left => 13 byte data isn't enough
        // with 8 bytes reserved for length 11 payload bytes will fit
        assert_eq!(buf.poll_transmit(19), (0..11, true));
        assert_eq!(
            buf.poll_transmit(MSG.len() + 16 - 11),
            (11..MSG.len() as u64, true)
        );
        assert_eq!(
            buf.poll_transmit(58),
            (MSG.len() as u64..MSG.len() as u64, true)
        );
    }

    #[test]
    fn fragment_without_length() {
        let mut buf = SendBuffer::new();
        const MSG: &[u8] = b"Hello, world with some extra data!";
        buf.write(MSG.into());
        // 0 byte offset => 19 bytes left => can be filled by 34 bytes payload
        assert_eq!(buf.poll_transmit(19), (0..19, false));
        assert_eq!(
            buf.poll_transmit(MSG.len() - 19 + 1),
            (19..MSG.len() as u64, false)
        );
        assert_eq!(
            buf.poll_transmit(58),
            (MSG.len() as u64..MSG.len() as u64, true)
        );
    }

    #[test]
    fn reserves_encoded_offset() {
        let mut buf = SendBuffer::new();

        // Pretend we have more than 1 GB of data in the buffer
        let chunk: Bytes = Bytes::from_static(&[0; 1024 * 1024]);
        for _ in 0..1025 {
            buf.write(chunk.clone());
        }

        const SIZE1: u64 = 64;
        const SIZE2: u64 = 16 * 1024;
        const SIZE3: u64 = 1024 * 1024 * 1024;

        // Offset 0 requires no space
        assert_eq!(buf.poll_transmit(16), (0..16, false));
        buf.retransmit(0..16);
        assert_eq!(buf.poll_transmit(16), (0..16, false));
        let mut transmitted = 16u64;

        // Offset 16 requires 1 byte
        assert_eq!(
            buf.poll_transmit((SIZE1 - transmitted + 1) as usize),
            (transmitted..SIZE1, false)
        );
        buf.retransmit(transmitted..SIZE1);
        assert_eq!(
            buf.poll_transmit((SIZE1 - transmitted + 1) as usize),
            (transmitted..SIZE1, false)
        );
        transmitted = SIZE1;

        // Offset 64 requires 2 bytes
        assert_eq!(
            buf.poll_transmit((SIZE2 - transmitted + 2) as usize),
            (transmitted..SIZE2, false)
        );
        buf.retransmit(transmitted..SIZE2);
        assert_eq!(
            buf.poll_transmit((SIZE2 - transmitted + 2) as usize),
            (transmitted..SIZE2, false)
        );
        transmitted = SIZE2;

        // Offset 16384 requires requires 4 bytes
        assert_eq!(
            buf.poll_transmit((SIZE3 - transmitted + 4) as usize),
            (transmitted..SIZE3, false)
        );
        buf.retransmit(transmitted..SIZE3);
        assert_eq!(
            buf.poll_transmit((SIZE3 - transmitted + 4) as usize),
            (transmitted..SIZE3, false)
        );
        transmitted = SIZE3;

        // Offset 1GB requires 8 bytes
        assert_eq!(
            buf.poll_transmit(chunk.len() + 8),
            (transmitted..transmitted + chunk.len() as u64, false)
        );
        buf.retransmit(transmitted..transmitted + chunk.len() as u64);
        assert_eq!(
            buf.poll_transmit(chunk.len() + 8),
            (transmitted..transmitted + chunk.len() as u64, false)
        );
    }

    #[test]
    fn multiple_segments() {
        let mut buf = SendBuffer::new();
        const MSG: &[u8] = b"Hello, world!";
        const MSG_LEN: u64 = MSG.len() as u64;

        const SEG1: &[u8] = b"He";
        buf.write(SEG1.into());
        const SEG2: &[u8] = b"llo,";
        buf.write(SEG2.into());
        const SEG3: &[u8] = b" w";
        buf.write(SEG3.into());
        const SEG4: &[u8] = b"o";
        buf.write(SEG4.into());
        const SEG5: &[u8] = b"rld!";
        buf.write(SEG5.into());

        assert_eq!(aggregate_unacked(&buf), MSG);

        assert_eq!(buf.poll_transmit(16), (0..8, true));
        assert_eq!(buf.get(0..5), SEG1);
        assert_eq!(buf.get(2..8), SEG2);
        assert_eq!(buf.get(6..8), SEG3);

        assert_eq!(buf.poll_transmit(16), (8..MSG_LEN, true));
        assert_eq!(buf.get(8..MSG_LEN), SEG4);
        assert_eq!(buf.get(9..MSG_LEN), SEG5);

        assert_eq!(buf.poll_transmit(42), (MSG_LEN..MSG_LEN, true));

        // Now drain the segments
        buf.ack(0..1);
        assert_eq!(aggregate_unacked(&buf), &MSG[1..]);
        buf.ack(0..3);
        assert_eq!(aggregate_unacked(&buf), &MSG[3..]);
        buf.ack(3..5);
        assert_eq!(aggregate_unacked(&buf), &MSG[5..]);
        buf.ack(7..9);
        assert_eq!(aggregate_unacked(&buf), &MSG[5..]);
        buf.ack(4..7);
        assert_eq!(aggregate_unacked(&buf), &MSG[9..]);
        buf.ack(0..MSG_LEN);
        assert_eq!(aggregate_unacked(&buf), &[] as &[u8]);
    }

    #[test]
    fn retransmit() {
        let mut buf = SendBuffer::new();
        const MSG: &[u8] = b"Hello, world with extra data!";
        buf.write(MSG.into());
        // Transmit two frames
        assert_eq!(buf.poll_transmit(16), (0..16, false));
        assert_eq!(buf.poll_transmit(16), (16..23, true));
        // Lose the first, but not the second
        buf.retransmit(0..16);
        // Ensure we only retransmit the lost frame, then continue sending fresh data
        assert_eq!(buf.poll_transmit(16), (0..16, false));
        assert_eq!(buf.poll_transmit(16), (23..MSG.len() as u64, true));
        // Lose the second frame
        buf.retransmit(16..23);
        assert_eq!(buf.poll_transmit(16), (16..23, true));
    }

    #[test]
    fn ack() {
        let mut buf = SendBuffer::new();
        const MSG: &[u8] = b"Hello, world!";
        buf.write(MSG.into());
        assert_eq!(buf.poll_transmit(16), (0..8, true));
        buf.ack(0..8);
        assert_eq!(aggregate_unacked(&buf), &MSG[8..]);
    }

    #[test]
    fn reordered_ack() {
        let mut buf = SendBuffer::new();
        const MSG: &[u8] = b"Hello, world with extra data!";
        buf.write(MSG.into());
        assert_eq!(buf.poll_transmit(16), (0..16, false));
        assert_eq!(buf.poll_transmit(16), (16..23, true));
        buf.ack(16..23);
        assert_eq!(aggregate_unacked(&buf), MSG);
        buf.ack(0..16);
        assert_eq!(aggregate_unacked(&buf), &MSG[23..]);
        assert!(buf.acks.is_empty());
    }

    fn aggregate_unacked(buf: &SendBuffer) -> Vec<u8> {
        let mut result = Vec::new();
        for segment in buf.unacked_segments.iter() {
            result.extend_from_slice(&segment[..]);
        }
        result
    }
}
