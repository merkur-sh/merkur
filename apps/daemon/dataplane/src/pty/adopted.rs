//! The PTY a predecessor dataplane handed over at an upgrade (`crate::handoff`).
//!
//! The predecessor `execve`d into this process, so the pid is the same and the shell is
//! still its child: the master descriptor arrived open across the exec, and the child is
//! reaped here with `waitpid` exactly as the spawning process would have. Nothing about the
//! shell changes; only the process reading its terminal does.

// A latency path: the PTY waits on the event itself, never on a clock. `clippy.toml` lists
// the timer calls this denies.
#![cfg_attr(not(test), deny(clippy::disallowed_methods))]

use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::ExitStatusExt;

use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use tokio::sync::mpsc::Sender;

use super::{PtyHandle, ReaderStop, TerminalEvent, configure_blocking_fd, start_pty_reader};

/// Takes over the terminal `master` whose shell is the child `pid`, starting the reader
/// thread a spawned PTY starts.
pub fn adopt_pty(
    master: OwnedFd,
    pid: u32,
    event_tx: Sender<TerminalEvent>,
    buffer_return_rx: crossbeam_channel::Receiver<Vec<u8>>,
) -> io::Result<PtyHandle> {
    configure_blocking_fd(master.as_raw_fd())?;
    let pid = libc::pid_t::try_from(pid)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let master = Master(master);
    let reader = master.duplicate()?;
    let writer = master.duplicate()?;
    let stop = std::sync::Arc::new(ReaderStop::default());
    start_pty_reader(
        Box::new(reader),
        event_tx,
        buffer_return_rx,
        std::sync::Arc::clone(&stop),
    )?;
    Ok(PtyHandle {
        writer: Box::new(writer),
        master: Box::new(master),
        child: Box::new(Shell(pid)),
        reader: stop,
    })
}

struct Master(OwnedFd);

impl Master {
    fn duplicate(&self) -> io::Result<File> {
        // SAFETY: `fcntl(F_DUPFD_CLOEXEC)` reads no pointer; it returns a new descriptor
        // this function then owns, or -1.
        let fd = unsafe { libc::fcntl(self.0.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if fd == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` was just returned by `fcntl` and nothing else owns it.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

impl MasterPty for Master {
    fn resize(&self, size: PtySize) -> Result<(), anyhow::Error> {
        let window = libc::winsize {
            ws_row: size.rows,
            ws_col: size.cols,
            ws_xpixel: size.pixel_width,
            ws_ypixel: size.pixel_height,
        };
        // SAFETY: `TIOCSWINSZ` reads one `winsize` through its argument, a live, aligned
        // value on this frame.
        if unsafe { libc::ioctl(self.0.as_raw_fd(), libc::TIOCSWINSZ, &window) } == -1 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, anyhow::Error> {
        let mut window = std::mem::MaybeUninit::<libc::winsize>::uninit();
        // SAFETY: `TIOCGWINSZ` writes one `winsize` through its argument, a live slot of
        // that type on this frame.
        if unsafe { libc::ioctl(self.0.as_raw_fd(), libc::TIOCGWINSZ, window.as_mut_ptr()) } == -1 {
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: the ioctl succeeded, so it filled the whole structure.
        let window = unsafe { window.assume_init() };
        Ok(PtySize {
            rows: window.ws_row,
            cols: window.ws_col,
            pixel_width: window.ws_xpixel,
            pixel_height: window.ws_ypixel,
        })
    }

    fn try_clone_reader(&self) -> Result<Box<dyn io::Read + Send>, anyhow::Error> {
        Ok(Box::new(self.duplicate()?))
    }

    fn take_writer(&self) -> Result<Box<dyn io::Write + Send>, anyhow::Error> {
        Ok(Box::new(self.duplicate()?))
    }

    fn process_group_leader(&self) -> Option<libc::pid_t> {
        // SAFETY: `tcgetpgrp` reads no pointer; -1 means the descriptor has no
        // foreground process group.
        match unsafe { libc::tcgetpgrp(self.0.as_raw_fd()) } {
            -1 => None,
            group => Some(group),
        }
    }

    fn as_raw_fd(&self) -> Option<RawFd> {
        Some(self.0.as_raw_fd())
    }

    fn tty_name(&self) -> Option<std::path::PathBuf> {
        None
    }
}

#[derive(Debug, Clone, Copy)]
struct Shell(libc::pid_t);

impl Shell {
    fn wait_with(&self, options: libc::c_int) -> io::Result<Option<ExitStatus>> {
        let mut status = 0;
        loop {
            // SAFETY: `waitpid` writes one `c_int` through its pointer, a live local.
            let result = unsafe { libc::waitpid(self.0, &mut status, options) };
            match result {
                0 => return Ok(None),
                -1 if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => continue,
                -1 => return Err(io::Error::last_os_error()),
                _ => return Ok(Some(std::process::ExitStatus::from_raw(status).into())),
            }
        }
    }
}

impl ChildKiller for Shell {
    /// What a spawned child's killer sends: the terminal hangup.
    fn kill(&mut self) -> io::Result<()> {
        // SAFETY: `kill` reads no pointer.
        if unsafe { libc::kill(self.0, libc::SIGHUP) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(*self)
    }
}

impl Child for Shell {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_with(libc::WNOHANG)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.wait_with(0)?
            .ok_or_else(|| io::Error::other("waitpid returned without a status"))
    }

    fn process_id(&self) -> Option<u32> {
        u32::try_from(self.0).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::{Read, Write};

    /// A real PTY whose shell this process spawned, handed to the adopter by descriptor
    /// alone, as an `execve` hands it: reading, writing, resizing and reaping all work.
    #[test]
    fn an_adopted_master_reads_writes_resizes_and_reaps_its_shell() {
        let pair = portable_pty::native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("pty");
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args(["-c", "read line; echo \"got:$line\"; stty size"]);
        let child = pair.slave.spawn_command(command).expect("spawn");
        drop(pair.slave);
        let pid = child.process_id().expect("pid");
        let fd = pair.master.as_raw_fd().expect("master fd");
        // SAFETY: `fd` is the master's open descriptor; duplicate it so the adopter owns
        // its own copy, as the exec'd process does.
        let owned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        assert!(owned >= 0);
        // SAFETY: `owned` was just returned by `fcntl`.
        let master = Master(unsafe { OwnedFd::from_raw_fd(owned) });
        // The child's handle is dropped without waiting: only the adopter reaps it.
        drop(child);

        master
            .resize(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("resize");
        assert_eq!(master.get_size().expect("size").cols, 100);
        let mut writer = master.take_writer().expect("writer");
        writer.write_all(b"hello\n").expect("write");
        let mut reader = master.try_clone_reader().expect("reader");
        let mut output = Vec::new();
        let mut buffer = [0u8; 256];
        while !String::from_utf8_lossy(&output).contains("30 100") {
            let read = reader.read(&mut buffer).expect("read");
            assert_ne!(read, 0, "pty closed before the shell answered: {output:?}");
            output.extend_from_slice(&buffer[..read]);
        }
        assert!(String::from_utf8_lossy(&output).contains("got:hello"));

        let mut shell = Shell(libc::pid_t::try_from(pid).expect("pid"));
        assert_eq!(shell.process_id(), Some(pid));
        let status = shell.wait().expect("reaped");
        assert!(status.success());
        drop(pair.master);
    }
}
