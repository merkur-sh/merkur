//! Daemon-interior latency attribution, keyed by browser input sequence.
//!
//! # What this closes
//!
//! The browser can already partition its own segment of keystroke-to-pixel
//! exactly, and the daemon has long had a coarse `MERKUR_PERF_LOG` line giving
//! one aggregate `input_to_flush_ms`. Between them sat the largest term in the
//! whole chain as a single opaque number: everything from a keystroke landing
//! here to the display datagram leaving. This splits that into ten contiguous
//! terms, separating the combined PTY/output wait from terminal mutation,
//! coalescing, selection/capture, worker queues, encoding, compression, or the
//! final carrier submission rather than to "the daemon".
//!
//! `input_seq` is the join key and already flows end to end — the browser stamps
//! it, [`crate::connection`] sequences it, and the display encoder stamps it on
//! the way back out. Nothing new has to be correlated.
//!
//! # Why deltas rather than timestamps
//!
//! Records carry microsecond *durations*, never absolute times. The browser and
//! the daemon have unrelated clock origins and no synchronisation between them,
//! so an absolute daemon timestamp would be uninterpretable on the other side —
//! and any attempt to reconcile the two would silently encode the clock offset
//! into whichever sub-term happened to span the boundary.
//!
//! # Cost when nobody is profiling
//!
//! [`PerfTimingTracker::enabled`] is false until a browser asks, and every entry
//! point returns immediately on that check. Enabled, bounded input queues and
//! display-attribution scans retain timing evidence; native PTY boundary events
//! additionally cross a preallocated diagnostic channel. Profiling overhead
//! must be measured rather than assumed negligible.
//!
//! # What the owner was doing
//!
//! Beside its terms, every record carries the owner thread's accounts over the
//! record's span, from [`owner`]: CPU time and off-CPU time inside its busy
//! periods, its contended waits on QUIC connection state, and its waits on the
//! WebTransport registry's lock. A stage that grows under load is then either
//! the owner working, the owner blocked on a named lock, or the owner off the
//! CPU for a reason none of those names.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::{Duration, Instant};

use crate::edge_tunnel::{EDGE_FORWARD_RESIDENCE_BUCKETS, EdgeAdmissions, EdgeContention};
use crate::perf_trace::{self, TraceToken};
use arrayvec::ArrayVec;

/// Bytes on the wire for one record: eighteen big-endian `u32`s.
///
/// Input sequence zero is reserved by the input protocol and identifies the
/// unique display-operation stream. Non-zero sequences are input-weighted
/// causal partitions. Keeping that discriminator in the existing join field
/// leaves room for three records after adding the observation epoch, the two
/// acknowledgment terms and the owner's five accounts.
pub const PERF_TIMING_RECORD_BYTES: usize = 72;

/// An acknowledgment term whose boundary was never observed: the input was
/// never confirmed, its ACK datagram was not sealed or never packetized, or
/// packetization had not happened when the record left. Unreachable as a
/// duration: a record leaves within one batch tail of completing.
pub const PERF_TIMING_UNOBSERVED_US: u32 = u32::MAX;

/// Batch metadata: sequence, cumulative input attributed/dropped/skipped
/// counts, current pending input count, cumulative display attributed/dropped
/// counts, the browser-owned observation epoch, then one record count byte.
/// The control protocol has a one-byte body length.
pub const PERF_TIMING_BATCH_HEADER_BYTES: usize = 33;

/// Largest fixed-record batch that fits the control protocol's 255-byte body.
pub const PERF_TIMING_WIRE_BATCH_RECORDS: usize =
    (u8::MAX as usize - PERF_TIMING_BATCH_HEADER_BYTES) / PERF_TIMING_RECORD_BYTES;

/// Records of each kind retained while bounded reliable CTRL admission is
/// unavailable. Separate bounds prevent sustained display-only output from
/// consuming input-causal evidence; a batch interleaves the two queues
/// one-for-one, so neither stream can starve the other. Sustained typing
/// produces one display record per attributed keystroke; a 4:1 input-first
/// split drained the display queue at a fifth of its fill rate and overflowed
/// this bound within a few hundred keystrokes.
pub const PERF_TIMING_MAX_READY: usize = 256;

/// Maximum time a partial profiling batch waits for more records. Full batches
/// are offered on the next owner-loop turn; a short tail is still delivered
/// promptly without putting a reliable CTRL write back in the display turn.
pub const PERF_TIMING_BATCH_TAIL: Duration = Duration::from_millis(20);

/// In-flight keystrokes retained while waiting for the display frame that
/// reflects them.
///
/// Bounded so a peer that never produces display output — a keystroke swallowed
/// by a full-screen application, say — cannot grow this without limit. Evicting
/// the oldest is right: a keystroke that has been outstanding this long has
/// already lost its causal link to the next frame.
const MAX_PENDING_INPUTS: usize = 256;

#[derive(Debug, Clone, Copy)]
struct InputStamps {
    received_at: Instant,
    /// Set when the bytes entered the bounded PTY FIFO.
    pty_written_at: Option<Instant>,
    /// First owner-loop PTY output handling after this keystroke's enqueue.
    /// This is the existing wire partition, not an actual syscall/echo join.
    /// Native PTY trace records independently expose the missing boundaries.
    ///
    /// Per-keystroke rather than one tracker-wide value. A single shared
    /// timestamp is only correct while keystrokes and reads alternate; the
    /// moment typing outruns shell turnaround it goes stale, and every later
    /// record then measures `read_to_flush` from some earlier keystroke's read
    /// while reporting `pty_to_read` as zero. In production that mis-attributed
    /// ~11% of records, with `read_to_flush_us` p95 reading 645ms against the
    /// 3.13ms the genuine samples showed.
    pty_read_at: Option<Instant>,
    /// Completion of the terminal-grid mutation started by `pty_read_at`.
    grid_applied_at: Option<Instant>,
    /// Acknowledgment boundaries, which run parallel to the echo terms above.
    ack: Option<AckStamps>,
    /// The owner's accounts as the bytes entered the PTY FIFO: where the
    /// record's owner span starts.
    owner_at_write: owner::OwnerStamp,
}

/// The input-acknowledgment half of one keystroke: the owner confirms the PTY
/// write, queues the cumulative ACK, and its datagram twin leaves in a QUIC
/// packet. Stamped as those events happen, which may be after the echo record
/// completed, so they travel beside the record until it leaves.
#[derive(Debug, Clone, Copy)]
struct AckStamps {
    /// Bytes entered the PTY FIFO; the origin of the write-completion term.
    written_at: Instant,
    /// The owner handled the write completion, queueing the cumulative ACK.
    completed_at: Option<Instant>,
    /// The ACK datagram registered for this input's completion.
    datagram: Option<AckWatchRef>,
}

impl AckStamps {
    fn new(written_at: Instant) -> Self {
        Self {
            written_at,
            completed_at: None,
            datagram: None,
        }
    }

    /// Both acknowledgment terms, exact where both boundaries were observed.
    fn terms(self) -> (u32, u32) {
        let Some(completed_at) = self.completed_at else {
            return (PERF_TIMING_UNOBSERVED_US, PERF_TIMING_UNOBSERVED_US);
        };
        // Both ends on the watch's microsecond grid, so the difference is exact
        // to the microsecond rather than off by one truncation.
        let transmit = self
            .datagram
            .and_then(ack_watch::packetized_us)
            .map_or(PERF_TIMING_UNOBSERVED_US, |packetized_us| {
                u32::try_from(
                    packetized_us.saturating_sub(ack_watch::micros_since_origin(completed_at)),
                )
                .unwrap_or(u32::MAX - 1)
            });
        (micros_between(self.written_at, completed_at), transmit)
    }
}

/// Exact monotonic boundaries for the display half of an input attribution.
///
/// The inline and worker paths fill the same boundaries. In the inline path
/// `prepare_queued_at == prepare_started_at` and
/// `prepare_finished_at == completion_started_at`, so the two queue terms are
/// truthfully zero. On the worker path they measure the bounded request and
/// completion queues separately. `compression_time` is accumulated around the
/// complete compression stage; subtracting it from prepare CPU leaves encode,
/// batch, and FEC work without timing overlapping intervals.
#[derive(Debug, Clone, Copy)]
pub struct DisplaySendStamps {
    pub flush_started_at: Instant,
    pub selection_finished_at: Instant,
    pub prepare_queued_at: Instant,
    pub prepare_started_at: Instant,
    pub prepare_finished_at: Instant,
    pub completion_started_at: Instant,
    pub sent_at: Instant,
    pub compression_time: Duration,
    /// An actual carrier admitted a display transformation carrying the
    /// presentation END advisory. False means this operation is only a prefix
    /// of a still-open logical presentation, even when every frame prepared in
    /// this particular attempt was admitted.
    pub presentation_end_admitted: bool,
    /// The owner's accounts at `flush_started_at` and at `sent_at`.
    pub flush_owner: owner::OwnerStamp,
    pub sent_owner: owner::OwnerStamp,
}

/// A display flush's start as attribution records it: the instant its terms
/// are measured from and the owner's accounts at that instant. Travels with
/// the flush's request through the preparation worker.
#[derive(Debug, Clone, Copy)]
pub struct FlushStart {
    pub at: Instant,
    pub owner: owner::OwnerStamp,
}

impl FlushStart {
    /// Read on the owner, at the flush's entry.
    pub fn now() -> Self {
        let at = Instant::now();
        Self {
            at,
            owner: owner::stamp(at),
        }
    }
}

/// One completed input-causal or unique display-operation attribution, ready
/// to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerfTimingRecord {
    /// Non-zero for an input-causal record; zero for a unique display
    /// operation. The authenticated input protocol never admits sequence zero.
    pub input_seq: u32,
    /// Datagram arrival to the bytes entering the PTY FIFO. Daemon ingress.
    pub recv_to_pty_us: u32,
    /// FIFO enqueue to the first owner-loop PTY output handling after it.
    /// Includes writer queueing, application response, physical reading, and
    /// reader/owner dispatch; this partition cannot isolate shell execution
    /// or establish that the output is an echo of this input.
    pub pty_to_read_us: u32,
    /// Owner-loop PTY output handling to parser/grid-mutation completion.
    pub grid_apply_us: u32,
    /// Grid-ready to entry into the selected display flush. This is the
    /// scheduler/coalescing wait (and includes newer PTY work that legitimately
    /// superseded this input before its first authoritative frame).
    pub display_coalesce_us: u32,
    /// Flush entry through hash refresh, row selection, budgeting and capture.
    pub select_capture_us: u32,
    /// Captured request waiting for the display preparation worker. Zero for
    /// header-only and one-row inline preparation.
    pub prepare_queue_us: u32,
    /// Encode, batching, framing and FEC CPU, excluding the compression stage.
    pub encode_us: u32,
    /// Validation, dictionary selection, capacity preparation, zstd, and
    /// rejected compression candidates. Zero when compression was not attempted.
    pub compression_us: u32,
    /// Prepared worker completion waiting for the daemon owner loop. Zero for
    /// inline preparation.
    pub completion_queue_us: u32,
    /// Owner completion admission, encryption/sealing, and carrier submission.
    pub transport_submit_us: u32,
    /// FIFO enqueue to the owner handling this input's PTY write completion,
    /// which queues its cumulative ACK: writer thread and owner wake.
    pub write_completion_us: u32,
    /// That handling to the QUIC packetization of the ACK datagram twin: the
    /// rest of the owner turn, the connection driver's wake and its packet
    /// admission. With `recv_to_pty_us` and `write_completion_us` this is the
    /// daemon's whole share of the browser's input-ACK time. Neither
    /// acknowledgment term belongs to the ten-term echo partition.
    pub ack_transmit_us: u32,
    /// The owner over this record's span: PTY FIFO enqueue to carrier
    /// submission for an input record, the flush for a display operation.
    /// Beside the partition, never inside it.
    pub owner: OwnerTerms,
}

/// The owner thread over one record's span.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OwnerTerms {
    /// CPU time inside the owner's busy periods.
    pub cpu_us: u32,
    /// Wall time inside those busy periods off the CPU: blocked in a lock or a
    /// system call, or descheduled.
    pub off_cpu_us: u32,
    /// Contended acquisitions of QUIC connection state. Blocking, so also
    /// inside `off_cpu_us`.
    pub quinn_wait_us: u32,
    /// Acquisitions of the WebTransport registry's lock a writer delayed. An
    /// async wait: the owner is idle meanwhile, not busy.
    pub registry_wait_us: u32,
    /// Both waits inside the flush alone, flush start to carrier submission.
    pub flush_lock_wait_us: u32,
}

impl OwnerTerms {
    fn between(
        start: owner::OwnerStamp,
        flush: owner::OwnerStamp,
        sent: owner::OwnerStamp,
    ) -> Self {
        let span = sent.since(start);
        let flush = sent.since(flush);
        Self {
            cpu_us: span.cpu_us,
            off_cpu_us: span.off_cpu_us,
            quinn_wait_us: span.quinn_wait_us,
            registry_wait_us: span.registry_wait_us,
            flush_lock_wait_us: flush.quinn_wait_us.saturating_add(flush.registry_wait_us),
        }
    }
}

impl PerfTimingRecord {
    fn is_display_operation(&self) -> bool {
        self.input_seq == 0
    }

    pub fn encode_into(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.input_seq.to_be_bytes());
        out.extend_from_slice(&self.recv_to_pty_us.to_be_bytes());
        out.extend_from_slice(&self.pty_to_read_us.to_be_bytes());
        out.extend_from_slice(&self.grid_apply_us.to_be_bytes());
        out.extend_from_slice(&self.display_coalesce_us.to_be_bytes());
        out.extend_from_slice(&self.select_capture_us.to_be_bytes());
        out.extend_from_slice(&self.prepare_queue_us.to_be_bytes());
        out.extend_from_slice(&self.encode_us.to_be_bytes());
        out.extend_from_slice(&self.compression_us.to_be_bytes());
        out.extend_from_slice(&self.completion_queue_us.to_be_bytes());
        out.extend_from_slice(&self.transport_submit_us.to_be_bytes());
        out.extend_from_slice(&self.write_completion_us.to_be_bytes());
        out.extend_from_slice(&self.ack_transmit_us.to_be_bytes());
        out.extend_from_slice(&self.owner.cpu_us.to_be_bytes());
        out.extend_from_slice(&self.owner.off_cpu_us.to_be_bytes());
        out.extend_from_slice(&self.owner.quinn_wait_us.to_be_bytes());
        out.extend_from_slice(&self.owner.registry_wait_us.to_be_bytes());
        out.extend_from_slice(&self.owner.flush_lock_wait_us.to_be_bytes());
    }
}

/// What the owner thread did with its time, for attribution while profiled.
///
/// The owner loop is `block_on`'s future on the process's main thread. Every
/// poll of it is a busy period and the time between polls is idle: the loop
/// waits for events, or for an async lock. While a browser profiles, each busy
/// period's wall time and thread CPU time accumulate ([`Turns`]), so wall less
/// CPU is the time the owner had work and was blocked or descheduled. Two
/// waits are charged where they occur: a contended acquisition of a QUIC
/// connection's state lock (the Quinn patch times it on this thread only) and
/// an acquisition of the WebTransport registry's lock a writer delayed
/// ([`registry_wait`]). A stamp reads every account at one instant, including
/// the running busy period, and a record differences two stamps.
///
/// Off unless profiling: an unobserved thread reads no clock anywhere here,
/// and an uncontended lock never does.
pub mod owner {
    use std::cell::Cell;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Instant;

    thread_local! {
        static LEDGER: Ledger = const { Ledger::new() };
    }

    struct Ledger {
        observed: Cell<bool>,
        /// Completed busy periods.
        busy_wall_ns: Cell<u64>,
        busy_cpu_ns: Cell<u64>,
        /// The running busy period's start and the thread CPU time then.
        period: Cell<Option<(Instant, u64)>>,
        registry_wait_ns: Cell<u64>,
    }

    impl Ledger {
        const fn new() -> Self {
            Self {
                observed: Cell::new(false),
                busy_wall_ns: Cell::new(0),
                busy_cpu_ns: Cell::new(0),
                period: Cell::new(None),
                registry_wait_ns: Cell::new(0),
            }
        }
    }

    /// Every account at one instant, cumulative for this thread.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct OwnerStamp {
        pub busy_wall_ns: u64,
        pub busy_cpu_ns: u64,
        pub quinn_wait_ns: u64,
        pub registry_wait_ns: u64,
    }

    /// Two stamps' difference in record units, saturating.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct OwnerSpan {
        pub cpu_us: u32,
        pub off_cpu_us: u32,
        pub quinn_wait_us: u32,
        pub registry_wait_us: u32,
    }

    impl OwnerStamp {
        pub fn since(self, earlier: Self) -> OwnerSpan {
            let micros = |ns: u64| u32::try_from(ns / 1_000).unwrap_or(u32::MAX);
            let wall = self.busy_wall_ns.saturating_sub(earlier.busy_wall_ns);
            let cpu = self.busy_cpu_ns.saturating_sub(earlier.busy_cpu_ns);
            OwnerSpan {
                cpu_us: micros(cpu),
                off_cpu_us: micros(wall.saturating_sub(cpu)),
                quinn_wait_us: micros(self.quinn_wait_ns.saturating_sub(earlier.quinn_wait_ns)),
                registry_wait_us: micros(
                    self.registry_wait_ns
                        .saturating_sub(earlier.registry_wait_ns),
                ),
            }
        }
    }

    /// This thread's CPU time. The clock read is a system call on Linux and
    /// about 180 ns on macOS; only an observed owner ever pays it.
    fn thread_cpu_ns() -> u64 {
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `now` is a valid out-pointer for the call's duration.
        let result = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) };
        if result != 0 {
            return 0;
        }
        u64::try_from(now.tv_sec)
            .unwrap_or(0)
            .saturating_mul(1_000_000_000)
            .saturating_add(u64::try_from(now.tv_nsec).unwrap_or(0))
    }

    fn nanos(from: Instant, to: Instant) -> u64 {
        u64::try_from(to.saturating_duration_since(from).as_nanos()).unwrap_or(u64::MAX)
    }

    /// Start or stop observing this thread: its busy periods, its contended
    /// QUIC connection-state acquisitions, its registry waits. Called by the
    /// profiler's owner on the owner thread.
    pub fn observe(enabled: bool) {
        LEDGER.with(|ledger| {
            ledger.observed.set(enabled);
            if !enabled {
                ledger.period.set(None);
            }
        });
        wtransport::quinn::contention::observe(enabled);
    }

    /// Every account now, `at` being this instant's wall clock reading.
    pub fn stamp(at: Instant) -> OwnerStamp {
        LEDGER.with(|ledger| {
            let mut stamp = OwnerStamp {
                busy_wall_ns: ledger.busy_wall_ns.get(),
                busy_cpu_ns: ledger.busy_cpu_ns.get(),
                quinn_wait_ns: u64::try_from(
                    wtransport::quinn::contention::waited().as_nanos(),
                )
                .unwrap_or(u64::MAX),
                registry_wait_ns: ledger.registry_wait_ns.get(),
            };
            if let Some((started, cpu_started)) = ledger.period.get() {
                stamp.busy_wall_ns = stamp.busy_wall_ns.saturating_add(nanos(started, at));
                stamp.busy_cpu_ns = stamp
                    .busy_cpu_ns
                    .saturating_add(thread_cpu_ns().saturating_sub(cpu_started));
            }
            stamp
        })
    }

    /// Times one registry acquisition until dropped, when this thread is the
    /// observed owner; otherwise inert.
    pub struct RegistryWait(Option<Instant>);

    pub fn registry_wait() -> RegistryWait {
        RegistryWait(
            LEDGER
                .with(|ledger| ledger.observed.get())
                .then(Instant::now),
        )
    }

    impl Drop for RegistryWait {
        fn drop(&mut self) {
            if let Some(started) = self.0 {
                let waited = nanos(started, Instant::now());
                LEDGER.with(|ledger| {
                    ledger
                        .registry_wait_ns
                        .set(ledger.registry_wait_ns.get().saturating_add(waited));
                });
            }
        }
    }

    /// The owner loop's future: each poll is one busy period, accounted while
    /// observed.
    pub struct Turns<F>(pub F);

    impl<F: Future + Unpin> Future for Turns<F> {
        type Output = F::Output;

        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            LEDGER.with(|ledger| {
                if ledger.observed.get() {
                    ledger.period.set(Some((Instant::now(), thread_cpu_ns())));
                }
            });
            let result = Pin::new(&mut self.0).poll(cx);
            LEDGER.with(|ledger| {
                if let Some((started, cpu_started)) = ledger.period.take() {
                    ledger
                        .busy_wall_ns
                        .set(ledger.busy_wall_ns.get().saturating_add(nanos(started, Instant::now())));
                    ledger.busy_cpu_ns.set(
                        ledger
                            .busy_cpu_ns
                            .get()
                            .saturating_add(thread_cpu_ns().saturating_sub(cpu_started)),
                    );
                }
            });
            result
        }
    }
}

/// ACK datagrams awaiting packetization, found by their sealed payload's AEAD
/// tag. The QUIC datagram observer fills a slot on a connection driver while
/// profiling is active; the owner reads it when a covered record leaves.
///
/// A resource bound: each owner turn that confirms input takes the next slot,
/// so sixteen bounds the ACKs that can be sent while one record waits to
/// leave. A slot reused before its record left resolves to unobserved, never
/// to its successor: every write and read is checked against the tag it was
/// taken for.
mod ack_watch {
    use super::{AckWatchRef, AtomicU64, Instant, OnceLock, Ordering};

    pub(super) const SLOTS: usize = 16;

    struct Slot {
        /// First eight AEAD-tag bytes of the watched datagram; zero is vacant.
        tag: AtomicU64,
        /// Microseconds since `ORIGIN` shifted past the tag's low sixteen bits,
        /// so a packetization racing a reuse cannot resolve the successor.
        packetized: AtomicU64,
    }

    static WATCH: [Slot; SLOTS] = [const {
        Slot {
            tag: AtomicU64::new(0),
            packetized: AtomicU64::new(0),
        }
    }; SLOTS];
    static ORIGIN: OnceLock<Instant> = OnceLock::new();

    /// Fix the origin before any watched datagram exists, so every
    /// packetization instant the observer stamps lies after it.
    pub(super) fn start() {
        let _ = ORIGIN.get_or_init(Instant::now);
    }

    pub(super) fn micros_since_origin(at: Instant) -> u64 {
        let origin = *ORIGIN.get_or_init(Instant::now);
        u64::try_from(at.saturating_duration_since(origin).as_micros())
            .unwrap_or(u64::MAX >> 16)
            .min(u64::MAX >> 16)
    }

    /// First eight bytes of the AEAD tag that ends a sealed datagram payload.
    pub(crate) fn tag(sealed: &[u8]) -> Option<u64> {
        let at = sealed.len().checked_sub(16)?;
        let tag = u64::from_le_bytes(sealed[at..at + 8].try_into().ok()?);
        (tag != 0).then_some(tag)
    }

    /// Owner only, before the datagram is offered to any carrier: a driver can
    /// packetize it before the send call returns.
    pub(super) fn watch(slot: usize, tag: u64) -> AckWatchRef {
        start();
        let index = slot % SLOTS;
        let watched = &WATCH[index];
        watched.tag.store(0, Ordering::Release);
        watched.packetized.store(0, Ordering::Release);
        watched.tag.store(tag, Ordering::Release);
        AckWatchRef { index, tag }
    }

    /// The datagram observer, on the connection driver that built the packet.
    pub(crate) fn packetized(payload: &[u8], at: Instant) {
        let Some(tag) = tag(payload) else {
            return;
        };
        if let Some(watched) = WATCH
            .iter()
            .find(|watched| watched.tag.load(Ordering::Acquire) == tag)
        {
            // First packetization wins; a datagram is never retransmitted.
            let _ = watched.packetized.compare_exchange(
                0,
                (micros_since_origin(at) << 16) | (tag & 0xffff),
                Ordering::AcqRel,
                Ordering::Relaxed,
            );
        }
    }

    /// Microseconds since `ORIGIN` at which the watched datagram was packetized.
    pub(super) fn packetized_us(ack: AckWatchRef) -> Option<u64> {
        let watched = &WATCH[ack.index];
        if watched.tag.load(Ordering::Acquire) != ack.tag {
            return None;
        }
        let packetized = watched.packetized.load(Ordering::Acquire);
        if packetized == 0 || packetized & 0xffff != ack.tag & 0xffff {
            return None;
        }
        Some(packetized >> 16)
    }
}
pub(crate) use ack_watch::{packetized as observe_ack_packetized, tag as ack_datagram_tag};

/// One registered ACK datagram: its watch slot and the tag it was taken for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AckWatchRef {
    index: usize,
    tag: u64,
}

/// Bytes on the wire for one egress snapshot: big-endian u32 identities,
/// refusal counters and residence buckets, then both models (five u64 gauges
/// and nine u32 identity, phase and counter words each).
pub const PERF_EGRESS_BYTES: usize =
    4 + 2 * 4 + 4 * 3 * 4 + 4 * EDGE_FORWARD_RESIDENCE_BUCKETS + 2 * 76;

/// Cumulative refusals of one traffic class at one egress hop. Modular `u32`
/// on the wire: the browser differences consecutive snapshots of one counter
/// identity, so a wrap is exact and only a changed identity is a new group.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EgressRefusals {
    pub blocked: u32,
    pub paced: u32,
    pub waited_us: u32,
}

impl EgressRefusals {
    fn from_daemon(admissions: wtransport::quinn::EgressAdmissions) -> Self {
        Self {
            blocked: admissions.blocked as u32,
            paced: admissions.paced as u32,
            waited_us: admissions.waited.as_micros() as u32,
        }
    }

    fn from_edge(admissions: EdgeAdmissions) -> Self {
        Self {
            blocked: admissions.blocked as u32,
            paced: admissions.paced as u32,
            waited_us: admissions.waited_us as u32,
        }
    }

    fn encode_into(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.blocked.to_be_bytes());
        out.extend_from_slice(&self.paced.to_be_bytes());
        out.extend_from_slice(&self.waited_us.to_be_bytes());
    }
}

/// Profiling snapshot. Gauges are bytes/second, microseconds or bytes; counters
/// are modular u32 within the model epoch, which changes on a path reset.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerfEgressModel {
    pub epoch: u32,
    pub bw: u64,
    pub rtprop_us: u64,
    pub pacing_rate: u64,
    pub bulk_cap: u64,
    pub quantum: u64,
    pub phase: u32,
    pub probes_gated: u32,
    pub probes_aborted: u32,
    pub interactive_in_probe: u32,
    pub queue_growth_cuts: u32,
    pub loss_rounds: u32,
    pub ce_rounds: u32,
    pub probe_rtts: u32,
}

impl PerfEgressModel {
    fn from_stats(stats: wtransport::quinn::EgressStats) -> Self {
        Self {
            epoch: stats.model_epoch as u32,
            bw: stats.bw,
            rtprop_us: stats.rtprop_us,
            pacing_rate: stats.pacing_rate,
            bulk_cap: stats.bulk_cap,
            quantum: stats.quantum,
            phase: stats.phase as u32,
            probes_gated: stats.model.probes_gated as u32,
            probes_aborted: stats.model.probes_aborted as u32,
            interactive_in_probe: stats.model.interactive_in_probe as u32,
            queue_growth_cuts: stats.model.queue_growth_cuts as u32,
            loss_rounds: stats.model.loss_rounds as u32,
            ce_rounds: stats.model.ce_rounds as u32,
            probe_rtts: stats.model.probe_rtts as u32,
        }
    }
}

impl PerfEgressModel {
    fn encode_into(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.epoch.to_be_bytes());
        out.extend_from_slice(&self.bw.to_be_bytes());
        out.extend_from_slice(&self.rtprop_us.to_be_bytes());
        out.extend_from_slice(&self.pacing_rate.to_be_bytes());
        out.extend_from_slice(&self.bulk_cap.to_be_bytes());
        out.extend_from_slice(&self.quantum.to_be_bytes());
        out.extend_from_slice(&self.phase.to_be_bytes());
        out.extend_from_slice(&self.probes_gated.to_be_bytes());
        out.extend_from_slice(&self.probes_aborted.to_be_bytes());
        out.extend_from_slice(&self.interactive_in_probe.to_be_bytes());
        out.extend_from_slice(&self.queue_growth_cuts.to_be_bytes());
        out.extend_from_slice(&self.loss_rounds.to_be_bytes());
        out.extend_from_slice(&self.ce_rounds.to_be_bytes());
        out.extend_from_slice(&self.probe_rtts.to_be_bytes());
    }
}

/// Where packets waited at the two egress hops Merkur owns: the daemon's
/// aggregate group on the owner's primary carrier and, on the relay path, the
/// edge's browser-facing group and datagram residence from its latest quote.
/// Zero where no group exists yet, as before any image transfer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PerfEgressSnapshot {
    /// Identity of the daemon group counted below; zero before one exists.
    pub daemon_group: u32,
    /// Identity of the edge counters below: the browser attachment whose
    /// quote carried them, zero before any.
    pub edge_attachment: u32,
    pub daemon_interactive: EgressRefusals,
    pub daemon_bulk: EgressRefusals,
    pub edge_interactive: EgressRefusals,
    pub edge_bulk: EgressRefusals,
    pub edge_forward_residence: [u32; EDGE_FORWARD_RESIDENCE_BUCKETS],
    pub daemon_model: PerfEgressModel,
    pub edge_model: PerfEgressModel,
}

impl PerfEgressSnapshot {
    pub fn new(
        daemon: Option<wtransport::quinn::EgressStats>,
        edge: Option<EdgeContention>,
    ) -> Self {
        let (daemon_group, daemon_interactive, daemon_bulk) =
            daemon.map_or_else(Default::default, |stats| {
                (
                    stats.group as u32,
                    EgressRefusals::from_daemon(stats.interactive),
                    EgressRefusals::from_daemon(stats.bulk),
                )
            });
        let edge = edge.unwrap_or_default();
        Self {
            daemon_group,
            edge_attachment: edge.attachment as u32,
            daemon_interactive,
            daemon_bulk,
            edge_interactive: EgressRefusals::from_edge(edge.interactive),
            edge_bulk: EgressRefusals::from_edge(edge.bulk),
            edge_forward_residence: edge.forward_residence,
            daemon_model: daemon.map(PerfEgressModel::from_stats).unwrap_or_default(),
            edge_model: edge.model.unwrap_or_default(),
        }
    }
}

pub fn encode_perf_egress(snapshot: &PerfEgressSnapshot, observation_epoch: u32) -> Vec<u8> {
    let mut body = Vec::with_capacity(PERF_EGRESS_BYTES);
    body.extend_from_slice(&observation_epoch.to_be_bytes());
    body.extend_from_slice(&snapshot.daemon_group.to_be_bytes());
    body.extend_from_slice(&snapshot.edge_attachment.to_be_bytes());
    snapshot.daemon_interactive.encode_into(&mut body);
    snapshot.daemon_bulk.encode_into(&mut body);
    snapshot.edge_interactive.encode_into(&mut body);
    snapshot.edge_bulk.encode_into(&mut body);
    for bucket in snapshot.edge_forward_residence {
        body.extend_from_slice(&bucket.to_be_bytes());
    }
    snapshot.daemon_model.encode_into(&mut body);
    snapshot.edge_model.encode_into(&mut body);
    body
}

/// Whether this process profiles. One authenticated profiler owns attribution
/// at a time; each edge tunnel mirrors this onto its delivery-quote stream, so
/// the edge gathers contention evidence exactly while someone profiles.
static PROFILING: LazyLock<tokio::sync::watch::Sender<bool>> =
    LazyLock::new(|| tokio::sync::watch::channel(false).0);

/// This process's profiling state and its changes.
pub(crate) fn profiling() -> tokio::sync::watch::Receiver<bool> {
    PROFILING.subscribe()
}

fn publish_profiling(enabled: bool) {
    PROFILING.send_if_modified(|profiling| std::mem::replace(profiling, enabled) != enabled);
}

/// Saturating microsecond delta. A non-monotonic pair yields zero rather than a
/// wrapped enormous value, which would poison a percentile.
fn micros_between(earlier: Instant, later: Instant) -> u32 {
    later
        .checked_duration_since(earlier)
        .map_or(0, |d| u32::try_from(d.as_micros()).unwrap_or(u32::MAX))
}

#[derive(Debug)]
pub struct PerfTimingTracker {
    enabled: bool,
    trace_token: Option<TraceToken>,
    /// Exact authenticated session that enabled collection and owns delivery.
    /// A replacement reusing the browser node id must not inherit samples or
    /// nonce state from its predecessor.
    owner: Option<PerfTimingOwner>,
    /// Arrival order, not numeric order: input sequence wraps at `u32::MAX`.
    pending: VecDeque<(u32, InputStamps)>,
    /// Earliest completed grid mutation in the logical presentation whose END
    /// has not yet entered a carrier. Every admitted continuation is measured
    /// from this same origin; consuming it on the first partial prefix hid the
    /// exact late-row tail that profiling exists to expose.
    open_presentation_grid_applied_at: Option<Instant>,
    input_ready: VecDeque<PerfTimingRecord>,
    /// Acknowledgment stamps of the not-yet-sent `input_ready` records, in the
    /// same arrival order. A restored record already carries its terms.
    ack_ready: VecDeque<(u32, AckStamps)>,
    display_ready: VecDeque<PerfTimingRecord>,
    next_batch_seq: u32,
    /// Watch slot the next registered ACK datagram takes.
    next_ack_slot: usize,
    /// The egress snapshot a reliable carrier last admitted this observation.
    egress_sent: Option<PerfEgressSnapshot>,
    attributed_total: u32,
    dropped_total: u32,
    skipped_total: u32,
    display_attributed_total: u32,
    display_dropped_total: u32,
    /// Status attached to the most recently accepted reliable batch. Comparing
    /// this with the live counters lets an all-skipped or all-dropped tail emit
    /// a zero-record batch exactly once instead of disappearing from the trace.
    accepted_status: PerfTimingStatus,
    /// Owner-loop deadline for the next single reliable batch. `None` while a
    /// batch is being offered prevents two sends in one maintenance turn.
    wire_deadline: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PerfTimingOwner {
    peer_id: Arc<str>,
    signal_session_id: String,
    observation_epoch: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PerfTimingStatus {
    pub attributed_total: u32,
    pub dropped_total: u32,
    pub skipped_total: u32,
    pub pending_total: u32,
    pub display_attributed_total: u32,
    pub display_dropped_total: u32,
}

impl Default for PerfTimingTracker {
    fn default() -> Self {
        Self {
            enabled: false,
            trace_token: None,
            owner: None,
            pending: VecDeque::with_capacity(MAX_PENDING_INPUTS),
            open_presentation_grid_applied_at: None,
            input_ready: VecDeque::with_capacity(PERF_TIMING_MAX_READY),
            ack_ready: VecDeque::with_capacity(PERF_TIMING_MAX_READY),
            display_ready: VecDeque::with_capacity(PERF_TIMING_MAX_READY),
            next_batch_seq: 1,
            next_ack_slot: 0,
            egress_sent: None,
            attributed_total: 0,
            dropped_total: 0,
            skipped_total: 0,
            display_attributed_total: 0,
            display_dropped_total: 0,
            accepted_status: PerfTimingStatus::default(),
            wire_deadline: None,
        }
    }
}

#[derive(Debug)]
pub struct PerfTimingBatch {
    pub batch_seq: u32,
    pub attributed_total: u32,
    pub dropped_total: u32,
    pub skipped_total: u32,
    pub pending_total: u32,
    pub display_attributed_total: u32,
    pub display_dropped_total: u32,
    pub observation_epoch: u32,
    pub records: ArrayVec<PerfTimingRecord, PERF_TIMING_WIRE_BATCH_RECORDS>,
}

impl PerfTimingTracker {
    /// Whether a browser has asked for input-to-display attribution.
    ///
    /// The display flush reads this before sampling a real `Instant`, so the
    /// common case — nobody asking — pays no clock read at all.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn configure(
        &mut self,
        peer_id: Arc<str>,
        signal_session_id: &str,
        enabled: bool,
        observation_epoch: u32,
    ) {
        debug_assert_ne!(observation_epoch, 0);
        let caller_identity_matches = self.owner.as_ref().is_some_and(|owner| {
            owner.peer_id.as_ref() == peer_id.as_ref()
                && owner.signal_session_id == signal_session_id
        });
        if caller_identity_matches {
            let current_epoch = self
                .owner
                .as_ref()
                .expect("matching owner identity must exist")
                .observation_epoch;
            // CTRL is reliable per carrier, but the logical lane can move
            // between live carriers. Its AEAD replay window deliberately
            // accepts reordering, so arrival order is not an observation
            // boundary: an older enable/disable must not replace a newer
            // recorder epoch. Browser epochs are a non-zero wrapping counter;
            // RFC 1982's half range gives the same ordering used by display
            // and input sequence spaces.
            if observation_epoch != current_epoch
                && !serial_is_newer(observation_epoch, current_epoch)
            {
                return;
            }
            if observation_epoch == current_epoch && self.enabled == enabled {
                return;
            }
        }
        // One authenticated profiler owns the process-wide PTY attribution at
        // a time. A new owner or browser reset epoch is a hard observation
        // boundary. A different peer cannot disable the current owner. Keep
        // the last matching identity and epoch even while disabled: otherwise
        // a delayed enable from before the disable could resurrect a stale
        // observation after its samples were discarded.
        if !enabled && !caller_identity_matches {
            return;
        }
        self.reset_samples();
        if let Some(token) = self.trace_token.take() {
            perf_trace::end(token);
        }
        if enabled {
            ack_watch::start();
        }
        self.enabled = enabled;
        publish_profiling(enabled);
        // The tracker lives on the owner loop, so this is the owner thread.
        owner::observe(enabled);
        self.trace_token = enabled
            .then(|| perf_trace::begin(&peer_id, signal_session_id, observation_epoch))
            .flatten();
        self.owner = Some(PerfTimingOwner {
            peer_id,
            signal_session_id: signal_session_id.to_owned(),
            observation_epoch,
        });
    }

    /// Clear a profiler whose authenticated peer/session owner disappeared.
    pub fn clear_owner(&mut self) {
        self.reset_samples();
        if let Some(token) = self.trace_token.take() {
            perf_trace::end(token);
        }
        self.enabled = false;
        publish_profiling(false);
        owner::observe(false);
        self.owner = None;
    }

    fn reset_samples(&mut self) {
        // Partial state carried across an owner boundary would produce records
        // spanning two authenticated sessions.
        self.pending.clear();
        self.open_presentation_grid_applied_at = None;
        self.input_ready.clear();
        self.ack_ready.clear();
        self.display_ready.clear();
        self.egress_sent = None;
        self.next_batch_seq = 1;
        self.attributed_total = 0;
        self.dropped_total = 0;
        self.skipped_total = 0;
        self.display_attributed_total = 0;
        self.display_dropped_total = 0;
        self.accepted_status = PerfTimingStatus::default();
        self.wire_deadline = None;
    }

    pub fn owns(&self, peer_id: &str, signal_session_id: &str) -> bool {
        self.enabled
            && self.owner.as_ref().is_some_and(|owner| {
                owner.peer_id.as_ref() == peer_id && owner.signal_session_id == signal_session_id
            })
    }

    pub fn owner_peer_id(&self) -> Option<&Arc<str>> {
        self.enabled.then_some(&self.owner.as_ref()?.peer_id)
    }

    /// Immutable native recorder ownership. Queued PTY work retains this token
    /// across disable, session replacement, and observation-epoch changes.
    pub fn trace_token(&self) -> Option<TraceToken> {
        self.trace_token
    }

    /// Reordered input carries no diagnostic ownership of its own. Only a
    /// receive stamped in this exact observation may tag its eventual write;
    /// otherwise an old buffered input could be attributed to a new recorder.
    pub fn trace_token_for_pending_input(&self, seq: u32) -> Option<TraceToken> {
        let token = self.trace_token?;
        self.pending
            .iter()
            .any(|(pending, _)| *pending == seq)
            .then_some(token)
    }

    /// Browser-owned observation epoch of the currently authenticated
    /// profiler. Convergence probes must match it exactly before they may make
    /// the daemon traverse the authoritative grid.
    pub fn observation_epoch(&self) -> Option<u32> {
        self.enabled
            .then_some(self.owner.as_ref()?.observation_epoch)
    }

    pub fn next_wire_deadline(&self) -> Option<Instant> {
        self.wire_deadline
    }

    fn arm_wire_update(&mut self, now: Instant) {
        if !self.has_wire_update() {
            self.wire_deadline = None;
            return;
        }
        let ready = self.input_ready.len() + self.display_ready.len();
        let candidate = if ready >= PERF_TIMING_WIRE_BATCH_RECORDS {
            now
        } else {
            now + PERF_TIMING_BATCH_TAIL
        };
        self.wire_deadline = Some(
            self.wire_deadline
                .map_or(candidate, |deadline| deadline.min(candidate)),
        );
    }

    #[cfg(test)]
    pub fn note_input_received_for(
        &mut self,
        peer_id: &str,
        signal_session_id: &str,
        seq: u32,
        at: Instant,
    ) {
        if !self.owns(peer_id, signal_session_id) {
            return;
        }
        self.note_input_received_owned(seq, at);
    }

    /// Record after the caller validated [`Self::owns`] against the live peer.
    /// This split lets the PTY reorder callback retain a `Copy` boolean instead
    /// of cloning the session id into every keystroke closure.
    pub fn note_input_received_owned(&mut self, seq: u32, at: Instant) {
        debug_assert!(self.enabled);
        // Zero is the protocol's cumulative "no input" sentinel and the wire
        // discriminator for an operation-weighted display record. A replay of
        // zero is rejected by the input sequencer; do not let its pre-apply
        // timing hook manufacture a display record.
        if seq == 0 {
            return;
        }
        if self.pending.len() >= MAX_PENDING_INPUTS {
            self.pending.pop_front();
            self.dropped_total = self.dropped_total.saturating_add(1);
        }
        self.pending.push_back((
            seq,
            InputStamps {
                received_at: at,
                pty_written_at: None,
                pty_read_at: None,
                grid_applied_at: None,
                ack: None,
                owner_at_write: owner::OwnerStamp::default(),
            },
        ));
        self.arm_wire_update(at);
    }

    #[cfg(test)]
    pub fn note_pty_write_for(
        &mut self,
        peer_id: &str,
        signal_session_id: &str,
        seq: u32,
        at: Instant,
    ) {
        if !self.owns(peer_id, signal_session_id) {
            return;
        }
        self.note_pty_write_owned(seq, at);
    }

    /// FIFO-enqueue counterpart to [`Self::note_input_received_owned`]. The
    /// historical method/field names do not denote successful kernel delivery.
    pub fn note_pty_write_owned(&mut self, seq: u32, at: Instant) {
        self.note_pty_write_stamped(seq, at, owner::stamp(at));
    }

    /// [`Self::note_pty_write_owned`] with the owner's accounts already read.
    fn note_pty_write_stamped(&mut self, seq: u32, at: Instant, owner: owner::OwnerStamp) {
        debug_assert!(self.enabled);
        if let Some((_, entry)) = self
            .pending
            .iter_mut()
            .rev()
            .find(|(pending, _)| *pending == seq)
        {
            entry.pty_written_at = Some(at);
            entry.ack = Some(AckStamps::new(at));
            entry.owner_at_write = owner;
        }
    }

    /// The owner handled this input's PTY write completion and queued its
    /// cumulative ACK. Completions arrive in per-peer FIFO order, usually
    /// before the echo record completes, but the record may already be ready.
    pub fn note_pty_write_completed_owned(&mut self, seq: u32, at: Instant) {
        debug_assert!(self.enabled);
        let stamps = self
            .pending
            .iter_mut()
            .rev()
            .find(|(pending, _)| *pending == seq)
            .and_then(|(_, entry)| entry.ack.as_mut())
            .or_else(|| {
                self.ack_ready
                    .iter_mut()
                    .rev()
                    .find(|(ready, _)| *ready == seq)
                    .map(|(_, stamps)| stamps)
            });
        if let Some(stamps) = stamps {
            stamps.completed_at.get_or_insert(at);
        }
    }

    /// The owner is about to offer the datagram twin of a cumulative ACK whose
    /// sealed payload ends in `tag`. Every completed input it covers that no
    /// earlier ACK carried is measured to this datagram's packetization.
    pub fn note_input_ack_sent(&mut self, ack_seq: u32, tag: u64) {
        debug_assert!(self.enabled);
        let datagram = ack_watch::watch(self.next_ack_slot, tag);
        self.next_ack_slot = (self.next_ack_slot + 1) % ack_watch::SLOTS;
        // Completions are FIFO, so the uncovered completed inputs are a suffix
        // of each queue: walk back to the first one an earlier ACK carried.
        let pending = self
            .pending
            .iter_mut()
            .filter(|(seq, _)| serial_at_or_before(*seq, ack_seq))
            .filter_map(|(_, entry)| entry.ack.as_mut());
        let ready = self
            .ack_ready
            .iter_mut()
            .filter(|(seq, _)| serial_at_or_before(*seq, ack_seq))
            .map(|(_, stamps)| stamps);
        for stamps in pending.rev().chain(ready.rev()) {
            if stamps.completed_at.is_none() {
                continue;
            }
            if stamps.datagram.is_some() {
                break;
            }
            stamps.datagram = Some(datagram);
        }
    }

    /// An input record that encoded to nothing (a key release no keyboard mode
    /// reports) wrote no bytes, so no read can answer it: it leaves the
    /// partition rather than waiting on a turnaround that never starts.
    pub fn note_input_silent_owned(&mut self, seq: u32) {
        debug_assert!(self.enabled);
        if let Some(index) = self
            .pending
            .iter()
            .rposition(|(pending, _)| *pending == seq)
        {
            self.pending.remove(index);
        }
    }

    pub fn note_pty_read(&mut self, at: Instant) {
        if !self.enabled {
            return;
        }
        // Partition every input already enqueued against this owner handling
        // boundary. This does NOT prove echo causality: bytes may have been
        // physically read before enqueue and waited in the owner queue, and
        // the writer may still be blocked. Native trace records keep those
        // independent boundaries rather than calling their residual "shell".
        //
        // Those entries are a suffix of the map: `seq` is monotonic, writes
        // follow that order, and anything older was answered by an earlier
        // read. Walking back until the first already-answered entry therefore
        // costs one step in the steady state instead of scanning all 256.
        //
        // Stamping once per entry also preserves the property the old
        // `awaiting_read` flag existed for — only the *first* read after a
        // enqueue ends this historical partition — because a later read in the same burst
        // finds `pty_read_at` already set and stops.
        for (_, stamps) in self.pending.iter_mut().rev() {
            if stamps.pty_read_at.is_some() {
                break;
            }
            // Received but not yet written: no turnaround has started, so this
            // read does not answer it. Keep walking — older entries may still
            // be unanswered.
            if stamps.pty_written_at.is_none() {
                continue;
            }
            stamps.pty_read_at = Some(at);
        }
    }

    /// Close the terminal-mutation term for every input answered by the most
    /// recent PTY read. Called immediately after `TerminalState::apply_bytes`.
    pub fn note_grid_applied(&mut self, at: Instant) {
        if !self.enabled {
            return;
        }
        // Keep the earliest mutation until a carrier actually admits the END
        // transform. A later PTY read while a clipped/offloaded continuation is
        // open belongs to the same visible completion tail and must not move
        // its origin forward.
        self.open_presentation_grid_applied_at.get_or_insert(at);
        for (_, stamps) in self.pending.iter_mut().rev() {
            if stamps.grid_applied_at.is_some() {
                break;
            }
            if stamps.pty_read_at.is_none() {
                continue;
            }
            stamps.grid_applied_at = Some(at);
        }
    }

    /// Complete every record causally covered by `input_seq`.
    ///
    /// Everything at or below `input_seq` is retired: display frames advertise a
    /// cumulative causal barrier, so an older keystroke that never got its own
    /// frame is covered by this one and will never complete on its own.
    pub fn note_display_sent_for(
        &mut self,
        peer_id: &str,
        signal_session_id: &str,
        input_seq: u32,
        display: DisplaySendStamps,
    ) {
        if !self.owns(peer_id, signal_session_id) {
            return;
        }
        let prepare_total_us =
            micros_between(display.prepare_started_at, display.prepare_finished_at);
        let compression_us =
            u32::try_from(display.compression_time.as_micros()).unwrap_or(u32::MAX);
        let select_capture_us =
            micros_between(display.flush_started_at, display.selection_finished_at);
        let prepare_queue_us =
            micros_between(display.prepare_queued_at, display.prepare_started_at);
        let encode_us = prepare_total_us.saturating_sub(compression_us);
        let completion_queue_us =
            micros_between(display.prepare_finished_at, display.completion_started_at);
        let transport_submit_us = micros_between(display.completion_started_at, display.sent_at);
        // `input_seq` is the browser's cumulative receive/handling watermark,
        // not proof that the PTY mutation for its newest input reached this
        // display. A header-only prediction-fence release can therefore race
        // ahead of the shell echo carrying the same sequence. Retire only
        // through the newest fully stamped input in the advertised prefix;
        // otherwise that early header would permanently turn a measurable
        // input into a skipped one.
        //
        // Arrival order is the authority. RFC 1982 half-range comparison only
        // decides where the advertised prefix ends, so u32 rollover cannot
        // retain old inputs or retire new ones. The queue is bounded at 256.
        let attributable_prefix_len = self
            .pending
            .iter()
            .take_while(|(seq, _)| serial_at_or_before(*seq, input_seq))
            .enumerate()
            .fold(0, |prefix_len, (index, (_, stamps))| {
                if stamps.pty_written_at.is_some()
                    && stamps.pty_read_at.is_some()
                    && stamps.grid_applied_at.is_some()
                {
                    index + 1
                } else {
                    prefix_len
                }
            });
        for _ in 0..attributable_prefix_len {
            let (covered_seq, stamps) = self.pending.pop_front().expect("front was present");
            let (Some(pty_written_at), Some(read_at), Some(grid_applied_at)) = (
                stamps.pty_written_at,
                stamps.pty_read_at,
                stamps.grid_applied_at,
            ) else {
                self.skipped_total = self.skipped_total.saturating_add(1);
                continue;
            };

            let record = PerfTimingRecord {
                input_seq: covered_seq,
                recv_to_pty_us: micros_between(stamps.received_at, pty_written_at),
                pty_to_read_us: micros_between(pty_written_at, read_at),
                grid_apply_us: micros_between(read_at, grid_applied_at),
                display_coalesce_us: micros_between(grid_applied_at, display.flush_started_at),
                select_capture_us,
                prepare_queue_us,
                encode_us,
                compression_us,
                completion_queue_us,
                transport_submit_us,
                write_completion_us: PERF_TIMING_UNOBSERVED_US,
                ack_transmit_us: PERF_TIMING_UNOBSERVED_US,
                owner: OwnerTerms::between(
                    stamps.owner_at_write,
                    display.flush_owner,
                    display.sent_owner,
                ),
            };
            if self.push_input_record(record)
                && let Some(ack) = stamps.ack
            {
                self.ack_ready.push_back((covered_seq, ack));
            }
        }
        let grid_applied_at = self
            .open_presentation_grid_applied_at
            .unwrap_or(display.flush_started_at);
        self.push_display_record(PerfTimingRecord {
            input_seq: 0,
            recv_to_pty_us: 0,
            pty_to_read_us: 0,
            grid_apply_us: 0,
            display_coalesce_us: micros_between(grid_applied_at, display.flush_started_at),
            select_capture_us,
            prepare_queue_us,
            encode_us,
            compression_us,
            completion_queue_us,
            transport_submit_us,
            write_completion_us: 0,
            ack_transmit_us: 0,
            owner: OwnerTerms::between(display.flush_owner, display.flush_owner, display.sent_owner),
        });
        if display.presentation_end_admitted {
            self.open_presentation_grid_applied_at = None;
        }
        self.arm_wire_update(display.sent_at);
    }

    /// Whether the record was retained rather than counted as dropped.
    fn push_input_record(&mut self, record: PerfTimingRecord) -> bool {
        debug_assert!(!record.is_display_operation());
        self.attributed_total = self.attributed_total.saturating_add(1);
        if self.input_ready.len() < PERF_TIMING_MAX_READY {
            self.input_ready.push_back(record);
            true
        } else {
            self.dropped_total = self.dropped_total.saturating_add(1);
            false
        }
    }

    fn push_display_record(&mut self, record: PerfTimingRecord) {
        debug_assert!(record.is_display_operation());
        self.display_attributed_total = self.display_attributed_total.saturating_add(1);
        if self.display_ready.len() < PERF_TIMING_MAX_READY {
            self.display_ready.push_back(record);
        } else {
            self.display_dropped_total = self.display_dropped_total.saturating_add(1);
        }
    }

    #[cfg(test)]
    pub fn has_ready(&self) -> bool {
        !self.input_ready.is_empty() || !self.display_ready.is_empty()
    }

    fn status(&self) -> PerfTimingStatus {
        PerfTimingStatus {
            attributed_total: self.attributed_total,
            dropped_total: self.dropped_total,
            skipped_total: self.skipped_total,
            pending_total: u32::try_from(self.pending.len()).unwrap_or(u32::MAX),
            display_attributed_total: self.display_attributed_total,
            display_dropped_total: self.display_dropped_total,
        }
    }

    /// Whether either records or changed completeness metadata need reliable
    /// delivery. Unlike `has_ready`, this remains true for an all-skipped or
    /// all-dropped tail so the browser cannot mistake missing samples for a
    /// complete distribution.
    pub fn has_wire_update(&self) -> bool {
        self.enabled
            && (!self.input_ready.is_empty()
                || !self.display_ready.is_empty()
                || self.status() != self.accepted_status)
    }

    /// Take one control-frame-sized batch. The caller must either accept or
    /// restore it after reliable carrier admission.
    pub fn take_due_wire_batch(&mut self, now: Instant) -> Option<PerfTimingBatch> {
        if !self.has_wire_update() || self.wire_deadline.is_none_or(|deadline| deadline > now) {
            return None;
        }
        self.wire_deadline = None;
        let status = self.status();
        let mut records = ArrayVec::new();
        // One-for-one interleave, input first. Each queue is FIFO on its own,
        // and the browser joins records by kind rather than by wire position,
        // so alternating drains both streams at the same rate whatever their
        // production ratio.
        while records.len() < PERF_TIMING_WIRE_BATCH_RECORDS {
            let take_input = if records.len() % 2 == 0 {
                !self.input_ready.is_empty()
            } else {
                self.display_ready.is_empty()
            };
            let record = if take_input {
                self.input_ready.pop_front().map(|mut record| {
                    // A restored record already carries its terms and has no
                    // stamps left; a fresh one takes its own, in FIFO order.
                    if self
                        .ack_ready
                        .front()
                        .is_some_and(|(seq, _)| *seq == record.input_seq)
                        && let Some((_, stamps)) = self.ack_ready.pop_front()
                    {
                        (record.write_completion_us, record.ack_transmit_us) = stamps.terms();
                    }
                    record
                })
            } else {
                self.display_ready.pop_front()
            };
            let Some(record) = record else {
                break;
            };
            records.push(record);
        }
        Some(PerfTimingBatch {
            batch_seq: self.next_batch_seq,
            attributed_total: status.attributed_total,
            dropped_total: status.dropped_total,
            skipped_total: status.skipped_total,
            pending_total: status.pending_total,
            display_attributed_total: status.display_attributed_total,
            display_dropped_total: status.display_dropped_total,
            observation_epoch: self.owner.as_ref()?.observation_epoch,
            records,
        })
    }

    /// Whether this snapshot differs from the last one a carrier admitted in
    /// the current observation; the first of every observation always does.
    pub fn egress_changed(&self, snapshot: &PerfEgressSnapshot) -> bool {
        self.enabled && self.egress_sent.as_ref() != Some(snapshot)
    }

    pub fn accept_egress(&mut self, snapshot: PerfEgressSnapshot) {
        self.egress_sent = Some(snapshot);
    }

    pub fn accept_wire_batch(&mut self, batch: &PerfTimingBatch, now: Instant) {
        debug_assert_eq!(batch.batch_seq, self.next_batch_seq);
        debug_assert_eq!(
            self.owner.as_ref().map(|owner| owner.observation_epoch),
            Some(batch.observation_epoch)
        );
        self.accepted_status = PerfTimingStatus {
            attributed_total: batch.attributed_total,
            dropped_total: batch.dropped_total,
            skipped_total: batch.skipped_total,
            pending_total: batch.pending_total,
            display_attributed_total: batch.display_attributed_total,
            display_dropped_total: batch.display_dropped_total,
        };
        self.next_batch_seq = self.next_batch_seq.wrapping_add(1);
        self.arm_wire_update(now);
    }

    pub fn restore_wire_batch(&mut self, batch: PerfTimingBatch, now: Instant) {
        debug_assert_eq!(batch.batch_seq, self.next_batch_seq);
        debug_assert_eq!(
            self.owner.as_ref().map(|owner| owner.observation_epoch),
            Some(batch.observation_epoch)
        );
        for record in batch.records.into_iter().rev() {
            if record.is_display_operation() {
                self.display_ready.push_front(record);
            } else {
                self.input_ready.push_front(record);
            }
        }
        // A failed admission retries after one bounded tail, rather than
        // immediately spinning a permanently full reliable queue.
        self.wire_deadline = Some(now + PERF_TIMING_BATCH_TAIL);
    }

    #[cfg(test)]
    fn set_enabled(&mut self, enabled: bool) {
        self.configure(Arc::from("perf-test-peer"), "perf-test-session", enabled, 1);
    }

    #[cfg(test)]
    fn note_input_received(&mut self, seq: u32, at: Instant) {
        self.note_input_received_for("perf-test-peer", "perf-test-session", seq, at);
    }

    #[cfg(test)]
    fn note_pty_write(&mut self, seq: u32, at: Instant) {
        self.note_pty_write_for("perf-test-peer", "perf-test-session", seq, at);
    }

    #[cfg(test)]
    fn note_display_sent(&mut self, input_seq: u32, display: DisplaySendStamps) {
        self.note_display_sent_for("perf-test-peer", "perf-test-session", input_seq, display);
    }

    /// Take everything completed since the last drain.
    #[cfg(test)]
    pub fn drain(&mut self) -> Vec<PerfTimingRecord> {
        self.ack_ready.clear();
        self.input_ready
            .drain(..)
            .chain(self.display_ready.drain(..))
            .collect()
    }
}

/// True when `candidate` is no newer than `anchor` in the RFC 1982 half range.
fn serial_at_or_before(candidate: u32, anchor: u32) -> bool {
    anchor.wrapping_sub(candidate) < (1_u32 << 31)
}

/// True when `candidate` is strictly newer than `anchor` in the RFC 1982 half
/// range. Profiling epochs skip zero, so `u32::MAX -> 1` advances by two and
/// remains correctly ordered.
fn serial_is_newer(candidate: u32, anchor: u32) -> bool {
    candidate != anchor && candidate.wrapping_sub(anchor) < (1_u32 << 31)
}

/// Frame body: cumulative completeness metadata and fixed-size records.
pub fn encode_perf_timing_batch(batch: &PerfTimingBatch) -> Vec<u8> {
    let count = batch.records.len().min(PERF_TIMING_WIRE_BATCH_RECORDS);
    let mut body =
        Vec::with_capacity(PERF_TIMING_BATCH_HEADER_BYTES + count * PERF_TIMING_RECORD_BYTES);
    body.extend_from_slice(&batch.batch_seq.to_be_bytes());
    body.extend_from_slice(&batch.attributed_total.to_be_bytes());
    body.extend_from_slice(&batch.dropped_total.to_be_bytes());
    body.extend_from_slice(&batch.skipped_total.to_be_bytes());
    body.extend_from_slice(&batch.pending_total.to_be_bytes());
    body.extend_from_slice(&batch.display_attributed_total.to_be_bytes());
    body.extend_from_slice(&batch.display_dropped_total.to_be_bytes());
    body.extend_from_slice(&batch.observation_epoch.to_be_bytes());
    body.push(u8::try_from(count).unwrap_or(u8::MAX));
    for record in batch.records.iter().take(count) {
        record.encode_into(&mut body);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(base: Instant, micros: u64) -> Instant {
        base + Duration::from_micros(micros)
    }

    fn inline_stamps(base: Instant, flush_us: u64, sent_us: u64) -> DisplaySendStamps {
        let flush = at(base, flush_us);
        DisplaySendStamps {
            flush_started_at: flush,
            selection_finished_at: flush,
            prepare_queued_at: flush,
            prepare_started_at: flush,
            prepare_finished_at: flush,
            completion_started_at: flush,
            sent_at: at(base, sent_us),
            compression_time: Duration::ZERO,
            presentation_end_admitted: true,
            flush_owner: owner::OwnerStamp::default(),
            sent_owner: owner::OwnerStamp::default(),
        }
    }

    #[test]
    fn disabled_tracker_records_nothing() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        tracker.note_pty_read(at(base, 20));
        tracker.note_grid_applied(at(base, 25));
        tracker.note_display_sent(1, inline_stamps(base, 30, 40));
        assert!(!tracker.has_ready());
    }

    #[test]
    fn a_record_that_wrote_nothing_leaves_the_partition() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        // A release no keyboard mode reports: received, then written as nothing.
        tracker.note_input_received(2, at(base, 20));
        tracker.note_input_silent_owned(2);
        tracker.note_pty_read(at(base, 30));
        assert_eq!(
            tracker
                .pending
                .iter()
                .map(|(seq, _)| *seq)
                .collect::<Vec<_>>(),
            [1],
            "only the input that wrote bytes waits on a read"
        );
    }

    #[test]
    fn a_complete_chain_partitions_into_ten_non_overlapping_terms() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_input_received(7, base);
        tracker.note_pty_write(7, at(base, 100));
        tracker.note_pty_read(at(base, 400));
        tracker.note_grid_applied(at(base, 500));
        tracker.note_display_sent(
            7,
            DisplaySendStamps {
                flush_started_at: at(base, 900),
                selection_finished_at: at(base, 1_000),
                prepare_queued_at: at(base, 1_000),
                prepare_started_at: at(base, 1_100),
                prepare_finished_at: at(base, 1_400),
                completion_started_at: at(base, 1_450),
                sent_at: at(base, 1_500),
                compression_time: Duration::from_micros(100),
                presentation_end_admitted: true,
                flush_owner: owner::OwnerStamp::default(),
                sent_owner: owner::OwnerStamp::default(),
            },
        );

        let records = tracker.drain();
        assert_eq!(
            records,
            vec![
                PerfTimingRecord {
                    input_seq: 7,
                    recv_to_pty_us: 100,
                    pty_to_read_us: 300,
                    grid_apply_us: 100,
                    display_coalesce_us: 400,
                    select_capture_us: 100,
                    prepare_queue_us: 100,
                    encode_us: 200,
                    compression_us: 100,
                    completion_queue_us: 50,
                    transport_submit_us: 50,
                    write_completion_us: PERF_TIMING_UNOBSERVED_US,
                    ack_transmit_us: PERF_TIMING_UNOBSERVED_US,
                    owner: OwnerTerms::default(),
                },
                PerfTimingRecord {
                    input_seq: 0,
                    recv_to_pty_us: 0,
                    pty_to_read_us: 0,
                    grid_apply_us: 0,
                    display_coalesce_us: 400,
                    select_capture_us: 100,
                    prepare_queue_us: 100,
                    encode_us: 200,
                    compression_us: 100,
                    completion_queue_us: 50,
                    transport_submit_us: 50,
                    write_completion_us: 0,
                    ack_transmit_us: 0,
                    owner: OwnerTerms::default(),
                }
            ]
        );
        // The ten terms must sum to the whole; that identity is the oracle the
        // browser-side decomposition is checked against too.
        let r = records[0];
        let total = r.recv_to_pty_us
            + r.pty_to_read_us
            + r.grid_apply_us
            + r.display_coalesce_us
            + r.select_capture_us
            + r.prepare_queue_us
            + r.encode_us
            + r.compression_us
            + r.completion_queue_us
            + r.transport_submit_us;
        assert_eq!(total, 1_500);
    }

    #[test]
    fn a_keystroke_never_written_to_the_pty_produces_no_input_record() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_input_received(1, base);
        // Backpressured or rejected: no PTY write, so no causal chain exists.
        tracker.note_display_sent(1, inline_stamps(base, 100, 200));
        let records = tracker.drain();
        assert_eq!(records.len(), 1);
        assert!(records[0].is_display_operation());
    }

    #[test]
    fn a_display_frame_attributes_every_causally_covered_keystroke() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        for seq in 1..=3 {
            tracker.note_input_received(seq, base);
            tracker.note_pty_write(seq, at(base, 10));
        }
        tracker.note_pty_read(at(base, 20));
        tracker.note_grid_applied(at(base, 25));
        tracker.note_display_sent(3, inline_stamps(base, 30, 40));
        let records = tracker.drain();
        assert_eq!(records.len(), 4);
        assert_eq!(
            records
                .iter()
                .filter(|record| !record.is_display_operation())
                .map(|record| record.input_seq)
                .collect::<Vec<_>>(),
            vec![1, 2, 3],
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.is_display_operation())
                .count(),
            1,
            "one display flush is one operation sample, however many inputs it covers",
        );
        assert_eq!(tracker.attributed_total, 3);
        assert_eq!(tracker.display_attributed_total, 1);

        // 1 and 2 were covered by the cumulative barrier and must not linger to
        // be paired with some later, unrelated frame.
        tracker.note_pty_read(at(base, 50));
        tracker.note_grid_applied(at(base, 55));
        tracker.note_display_sent(2, inline_stamps(base, 60, 70));
        let records = tracker.drain();
        assert_eq!(records.len(), 1);
        assert!(records[0].is_display_operation());
    }

    #[test]
    fn split_presentation_keeps_earliest_grid_ready_until_end_is_admitted() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);

        tracker.note_grid_applied(base);
        let mut first = inline_stamps(base, 100, 110);
        first.presentation_end_admitted = false;
        tracker.note_display_sent(0, first);

        // A newer grid mutation while physical admission is continuing must
        // not move the logical redraw's origin forward.
        tracker.note_grid_applied(at(base, 150));
        let mut second = inline_stamps(base, 200, 210);
        second.presentation_end_admitted = false;
        tracker.note_display_sent(0, second);

        tracker.note_display_sent(0, inline_stamps(base, 300, 310));
        tracker.note_display_sent(0, inline_stamps(base, 400, 410));

        let coalescing = tracker
            .drain()
            .into_iter()
            .map(|record| record.display_coalesce_us)
            .collect::<Vec<_>>();
        assert_eq!(
            coalescing,
            vec![100, 200, 300, 0],
            "only the admitted END retires grid-ready provenance",
        );
    }

    #[test]
    fn convergence_epoch_is_exposed_only_for_the_live_enabled_owner() {
        let mut tracker = PerfTimingTracker::default();
        assert_eq!(tracker.observation_epoch(), None);
        tracker.configure(Arc::from("peer-a"), "session-a", true, 77);
        assert_eq!(tracker.observation_epoch(), Some(77));
        tracker.configure(Arc::from("peer-a"), "session-a", false, 77);
        assert_eq!(tracker.observation_epoch(), None);
    }

    #[test]
    fn reordered_older_epoch_controls_cannot_replace_or_resurrect_the_fence() {
        let mut tracker = PerfTimingTracker::default();
        tracker.configure(Arc::from("peer-a"), "session-a", true, 9);

        // A delayed control from the prior observation can arrive on another
        // live reliable carrier. Neither polarity may cut the current epoch.
        tracker.configure(Arc::from("peer-a"), "session-a", false, 8);
        tracker.configure(Arc::from("peer-a"), "session-a", true, 8);
        assert!(tracker.owns("peer-a", "session-a"));
        assert_eq!(tracker.observation_epoch(), Some(9));

        // Disabling retains the epoch fence even though it exposes no active
        // observation. A still-later old enable must not resurrect epoch 8.
        tracker.configure(Arc::from("peer-a"), "session-a", false, 10);
        assert!(!tracker.is_enabled());
        assert_eq!(tracker.observation_epoch(), None);
        tracker.configure(Arc::from("peer-a"), "session-a", true, 8);
        assert!(!tracker.is_enabled());

        // Re-enabling the retained current epoch remains a valid toggle.
        tracker.configure(Arc::from("peer-a"), "session-a", true, 10);
        assert!(tracker.owns("peer-a", "session-a"));
        assert_eq!(tracker.observation_epoch(), Some(10));
    }

    #[test]
    fn observation_epoch_freshness_wraps_across_the_nonzero_sequence_space() {
        let mut tracker = PerfTimingTracker::default();
        tracker.configure(Arc::from("peer-a"), "session-a", true, u32::MAX);
        tracker.configure(Arc::from("peer-a"), "session-a", true, 1);
        assert_eq!(tracker.observation_epoch(), Some(1));

        tracker.configure(Arc::from("peer-a"), "session-a", false, u32::MAX);
        assert!(tracker.is_enabled(), "pre-wrap epoch is stale after wrap");
        assert_eq!(tracker.observation_epoch(), Some(1));
    }

    #[test]
    fn only_the_first_read_after_a_write_counts_as_turnaround() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        tracker.note_pty_read(at(base, 100));
        tracker.note_grid_applied(at(base, 110));
        // Continuation output from the same command, not a second turnaround.
        tracker.note_pty_read(at(base, 900));
        tracker.note_grid_applied(at(base, 910));
        tracker.note_display_sent(1, inline_stamps(base, 1_000, 1_100));

        assert_eq!(tracker.drain()[0].pty_to_read_us, 90);
    }

    #[test]
    fn a_display_only_flush_has_one_operation_weighted_stage_record() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_pty_read(at(base, 100));
        tracker.note_grid_applied(at(base, 150));
        tracker.note_display_sent(0, inline_stamps(base, 300, 400));

        let records = tracker.drain();
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0],
            PerfTimingRecord {
                input_seq: 0,
                recv_to_pty_us: 0,
                pty_to_read_us: 0,
                grid_apply_us: 0,
                display_coalesce_us: 150,
                select_capture_us: 0,
                prepare_queue_us: 0,
                encode_us: 0,
                compression_us: 0,
                completion_queue_us: 0,
                transport_submit_us: 100,
                write_completion_us: 0,
                ack_transmit_us: 0,
                owner: OwnerTerms::default(),
            }
        );
        assert_eq!(tracker.attributed_total, 0);
        assert_eq!(tracker.display_attributed_total, 1);
        assert_eq!(tracker.display_dropped_total, 0);
    }

    #[test]
    fn a_keystroke_no_read_has_answered_yet_produces_no_input_record() {
        // The production failure this closes. Typing outruns shell turnaround:
        // keystroke 1 is answered by the read at t=100, keystroke 2 is written
        // afterwards and no read has answered it when its frame goes out.
        //
        // The old tracker held one shared read timestamp, so keystroke 2's
        // record was built from keystroke 1's read — reporting pty_to_read as 0
        // (its write is later than that read) and read_to_flush as the whole
        // span back to t=100. Repeated across a burst that inflated the term
        // without bound; the fix is to emit nothing rather than something
        // wrong.
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);

        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        tracker.note_pty_read(at(base, 100));

        tracker.note_input_received(2, at(base, 200));
        tracker.note_pty_write(2, at(base, 210));
        tracker.note_display_sent(2, inline_stamps(base, 5_000, 5_100));

        let records = tracker.drain();
        assert_eq!(records.len(), 1);
        assert!(records[0].is_display_operation());
        assert_eq!(tracker.skipped_total, 0);
        assert_eq!(tracker.pending.len(), 2);
    }

    #[test]
    fn one_read_answers_every_keystroke_written_before_it() {
        // The legitimate burst case, and the reason the read is stamped onto
        // each entry rather than only the newest: all three keystrokes really
        // did wait until this read, so all three are attributable — each from
        // its own write.
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        for seq in 1..=3u32 {
            tracker.note_input_received(seq, base);
            tracker.note_pty_write(seq, at(base, u64::from(seq) * 10));
        }
        tracker.note_pty_read(at(base, 500));
        tracker.note_grid_applied(at(base, 550));

        // Oldest-first: the cumulative barrier retires everything at or below
        // the sequence it is given, so a youngest-first walk would sweep the
        // earlier two before they could be asserted.
        for seq in 1..=3u32 {
            tracker.note_display_sent(seq, inline_stamps(base, 600, 700));
            let records = tracker.drain();
            assert_eq!(records.len(), 2, "seq {seq} and its display operation");
            assert_eq!(
                records[0].pty_to_read_us,
                500 - u32::from(u16::try_from(seq).unwrap()) * 10,
                "seq {seq} must measure turnaround from its own write",
            );
            assert_eq!(records[0].grid_apply_us, 50);
            assert_eq!(records[0].display_coalesce_us, 50);
        }
    }

    #[test]
    fn a_read_arriving_before_a_later_write_does_not_answer_it() {
        // Ordering guard for the reverse walk: an entry received but not yet
        // written sits at the high end of the map and must be stepped over,
        // not treated as answered and not used to stop the walk early.
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);

        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        // Received, still queued behind PTY backpressure when the read lands.
        tracker.note_input_received(2, at(base, 20));
        tracker.note_pty_read(at(base, 30));
        tracker.note_grid_applied(at(base, 35));

        // 1 was answered and is attributable.
        tracker.note_display_sent(1, inline_stamps(base, 40, 50));
        let records = tracker.drain();
        assert_eq!(records.len(), 2);
        assert!(!records[0].is_display_operation());
        assert!(records[1].is_display_operation());

        // 2 was not, even though the read came after it was received.
        tracker.note_input_received(3, at(base, 60));
        tracker.note_pty_write(3, at(base, 70));
        tracker.note_display_sent(2, inline_stamps(base, 80, 90));
        let records = tracker.drain();
        assert_eq!(records.len(), 1);
        assert!(records[0].is_display_operation());
    }

    #[test]
    fn pending_inputs_are_bounded() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        for seq in 1..=(MAX_PENDING_INPUTS as u32 * 2) {
            tracker.note_input_received(seq, base);
        }
        assert!(tracker.pending.len() <= MAX_PENDING_INPUTS);
    }

    #[test]
    fn disabling_drops_state_rather_than_carrying_it_across_the_gap() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        tracker.set_enabled(false);
        tracker.set_enabled(true);
        tracker.note_pty_read(at(base, 20));
        tracker.note_grid_applied(at(base, 25));
        tracker.note_display_sent(1, inline_stamps(base, 30, 40));
        let records = tracker.drain();
        assert_eq!(records.len(), 1);
        assert!(records[0].is_display_operation());
    }

    #[test]
    fn a_batch_encodes_a_count_then_fixed_size_records() {
        let record = PerfTimingRecord {
            input_seq: 0x0102_0304,
            recv_to_pty_us: 1,
            pty_to_read_us: 2,
            grid_apply_us: 3,
            display_coalesce_us: 4,
            select_capture_us: 5,
            prepare_queue_us: 6,
            encode_us: 7,
            compression_us: 8,
            completion_queue_us: 9,
            transport_submit_us: 10,
            write_completion_us: 11,
            ack_transmit_us: PERF_TIMING_UNOBSERVED_US,
            owner: OwnerTerms {
                cpu_us: 12,
                off_cpu_us: 13,
                quinn_wait_us: 14,
                registry_wait_us: 15,
                flush_lock_wait_us: 16,
            },
        };
        let batch = PerfTimingBatch {
            batch_seq: 9,
            attributed_total: 2,
            dropped_total: 0,
            skipped_total: 0,
            pending_total: 3,
            display_attributed_total: 4,
            display_dropped_total: 5,
            observation_epoch: 0x0607_0809,
            records: ArrayVec::from_iter([record, record]),
        };
        let body = encode_perf_timing_batch(&batch);
        assert_eq!(
            body.len(),
            PERF_TIMING_BATCH_HEADER_BYTES + 2 * PERF_TIMING_RECORD_BYTES
        );
        assert_eq!(&body[..4], &9_u32.to_be_bytes());
        assert_eq!(&body[16..20], &3_u32.to_be_bytes());
        assert_eq!(&body[20..24], &4_u32.to_be_bytes());
        assert_eq!(&body[24..28], &5_u32.to_be_bytes());
        assert_eq!(&body[28..32], &0x0607_0809_u32.to_be_bytes());
        assert_eq!(body[32], 2);
        assert_eq!(&body[33..37], &[0x01, 0x02, 0x03, 0x04]);
        // The acknowledgment terms follow the echo, then the owner's accounts
        // close each 72-byte record.
        assert_eq!(&body[33 + 44..33 + 48], &11_u32.to_be_bytes());
        assert_eq!(&body[33 + 48..33 + 52], &u32::MAX.to_be_bytes());
        for (index, value) in (12_u32..=16).enumerate() {
            let at = 33 + 52 + 4 * index;
            assert_eq!(&body[at..at + 4], &value.to_be_bytes());
        }
        assert_eq!(&body[33 + 72..33 + 76], &[0x01, 0x02, 0x03, 0x04]);
    }

    #[test]
    fn a_stalled_consumer_bounds_the_ready_buffer() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        for seq in 1..=(PERF_TIMING_MAX_READY as u32 + 50) {
            tracker.note_input_received(seq, base);
            tracker.note_pty_write(seq, at(base, 1));
            tracker.note_pty_read(at(base, 2));
            tracker.note_grid_applied(at(base, 3));
            tracker.note_display_sent(seq, inline_stamps(base, 3, 4));
        }
        let records = tracker.drain();
        assert_eq!(
            records
                .iter()
                .filter(|record| !record.is_display_operation())
                .count(),
            PERF_TIMING_MAX_READY
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.is_display_operation())
                .count(),
            PERF_TIMING_MAX_READY
        );
        assert_eq!(tracker.dropped_total, 50);
        assert_eq!(tracker.display_dropped_total, 50);
    }

    #[test]
    fn cumulative_attribution_crosses_u32_rollover_in_arrival_order() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        for seq in [u32::MAX - 1, u32::MAX, 1, 2] {
            tracker.note_input_received(seq, base);
            tracker.note_pty_write(seq, at(base, 1));
        }
        tracker.note_pty_read(at(base, 2));
        tracker.note_grid_applied(at(base, 3));
        tracker.note_display_sent(1, inline_stamps(base, 4, 5));
        assert_eq!(
            tracker
                .drain()
                .iter()
                .filter(|record| !record.is_display_operation())
                .map(|record| record.input_seq)
                .collect::<Vec<_>>(),
            vec![u32::MAX - 1, u32::MAX, 1],
        );
        tracker.note_display_sent(2, inline_stamps(base, 6, 7));
        let records = tracker.drain();
        assert!(!records[0].is_display_operation());
        assert_eq!(records[0].input_seq, 2);
    }

    #[test]
    fn wire_batches_fit_u8_body_and_restore_fifo_after_refusal() {
        let base = Instant::now();
        let record = PerfTimingRecord {
            input_seq: 1,
            recv_to_pty_us: 1,
            pty_to_read_us: 2,
            grid_apply_us: 3,
            display_coalesce_us: 4,
            select_capture_us: 5,
            prepare_queue_us: 6,
            encode_us: 7,
            compression_us: 8,
            completion_queue_us: 9,
            transport_submit_us: 10,
            write_completion_us: 11,
            ack_transmit_us: 12,
            owner: OwnerTerms {
                cpu_us: u32::MAX,
                off_cpu_us: u32::MAX,
                quinn_wait_us: u32::MAX,
                registry_wait_us: u32::MAX,
                flush_lock_wait_us: u32::MAX,
            },
        };
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker
            .input_ready
            .extend((1..=7).map(|input_seq| PerfTimingRecord {
                input_seq,
                ..record
            }));
        tracker.attributed_total = 7;

        tracker.arm_wire_update(base);
        let first = tracker
            .take_due_wire_batch(base)
            .expect("three-record batch");
        assert_eq!(first.records.len(), PERF_TIMING_WIRE_BATCH_RECORDS);
        assert!(encode_perf_timing_batch(&first).len() <= u8::MAX as usize);
        tracker.restore_wire_batch(first, base);
        assert_eq!(tracker.drain()[0].input_seq, 1);
    }

    #[test]
    fn a_completed_successor_retires_an_unanswered_predecessor_as_skipped() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_input_received(1, base);
        tracker.note_input_received(2, at(base, 1));
        tracker.note_pty_write(2, at(base, 2));
        tracker.note_pty_read(at(base, 3));
        tracker.note_grid_applied(at(base, 4));
        tracker.note_display_sent(2, inline_stamps(base, 10, 20));

        let batch = tracker
            .take_due_wire_batch(at(base, 20_000))
            .expect("changed status");
        assert_eq!(batch.records.len(), 2);
        assert_eq!(batch.records[0].input_seq, 2);
        assert!(batch.records[1].is_display_operation());
        assert_eq!(batch.attributed_total, 1);
        assert_eq!(batch.skipped_total, 1);
        assert_eq!(batch.pending_total, 0);
        assert_eq!(batch.display_attributed_total, 1);
        assert_eq!(batch.display_dropped_total, 0);
        tracker.accept_wire_batch(&batch, at(base, 20_000));
        assert!(!tracker.has_wire_update(), "accepted status must not spin");
    }

    #[test]
    fn pending_and_drop_counts_are_visible_without_completed_records() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        for seq in 1..=(MAX_PENDING_INPUTS as u32 + 1) {
            tracker.note_input_received(seq, base);
        }

        let batch = tracker
            .take_due_wire_batch(at(base, 20_000))
            .expect("pending status");
        assert!(batch.records.is_empty());
        assert_eq!(batch.pending_total, MAX_PENDING_INPUTS as u32);
        assert_eq!(batch.dropped_total, 1);
    }

    fn timing_record(input_seq: u32) -> PerfTimingRecord {
        PerfTimingRecord {
            input_seq,
            recv_to_pty_us: 1,
            pty_to_read_us: 2,
            grid_apply_us: 3,
            display_coalesce_us: 4,
            select_capture_us: 5,
            prepare_queue_us: 6,
            encode_us: 7,
            compression_us: 8,
            completion_queue_us: 9,
            transport_submit_us: 10,
            write_completion_us: 11,
            ack_transmit_us: 12,
            owner: OwnerTerms {
                cpu_us: 13,
                off_cpu_us: 14,
                quinn_wait_us: 15,
                registry_wait_us: 16,
                flush_lock_wait_us: 17,
            },
        }
    }

    #[test]
    fn one_hundred_ninety_two_samples_form_sixty_four_owner_turn_batches() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.input_ready.extend((1..=192).map(timing_record));
        tracker.attributed_total = 192;
        tracker.arm_wire_update(base);

        let mut batches = 0;
        let mut records = 0;
        let mut now = base;
        while tracker.has_wire_update() {
            if tracker
                .next_wire_deadline()
                .is_some_and(|deadline| deadline > now)
            {
                now += PERF_TIMING_BATCH_TAIL;
            }
            let batch = tracker
                .take_due_wire_batch(now)
                .expect("armed batch must be due on this owner turn");
            batches += 1;
            records += batch.records.len();
            tracker.accept_wire_batch(&batch, now);
        }

        assert_eq!(records, 192);
        assert_eq!(batches, 64);
        assert_eq!(tracker.dropped_total, 0);
    }

    #[test]
    fn two_sample_tail_waits_twenty_milliseconds() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.input_ready.extend((1..=2).map(timing_record));
        tracker.attributed_total = 2;
        tracker.arm_wire_update(base);

        assert!(tracker.take_due_wire_batch(base).is_none());
        assert!(
            tracker
                .take_due_wire_batch(base + PERF_TIMING_BATCH_TAIL - Duration::from_nanos(1))
                .is_none()
        );
        assert_eq!(
            tracker
                .take_due_wire_batch(base + PERF_TIMING_BATCH_TAIL)
                .expect("tail deadline")
                .records
                .len(),
            2
        );
    }

    #[test]
    fn refused_batch_restores_fifo_and_retries_without_spinning() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.input_ready.extend((1..=6).map(timing_record));
        tracker.attributed_total = 6;
        tracker.arm_wire_update(base);

        let refused = tracker
            .take_due_wire_batch(base)
            .expect("full batch is immediately due");
        assert!(tracker.take_due_wire_batch(base).is_none());
        tracker.restore_wire_batch(refused, base);
        assert!(tracker.take_due_wire_batch(base).is_none());
        let retried = tracker
            .take_due_wire_batch(base + PERF_TIMING_BATCH_TAIL)
            .expect("refused batch retries at bounded tail");
        assert_eq!(
            retried
                .records
                .iter()
                .map(|record| record.input_seq)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn a_mixed_batch_interleaves_input_and_display_records_one_for_one() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.input_ready.extend((1..=5).map(timing_record));
        tracker.display_ready.extend((0..2).map(|_| timing_record(0)));
        tracker.attributed_total = 5;
        tracker.display_attributed_total = 2;
        tracker.arm_wire_update(base);

        let seqs = |batch: &PerfTimingBatch| {
            batch
                .records
                .iter()
                .map(|record| record.input_seq)
                .collect::<Vec<_>>()
        };
        let batch = tracker
            .take_due_wire_batch(base)
            .expect("full mixed batch is immediately due");
        assert_eq!(
            seqs(&batch),
            vec![1, 0, 2],
            "input first, then strict alternation while both queues hold records",
        );
        assert_eq!(tracker.input_ready.len(), 3);
        assert_eq!(tracker.display_ready.len(), 1);
        tracker.accept_wire_batch(&batch, base);

        let batch = tracker
            .take_due_wire_batch(base)
            .expect("the second full batch is immediately due");
        assert_eq!(seqs(&batch), vec![3, 0, 4]);
        tracker.accept_wire_batch(&batch, base);

        // Once one queue is empty the other fills the remaining slots. One
        // record is a partial tail, due after the bounded tail wait.
        assert!(tracker.take_due_wire_batch(base).is_none());
        let batch = tracker
            .take_due_wire_batch(base + PERF_TIMING_BATCH_TAIL)
            .expect("the partial tail is due at its deadline");
        assert_eq!(seqs(&batch), vec![5]);
        assert!(tracker.input_ready.is_empty());
        assert!(tracker.display_ready.is_empty());
    }

    /// The typing workload: every keystroke closes one input-attributed record
    /// and one display record, and the owner turn offers batches whenever the
    /// deadline says one is due. Draining every due batch per offer keeps both
    /// queues at the wire's pace instead of the offer cadence's.
    #[test]
    fn sustained_typing_drains_both_queues_without_starving_display() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        let mut sent = 0usize;
        for turn in 1..=2_048u32 {
            let now = base + Duration::from_millis(u64::from(turn));
            tracker.note_input_received(turn, now);
            tracker.note_pty_write(turn, now);
            tracker.note_pty_read(now);
            tracker.note_grid_applied(now);
            tracker.note_display_sent(turn, inline_stamps(base, 1_000 * u64::from(turn), 1_000 * u64::from(turn)));
            while let Some(batch) = tracker.take_due_wire_batch(now) {
                sent += batch.records.len();
                tracker.accept_wire_batch(&batch, now);
            }
            assert!(
                tracker.input_ready.len() + tracker.display_ready.len()
                    < PERF_TIMING_WIRE_BATCH_RECORDS,
                "an offer leaves only a partial tail behind",
            );
        }
        assert_eq!(tracker.dropped_total, 0);
        assert_eq!(tracker.display_dropped_total, 0);
        let mut now = base + Duration::from_secs(3);
        while tracker.has_wire_update() {
            if let Some(deadline) = tracker.next_wire_deadline()
                && deadline > now
            {
                now = deadline;
            }
            let batch = tracker
                .take_due_wire_batch(now)
                .expect("the partial tail is due at its deadline");
            sent += batch.records.len();
            tracker.accept_wire_batch(&batch, now);
        }
        assert_eq!(sent, 2 * 2_048);
    }

    #[test]
    fn observation_epoch_change_fences_same_session_records_and_restarts_batch_sequence() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.configure(Arc::from("peer-a"), "session-a", true, 7);
        tracker.note_grid_applied(base);
        tracker.note_display_sent_for("peer-a", "session-a", 0, inline_stamps(base, 10, 20));
        let stale = tracker
            .take_due_wire_batch(at(base, 20_020))
            .expect("epoch seven batch");
        assert_eq!(stale.observation_epoch, 7);
        assert_eq!(stale.batch_seq, 1);

        // The old batch may already be resident in the persistent reliable
        // stream, but all daemon-owned state is cut before the new window.
        tracker.configure(Arc::from("peer-a"), "session-a", true, 8);
        assert!(!tracker.has_wire_update());
        tracker.note_grid_applied(at(base, 21_000));
        tracker.note_display_sent_for(
            "peer-a",
            "session-a",
            0,
            inline_stamps(base, 21_010, 21_020),
        );
        let current = tracker
            .take_due_wire_batch(at(base, 41_020))
            .expect("epoch eight batch");
        assert_eq!(current.observation_epoch, 8);
        assert_eq!(current.batch_seq, 1);
        assert_eq!(current.records.len(), 1);
        assert!(current.records[0].is_display_operation());
    }

    #[test]
    fn an_egress_snapshot_is_offered_once_per_change_and_encodes_every_hop() {
        let mut tracker = PerfTimingTracker::default();
        tracker.configure(Arc::from("peer-a"), "session-a", true, 5);
        let mut snapshot = PerfEgressSnapshot::new(
            None,
            Some(EdgeContention {
                attachment: (1 << 32) + 9,
                interactive: EdgeAdmissions {
                    blocked: 1,
                    paced: 2,
                    waited_us: 3,
                },
                bulk: EdgeAdmissions {
                    blocked: 4,
                    paced: 5,
                    waited_us: (1 << 32) + 6,
                },
                forward_residence: std::array::from_fn(|bucket| bucket as u32 + 10),
                model: None,
            }),
        );
        assert!(tracker.egress_changed(&snapshot), "first of the observation");
        tracker.accept_egress(snapshot);
        assert!(!tracker.egress_changed(&snapshot));
        snapshot.daemon_interactive.blocked = 7;
        assert!(tracker.egress_changed(&snapshot));

        let body = encode_perf_egress(&snapshot, 5);
        assert_eq!(body.len(), PERF_EGRESS_BYTES);
        let word = |index: usize| u32::from_be_bytes(body[index * 4..index * 4 + 4].try_into().unwrap());
        assert_eq!(word(0), 5);
        // Each hop names the counters it reports; no group yet is zero.
        assert_eq!((word(1), word(2)), (0, 9), "daemon group, edge attachment");
        assert_eq!((word(3), word(4), word(5)), (7, 0, 0), "daemon interactive");
        assert_eq!((word(9), word(10), word(11)), (1, 2, 3), "edge interactive");
        // Modular on the wire: the browser differences consecutive snapshots
        // of one identity.
        assert_eq!((word(12), word(13), word(14)), (4, 5, 6), "edge bulk");
        assert_eq!(word(15), 10);
        assert_eq!(word(26), 21);

        // A new observation re-offers the same cumulative counters.
        tracker.accept_egress(snapshot);
        tracker.configure(Arc::from("peer-a"), "session-a", true, 6);
        assert!(tracker.egress_changed(&snapshot));
    }

    #[test]
    fn model_gauges_and_path_epoch_survive_the_wire_without_u32_truncation() {
        let model = PerfEgressModel {
            epoch: 17,
            bw: 4_294_967_311,
            rtprop_us: 120_000,
            pacing_rate: 8_589_934_609,
            bulk_cap: 65_536,
            quantum: 1_200,
            phase: 5,
            probes_gated: 1,
            probes_aborted: 2,
            interactive_in_probe: 3,
            queue_growth_cuts: 4,
            loss_rounds: 5,
            ce_rounds: 6,
            probe_rtts: 7,
        };
        let snapshot = PerfEgressSnapshot {
            daemon_model: model,
            edge_model: model,
            ..Default::default()
        };
        let body = encode_perf_egress(&snapshot, 1);
        let expected: [u32; 19] = [
            17, 1, 15, 0, 120_000, 2, 17, 0, 65_536, 0, 1_200, 5, 1, 2, 3, 4, 5, 6, 7,
        ];
        for offset in [108, 184] {
            for (index, value) in expected.into_iter().enumerate() {
                assert_eq!(
                    &body[offset + index * 4..offset + index * 4 + 4],
                    &value.to_be_bytes()
                );
            }
        }
        let frame = crate::network::protocol::encode_proto_frame(
            crate::network::protocol::MSG_TYPE_PERF_EGRESS,
            &body,
        );
        assert_eq!(
            &frame[1..4],
            &[0, 1, 4],
            "260-byte body needs the full length field"
        );
        assert_eq!(
            crate::network::protocol::decode_proto_frame(&frame),
            Some((crate::network::protocol::MSG_TYPE_PERF_EGRESS, body.as_slice()))
        );
    }

    /// The watch ring is process-global, like the datagram observer feeding it.
    static ACK_WATCH_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A sealed datagram payload whose AEAD tag starts with `tag`.
    fn sealed_payload(tag: u64) -> [u8; 24] {
        let mut payload = [0xa5; 24];
        payload[8..16].copy_from_slice(&tag.to_le_bytes());
        payload
    }

    fn echo(tracker: &mut PerfTimingTracker, seq: u32, base: Instant, read_us: u64) {
        tracker.note_pty_read(at(base, read_us));
        tracker.note_grid_applied(at(base, read_us + 10));
        tracker.note_display_sent(seq, inline_stamps(base, read_us + 20, read_us + 30));
    }

    /// Every input record the tracker sends from `now`, its tail included, in
    /// wire order.
    fn sent_inputs(tracker: &mut PerfTimingTracker, now: Instant) -> Vec<PerfTimingRecord> {
        let mut batch = Some(tracker.take_due_wire_batch(now).expect("due batch"));
        let mut inputs = Vec::new();
        while let Some(due) = batch {
            inputs.extend(
                due.records
                    .iter()
                    .copied()
                    .filter(|record| !record.is_display_operation()),
            );
            tracker.accept_wire_batch(&due, now);
            batch = tracker.take_due_wire_batch(now + PERF_TIMING_BATCH_TAIL);
        }
        inputs
    }

    #[test]
    fn acknowledgment_terms_run_from_enqueue_through_completion_to_packetization() {
        let _watch = ACK_WATCH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        let base = Instant::now();
        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        tracker.note_pty_write_completed_owned(1, at(base, 40));
        let tag = 0x5eed_0001_u64;
        tracker.note_input_ack_sent(1, tag);
        observe_ack_packetized(&sealed_payload(tag), at(base, 90));
        echo(&mut tracker, 1, base, 200);

        let record = sent_inputs(&mut tracker, at(base, 30_000))[0];
        assert_eq!(record.write_completion_us, 30);
        assert_eq!(record.ack_transmit_us, 50);
        // The echo partition does not absorb either acknowledgment term.
        assert_eq!(record.recv_to_pty_us, 10);
        assert_eq!(record.pty_to_read_us, 190);
    }

    #[test]
    fn a_completion_and_packetization_after_the_echo_record_still_resolve() {
        let _watch = ACK_WATCH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        let base = Instant::now();
        tracker.note_input_received(4, base);
        tracker.note_pty_write(4, at(base, 10));
        echo(&mut tracker, 4, base, 50);
        assert!(tracker.pending.is_empty(), "the echo record is already ready");

        tracker.note_pty_write_completed_owned(4, at(base, 400));
        let tag = 0x5eed_0002_u64;
        tracker.note_input_ack_sent(4, tag);
        observe_ack_packetized(&sealed_payload(tag), at(base, 1_400));
        let record = sent_inputs(&mut tracker, at(base, 30_000))[0];
        assert_eq!(record.write_completion_us, 390);
        assert_eq!(record.ack_transmit_us, 1_000);
    }

    #[test]
    fn an_ack_never_packetized_is_unobserved_rather_than_zero() {
        let _watch = ACK_WATCH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        let base = Instant::now();
        tracker.note_input_received(2, base);
        tracker.note_pty_write(2, at(base, 10));
        tracker.note_pty_write_completed_owned(2, at(base, 20));
        tracker.note_input_ack_sent(2, 0x5eed_0003);
        // Another datagram's packetization resolves nothing.
        observe_ack_packetized(&sealed_payload(0x5eed_0004), at(base, 30));
        echo(&mut tracker, 2, base, 100);

        let record = sent_inputs(&mut tracker, at(base, 30_000))[0];
        assert_eq!(record.write_completion_us, 10);
        assert_eq!(record.ack_transmit_us, PERF_TIMING_UNOBSERVED_US);
    }

    #[test]
    fn a_reused_watch_slot_cannot_resolve_its_successor() {
        let _watch = ACK_WATCH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        let base = Instant::now();
        tracker.note_input_received(1, base);
        tracker.note_pty_write(1, at(base, 10));
        tracker.note_pty_write_completed_owned(1, at(base, 20));
        tracker.note_input_ack_sent(1, 0x5eed_1000);
        echo(&mut tracker, 1, base, 100);
        // One lap of the ring hands slot zero to a new tag with the same low
        // sixteen bits. Neither the old datagram's late packetization nor the
        // successor's may resolve the old ACK.
        for lap in 1..ack_watch::SLOTS as u64 {
            tracker.note_input_ack_sent(1, 0x5eed_1000 + lap);
        }
        tracker.note_input_ack_sent(1, 0x6eed_1000);
        observe_ack_packetized(&sealed_payload(0x5eed_1000), at(base, 500));
        observe_ack_packetized(&sealed_payload(0x6eed_1000), at(base, 600));
        let record = sent_inputs(&mut tracker, at(base, 30_000))[0];
        assert_eq!(record.ack_transmit_us, PERF_TIMING_UNOBSERVED_US);
    }

    #[test]
    fn each_input_is_measured_to_the_first_ack_that_carried_it() {
        let _watch = ACK_WATCH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        let base = Instant::now();
        for seq in 1..=3 {
            tracker.note_input_received(seq, base);
            tracker.note_pty_write(seq, at(base, 10));
        }
        // One turn confirms 1 and 2 under one cumulative ACK; 3 is still in
        // the FIFO, so that ACK must not claim it.
        tracker.note_pty_write_completed_owned(1, at(base, 20));
        tracker.note_pty_write_completed_owned(2, at(base, 30));
        tracker.note_input_ack_sent(2, 0x5eed_2001);
        tracker.note_pty_write_completed_owned(3, at(base, 50));
        tracker.note_input_ack_sent(3, 0x5eed_2002);
        observe_ack_packetized(&sealed_payload(0x5eed_2001), at(base, 100));
        observe_ack_packetized(&sealed_payload(0x5eed_2002), at(base, 150));
        tracker.note_pty_read(at(base, 200));
        tracker.note_grid_applied(at(base, 210));
        tracker.note_display_sent(3, inline_stamps(base, 220, 230));

        let transmit = sent_inputs(&mut tracker, at(base, 30_000))
            .into_iter()
            .map(|record| (record.input_seq, record.ack_transmit_us))
            .collect::<Vec<_>>();
        assert_eq!(transmit, vec![(1, 80), (2, 70), (3, 100)]);
    }

    #[test]
    fn profiling_samples_never_cross_an_authenticated_session_owner() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.configure(Arc::from("peer-a"), "session-a", true, 1);
        tracker.note_input_received_for("peer-a", "session-a", 1, base);
        tracker.note_pty_write_for("peer-a", "session-a", 1, at(base, 1));

        tracker.configure(Arc::from("peer-a"), "session-b", true, 1);
        assert!(!tracker.has_wire_update());
        tracker.note_pty_read(at(base, 2));
        tracker.note_grid_applied(at(base, 3));
        tracker.note_display_sent_for("peer-a", "session-a", 1, inline_stamps(base, 4, 5));
        tracker.note_input_received_for("peer-b", "session-b", 2, base);
        assert!(!tracker.has_ready());

        tracker.note_input_received_for("peer-a", "session-b", 3, base);
        tracker.note_pty_write_for("peer-a", "session-b", 3, at(base, 1));
        tracker.note_pty_read(at(base, 2));
        tracker.note_grid_applied(at(base, 3));
        tracker.note_display_sent_for("peer-a", "session-b", 3, inline_stamps(base, 4, 5));
        assert_eq!(tracker.drain()[0].input_seq, 3);
    }

    fn owner_stamp(busy_wall_us: u64, busy_cpu_us: u64, quinn_us: u64, registry_us: u64) -> owner::OwnerStamp {
        owner::OwnerStamp {
            busy_wall_ns: busy_wall_us * 1_000,
            busy_cpu_ns: busy_cpu_us * 1_000,
            quinn_wait_ns: quinn_us * 1_000,
            registry_wait_ns: registry_us * 1_000,
        }
    }

    /// An input's owner span runs from its own write, a display operation's
    /// from its flush, and both end at carrier submission; the flush's lock
    /// waits are the part of each span after the flush began.
    #[test]
    fn records_carry_the_owner_over_their_own_spans() {
        let base = Instant::now();
        let mut tracker = PerfTimingTracker::default();
        tracker.set_enabled(true);
        tracker.note_input_received(1, base);
        tracker.note_pty_write_stamped(1, at(base, 10), owner_stamp(1_000, 900, 40, 5));
        tracker.note_input_received(2, at(base, 20));
        tracker.note_pty_write_stamped(2, at(base, 30), owner_stamp(1_500, 1_100, 90, 5));
        tracker.note_pty_read(at(base, 40));
        tracker.note_grid_applied(at(base, 50));
        let mut display = inline_stamps(base, 60, 70);
        display.flush_owner = owner_stamp(2_000, 1_300, 140, 5);
        display.sent_owner = owner_stamp(4_500, 1_500, 2_340, 305);
        tracker.note_display_sent(2, display);

        let owners = tracker
            .drain()
            .into_iter()
            .map(|record| (record.input_seq, record.owner))
            .collect::<Vec<_>>();
        let terms = |cpu_us, off_cpu_us, quinn_wait_us, registry_wait_us| OwnerTerms {
            cpu_us,
            off_cpu_us,
            quinn_wait_us,
            registry_wait_us,
            flush_lock_wait_us: 2_200 + 300,
        };
        assert_eq!(
            owners,
            vec![
                (1, terms(600, 2_900, 2_300, 300)),
                (2, terms(400, 2_600, 2_250, 300)),
                (0, terms(200, 2_300, 2_200, 300)),
            ]
        );
    }

    /// Busy time off the CPU is wall less CPU per period, never negative, and
    /// a wait the owner spent idle between polls (an async lock) is no part
    /// of a busy period.
    #[test]
    fn owner_spans_saturate_and_keep_idle_waits_out_of_busy_time() {
        let earlier = owner_stamp(100, 50, 0, 0);
        assert_eq!(
            owner_stamp(100, 80, 0, 7_000).since(earlier),
            owner::OwnerSpan {
                cpu_us: 30,
                off_cpu_us: 0,
                quinn_wait_us: 0,
                registry_wait_us: 7_000,
            }
        );
        assert_eq!(earlier.since(owner_stamp(500, 400, 9, 9)), owner::OwnerSpan::default());
    }

    /// The owner's accounts, measured: a blocking wait inside a busy period is
    /// off the CPU, spinning is on it, an async wait between polls is neither,
    /// and an unobserved owner reads nothing at all.
    #[test]
    fn the_owner_ledger_splits_its_busy_periods_while_observed() {
        const BLOCKED: Duration = Duration::from_millis(30);
        const SPUN: Duration = Duration::from_millis(10);
        const IDLE: Duration = Duration::from_millis(200);
        let micros = |duration: Duration| duration.as_micros() as u32;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let held = Arc::new(std::sync::Mutex::new(()));
        let mut turns = Box::pin(owner::Turns(Box::pin(async {
            let mut spans = Vec::new();
            for observed in [true, false] {
                owner::observe(observed);
                tokio::task::yield_now().await;
                let start = owner::stamp(Instant::now());
                let (locked, is_locked) = std::sync::mpsc::channel();
                let holder = {
                    let held = Arc::clone(&held);
                    std::thread::spawn(move || {
                        let _held = held.lock().expect("held");
                        locked.send(()).expect("locked");
                        std::thread::sleep(BLOCKED);
                    })
                };
                is_locked.recv().expect("locked");
                drop(held.lock().expect("released"));
                holder.join().expect("holder");
                let spinning = Instant::now();
                let spin_start = owner::stamp(spinning);
                while spinning.elapsed() < SPUN
                    || (observed
                        && owner::stamp(Instant::now()).since(spin_start).cpu_us < micros(SPUN))
                {
                    assert!(spinning.elapsed() < Duration::from_secs(30), "owner CPU clock stalled");
                    std::hint::spin_loop();
                }
                let waiting = owner::registry_wait();
                tokio::time::sleep(IDLE).await;
                drop(waiting);
                spans.push(owner::stamp(Instant::now()).since(start));
            }
            owner::observe(false);
            spans
        })));
        let spans = runtime.block_on(std::future::poll_fn(|cx| {
            let result = std::future::Future::poll(turns.as_mut(), cx);
            let at = Instant::now();
            // The poll has ended: advancing the stamp's wall clock must add
            // exactly no busy time, however long this host deschedules us.
            assert_eq!(owner::stamp(at), owner::stamp(at + IDLE));
            result
        }));
        let observed = spans[0];
        assert!(observed.off_cpu_us >= micros(BLOCKED) * 2 / 3, "{observed:?}");
        assert!(observed.cpu_us >= micros(SPUN), "{observed:?}");
        assert!(observed.registry_wait_us >= micros(IDLE), "{observed:?}");
        assert_eq!(spans[1], owner::OwnerSpan::default());
    }
}
