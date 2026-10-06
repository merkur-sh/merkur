//! The outage scenario the recovery and fault tests share, and the invariants
//! every recovery must hold.
//!
//! A client connects, types, and is cut off from the edge for a while. At the
//! repair a fault may strike the recovery itself; the client keeps typing
//! through it. Then the invariants: it recovers within one retry ceiling and
//! one attempt of the network healing, every key reaches the program exactly
//! once and in order, it presents the daemon's grid, and a session is
//! retracted only when a fresh issuance superseded it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::Summary;
use crate::client;
use crate::faults;
use crate::oracle;
use crate::server::EDGE_HOST;
use crate::shell::{PROMPT, Transcript};
use crate::world::{self, World};

pub const LATENCY: Duration = Duration::from_millis(15);
pub const CLIENT_HOST: &str = "browser";
/// The client core's recovery retries back off to this ceiling with full
/// jitter (`RECONNECT_CEIL_MS` in `packages/merkur-client/src/session.rs`), so
/// after a long outage the next attempt can start this long after the network
/// heals.
pub const RECONNECT_CEIL: Duration = Duration::from_secs(5);
/// One attempt's exchanges at most: issuance, three dials and the three
/// authentication flights, each a few relay round trips of `4 * LATENCY`.
pub const ATTEMPT: Duration = Duration::from_secs(1);
/// The longest an attempt waits for an answer before the client abandons it
/// (`AUTH_PHASE_WATCHDOG_MS` in `packages/merkur-client/src/session.rs`). An
/// attempt in flight when an outage heals may be backing off through it, so
/// this bounds how long the outage can still hold that attempt after the heal.
pub const ATTEMPT_WATCHDOG: Duration = Duration::from_secs(10);
/// What the client types, before the outage and once it begins to heal, as
/// the daemon encodes it for the PTY.
pub const TYPED: &[u8] = b"before after";

/// Which way an outage cuts the link between the client and the edge.
#[derive(Clone, Copy, Debug)]
pub enum Direction {
    Both,
    /// The client's datagrams are lost; the edge's still arrive.
    Uplink,
    /// The edge's datagrams are lost; the client's still arrive.
    Downlink,
}

impl Direction {
    fn cut(self) {
        match self {
            Self::Both => turmoil::partition(CLIENT_HOST, EDGE_HOST),
            Self::Uplink => turmoil::partition_oneway(CLIENT_HOST, EDGE_HOST),
            Self::Downlink => turmoil::partition_oneway(EDGE_HOST, CLIENT_HOST),
        }
    }

    fn repair(self) {
        match self {
            Self::Both => turmoil::repair(CLIENT_HOST, EDGE_HOST),
            Self::Uplink => turmoil::repair_oneway(CLIENT_HOST, EDGE_HOST),
            Self::Downlink => turmoil::repair_oneway(EDGE_HOST, CLIENT_HOST),
        }
    }
}

/// What strikes as the outage ends.
#[derive(Clone, Copy, Debug)]
pub enum AtRepair {
    Nothing,
    /// Count the datagrams the client sends until it recovers.
    Count,
    /// The client's datagrams after its `after`-th are lost for `hold`.
    Cut {
        after: u64,
        hold: Duration,
    },
}

#[derive(Debug, Default, Clone)]
pub struct Recovered {
    /// Simulated time from the network healing to the client's grid showing
    /// what was typed once the outage ended.
    pub after_heal: Option<Duration>,
    pub issued: u64,
    /// Sessions the server retracted because a fresh issuance superseded them.
    pub cancelled: u64,
    /// Capabilities the server renewed.
    pub renewed: u64,
    pub statuses: Vec<String>,
    pub rows: Vec<String>,
    /// Every byte the daemon's terminal wrote to its program.
    pub input: Vec<u8>,
    /// The daemon's screen, rebuilt from what its program wrote.
    pub daemon_rows: Vec<String>,
    /// Datagrams the exchange under test sent, when counted: from the repair
    /// until the recovery, or from the start until the prompt.
    pub counted: u64,
}

pub fn outage(seed: u64, partition: Duration, at_repair: AtRepair) -> (Summary, Recovered) {
    outage_in(seed, Direction::Both, partition, at_repair)
}

/// An outage that cuts the link in `direction` for `partition`.
pub fn outage_in(
    seed: u64,
    direction: Direction,
    partition: Duration,
    at_repair: AtRepair,
) -> (Summary, Recovered) {
    outage_with(seed, direction, 0, partition, at_repair)
}

/// An outage that follows `rotations` in-place rotations of the edge's
/// certificate, each a rotation period apart in production; the session's
/// tunnels and incumbent carrier ride through them on their established
/// connections.
pub fn outage_after_rotations(
    seed: u64,
    rotations: usize,
    partition: Duration,
) -> (Summary, Recovered) {
    outage_with(seed, Direction::Both, rotations, partition, AtRepair::Nothing)
}

/// Long enough for the edge to reload a rotated certificate and register it.
const ROTATION_SETTLE: Duration = Duration::from_secs(1);

fn outage_with(
    seed: u64,
    direction: Direction,
    rotations: usize,
    partition: Duration,
    at_repair: AtRepair,
) -> (Summary, Recovered) {
    crate::run(seed, move || {
        let mut world = World::new(seed, LATENCY, partition + Duration::from_secs(120));
        let transcript = world.transcript.clone();
        let recovered = Arc::new(Mutex::new(Recovered::default()));
        let server = world.server();
        let rotator = world.edge_rotator();
        let observed = Arc::clone(&recovered);
        world.client(CLIENT_HOST, async move {
            let mut client = world::connect(&server, true).await;
            client
                .until(|presented| client::shows(presented, PROMPT.trim_end()))
                .await;
            client.type_text("before");
            client
                .until(|presented| client::shows(presented, "$ before"))
                .await;

            if rotations > 0 {
                for _ in 0..rotations {
                    rotator.rotate();
                }
                tokio::time::sleep(ROTATION_SETTLE).await;
            }
            direction.cut();
            tokio::time::sleep(partition).await;
            direction.repair();
            client.type_text(" after");
            match at_repair {
                AtRepair::Nothing => {}
                AtRepair::Count => faults::count(CLIENT_HOST),
                AtRepair::Cut { after, hold } => {
                    faults::cut_after(CLIENT_HOST, after);
                    tokio::time::sleep(hold).await;
                    faults::restore();
                }
            }
            let healed = tokio::time::Instant::now();
            let wait = client.until(|presented| client::shows(presented, "$ before after"));
            let presented = tokio::time::timeout(Duration::from_secs(90), wait).await;
            let state = client.presented();
            *observed.lock().expect("recovered") = Recovered {
                after_heal: presented.is_ok().then(|| healed.elapsed()),
                issued: server.issued(),
                cancelled: server.cancelled(),
                renewed: server.renewed(),
                statuses: state.statuses,
                rows: state.rows,
                counted: faults::counted(),
                ..Recovered::default()
            };
            client.close().await;
            Ok(())
        });
        settle(world, &transcript, &recovered)
    })
}

/// A first connection with `at_start` striking from the client's first
/// datagram on: [`AtRepair::Count`] counts the datagrams it sends until its
/// prompt shows, and [`AtRepair::Cut`] loses its datagrams after the `after`-th
/// for `hold`. Once connected it types [`TYPED`], and every recovery invariant
/// holds from the moment the fault ends.
pub fn first_connect(seed: u64, at_start: AtRepair) -> (Summary, Recovered) {
    crate::run(seed, move || {
        let mut world = World::new(seed, LATENCY, Duration::from_secs(120));
        let transcript = world.transcript.clone();
        let recovered = Arc::new(Mutex::new(Recovered::default()));
        let server = world.server();
        let observed = Arc::clone(&recovered);
        world.client(CLIENT_HOST, async move {
            server.edge_ready().await;
            // Armed before the driver it spawns sends anything.
            match at_start {
                AtRepair::Nothing => {}
                AtRepair::Count => faults::count(CLIENT_HOST),
                AtRepair::Cut { after, .. } => faults::cut_after(CLIENT_HOST, after),
            }
            let mut client = world::connect(&server, true).await;
            if let AtRepair::Cut { hold, .. } = at_start {
                tokio::time::sleep(hold).await;
                faults::restore();
            }
            let healed = tokio::time::Instant::now();
            let prompt = client.until(|presented| client::shows(presented, PROMPT.trim_end()));
            let connected = tokio::time::timeout(Duration::from_secs(90), prompt).await;
            let counted = faults::counted();
            client.type_text(std::str::from_utf8(TYPED).expect("typed text"));
            let wait = client.until(|presented| client::shows(presented, "$ before after"));
            let presented = tokio::time::timeout(Duration::from_secs(30), wait).await;
            let state = client.presented();
            *observed.lock().expect("recovered") = Recovered {
                after_heal: (connected.is_ok() && presented.is_ok()).then(|| healed.elapsed()),
                issued: server.issued(),
                cancelled: server.cancelled(),
                statuses: state.statuses,
                rows: state.rows,
                counted,
                ..Recovered::default()
            };
            client.close().await;
            Ok(())
        });
        settle(world, &transcript, &recovered)
    })
}

/// Runs the simulation to its end and completes what the client observed with
/// what the daemon's program received and showed.
fn settle(
    mut world: World<'_>,
    transcript: &Transcript,
    recovered: &Mutex<Recovered>,
) -> Recovered {
    world.sim.run().expect("the simulation completes");
    let mut recovered = recovered.lock().expect("recovered").clone();
    let transcript = transcript.read();
    recovered.input = transcript.input;
    recovered.daemon_rows = oracle::screen(&transcript.output, client::COLS, client::ROWS);
    recovered
}

/// Waits until every key in `typed` reached the program and the client
/// presents the program's screen: the convergence a scenario ends on.
pub async fn converged(client: &mut client::Client, transcript: &Transcript, typed: &[u8]) {
    client
        .until(|presented| {
            let transcribed = transcript.read();
            transcribed.input == typed
                && presented.rows == oracle::screen(&transcribed.output, client::COLS, client::ROWS)
        })
        .await;
}

/// The invariants every recovery holds. `blackout` is how long the network
/// silently dropped an attempt already in flight: its QUIC handshake backs off
/// exponentially through the loss, so its next retransmission can come up to
/// that long after the network heals, and nothing announces a silent heal.
pub fn assert_recovered(recovered: &Recovered, blackout: Duration) {
    let after_heal = recovered.after_heal.expect("the client recovers");
    assert!(
        after_heal <= RECONNECT_CEIL + blackout + ATTEMPT,
        "recovered {after_heal:?} after the network healed: {recovered:?}"
    );
    assert_eq!(
        String::from_utf8_lossy(&recovered.input),
        String::from_utf8_lossy(TYPED),
        "input reaches the PTY exactly once, in order: {recovered:?}"
    );
    assert_eq!(
        recovered.rows, recovered.daemon_rows,
        "the client presents the daemon's grid"
    );
    assert_eq!(
        recovered.cancelled,
        recovered.issued - 1,
        "only a superseded session is cancelled: {recovered:?}"
    );
}

pub fn report(name: &str, summary: &Summary, recovered: &Recovered) {
    eprintln!(
        "{name}: {summary:?} after heal {:?}, issued {}, cancelled {}\nstatuses {:?}\n{}",
        recovered.after_heal,
        recovered.issued,
        recovered.cancelled,
        recovered.statuses,
        recovered.rows.join("\n").trim_end()
    );
}
