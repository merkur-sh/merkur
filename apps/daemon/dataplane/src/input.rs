//! Lossless, bounded admission of reliable input. A carrier reader lends one
//! record at a time; its local permit stays with any unadmitted plaintext suffix.
//! Parsing/validation happens once. Resumption advances a cursor, not a frame
//! decoder, and no network acknowledgement is owed until the PTY write completes.

// A latency path: input waits on the event itself, never on a clock. `clippy.toml` lists the
// timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

use std::time::Instant;
use tokio::sync::OwnedSemaphorePermit;

use crate::connection::{PeerDisplayState, PeerTransport, seq_lt};
use crate::network::peer::{MAX_INBOUND_FRAME_BYTES, PeerMessage};
use crate::network::protocol::{
    MSG_TYPE_INPUT_RUN, MSG_TYPE_SEQUENCED_KEYSTROKE, PROTO_HEADER_BYTES, decode_proto_frame,
    parse_input_run,
};

/// Fully validated input frame, with the current entry's bounds already decoded.
/// All offsets refer to the original immutable plaintext; no self-reference.
#[derive(Clone, Copy, Debug)]
pub(crate) struct InputCursor {
    seq: u32,
    start: usize,
    end: usize,
    remaining: u8,
    index: u8,
    shadow_offset: usize,
    pub(crate) retransmit: bool,
    /// The liveness probe token the run carried, answered on arrival.
    pub(crate) probe: Option<u64>,
}

impl InputCursor {
    pub(crate) fn parse(frame: &[u8]) -> Option<Self> {
        if frame.len() > MAX_INBOUND_FRAME_BYTES {
            return None;
        }
        let (kind, body) = decode_proto_frame(frame)?;
        match kind {
            MSG_TYPE_INPUT_RUN => {
                // This validates the ENTIRE run before any input can be admitted.
                let (header, _) = parse_input_run(body)?;
                let count = header.count;
                let shadow_offset = PROTO_HEADER_BYTES + header.shadow_offset;
                let entry = shadow_offset + usize::from(count).div_ceil(8);
                let (start, end) = if count == 0 {
                    (entry, entry)
                } else {
                    let length = usize::from(u16::from_be_bytes([frame[entry], frame[entry + 1]]));
                    (entry + 2, entry + 2 + length)
                };
                Some(Self {
                    seq: header.base_seq,
                    start,
                    end,
                    remaining: count,
                    index: 0,
                    shadow_offset,
                    retransmit: header.retransmit,
                    probe: header.probe,
                })
            }
            MSG_TYPE_SEQUENCED_KEYSTROKE => {
                let (seq, record) = body.split_first_chunk::<4>()?;
                // One rule on both lanes: the datagram lane validates this
                // record before it queues it, and a run validates every entry.
                // An unvalidated one would take a FIFO slot and be acknowledged.
                if !crate::network::input_record::validate(record) {
                    return None;
                }
                Some(Self {
                    seq: u32::from_be_bytes(*seq),
                    start: PROTO_HEADER_BYTES + 4,
                    end: frame.len(),
                    remaining: 1,
                    index: 0,
                    shadow_offset: 0,
                    retransmit: false,
                    probe: None,
                })
            }
            _ => None,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.remaining == 0
    }

    fn current<'a>(&self, frame: &'a [u8]) -> (u32, &'a [u8], bool) {
        let modelled = self.shadow_offset != 0
            && frame[self.shadow_offset + usize::from(self.index / 8)] & (1 << (self.index % 8))
                != 0;
        (self.seq, &frame[self.start..self.end], modelled)
    }

    fn advance(&mut self, frame: &[u8]) {
        self.remaining -= 1;
        self.seq = self.seq.wrapping_add(1);
        if self.remaining == 0 {
            return;
        }
        self.index += 1;
        let length = usize::from(u16::from_be_bytes([frame[self.end], frame[self.end + 1]]));
        self.start = self.end + 2;
        self.end = self.start + length;
    }
}

/// Reuse the production sequence/FIFO state machine. Future reliable input stays
/// in its record instead of allocating a reorder entry or overflowing that map.
/// The other carrier can fill a gap without being blocked by this reader.
pub(crate) fn admit_reliable<F>(
    peer: &mut PeerDisplayState,
    cursor: &mut InputCursor,
    frame: &[u8],
    origin: InputOrigin,
    enqueue: &mut F,
) -> bool
where
    F: FnMut(InputOrigin, u32, &[u8], bool) -> bool,
{
    let mut advanced = false;
    while !cursor.is_empty() {
        let (seq, bytes, modelled) = cursor.current(frame);
        if seq_lt(seq, peer.keystroke_next_queued_seq) {
            cursor.advance(frame);
            continue;
        }
        if seq != peer.keystroke_next_queued_seq {
            break;
        }
        let applied = peer.apply_keystroke(seq, bytes, modelled, &mut |seq, bytes, modelled| {
            enqueue(origin, seq, bytes, modelled)
        });
        if !applied.advanced {
            break;
        }
        advanced = true;
        cursor.advance(frame);
    }
    advanced
}

#[derive(Clone, Copy)]
pub(crate) struct InputOrigin {
    pub(crate) via: PeerTransport,
    pub(crate) received_at: Option<Instant>,
    pub(crate) observation_epoch: Option<u32>,
}

struct PendingInput {
    cursor: InputCursor,
    origin: InputOrigin,
    connection_id: u64,
    _permit: Option<OwnedSemaphorePermit>,
}

#[derive(Default)]
struct InputSlot {
    bytes: Vec<u8>,
    pending: Option<PendingInput>,
}

/// One fixed slot per physical input lane: direct, interactive edge, bulk edge.
/// A reader cannot lend a second record until the first returns its permit.
/// Bulk input is normally unused, but it must obey the same bound if received.
#[derive(Default)]
pub(crate) struct ReliableInputs {
    slots: [InputSlot; 3],
    pending_mask: u8,
}

impl ReliableInputs {
    pub(crate) fn new() -> Self {
        Self {
            pending_mask: 0,
            slots: std::array::from_fn(|_| InputSlot {
                // Cold peer setup, not first backpressure: buffer swaps and resumed
                // opens remain allocation-free even on the first blocked key.
                bytes: vec![0; MAX_INBOUND_FRAME_BYTES],
                pending: None,
            }),
        }
    }

    pub(crate) fn has_pending(&self) -> bool {
        self.pending_mask != 0
    }

    pub(crate) fn clear(&mut self) {
        for slot in &mut self.slots {
            slot.pending = None;
        }
        self.pending_mask = 0;
    }

    pub(crate) fn retain(
        &mut self,
        msg: &mut PeerMessage,
        cursor: InputCursor,
        origin: InputOrigin,
        plaintext: &mut Vec<u8>,
    ) {
        let index = match msg.via_transport {
            PeerTransport::WebTransport => 0,
            PeerTransport::Edge
                if msg.edge_ingress.as_ref().is_some_and(|ingress| {
                    ingress.lane == crate::network::protocol::EdgeLane::Bulk
                }) =>
            {
                2
            }
            PeerTransport::Edge => 1,
        };
        let slot = &mut self.slots[index];
        // One reader's overlap is structurally forbidden by its read permit.
        // A reader is its own credit, not its connection id: every reader on
        // an edge tunnel stamps the tunnel's generation, and a replacement
        // browser attachment brings a new reader, with new credit, onto the
        // same tunnel. A replacement carrier or reader replays the browser's
        // unacknowledged prefix, so the record it displaces here, never
        // acknowledged, arrives again; already queued/completed input keeps
        // its existing sequence ownership.
        assert!(
            slot.pending.as_ref().is_none_or(|pending| {
                match (&pending._permit, &msg.input_permit) {
                    (Some(held), Some(lent)) => {
                        !std::sync::Arc::ptr_eq(held.semaphore(), lent.semaphore())
                    }
                    _ => pending.connection_id != msg.connection_id,
                }
            }),
            "a reliable reader lent a second unadmitted input record"
        );
        slot.pending = Some(PendingInput {
            cursor,
            origin,
            connection_id: msg.connection_id,
            _permit: msg.input_permit.take(),
        });
        self.pending_mask |= 1 << index;
        std::mem::swap(&mut slot.bytes, plaintext);
    }
}

/// Cold/pressure path only. Temporarily move the three slot owners out so the
/// sequencer and the borrowed plaintext are disjoint without unsafe aliasing.
/// `Default` contains empty Vecs; this move never allocates or copies payloads.
pub(crate) fn drain_reliable<F>(peer: &mut PeerDisplayState, enqueue: &mut F)
where
    F: FnMut(InputOrigin, u32, &[u8], bool) -> bool,
{
    if !peer.reliable_inputs.has_pending() {
        return;
    }
    let mut inputs = std::mem::take(&mut peer.reliable_inputs);
    if let Some(pending) = inputs.slots.iter().find_map(|slot| slot.pending.as_ref()) {
        let origin = InputOrigin {
            received_at: None,
            observation_epoch: None,
            ..pending.origin
        };
        peer.drain_keystroke_reorder(&mut |seq, bytes, modelled| {
            enqueue(origin, seq, bytes, modelled)
        });
    }
    for (index, slot) in inputs.slots.iter_mut().enumerate() {
        let Some(pending) = slot.pending.as_mut() else {
            continue;
        };
        admit_reliable(
            peer,
            &mut pending.cursor,
            &slot.bytes,
            pending.origin,
            enqueue,
        );
        if pending.cursor.is_empty() {
            slot.pending = None;
            inputs.pending_mask &= !(1 << index);
        }
    }
    peer.reliable_inputs = inputs;
}

/// Owner-loop scheduling evidence, independent of network ACKs or timers.
#[derive(Default)]
pub(crate) struct InputRefill {
    pub(crate) pending: bool,
    pub(crate) next_peer: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::input_record::build;

    /// Sequencing never looks inside a record; each entry is the text record of its text.
    fn rec(text: &str) -> Vec<u8> {
        build::text(text)
    }
    use crate::connection::PeerMap;
    use crate::network::peer::DeliveryMode;
    use crate::network::protocol::{CHANNEL_PTY, encode_input_run, encode_proto_frame};
    use crate::perf_timing::PerfTimingTracker;
    use crate::pty::{MAX_QUEUED_USER_PTY_BYTES, PtyWriter, TerminalState};
    use crate::session::resume::ParkedPeers;
    use std::io::{self, Write};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;
    use tokio::sync::Semaphore;

    fn origin(via: PeerTransport) -> InputOrigin {
        InputOrigin {
            via,
            received_at: None,
            observation_epoch: None,
        }
    }

    fn message(via: PeerTransport, connection_id: u64, credit: &Arc<Semaphore>) -> PeerMessage {
        PeerMessage {
            input_permit: Some(Arc::clone(credit).try_acquire_owned().unwrap()),
            peer_node_id: Arc::from("peer"),
            channel_id: CHANNEL_PTY,
            payload: bytes::Bytes::new(),
            via_transport: via,
            delivery: DeliveryMode::Stream,
            connection_id,
            edge_ingress: None,
        }
    }

    #[test]
    fn refused_suffix_moves_its_buffer_and_resumes_exactly_once_on_credit() {
        let mut peer = PeerDisplayState::new("peer".into(), PeerTransport::WebTransport);
        let mut bytes = encode_input_run(
            1,
            false,
            &[
                (&rec("a")[..], true),
                (&rec("é")[..], true),
                (&rec("\r")[..], false),
            ],
        );
        let ptr = bytes.as_ptr();
        let mut cursor = InputCursor::parse(&bytes).unwrap();
        let mut writes = Vec::new();
        let mut room = 1;
        let mut accept = |_: InputOrigin, seq, bytes: &[u8], modelled| {
            if room == 0 {
                return false;
            }
            room -= 1;
            writes.push((seq, bytes.to_vec(), modelled));
            true
        };
        assert!(admit_reliable(
            &mut peer,
            &mut cursor,
            &bytes,
            origin(PeerTransport::WebTransport),
            &mut accept
        ));
        assert_eq!(
            peer.keystroke_next_expected_seq, 1,
            "admission is not confirmation"
        );
        let credit = Arc::new(Semaphore::new(1));
        let mut msg = message(PeerTransport::WebTransport, 1, &credit);
        peer.reliable_inputs.retain(
            &mut msg,
            cursor,
            origin(PeerTransport::WebTransport),
            &mut bytes,
        );
        assert_eq!(
            peer.reliable_inputs.slots[0].bytes.as_ptr(),
            ptr,
            "move, no plaintext copy"
        );
        assert_eq!(credit.available_permits(), 0);
        assert_eq!(peer.confirm_keystroke_delivery(1), Some(1));
        for next in [2, 3] {
            let mut room = 1;
            drain_reliable(&mut peer, &mut |_, seq, bytes, modelled| {
                if room == 0 {
                    return false;
                }
                room -= 1;
                writes.push((seq, bytes.to_vec(), modelled));
                true
            });
            assert_eq!(peer.confirm_keystroke_delivery(next), Some(next));
        }
        assert_eq!(
            writes,
            vec![
                (1, rec("a"), true),
                (2, rec("é"), true),
                (3, rec("\r"), false)
            ]
        );
        assert!(!peer.reliable_inputs.has_pending());
        assert_eq!(credit.available_permits(), 1);
        let duplicate = encode_input_run(
            1,
            false,
            &[
                (&rec("a")[..], true),
                (&rec("é")[..], true),
                (&rec("\r")[..], false),
            ],
        );
        let mut cursor = InputCursor::parse(&duplicate).unwrap();
        assert!(!admit_reliable(
            &mut peer,
            &mut cursor,
            &duplicate,
            origin(PeerTransport::Edge),
            &mut |_, _, _, _| panic!("duplicate write")
        ));
        assert!(cursor.is_empty());
    }

    #[test]
    fn another_carrier_fills_a_gap_without_allocating_reorder_entries() {
        let mut peer = PeerDisplayState::new("peer".into(), PeerTransport::WebTransport);
        let mut later = encode_input_run(3, false, &[(&rec("c")[..], false)]);
        let mut cursor = InputCursor::parse(&later).unwrap();
        assert!(!admit_reliable(
            &mut peer,
            &mut cursor,
            &later,
            origin(PeerTransport::WebTransport),
            &mut |_, _, _, _| panic!("skip gap")
        ));
        let credit = Arc::new(Semaphore::new(1));
        let mut msg = message(PeerTransport::WebTransport, 1, &credit);
        peer.reliable_inputs.retain(
            &mut msg,
            cursor,
            origin(PeerTransport::WebTransport),
            &mut later,
        );
        assert!(peer.keystroke_reorder_buf.is_empty());
        let earlier = encode_input_run(1, false, &[(&rec("a")[..], false), (&rec("b")[..], false)]);
        let mut cursor = InputCursor::parse(&earlier).unwrap();
        let mut written = Vec::new();
        let mut accept = |_: InputOrigin, seq, _: &[u8], _| {
            written.push(seq);
            true
        };
        admit_reliable(
            &mut peer,
            &mut cursor,
            &earlier,
            origin(PeerTransport::Edge),
            &mut accept,
        );
        drain_reliable(&mut peer, &mut accept);
        assert_eq!(written, [1, 2, 3]);
        assert_eq!(credit.available_permits(), 1);
    }

    #[test]
    fn malformed_and_oversized_records_never_create_a_cursor() {
        let mut run = encode_input_run(1, false, &[(&rec("a")[..], false), (&rec("b")[..], false)]);
        run[PROTO_HEADER_BYTES + 5] = 0x80;
        assert!(InputCursor::parse(&run).is_none());
        run[PROTO_HEADER_BYTES + 5] = 0;
        run.pop();
        assert!(InputCursor::parse(&run).is_none());
        let oversized = encode_proto_frame(
            MSG_TYPE_SEQUENCED_KEYSTROKE,
            &vec![0; MAX_INBOUND_FRAME_BYTES],
        );
        assert!(InputCursor::parse(&oversized).is_none());
    }

    /// The reliable PTY lane applies the record rule the datagram lane and an
    /// input run apply: a keystroke that is no canonical record is refused
    /// before it can take a FIFO slot or be acknowledged.
    #[test]
    fn a_malformed_sequenced_keystroke_creates_no_cursor() {
        let keystroke = |record: &[u8]| {
            let mut body = 7u32.to_be_bytes().to_vec();
            body.extend_from_slice(record);
            encode_proto_frame(MSG_TYPE_SEQUENCED_KEYSTROKE, &body)
        };
        let cursor = InputCursor::parse(&keystroke(&rec("a"))).expect("a canonical record");
        assert_eq!((cursor.seq, cursor.remaining), (7, 1));
        let malformed: [&[u8]; 5] = [
            // No record at all, a reserved kind, a control character that must
            // be named by its functional key, truncated UTF-8, trailing bytes.
            &[],
            &[0xe0],
            &[0x00, 0x0d],
            &[2 << 5, 0xc3],
            &[0x00, b'a', b'b'],
        ];
        for record in malformed {
            assert!(
                InputCursor::parse(&keystroke(record)).is_none(),
                "{record:02x?} created a cursor"
            );
        }
        // A sequence number cut short is no keystroke either.
        let truncated = encode_proto_frame(MSG_TYPE_SEQUENCED_KEYSTROKE, &[0, 0, 7]);
        assert!(InputCursor::parse(&truncated).is_none());
    }

    #[test]
    fn successor_clear_releases_credit_without_advancing_input_or_replaying_old_provenance() {
        let mut peer = PeerDisplayState::new("peer".into(), PeerTransport::WebTransport);
        let mut bytes = encode_input_run(1, false, &[(&rec("a")[..], true)]);
        let cursor = InputCursor::parse(&bytes).unwrap();
        let credit = Arc::new(Semaphore::new(1));
        let mut msg = message(PeerTransport::WebTransport, 1, &credit);
        peer.reliable_inputs.retain(
            &mut msg,
            cursor,
            origin(PeerTransport::WebTransport),
            &mut bytes,
        );
        peer.reliable_inputs.clear();
        assert_eq!(credit.available_permits(), 1);
        assert_eq!(peer.keystroke_next_queued_seq, 1);
        assert_eq!(peer.keystroke_next_expected_seq, 1);
        drain_reliable(&mut peer, &mut |_, _, _, _| {
            panic!("old provenance survived")
        });
    }

    /// Every reader on one edge tunnel stamps the tunnel's generation as its
    /// connection id. A replacement browser attachment starts a new reader,
    /// with its own credit, on that same tunnel while the displaced reader's
    /// last record still waits here for the PTY.
    #[test]
    fn a_replacement_reader_on_one_edge_tunnel_takes_the_slot_without_losing_or_repeating_input() {
        const TUNNEL_GENERATION: u64 = 7;
        let mut peer = PeerDisplayState::new("peer".into(), PeerTransport::Edge);
        let mut writes = Vec::new();

        // The first attachment lends 1..=3; the FIFO takes 1 and is full.
        let mut lent = encode_input_run(
            1,
            false,
            &[
                (&rec("a")[..], false),
                (&rec("b")[..], false),
                (&rec("c")[..], false),
            ],
        );
        let mut cursor = InputCursor::parse(&lent).unwrap();
        let mut room = 1;
        assert!(admit_reliable(
            &mut peer,
            &mut cursor,
            &lent,
            origin(PeerTransport::Edge),
            &mut |_, seq, bytes: &[u8], _| {
                if room == 0 {
                    return false;
                }
                room -= 1;
                writes.push((seq, bytes.to_vec()));
                true
            },
        ));
        let displaced = Arc::new(Semaphore::new(1));
        let mut msg = message(PeerTransport::Edge, TUNNEL_GENERATION, &displaced);
        peer.reliable_inputs
            .retain(&mut msg, cursor, origin(PeerTransport::Edge), &mut lent);
        assert_eq!(displaced.available_permits(), 0);

        // Nothing is acknowledged before the PTY write completes, so the
        // replacement attachment replays 1..=3 and sends 4 behind them. The
        // FIFO is still full: its record waits too, on the same tunnel.
        let mut replayed = encode_input_run(
            1,
            false,
            &[
                (&rec("a")[..], false),
                (&rec("b")[..], false),
                (&rec("c")[..], false),
                (&rec("d")[..], false),
            ],
        );
        let mut cursor = InputCursor::parse(&replayed).unwrap();
        assert!(!admit_reliable(
            &mut peer,
            &mut cursor,
            &replayed,
            origin(PeerTransport::Edge),
            &mut |_, _, _, _| false,
        ));
        let replacement = Arc::new(Semaphore::new(1));
        let mut msg = message(PeerTransport::Edge, TUNNEL_GENERATION, &replacement);
        peer.reliable_inputs
            .retain(&mut msg, cursor, origin(PeerTransport::Edge), &mut replayed);
        assert_eq!(
            displaced.available_permits(),
            1,
            "the displaced reader's record left with its permit"
        );
        assert_eq!(replacement.available_permits(), 0);

        // The PTY completes 1: the replay resumes at 2, and every record is
        // written exactly once under the sequence it always had.
        assert_eq!(peer.confirm_keystroke_delivery(1), Some(1));
        drain_reliable(&mut peer, &mut |_, seq, bytes, _| {
            writes.push((seq, bytes.to_vec()));
            true
        });
        assert_eq!(
            writes,
            vec![(1, rec("a")), (2, rec("b")), (3, rec("c")), (4, rec("d"))]
        );
        assert!(!peer.reliable_inputs.has_pending());
        assert_eq!(replacement.available_permits(), 1);
    }

    /// The structural rule itself is unchanged: one reader, known here by its
    /// connection alone, cannot have two unadmitted records.
    #[test]
    #[should_panic(expected = "a reliable reader lent a second unadmitted input record")]
    fn one_reader_lending_a_second_unadmitted_record_is_still_a_fault() {
        let mut peer = PeerDisplayState::new("peer".into(), PeerTransport::WebTransport);
        for base in [2, 3] {
            let mut later = encode_input_run(base, false, &[(&rec("x")[..], false)]);
            let cursor = InputCursor::parse(&later).unwrap();
            let mut msg = message(PeerTransport::WebTransport, 1, &Arc::new(Semaphore::new(1)));
            msg.input_permit = None;
            peer.reliable_inputs.retain(
                &mut msg,
                cursor,
                origin(PeerTransport::WebTransport),
                &mut later,
            );
        }
    }

    #[test]
    fn first_block_and_repeated_credit_resumption_allocate_nothing() {
        const BATCHES: u32 = 128;
        let mut peer = PeerDisplayState::new("peer".into(), PeerTransport::WebTransport);
        let expected = rec("a");
        let mut frame = encode_input_run(1, false, &[(&expected[..], false); 8]);
        let frame_len = frame.len();
        let encoded = frame.clone();
        frame.resize(MAX_INBOUND_FRAME_BYTES, 0);
        let credit = Arc::new(Semaphore::new(1));
        let mut msg = message(PeerTransport::WebTransport, 1, &credit);
        let mut delivered = 0;
        crate::edge_tunnel::test_allocations::begin_thread();
        for batch in 0..BATCHES {
            if batch > 0 {
                msg.input_permit = Some(Arc::clone(&credit).try_acquire_owned().unwrap());
            }
            frame[..frame_len].copy_from_slice(&encoded);
            frame[4..8].copy_from_slice(&(batch * 8 + 1).to_be_bytes());
            let mut cursor = InputCursor::parse(&frame[..frame_len]).unwrap();
            assert!(!admit_reliable(
                &mut peer,
                &mut cursor,
                &frame,
                origin(PeerTransport::WebTransport),
                &mut |_, _, _, _| false
            ));
            peer.reliable_inputs.retain(
                &mut msg,
                cursor,
                origin(PeerTransport::WebTransport),
                &mut frame,
            );
            for _ in 0..8 {
                let mut room = 1;
                drain_reliable(&mut peer, &mut |_, seq, bytes, _| {
                    if room == 0 {
                        return false;
                    }
                    room -= 1;
                    assert_eq!(seq, delivered + 1);
                    assert_eq!(bytes, expected.as_slice());
                    delivered = seq;
                    true
                });
                assert_eq!(peer.confirm_keystroke_delivery(delivered), Some(delivered));
            }
            assert_eq!(credit.available_permits(), 1);
        }
        let allocations = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(delivered, BATCHES * 8);
        assert_eq!(
            allocations.allocations, 0,
            "first retention and all credit resumes"
        );
        assert_eq!(allocations.allocated_bytes, 0);
    }

    struct StoppedSink {
        gate: Arc<(Mutex<bool>, Condvar)>,
        bytes: Arc<AtomicUsize>,
    }
    impl Write for StoppedSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let (lock, wake) = &*self.gate;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = wake.wait(open).unwrap();
            }
            self.bytes.fetch_add(bytes.len(), Ordering::Relaxed);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct ReleaseSink(Arc<(Mutex<bool>, Condvar)>);
    impl Drop for ReleaseSink {
        fn drop(&mut self) {
            *self.0.0.lock().unwrap() = true;
            self.0.1.notify_one();
        }
    }

    #[tokio::test]
    async fn another_peers_completion_resumes_real_writer_without_timer_or_new_input() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let _release = ReleaseSink(Arc::clone(&gate));
        let bytes = Arc::new(AtomicUsize::new(0));
        let (mut writer, mut completions) = PtyWriter::new(Box::new(StoppedSink {
            gate: Arc::clone(&gate),
            bytes: Arc::clone(&bytes),
        }))
        .unwrap();
        let mut peers = PeerMap::new();
        let mut first = PeerDisplayState::new("first".into(), PeerTransport::WebTransport);
        let first_id = Arc::clone(&first.peer_id);
        // Fill real queue credit with ordinary unpaced writes. A single 256 KiB
        // paste incurs 1,023 OS sleeps, making this admission test depend on
        // timer coalescing and runner load rather than the completion wakeup.
        for (index, chunk) in vec![b'x'; MAX_QUEUED_USER_PTY_BYTES]
            .chunks(128)
            .enumerate()
        {
            let applied = first.apply_keystroke(
                u32::try_from(index + 1).unwrap(),
                chunk,
                false,
                &mut |seq, data, _| {
                    writer
                        .try_enqueue_user(
                            Arc::clone(&first_id),
                            seq,
                            PeerTransport::WebTransport,
                            crate::pty::PtyWritePayload::borrowed(data),
                            None,
                        )
                        .is_ok()
                },
            );
            assert!(applied.advanced);
            assert!(!applied.backpressured);
        }
        peers.insert(first_id, first);
        peers.insert(
            "peer".into(),
            PeerDisplayState::new("peer".into(), PeerTransport::WebTransport),
        );
        let (events, _) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(80, 24, events);
        let mut perf = PerfTimingTracker::default();
        let mut refill = InputRefill::default();
        let credit = Arc::new(Semaphore::new(1));
        let mut msg = message(PeerTransport::WebTransport, 1, &credit);
        let mut frame = encode_input_run(1, false, &[(&rec("a")[..], false)]);
        let len = frame.len();
        assert!(
            !crate::handle_reliable_input(
                &mut msg,
                &mut frame,
                len,
                &mut writer,
                &mut terminal,
                &mut peers,
                &mut refill,
                Instant::now(),
                &mut perf
            )
            .ack_pending
        );
        assert!(refill.pending);
        assert_eq!(credit.available_permits(), 0);
        assert!(peers["peer"].pending_input_ack.is_none());
        *gate.0.lock().unwrap() = true;
        gate.1.notify_one();
        let mut parked = ParkedPeers::new();
        tokio::time::timeout(Duration::from_secs(2), async {
            // The owner batches completions, so observe delivery rather than
            // assuming a fixed number of receiver wakeups.
            while peers["peer"].keystroke_next_expected_seq != 2 {
                let completion = completions.recv().await.unwrap();
                crate::handle_pty_write_completions(
                    completion,
                    &mut completions,
                    &mut writer,
                    &mut terminal,
                    &mut peers,
                    &mut parked,
                    &mut refill,
                    &mut perf,
                )
                .unwrap();
                assert!(!refill.pending);
                assert_eq!(credit.available_permits(), 1);
            }
        })
        .await
        .expect("PTY completions must resume and deliver the retained peer input");
        assert_eq!(bytes.load(Ordering::Relaxed), MAX_QUEUED_USER_PTY_BYTES + 1);
        assert_eq!(peers["peer"].keystroke_next_expected_seq, 2);
        assert_eq!(peers["peer"].pending_input_ack.unwrap().ack_seq, 1);
        assert_eq!(credit.available_permits(), 1);
        assert!(!refill.pending);
    }
}
