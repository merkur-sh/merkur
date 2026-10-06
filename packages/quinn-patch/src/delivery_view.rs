//! A connection's delivery state, readable without its state lock.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering, fence};

use proto::DeliveryState;

use crate::Duration;

/// Words one encoded [`DeliveryState`] occupies.
const WORDS: usize = 10;

/// Flag bit of word 0: `pacing_rate` is `Some`.
const PACING_RATE_PRESENT: u64 = 1;

/// A connection's [`DeliveryState`] as of the last release of its state lock
/// that changed it, and whether the connection has closed.
///
/// Whoever holds the connection's state lock publishes, so there is one
/// writer at a time and it never waits. The two copies behind one sequence
/// counter form a latch (Linux's `seqcount_latch`): a publication directs
/// readers to the copy it is not rewriting, rewrites the other, flips readers
/// onto it, then rewrites the first. A reader loads the directed copy and
/// retries only if the counter moved meanwhile, which takes the writer
/// completing a flip during those few loads. A writer stalled mid-publication
/// never holds a reader up: the copy it is rewriting is never the one read.
#[derive(Debug, Default)]
pub(crate) struct DeliveryView {
    sequence: AtomicU64,
    copies: [[AtomicU64; WORDS]; 2],
    closed: AtomicBool,
}

impl DeliveryView {
    /// Callers hold the connection's state lock, which makes them the only
    /// writer.
    pub(crate) fn publish(&self, state: &DeliveryState) {
        let words = encode(state);
        let sequence = self.sequence.load(Ordering::Relaxed);
        self.flip(sequence.wrapping_add(1));
        store(&self.copies[0], &words);
        self.flip(sequence.wrapping_add(2));
        store(&self.copies[1], &words);
    }

    /// Direct readers to copy `sequence & 1`. The first fence keeps the
    /// preceding copy's stores before the flip, the second keeps the next
    /// copy's stores after it.
    fn flip(&self, sequence: u64) {
        fence(Ordering::Release);
        self.sequence.store(sequence, Ordering::Relaxed);
        fence(Ordering::Release);
    }

    pub(crate) fn read(&self) -> DeliveryState {
        loop {
            let sequence = self.sequence.load(Ordering::Acquire);
            let copy = &self.copies[(sequence & 1) as usize];
            let words: [u64; WORDS] =
                std::array::from_fn(|index| copy[index].load(Ordering::Relaxed));
            fence(Ordering::Acquire);
            if self.sequence.load(Ordering::Relaxed) == sequence {
                return decode(words);
            }
        }
    }

    /// Set where the connection records its error, under its state lock.
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

fn store(copy: &[AtomicU64; WORDS], words: &[u64; WORDS]) {
    for (slot, word) in copy.iter().zip(words) {
        slot.store(*word, Ordering::Relaxed);
    }
}

fn encode(state: &DeliveryState) -> [u64; WORDS] {
    let pacing_flag = if state.pacing_rate.is_some() {
        PACING_RATE_PRESENT
    } else {
        0
    };
    [
        pacing_flag | (u64::from(state.current_mtu) << 16) | (u64::from(state.pto_count) << 32),
        u64::try_from(state.rtt.as_nanos()).unwrap_or(u64::MAX),
        state.cwnd,
        state.bytes_in_flight,
        state.pacing_rate.unwrap_or(0),
        state.sent_packets,
        state.lost_packets,
        state.datagram_send_buffer_space as u64,
        state.image_bytes_in_flight,
        u64::from(state.peer_rebinds) | (u64::from(state.peer_address_changes) << 32),
    ]
}

fn decode(words: [u64; WORDS]) -> DeliveryState {
    let [
        flags,
        rtt,
        cwnd,
        bytes_in_flight,
        pacing_rate,
        sent,
        lost,
        datagram_space,
        image_flight,
        migrations,
    ] = words;
    let mut state = DeliveryState::default();
    state.rtt = Duration::from_nanos(rtt);
    state.cwnd = cwnd;
    state.bytes_in_flight = bytes_in_flight;
    state.image_bytes_in_flight = image_flight;
    state.pacing_rate = (flags & PACING_RATE_PRESENT != 0).then_some(pacing_rate);
    state.current_mtu = (flags >> 16) as u16;
    state.pto_count = (flags >> 32) as u32;
    state.sent_packets = sent;
    state.lost_packets = lost;
    state.datagram_send_buffer_space = usize::try_from(datagram_space).unwrap_or(usize::MAX);
    state.peer_rebinds = migrations as u32;
    state.peer_address_changes = (migrations >> 32) as u32;
    state
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn state(value: u64) -> DeliveryState {
        let mut state = DeliveryState::default();
        state.rtt = Duration::from_nanos(value);
        state.cwnd = value;
        state.bytes_in_flight = value;
        state.image_bytes_in_flight = value;
        state.pacing_rate = (value % 2 == 0).then_some(value);
        state.current_mtu = value as u16;
        state.pto_count = value as u32;
        state.sent_packets = value;
        state.lost_packets = value;
        state.datagram_send_buffer_space = value as usize;
        state.peer_rebinds = value as u32;
        state.peer_address_changes = value as u32;
        state
    }

    #[test]
    fn a_publication_reads_back_exactly() {
        let view = DeliveryView::default();
        for value in [
            0,
            1,
            1_200,
            u64::from(u16::MAX),
            u64::from(u32::MAX) + 7,
            u64::MAX >> 1,
        ] {
            let mut expected = state(value);
            expected.pacing_rate = Some(value);
            view.publish(&expected);
            assert_eq!(view.read(), expected);
            expected.pacing_rate = None;
            view.publish(&expected);
            assert_eq!(view.read(), expected);
        }
    }

    /// Every field carries the same number, so a torn read shows up as two
    /// fields that disagree. One writer (the lock holder) publishes an
    /// increasing sequence while readers on other threads check each read.
    #[test]
    fn concurrent_reads_are_never_torn_and_never_go_backwards() {
        let view = Arc::new(DeliveryView::default());
        view.publish(&state(0));
        const PUBLICATIONS: u64 = 200_000;
        let readers: Vec<_> = (0..3)
            .map(|_| {
                let view = Arc::clone(&view);
                std::thread::spawn(move || {
                    let mut last = 0;
                    loop {
                        let read = view.read();
                        let value = read.cwnd;
                        assert_eq!(read, state(value), "torn read");
                        assert!(value >= last, "read went backwards: {value} after {last}");
                        last = value;
                        if value == PUBLICATIONS {
                            return;
                        }
                    }
                })
            })
            .collect();
        for value in 1..=PUBLICATIONS {
            view.publish(&state(value));
        }
        for reader in readers {
            reader.join().expect("reader");
        }
    }
}
