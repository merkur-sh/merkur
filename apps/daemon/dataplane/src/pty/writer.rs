use std::io::{self, Write};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Sender, TrySendError, bounded};
use tokio::sync::mpsc;

use crate::connection::PeerTransport;
use crate::perf_trace::{self, TraceEvent, TraceToken};
use crate::pty::input_encoder::Sink;

/// Native diagnostic events, never terminal contents or a claim that an
/// arbitrary output read is the echo of an input. Ordinals name the physical
/// writer/reader operation independently of owner-loop scheduling order.
#[derive(Clone, Copy, Debug)]
pub enum PtyTraceEvent {
    WriteQueued {
        write_ordinal: u64,
        input_seq: u32,
        terminal_reply: bool,
        byte_len: usize,
        queued_writes: usize,
        queued_bytes: usize,
    },
    WriteDequeued {
        write_ordinal: u64,
    },
    WriteSyscallStarted {
        write_ordinal: u64,
    },
    WriteCompleted {
        write_ordinal: u64,
        accepted_bytes: usize,
        write_calls: u32,
        syscall_us: u64,
        success: bool,
    },
    WriteOwnerHandled {
        write_ordinal: u64,
    },
    ReadStarted {
        read_ordinal: u64,
    },
    ReadCompleted {
        read_ordinal: u64,
        byte_len: usize,
    },
    ReadOwnerHandled {
        read_ordinal: u64,
    },
    ReadGridApplied {
        read_ordinal: u64,
    },
    ReadBoundaryDiscard {
        read_ordinal: u64,
        had_prior_owner: bool,
        byte_len: usize,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct PtyTraceStamp {
    pub token: TraceToken,
    pub ordinal: u64,
}

impl PtyTraceStamp {
    pub fn record(self, at: Instant, event: PtyTraceEvent) {
        perf_trace::record_at(self.token, at, TraceEvent::Pty(event));
    }

    /// Record `event` now and return that instant, so the owner's profiler
    /// reuses this clock read rather than taking a second one.
    pub fn record_now(self, event: PtyTraceEvent) -> Instant {
        let at = Instant::now();
        self.record(at, event);
        at
    }
}

impl PtyTraceEvent {
    /// Local trace slots: 0=subkind, 1=operation ordinal, then variant fields.
    /// pty_enqueue: 0; input_seq, reply, bytes, queued entries, queued bytes.
    /// pty_write: 0=dequeued, 1=first syscall, 2=completed, 3=owner handled.
    ///   completed fields: accepted bytes, calls, syscall microseconds, success.
    /// pty_read: 0=started, 1=completed (followed by bytes).
    /// pty_read_handled: 0=owner handled, 1=grid applied.
    /// pty_boundary_discard: 0; prior owner present, bytes.
    /// All other slots are zero. These are a closed diagnostic vocabulary,
    /// not a browser/display wire contract.
    pub(crate) fn trace_fields(self) -> (&'static str, [u64; 16]) {
        let mut fields = [0; 16];
        let kind = match self {
            Self::WriteQueued {
                write_ordinal,
                input_seq,
                terminal_reply,
                byte_len,
                queued_writes,
                queued_bytes,
            } => {
                fields[..7].copy_from_slice(&[
                    0,
                    write_ordinal,
                    u64::from(input_seq),
                    u64::from(terminal_reply),
                    byte_len as u64,
                    queued_writes as u64,
                    queued_bytes as u64,
                ]);
                "pty_enqueue"
            }
            Self::WriteDequeued { write_ordinal } => {
                fields[1] = write_ordinal;
                "pty_write"
            }
            Self::WriteSyscallStarted { write_ordinal } => {
                fields[..2].copy_from_slice(&[1, write_ordinal]);
                "pty_write"
            }
            Self::WriteCompleted {
                write_ordinal,
                accepted_bytes,
                write_calls,
                syscall_us,
                success,
            } => {
                fields[..6].copy_from_slice(&[
                    2,
                    write_ordinal,
                    accepted_bytes as u64,
                    u64::from(write_calls),
                    syscall_us,
                    u64::from(success),
                ]);
                "pty_write"
            }
            Self::WriteOwnerHandled { write_ordinal } => {
                fields[..2].copy_from_slice(&[3, write_ordinal]);
                "pty_write"
            }
            Self::ReadStarted { read_ordinal } => {
                fields[1] = read_ordinal;
                "pty_read"
            }
            Self::ReadCompleted {
                read_ordinal,
                byte_len,
            } => {
                fields[..3].copy_from_slice(&[1, read_ordinal, byte_len as u64]);
                "pty_read"
            }
            Self::ReadOwnerHandled { read_ordinal } => {
                fields[1] = read_ordinal;
                "pty_read_handled"
            }
            Self::ReadGridApplied { read_ordinal } => {
                fields[..2].copy_from_slice(&[1, read_ordinal]);
                "pty_read_handled"
            }
            Self::ReadBoundaryDiscard {
                read_ordinal,
                had_prior_owner,
                byte_len,
            } => {
                fields[..4].copy_from_slice(&[
                    0,
                    read_ordinal,
                    u64::from(had_prior_owner),
                    byte_len as u64,
                ]);
                "pty_boundary_discard"
            }
        };
        (kind, fields)
    }
}

/// Resource bound on encoded user input awaiting the PTY. The browser's budget
/// of the same size bounds input *records*; the bytes a record encodes to
/// differ (a two-byte key record can be a twenty-byte Kitty sequence, a paste
/// gains its brackets), so a full browser budget can exceed this one and meet
/// `Full`, which admission already handles by retrying on the next completion.
/// Bytes remain charged until the owner loop processes their write completion.
pub const MAX_QUEUED_USER_PTY_BYTES: usize = 256 * 1024;
/// Terminal query replies share the FIFO but retain space when user input has
/// filled its budget, so a child waiting on a reply can make progress.
pub const MAX_QUEUED_PTY_REPLY_BYTES: usize = 64 * 1024;
/// Both traffic classes share this hard allocation bound. The per-class user
/// limit reserves reply capacity but must never allow the combined queue to
/// exceed it.
const MAX_QUEUED_PTY_BYTES: usize = MAX_QUEUED_USER_PTY_BYTES + MAX_QUEUED_PTY_REPLY_BYTES;

const MAX_QUEUED_USER_PTY_WRITES: usize = 2_048;
const MAX_QUEUED_PTY_WRITES: usize = 4_096;
/// Darwin's terminal input queue is only 1 KiB and a successful blocking
/// master write does not prove that the line discipline retained every byte.
/// Keep ordinary key/command input on the immediate path, but start pacing
/// bulk input while there is still ample headroom in that queue.
const MULTILINE_PASTE_PACING_THRESHOLD: usize = 256;
/// Never hand a bulk-input write larger than one quarter of Darwin's terminal
/// input queue to the line discipline at once. Two logical lines per burst
/// leave substantial queue headroom while avoiding a full millisecond of
/// scheduling overhead for every short pasted command.
const MULTILINE_PASTE_MAX_BURST_BYTES: usize = 256;
const MULTILINE_PASTE_LINES_PER_BURST: usize = 2;
const MULTILINE_PASTE_LINE_DELAY: Duration = Duration::from_millis(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PtyWriteSource {
    UserInput {
        peer_id: Arc<str>,
        seq: u32,
        via_transport: PeerTransport,
    },
    TerminalReply,
}

impl PtyWriteSource {
    fn is_user_input(&self) -> bool {
        matches!(self, Self::UserInput { .. })
    }
}

#[derive(Debug)]
pub enum PtyWriteCompletion {
    Delivered {
        source: PtyWriteSource,
        byte_len: usize,
        trace: Option<PtyTraceStamp>,
    },
    Failed {
        source: PtyWriteSource,
        byte_len: usize,
        error: io::Error,
        trace: Option<PtyTraceStamp>,
    },
}

impl PtyWriteCompletion {
    pub fn trace(&self) -> Option<PtyTraceStamp> {
        match self {
            Self::Delivered { trace, .. } | Self::Failed { trace, .. } => *trace,
        }
    }

    pub fn source(&self) -> &PtyWriteSource {
        match self {
            Self::Delivered { source, .. } | Self::Failed { source, .. } => source,
        }
    }

    pub(crate) fn byte_len(&self) -> usize {
        match self {
            Self::Delivered { byte_len, .. } | Self::Failed { byte_len, .. } => *byte_len,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PtyWriteQueueError {
    Full,
    Closed,
}

/// Bytes queued for one PTY write.
///
/// A keystroke is one to a few bytes, and the queue entry is handed to another
/// thread and dropped there — so the old `Vec<u8>` meant one allocation on the
/// input critical path and one cross-thread free per keystroke. The common case
/// now lives inline in the entry and never reaches the allocator; a paste chunk
/// still spills to the heap, and a caller that already owns its bytes keeps
/// handing them over by move rather than paying a copy to inline them.
///
/// `INLINE_PTY_WRITE_BYTES` is sized so the inline arm does not make the entry
/// larger than the `Vec` arm plus its tag. It covers every legacy key and
/// every Kitty key short of one reporting alternate keys and associated text
/// at once, which spills to the heap. The input encoder writes straight into
/// the payload (`Sink`), so a keystroke is encoded where it is queued.
///
/// An empty payload is a record that encoded to nothing — a release no flag
/// asked for — and still occupies its place in the FIFO, so its sequence is
/// confirmed exactly when every earlier one is, without a write.
pub(crate) enum PtyWritePayload {
    Inline {
        len: u8,
        bytes: [u8; INLINE_PTY_WRITE_BYTES],
    },
    Heap(Vec<u8>),
}

const INLINE_PTY_WRITE_BYTES: usize = 23;

impl PtyWritePayload {
    /// An empty payload that holds `capacity` bytes without growing.
    #[inline]
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        if capacity <= INLINE_PTY_WRITE_BYTES {
            Self::Inline {
                len: 0,
                bytes: [0u8; INLINE_PTY_WRITE_BYTES],
            }
        } else {
            Self::Heap(Vec::with_capacity(capacity))
        }
    }

    #[cfg(test)]
    pub(crate) fn borrowed(bytes: &[u8]) -> Self {
        let mut payload = Self::with_capacity(bytes.len());
        payload.put(bytes);
        payload
    }

    #[inline]
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Inline { len, bytes } => &bytes[..usize::from(*len)],
            Self::Heap(bytes) => bytes,
        }
    }

    #[inline]
    fn len(&self) -> usize {
        match self {
            Self::Inline { len, .. } => usize::from(*len),
            Self::Heap(bytes) => bytes.len(),
        }
    }

    #[inline]
    pub(crate) fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Sink for PtyWritePayload {
    #[inline]
    fn put(&mut self, more: &[u8]) {
        match self {
            Self::Inline { len, bytes } => {
                let start = usize::from(*len);
                let end = start + more.len();
                if end <= INLINE_PTY_WRITE_BYTES {
                    bytes[start..end].copy_from_slice(more);
                    *len = end as u8;
                } else {
                    let mut heap = Vec::with_capacity(end.max(2 * INLINE_PTY_WRITE_BYTES));
                    heap.extend_from_slice(&bytes[..start]);
                    heap.extend_from_slice(more);
                    *self = Self::Heap(heap);
                }
            }
            Self::Heap(bytes) => bytes.extend_from_slice(more),
        }
    }
}

struct QueuedPtyWrite {
    source: PtyWriteSource,
    payload: PtyWritePayload,
    trace: Option<PtyTraceStamp>,
}

pub struct PtyWriter {
    write_tx: Sender<QueuedPtyWrite>,
    queued_bytes: usize,
    queued_user_bytes: usize,
    queued_writes: usize,
    queued_user_writes: usize,
    closed: bool,
    next_write_ordinal: u64,
    #[cfg(merkur_sim)]
    inline: InlineWriter,
}

impl PtyWriter {
    pub fn new(
        writer: Box<dyn Write + Send>,
    ) -> io::Result<(Self, mpsc::UnboundedReceiver<PtyWriteCompletion>)> {
        let (write_tx, write_rx) = bounded::<QueuedPtyWrite>(MAX_QUEUED_PTY_WRITES);
        // This completion channel is unbounded in type so the blocking writer
        // never waits on the async owner. It is bounded by the admission
        // invariant: `queued_writes` is released only by `finish`, so at most
        // MAX_QUEUED_PTY_WRITES completions can exist without being observed.
        let (completion_tx, completion_rx) = mpsc::unbounded_channel();

        #[cfg(not(merkur_sim))]
        thread::Builder::new()
            .name("merkur-pty-writer".to_string())
            .spawn(move || run_writer(writer, write_rx, completion_tx))?;

        Ok((
            Self {
                write_tx,
                queued_bytes: 0,
                queued_user_bytes: 0,
                queued_writes: 0,
                queued_user_writes: 0,
                closed: false,
                next_write_ordinal: 1,
                #[cfg(merkur_sim)]
                inline: InlineWriter {
                    writer,
                    write_rx,
                    completion_tx,
                    input_pacer: PtyInputPacer::default(),
                    stopped: false,
                },
            },
            completion_rx,
        ))
    }

    /// Performs every queued write, as the writer thread would have by now.
    #[cfg(merkur_sim)]
    pub fn run_inline(&mut self) {
        let inline = &mut self.inline;
        while !inline.stopped
            && let Ok(write) = inline.write_rx.try_recv()
        {
            inline.stopped = !write_queued(
                inline.writer.as_mut(),
                write,
                &mut inline.input_pacer,
                &inline.completion_tx,
            );
        }
    }

    pub fn try_enqueue_user(
        &mut self,
        peer_id: Arc<str>,
        seq: u32,
        via_transport: PeerTransport,
        payload: PtyWritePayload,
        trace_token: Option<TraceToken>,
    ) -> Result<(), PtyWriteQueueError> {
        if self.closed {
            return Err(PtyWriteQueueError::Closed);
        }
        let byte_len = payload.len();
        if self.queued_user_writes >= MAX_QUEUED_USER_PTY_WRITES
            || self.queued_writes >= MAX_QUEUED_PTY_WRITES
            || byte_len > MAX_QUEUED_USER_PTY_BYTES.saturating_sub(self.queued_user_bytes)
            || byte_len > MAX_QUEUED_PTY_BYTES.saturating_sub(self.queued_bytes)
        {
            return Err(PtyWriteQueueError::Full);
        }

        self.try_enqueue(QueuedPtyWrite {
            source: PtyWriteSource::UserInput {
                peer_id,
                seq,
                via_transport,
            },
            payload,
            trace: trace_token.map(|token| PtyTraceStamp {
                token,
                ordinal: self.next_write_ordinal,
            }),
        })
    }

    pub fn try_enqueue_terminal_reply(&mut self, bytes: Vec<u8>) -> Result<(), PtyWriteQueueError> {
        if self.closed {
            return Err(PtyWriteQueueError::Closed);
        }
        if self.queued_writes >= MAX_QUEUED_PTY_WRITES
            || bytes.len() > MAX_QUEUED_PTY_BYTES.saturating_sub(self.queued_bytes)
        {
            return Err(PtyWriteQueueError::Full);
        }

        self.try_enqueue(QueuedPtyWrite {
            source: PtyWriteSource::TerminalReply,
            payload: PtyWritePayload::Heap(bytes),
            trace: perf_trace::active_token().map(|token| PtyTraceStamp {
                token,
                ordinal: self.next_write_ordinal,
            }),
        })
    }

    fn try_enqueue(&mut self, write: QueuedPtyWrite) -> Result<(), PtyWriteQueueError> {
        let byte_len = write.payload.len();
        let is_user_input = write.source.is_user_input();
        let trace = write.trace;
        let queued_at = trace.map(|_| Instant::now());
        let input_seq = match write.source {
            PtyWriteSource::UserInput { seq, .. } => seq,
            PtyWriteSource::TerminalReply => 0,
        };
        match self.write_tx.try_send(write) {
            Ok(()) => {
                self.next_write_ordinal = self.next_write_ordinal.wrapping_add(1);
                self.queued_bytes += byte_len;
                self.queued_writes += 1;
                if is_user_input {
                    self.queued_user_bytes += byte_len;
                    self.queued_user_writes += 1;
                }
                if let (Some(trace), Some(at)) = (trace, queued_at) {
                    trace.record(
                        at,
                        PtyTraceEvent::WriteQueued {
                            write_ordinal: trace.ordinal,
                            input_seq,
                            terminal_reply: !is_user_input,
                            byte_len,
                            queued_writes: self.queued_writes,
                            queued_bytes: self.queued_bytes,
                        },
                    );
                }
                Ok(())
            }
            Err(TrySendError::Full(_)) => Err(PtyWriteQueueError::Full),
            Err(TrySendError::Disconnected(_)) => {
                self.closed = true;
                Err(PtyWriteQueueError::Closed)
            }
        }
    }

    /// Nothing written is outstanding: every queued write's completion has been
    /// observed. A write offered now reaches the PTY before anything else, so
    /// its completion follows unless the kernel's input queue is full.
    pub fn is_idle(&self) -> bool {
        self.queued_writes == 0
    }

    /// Releases byte/entry accounting only when the owner loop observes the
    /// worker completion. This keeps the bound deterministic even if the worker
    /// runs ahead while the owner is busy with terminal output.
    pub fn finish(&mut self, completion: &PtyWriteCompletion) {
        self.queued_bytes = self.queued_bytes.saturating_sub(completion.byte_len());
        self.queued_writes = self.queued_writes.saturating_sub(1);
        if completion.source().is_user_input() {
            self.queued_user_bytes = self.queued_user_bytes.saturating_sub(completion.byte_len());
            self.queued_user_writes = self.queued_user_writes.saturating_sub(1);
        }
        if matches!(completion, PtyWriteCompletion::Failed { .. }) {
            self.closed = true;
        }
    }

    #[cfg(test)]
    fn queued_user_bytes(&self) -> usize {
        self.queued_user_bytes
    }
}

#[cfg(not(merkur_sim))]
fn run_writer(
    mut writer: Box<dyn Write + Send>,
    write_rx: crossbeam_channel::Receiver<QueuedPtyWrite>,
    completion_tx: mpsc::UnboundedSender<PtyWriteCompletion>,
) {
    let mut input_pacer = PtyInputPacer::default();
    while let Ok(write) = write_rx.recv() {
        if !write_queued(writer.as_mut(), write, &mut input_pacer, &completion_tx) {
            break;
        }
    }
}

/// Performs one FIFO entry and reports it to the owner loop; `false` ends the
/// writer.
fn write_queued(
    writer: &mut dyn Write,
    write: QueuedPtyWrite,
    input_pacer: &mut PtyInputPacer,
    completion_tx: &mpsc::UnboundedSender<PtyWriteCompletion>,
) -> bool {
    let byte_len = write.payload.len();
    let result = if let Some(trace) = write.trace {
        trace.record(
            Instant::now(),
            PtyTraceEvent::WriteDequeued {
                write_ordinal: trace.ordinal,
            },
        );
        let mut observed = ObservedWriter::new(writer, trace);
        let result = perform_queued_write(&mut observed, &write, input_pacer);
        observed.finish(result.is_ok());
        result
    } else {
        perform_queued_write(writer, &write, input_pacer)
    };
    match result {
        Ok(()) => completion_tx
            .send(PtyWriteCompletion::Delivered {
                source: write.source,
                byte_len,
                trace: write.trace,
            })
            .is_ok(),
        Err(error) => {
            let _ = completion_tx.send(PtyWriteCompletion::Failed {
                source: write.source,
                byte_len,
                error,
                trace: write.trace,
            });
            // A fatal error after a short write leaves an unknown prefix in
            // the PTY. Never retry or write later FIFO entries over it.
            false
        }
    }
}

/// The network simulator's writer: the FIFO `merkur-pty-writer` would drain,
/// drained on the owner loop at the top of each turn (`crate::sim`).
#[cfg(merkur_sim)]
struct InlineWriter {
    writer: Box<dyn Write + Send>,
    write_rx: crossbeam_channel::Receiver<QueuedPtyWrite>,
    completion_tx: mpsc::UnboundedSender<PtyWriteCompletion>,
    input_pacer: PtyInputPacer,
    stopped: bool,
}

fn perform_queued_write(
    writer: &mut dyn Write,
    write: &QueuedPtyWrite,
    input_pacer: &mut PtyInputPacer,
) -> io::Result<()> {
    if write.source.is_user_input() {
        write_user_input_blocking(writer, write.payload.as_slice(), input_pacer)
    } else {
        input_pacer.pause_before_unpaced_write();
        write_all_blocking(writer, write.payload.as_slice())
    }
}

/// Exists only for a profiled FIFO entry. Ordinary input still calls the
/// original writer directly: no clock, allocation, or per-syscall counters.
struct ObservedWriter<'a> {
    writer: &'a mut dyn Write,
    trace: PtyTraceStamp,
    accepted_bytes: usize,
    write_calls: u32,
    syscall_time: Duration,
    last_write_returned_at: Option<Instant>,
}

impl<'a> ObservedWriter<'a> {
    fn new(writer: &'a mut dyn Write, trace: PtyTraceStamp) -> Self {
        Self {
            writer,
            trace,
            accepted_bytes: 0,
            write_calls: 0,
            syscall_time: Duration::ZERO,
            last_write_returned_at: None,
        }
    }

    fn finish(&self, success: bool) {
        self.trace.record(
            self.last_write_returned_at.unwrap_or_else(Instant::now),
            PtyTraceEvent::WriteCompleted {
                write_ordinal: self.trace.ordinal,
                accepted_bytes: self.accepted_bytes,
                write_calls: self.write_calls,
                syscall_us: self.syscall_time.as_micros().try_into().unwrap_or(u64::MAX),
                success,
            },
        );
    }
}

impl Write for ObservedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let first = self.write_calls == 0;
        self.write_calls = self.write_calls.saturating_add(1);
        let started = Instant::now();
        let result = self.writer.write(bytes);
        let returned = Instant::now();
        self.last_write_returned_at = Some(returned);
        self.syscall_time += returned.saturating_duration_since(started);
        // Publish after the syscall, with its original boundary, so recorder
        // work is never charged to kernel write time. A blocked call remains
        // visible as a dequeued operation with no completion yet.
        if first {
            self.trace.record(
                started,
                PtyTraceEvent::WriteSyscallStarted {
                    write_ordinal: self.trace.ordinal,
                },
            );
        }
        if let Ok(accepted) = result {
            self.accepted_bytes += accepted;
        }
        result
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

#[derive(Default)]
struct PtyInputPacer {
    /// A browser paste is split into independent 8 KiB protocol entries. Carry
    /// the pacing edge across FIFO entries so the boundary cannot recreate an
    /// unbounded back-to-back PTY write.
    pause_before_next_write: bool,
}

impl PtyInputPacer {
    #[expect(
        clippy::disallowed_methods,
        reason = "the kernel takes a PTY write while its input queue discards bytes and gives no edge when the queue has room, so a write after a bulk burst waits out the pacing delay"
    )]
    fn pause_before_unpaced_write(&mut self) {
        if self.pause_before_next_write {
            thread::sleep(MULTILINE_PASTE_LINE_DELAY);
            self.pause_before_next_write = false;
        }
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "the kernel takes a PTY write while its input queue discards bytes and gives no edge when the queue has room, so bulk input is paced by a delay; a write under the pacing threshold never sleeps"
)]
fn write_user_input_blocking(
    writer: &mut dyn Write,
    bytes: &[u8],
    pacer: &mut PtyInputPacer,
) -> io::Result<()> {
    write_user_input_with_pacing(writer, bytes, pacer, thread::sleep)
}

fn write_user_input_with_pacing(
    writer: &mut dyn Write,
    bytes: &[u8],
    pacer: &mut PtyInputPacer,
    mut pause: impl FnMut(Duration),
) -> io::Result<()> {
    if bytes.is_empty() {
        // A record that encoded to nothing: no write, and the pacing edge a
        // paste left behind still belongs to the next real write.
        return Ok(());
    }
    if bytes.len() < MULTILINE_PASTE_PACING_THRESHOLD {
        // The pacing edge bounds *bulk* admission into a small kernel input
        // queue. This entry is an ordinary keystroke or command, so it is not
        // the traffic the bound exists for — and it is the one thing on this
        // thread with a human waiting on it. Consume the edge without sleeping:
        // a key typed right after a paste used to pay a millisecond for the
        // paste's last burst.
        pacer.pause_before_next_write = false;
        return write_all_blocking(writer, bytes);
    }

    let mut remaining = bytes;
    while !remaining.is_empty() {
        if pacer.pause_before_next_write {
            pause(MULTILINE_PASTE_LINE_DELAY);
            pacer.pause_before_next_write = false;
        }

        let split_at = next_paced_input_burst_len(remaining);
        write_all_blocking(writer, &remaining[..split_at])?;
        remaining = &remaining[split_at..];
        // PTY master writes can succeed after the slave input queue has started
        // discarding input. Rate-limit admission before the next burst rather
        // than retrying a write the kernel already reported as successful.
        pacer.pause_before_next_write = true;
    }
    Ok(())
}

fn next_paced_input_burst_len(bytes: &[u8]) -> usize {
    let capped_len = bytes.len().min(MULTILINE_PASTE_MAX_BURST_BYTES);
    let mut split_at = 0;
    for _ in 0..MULTILINE_PASTE_LINES_PER_BURST {
        let Some(line_end) = bytes[split_at..capped_len]
            .iter()
            .position(|byte| matches!(byte, b'\r' | b'\n'))
        else {
            break;
        };
        split_at += line_end + 1;
        while split_at < capped_len
            && bytes
                .get(split_at)
                .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
        {
            split_at += 1;
        }
    }
    if split_at == 0 { capped_len } else { split_at }
}

/// Drain one FIFO entry through the blocking PTY writer.
///
/// `spawn_pty` explicitly keeps the PTY master in blocking mode, so kernel
/// writability is the wakeup edge. A `WouldBlock` result therefore means the
/// sink contract was violated (or a non-PTY test sink was supplied) and is
/// terminal; sleeping and trying again here would turn backpressure into a
/// permanent 1ms timer loop. Only `Interrupted` is safe to retry blindly.
fn write_all_blocking(writer: &mut dyn Write, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        match writer.write(bytes) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn trace_layout_names_physical_operations_without_echo_claims() {
        let (kind, fields) = PtyTraceEvent::WriteQueued {
            write_ordinal: 8,
            input_seq: 9,
            terminal_reply: false,
            byte_len: 1,
            queued_writes: 2,
            queued_bytes: 3,
        }
        .trace_fields();
        assert_eq!(kind, "pty_enqueue");
        assert_eq!(&fields[..7], &[0, 8, 9, 0, 1, 2, 3]);
        assert!(fields[7..].iter().all(|field| *field == 0));
        for (event, subkind) in [
            (PtyTraceEvent::WriteDequeued { write_ordinal: 8 }, 0),
            (PtyTraceEvent::WriteSyscallStarted { write_ordinal: 8 }, 1),
            (PtyTraceEvent::WriteOwnerHandled { write_ordinal: 8 }, 3),
        ] {
            let (kind, fields) = event.trace_fields();
            assert_eq!(kind, "pty_write");
            assert_eq!(&fields[..2], &[subkind, 8]);
        }
        let (kind, fields) = PtyTraceEvent::WriteCompleted {
            write_ordinal: 8,
            accepted_bytes: 2,
            write_calls: 3,
            syscall_us: 17,
            success: false,
        }
        .trace_fields();
        assert_eq!(kind, "pty_write");
        assert_eq!(&fields[..6], &[2, 8, 2, 3, 17, 0]);
    }

    #[test]
    fn observed_writer_preserves_partial_failure_and_interrupted_call_counts() {
        let (mut writer, output) = scripted_writer(vec![
            WriteStep::Interrupted,
            WriteStep::Bytes(2),
            WriteStep::Fail,
        ]);
        let mut observed = ObservedWriter::new(
            &mut writer,
            PtyTraceStamp {
                token: TraceToken { owner: u64::MAX },
                ordinal: 13,
            },
        );
        let result = write_all_blocking(&mut observed, b"abcdef");
        assert!(result.is_err());
        assert_eq!(observed.accepted_bytes, 2);
        assert_eq!(observed.write_calls, 3);
        assert_eq!(&*output.lock().unwrap(), b"ab");
    }

    #[test]
    fn observed_writer_measures_forced_block_inside_actual_write() {
        struct BlockedWriter {
            entered: crossbeam_channel::Sender<Instant>,
            release: crossbeam_channel::Receiver<()>,
        }
        impl Write for BlockedWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.entered.send(Instant::now()).unwrap();
                self.release.recv_timeout(Duration::from_secs(1)).unwrap();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let (entered_tx, entered_rx) = bounded(1);
        let (release_tx, release_rx) = bounded(1);
        let worker = thread::spawn(move || {
            let mut writer = BlockedWriter {
                entered: entered_tx,
                release: release_rx,
            };
            let mut observed = ObservedWriter::new(
                &mut writer,
                PtyTraceStamp {
                    token: TraceToken { owner: u64::MAX },
                    ordinal: 14,
                },
            );
            write_all_blocking(&mut observed, b"x").unwrap();
            (
                observed.syscall_time,
                observed.accepted_bytes,
                observed.write_calls,
            )
        });
        let entered = entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        // A deliberately stalled sink, not a performance-budget assertion.
        thread::sleep(Duration::from_millis(5));
        let released = Instant::now();
        release_tx.send(()).unwrap();
        let (syscall_time, bytes, calls) = worker.join().unwrap();
        assert!(syscall_time >= released.duration_since(entered));
        assert_eq!((bytes, calls), (1, 1));
    }

    /// Idle means no completion is outstanding as the owner sees it: a queued
    /// write stays outstanding until its completion is observed, even after the
    /// worker has already written it.
    #[tokio::test]
    async fn the_writer_is_idle_only_once_every_completion_is_observed() {
        let (mut writer, mut completions) = PtyWriter::new(Box::new(NullWriter)).unwrap();
        assert!(writer.is_idle());
        writer
            .try_enqueue_user(
                Arc::from("peer"),
                1,
                PeerTransport::Edge,
                PtyWritePayload::borrowed(b"x"),
                None,
            )
            .unwrap();
        assert!(!writer.is_idle());
        let completion = completions.recv().await.unwrap();
        assert!(!writer.is_idle(), "written, but not yet observed");
        writer.finish(&completion);
        assert!(writer.is_idle());
    }

    #[tokio::test]
    async fn queued_diagnostic_identity_survives_later_observation_tokens() {
        let (mut writer, mut completions) = PtyWriter::new(Box::new(NullWriter)).unwrap();
        let peer: Arc<str> = Arc::from("peer");
        let old = TraceToken {
            owner: u64::MAX - 1,
        };
        let new = TraceToken { owner: u64::MAX };
        writer
            .try_enqueue_user(
                Arc::clone(&peer),
                1,
                PeerTransport::Edge,
                PtyWritePayload::borrowed(b"x"),
                Some(old),
            )
            .unwrap();
        writer
            .try_enqueue_user(
                peer,
                2,
                PeerTransport::Edge,
                PtyWritePayload::borrowed(b"y"),
                Some(new),
            )
            .unwrap();
        let first = completions.recv().await.unwrap();
        let second = completions.recv().await.unwrap();
        assert_eq!(first.trace().unwrap().token, old);
        assert_eq!(second.trace().unwrap().token, new);
        assert!(first.trace().unwrap().ordinal < second.trace().unwrap().ordinal);
        writer.finish(&first);
        writer.finish(&second);
        assert_eq!(writer.queued_user_bytes(), 0);
    }

    /// A sink that discards, so the oracle below measures the queue rather than
    /// the terminal underneath it.
    struct NullWriter;

    impl Write for NullWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Queueing a keystroke must not reach the allocator.
    ///
    /// The payload used to be a `Vec<u8>`, so every keypress — one to four bytes
    /// — cost one allocation on the input critical path and one free on the
    /// writer thread, which is a different thread from the one that allocated
    /// it. This is a structural claim, not a latency one: the win is jitter and
    /// cross-thread allocator traffic, and it is stated as an exact count
    /// precisely so it cannot be restated as a wall-clock number.
    ///
    /// The spilling arm is asserted in the same test so the inline bound cannot
    /// be quietly widened until pastes start being copied twice.
    ///
    /// Keys are measured from the record: decoding it and encoding it into the
    /// payload is part of queueing it, so neither may allocate either. Counted
    /// on the owner thread only, which is the input critical path; the writer
    /// thread's completion channel is its own traffic.
    #[test]
    #[ignore = "production performance workload"]
    fn queued_keystrokes_never_reach_the_allocator() {
        use crate::network::input_record::{self, build, mods};
        use crate::pty::input_encoder;
        use alacritty_terminal::term::TermMode;

        const KEYSTROKES: usize = 512;
        let (mut writer, _completions) = PtyWriter::new(Box::new(NullWriter)).expect("writer");
        let peer: Arc<str> = Arc::from("browser-bench");
        // Ctrl+Right under Kitty's disambiguate flag: `CSI 1;5C`.
        let record = build::functional(0xE007, 0, mods::CTRL);
        let mode = TermMode::DISAMBIGUATE_ESC_CODES;
        let encode = |record: &[u8]| {
            let decoded = input_record::decode(record).expect("canonical record");
            let mut payload =
                PtyWritePayload::with_capacity(input_encoder::encoded_len_hint(record));
            input_encoder::encode(&decoded, mode, &mut payload);
            payload
        };

        // Warm the channel and the Arc so first-touch growth is not counted.
        for seq in 0..8u32 {
            writer
                .try_enqueue_user(
                    Arc::clone(&peer),
                    seq,
                    PeerTransport::Edge,
                    encode(&record),
                    None,
                )
                .expect("warm enqueue");
        }

        crate::edge_tunnel::test_allocations::begin_thread();
        for seq in 0..KEYSTROKES {
            writer
                .try_enqueue_user(
                    Arc::clone(&peer),
                    seq as u32,
                    PeerTransport::Edge,
                    encode(&record),
                    None,
                )
                .expect("enqueue");
        }
        let inline = crate::edge_tunnel::test_allocations::end_thread();

        assert_eq!(
            inline.allocations, 0,
            "a keystroke must not allocate; got {} allocations and {} bytes for {KEYSTROKES} keys",
            inline.allocations, inline.allocated_bytes
        );

        let paste = build::paste(&"x".repeat(INLINE_PTY_WRITE_BYTES + 1));
        crate::edge_tunnel::test_allocations::begin_thread();
        writer
            .try_enqueue_user(
                Arc::clone(&peer),
                9_999,
                PeerTransport::Edge,
                encode(&paste),
                None,
            )
            .expect("enqueue paste");
        let spilled = crate::edge_tunnel::test_allocations::end_thread();

        assert_eq!(
            spilled.allocations, 1,
            "a payload past the inline bound spills to exactly one allocation"
        );

        println!(
            "@@merkur-perf {{\"name\":\"pty-keystroke-enqueue-allocations\",\"value\":{},\"unit\":\"allocations/keystroke\",\"direction\":\"lower\",\"sampleSize\":{KEYSTROKES}}}",
            inline.allocations / KEYSTROKES
        );
    }

    enum WriteStep {
        Bytes(usize),
        WouldBlock,
        Interrupted,
        Fail,
    }

    struct ScriptedWriter {
        output: Arc<Mutex<Vec<u8>>>,
        steps: VecDeque<WriteStep>,
    }

    #[derive(Default)]
    struct RecordingWriter {
        output: Vec<u8>,
        request_lengths: Vec<usize>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.request_lengths.push(bytes.len());
            self.output.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Write for ScriptedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            match self.steps.pop_front() {
                Some(WriteStep::Bytes(limit)) => {
                    let written = limit.min(bytes.len());
                    self.output
                        .lock()
                        .unwrap()
                        .extend_from_slice(&bytes[..written]);
                    Ok(written)
                }
                Some(WriteStep::WouldBlock) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
                Some(WriteStep::Interrupted) => Err(io::Error::from(io::ErrorKind::Interrupted)),
                Some(WriteStep::Fail) => Err(io::Error::new(io::ErrorKind::BrokenPipe, "failed")),
                None => {
                    self.output.lock().unwrap().extend_from_slice(bytes);
                    Ok(bytes.len())
                }
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn scripted_writer(steps: Vec<WriteStep>) -> (ScriptedWriter, Arc<Mutex<Vec<u8>>>) {
        let output = Arc::new(Mutex::new(Vec::new()));
        (
            ScriptedWriter {
                output: Arc::clone(&output),
                steps: steps.into(),
            },
            output,
        )
    }

    #[test]
    fn blocking_write_handles_short_and_interrupted_writes() {
        let (mut writer, output) = scripted_writer(vec![
            WriteStep::Bytes(2),
            WriteStep::Interrupted,
            WriteStep::Bytes(1),
        ]);

        write_all_blocking(&mut writer, b"abcdef").unwrap();

        assert_eq!(&*output.lock().unwrap(), b"abcdef");
    }

    #[test]
    fn blocking_write_does_not_poll_after_would_block() {
        let (mut writer, output) = scripted_writer(vec![
            WriteStep::Bytes(2),
            WriteStep::WouldBlock,
            WriteStep::Bytes(4),
        ]);

        let error = write_all_blocking(&mut writer, b"abcdef").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(
            &*output.lock().unwrap(),
            b"ab",
            "a WouldBlock contract violation must not enter a hidden retry loop"
        );
    }

    #[test]
    fn blocking_write_reports_failure_after_a_partial_write() {
        let (mut writer, output) = scripted_writer(vec![WriteStep::Bytes(3), WriteStep::Fail]);

        let error = write_all_blocking(&mut writer, b"abcdef").unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(&*output.lock().unwrap(), b"abc");
    }

    #[test]
    fn large_multiline_user_input_is_paced_two_bounded_lines_at_a_time() {
        let mut writer = RecordingWriter::default();
        let mut pacer = PtyInputPacer::default();
        let mut pauses = Vec::new();
        let mut input = vec![b'x'; MULTILINE_PASTE_PACING_THRESHOLD];
        let line_prefix: Vec<u8> = (0..17).flat_map(|_| *b"a\n").collect();
        input.splice(..line_prefix.len(), line_prefix.iter().copied());

        write_user_input_with_pacing(&mut writer, &input, &mut pacer, |delay| {
            pauses.push(delay);
        })
        .unwrap();

        assert_eq!(writer.output, input);
        assert_eq!(
            writer.request_lengths,
            [vec![4; 8], vec![2], vec![input.len() - line_prefix.len()],].concat()
        );
        assert_eq!(
            pauses,
            vec![MULTILINE_PASTE_LINE_DELAY; writer.request_lengths.len() - 1]
        );
        assert!(pacer.pause_before_next_write);
    }

    #[test]
    fn bulk_input_pacing_still_paces_every_bulk_entry_boundary() {
        let mut writer = RecordingWriter::default();
        let mut pacer = PtyInputPacer::default();
        let mut pauses = Vec::new();
        let first = vec![b'x'; MULTILINE_PASTE_PACING_THRESHOLD];
        let second = vec![b'y'; MULTILINE_PASTE_PACING_THRESHOLD];

        write_user_input_with_pacing(&mut writer, &first, &mut pacer, |delay| {
            pauses.push(delay);
        })
        .unwrap();
        write_user_input_with_pacing(&mut writer, &second, &mut pacer, |delay| {
            pauses.push(delay);
        })
        .unwrap();

        assert_eq!(writer.output, [first, second].concat());
        // Each entry is exactly one burst, so the only pause in this sequence is
        // the one carried across the entry boundary — which is the property.
        assert_eq!(
            pauses,
            vec![MULTILINE_PASTE_LINE_DELAY],
            "the pacing edge must survive the boundary between two bulk entries",
        );
        assert!(pacer.pause_before_next_write);
    }

    #[test]
    fn a_keystroke_after_a_paste_consumes_the_pacing_edge_without_waiting() {
        let mut writer = RecordingWriter::default();
        let mut pacer = PtyInputPacer::default();
        let mut pauses = Vec::new();
        let paste = vec![b'x'; MULTILINE_PASTE_PACING_THRESHOLD];

        write_user_input_with_pacing(&mut writer, &paste, &mut pacer, |delay| {
            pauses.push(delay);
        })
        .unwrap();
        let paste_pauses = pauses.len();
        // The edge bounds bulk admission into a ~1 KiB kernel input queue. One
        // sub-threshold write on top of a 256-byte burst stays well inside that
        // queue, and it is the write with a human waiting on it.
        write_user_input_with_pacing(&mut writer, b"a", &mut pacer, |delay| {
            pauses.push(delay);
        })
        .unwrap();

        assert_eq!(writer.output, [paste, b"a".to_vec()].concat());
        assert_eq!(pauses.len(), paste_pauses);
        assert!(!pacer.pause_before_next_write);
    }

    #[test]
    fn ordinary_input_retains_the_single_write_zero_delay_fast_path() {
        let mut writer = RecordingWriter::default();
        let mut pacer = PtyInputPacer::default();
        let input = vec![b'a'; MULTILINE_PASTE_PACING_THRESHOLD - 1];
        let mut pauses = Vec::new();

        write_user_input_with_pacing(&mut writer, &input, &mut pacer, |delay| {
            pauses.push(delay);
        })
        .unwrap();

        assert_eq!(writer.output, input);
        assert_eq!(
            writer.request_lengths,
            vec![MULTILINE_PASTE_PACING_THRESHOLD - 1]
        );
        assert!(pauses.is_empty());
        assert!(!pacer.pause_before_next_write);
    }

    #[test]
    fn paced_burst_coalesces_crlf_without_crossing_the_byte_cap() {
        assert_eq!(next_paced_input_burst_len(b"command\r\n\nnext\n"), 15);
        assert_eq!(next_paced_input_burst_len(b"one\ntwo\nthree\n"), 8);
        assert_eq!(next_paced_input_burst_len(b"three\n"), 6);

        let mut boundary = vec![b'x'; MULTILINE_PASTE_MAX_BURST_BYTES + 2];
        boundary[MULTILINE_PASTE_MAX_BURST_BYTES - 2] = b'\r';
        boundary[MULTILINE_PASTE_MAX_BURST_BYTES - 1] = b'\n';
        boundary[MULTILINE_PASTE_MAX_BURST_BYTES] = b'\n';

        assert_eq!(
            next_paced_input_burst_len(&boundary),
            MULTILINE_PASTE_MAX_BURST_BYTES,
            "the CRLF pair belongs to one burst, but the following newline remains bounded",
        );
        assert_eq!(
            next_paced_input_burst_len(&boundary[MULTILINE_PASTE_MAX_BURST_BYTES..]),
            1,
        );
    }

    #[tokio::test]
    async fn writer_preserves_fifo_across_burst_input_and_terminal_replies() {
        let (writer, output) = scripted_writer(Vec::new());
        let (mut queue, mut completion_rx) = PtyWriter::new(Box::new(writer)).unwrap();
        let peer_id: Arc<str> = Arc::from("peer");
        let mut expected = Vec::new();
        let mut write_count = 0;

        for seq in 1..=180 {
            let byte = (seq % 251) as u8;
            queue
                .try_enqueue_user(
                    Arc::clone(&peer_id),
                    seq,
                    PeerTransport::Edge,
                    PtyWritePayload::borrowed(&[byte]),
                    None,
                )
                .unwrap();
            expected.push(byte);
            write_count += 1;
            if seq % 30 == 0 {
                queue
                    .try_enqueue_terminal_reply(vec![0x1b, b'[', b'0', b'n'])
                    .unwrap();
                expected.extend_from_slice(&[0x1b, b'[', b'0', b'n']);
                write_count += 1;
            }
        }

        for _ in 0..write_count {
            let completion = completion_rx.recv().await.unwrap();
            assert!(matches!(completion, PtyWriteCompletion::Delivered { .. }));
            queue.finish(&completion);
        }

        assert_eq!(*output.lock().unwrap(), expected);
        assert_eq!(queue.queued_user_bytes(), 0);
    }

    #[tokio::test]
    async fn user_byte_bound_is_released_only_after_delivery_completion() {
        let (writer, _output) = scripted_writer(Vec::new());
        let (mut queue, mut completion_rx) = PtyWriter::new(Box::new(writer)).unwrap();
        let peer_id: Arc<str> = Arc::from("peer");
        let full_budget = vec![b'x'; MAX_QUEUED_USER_PTY_BYTES];

        queue
            .try_enqueue_user(
                Arc::clone(&peer_id),
                1,
                PeerTransport::Edge,
                PtyWritePayload::borrowed(&full_budget),
                None,
            )
            .unwrap();
        assert_eq!(
            queue.try_enqueue_user(
                peer_id,
                2,
                PeerTransport::Edge,
                PtyWritePayload::borrowed(b"y"),
                None,
            ),
            Err(PtyWriteQueueError::Full),
        );

        let completion = completion_rx.recv().await.unwrap();
        queue.finish(&completion);
        assert_eq!(queue.queued_user_bytes(), 0);
    }

    #[test]
    fn reply_backlog_cannot_admit_user_bytes_past_the_shared_bound() {
        let (writer, _output) = scripted_writer(Vec::new());
        let (mut queue, _completion_rx) = PtyWriter::new(Box::new(writer)).unwrap();
        let peer_id: Arc<str> = Arc::from("peer");

        queue
            .try_enqueue_terminal_reply(vec![b'r'; MAX_QUEUED_PTY_BYTES])
            .unwrap();

        assert_eq!(
            queue.try_enqueue_user(
                peer_id,
                1,
                PeerTransport::Edge,
                PtyWritePayload::borrowed(b"x"),
                None,
            ),
            Err(PtyWriteQueueError::Full),
            "the user-only reserve must not bypass the combined allocation bound",
        );
    }

    #[test]
    fn completion_backlog_cannot_outgrow_unreleased_entry_accounting() {
        let (writer, _output) = scripted_writer(Vec::new());
        let (mut queue, _completion_rx) = PtyWriter::new(Box::new(writer)).unwrap();

        for _ in 0..MAX_QUEUED_PTY_WRITES {
            queue.try_enqueue_terminal_reply(Vec::new()).unwrap();
        }

        assert_eq!(
            queue.try_enqueue_terminal_reply(Vec::new()),
            Err(PtyWriteQueueError::Full),
            "worker completions must not release admission before the owner observes them",
        );
    }

    #[tokio::test]
    async fn failing_sink_never_reports_the_write_as_delivered() {
        let (writer, output) = scripted_writer(vec![WriteStep::Bytes(2), WriteStep::Fail]);
        let (mut queue, mut completion_rx) = PtyWriter::new(Box::new(writer)).unwrap();
        let mut peer =
            crate::connection::PeerDisplayState::new("peer".into(), PeerTransport::WebTransport);
        let peer_id: Arc<str> = Arc::from("peer");
        let mut enqueue = |seq: u32, bytes: &[u8], _shadow_modelled: bool| {
            queue
                .try_enqueue_user(
                    Arc::clone(&peer_id),
                    seq,
                    PeerTransport::WebTransport,
                    PtyWritePayload::borrowed(bytes),
                    None,
                )
                .is_ok()
        };

        let applied = peer.apply_keystroke(1, b"abcdef", false, &mut enqueue);
        assert!(applied.advanced);

        let completion = completion_rx.recv().await.unwrap();
        assert!(matches!(
            completion,
            PtyWriteCompletion::Failed {
                ref error,
                ..
            } if error.kind() == io::ErrorKind::BrokenPipe
        ));
        assert_eq!(&*output.lock().unwrap(), b"ab");
        queue.finish(&completion);
        assert_eq!(peer.keystroke_next_queued_seq, 2);
        assert_eq!(peer.keystroke_next_expected_seq, 1);
    }
}
