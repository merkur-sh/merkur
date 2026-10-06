//! The daemon host: the dataplane's owner loop, the Bun daemon's part of the
//! host, and the program on the PTY.
//!
//! The Bun daemon's part configures the dataplane, hands it a fresh edge
//! ticket and the edge's current certificate hashes with every control lease,
//! and carries each session the server starts or retracts, answering a start
//! once the dataplane has accepted it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use merkur_dataplane::sim::{Commands, Dataplane, Events, command, event};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot, watch};

use crate::server::{Account, Control, cert_hashes_base64, edge_url};
use crate::shell::Transcript;

/// The server renews a daemon's control lease, and with it the edge ticket and
/// the registered edges, this often.
const LEASE_INTERVAL: Duration = Duration::from_secs(20);
/// The account's revocation generation: nothing in a run revokes, so it never
/// moves.
const REVOCATION_GENERATION: u32 = 0;

/// Every event the dataplane wrote, in order, for a scenario's invariants.
#[derive(Clone, Default)]
pub struct EventLog(Arc<Mutex<Vec<(u8, Vec<u8>)>>>);

impl EventLog {
    fn push(&self, kind: u8, payload: Vec<u8>) {
        self.0.lock().expect("event log").push((kind, payload));
    }

    pub fn count(&self, kind: u8) -> usize {
        self.0
            .lock()
            .expect("event log")
            .iter()
            .filter(|(logged, _)| *logged == kind)
            .count()
    }
}

#[derive(Deserialize)]
struct CommandAck {
    status: String,
    command_id: String,
}

/// Starts the dataplane on the current host with its shell, then runs the
/// Bun daemon's part until the dataplane exits.
///
/// `control` outlives a boot of the host: each boot holds it while it runs,
/// and a crashed boot's tasks drop with it.
pub async fn serve(
    account: Arc<Account>,
    edge: watch::Receiver<Option<[[u8; 32]; 2]>>,
    control: Arc<tokio::sync::Mutex<mpsc::Receiver<Control>>>,
    log: EventLog,
    transcript: Transcript,
    cols: u16,
    rows: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let (dataplane, owner) = merkur_dataplane::sim::start(cols, rows);
    let Dataplane {
        commands,
        events,
        shell,
    } = dataplane;
    tokio::spawn(crate::shell::run(shell, transcript));
    tokio::spawn(async move {
        let mut control = control.lock().await;
        bun(&commands, events, &account, &edge, &mut control, log).await;
    });
    // The owner loop runs on the host's own task, as `block_on` runs it in the
    // process; it is not `Send`.
    owner.await
}

async fn bun(
    commands: &Commands,
    mut events: Events,
    account: &Account,
    edge: &watch::Receiver<Option<[[u8; 32]; 2]>>,
    control: &mut mpsc::Receiver<Control>,
    log: EventLog,
) {
    if !commands.send(command::CONFIGURE, account.configure()).await
        || !lease(commands, account, edge).await
    {
        return;
    }
    let mut leases =
        tokio::time::interval_at(tokio::time::Instant::now() + LEASE_INTERVAL, LEASE_INTERVAL);
    let mut pending: Vec<(String, oneshot::Sender<bool>)> = Vec::new();
    loop {
        tokio::select! {
            message = control.recv() => {
                let sent = match message {
                    None => return,
                    Some(Control::Start { command, command_id, accepted }) => {
                        pending.push((command_id, accepted));
                        commands.send(command::START_SESSION, command).await
                    }
                    Some(Control::Cancel { command }) => {
                        commands.send(command::CANCEL_SESSION, command).await
                    }
                };
                if !sent {
                    return;
                }
            }
            frame = events.recv() => {
                let Some((kind, payload)) = frame else { return };
                if kind == event::COMMAND_ACK
                    && let Ok(ack) = serde_json::from_slice::<CommandAck>(&payload)
                    && let Some(at) = pending.iter().position(|(id, _)| *id == ack.command_id)
                {
                    let (_, answer) = pending.swap_remove(at);
                    let _ = answer.send(ack.status == "accepted");
                }
                log.push(kind, payload);
            }
            _ = leases.tick() => {
                if !lease(commands, account, edge).await {
                    return;
                }
            }
        }
    }
}

/// What a control lease delivers, as the Bun daemon relays it: the account's
/// revocation generation, a fresh edge ticket and the edge registry, which in
/// a simulation holds the one edge once it has registered. The STUN ticket a
/// lease also carries starts the direct path's discovery, which the simulator
/// does not run, so it is not relayed.
async fn lease(
    commands: &Commands,
    account: &Account,
    edge: &watch::Receiver<Option<[[u8; 32]; 2]>>,
) -> bool {
    let edges: Vec<serde_json::Value> = edge
        .borrow()
        .iter()
        .map(|hashes| {
            serde_json::json!({ "url": edge_url(), "cert_hashes": cert_hashes_base64(hashes) })
        })
        .collect();
    let admission = serde_json::to_vec(&serde_json::json!({
        "ticket": account.daemon_ticket(),
        "edges": edges,
    }))
    .expect("an edge admission command");
    commands
        .send(
            command::UPDATE_REVOCATION,
            REVOCATION_GENERATION.to_be_bytes().to_vec(),
        )
        .await
        && commands.send(command::UPDATE_EDGE_ADMISSION, admission).await
}
