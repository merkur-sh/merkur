//! The dataplane as the network simulator (`tools/sim`) runs it: the same
//! owner loop, with what the process gets from its parent and its terminal
//! handed in as channels. The simulator plays the Bun daemon on the other end
//! of the commands and events, and the program on the PTY. Compiled only under
//! `cfg(merkur_sim)`.
//!
//! Everything the process hands across a thread happens on the host's runtime
//! instead: reading stdin, writing stdout, the PTY's reads and writes, display
//! preparation, and identity signing. A run's order of events is then a
//! function of its seed.

use std::future::Future;

use tokio::sync::mpsc;

pub use crate::pty::sim::Shell;

/// The commands the Bun daemon writes.
pub mod command {
    pub use crate::ipc::commands::{
        CMD_CANCEL_SESSION as CANCEL_SESSION, CMD_CONFIGURE as CONFIGURE, CMD_SHUTDOWN as SHUTDOWN,
        CMD_START_SESSION as START_SESSION, CMD_UPDATE_EDGE_ADMISSION as UPDATE_EDGE_ADMISSION,
        CMD_UPDATE_REVOCATION as UPDATE_REVOCATION, CMD_UPDATE_STUN as UPDATE_STUN,
    };
}

/// The events the Bun daemon reads.
pub mod event {
    pub use crate::ipc::events::{
        EVT_COMMAND_ACK as COMMAND_ACK, EVT_ERROR as ERROR,
        EVT_PEER_AUTHENTICATED as PEER_AUTHENTICATED, EVT_PEER_DISCONNECTED as PEER_DISCONNECTED,
        EVT_PTY_CLOSED as PTY_CLOSED, EVT_PTY_READY as PTY_READY,
        EVT_SESSION_REBIND as SESSION_REBIND,
    };
}

/// The dataplane's stdin.
pub struct Commands(mpsc::Sender<crate::IpcInput>);

impl Commands {
    /// One framed command; `false` once the owner loop has stopped reading.
    pub async fn send(&self, kind: u8, payload: Vec<u8>) -> bool {
        self.0
            .send(crate::IpcInput::Frame(kind, payload))
            .await
            .is_ok()
    }
}

/// The dataplane's stdout.
pub struct Events(crate::ipc::events::SimEvents);

impl Events {
    /// The next event frame; `None` once the owner loop has closed its sink.
    pub async fn recv(&mut self) -> Option<(u8, Vec<u8>)> {
        self.0.recv().await
    }
}

/// Everything the Bun daemon and the PTY's program hold.
pub struct Dataplane {
    pub commands: Commands,
    pub events: Events,
    pub shell: Shell,
}

/// The owner loop for a `cols` by `rows` terminal, and the handles it is
/// driven by. The loop runs until a shutdown command, or until every command
/// sender is gone.
pub fn start(
    cols: u16,
    rows: u16,
) -> (
    Dataplane,
    impl Future<Output = Result<(), Box<dyn std::error::Error>>>,
) {
    let (commands, ipc) = mpsc::channel(crate::IPC_COMMAND_QUEUE_DEPTH);
    let (sink, failures, output, events) = crate::ipc::events::start_sim_event_output();
    let (pty, shell) = crate::pty::sim::pair(cols, rows);
    let args = crate::parse_args(
        [
            "--shell".to_string(),
            "sim".to_string(),
            "--cols".to_string(),
            cols.to_string(),
            "--rows".to_string(),
            rows.to_string(),
        ]
        .into_iter(),
    );
    let host = args.map(|args| crate::Host {
        args,
        ipc,
        events: (sink, failures, output),
        pty,
    });
    (
        Dataplane {
            commands: Commands(commands),
            events: Events(events),
            shell,
        },
        async move { crate::run(host?).await },
    )
}
