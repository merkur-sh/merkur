//! Test-only oracle for scripts/bench-input-ack.ts. The real wire parser and
//! per-peer sequencing run here; FIFO capacity and write completion are controlled
//! by virtual time in the driver. This is not a QUIC or OS PTY benchmark.

use std::collections::VecDeque;
use std::io::{self, BufRead, Write};

use serde::{Deserialize, Serialize};

use crate::connection::{KEYSTROKE_REORDER_CAP, PeerDisplayState, PeerTransport};
use crate::network::protocol::{
    MSG_TYPE_INPUT_RUN, MSG_TYPE_SEQUENCED_KEYSTROKE, decode_proto_frame, encode_input_ack,
    parse_input_run,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Reset { capacity: usize },
    Deliver { frame: Vec<u8>, reliable: bool },
    Rebind,
    Complete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Entry {
    seq: u32,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
struct Reply {
    confirmed: u32,
    admitted: u32,
    queued: usize,
    reordered: usize,
    delivered: Option<Entry>,
    ack: Option<Vec<u8>>,
}

struct Oracle {
    peer: PeerDisplayState,
    fifo: VecDeque<Entry>,
    capacity: usize,
}

impl Oracle {
    fn new(capacity: usize) -> Self {
        assert!((1..=4096).contains(&capacity));
        Self {
            peer: PeerDisplayState::new("input-ack-lab".into(), PeerTransport::WebTransport),
            fifo: VecDeque::new(),
            capacity,
        }
    }

    fn command(&mut self, command: Command) -> Reply {
        let mut delivered = None;
        match command {
            Command::Reset { capacity } => *self = Self::new(capacity),
            Command::Deliver { frame, reliable } => {
                if reliable {
                    self.deliver_reliable(frame);
                } else {
                    self.deliver(&frame);
                }
            }
            Command::Rebind => {
                self.peer.reliable_inputs.clear();
                self.peer.keystroke_reorder_buf.clear();
            }
            Command::Complete => {
                let entry = self
                    .fifo
                    .pop_front()
                    .expect("scheduled completion has a FIFO head");
                let ack = self
                    .peer
                    .confirm_keystroke_delivery(entry.seq)
                    .expect("only ordered completed writes may advance ACK");
                self.peer.queue_input_ack(ack, PeerTransport::WebTransport);
                let fifo = &mut self.fifo;
                let capacity = self.capacity;
                self.peer.drain_keystroke_reorder(&mut |seq, bytes, _| {
                    enqueue(fifo, capacity, seq, bytes)
                });
                crate::input::drain_reliable(&mut self.peer, &mut |_, seq, bytes, _| {
                    enqueue(fifo, capacity, seq, bytes)
                });
                delivered = Some(entry);
            }
        }
        assert!(self.fifo.len() <= self.capacity);
        assert!(self.peer.keystroke_reorder_buf.len() <= KEYSTROKE_REORDER_CAP);
        Reply {
            confirmed: self.peer.keystroke_next_expected_seq.wrapping_sub(1),
            admitted: self.peer.keystroke_next_queued_seq.wrapping_sub(1),
            queued: self.fifo.len(),
            reordered: self.peer.keystroke_reorder_buf.len(),
            delivered,
            ack: self
                .peer
                .pending_input_ack
                .take()
                .map(|ack| encode_input_ack(ack.ack_seq).to_vec()),
        }
    }

    fn deliver_reliable(&mut self, mut frame: Vec<u8>) {
        use crate::input::{InputCursor, InputOrigin, admit_reliable};
        use crate::network::peer::{DeliveryMode, PeerMessage};
        let Some(mut cursor) = InputCursor::parse(&frame) else {
            return;
        };
        let origin = InputOrigin {
            via: PeerTransport::WebTransport,
            received_at: None,
            observation_epoch: None,
        };
        let fifo = &mut self.fifo;
        let capacity = self.capacity;
        let advanced = admit_reliable(
            &mut self.peer,
            &mut cursor,
            &frame,
            origin,
            &mut |_, seq, bytes, _| enqueue(fifo, capacity, seq, bytes),
        );
        if cursor.retransmit && !advanced {
            self.peer.queue_input_ack(
                self.peer.keystroke_next_expected_seq.wrapping_sub(1),
                origin.via,
            );
        }
        if !cursor.is_empty() {
            // The driver models the reader's one-record credit. Native state owns
            // the cursor and resumes only on the production completion path.
            let mut msg = PeerMessage {
                peer_node_id: self.peer.peer_id.clone(),
                connection_id: 1,
                channel_id: crate::network::protocol::CHANNEL_PTY,
                payload: bytes::Bytes::new(),
                via_transport: origin.via,
                delivery: DeliveryMode::Stream,
                edge_ingress: None,
                input_permit: None,
            };
            self.peer
                .reliable_inputs
                .retain(&mut msg, cursor, origin, &mut frame);
        }
    }

    fn deliver(&mut self, frame: &[u8]) {
        let Some((kind, body)) = decode_proto_frame(frame) else {
            return;
        };
        let fifo = &mut self.fifo;
        let capacity = self.capacity;
        let mut accept = |seq, bytes: &[u8], _| enqueue(fifo, capacity, seq, bytes);
        match kind {
            MSG_TYPE_INPUT_RUN => {
                let Some((header, entries)) = parse_input_run(body) else {
                    return;
                };
                let applied = self.peer.apply_input_run(
                    header.base_seq,
                    entries.map(|entry| (entry.payload, entry.shadow_modelled)),
                    &mut accept,
                );
                // Mirrors handle_pty_channel: ordinary twins owe no extra ACK;
                // a marked idle retry can solicit the delivered watermark.
                if header.retransmit && !applied.advanced {
                    self.peer
                        .queue_input_ack(applied.ack_seq, PeerTransport::WebTransport);
                }
            }
            MSG_TYPE_SEQUENCED_KEYSTROKE if body.len() >= 4 => {
                let seq = u32::from_be_bytes(body[..4].try_into().expect("checked length"));
                self.peer
                    .apply_keystroke(seq, &body[4..], false, &mut accept);
            }
            _ => {}
        }
    }
}

fn enqueue(fifo: &mut VecDeque<Entry>, capacity: usize, seq: u32, bytes: &[u8]) -> bool {
    if fifo.len() == capacity {
        return false;
    }
    fifo.push_back(Entry {
        seq,
        bytes: bytes.to_vec(),
    });
    true
}

#[test]
#[ignore = "JSON oracle driven by bun scripts/bench-input-ack.ts"]
fn bridge() {
    let mut oracle = Oracle::new(8);
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("driver stdin");
        assert!(line.len() <= 2 * 1024 * 1024, "bounded test command");
        let command = serde_json::from_str(&line).expect("valid driver command");
        let reply = oracle.command(command);
        writeln!(
            stdout,
            "ACK_LAB {}",
            serde_json::to_string(&reply).expect("reply JSON")
        )
        .expect("driver stdout");
        stdout.flush().expect("flush reply");
    }
}

#[test]
fn ordering_duplicates_backpressure_and_ack_authority() {
    use crate::network::input_record::build;
    use crate::network::protocol::encode_input_run;
    let mut oracle = Oracle::new(1);
    // Sequencing never looks inside a record; each entry is typed text.
    let run = |seq, retry, text: &str| Command::Deliver {
        frame: encode_input_run(seq, retry, &[(&build::text(text)[..], false)]),
        reliable: false,
    };
    assert_eq!(oracle.command(run(2, false, "b")).reordered, 1);
    assert_eq!(oracle.command(run(1, false, "a")).confirmed, 0);
    assert!(oracle.peer.confirm_keystroke_delivery(2).is_none());
    assert_eq!(oracle.command(run(1, false, "a")).queued, 1);
    let first = oracle.command(Command::Complete);
    assert_eq!(
        first.delivered.expect("first write").bytes,
        build::text("a")
    );
    assert_eq!(first.confirmed, 1);
    assert_eq!(first.queued, 1, "completion refills the bounded FIFO");
    let second = oracle.command(Command::Complete);
    assert_eq!(
        second.delivered.expect("second write").bytes,
        build::text("b")
    );
    assert_eq!(second.confirmed, 2);
    let retry = oracle.command(run(1, true, "a"));
    assert_eq!(retry.queued, 0, "retry cannot duplicate PTY bytes");
    assert_eq!(retry.ack, Some(encode_input_ack(2).to_vec()));
}

#[test]
fn malformed_run_is_atomic_and_queue_admission_is_not_delivery() {
    use crate::network::input_record::build;
    use crate::network::protocol::encode_input_run;
    let mut oracle = Oracle::new(1);
    let (a, b) = (build::text("a"), build::text("b"));
    let mut frame = encode_input_run(1, false, &[(&a[..], false), (&b[..], false)]);
    frame.pop();
    assert_eq!(
        oracle
            .command(Command::Deliver {
                frame,
                reliable: false
            })
            .queued,
        0
    );
    let frame = encode_input_run(1, false, &[(&a[..], false), (&b[..], false)]);
    let reply = oracle.command(Command::Deliver {
        frame,
        reliable: false,
    });
    assert_eq!(reply.confirmed, 0);
    assert!(reply.ack.is_none());
    assert_eq!(reply.queued, 1);
    let frame = encode_input_run(1, true, &[(&a[..], false)]);
    assert_eq!(
        oracle
            .command(Command::Deliver {
                frame,
                reliable: false
            })
            .ack,
        Some(encode_input_ack(0).to_vec())
    );
}

#[test]
fn a_probed_run_sequences_and_acknowledges_exactly_as_an_unprobed_one() {
    use crate::network::input_record::build;
    use crate::network::protocol::encode_probed_input_run;
    let mut oracle = Oracle::new(1);
    let (a, b) = (build::text("a"), build::text("b"));
    // The liveness token sits between the flags and the bitset; sequencing,
    // dedup and ACK authority read past it on both lanes.
    let datagram = encode_probed_input_run(1, false, Some(7), &[(&a[..], false), (&b[..], true)]);
    let reply = oracle.command(Command::Deliver {
        frame: datagram,
        reliable: false,
    });
    assert_eq!(reply.queued, 1);
    assert!(reply.ack.is_none());
    let twin = encode_probed_input_run(1, false, Some(7), &[(&a[..], false), (&b[..], true)]);
    let reply = oracle.command(Command::Deliver {
        frame: twin,
        reliable: true,
    });
    assert_eq!(reply.queued, 1, "the reliable copy duplicates nothing");
    assert_eq!(
        oracle
            .command(Command::Complete)
            .delivered
            .expect("first write")
            .bytes,
        a
    );
    let second = oracle.command(Command::Complete);
    assert_eq!(second.delivered.expect("second write").bytes, b);
    assert_eq!(second.confirmed, 2);
}
