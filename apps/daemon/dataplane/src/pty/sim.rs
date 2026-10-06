//! The PTY as the network simulator (`tools/sim`) runs it: what the owner loop
//! writes reaches the program through a channel, and what the program writes
//! reaches the owner loop's read queue directly. The program is a task on the
//! same simulated host, so no reader or writer thread decides when a byte
//! arrives. Compiled only under `cfg(merkur_sim)`.

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use tokio::sync::{mpsc, oneshot, watch};

use super::{PtyHandle, TerminalEvent};

/// What the simulated program reports as its process id. No signal reaches
/// it and no process group owns the terminal, so this names nothing.
const PROGRAM_PID: u32 = 1;

/// The owner loop's half, consumed where the process spawns its shell.
pub struct Pty {
    input: mpsc::UnboundedSender<Vec<u8>>,
    size: watch::Sender<PtySize>,
    output: oneshot::Sender<mpsc::Sender<TerminalEvent>>,
}

/// The program's half: what the terminal wrote to it, and its own output.
pub struct Shell {
    input: mpsc::UnboundedReceiver<Vec<u8>>,
    size: watch::Receiver<PtySize>,
    output: Output,
}

enum Output {
    Pending(oneshot::Receiver<mpsc::Sender<TerminalEvent>>),
    Ready(mpsc::Sender<TerminalEvent>),
    Closed,
}

pub fn pair(cols: u16, rows: u16) -> (Pty, Shell) {
    let (input, input_rx) = mpsc::unbounded_channel();
    let (size, size_rx) = watch::channel(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    let (output, output_rx) = oneshot::channel();
    (
        Pty {
            input,
            size,
            output,
        },
        Shell {
            input: input_rx,
            size: size_rx,
            output: Output::Pending(output_rx),
        },
    )
}

impl Pty {
    /// The handle `spawn_pty` returns, with the program's output going to
    /// `event_tx` as a reader thread's would.
    pub fn spawn(self, event_tx: mpsc::Sender<TerminalEvent>) -> PtyHandle {
        let _ = self.output.send(event_tx);
        let exited = Arc::new(AtomicBool::new(false));
        PtyHandle {
            writer: Box::new(ProgramInput(self.input)),
            master: Box::new(Master(self.size)),
            child: Box::new(Program(exited)),
        }
    }
}

impl Shell {
    /// The next bytes the terminal wrote to the program; `None` once the
    /// dataplane is gone.
    pub async fn read(&mut self) -> Option<Vec<u8>> {
        self.input.recv().await
    }

    /// Writes program output; `false` once the dataplane has stopped reading.
    pub async fn write(&mut self, bytes: Vec<u8>) -> bool {
        if let Output::Pending(receiver) = &mut self.output {
            self.output = match receiver.await {
                Ok(sender) => Output::Ready(sender),
                Err(_) => Output::Closed,
            };
        }
        match &self.output {
            Output::Ready(sender) => sender
                .send(TerminalEvent::PtyBytes(bytes.into(), None))
                .await
                .is_ok(),
            Output::Pending(_) | Output::Closed => false,
        }
    }

    /// The terminal's size, as the last resize set it.
    pub fn size(&self) -> (u16, u16) {
        let size = *self.size.borrow();
        (size.cols, size.rows)
    }
}

struct ProgramInput(mpsc::UnboundedSender<Vec<u8>>);

impl Write for ProgramInput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0
            .send(bytes.to_vec())
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Master(watch::Sender<PtySize>);

impl MasterPty for Master {
    fn resize(&self, size: PtySize) -> Result<(), anyhow::Error> {
        self.0.send_replace(size);
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, anyhow::Error> {
        Ok(*self.0.borrow())
    }

    fn try_clone_reader(&self) -> Result<Box<dyn io::Read + Send>, anyhow::Error> {
        Err(io::Error::from(io::ErrorKind::Unsupported).into())
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>, anyhow::Error> {
        Err(io::Error::from(io::ErrorKind::Unsupported).into())
    }

    fn process_group_leader(&self) -> Option<libc::pid_t> {
        None
    }

    fn as_raw_fd(&self) -> Option<std::os::fd::RawFd> {
        None
    }

    fn tty_name(&self) -> Option<std::path::PathBuf> {
        None
    }
}

#[derive(Debug)]
struct Program(Arc<AtomicBool>);

impl ChildKiller for Program {
    fn kill(&mut self) -> io::Result<()> {
        self.0.store(true, Ordering::Release);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Program(Arc::clone(&self.0)))
    }
}

impl Child for Program {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        Ok(self
            .0
            .load(Ordering::Acquire)
            .then(|| ExitStatus::with_exit_code(0)))
    }

    /// The owner loop waits only after killing the program, which ends it.
    fn wait(&mut self) -> io::Result<ExitStatus> {
        Ok(ExitStatus::with_exit_code(0))
    }

    fn process_id(&self) -> Option<u32> {
        Some(PROGRAM_PID)
    }
}
