//! A client host, as `merkur-tui headless` runs one: the session core under the
//! native driver, and a viewer applying the daemon's display to a grid it never
//! draws, presented as a 60 Hz display would. Presenting is what keeps the
//! daemon's display grants flowing. A scenario types into it and reads what it
//! presents.

use std::sync::Arc;

use merkur_client::session::graphics::GraphicsAsset;
use merkur_client::session::{Config, Session, Status};
use merkur_client::uuid_v4;
use merkur_client::viewer::{self, Viewer};
use merkur_client_native::driver::{self, Command, OsEntropy, Output};
use merkur_client_native::grid::NativeGrid;
use merkur_wire::input_record::{build, keys};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::server::{Account, DAEMON_ID, Server};

const PRESENT_PERIOD_NS: u64 = 1_000_000_000 / 60;
pub const COLS: u16 = 80;
pub const ROWS: u16 = 24;
const CELL_WIDTH: f64 = 10.0;
const CELL_HEIGHT: f64 = 20.0;

/// One key press.
#[derive(Clone, Copy, Debug)]
pub enum Key {
    Char(char),
    Enter,
}

/// What the client presents, and what its session last said about itself.
#[derive(Clone, Debug, Default)]
pub struct Presented {
    pub rows: Vec<String>,
    pub frames: u64,
    pub snapshots: u64,
    /// Every status the session reported, in order.
    pub statuses: Vec<String>,
    pub issuance_refusals: u64,
    pub closed: bool,
}

pub struct Client {
    browser_node_id: String,
    keys: mpsc::UnboundedSender<Key>,
    presented: watch::Receiver<Presented>,
    task: JoinHandle<()>,
}

impl Client {
    /// Connects a fresh client of `account` to the simulated daemon through
    /// `server`, on the current host.
    pub fn connect(server: Arc<Server>, account: &Account, relay_only: bool) -> Self {
        let browser_node_id = uuid_v4(&mut OsEntropy);
        Self::connect_as(server, account, relay_only, browser_node_id)
    }

    /// Connects as the client node `browser_node_id`, as a client that kept its
    /// node identity across a restart does.
    pub fn connect_as(
        server: Arc<Server>,
        account: &Account,
        relay_only: bool,
        browser_node_id: String,
    ) -> Self {
        let session = Session::new(
            Config {
                browser_node_id: browser_node_id.clone(),
                relay_only,
            },
            account.delegation(),
        );
        let (commands, session_commands) = driver::Commands::channel();
        let _ = commands.send(Command::Focused(true));
        let _ = commands.send(Command::Viewport {
            cols: COLS,
            rows: ROWS,
            cell: Some((CELL_WIDTH, CELL_HEIGHT)),
        });
        let (outputs, output) = driver::Outputs::channel();
        let delegate = account.delegate();
        tokio::spawn(async move {
            driver::run(
                session,
                DAEMON_ID,
                server,
                delegate,
                None,
                session_commands,
                outputs,
            )
            .await;
        });
        let (keys, key_input) = mpsc::unbounded_channel();
        let (presented_tx, presented) = watch::channel(Presented::default());
        // The viewer is not `Send`; turmoil runs every host on a `LocalSet`.
        let task = tokio::task::spawn_local(present(commands, output, key_input, presented_tx));
        Self {
            browser_node_id,
            keys,
            presented,
            task,
        }
    }

    pub fn browser_node_id(&self) -> &str {
        &self.browser_node_id
    }

    pub fn type_text(&self, text: &str) {
        for key in text.chars() {
            let _ = self.keys.send(Key::Char(key));
        }
    }

    pub fn press(&self, key: Key) {
        let _ = self.keys.send(key);
    }

    pub fn presented(&self) -> Presented {
        self.presented.borrow().clone()
    }

    /// Waits until what the client presents satisfies `done`.
    pub async fn until(&mut self, done: impl Fn(&Presented) -> bool) -> Presented {
        let presented = self
            .presented
            .wait_for(|presented| done(presented))
            .await
            .expect("the client presents until it closes");
        presented.clone()
    }

    /// Ends the session: the viewer drops its commands, which ends the driver.
    pub async fn close(self) {
        drop(self.keys);
        let _ = self.task.await;
    }
}

/// Whether any presented row contains `text`.
pub fn shows(presented: &Presented, text: &str) -> bool {
    presented.rows.iter().any(|row| row.contains(text))
}

async fn present(
    commands: driver::Commands,
    mut output: mpsc::UnboundedReceiver<driver::Delivery>,
    mut key_input: mpsc::UnboundedReceiver<Key>,
    presented: watch::Sender<Presented>,
) {
    let epoch = Instant::now();
    let now_ns = || epoch.elapsed().as_nanos() as u64;
    let now_ms = || ms(now_ns());
    let mut viewer = Viewer::new(NativeGrid::new(COLS, ROWS));
    viewer.set_cell_size(now_ms(), CELL_WIDTH, CELL_HEIGHT);
    let mut frame_owed = false;
    let mut commands = Some(commands);
    let mut local_seq = 0u32;
    let mut state = Presented::default();
    loop {
        let wake = next_wake(&viewer, frame_owed, now_ns())
            .map(|at_ns| epoch + std::time::Duration::from_nanos(at_ns));
        tokio::select! {
            key = key_input.recv(), if commands.is_some() => match key {
                Some(key) => {
                    let record = match key {
                        Key::Char(key) => build::press(key),
                        Key::Enter => build::functional(keys::ENTER, 0, 0),
                    };
                    local_seq += 1;
                    let modelled = viewer.input(now_ms(), local_seq, &record);
                    if let Some(commands) = &commands {
                        let _ = commands.send(Command::Input { local_seq, record, modelled });
                    }
                }
                None => commands = None,
            },
            delivery = output.recv() => {
                let Some(delivery) = delivery else {
                    break;
                };
                let (event, _lease) = delivery.into_parts();
                match event {
                    Output::Status(status) => {
                        let closed = matches!(status, Status::Closed(_));
                        state.statuses.push(format!("{status:?}"));
                        if closed {
                            break;
                        }
                    }
                    Output::IssuanceRefused(_) => state.issuance_refusals += 1,
                    Output::OpenUrl { id, .. } => {
                        if let Some(commands) = &commands {
                            let _ = commands.send(Command::OpenUrlAcknowledged(id));
                        }
                    }
                    Output::DisplayFence(fence) => viewer.fence(now_ms(), fence),
                    Output::GraphicsAsset { epoch, key, asset, bytes } => match asset {
                        GraphicsAsset::Tile => viewer.set_graphics_resident(now_ms(), epoch, &key, true),
                        GraphicsAsset::Animation => viewer.graphics_manifest(now_ms(), epoch, &key, bytes),
                    },
                    Output::GraphicsClock { monotonic_us, rtt_ms } => {
                        viewer.graphics_clock(now_ms(), monotonic_us, rtt_ms as f64);
                    }
                    Output::Terminal { channel, payload, input, .. } => {
                        let before = viewer.stats().frames;
                        let now = now_ms();
                        viewer.receive(now, channel, &payload, input);
                        viewer.present_now(now);
                        frame_owed |= viewer.stats().frames != before;
                    }
                    Output::InputAcknowledged(_)
                    | Output::TerminalUi(_)
                    | Output::ObservedPath(_)
                    | Output::Observation(_)
                    | Output::Path(_)
                    | Output::GeometryState(_) => {}
                }
            },
            () = sleep_until(wake) => {
                let now_ns = now_ns();
                let now = ms(now_ns);
                viewer.handle_timeout(now);
                viewer.present_now(now);
                if frame_owed || viewer.wants_frame(true) {
                    let frame_ms = ms(now_ns / PRESENT_PERIOD_NS * PRESENT_PERIOD_NS);
                    viewer.frame(frame_ms, ms(PRESENT_PERIOD_NS), true, None);
                    frame_owed = false;
                }
            }
        }
        while let Some(message) = viewer.poll_output(now_ms()) {
            let command = match message {
                viewer::Output::Ack { payload, durable } => {
                    Command::DisplayAck { payload, durable }
                }
                viewer::Output::SnapshotRequest => Command::SnapshotRequest,
                viewer::Output::ResyncRows { generation, rows } => {
                    Command::ResyncRows { generation, rows }
                }
                viewer::Output::DictionaryReady(ready) => Command::DictionaryReady(ready),
                viewer::Output::DictionaryAck(id) => Command::DictionaryAck(id),
                viewer::Output::GraphicsDemand { epoch, demands } => {
                    Command::GraphicsDemand { epoch, demands }
                }
                viewer::Output::Resume(resume) => Command::DisplayResume(resume),
            };
            if let Some(commands) = &commands {
                let _ = commands.send(command);
            }
        }
        let stats = viewer.stats();
        state.rows = viewer.grid().screen();
        state.frames = stats.frames;
        state.snapshots = stats.snapshots;
        presented.send_replace(state.clone());
    }
    state.closed = true;
    presented.send_replace(state);
}

fn ms(ns: u64) -> f64 {
    ns as f64 / 1e6
}

/// When the presenter next wakes, in nanoseconds since its epoch: the next
/// frame boundary while a frame is wanted, or the viewer's deadline, rounded
/// up so the viewer sees it reached. Integer nanoseconds put every frame
/// boundary strictly after `now_ns`; in floating point one could land on it,
/// and a wake that never passes the simulated clock never lets it advance.
fn next_wake(viewer: &Viewer<NativeGrid>, frame_owed: bool, now_ns: u64) -> Option<u64> {
    let frame = (frame_owed || viewer.wants_frame(true))
        .then(|| (now_ns / PRESENT_PERIOD_NS + 1) * PRESENT_PERIOD_NS);
    let deadline = viewer
        .next_deadline()
        .map(|at_ms| (at_ms * 1e6).ceil() as u64 + 1);
    match (frame, deadline) {
        (Some(frame), Some(deadline)) => Some(frame.min(deadline)),
        (frame, deadline) => frame.or(deadline),
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
