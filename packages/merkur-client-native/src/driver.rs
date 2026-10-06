//! Runs one [`Session`] on tokio: performs its actions, feeds it carrier
//! events and timers, and hands its output to the viewer.
//!
//! The loop owns the session outright; carriers, dials and issuance requests
//! run as tasks that report back through one channel. A keystroke goes from
//! `commands` into the session and out as a datagram in the same turn: nothing
//! on that path waits for a timer.

use futures::future::BoxFuture;
use std::collections::HashMap;
use std::sync::Arc;

use merkur_authorization::{MlDsa87Signer, SIGNATURE_BYTES};
use merkur_client::Entropy;
use merkur_client::input_sequence::InputMapping;
use merkur_client::liveness::PathKind;
use merkur_client::session::geometry::GeometryStatus;
use merkur_client::session::graphics::{FinitePart, GraphicsAsset, GraphicsDemand};
use merkur_client::session::{Action, ConnId, DisplayFence, DisplayResume, Event, Session, Status};
use merkur_wire::protocol::{DisplayAckPayload, OpenUrlId};
use rand_core::RngCore;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::account::AccountError;
use crate::carrier::{Carrier, Finite, Inbound};
use crate::issuer::Issuer;

mod output;
pub use output::{Delivery, Outputs};
mod command;
pub use command::{CommandDelivery, CommandReceiver, CommandSendError, Commands};

/// The operating system's randomness.
pub struct OsEntropy;

impl Entropy for OsEntropy {
    fn fill(&mut self, bytes: &mut [u8]) {
        rand_core::OsRng.fill_bytes(bytes);
    }
}

/// What a running session hands its viewer.
pub enum Output {
    /// Cumulative host input released by an authenticated ACK or genesis.
    InputAcknowledged(u32),
    Terminal {
        channel: u8,
        datagram: bool,
        payload: Vec<u8>,
        /// The numbering input went out under when this arrived.
        input: InputMapping,
    },
    DisplayFence(DisplayFence),
    TerminalUi(merkur_wire::terminal_ui::TerminalUi),
    OpenUrl {
        id: OpenUrlId,
        url: String,
    },
    /// A verified graphics asset of the scene of display lineage `epoch`.
    GraphicsAsset {
        epoch: u32,
        key: String,
        asset: GraphicsAsset,
        bytes: Vec<u8>,
    },
    Status(Status),
    /// Who owns the shared terminal's size, as the daemon last stated it.
    GeometryState(GeometryStatus),
    /// The daemon's animation clock, read within a round trip of `rtt_ms`
    /// that just ended.
    GraphicsClock {
        monotonic_us: u64,
        rtt_ms: u64,
    },
    /// Which path now carries the session: the edge relay or the direct one.
    Path(PathKind),
    /// The committed carrier's independently observed source address.
    ObservedPath(std::net::IpAddr),
    /// Authenticated opt-in performance evidence.
    Observation(Box<merkur_client::session::observation::Observation>),
    /// Why the server refused the issuance the session asked for.
    IssuanceRefused(AccountError),
}

/// What the viewer's side hands the running session.
pub enum Command {
    /// One input record, numbered by the host's own contiguous counter;
    /// `modelled` when the viewer's speculative model painted its effect.
    Input {
        local_seq: u32,
        record: Vec<u8>,
        modelled: bool,
    },
    DisplayAck {
        payload: DisplayAckPayload,
        durable: bool,
    },
    SnapshotRequest,
    OpenUrlAcknowledged(OpenUrlId),
    ResyncRows {
        generation: u32,
        rows: Vec<u16>,
    },
    DictionaryReady(bool),
    DictionaryAck(u32),
    DisplayResume(DisplayResume),
    /// The assets the viewer's scene of display lineage `epoch` needs.
    GraphicsDemand {
        epoch: u32,
        demands: Vec<GraphicsDemand>,
    },
    /// The host's viewport: cells, and one cell in logical pixels when the
    /// host knows them.
    Viewport {
        cols: u16,
        rows: u16,
        cell: Option<(f64, f64)>,
    },
    /// Whether the host's window is the focused one.
    Focused(bool),
    /// The user asked for the shared geometry.
    TakeGeometry,
}

impl Drop for Command {
    fn drop(&mut self) {
        if let Self::Input { record, .. } = self {
            use zeroize::Zeroize;
            record.zeroize();
        }
    }
}

enum Task {
    Issued(Result<Box<merkur_client::issuance::Issuance>, AccountError>),
    Renewed(Result<merkur_client::issuance::RenewalCapability, AccountError>),
    /// The delegate's signature for one session request; `None` when the
    /// signer failed.
    Signed(u64, Option<Box<[u8; SIGNATURE_BYTES]>>),
    Dialed(ConnId, Result<Carrier, String>),
    Carrier(Inbound),
}

#[derive(Default)]
struct PendingWrites(HashMap<(ConnId, u8), BoxFuture<'static, bool>>);
impl PendingWrites {
    fn insert(&mut self, conn: ConnId, channel: u8, pending: crate::carrier::Pending) {
        self.insert_future(conn, channel, Box::pin(pending.admit()));
    }
    fn insert_future(&mut self, conn: ConnId, channel: u8, future: BoxFuture<'static, bool>) {
        assert!(
            self.0.insert((conn, channel), future).is_none(),
            "one pending record per writer"
        );
    }
    fn retire(&mut self, conn: ConnId) {
        self.0.retain(|(owner, _), _| *owner != conn);
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    async fn ready(&mut self) -> (ConnId, u8, bool) {
        futures::future::poll_fn(|cx| {
            let ready =
                self.0
                    .iter_mut()
                    .find_map(|(key, future)| match future.as_mut().poll(cx) {
                        std::task::Poll::Ready(admitted) => Some((*key, admitted)),
                        std::task::Poll::Pending => None,
                    });
            match ready {
                Some(((conn, channel), admitted)) => {
                    self.0.remove(&(conn, channel));
                    std::task::Poll::Ready((conn, channel, admitted))
                }
                None => std::task::Poll::Pending,
            }
        })
        .await
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum TaskOwner {
    Issuance,
    Renewal,
    Signature(u64),
    Dial(ConnId),
    PathWatcher,
}
#[derive(Default)]
struct OwnedTasks(HashMap<TaskOwner, tokio::task::JoinHandle<()>>);
impl OwnedTasks {
    fn abort(&mut self, owner: TaskOwner) {
        if let Some(task) = self.0.remove(&owner) {
            task.abort();
        }
    }
    fn spawn(
        &mut self,
        owner: TaskOwner,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) {
        self.abort(owner);
        self.0.insert(owner, tokio::spawn(future));
    }
    fn finish(&mut self, task: &Task) {
        let owner = match task {
            Task::Issued(_) => TaskOwner::Issuance,
            Task::Renewed(_) => TaskOwner::Renewal,
            Task::Signed(id, _) => TaskOwner::Signature(*id),
            Task::Dialed(conn, _) => TaskOwner::Dial(*conn),
            Task::Carrier(_) => return,
        };
        self.0.remove(&owner);
    }
}
impl Drop for OwnedTasks {
    fn drop(&mut self) {
        for (_, task) in self.0.drain() {
            task.abort();
        }
    }
}

/// Connects `session` to `daemon_id` and runs it until the session closes or
/// `commands` ends.
///
/// Issuances and renewal capabilities come from `issuer`. `edge_port`
/// replaces the port of every issued edge URL. Only the e2e harness sets it:
/// its proxy gives each peer role its own listener, and the edge registers the
/// daemon's.
pub async fn run(
    mut session: Session,
    daemon_id: &str,
    issuer: Arc<dyn Issuer>,
    delegate: Arc<dyn MlDsa87Signer>,
    edge_port: Option<u16>,
    mut commands: CommandReceiver,
    output: Outputs,
) {
    let epoch = Instant::now();
    let now_ms = move || epoch.elapsed().as_millis() as u64;
    let mut entropy = OsEntropy;
    let (tasks, mut task_events) = mpsc::channel::<Task>(16);
    let mut owned_tasks = OwnedTasks::default();
    let (carrier_events, mut inbound) = crate::carrier::InboundSender::channel();
    let mut carriers: HashMap<ConnId, Carrier> = HashMap::new();
    let mut writes = PendingWrites::default();
    let (path_changes, mut hints) = mpsc::channel::<()>(1);
    if let Some(watcher) = crate::path_hints::spawn(path_changes) {
        owned_tasks.0.insert(TaskOwner::PathWatcher, watcher);
    }
    // Dials the session still wants; one it closed while dialing is dropped
    // on arrival.
    let mut dialing: Vec<ConnId> = Vec::new();

    let mut input_released = 0;
    let mut ready_lease = None;
    let mut ingress_leases: [Option<crate::credit::Lease>; 2] = [None, None];
    let mut issuance_refused = None;
    session.connect(daemon_id, &mut entropy);
    loop {
        if output.is_closed() {
            return;
        }
        if session.is_closed() {
            // A terminal failure is definitive even while its host status waits
            // for receive credit. Refuse/wipe unpublished host commands now.
            commands.close();
            for (_, task) in owned_tasks.0.drain() {
                task.abort();
            }
            while let Ok(command) = commands.try_recv() {
                drop(command);
            }
        }
        let mut blocked_bytes = None;
        let released = session.input_released_local();
        if released != input_released {
            let bytes = std::mem::size_of::<Delivery>();
            if let Some(lease) = ready_lease.take().or_else(|| output.try_reserve(bytes)) {
                input_released = released;
                if !output.publish(Output::InputAcknowledged(released), lease) {
                    return;
                }
            } else {
                blocked_bytes = Some(bytes);
            }
        }
        if let Some(error) = issuance_refused.take() {
            let bytes = output::error_bytes(&error);
            if let Some(lease) = ready_lease.take().or_else(|| output.try_reserve(bytes)) {
                if !output.publish(Output::IssuanceRefused(error), lease) {
                    return;
                }
            } else {
                issuance_refused = Some(error);
                blocked_bytes = Some(bytes);
            }
        }
        while let Some(Action::Close { conn }) = session.poll_close_action(now_ms()) {
            dialing.retain(|pending| *pending != conn);
            carriers.remove(&conn);
            writes.retire(conn);
            owned_tasks.abort(TaskOwner::Dial(conn));
        }
        // A hardware delegate signs for milliseconds: on a blocking thread,
        // while this loop keeps dialing, typing and painting.
        while let Some(request) = session.take_signature_request() {
            let (delegate, tasks) = (Arc::clone(&delegate), tasks.clone());
            let (id, randomness) = (request.id, entropy.array());
            owned_tasks.spawn(TaskOwner::Signature(id), async move {
                let signature = off_reactor(move || {
                    merkur_authorization::sign_session_delegation_proof(
                        &request.proof,
                        &*delegate,
                        randomness,
                    )
                    .ok()
                    .map(Box::new)
                })
                .await
                .flatten();
                let _ = tasks.send(Task::Signed(id, signature)).await;
            });
        }
        while let Some(action) = session.poll_available_io_action() {
            match action {
                Action::RequestIssuance(request) => {
                    let (issuer, tasks) = (Arc::clone(&issuer), tasks.clone());
                    owned_tasks.spawn(TaskOwner::Issuance, async move {
                        let issued = issuer.issue(request).await;
                        let _ = tasks.send(Task::Issued(issued)).await;
                    });
                }
                Action::RequestRenewal(request) => {
                    let (issuer, tasks) = (Arc::clone(&issuer), tasks.clone());
                    owned_tasks.spawn(TaskOwner::Renewal, async move {
                        let renewed = issuer.renew(request).await;
                        let _ = tasks.send(Task::Renewed(renewed)).await;
                    });
                }
                Action::Dial {
                    conn,
                    url,
                    cert_hashes,
                    preface,
                    candidate,
                    ..
                } => {
                    dialing.push(conn);
                    let url = match edge_port {
                        Some(port) => with_port(&url, port),
                        None => Some(url),
                    };
                    let (tasks, carrier_events) = (tasks.clone(), carrier_events.clone());
                    let origin = issuer.origin().to_owned();
                    owned_tasks.spawn(TaskOwner::Dial(conn), async move {
                        let dialed = match url {
                            Some(url) => {
                                Carrier::dial(
                                    conn,
                                    &url,
                                    &cert_hashes,
                                    &preface,
                                    candidate,
                                    &origin,
                                    carrier_events,
                                )
                                .await
                            }
                            None => Err("edge URL has no port to replace".to_string()),
                        };
                        let _ = tasks.send(Task::Dialed(conn, dialed)).await;
                    });
                }
                Action::DialDirect {
                    conn,
                    addr,
                    cert_hash,
                } => {
                    dialing.push(conn);
                    let (tasks, carrier_events) = (tasks.clone(), carrier_events.clone());
                    let origin = issuer.origin().to_owned();
                    owned_tasks.spawn(TaskOwner::Dial(conn), async move {
                        let dialed =
                            Carrier::dial_direct(conn, addr, cert_hash, &origin, carrier_events)
                                .await;
                        let _ = tasks.send(Task::Dialed(conn, dialed)).await;
                    });
                }
                Action::SendReliable {
                    conn,
                    channel,
                    payload,
                } => {
                    if let Some(carrier) = carriers.get_mut(&conn) {
                        session.set_reliable_blocked(now_ms(), conn, channel, true);
                        match carrier.send_reliable(channel, payload) {
                            Ok(completion) => {
                                writes.insert_future(conn, channel, Box::pin(completion.written()))
                            }
                            Err(pending) => writes.insert(conn, channel, pending),
                        }
                    }
                }
                Action::SendInputDatagram {
                    conn,
                    payload,
                    top_seq,
                } => {
                    if carriers
                        .get(&conn)
                        .is_some_and(|carrier| carrier.send_datagram(&payload))
                    {
                        session.handle(
                            now_ms(),
                            Event::InputDatagramSent { conn, top_seq },
                            &mut entropy,
                        );
                    }
                }
                Action::SendDatagram { conn, payload } => {
                    if let Some(carrier) = carriers.get(&conn) {
                        carrier.send_datagram(&payload);
                    }
                }
                Action::SendProof { conn, payload } => {
                    if let Some(carrier) = carriers.get(&conn) {
                        let channel = merkur_wire::protocol::CHANNEL_SIGNALING;
                        session.set_reliable_blocked(now_ms(), conn, channel, true);
                        match carrier.send_proof(payload) {
                            Ok(completion) => {
                                writes.insert_future(conn, channel, Box::pin(completion.written()))
                            }
                            Err(pending) => writes.insert(conn, channel, pending),
                        }
                    }
                }
                Action::Close { conn } => {
                    dialing.retain(|pending| *pending != conn);
                    carriers.remove(&conn);
                    writes.retire(conn);
                    owned_tasks.abort(TaskOwner::Dial(conn));
                }
                _ => unreachable!("poll_io_action returned a host output"),
            }
        }

        if blocked_bytes.is_none() {
            while let Some(action) = session.peek_host_action() {
                let bytes = output::action_bytes(action);
                let Some(lease) = ready_lease.take().or_else(|| output.try_reserve(bytes)) else {
                    blocked_bytes = Some(bytes);
                    break;
                };
                let Some(action) = session.poll_host_action() else {
                    unreachable!("peeked host action");
                };
                let Some(event) = host_output(action) else {
                    unreachable!("host action");
                };
                let closed = matches!(event, Output::Status(Status::Closed(_)));
                if !output.publish(event, lease) || closed {
                    return;
                }
            }
        }

        if session.peek_host_action().is_none() {
            for lease in &mut ingress_leases {
                drop(lease.take());
            }
        }
        let deadline = session
            .next_deadline()
            .map(|at| epoch + std::time::Duration::from_millis(at));
        tokio::select! {
            (conn, channel, admitted) = writes.ready(), if !writes.is_empty() => {
                if carriers.contains_key(&conn) {
                    if admitted { session.set_reliable_blocked(now_ms(), conn, channel, false); }
                    else {
                        carriers.remove(&conn);
                        session.handle(now_ms(), Event::Closed { conn, egress_budget: false }, &mut entropy);
                    }
                }
            }
            Some(event) = inbound.lifecycle.recv() => {
                let (event, _lease) = event.into_parts();
                if let Inbound::Closed { conn, .. } = &event {
                    writes.retire(*conn);
                    owned_tasks.abort(TaskOwner::Dial(*conn));
                }
                deliver(&mut session, Task::Carrier(event), now_ms(), &mut carriers, &mut dialing, &mut issuance_refused, &mut entropy);
            }
            command = commands.input.recv(), if !session.is_closed() => {
                let Some(command) = command else { return; };
                apply_command(&mut session, command, now_ms());
            },
            Some(command) = commands.pulse.recv(), if !session.is_closed() => apply_command(&mut session, command, now_ms()),
            Some(command) = commands.control.recv(), if !session.is_closed() && (!session.is_ready() || session.has_reliable_capacity(merkur_wire::protocol::CHANNEL_CTRL)) => apply_command(&mut session, command, now_ms()),
            Some(event) = inbound.pulse.recv() => {
                // Authentication admits only ACK/heartbeat pulses on these
                // datagram channels. Clock state coalesces within its fence.
                let (event, _lease) = event.into_parts();
                deliver(&mut session, Task::Carrier(event), now_ms(), &mut carriers, &mut dialing, &mut issuance_refused, &mut entropy);
            }
            Some(event) = inbound.control.recv(), if ingress_leases[0].is_none() && (!session.is_ready() || session.has_reliable_capacity(merkur_wire::protocol::CHANNEL_CTRL)) => {
                let (event, lease) = event.into_parts();
                let before = session.host_actions_len();
                deliver(&mut session, Task::Carrier(event), now_ms(), &mut carriers, &mut dialing, &mut issuance_refused, &mut entropy);
                if session.host_actions_len() > before { ingress_leases[0] = Some(lease); }
            }
            Some(event) = inbound.display.recv(), if ingress_leases[1].is_none() => {
                let (event, lease) = event.into_parts();
                let before = session.host_actions_len();
                deliver(&mut session, Task::Carrier(event), now_ms(), &mut carriers, &mut dialing, &mut issuance_refused, &mut entropy);
                if session.host_actions_len() > before { ingress_leases[1] = Some(lease); }
            }
            Some(task) = task_events.recv(), if blocked_bytes.is_none() => {
                owned_tasks.finish(&task);
                deliver(&mut session, task, now_ms(), &mut carriers, &mut dialing, &mut issuance_refused, &mut entropy);
            }
            Some(()) = hints.recv(), if blocked_bytes.is_none() => session.connectivity_hint(now_ms(), &mut entropy),
            lease = wait_output(&output, blocked_bytes), if blocked_bytes.is_some() => {
                let Some(lease) = lease else { return; };
                ready_lease = Some(lease);
            },
            () = sleep_until(deadline) => session.handle_timeout(now_ms(), &mut entropy),
        }
    }
}

fn apply_command(session: &mut Session, delivery: CommandDelivery, now_ms: u64) {
    let (mut command, _lease) = delivery.into_parts();
    match &mut command {
        Command::Input {
            local_seq,
            record,
            modelled,
        } => session.send_input(now_ms, *local_seq, std::mem::take(record), *modelled),
        Command::DisplayAck { payload, durable } => {
            session.send_display_ack(now_ms, payload, *durable)
        }
        Command::SnapshotRequest => session.request_display_snapshot(now_ms),
        Command::OpenUrlAcknowledged(id) => session.acknowledge_open_url(*id),
        Command::ResyncRows { generation, rows } => {
            session.send_display_resync_rows(*generation, rows)
        }
        Command::DictionaryReady(ready) => session.send_display_dictionary_ready(*ready),
        Command::DictionaryAck(id) => session.send_display_dictionary_ack(*id),
        Command::DisplayResume(resume) => session.send_display_resume(now_ms, resume),
        Command::GraphicsDemand { epoch, demands } => {
            session.graphics_demand(*epoch, std::mem::take(demands))
        }
        Command::Viewport { cols, rows, cell } => session.set_viewport(*cols, *rows, *cell),
        Command::Focused(focused) => session.set_focused(*focused),
        Command::TakeGeometry => session.take_geometry(),
    }
}

async fn wait_output(output: &Outputs, bytes: Option<usize>) -> Option<crate::credit::Lease> {
    match bytes {
        Some(bytes) => output.reserve(bytes).await,
        None => std::future::pending().await,
    }
}

fn host_output(action: Action) -> Option<Output> {
    Some(match action {
        Action::Terminal {
            channel,
            datagram,
            payload,
            input,
        } => Output::Terminal {
            channel,
            datagram,
            payload,
            input,
        },
        Action::TerminalUi(effect) => Output::TerminalUi(effect),
        Action::OpenUrl { id, url } => Output::OpenUrl { id, url },
        Action::DisplayFence(fence) => Output::DisplayFence(fence),
        Action::GraphicsAsset {
            epoch,
            key,
            asset,
            bytes,
            ..
        } => Output::GraphicsAsset {
            epoch,
            key,
            asset,
            bytes,
        },
        Action::GeometryState(status) => Output::GeometryState(status),
        Action::GraphicsClock {
            monotonic_us,
            rtt_ms,
        } => Output::GraphicsClock {
            monotonic_us,
            rtt_ms,
        },
        Action::Status(status) => Output::Status(status),
        Action::Path(path) => Output::Path(path),
        Action::ObservedPath(address) => Output::ObservedPath(address),
        Action::Observation(observation) => Output::Observation(observation),
        _ => return None,
    })
}

/// `url` with its authority's port replaced; `None` when it names no port.
fn with_port(url: &str, port: u16) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let (authority, path) = rest.find('/').map_or((rest, ""), |at| rest.split_at(at));
    let (host, current) = authority.rsplit_once(':')?;
    current.parse::<u16>().ok()?;
    Some(format!("{scheme}://{host}:{port}{path}"))
}

/// Runs `work` on a blocking thread; `None` when that thread panicked. The
/// network simulator runs it in place, so its result arrives at a simulated
/// instant rather than whenever a thread finishes.
async fn off_reactor<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    #[cfg(merkur_sim)]
    return Some(work());
    #[cfg(not(merkur_sim))]
    tokio::task::spawn_blocking(work).await.ok()
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn issuance_failure(error: &AccountError) -> Event<'static> {
    if error.authorization_denied() {
        return Event::AuthorizationDenied;
    }
    match error {
        AccountError::Unreachable(_) => Event::IssuanceFailed,
        AccountError::Refused { status: 404, .. } => Event::DaemonUnlinked,
        AccountError::Refused { status, code }
            if matches!(status, 408 | 429 | 500..=599)
                || matches!(
                    code.as_str(),
                    "session_issuance_cancelled"
                        | "session_issuance_conflict"
                        | "session_issuance_expired"
                ) =>
        {
            Event::IssuanceFailed
        }
        _ => Event::Issued(None),
    }
}

fn deliver(
    session: &mut Session,
    task: Task,
    now_ms: u64,
    carriers: &mut HashMap<ConnId, Carrier>,
    dialing: &mut Vec<ConnId>,
    output: &mut Option<AccountError>,
    entropy: &mut OsEntropy,
) {
    match task {
        Task::Issued(Ok(issuance)) => {
            *output = None;
            session.handle(now_ms, Event::Issued(Some(issuance)), entropy)
        }
        Task::Issued(Err(error)) => {
            let event = issuance_failure(&error);
            *output = Some(error);
            session.handle(now_ms, event, entropy);
        }
        Task::Renewed(Err(error)) if error.authorization_denied() => {
            *output = Some(error);
            session.handle(now_ms, Event::AuthorizationDenied, entropy);
        }
        // Other renewal failures end only that renewal; the session decides.
        Task::Renewed(renewed) => session.handle(now_ms, Event::Renewed(renewed.ok()), entropy),
        Task::Signed(id, signature) => session.signed(now_ms, id, signature.as_deref(), entropy),
        Task::Dialed(conn, dialed) => {
            let Some(index) = dialing.iter().position(|pending| *pending == conn) else {
                return;
            };
            dialing.swap_remove(index);
            match dialed {
                Ok(carrier) => {
                    let carrier = carriers.entry(conn).insert_entry(carrier).into_mut();
                    session.handle(now_ms, Event::Connected(conn), entropy);
                    carrier.activate();
                }
                Err(_) => session.handle(now_ms, Event::DialFailed(conn), entropy),
            }
        }
        Task::Carrier(inbound) => {
            let conn = match &inbound {
                Inbound::Splice(conn, _)
                | Inbound::Closed { conn, .. }
                | Inbound::Finite { conn, .. } => *conn,
                Inbound::Reliable { conn, .. }
                | Inbound::Datagram { conn, .. }
                | Inbound::Proof { conn, .. } => *conn,
            };
            // Events from a carrier the session already closed are stale.
            if !carriers.contains_key(&conn) {
                return;
            }
            match inbound {
                Inbound::Splice(conn, event) => {
                    session.handle(now_ms, Event::Splice(conn, event), entropy)
                }
                Inbound::Reliable {
                    conn,
                    source,
                    channel,
                    payload,
                } => session.handle(
                    now_ms,
                    Event::Reliable {
                        conn,
                        source,
                        channel,
                        payload: &payload,
                    },
                    entropy,
                ),
                Inbound::Datagram { conn, payload } => session.handle(
                    now_ms,
                    Event::Datagram {
                        conn,
                        payload: &payload,
                    },
                    entropy,
                ),
                Inbound::Proof { conn, payload } => session.handle(
                    now_ms,
                    Event::Proof {
                        conn,
                        payload: &payload,
                    },
                    entropy,
                ),
                Inbound::Finite { conn, stream, part } => {
                    let part = match &part {
                        Finite::Begin { channel, total } => FinitePart::Begin {
                            channel: *channel,
                            total: *total,
                        },
                        Finite::Data(bytes) => FinitePart::Data(bytes),
                        Finite::End { complete } => FinitePart::End {
                            complete: *complete,
                        },
                    };
                    session.handle(now_ms, Event::Finite { conn, stream, part }, entropy);
                }
                Inbound::Closed {
                    conn,
                    egress_budget,
                } => {
                    carriers.remove(&conn);
                    session.handle(
                        now_ms,
                        Event::Closed {
                            conn,
                            egress_budget,
                        },
                        entropy,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::with_port;
    use super::{AccountError, Event, issuance_failure};

    #[tokio::test]
    async fn pending_writer_polling_keeps_other_writers_live_and_retirement_releases_credit() {
        let credit = crate::credit::Credit::new(2, 8);
        let writing = credit.try_reserve(8).unwrap();
        let waiting_credit = credit.clone();
        let mut pending = super::PendingWrites::default();
        pending.0.insert(
            (merkur_client::session::ConnId(1), 2),
            Box::pin(async move {
                let _lease = waiting_credit.reserve(1).await;
                true
            }),
        );
        {
            let mut ready = Box::pin(pending.ready());
            assert!(futures::poll!(&mut ready).is_pending());
        }
        pending.0.insert(
            (merkur_client::session::ConnId(2), 2),
            Box::pin(async { true }),
        );
        assert_eq!(
            pending.ready().await,
            (merkur_client::session::ConnId(2), 2, true)
        );
        assert!(!pending.is_empty());
        pending.retire(merkur_client::session::ConnId(1));
        assert!(pending.is_empty());
        drop(writing);
        let one = credit.try_reserve(4).unwrap();
        let two = credit.try_reserve(4).unwrap();
        drop((one, two));
    }

    #[test]
    fn issuance_failures_preserve_availability_and_authority_outcomes() {
        for error in [
            AccountError::Unreachable("response stream interrupted".into()),
            AccountError::Refused {
                status: 408,
                code: "request_timeout".into(),
            },
            AccountError::Refused {
                status: 429,
                code: "capacity".into(),
            },
            AccountError::Refused {
                status: 500,
                code: "internal_error".into(),
            },
            AccountError::Refused {
                status: 503,
                code: "daemon_unavailable".into(),
            },
            AccountError::Refused {
                status: 599,
                code: "unavailable".into(),
            },
            AccountError::Refused {
                status: 409,
                code: "session_issuance_cancelled".into(),
            },
            AccountError::Refused {
                status: 409,
                code: "session_issuance_conflict".into(),
            },
            AccountError::Refused {
                status: 409,
                code: "session_issuance_expired".into(),
            },
        ] {
            assert!(
                matches!(issuance_failure(&error), Event::IssuanceFailed),
                "{error:?}"
            );
        }
        for error in [
            AccountError::Invalid("session issuance"),
            AccountError::Refused {
                status: 400,
                code: "invalid_request".into(),
            },
            AccountError::Refused {
                status: 409,
                code: "invalid_contract".into(),
            },
            AccountError::Refused {
                status: 422,
                code: "invalid_request".into(),
            },
        ] {
            assert!(
                matches!(issuance_failure(&error), Event::Issued(None)),
                "{error:?}"
            );
        }
        for status in [401, 403] {
            let error = AccountError::Refused {
                status,
                code: "unauthorized".into(),
            };
            assert!(
                matches!(issuance_failure(&error), Event::AuthorizationDenied),
                "{error:?}"
            );
        }
        let error = AccountError::Refused {
            status: 404,
            code: "device_not_found".into(),
        };
        assert!(matches!(issuance_failure(&error), Event::DaemonUnlinked));
    }

    #[test]
    fn only_final_authorization_refusals_terminate_session_authority() {
        for status in [401, 403] {
            assert!(
                crate::account::AccountError::Refused {
                    status,
                    code: "unauthorized".into()
                }
                .authorization_denied()
            );
        }
        for status in [400, 408, 409, 429, 500, 503] {
            assert!(
                !crate::account::AccountError::Refused {
                    status,
                    code: "unavailable".into()
                }
                .authorization_denied()
            );
        }
        assert!(!crate::account::AccountError::Unreachable("closed".into()).authorization_denied());
        assert!(!crate::account::AccountError::Invalid("response").authorization_denied());
    }

    #[test]
    fn only_the_port_of_the_edge_url_is_replaced() {
        assert_eq!(
            with_port("https://[::1]:4433", 14435).as_deref(),
            Some("https://[::1]:14435")
        );
        assert_eq!(
            with_port("https://edge.merkur.example:443/wt", 8443).as_deref(),
            Some("https://edge.merkur.example:8443/wt")
        );
        assert_eq!(with_port("https://edge.merkur.example/wt", 8443), None);
        assert_eq!(with_port("https://[::1]", 8443), None);
    }
}
