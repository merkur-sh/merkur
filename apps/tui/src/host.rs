//! The host terminal the TUI runs in.
//!
//! The TUI opens the controlling terminal as a file description of its own,
//! so the non-blocking mode that lets the reactor read keys without a thread
//! hop never reaches the shell's standard input. It puts that terminal in raw
//! mode with the alternate screen, every Kitty keyboard flag, bracketed paste
//! and focus reporting, and puts it back as it was on every way out: a drop,
//! or a panic, whose message then prints on the normal screen. Mouse reporting
//! is not set here: it follows the machine's own modes.

use std::io;
use std::os::fd::OwnedFd;
use std::sync::{Arc, Mutex};

use rustix::event::{PollFd, PollFlags, poll};
use rustix::fs::{Mode, OFlags, open};
use rustix::termios::{
    OptionalActions, QueueSelector, Termios, tcflush, tcgetattr, tcgetwinsize, tcsetattr,
};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;
use tokio::signal::unix::{Signal, SignalKind, signal};

/// Save the host title, alternate screen, Kitty flags 31, bracketed paste, focus.
const ENTER: &[u8] = b"\x1b[22;0t\x1b[?1049h\x1b[>31u\x1b[?2004h\x1b[?1004h";
/// Every mode the TUI may have set, off; the pushed flags popped; the
/// cursor's shape and pen, normal screen and saved host title restored.
const LEAVE: &[u8] = b"\x18\x1b\\\x1b[?2026l\x1b]8;;\x1b\\\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\
\x1b[<u\x1b[0 q\x1b[?25h\x1b[m\x1b[?1049l\x1b[23;0t";

/// The host's size, and one cell in pixels when the host reports its own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HostSize {
    pub cols: u16,
    pub rows: u16,
    pub cell: Option<(f64, f64)>,
}

/// What restores the host: a descriptor of its own, so a panic can use it
/// whoever holds the `Host`.
struct Restore {
    tty: OwnedFd,
    original: Termios,
    owner: Arc<()>,
}

static RESTORE: Mutex<Option<Restore>> = Mutex::new(None);

pub struct Host {
    tty: AsyncFd<OwnedFd>,
    owner: Arc<()>,
    signals: tokio::sync::Mutex<Signals>,
}

/// Host input and lifecycle notifications share the UI reactor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostRead {
    Bytes(usize),
    Resize,
    Exit(i32),
}

struct Signals {
    resize: Signal,
    interrupt: Signal,
    terminate: Signal,
    hangup: Signal,
}

impl Signals {
    fn new() -> io::Result<Self> {
        Ok(Self {
            resize: signal(SignalKind::window_change())?,
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
        })
    }

    async fn next(&mut self) -> HostRead {
        tokio::select! {
            _ = self.resize.recv() => HostRead::Resize,
            _ = self.interrupt.recv() => HostRead::Exit(128 + SignalKind::interrupt().as_raw_value()),
            _ = self.terminate.recv() => HostRead::Exit(128 + SignalKind::terminate().as_raw_value()),
            _ = self.hangup.recv() => HostRead::Exit(128 + SignalKind::hangup().as_raw_value()),
        }
    }
}

impl Host {
    /// Takes over the controlling terminal.
    pub fn enter() -> io::Result<Self> {
        // Use the actual terminal device, not the /dev/tty indirection:
        // Darwin's kqueue rejects readiness registration on that alias.
        // The CLI keeps stdin attached to its controlling terminal.
        let name = rustix::termios::ttyname(std::io::stdin(), Vec::new())?;
        let tty = open(
            name.as_c_str(),
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )?;
        Self::take(tty).map_err(|error| {
            io::Error::new(error.kind(), format!("take controlling terminal: {error}"))
        })
    }

    /// Takes over the terminal `tty`, which must be non-blocking.
    fn take(tty: OwnedFd) -> io::Result<Self> {
        // Register lifecycle handlers before raw mode can suppress the shell's
        // normal cleanup. Signal work runs on the reactor, never in a handler.
        let signals = Signals::new()?;
        let mut slot = RESTORE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "host terminal already taken",
            ));
        }
        let original = tcgetattr(&tty)?;
        let mut raw = original.clone();
        raw.make_raw();
        let owner = Arc::new(());
        let restore = Restore {
            tty: tty.try_clone()?,
            original,
            owner: Arc::clone(&owner),
        };
        let tty = AsyncFd::with_interest(tty, Interest::READABLE | Interest::WRITABLE).map_err(
            |error| io::Error::new(error.kind(), format!("register terminal reactor: {error}")),
        )?;
        tcsetattr(tty.get_ref(), OptionalActions::Now, &raw)?;
        *slot = Some(restore);
        drop(slot);
        // Own restoration before the first fallible write enters any host mode.
        let host = Self {
            tty,
            owner,
            signals: tokio::sync::Mutex::new(signals),
        };
        install_panic_restore();
        blocking_write(host.tty.get_ref(), ENTER)?;
        Ok(host)
    }

    pub fn size(&self) -> io::Result<HostSize> {
        let size = tcgetwinsize(self.tty.get_ref())?;
        let cell = (size.ws_xpixel > 0
            && size.ws_ypixel > 0
            && size.ws_col > 0
            && size.ws_row > 0
            && size.ws_xpixel % size.ws_col == 0
            && size.ws_ypixel % size.ws_row == 0)
            .then(|| {
                (
                    f64::from(size.ws_xpixel) / f64::from(size.ws_col),
                    f64::from(size.ws_ypixel) / f64::from(size.ws_row),
                )
            });
        Ok(HostSize {
            cols: size.ws_col,
            rows: size.ws_row,
            cell,
        })
    }

    /// The size after a window change. A host that states its cell only in
    /// answer to `CSI 16 t` keeps the one it last stated until it answers again.
    pub fn resized(&self, previous: HostSize) -> io::Result<HostSize> {
        let size = self.size()?;
        Ok(HostSize {
            cell: size.cell.or(previous.cell),
            ..size
        })
    }

    /// What the host wrote: its keys, reports and replies.
    pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        read_tty(&self.tty, buf).await
    }

    /// Cancellation-safe input, resize, or termination. A termination restores
    /// the terminal before handing the exit status to the application.
    pub async fn read_event(&self, buf: &mut [u8]) -> io::Result<HostRead> {
        let event = tokio::select! {
            bytes = read_tty(&self.tty, buf) => HostRead::Bytes(bytes?),
            event = async { self.signals.lock().await.next().await } => event,
        };
        if matches!(event, HostRead::Exit(_)) {
            restore(Some(&self.owner));
        }
        Ok(event)
    }

    /// Writes one ready chunk. The caller retains the remaining byte offset,
    /// so cancellation while input or an ACK wins the UI select loses nothing.
    pub async fn write_chunk(&self, bytes: &[u8]) -> io::Result<usize> {
        loop {
            let mut ready = self.tty.writable().await?;
            match ready.try_io(|tty| Ok(rustix::io::write(tty, bytes)?)) {
                Ok(Ok(0)) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
                Ok(result) => return result,
                Err(_would_block) => {}
            }
        }
    }

    /// Writes all of `bytes`, at the pace the host reads them.
    pub async fn write_all(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let mut ready = self.tty.writable().await?;
            match ready.try_io(|tty| Ok(rustix::io::write(tty, bytes)?)) {
                Ok(Ok(0)) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
                Ok(written) => bytes = &bytes[written?..],
                Err(_would_block) => {}
            }
        }
        Ok(())
    }
}

async fn read_tty(tty: &AsyncFd<OwnedFd>, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        let mut ready = tty.readable().await?;
        match ready.try_io(|tty| Ok(rustix::io::read(tty, &mut *buf)?)) {
            Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
            Ok(result) => return result,
            Err(_would_block) => {}
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        restore(Some(&self.owner));
    }
}

/// Puts the host back as it was, once.
fn restore(owner: Option<&Arc<()>>) {
    let mut slot = RESTORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if owner.is_some_and(|owner| {
        slot.as_ref()
            .is_some_and(|state| !Arc::ptr_eq(owner, &state.owner))
    }) {
        return;
    }
    let taken = slot.take();
    drop(slot);
    if let Some(restore) = taken {
        // Discard unread raw input before returning to an echoing shell. A
        // cancelled password prompt must not leave a suffix as shell commands.
        let _ = tcflush(&restore.tty, QueueSelector::IFlush);
        // Restore input even when the host's output queue is stalled.
        let _ = tcsetattr(&restore.tty, OptionalActions::Now, &restore.original);
        // Stop any partly written APC before deleting uploads, including
        // images that never acquired a visible placement.
        let _ = blocking_write(&restore.tty, b"\x18\x1b\\");
        let _ = blocking_write(&restore.tty, &crate::graphics::restore_commands());
        let _ = blocking_write(&restore.tty, LEAVE);
    }
}

fn install_panic_restore() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        let report = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore(None);
            report(info);
        }));
    });
}

/// Writes all of `bytes` to a non-blocking terminal, waiting out a full one.
fn blocking_write(tty: &OwnedFd, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        match rustix::io::write(tty, bytes) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(written) => bytes = &bytes[written..],
            Err(rustix::io::Errno::AGAIN) => {
                let mut ready = [PollFd::new(tty, PollFlags::OUT)];
                poll(&mut ready, None)?;
            }
            Err(rustix::io::Errno::INTR) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
