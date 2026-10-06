//! Bounded, native-only boundary evidence. Producers never serialize, perform IO,
//! allocate, or take the metadata lock. A full recorder reports loss.
//! Explicit IPC capture is cold work and never rides the display/control lanes.
//! Timestamps share a process-monotonic origin, NOT the browser's clock.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

use crate::pty::PtyTraceEvent;

pub const CAPACITY: usize = 16_384;
pub const CHUNK_RECORDS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TraceToken {
    pub owner: u64,
}

pub enum TraceEvent {
    Pty(PtyTraceEvent),
    /// seq, generation, frame, PID, member index/count, flags, row count,
    /// planned primary, path mask, wire bytes. Remaining words are zero.
    DisplayMember([u64; 16]),
    /// seq/group-start, generation, role, attempted carrier, start_us, accepted,
    /// bytes, reserved-space-before, budget-refused. Not a wire timestamp.
    DisplayAttempt([u64; 16]),
    /// carrier, RTT us, cwnd, in-flight, queued bytes, MTU, pacing bps,
    /// packets-sent count, packets-lost count. These are not loss rates.
    CarrierState([u64; 16]),
    /// phase, connection identity, packet+1 (zero absent), queued/payload bytes,
    /// four uint32 words of the sealed AEAD tag, then Merkur channel+1 (zero
    /// absent). No payload or keys retained.
    QuicDatagram([u64; 16]),
}

impl TraceEvent {
    fn fields(self) -> (&'static str, [u64; 16]) {
        match self {
            Self::Pty(event) => event.trace_fields(),
            Self::DisplayMember(fields) => ("display_member", fields),
            Self::DisplayAttempt(fields) => ("display_attempt", fields),
            Self::CarrierState(fields) => ("carrier_state", fields),
            Self::QuicDatagram(fields) => ("quic_datagram", fields),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct TraceRecord {
    pub ordinal: u64,
    pub owner: u64,
    pub at_us: u64,
    pub kind: &'static str,
    pub fields: [u64; 16],
}

#[derive(Clone, Debug, Serialize)]
pub struct TraceOwner {
    pub owner: u64,
    pub peer_id: String,
    pub session_id: String,
    pub observation_epoch: u32,
}

struct State {
    owner: Option<TraceOwner>,
    stale_baseline: u64,
    reset_discarded: u64,
}

struct Recorder {
    origin: Instant,
    active: AtomicU64,
    next_owner: AtomicU64,
    next_ordinal: AtomicU64,
    /// High word = exact process observation owner, low word = full refusals.
    /// Atomic tagging prevents a delayed old producer crediting new-owner loss.
    /// Owner allocation fails before u32 wrap; refusal counts saturate at
    /// u32::MAX per capture, which is always a positive incompleteness verdict.
    full_drops: AtomicU64,
    stale: AtomicU64,
    record_tx: crossbeam_channel::Sender<TraceRecord>,
    record_rx: crossbeam_channel::Receiver<TraceRecord>,
    state: Mutex<State>,
    capacity: usize,
}

pub struct TraceSnapshot {
    pub owner: TraceOwner,
    pub records: Vec<TraceRecord>,
    pub dropped: u64,
    pub stale: u64,
}

#[derive(Serialize)]
pub struct TraceChunk<'a> {
    pub command_id: &'a str,
    #[serde(flatten)]
    pub owner: &'a TraceOwner,
    pub attempted: u64,
    pub dropped: u64,
    pub stale: u64,
    pub first_ordinal: u64,
    pub last_ordinal: u64,
    pub record_count: usize,
    pub chunk_index: usize,
    pub chunk_count: usize,
    pub records: &'a [TraceRecord],
}

impl TraceSnapshot {
    pub fn chunk_count(&self) -> usize {
        self.records.len().div_ceil(CHUNK_RECORDS).max(1)
    }

    pub fn chunk<'a>(&'a self, command_id: &'a str, index: usize) -> TraceChunk<'a> {
        assert!(index < self.chunk_count());
        let start = index * CHUNK_RECORDS;
        let end = (start + CHUNK_RECORDS).min(self.records.len());
        TraceChunk {
            command_id,
            owner: &self.owner,
            attempted: self.records.len() as u64 + self.dropped,
            dropped: self.dropped,
            stale: self.stale,
            first_ordinal: self.records.first().map_or(0, |record| record.ordinal),
            last_ordinal: self.records.last().map_or(0, |record| record.ordinal),
            record_count: self.records.len(),
            chunk_index: index,
            chunk_count: self.chunk_count(),
            records: &self.records[start..end],
        }
    }
}

impl Recorder {
    fn new(capacity: usize) -> Self {
        assert!(capacity > 0);
        let (record_tx, record_rx) = crossbeam_channel::bounded(capacity);
        Self {
            origin: Instant::now(),
            active: AtomicU64::new(0),
            next_owner: AtomicU64::new(1),
            next_ordinal: AtomicU64::new(1),
            full_drops: AtomicU64::new(0),
            stale: AtomicU64::new(0),
            record_tx,
            record_rx,
            state: Mutex::new(State {
                owner: None,
                stale_baseline: 0,
                reset_discarded: 0,
            }),
            capacity,
        }
    }

    fn begin(&self, peer_id: &str, session_id: &str, epoch: u32) -> TraceToken {
        // Only the owner loop starts observations. No producer takes this
        // metadata lock; old work retains its exact token through a reset.
        self.active.store(0, Ordering::Release);
        let mut state = self.state.lock().expect("native trace state");
        let owner = self.next_owner.fetch_add(1, Ordering::Relaxed);
        assert!(owner <= u64::from(u32::MAX), "native trace owner exhausted");
        let mut discarded = 0;
        for _ in 0..self.capacity {
            if self.record_rx.try_recv().is_err() {
                break;
            }
            discarded += 1;
        }
        let previous_loss = self.full_drops.swap(owner << 32, Ordering::AcqRel) as u32;
        // Reset censoring is informational stale evidence, never missing
        // records of the successor observation. It cannot become "dropped".
        state.reset_discarded = state
            .reset_discarded
            .saturating_add(discarded)
            .saturating_add(u64::from(previous_loss));
        state.stale_baseline = self.stale.load(Ordering::Relaxed);
        state.owner = Some(TraceOwner {
            owner,
            peer_id: peer_id.to_owned(),
            session_id: session_id.to_owned(),
            observation_epoch: epoch,
        });
        self.active.store(owner, Ordering::Release);
        TraceToken { owner }
    }

    fn record(&self, token: TraceToken, at: Instant, event: TraceEvent) {
        if self.active.load(Ordering::Acquire) != token.owner {
            self.stale.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let (kind, fields) = event.fields();
        let ordinal = self.next_ordinal.fetch_add(1, Ordering::Relaxed);
        let record = TraceRecord {
            ordinal,
            owner: token.owner,
            at_us: u64::try_from(at.saturating_duration_since(self.origin).as_micros())
                .unwrap_or(u64::MAX),
            kind,
            fields,
        };
        if self.record_tx.try_send(record).is_err() {
            self.note_full(token);
        }
    }

    fn note_full(&self, token: TraceToken) {
        if self
            .full_drops
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |state| {
                (state >> 32 == token.owner).then(|| {
                    (state & !u64::from(u32::MAX)) | u64::from((state as u32).saturating_add(1))
                })
            })
            .is_err()
        {
            self.stale.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn capture(&self) -> Option<TraceSnapshot> {
        let mut state = self.state.lock().expect("native trace state");
        let owner = state.owner.clone()?;
        // One bounded drain, not an in-flight-producer barrier. A producer can
        // reserve a lower ordinal and publish it into the following capture.
        // Consumers must join all retained identities, not infer chronology
        // or completeness from capture order or ordinal range subtraction.
        let limit = self.record_rx.len().min(self.capacity);
        let mut records = Vec::with_capacity(limit);
        let mut filtered = 0u64;
        for _ in 0..limit {
            let Ok(record) = self.record_rx.try_recv() else {
                break;
            };
            if record.owner == owner.owner {
                records.push(record);
            } else {
                filtered += 1;
            }
        }
        records.sort_unstable_by_key(|record| record.ordinal);
        let dropped = u64::from(self.full_drops.swap(owner.owner << 32, Ordering::AcqRel) as u32);
        let stale_total = self.stale.load(Ordering::Relaxed);
        let stale = stale_total
            .saturating_sub(state.stale_baseline)
            .saturating_add(filtered)
            .saturating_add(std::mem::take(&mut state.reset_discarded));
        state.stale_baseline = stale_total;
        Some(TraceSnapshot {
            owner,
            records,
            dropped,
            stale,
        })
    }
}

static RECORDER: OnceLock<Recorder> = OnceLock::new();

pub fn begin(peer_id: &str, session_id: &str, epoch: u32) -> Option<TraceToken> {
    if epoch == 0 {
        return None;
    }
    let recorder = RECORDER.get_or_init(|| {
        let _ = quinn_proto::datagram_observer::install_datagram_observer(observe_quic_datagram);
        Recorder::new(CAPACITY)
    });
    let token = recorder.begin(peer_id, session_id, epoch);
    quinn_proto::datagram_observer::set_datagram_observer_enabled(true);
    Some(token)
}

pub fn active_token() -> Option<TraceToken> {
    let owner = RECORDER.get()?.active.load(Ordering::Acquire);
    (owner != 0).then_some(TraceToken { owner })
}

pub fn end(token: TraceToken) {
    if let Some(recorder) = RECORDER.get()
        && recorder
            .active
            .compare_exchange(token.owner, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    {
        quinn_proto::datagram_observer::set_datagram_observer_enabled(false);
    }
}

pub fn elapsed_us(_token: TraceToken, at: Instant) -> u64 {
    RECORDER.get().map_or(0, |recorder| {
        u64::try_from(at.saturating_duration_since(recorder.origin).as_micros()).unwrap_or(u64::MAX)
    })
}

pub fn record_at(token: TraceToken, at: Instant, event: TraceEvent) {
    if let Some(recorder) = RECORDER.get() {
        recorder.record(token, at, event);
    }
}

pub fn capture() -> Option<TraceSnapshot> {
    RECORDER.get()?.capture()
}

fn observe_quic_datagram(observation: quinn_proto::datagram_observer::DatagramObservation<'_>) {
    use quinn_proto::datagram_observer::DatagramObservationKind;
    let Some(token) = active_token() else {
        return;
    };
    let at = Instant::now();
    let phase = match observation.kind {
        DatagramObservationKind::Queued => 0,
        DatagramObservationKind::Packetized => {
            crate::perf_timing::observe_ack_packetized(observation.payload, at);
            1
        }
        DatagramObservationKind::PacketAcknowledged => 2,
        DatagramObservationKind::PacketLost => 3,
    };
    let mut fields = [0; 16];
    fields[..5].copy_from_slice(&[
        phase,
        observation.connection,
        observation.packet.map_or(0, |packet| packet + 1),
        observation.queued_bytes as u64,
        observation.payload_len() as u64,
    ]);
    if observation.payload.len() >= 16 {
        let tag = &observation.payload[observation.payload.len() - 16..];
        for (index, word) in tag.chunks_exact(4).enumerate() {
            fields[5 + index] = u64::from(u32::from_le_bytes(word.try_into().expect("tag word")));
        }
    }
    fields[9] = datagram_channel(observation.payload, observation.prefix.is_some())
        .map_or(0, |channel| u64::from(channel) + 1);
    record_at(token, at, TraceEvent::QuicDatagram(fields));
}

/// The Merkur channel byte of a DATAGRAM payload, so a capture can tell input
/// ACKs, pongs and display frames apart without retaining the payload. An
/// owned-prefix sender passes the HTTP/3 quarter-stream id as the prefix, so the
/// channel opens the payload; otherwise the payload starts with that QUIC
/// varint, whose two high bits give its length.
fn datagram_channel(payload: &[u8], prefixed: bool) -> Option<u8> {
    if prefixed {
        return payload.first().copied();
    }
    let varint_len = 1usize << (payload.first()? >> 6);
    payload.get(varint_len).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rejected recorder retained only as this benchmark's negative control.
    /// It never enters the production producer or capture path.
    struct RetiredTryLockRecorder {
        origin: Instant,
        active: AtomicU64,
        contention: AtomicU64,
        records: Mutex<(u64, Vec<TraceRecord>)>,
    }

    impl RetiredTryLockRecorder {
        fn new() -> Self {
            Self {
                origin: Instant::now(),
                active: AtomicU64::new(1),
                contention: AtomicU64::new(0),
                records: Mutex::new((0, Vec::with_capacity(CAPACITY))),
            }
        }

        fn record(&self, token: TraceToken, at: Instant, event: TraceEvent) {
            if self.active.load(Ordering::Acquire) != token.owner {
                return;
            }
            let Ok(mut state) = self.records.try_lock() else {
                self.contention.fetch_add(1, Ordering::Relaxed);
                return;
            };
            state.0 += 1;
            let ordinal = state.0;
            if state.1.len() == CAPACITY {
                self.contention.fetch_add(1, Ordering::Relaxed);
                return;
            }
            let (kind, fields) = event.fields();
            state.1.push(TraceRecord {
                ordinal,
                owner: token.owner,
                at_us: at
                    .saturating_duration_since(self.origin)
                    .as_micros()
                    .try_into()
                    .unwrap(),
                kind,
                fields,
            });
        }

        fn capture(&self) -> (Vec<TraceRecord>, u64) {
            let records = std::mem::take(&mut self.records.lock().unwrap().1);
            (records, self.contention.load(Ordering::Relaxed))
        }
    }

    /// Fixed population below capacity, so any refusal measures producer
    /// contention rather than an undersized collector. No capture overlaps
    /// producers. Thread creation, barriers, allocation and validation are
    /// outside each producer's timed interval. Wall time includes descheduling
    /// and is not advertised as a CPU or application-latency measurement.
    #[test]
    #[ignore = "native diagnostic collector contention comparison"]
    fn native_trace_collector_contention_probe() {
        use std::sync::{Arc, Barrier};
        use std::thread;
        const PER_PRODUCER: usize = 4_000;
        const ROUNDS: usize = 20;

        for producers in [1, 2, 4] {
            for round in 0..ROUNDS + 2 {
                // Alternate arms so warming/frequency drift does not always
                // favor the same implementation. First two rounds warm only.
                for mpsc in if round % 2 == 0 {
                    [false, true]
                } else {
                    [true, false]
                } {
                    let recorder = Arc::new(Recorder::new(CAPACITY));
                    let token = recorder.begin("probe", "probe-session", 1);
                    let retired = Arc::new(RetiredTryLockRecorder::new());
                    let start = Arc::new(Barrier::new(producers + 1));
                    let mut handles = Vec::with_capacity(producers);
                    for producer in 0..producers {
                        let recorder = Arc::clone(&recorder);
                        let retired = Arc::clone(&retired);
                        let start = Arc::clone(&start);
                        handles.push(thread::spawn(move || {
                            start.wait();
                            let began = Instant::now();
                            for index in 0..PER_PRODUCER {
                                let at = Instant::now();
                                let mut fields = [0; 16];
                                fields[0] = producer as u64;
                                fields[1] = index as u64;
                                let event = TraceEvent::DisplayAttempt(fields);
                                if mpsc {
                                    recorder.record(token, at, event);
                                } else {
                                    retired.record(token, at, event);
                                }
                            }
                            began.elapsed().as_nanos() as u64
                        }));
                    }
                    start.wait();
                    let measurements: Vec<_> = handles
                        .into_iter()
                        .map(|handle| handle.join().unwrap())
                        .collect();
                    let (records, drops) = if mpsc {
                        let snapshot = recorder.capture().unwrap();
                        (snapshot.records, snapshot.dropped)
                    } else {
                        retired.capture()
                    };
                    assert_eq!(
                        records.len() as u64 + drops,
                        (producers * PER_PRODUCER) as u64
                    );
                    if mpsc {
                        assert_eq!(drops, 0, "capacity covers every independent producer");
                    }
                    let mut seen = vec![false; producers * PER_PRODUCER];
                    for record in records.iter() {
                        let key =
                            record.fields[0] as usize * PER_PRODUCER + record.fields[1] as usize;
                        assert!(!seen[key], "duplicate diagnostic record");
                        seen[key] = true;
                        assert_eq!(record.owner, token.owner);
                    }
                    if round >= 2 {
                        println!(
                            "@@native-trace-contention {}",
                            serde_json::json!({
                                "arm": if mpsc { "bounded-mpsc" } else { "try-lock" },
                                "producers": producers, "round": round - 2,
                                "recordsPerProducer": PER_PRODUCER, "retained": records.len(),
                                "dropped": drops,
                                "producerElapsedNs": measurements,
                            })
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn bounded_records_report_only_actual_full_refusals() {
        let recorder = Recorder::new(2);
        let token = recorder.begin("peer", "session", 1);
        for _ in 0..3 {
            recorder.record(token, Instant::now(), TraceEvent::DisplayAttempt([0; 16]));
        }
        {
            let _held = recorder.state.lock().unwrap();
            recorder.record(token, Instant::now(), TraceEvent::DisplayAttempt([0; 16]));
        }
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.records.len(), 2);
        assert_eq!(snapshot.dropped, 2);
        assert_eq!(snapshot.chunk("capture", 0).attempted, 4);
        assert_eq!(recorder.capture().unwrap().dropped, 0);
    }

    #[test]
    fn producers_never_take_the_cold_metadata_lock() {
        let recorder = Recorder::new(2);
        let token = recorder.begin("peer", "session", 1);
        {
            let _held = recorder.state.lock().unwrap();
            recorder.record(token, Instant::now(), TraceEvent::DisplayAttempt([0; 16]));
        }
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.records.len(), 1);
        assert_eq!(snapshot.dropped, 0);
    }

    #[test]
    fn old_owner_refusal_cannot_increment_the_successor_drop_count() {
        let recorder = Recorder::new(2);
        let old = recorder.begin("peer", "old", 1);
        let current = recorder.begin("peer", "new", 2);
        // The old producer passed its active check before reset but reached
        // a full queue afterward. The tagged compare-update is the race fence.
        recorder.note_full(old);
        recorder.note_full(current);
        recorder.note_full(old);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.dropped, 1);
        assert_eq!(snapshot.stale, 2);
        assert_eq!(snapshot.owner.owner, current.owner);
        assert_eq!(recorder.capture().unwrap().dropped, 0);
    }

    #[test]
    fn reset_discard_and_late_old_publication_are_informational_not_current_loss() {
        let recorder = Recorder::new(2);
        let old = recorder.begin("peer", "old", 1);
        recorder.record(old, Instant::now(), TraceEvent::DisplayAttempt([0; 16]));
        let current = recorder.begin("peer", "new", 2);
        // Model a producer whose reservation preceded reset but whose queue
        // publication follows it. Capture must not relabel its owner.
        recorder
            .record_tx
            .try_send(TraceRecord {
                ordinal: 2,
                owner: old.owner,
                at_us: 0,
                kind: "display_attempt",
                fields: [0; 16],
            })
            .unwrap();
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.owner.owner, current.owner);
        assert!(snapshot.records.is_empty());
        assert_eq!(snapshot.stale, 2);
        assert_eq!(snapshot.dropped, 0);
    }

    #[test]
    fn capture_preserves_late_reserved_ordinals_without_a_producer_barrier() {
        let recorder = Recorder::new(3);
        let token = recorder.begin("peer", "session", 1);
        for ordinal in [3, 2] {
            recorder
                .record_tx
                .try_send(TraceRecord {
                    ordinal,
                    owner: token.owner,
                    at_us: ordinal,
                    kind: "display_attempt",
                    fields: [0; 16],
                })
                .unwrap();
        }
        let first = recorder.capture().unwrap();
        assert_eq!(
            first
                .records
                .iter()
                .map(|record| record.ordinal)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        recorder
            .record_tx
            .try_send(TraceRecord {
                ordinal: 1,
                owner: token.owner,
                at_us: 1,
                kind: "display_attempt",
                fields: [0; 16],
            })
            .unwrap();
        let second = recorder.capture().unwrap();
        assert_eq!(second.records[0].ordinal, 1);
        assert_eq!(second.dropped, 0);
    }

    #[test]
    fn refusal_counter_saturates_instead_of_corrupting_its_owner_tag() {
        let recorder = Recorder::new(1);
        let token = recorder.begin("peer", "session", 1);
        recorder
            .full_drops
            .store((token.owner << 32) | u64::from(u32::MAX), Ordering::Relaxed);
        recorder.note_full(token);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.dropped, u64::from(u32::MAX));
        assert_eq!(
            recorder.full_drops.load(Ordering::Relaxed),
            token.owner << 32
        );
    }

    #[test]
    fn producer_recording_allocates_nothing_after_collector_setup() {
        let recorder = Recorder::new(1_024);
        let token = recorder.begin("peer", "session", 1);
        let at = Instant::now();
        crate::edge_tunnel::test_allocations::begin_thread();
        for _ in 0..1_024 {
            recorder.record(token, at, TraceEvent::DisplayAttempt([0; 16]));
        }
        let counts = crate::edge_tunnel::test_allocations::end_thread();
        assert_eq!(counts.allocations, 0);
        assert_eq!(counts.allocated_bytes, 0);
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.records.len(), 1_024);
        assert_eq!(snapshot.dropped, 0);
    }

    #[test]
    fn stale_tokens_cannot_write_or_disable_successor_observations() {
        let recorder = Recorder::new(2);
        let old = recorder.begin("peer", "old", 1);
        let current = recorder.begin("peer", "new", 2);
        recorder.record(old, Instant::now(), TraceEvent::DisplayMember([0; 16]));
        recorder.record(current, Instant::now(), TraceEvent::DisplayMember([0; 16]));
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.owner.session_id, "new");
        assert_eq!(snapshot.records.len(), 1);
        assert_eq!(snapshot.records[0].owner, current.owner);
    }

    #[test]
    fn capture_chunks_are_bounded_and_preserve_out_of_order_clock_stamps() {
        let recorder = Recorder::new(129);
        let token = recorder.begin("peer", "session", 3);
        let now = Instant::now();
        for i in 0..129 {
            recorder.record(
                token,
                if i == 0 { now } else { recorder.origin },
                TraceEvent::DisplayMember([0; 16]),
            );
        }
        let snapshot = recorder.capture().unwrap();
        assert_eq!(snapshot.chunk_count(), 2);
        assert_eq!(snapshot.chunk("capture", 0).records.len(), 128);
        assert_eq!(snapshot.chunk("capture", 1).records.len(), 1);
        assert!(
            snapshot
                .records
                .windows(2)
                .all(|rows| rows[0].ordinal < rows[1].ordinal)
        );
        assert_eq!(recorder.capture().unwrap().chunk_count(), 1);
    }

    /// Both admission framings name the same channel: the plain path carries
    /// the HTTP/3 quarter-stream varint in the payload, at every varint width;
    /// the owned-prefix path passes it separately. Payloads too short to hold
    /// a channel report none rather than reading past their end.
    #[test]
    fn a_datagram_channel_is_read_past_the_quarter_stream_varint() {
        use crate::network::protocol::{CHANNEL_CTRL, CHANNEL_DISPLAY_DATAGRAM, CHANNEL_PTY};
        assert_eq!(datagram_channel(&[0x00, CHANNEL_PTY, 9, 9], false), Some(CHANNEL_PTY));
        assert_eq!(datagram_channel(&[0x40, 0x41, CHANNEL_CTRL, 9], false), Some(CHANNEL_CTRL));
        assert_eq!(
            datagram_channel(&[0x80, 0, 0, 1, CHANNEL_PTY], false),
            Some(CHANNEL_PTY)
        );
        assert_eq!(
            datagram_channel(&[0xc0, 0, 0, 0, 0, 0, 0, 1, CHANNEL_CTRL], false),
            Some(CHANNEL_CTRL)
        );
        assert_eq!(
            datagram_channel(&[CHANNEL_DISPLAY_DATAGRAM, 9], true),
            Some(CHANNEL_DISPLAY_DATAGRAM)
        );
        assert_eq!(datagram_channel(&[0x40, 0x41], false), None);
        assert_eq!(datagram_channel(&[], false), None);
        assert_eq!(datagram_channel(&[], true), None);
    }
}
