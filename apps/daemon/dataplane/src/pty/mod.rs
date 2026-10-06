// A latency path: the PTY waits on the event itself, never on a clock. `clippy.toml` lists
// the timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

mod dimensions;
pub mod input_encoder;
pub mod links;
pub mod open_url;
#[cfg(all(test, unix))]
mod redraw_probe;
#[cfg(merkur_sim)]
pub(crate) mod sim;
pub mod terminal;
mod terminal_ui;
mod writer;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{self, Read, Write};
use std::thread;
use std::time::Instant;
use tokio::sync::mpsc::Sender;

use crate::perf_trace;

pub use dimensions::{Viewport, validate_terminal_dimensions};
pub use terminal::{
    CapturedRow, DisplayRowRequest, PendingDisplayDamage, PendingRowDamage, RowCaptureScratch,
    TerminalState,
};
#[cfg(test)]
pub(crate) use writer::MAX_QUEUED_USER_PTY_BYTES;
pub(crate) use writer::PtyWritePayload;
pub use writer::{PtyTraceEvent, PtyTraceStamp, PtyWriteCompletion, PtyWriteSource, PtyWriter};

/// The most one PTY read delivers; every reader buffer is this long.
const PTY_READ_BYTES: usize = 32 * 1024;

/// One PTY read: the reader's buffer and how much of it the read filled. The
/// buffer keeps its full, initialized length, so the reader that gets it back
/// reads into it again without zeroing a byte.
pub struct PtyRead {
    buffer: Vec<u8>,
    len: usize,
}

impl PtyRead {
    /// The whole buffer, for the owner to hand back to the reader.
    pub fn into_buffer(self) -> Vec<u8> {
        self.buffer
    }
}

/// The bytes the read delivered.
impl std::ops::Deref for PtyRead {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.buffer[..self.len]
    }
}

/// A read that is exactly its bytes: the simulated program's output, and tests.
impl From<Vec<u8>> for PtyRead {
    fn from(buffer: Vec<u8>) -> Self {
        let len = buffer.len();
        Self { buffer, len }
    }
}

#[expect(
    clippy::enum_variant_names,
    reason = "the event vocabulary of the PTY owner and emulator; the prefix keeps each \
              event's origin explicit at call sites"
)]
pub enum TerminalEvent {
    PtyBytes(PtyRead, Option<PtyTraceStamp>),
    /// A response the terminal emulator must write BACK to the PTY (the child's
    /// stdin) — replies to cursor-position/DSR, device-attributes/DA, mode
    /// (DECRQM) and similar queries. Programs like neovim block up to
    /// `ttimeoutlen` (~100ms) waiting for these; dropping them makes every
    /// query-driven redraw stall, which reads as line-by-line repaint.
    PtyWrite(Vec<u8>),
    PtyReadClosed,
    PtyReadError(String),
}

/// A bounded LIFO of emptied byte buffers.
///
/// `take` hands out the most recently returned buffer, so a steady workload
/// keeps reusing the few that have grown to its high-water size; `put` parks a
/// buffer only while the pool holds fewer than `depth`, and lets the allocator
/// have it otherwise. That bound is the whole contract: a burst larger than the
/// pool allocates for its excess and returns the excess to the allocator, and
/// nothing ever fails for want of a slot.
pub struct BufferPool {
    buffers: Vec<Vec<u8>>,
    depth: usize,
}

impl BufferPool {
    /// A pool that starts with `depth` empty buffers and never parks more.
    pub fn new(depth: usize) -> Self {
        Self {
            buffers: (0..depth).map(|_| Vec::new()).collect(),
            depth,
        }
    }

    pub fn take(&mut self, min_capacity: usize) -> Vec<u8> {
        let mut buffer = self.buffers.pop().unwrap_or_default();
        buffer.clear();
        // reserve is relative to length, not existing capacity. Subtracting
        // capacity can leave a reused buffer short and force another growth
        // while its caller is filling it.
        buffer.reserve(min_capacity);
        buffer
    }

    pub fn put(&mut self, mut buffer: Vec<u8>) {
        buffer.clear();
        if self.buffers.len() < self.depth {
            self.buffers.push(buffer);
        }
    }

    /// How many buffers are parked right now, for the oracle that proves a
    /// burst returns every frame it took.
    #[cfg(test)]
    pub fn parked(&self) -> usize {
        self.buffers.len()
    }
}

#[cfg(test)]
mod buffer_pool_tests {
    use super::BufferPool;
    use crate::edge_tunnel::test_allocations;

    #[test]
    fn reused_buffer_reserves_the_full_requested_capacity_before_writing() {
        let mut pool = BufferPool::new(1);
        let mut buffer = pool.take(1_024);
        buffer.resize(1_024, 7);
        let requested = buffer.capacity() + 1;
        pool.put(buffer);

        let mut buffer = pool.take(requested);
        assert!(buffer.is_empty());
        assert!(buffer.capacity() >= requested);
        test_allocations::begin_thread();
        buffer.resize(requested, 9);
        let tally = test_allocations::end_thread();
        assert_eq!(tally.allocations, 0);

        let pointer = buffer.as_ptr();
        pool.put(buffer);
        test_allocations::begin_thread();
        let buffer = pool.take(requested);
        let tally = test_allocations::end_thread();
        assert_eq!(tally.allocations, 0);
        assert!(buffer.is_empty());
        assert_eq!(buffer.as_ptr(), pointer);
    }
}

pub struct PtyHandle {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Route a program's request for a browser to the browser viewing this
/// terminal: `$BROWSER` names the daemon's `merkur-open` helper, and the
/// helper directory leads `PATH` so its opener stand-in — `open` on macOS,
/// `xdg-open` on Linux — is found before the system one. Each stand-in forwards
/// only a web URL and hands everything else to the system opener.
fn apply_open_url_environment(command: &mut CommandBuilder, bin_dir: &str) {
    let helper = std::path::Path::new(bin_dir).join("merkur-open");
    command.env("BROWSER", helper.as_os_str());
    let mut path = std::ffi::OsString::from(bin_dir);
    if let Some(inherited) = command.get_env("PATH").filter(|value| !value.is_empty()) {
        path.push(":");
        path.push(inherited);
    }
    command.env("PATH", path);
}

pub struct PtyEnvironment<'a> {
    pub shell_token: Option<&'a str>,
    pub open_url_bin_dir: Option<&'a str>,
    pub image_endpoint: &'a std::path::Path,
    pub image_credential: &'a str,
}

pub fn spawn_pty(
    shell: &str,
    cols: u16,
    rows: u16,
    environment: &PtyEnvironment<'_>,
    event_tx: Sender<TerminalEvent>,
    buffer_return_rx: crossbeam_channel::Receiver<Vec<u8>>,
) -> io::Result<PtyHandle> {
    validate_terminal_dimensions(cols, rows)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| io::Error::other(e.to_string()))?;
    configure_blocking_master(pty_pair.master.as_ref())?;

    let mut command = CommandBuilder::new(shell);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Merkur");
    command.env("MERKUR_IMAGE_SOCKET", environment.image_endpoint);
    command.env("MERKUR_IMAGE_CREDENTIAL", environment.image_credential);
    // login(1) sets SHELL from the passwd entry; nothing sets it on this path,
    // so a shell the daemon spawns inherits whatever the supervisor happened to
    // hold — launchd's environment on macOS, systemd's on a box. `shell` IS
    // that passwd entry (`readLoginShellEffect`, recorded in the daemon's config
    // at link), so this restores the value the account already defines rather
    // than inventing one, exactly as tmux and sshd do for the shells they start.
    //
    // Without it `merkur shell-integration` mis-detects INSIDE a Merkur
    // terminal, which is the one place it has to be right: it sources a bash
    // snippet into fish, the shell errors instead of defining the prompt hook,
    // no authenticated OSC 133;B is ever emitted, and speculative echo is
    // silently withheld for the whole session.
    command.env("SHELL", shell);
    // The shell-integration snippet prefers this over re-reading the token
    // file. It is safe for a multiplexer to snapshot into a long-lived server
    // environment precisely because the token is persistent: a value inherited
    // by a pane started days later is still the right one. The snippet keeps a
    // file fallback for the case this cannot cover — a tmux server that was
    // already running before Merkur started it.
    if let Some(token) = environment.shell_token {
        command.env("MERKUR_SHELL_TOKEN", token);
    }
    if let Some(bin_dir) = environment.open_url_bin_dir {
        apply_open_url_environment(&mut command, bin_dir);
    }

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|e| io::Error::other(e.to_string()))?;
    drop(pty_pair.slave);

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| io::Error::other(e.to_string()))?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| io::Error::other(e.to_string()))?;

    start_pty_reader(reader, event_tx, buffer_return_rx)?;

    Ok(PtyHandle {
        writer,
        master: pty_pair.master,
        child,
    })
}

/// The writer thread relies on the kernel's blocking PTY write wait rather than
/// user-space timer polling. `dup`-created reader/writer handles share these
/// file-status flags with the master, so establish the contract before cloning
/// either side.
#[cfg(unix)]
fn configure_blocking_master(master: &dyn MasterPty) -> io::Result<()> {
    let fd = master
        .as_raw_fd()
        .ok_or_else(|| io::Error::other("native PTY master did not expose a file descriptor"))?;
    configure_blocking_fd(fd)
}

#[cfg(unix)]
fn configure_blocking_fd(fd: std::os::fd::RawFd) -> io::Result<()> {
    // SAFETY: `F_GETFL` takes no pointer and changes nothing; a descriptor
    // that is not open answers `-1`/`EBADF`, which is returned below.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        // SAFETY: `F_SETFL` takes an integer flag word, here the one the
        // kernel just returned with `O_NONBLOCK` cleared, and no pointer.
        let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Determine whether the PTY is in a state where browser-side prediction is
/// safe.
///
/// A complete shell-editor boundary hint is mandatory even when kernel ECHO is
/// set: ECHO alone cannot prove that cursor/delete operations have line-editor
/// semantics. The spawned shell must also own the foreground process group,
/// and canonical no-ECHO reads always fail closed.
///
/// The boundary latch is revoked before every submitted line, so a command
/// repaint sampled before a same-process silent read cannot reopen prediction.
/// This remains a point-in-time kernel sample; callers must publish it only
/// alongside the output event that supplied fresh editor evidence.
///
/// OSC/CSI bytes do not prove their semantic origin: shell-owned output can
/// imitate them. Browser prediction therefore remains tentative behind its
/// semantic-input barrier; this bit is not sufficient to confirm visible cells.
#[cfg(unix)]
pub fn pty_prediction_safe(
    master: &dyn MasterPty,
    shell_pid: u32,
    shell_integration_input_active: bool,
    shell_integration_authenticated: bool,
) -> bool {
    let Some(fd) = master.as_raw_fd() else {
        return false;
    };
    pty_prediction_safe_fd(
        fd,
        shell_pid,
        shell_integration_input_active,
        shell_integration_authenticated,
    )
}

#[cfg(unix)]
fn pty_prediction_safe_fd(
    fd: std::os::fd::RawFd,
    shell_pid: u32,
    shell_integration_input_active: bool,
    shell_integration_authenticated: bool,
) -> bool {
    if !shell_integration_input_active {
        return false;
    }
    let mut attributes = std::mem::MaybeUninit::<libc::termios>::uninit();
    // SAFETY: `attributes` is a live `termios` slot on this frame, aligned and
    // sized for the one structure `tcgetattr` writes through the pointer.
    let result = unsafe { libc::tcgetattr(fd, attributes.as_mut_ptr()) };
    if result != 0 {
        return false;
    }
    // SAFETY: `tcgetattr` returned 0, so it filled the whole structure.
    let attributes = unsafe { attributes.assume_init() };
    if attributes.c_lflag & libc::ECHO == 0 && attributes.c_lflag & libc::ICANON != 0 {
        return false;
    }
    let mut foreground_process_group = 0;
    // SAFETY: `TIOCGPGRP` writes one `pid_t` through its argument, and
    // `foreground_process_group` is a live, aligned `pid_t` on this frame.
    let foreground_result = unsafe {
        libc::ioctl(
            fd,
            libc::TIOCGPGRP as _,
            &mut foreground_process_group as *mut libc::pid_t,
        )
    };
    prediction_safe_from_terminal_state(
        attributes.c_lflag,
        (foreground_result == 0 && foreground_process_group > 0)
            .then_some(foreground_process_group),
        shell_pid,
        shell_integration_input_active,
        shell_integration_authenticated,
    )
}

/// Whether speculative echo may be granted, from the PTY's own state.
///
/// # Why an authenticated boundary skips the foreground-process-group check
///
/// The `foreground_process_group == shell_pid` test asks "is the shell itself
/// reading, rather than something it launched". It is a real second layer, and
/// it is why a full-screen program cannot inherit a prompt's grant.
///
/// Under a multiplexer it cannot be satisfied and cannot be made to be. The
/// daemon's PTY is the OUTER one: its foreground process group is tmux, its
/// termios is the raw mode tmux set, and the shell the user is actually typing
/// into is reading from a PTY inside tmux that this process cannot see. Every
/// signal this function reads describes the multiplexer.
///
/// So for an authenticated boundary the guarantee narrows to one layer: the
/// token proves the `OSC 133;B` came from a shell Merkur started, and a shell
/// emits it from its prompt. A `read -s` inside a script never prints a
/// prompt, so the boundary is already closed there — which is the property the
/// `read -s -k 1` regression test pins, and it survives this change. What is
/// lost is defence in depth, not the primary guarantee. See `docs/security.md`.
///
/// An unauthenticated boundary keeps both layers exactly as before.
#[cfg(unix)]
fn prediction_safe_from_terminal_state(
    local_flags: libc::tcflag_t,
    foreground_process_group: Option<libc::pid_t>,
    shell_pid: u32,
    shell_integration_input_active: bool,
    shell_integration_authenticated: bool,
) -> bool {
    if !shell_integration_input_active {
        return false;
    }
    if local_flags & libc::ECHO == 0 && local_flags & libc::ICANON != 0 {
        return false;
    }
    if shell_integration_authenticated {
        return true;
    }
    let Ok(shell_pid) = libc::pid_t::try_from(shell_pid) else {
        return false;
    };
    foreground_process_group == Some(shell_pid)
}

#[cfg(not(unix))]
pub fn pty_prediction_safe(
    _master: &dyn MasterPty,
    _shell_pid: u32,
    _shell_integration_input_active: bool,
    _shell_integration_authenticated: bool,
) -> bool {
    false
}

#[cfg(not(unix))]
fn configure_blocking_master(_master: &dyn MasterPty) -> io::Result<()> {
    // The Windows portable-pty writer is a synchronous pipe handle.
    Ok(())
}

/// The reader thread hands bytes straight to the owner loop's Tokio channel.
///
/// It used to publish onto a crossbeam queue that a second, dedicated thread
/// re-published onto this same Tokio channel. That bridge added a thread and a
/// depth-8 queue to every PTY read for no ordering or backpressure property the
/// Tokio channel does not already have: `blocking_send` on a bounded channel is
/// exactly the wait the crossbeam `send` was already doing, one hop earlier.
///
/// Buffer recycling is load-bearing: the reader is the only consumer of
/// `buffer_return_rx`, and the owner returns each buffer at its full length, so
/// a steady output stream rotates the same allocations and neither allocates
/// nor zeroes per read.
fn start_pty_reader(
    mut reader: Box<dyn Read + Send>,
    event_tx: Sender<TerminalEvent>,
    buffer_return_rx: crossbeam_channel::Receiver<Vec<u8>>,
) -> io::Result<()> {
    thread::Builder::new()
        .name("merkur-pty-reader".to_string())
        .spawn(move || {
            let mut buf = vec![0u8; PTY_READ_BYTES];
            let mut read_ordinal = 0u64;
            loop {
                // The last read's buffer went to the owner. Take back one it has
                // finished with; only a pipeline deeper than before allocates.
                if buf.len() != PTY_READ_BYTES {
                    buf = match buffer_return_rx.try_recv() {
                        Ok(returned) if returned.len() == PTY_READ_BYTES => returned,
                        _ => vec![0u8; PTY_READ_BYTES],
                    };
                }
                read_ordinal = read_ordinal.wrapping_add(1);
                let token_before = perf_trace::active_token();
                let read_started_at = token_before.map(|_| Instant::now());
                let result = reader.read(&mut buf);
                let read_at = token_before.map(|_| Instant::now());
                let token_after = perf_trace::active_token();
                match result {
                    Ok(0) => {
                        let _ = event_tx.blocking_send(TerminalEvent::PtyReadClosed);
                        break;
                    }
                    Ok(size) => {
                        let trace = observe_pty_read(
                            read_ordinal,
                            size,
                            token_before,
                            token_after,
                            read_started_at,
                            read_at,
                            PtyTraceStamp::record,
                        );
                        let read = PtyRead {
                            buffer: std::mem::take(&mut buf),
                            len: size,
                        };
                        if event_tx
                            .blocking_send(TerminalEvent::PtyBytes(read, trace))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ =
                            event_tx.blocking_send(TerminalEvent::PtyReadError(error.to_string()));
                        break;
                    }
                }
            }
        })?;
    Ok(())
}

/// Emit physical read boundaries before queueing the bytes to the owner. The
/// injected sink keeps the epoch/race oracle independent of the process-global
/// diagnostic recorder; production monomorphizes this to direct scalar writes.
fn observe_pty_read(
    read_ordinal: u64,
    byte_len: usize,
    token_before: Option<perf_trace::TraceToken>,
    token_after: Option<perf_trace::TraceToken>,
    started_at: Option<Instant>,
    completed_at: Option<Instant>,
    mut record: impl FnMut(PtyTraceStamp, Instant, PtyTraceEvent),
) -> Option<PtyTraceStamp> {
    if token_before != token_after {
        // A syscall spanning a reset has no single observation owner. The
        // discard itself is evidence, not a fabricated response in the new
        // epoch. This also marks the first read after enabling while blocked.
        if let Some(token) = token_after.or(token_before) {
            record(
                PtyTraceStamp {
                    token,
                    ordinal: read_ordinal,
                },
                completed_at.unwrap_or_else(Instant::now),
                PtyTraceEvent::ReadBoundaryDiscard {
                    read_ordinal,
                    had_prior_owner: token_before.is_some(),
                    byte_len,
                },
            );
        }
        return None;
    }
    let token = token_before?;
    let (Some(start), Some(at)) = (started_at, completed_at) else {
        return None;
    };
    let trace = PtyTraceStamp {
        token,
        ordinal: read_ordinal,
    };
    record(trace, start, PtyTraceEvent::ReadStarted { read_ordinal });
    record(
        trace,
        at,
        PtyTraceEvent::ReadCompleted {
            read_ordinal,
            byte_len,
        },
    );
    Some(trace)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crossbeam_channel::unbounded;

    use super::*;

    #[test]
    fn physical_read_boundaries_survive_late_owner_handling() {
        let token = perf_trace::TraceToken { owner: 17 };
        let origin = Instant::now();
        let read_started = origin + Duration::from_millis(3);
        let read_finished = origin + Duration::from_millis(8);
        let owner_handled = origin + Duration::from_millis(48);
        let mut events = Vec::new();
        let trace = observe_pty_read(
            9,
            123,
            Some(token),
            Some(token),
            Some(read_started),
            Some(read_finished),
            |stamp, at, event| events.push((stamp, at, event.trace_fields())),
        )
        .unwrap();
        // The owner may handle this read before observing a writer completion.
        // Neither boundary is derived from that completion or latest_input_seq.
        events.push((
            trace,
            owner_handled,
            PtyTraceEvent::ReadOwnerHandled {
                read_ordinal: trace.ordinal,
            }
            .trace_fields(),
        ));
        assert_eq!(events.len(), 3);
        assert!(
            events
                .iter()
                .all(|(stamp, _, _)| stamp.token == token && stamp.ordinal == 9)
        );
        assert_eq!(events[1].1, read_finished);
        assert_eq!(
            events[2].1.duration_since(events[1].1),
            Duration::from_millis(40)
        );
        assert_eq!(events[1].2.0, "pty_read");
        assert_eq!(&events[1].2.1[..3], &[1, 9, 123]);
        assert_eq!(events[2].2.0, "pty_read_handled");
    }

    #[test]
    fn read_crossing_a_generation_never_inherits_new_owner_identity() {
        let old = perf_trace::TraceToken { owner: 17 };
        let new = perf_trace::TraceToken { owner: 18 };
        let now = Instant::now();
        for before in [None, Some(old)] {
            let mut events = Vec::new();
            assert!(
                observe_pty_read(
                    9,
                    123,
                    before,
                    Some(new),
                    Some(now),
                    Some(now),
                    |stamp, at, event| events.push((stamp, at, event.trace_fields())),
                )
                .is_none()
            );
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].0.token, new);
            assert_eq!(events[0].2.0, "pty_boundary_discard");
            assert_eq!(
                &events[0].2.1[..4],
                &[0, 9, u64::from(before.is_some()), 123]
            );
        }
    }

    #[test]
    fn disabled_read_observation_has_no_clock_or_sink_work() {
        let mut called = false;
        assert!(
            observe_pty_read(9, 123, None, None, None, None, |_, _, _| called = true,).is_none()
        );
        assert!(!called);
    }

    /// Blocking view of the reader's Tokio channel for synchronous tests.
    ///
    /// The reader publishes straight onto the owner loop's channel now, with no
    /// crossbeam hop in between. Every test in this module is a plain `#[test]`
    /// with no ambient runtime, so a private current-thread runtime turns
    /// `recv` back into a real blocking wait — deliberately not a poll loop,
    /// which would burn a core and make these already timing-sensitive
    /// shell-spawning tests flakier under a loaded workspace run. Crossbeam's
    /// error type is reused so every assertion stays exactly as it was.
    struct PtyEventReceiver {
        runtime: tokio::runtime::Runtime,
        inner: std::cell::RefCell<tokio::sync::mpsc::Receiver<TerminalEvent>>,
    }

    impl PtyEventReceiver {
        fn recv_timeout(
            &self,
            timeout: Duration,
        ) -> Result<TerminalEvent, crossbeam_channel::RecvTimeoutError> {
            let mut rx = self.inner.borrow_mut();
            self.runtime.block_on(async {
                match tokio::time::timeout(timeout, rx.recv()).await {
                    Ok(Some(event)) => Ok(event),
                    Ok(None) => Err(crossbeam_channel::RecvTimeoutError::Disconnected),
                    Err(_) => Err(crossbeam_channel::RecvTimeoutError::Timeout),
                }
            })
        }
    }

    fn pty_event_channel(depth: usize) -> (Sender<TerminalEvent>, PtyEventReceiver) {
        let (tx, rx) = tokio::sync::mpsc::channel(depth);
        (
            tx,
            PtyEventReceiver {
                runtime: tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                    .expect("current-thread runtime for the PTY reader tests"),
                inner: std::cell::RefCell::new(rx),
            },
        )
    }

    /// Hang-guard for the helpers that wait on a REAL shell to emit a marker,
    /// and deliberately not a latency assertion: nothing here claims a shell
    /// must print its prompt within any particular time. It only has to be long
    /// enough that a starved machine does not trip it, because a spurious
    /// failure here reads as a prediction-gate regression. At 10 s
    /// `fish_editor_boundaries_grant_editor_and_revoke_silent_read` failed
    /// about one full-suite run in three — passing every time in isolation —
    /// while the suite ran ~600 tests, several of them spawning their own PTY
    /// and shell, across every core.
    #[cfg(unix)]
    const SHELL_MARKER_TIMEOUT: Duration = Duration::from_secs(60);

    #[cfg(unix)]
    fn receive_until_pty_marker(event_rx: &PtyEventReceiver, marker: &[u8], occurrences: usize) {
        let deadline = std::time::Instant::now() + SHELL_MARKER_TIMEOUT;
        let mut received = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for PTY marker");
            match event_rx.recv_timeout(remaining) {
                Err(error) => panic!(
                    "timed out waiting for PTY marker {marker:?} ({error}); output={received:?}"
                ),
                Ok(TerminalEvent::PtyBytes(bytes, _)) => {
                    received.extend_from_slice(&bytes);
                    if received
                        .windows(marker.len())
                        .filter(|window| *window == marker)
                        .count()
                        >= occurrences
                    {
                        return;
                    }
                }
                Ok(TerminalEvent::PtyReadClosed) => panic!("PTY closed before marker"),
                Ok(TerminalEvent::PtyReadError(error)) => panic!("PTY read failed: {error}"),
                Ok(TerminalEvent::PtyWrite(_)) => {
                    unreachable!("reader emits only output events")
                }
            }
        }
    }

    #[cfg(unix)]
    fn apply_test_pty_output(
        terminal: &mut TerminalState,
        terminal_event_rx: &crossbeam_channel::Receiver<TerminalEvent>,
        writer: &mut dyn Write,
        bytes: &[u8],
    ) {
        terminal.apply_bytes(bytes);
        while let Ok(event) = terminal_event_rx.try_recv() {
            match event {
                TerminalEvent::PtyWrite(reply) => writer.write_all(&reply).unwrap(),
                TerminalEvent::PtyBytes(_, _)
                | TerminalEvent::PtyReadClosed
                | TerminalEvent::PtyReadError(_) => {
                    panic!("terminal emulator emitted a PTY reader event")
                }
            }
        }
        writer.flush().unwrap();
    }

    #[cfg(unix)]
    fn receive_until_terminal_marker(
        event_rx: &PtyEventReceiver,
        terminal: &mut TerminalState,
        terminal_event_rx: &crossbeam_channel::Receiver<TerminalEvent>,
        writer: &mut dyn Write,
        marker: &[u8],
        occurrences: usize,
        expected_input_active: bool,
    ) {
        let deadline = std::time::Instant::now() + SHELL_MARKER_TIMEOUT;
        let mut received = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for PTY marker");
            match event_rx.recv_timeout(remaining) {
                Err(error) => panic!(
                    "timed out waiting for terminal marker {marker:?} ({error}); output={received:?}"
                ),
                Ok(TerminalEvent::PtyBytes(bytes, _)) => {
                    apply_test_pty_output(terminal, terminal_event_rx, writer, &bytes);
                    received.extend_from_slice(&bytes);
                    if received
                        .windows(marker.len())
                        .filter(|window| *window == marker)
                        .count()
                        >= occurrences
                        && terminal.shell_integration_input_active() == expected_input_active
                    {
                        return;
                    }
                }
                Ok(TerminalEvent::PtyReadClosed) => panic!("PTY closed before marker"),
                Ok(TerminalEvent::PtyReadError(error)) => panic!("PTY read failed: {error}"),
                Ok(TerminalEvent::PtyWrite(_)) => {
                    unreachable!("reader emits only output events")
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn pty_writer_fd_is_restored_to_kernel_blocking_mode() {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;

        let (writer, _reader) = UnixStream::pair().unwrap();
        writer.set_nonblocking(true).unwrap();
        let fd = writer.as_raw_fd();
        // SAFETY: `fd` is `writer`'s open socket, which outlives this call;
        // `F_GETFL` takes no pointer.
        let before = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert_ne!(before & libc::O_NONBLOCK, 0);

        configure_blocking_fd(fd).unwrap();

        // SAFETY: `writer` still owns `fd`; `F_GETFL` takes no pointer.
        let after = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert_eq!(after & libc::O_NONBLOCK, 0);
    }

    #[cfg(unix)]
    #[test]
    fn prediction_safety_requires_editor_boundary_and_shell_process_group() {
        const SHELL_PID: u32 = 42;
        const SHELL_PROCESS_GROUP: libc::pid_t = 42;
        const EXTERNAL_PROCESS_GROUP: libc::pid_t = 43;

        assert!(
            !prediction_safe_from_terminal_state(
                libc::ECHO | libc::ICANON,
                Some(SHELL_PROCESS_GROUP),
                SHELL_PID,
                false,
                false,
            ),
            "kernel ECHO alone cannot prove line-editor cursor/delete semantics"
        );
        assert!(prediction_safe_from_terminal_state(
            libc::ECHO | libc::ICANON,
            Some(SHELL_PROCESS_GROUP),
            SHELL_PID,
            true,
            false,
        ));
        assert!(prediction_safe_from_terminal_state(
            0,
            Some(SHELL_PROCESS_GROUP),
            SHELL_PID,
            true,
            false,
        ));
        assert!(
            !prediction_safe_from_terminal_state(
                libc::ICANON,
                Some(SHELL_PROCESS_GROUP),
                SHELL_PID,
                true,
                false,
            ),
            "canonical no-ECHO password reads must fail closed"
        );
        assert!(
            !prediction_safe_from_terminal_state(
                libc::ECHO | libc::ICANON,
                Some(EXTERNAL_PROCESS_GROUP),
                SHELL_PID,
                true,
                false,
            ),
            "external foreground REPLs must not inherit shell editor evidence"
        );
        assert!(!prediction_safe_from_terminal_state(
            0, None, SHELL_PID, true, false,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn an_authenticated_boundary_survives_a_foreground_group_it_cannot_own() {
        const SHELL_PID: u32 = 42;
        const MULTIPLEXER_PROCESS_GROUP: libc::pid_t = 43;

        // This is the tmux case, and the entire reason the authenticated form
        // exists. The daemon's PTY is the OUTER one: its foreground process
        // group belongs to the multiplexer, and the shell the user types into
        // is behind a PTY this process cannot see. Requiring the group to match
        // would make prediction permanently unreachable under tmux.
        assert!(prediction_safe_from_terminal_state(
            libc::ECHO | libc::ICANON,
            Some(MULTIPLEXER_PROCESS_GROUP),
            SHELL_PID,
            true,
            true,
        ));
        assert!(
            !prediction_safe_from_terminal_state(
                libc::ECHO | libc::ICANON,
                Some(MULTIPLEXER_PROCESS_GROUP),
                SHELL_PID,
                true,
                false,
            ),
            "without a token the foreground-group check must still be mandatory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn authentication_never_overrides_a_closed_boundary_or_a_canonical_silent_read() {
        const SHELL_PID: u32 = 42;
        const SHELL_PROCESS_GROUP: libc::pid_t = 42;

        // The token relaxes exactly one check. It must not become a skeleton
        // key for the two that actually catch a password prompt.
        assert!(
            !prediction_safe_from_terminal_state(
                libc::ECHO | libc::ICANON,
                Some(SHELL_PROCESS_GROUP),
                SHELL_PID,
                false,
                true,
            ),
            "no open boundary means no grant, however well authenticated"
        );
        assert!(
            !prediction_safe_from_terminal_state(
                libc::ICANON,
                Some(SHELL_PROCESS_GROUP),
                SHELL_PID,
                true,
                true,
            ),
            "canonical no-ECHO reads must fail closed for authenticated shells too"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pty_prediction_safety_tracks_kernel_echo_after_editor_boundary() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let fd = pair.master.as_raw_fd().unwrap();
        let mut attributes = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: `fd` is the master `pair` keeps open for the whole test, and
        // `attributes` is a live `termios` slot `tcgetattr` writes once.
        let read = unsafe { libc::tcgetattr(fd, attributes.as_mut_ptr()) };
        assert_eq!(read, 0);
        // SAFETY: `tcgetattr` returned 0, so it filled the whole structure.
        let mut attributes = unsafe { attributes.assume_init() };

        attributes.c_lflag &= !libc::ECHO;
        // SAFETY: `attributes` is the initialized `termios` read above, borrowed
        // for the call; `tcsetattr` only reads it.
        let written = unsafe { libc::tcsetattr(fd, libc::TCSANOW, &attributes) };
        assert_eq!(written, 0);
        assert!(!pty_prediction_safe(
            pair.master.as_ref(),
            std::process::id(),
            true,
            false,
        ));

        attributes.c_lflag |= libc::ECHO;
        // SAFETY: the same initialized `termios`, read-only to `tcsetattr`, on
        // the master `pair` still holds open.
        let written = unsafe { libc::tcsetattr(fd, libc::TCSANOW, &attributes) };
        assert_eq!(written, 0);
        // This synthetic PTY has no foreground process group owned by the
        // current process, so even ECHO + boundary evidence remains closed.
        assert!(!pty_prediction_safe(
            pair.master.as_ref(),
            std::process::id(),
            true,
            false,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn spawned_shell_echo_transitions_are_visible_from_retained_master() {
        const ECHO_OFF_MARKER: &[u8] = b"__MERKUR_ECHO_OFF__";
        const ECHO_ON_MARKER: &[u8] = b"__MERKUR_ECHO_ON__";

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        configure_blocking_master(pair.master.as_ref()).unwrap();

        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "stty -echo; printf '__MERKUR_ECHO_OFF__\\n'; \
             IFS= read -r _; stty echo; printf '__MERKUR_ECHO_ON__\\n'; \
             IFS= read -r _",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let shell_pid = child.process_id().unwrap();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (event_tx, event_rx) = pty_event_channel(8);
        let (_buffer_return_tx, buffer_return_rx) = unbounded();
        start_pty_reader(reader, event_tx, buffer_return_rx).unwrap();

        receive_until_pty_marker(&event_rx, ECHO_OFF_MARKER, 1);
        assert!(
            !pty_prediction_safe(pair.master.as_ref(), shell_pid, true, false),
            "master must observe the spawned child's disabled slave ECHO"
        );

        writer.write_all(b"continue\n").unwrap();
        writer.flush().unwrap();
        receive_until_pty_marker(&event_rx, ECHO_ON_MARKER, 1);
        assert!(
            pty_prediction_safe(pair.master.as_ref(), shell_pid, true, false),
            "master must observe the spawned child's enabled slave ECHO"
        );

        writer.write_all(b"exit\n").unwrap();
        writer.flush().unwrap();
        child.wait().unwrap();
    }

    #[cfg(target_os = "macos")]
    /// A multiplexer's terminal modes must not withhold the prediction grant.
    ///
    /// tmux with `mouse on` holds the alternate screen for its whole lifetime
    /// and enables mouse tracking, while the shell inside it has an ordinary
    /// line editor. Both bits were once browser-side proxies for "there is no
    /// line editor at the cursor" and both vetoed speculative echo, so local
    /// echo was unreachable for those users — the mouse proxy alone accounted
    /// for 74% of production refusals.
    ///
    /// This is the end-to-end leg for that removal: a real zsh on a real PTY,
    /// real termios, the real parser, and the real frame header. It asserts the
    /// exact wire byte the browser gates on — `mode_flags` carrying
    /// `DISPLAY_MODE_PREDICTION_SAFE` *together with* the multiplexer bits,
    /// which is precisely the combination that used to be refused.
    ///
    /// It owns its own PTY deliberately. The browser latency harness shares a
    /// worker-scoped daemon, so priming these modes there both fails to obtain a
    /// grant and leaves the alternate screen active for every later spec.
    #[test]
    fn a_multiplexers_modes_do_not_withhold_the_prediction_grant() {
        const PROMPT_MARKER: &[u8] = b"__MERKUR_MUX_PROMPT__";

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        configure_blocking_master(pair.master.as_ref()).unwrap();

        let mut command = CommandBuilder::new("/bin/zsh");
        command.arg("-f");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let shell_pid = child.process_id().unwrap();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (event_tx, event_rx) = pty_event_channel(8);
        let (_buffer_return_tx, buffer_return_rx) = unbounded();
        start_pty_reader(reader, event_tx, buffer_return_rx).unwrap();
        let (terminal_event_tx, terminal_event_rx) = unbounded();
        let mut terminal = TerminalState::new(80, 24, terminal_event_tx);

        // Enter the modes a multiplexer sets, then reach a fresh ZLE prompt.
        // Order matters and mirrors reality: tmux switches screens first, and
        // the shell inside it then draws the prompt that opens the boundary.
        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        writer
            .write_all(
                b"printf '\\033[?1000h\\033[?1002h\\033[?1049h'; PS1='__MERKUR_'\"MUX_PROMPT__ \"\n",
            )
            .unwrap();
        writer.flush().unwrap();
        receive_until_terminal_marker(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            PROMPT_MARKER,
            1,
            true,
        );

        // Assert against the encoded header rather than internal state: that is
        // the only thing the browser ever sees, and it is what the removed
        // proxies were reading.
        const MODE_MOUSE_ANY: u16 = terminal::DISPLAY_MODE_POINTER_CLICKS;
        const MODE_ALT_SCREEN: u16 = terminal::DISPLAY_MODE_ALT_SCREEN;
        let mut baseline = Vec::new();
        terminal.current_grid_into(&mut baseline);
        let (before_payload, _) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let before = merkur_codec::parse_frame_header(&before_payload).unwrap();
        assert_ne!(
            before.mode_flags & MODE_ALT_SCREEN,
            0,
            "the fixture must reach the alternate screen for this to test anything"
        );
        assert_ne!(
            before.mode_flags & MODE_MOUSE_ANY,
            0,
            "the fixture must have mouse tracking enabled"
        );

        // The three gates in docs/security.md, evaluated against the real PTY.
        assert!(
            terminal.shell_integration_input_active(),
            "a ZLE prompt inside the alternate screen still opens the boundary"
        );
        assert!(
            pty_prediction_safe(
                pair.master.as_ref(),
                shell_pid,
                terminal.shell_integration_input_active(),
                terminal.shell_integration_authenticated(),
            ),
            "no terminal mode is one of the three gates; a multiplexer pane with a \
             live prompt boundary must still be granted"
        );

        // And the byte the browser actually gates on carries all of them at once.
        assert!(terminal.set_prediction_safe(true));
        let (payload, _) = terminal.encode_delta_for_rows(&baseline, &[], Vec::new());
        let header = merkur_codec::parse_frame_header(&payload).unwrap();
        assert_ne!(
            header.mode_flags & crate::pty::terminal::DISPLAY_MODE_PREDICTION_SAFE,
            0,
            "the grant must ride the same header as the multiplexer bits"
        );
        assert_ne!(
            header.mode_flags & MODE_ALT_SCREEN,
            0,
            "and that header must genuinely still be an alternate-screen one"
        );
        assert_ne!(
            header.mode_flags & MODE_MOUSE_ANY,
            0,
            "with mouse tracking still active"
        );

        let _ = child.kill();
    }

    // macOS only, for the same reason as
    // `a_multiplexers_modes_do_not_withhold_the_prediction_grant` above: it
    // drives a real `/bin/zsh`, which is the system shell there and is present
    // at that exact path. On Linux the spawn fails with ENOENT and the test can
    // never pass, so an ungated `#[test]` makes `cargo test -p merkur-dataplane`
    // permanently red rather than informative. The Linux-side coverage of these
    // gates runs against `/bin/sh` and `/usr/bin/fish`.
    #[cfg(target_os = "macos")]
    #[test]
    fn interactive_shell_prediction_safety_blocks_password_and_external_raw_modes() {
        const PROMPT_MARKER: &[u8] = b"__MERKUR_ZSH_PROMPT__";
        const PASSWORD_MARKER: &[u8] = b"__MERKUR_PASSWORD_WAIT__";
        const EXTERNAL_RAW_MARKER: &[u8] = b"__MERKUR_EXTERNAL_RAW__";

        fn read_local_flags(fd: std::os::fd::RawFd) -> libc::tcflag_t {
            let mut attributes = std::mem::MaybeUninit::<libc::termios>::uninit();
            // SAFETY: `attributes` is a live `termios` slot `tcgetattr` writes
            // once; the caller's `fd` is the master its PTY pair keeps open.
            let read = unsafe { libc::tcgetattr(fd, attributes.as_mut_ptr()) };
            assert_eq!(read, 0);
            // SAFETY: `tcgetattr` returned 0, so it filled the whole structure.
            unsafe { attributes.assume_init() }.c_lflag
        }

        fn wait_for_local_flags(
            fd: std::os::fd::RawFd,
            predicate: impl Fn(libc::tcflag_t) -> bool,
        ) -> libc::tcflag_t {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                let flags = read_local_flags(fd);
                if predicate(flags) {
                    return flags;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "PTY line discipline did not reach the expected state"
                );
                std::thread::yield_now();
            }
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        configure_blocking_master(pair.master.as_ref()).unwrap();

        let mut command = CommandBuilder::new("/bin/zsh");
        command.arg("-f");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let shell_pid = child.process_id().unwrap();
        let shell_process_group = libc::pid_t::try_from(shell_pid).unwrap();
        drop(pair.slave);

        let fd = pair.master.as_raw_fd().unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (event_tx, event_rx) = pty_event_channel(8);
        let (_buffer_return_tx, buffer_return_rx) = unbounded();
        start_pty_reader(reader, event_tx, buffer_return_rx).unwrap();
        let (terminal_event_tx, terminal_event_rx) = unbounded();
        let mut terminal = TerminalState::new(80, 24, terminal_event_tx);

        let prompt_setup = b"PS1='__MERKUR_'\"ZSH_PROMPT__ \"\n";
        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        writer.write_all(prompt_setup).unwrap();
        writer.flush().unwrap();
        // Split the source literal so neither kernel echo nor ZLE's command
        // repaint contains the marker. Its first occurrence is the real prompt.
        receive_until_terminal_marker(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            PROMPT_MARKER,
            1,
            true,
        );
        let prompt_flags =
            wait_for_local_flags(fd, |flags| flags & (libc::ECHO | libc::ICANON) == 0);
        assert_eq!(prompt_flags & libc::ECHO, 0);
        assert_eq!(prompt_flags & libc::ICANON, 0);
        // SAFETY: `tcgetpgrp` takes only the descriptor, the master `pair`
        // holds open, and returns the foreground group by value.
        let foreground = unsafe { libc::tcgetpgrp(fd) };
        assert_eq!(foreground, shell_process_group);
        assert!(
            terminal.shell_integration_input_active(),
            "ZLE prompt must emit fresh bracketed-paste editor evidence"
        );
        assert!(pty_prediction_safe(
            pair.master.as_ref(),
            shell_pid,
            terminal.shell_integration_input_active(),
            terminal.shell_integration_authenticated(),
        ));
        terminal.set_prediction_safe(true);

        let password_command = b"printf '__MERKUR_PASSWORD_WAIT__\\n'; read -s -k 1 secret\n";
        assert!(
            terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r")),
            "line submission must revoke the advertised prediction bit"
        );
        assert!(!terminal.shell_integration_input_active());
        writer.write_all(password_command).unwrap();
        writer.flush().unwrap();
        // Again distinguish the command repaint from printf's marker. By the
        // second occurrence the same shell process is blocked in a raw,
        // single-byte silent read. The pre-transition ZLE repaint must not
        // reopen the line-submission latch.
        receive_until_terminal_marker(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            PASSWORD_MARKER,
            2,
            false,
        );
        let password_flags =
            wait_for_local_flags(fd, |flags| flags & (libc::ECHO | libc::ICANON) == 0);
        assert_eq!(password_flags & libc::ECHO, 0);
        assert_eq!(password_flags & libc::ICANON, 0);
        // SAFETY: as above: only the open master descriptor crosses the call.
        let foreground = unsafe { libc::tcgetpgrp(fd) };
        assert_eq!(foreground, shell_process_group);
        assert!(
            !terminal.shell_integration_input_active(),
            "accepted-command repaint cannot substitute for a fresh prompt boundary"
        );
        assert!(
            !pty_prediction_safe(
                pair.master.as_ref(),
                shell_pid,
                terminal.shell_integration_input_active(),
                terminal.shell_integration_authenticated(),
            ),
            "same-shell raw no-ECHO password reads must fail closed"
        );

        writer.write_all(b"x").unwrap();
        writer.flush().unwrap();
        receive_until_terminal_marker(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            PROMPT_MARKER,
            1,
            true,
        );
        wait_for_local_flags(fd, |flags| flags & (libc::ECHO | libc::ICANON) == 0);
        assert!(pty_prediction_safe(
            pair.master.as_ref(),
            shell_pid,
            terminal.shell_integration_input_active(),
            terminal.shell_integration_authenticated(),
        ));

        let external_command = b"/bin/sh -c 'stty raw -echo; exec /bin/cat'\n";
        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        writer.write_all(external_command).unwrap();
        writer.flush().unwrap();
        let foreground_deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut foreground_output = Vec::new();
        loop {
            // SAFETY: only the open master descriptor crosses the call; the
            // group comes back by value.
            let foreground_process_group = unsafe { libc::tcgetpgrp(fd) };
            if foreground_process_group > 0 && foreground_process_group != shell_process_group {
                break;
            }
            assert!(
                std::time::Instant::now() < foreground_deadline,
                "external raw process never acquired the foreground PTY; output={:?}",
                String::from_utf8_lossy(&foreground_output)
            );
            match event_rx.recv_timeout(Duration::from_millis(1)) {
                Ok(TerminalEvent::PtyBytes(bytes, _)) => {
                    foreground_output.extend_from_slice(&bytes);
                    apply_test_pty_output(
                        &mut terminal,
                        &terminal_event_rx,
                        writer.as_mut(),
                        &bytes,
                    );
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                _ => panic!("PTY closed before external foreground ownership"),
            }
        }
        wait_for_local_flags(fd, |flags| flags & (libc::ECHO | libc::ICANON) == 0);
        writer.write_all(b"\x1b[?2004h").unwrap();
        writer.write_all(EXTERNAL_RAW_MARKER).unwrap();
        writer.flush().unwrap();
        receive_until_terminal_marker(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            EXTERNAL_RAW_MARKER,
            1,
            true,
        );
        // SAFETY: only the open master descriptor crosses the call; the group
        // comes back by value.
        let external_process_group = unsafe { libc::tcgetpgrp(fd) };
        let external_flags = read_local_flags(fd);
        assert_eq!(external_flags & libc::ECHO, 0);
        assert_eq!(external_flags & libc::ICANON, 0);
        assert_ne!(external_process_group, shell_process_group);
        assert!(
            terminal.shell_integration_input_active(),
            "the test's external process intentionally spoofed editor evidence"
        );
        assert!(
            !pty_prediction_safe(
                pair.master.as_ref(),
                shell_pid,
                terminal.shell_integration_input_active(),
                terminal.shell_integration_authenticated(),
            ),
            "foreground-pgrp authentication must reject external control-sequence spoofing"
        );

        // SAFETY: `killpg` takes two integers. The group is the one the kernel
        // just reported in this PTY's foreground, asserted above to differ from
        // the shell's, so the signal reaches only the `/bin/cat` this test
        // started.
        let killed = unsafe { libc::killpg(external_process_group, libc::SIGTERM) };
        assert_eq!(killed, 0);
        receive_until_terminal_marker(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            PROMPT_MARKER,
            1,
            true,
        );
        assert!(pty_prediction_safe(
            pair.master.as_ref(),
            shell_pid,
            terminal.shell_integration_input_active(),
            terminal.shell_integration_authenticated(),
        ));

        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        writer.write_all(b"exit\n").unwrap();
        writer.flush().unwrap();
        let exit_deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < exit_deadline,
                "zsh did not exit after its terminal replies were drained"
            );
            match event_rx.recv_timeout(Duration::from_millis(10)) {
                Ok(TerminalEvent::PtyBytes(bytes, _)) => apply_test_pty_output(
                    &mut terminal,
                    &terminal_event_rx,
                    writer.as_mut(),
                    &bytes,
                ),
                Ok(TerminalEvent::PtyReadClosed | TerminalEvent::PtyReadError(_))
                | Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Ok(TerminalEvent::PtyWrite(_)) => {
                    unreachable!("reader emits only output events")
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn fish_editor_boundaries_grant_editor_and_revoke_silent_read() {
        const READ_DONE_MARKER: &[u8] = b"__MERKUR_FISH_READ_DONE__";

        fn installed_fish() -> Option<&'static str> {
            [
                "/opt/homebrew/bin/fish",
                "/usr/local/bin/fish",
                "/usr/bin/fish",
            ]
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file())
        }

        fn observe_until_integration_state(
            event_rx: &PtyEventReceiver,
            terminal: &mut TerminalState,
            terminal_event_rx: &crossbeam_channel::Receiver<TerminalEvent>,
            writer: &mut dyn Write,
            expected: bool,
        ) {
            let deadline = std::time::Instant::now() + SHELL_MARKER_TIMEOUT;
            let mut received = Vec::new();
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "fish did not emit the expected editor boundary; output={received:?}"
                );
                match event_rx.recv_timeout(remaining) {
                    Err(error) => {
                        panic!(
                            "fish did not emit the expected editor boundary ({error}); output={received:?}"
                        )
                    }
                    Ok(TerminalEvent::PtyBytes(bytes, _)) => {
                        received.extend_from_slice(&bytes);
                        apply_test_pty_output(terminal, terminal_event_rx, writer, &bytes);
                        if terminal.shell_integration_input_active() == expected {
                            return;
                        }
                    }
                    Ok(TerminalEvent::PtyReadClosed) => {
                        panic!("fish closed before the editor boundary; output={received:?}")
                    }
                    Ok(TerminalEvent::PtyReadError(error)) => {
                        panic!("fish PTY failed: {error}")
                    }
                    Ok(TerminalEvent::PtyWrite(_)) => {
                        unreachable!("reader emits only output events")
                    }
                }
            }
        }

        let Some(fish) = installed_fish() else {
            return;
        };
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        configure_blocking_master(pair.master.as_ref()).unwrap();

        // fish raises its editor boundaries — bracketed paste on 3.x, OSC 133 on
        // 4.x — from the interactive setup in its *system* config, not from the
        // binary itself. `--no-config`, the fish spelling of the `zsh -f` above,
        // drops that as well, leaving a shell that paints a prompt and never
        // opens an editor boundary, so the grant below can never fire. Isolate
        // the user's config, which is the part that has to stay out of the test,
        // and let the system config load.
        let config_home =
            std::env::temp_dir().join(format!("merkur-fish-config-{}", std::process::id()));
        std::fs::create_dir_all(&config_home).unwrap();
        let mut command = CommandBuilder::new(fish);
        command.env("HOME", &config_home);
        command.env("XDG_CONFIG_HOME", &config_home);
        command.env("XDG_DATA_HOME", &config_home);
        command.env("fish_greeting", "");
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Merkur");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let shell_pid = child.process_id().unwrap();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (event_tx, event_rx) = pty_event_channel(16);
        let (_buffer_return_tx, buffer_return_rx) = unbounded();
        start_pty_reader(reader, event_tx, buffer_return_rx).unwrap();
        let (terminal_event_tx, terminal_event_rx) = unbounded();
        let mut terminal = TerminalState::new(80, 24, terminal_event_tx);

        observe_until_integration_state(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            true,
        );
        assert!(pty_prediction_safe(
            pair.master.as_ref(),
            shell_pid,
            terminal.shell_integration_input_active(),
            terminal.shell_integration_authenticated(),
        ));
        terminal.set_prediction_safe(true);

        let password_command = b"read --silent secret; printf '__MERKUR_FISH_READ_DONE__\\n'\n";
        assert!(terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r")));
        writer.write_all(password_command).unwrap();
        writer.flush().unwrap();
        observe_until_integration_state(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            false,
        );
        assert!(
            !pty_prediction_safe(
                pair.master.as_ref(),
                shell_pid,
                terminal.shell_integration_input_active(),
                terminal.shell_integration_authenticated(),
            ),
            "line submission/editor-close must revoke before fish's silent read"
        );

        writer.write_all(b"password\n").unwrap();
        writer.flush().unwrap();
        // Do not accept a boundary emitted by fish's silent reader itself as
        // proof that the command completed. Wait for both the command repaint
        // and the post-read marker, then for the next editor-open boundary.
        receive_until_terminal_marker(
            &event_rx,
            &mut terminal,
            &terminal_event_rx,
            writer.as_mut(),
            READ_DONE_MARKER,
            2,
            true,
        );
        terminal.observe_user_input(false, TerminalState::bytes_leave_line_editor(b"\r"));
        writer.write_all(b"exit\n").unwrap();
        writer.flush().unwrap();
        let exit_deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < exit_deadline,
                "fish did not exit after its terminal replies were drained"
            );
            match event_rx.recv_timeout(Duration::from_millis(10)) {
                Ok(TerminalEvent::PtyBytes(bytes, _)) => apply_test_pty_output(
                    &mut terminal,
                    &terminal_event_rx,
                    writer.as_mut(),
                    &bytes,
                ),
                Ok(TerminalEvent::PtyReadClosed | TerminalEvent::PtyReadError(_))
                | Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Ok(TerminalEvent::PtyWrite(_)) => {
                    unreachable!("reader emits only output events")
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        }
        std::fs::remove_dir_all(&config_home).ok();
    }

    #[cfg(unix)]
    #[test]
    fn pty_prediction_safety_fails_closed_on_tcgetattr_error() {
        assert!(!pty_prediction_safe_fd(-1, std::process::id(), true, false));
    }

    #[cfg(unix)]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ProfilePath {
        Baseline,
        PerReadSafety,
        CoalescedSafety,
    }

    #[cfg(unix)]
    #[derive(Debug, PartialEq, Eq)]
    struct ProfileTerminalWork {
        apply_calls: usize,
        applied_bytes: usize,
        display_revision: u64,
        display_header_signal: u128,
        shell_integration_input_active: bool,
        prediction_safe: bool,
        editor_anchor: Option<(u16, u16)>,
        editor_anchor_generation: u32,
        has_dirty: bool,
        emitted_events: usize,
        grid: Vec<merkur_codec::CellRepr>,
    }

    #[cfg(unix)]
    struct ProfileTerminal {
        terminal: TerminalState,
        event_rx: crossbeam_channel::Receiver<TerminalEvent>,
        apply_calls: usize,
        applied_bytes: usize,
    }

    #[cfg(unix)]
    impl ProfileTerminal {
        fn new() -> Self {
            let (event_tx, event_rx) = unbounded();
            let mut profile = Self {
                terminal: TerminalState::new(160, 48, event_tx),
                event_rx,
                apply_calls: 0,
                applied_bytes: 0,
            };
            profile.apply_bytes(b"\x1b[?2004h");
            // The real raw-mode PTY used by the profile keeps this grant true.
            // Prime every arm outside timing so the safety arms do not add an
            // otherwise unmatched metadata transition on their first sample.
            profile.terminal.set_prediction_safe(true);
            profile
        }

        fn apply_bytes(&mut self, bytes: &[u8]) {
            self.terminal.apply_bytes(bytes);
            self.apply_calls += 1;
            self.applied_bytes += bytes.len();
        }

        fn into_work(self) -> ProfileTerminalWork {
            let mut grid = Vec::new();
            self.terminal.current_grid_into(&mut grid);
            ProfileTerminalWork {
                apply_calls: self.apply_calls,
                applied_bytes: self.applied_bytes,
                display_revision: self.terminal.display_revision(),
                display_header_signal: self.terminal.current_display_header_signal(),
                shell_integration_input_active: self.terminal.shell_integration_input_active(),
                prediction_safe: self.terminal.prediction_safe(),
                editor_anchor: self.terminal.editor_anchor(),
                editor_anchor_generation: self.terminal.editor_anchor_generation(),
                has_dirty: self.terminal.has_dirty(),
                emitted_events: self.event_rx.try_iter().count(),
                grid,
            }
        }
    }

    #[cfg(unix)]
    fn run_profile_events(
        terminal: &mut ProfileTerminal,
        master: Option<&dyn MasterPty>,
        shell_pid: u32,
        bytes: &[u8],
        path: ProfilePath,
        samples: usize,
        output_events_per_coalesced_flush: usize,
    ) {
        for index in 0..samples {
            // Every path performs exactly one terminal/VTE apply, including the
            // canonical semantic shell-boundary callbacks. Only kernel sampling
            // cadence differs; the superseded standalone scanner is gone.
            terminal.apply_bytes(std::hint::black_box(bytes));
            if path == ProfilePath::PerReadSafety
                || (path == ProfilePath::CoalescedSafety
                    && (index + 1) % output_events_per_coalesced_flush == 0)
            {
                let master = master.expect("PTY safety profile path requires a PTY master");
                let prediction_safe = std::hint::black_box(pty_prediction_safe(
                    std::hint::black_box(master),
                    std::hint::black_box(shell_pid),
                    terminal.terminal.shell_integration_input_active(),
                    terminal.terminal.shell_integration_authenticated(),
                ));
                terminal.terminal.set_prediction_safe(prediction_safe);
            }
        }
    }

    #[cfg(unix)]
    fn measure_event_loop(
        master: Option<&dyn MasterPty>,
        shell_pid: u32,
        bytes: &[u8],
        path: ProfilePath,
        warmup_samples: usize,
        samples: usize,
        output_events_per_coalesced_flush: usize,
    ) -> (Duration, ProfileTerminalWork) {
        let mut terminal = ProfileTerminal::new();
        run_profile_events(
            &mut terminal,
            master,
            shell_pid,
            bytes,
            path,
            warmup_samples,
            output_events_per_coalesced_flush,
        );

        let started_at = std::time::Instant::now();
        run_profile_events(
            &mut terminal,
            master,
            shell_pid,
            bytes,
            path,
            samples,
            output_events_per_coalesced_flush,
        );
        let elapsed = started_at.elapsed();
        (elapsed, terminal.into_work())
    }

    #[cfg(unix)]
    #[test]
    fn pty_prediction_safety_profile_counts_equivalent_terminal_work() {
        const WARMUP_SAMPLES: usize = 3;
        const SAMPLES: usize = 11;
        const OUTPUT_EVENTS_PER_COALESCED_FLUSH: usize = 8;
        const BRACKETED_PASTE_ENABLE_BYTES: usize = b"\x1b[?2004h".len();
        let cases: &[(&str, &[u8])] = &[
            ("small_echo", b"x"),
            ("prompt", b"\r\x1b[2Kmerkur@host:/workspace/merkur$ "),
        ];

        for &(name, bytes) in cases {
            let (_, baseline) = measure_event_loop(
                None,
                0,
                bytes,
                ProfilePath::Baseline,
                WARMUP_SAMPLES,
                SAMPLES,
                OUTPUT_EVENTS_PER_COALESCED_FLUSH,
            );
            let mut expected = ProfileTerminal::new();
            for _ in 0..WARMUP_SAMPLES + SAMPLES {
                expected.apply_bytes(bytes);
            }
            assert_eq!(
                baseline,
                expected.into_work(),
                "{name} measured path must perform exactly the requested terminal work"
            );
            assert_eq!(baseline.apply_calls, 1 + WARMUP_SAMPLES + SAMPLES);
            assert_eq!(
                baseline.applied_bytes,
                BRACKETED_PASTE_ENABLE_BYTES + (WARMUP_SAMPLES + SAMPLES) * bytes.len()
            );
        }
    }

    /// Manual release-mode owner-loop microbenchmark comparing terminal/VTE work
    /// with per-read and coalesced termios/process-group sampling. Every arm
    /// includes canonical shell-boundary callbacks; there is no second scanner:
    /// `cargo test --release profile_pty_prediction_safety -- --ignored --nocapture`
    #[cfg(unix)]
    #[test]
    #[ignore = "release-mode PTY safety microbenchmark"]
    fn profile_pty_prediction_safety() {
        const WARMUP_SAMPLES: usize = 2_000;
        const SAMPLES: usize = 100_000;
        const ROUNDS: usize = 7;
        const OUTPUT_EVENTS_PER_COALESCED_FLUSH: usize = 8;
        // Keep the raw two-syscall sample below its prior 3.5 us gate and the
        // coalesced per-output-event cost below 0.7 us at eight reads/flush.
        const MAX_PER_READ_OVERHEAD_NS: f64 = 3_500.0;
        const MAX_COALESCED_OVERHEAD_NS: f64 = 700.0;
        const SMALL_ECHO: &[u8] = b"x";
        const PROMPT: &[u8] = b"\r\x1b[2Kmerkur@host:/workspace/merkur$ ";
        const READY_MARKER: &[u8] = b"__MERKUR_PROFILE_RAW_READY__";

        fn median(mut samples: Vec<Duration>) -> Duration {
            samples.sort_unstable();
            samples[samples.len() / 2]
        }

        fn profile_case(master: &dyn MasterPty, shell_pid: u32, name: &str, bytes: &[u8]) {
            let mut baseline = Vec::with_capacity(ROUNDS);
            let mut per_read = Vec::with_capacity(ROUNDS);
            let mut coalesced = Vec::with_capacity(ROUNDS);
            let mut expected_work = None;
            for round in 0..ROUNDS {
                let paths = match round % 3 {
                    0 => [
                        ProfilePath::Baseline,
                        ProfilePath::PerReadSafety,
                        ProfilePath::CoalescedSafety,
                    ],
                    1 => [
                        ProfilePath::PerReadSafety,
                        ProfilePath::CoalescedSafety,
                        ProfilePath::Baseline,
                    ],
                    _ => [
                        ProfilePath::CoalescedSafety,
                        ProfilePath::Baseline,
                        ProfilePath::PerReadSafety,
                    ],
                };
                for path in paths {
                    let (duration, work) = measure_event_loop(
                        Some(master),
                        shell_pid,
                        bytes,
                        path,
                        WARMUP_SAMPLES,
                        SAMPLES,
                        OUTPUT_EVENTS_PER_COALESCED_FLUSH,
                    );
                    if let Some(expected) = &expected_work {
                        assert_eq!(
                            &work, expected,
                            "{name} round {round} {path:?} performed different terminal work"
                        );
                    } else {
                        expected_work = Some(work);
                    }
                    match path {
                        ProfilePath::Baseline => baseline.push(duration),
                        ProfilePath::PerReadSafety => per_read.push(duration),
                        ProfilePath::CoalescedSafety => coalesced.push(duration),
                    }
                }
            }
            let baseline_ns = median(baseline).as_nanos() as f64 / SAMPLES as f64;
            let per_read_ns = median(per_read).as_nanos() as f64 / SAMPLES as f64;
            let coalesced_ns = median(coalesced).as_nanos() as f64 / SAMPLES as f64;
            let per_read_overhead_ns = per_read_ns - baseline_ns;
            let coalesced_overhead_ns = coalesced_ns - baseline_ns;
            eprintln!(
                "pty_prediction_safety/{name}: {} bytes, baseline={baseline_ns:.1} ns/event, per_read={per_read_ns:.1} ({per_read_overhead_ns:+.1}), coalesced_{OUTPUT_EVENTS_PER_COALESCED_FLUSH}={coalesced_ns:.1} ({coalesced_overhead_ns:+.1}) ns/event",
                bytes.len(),
            );
            assert!(
                per_read_overhead_ns <= MAX_PER_READ_OVERHEAD_NS,
                "{name} per-read PTY safety overhead {per_read_overhead_ns:.1} ns exceeded {MAX_PER_READ_OVERHEAD_NS:.1} ns"
            );
            assert!(
                coalesced_overhead_ns <= MAX_COALESCED_OVERHEAD_NS,
                "{name} coalesced PTY safety overhead {coalesced_overhead_ns:.1} ns exceeded {MAX_COALESCED_OVERHEAD_NS:.1} ns"
            );
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        configure_blocking_master(pair.master.as_ref()).unwrap();

        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "stty raw -echo; printf '__MERKUR_PROFILE_RAW_READY__'; IFS= read -r _",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let shell_pid = child.process_id().unwrap();
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (event_tx, event_rx) = pty_event_channel(8);
        let (_buffer_return_tx, buffer_return_rx) = unbounded();
        start_pty_reader(reader, event_tx, buffer_return_rx).unwrap();
        receive_until_pty_marker(&event_rx, READY_MARKER, 1);
        assert!(pty_prediction_safe(
            pair.master.as_ref(),
            shell_pid,
            true,
            false,
        ));

        profile_case(pair.master.as_ref(), shell_pid, "small_echo", SMALL_ECHO);
        profile_case(pair.master.as_ref(), shell_pid, "prompt", PROMPT);

        writer.write_all(b"done\n").unwrap();
        writer.flush().unwrap();
        child.wait().unwrap();
    }

    struct InterruptedThenData {
        step: u8,
    }

    impl Read for InterruptedThenData {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.step += 1;
            match self.step {
                1 => Err(io::Error::from(io::ErrorKind::Interrupted)),
                2 => {
                    buf[..3].copy_from_slice(b"pty");
                    Ok(3)
                }
                _ => Ok(0),
            }
        }
    }

    /// Sixteen three-byte reads, then end of file.
    struct SteadyOutput {
        reads: u8,
    }

    impl Read for SteadyOutput {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.reads == 16 {
                return Ok(0);
            }
            self.reads += 1;
            buf[..3].copy_from_slice(b"pty");
            Ok(3)
        }
    }

    /// The owner hands each buffer back at its full length, so a steady stream
    /// rotates the reader's first two allocations and never zeroes one again.
    #[test]
    fn pty_reader_rotates_its_returned_buffers_at_full_length() {
        let (event_tx, event_rx) = pty_event_channel(1);
        let (return_tx, return_rx) = unbounded();
        start_pty_reader(Box::new(SteadyOutput { reads: 0 }), event_tx, return_rx).unwrap();

        let mut buffers = std::collections::BTreeSet::new();
        loop {
            match event_rx.recv_timeout(Duration::from_secs(1)).unwrap() {
                TerminalEvent::PtyBytes(read, _) => {
                    assert_eq!(*read, *b"pty");
                    let buffer = read.into_buffer();
                    assert_eq!(buffer.len(), PTY_READ_BYTES);
                    buffers.insert(buffer.as_ptr() as usize);
                    return_tx.send(buffer).unwrap();
                }
                TerminalEvent::PtyReadClosed => break,
                _ => panic!("unexpected reader event"),
            }
        }
        assert!(
            buffers.len() <= 3,
            "sixteen reads used {} allocations",
            buffers.len()
        );
    }

    #[test]
    fn pty_reader_retries_interrupted_reads_without_reporting_a_false_close() {
        let (event_tx, event_rx) = pty_event_channel(4);
        let (_return_tx, return_rx) = unbounded();
        start_pty_reader(
            Box::new(InterruptedThenData { step: 0 }),
            event_tx,
            return_rx,
        )
        .unwrap();

        let first = event_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(first, TerminalEvent::PtyBytes(ref bytes, _) if **bytes == *b"pty"));
        let second = event_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(second, TerminalEvent::PtyReadClosed));
    }
}
