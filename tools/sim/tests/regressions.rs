//! Production incidents as scenarios, each asserting the fact the incident
//! broke. A regression's scenario must fail with its fix reverted; the ledger
//! records each such negative control.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use merkur_sim::client::{self, Client, Key};
use merkur_sim::oracle;
use merkur_sim::scenario::{ATTEMPT, CLIENT_HOST, LATENCY};
use merkur_sim::server::EDGE_HOST;
use merkur_sim::shell::{FLOOD, PROMPT, flood_tail};
use merkur_sim::world::{self, World};

#[derive(Debug, Default, Clone)]
struct Returned {
    /// Simulated time from the returning client's connect to its grid showing
    /// the session's screen.
    to_screen: Option<Duration>,
    issued: u64,
    rows: Vec<String>,
    daemon_rows: Vec<String>,
}

/// 2026-09-30: a phone back from the background re-authenticates in full
/// while the daemon still holds its peer live inside the rebind window. The
/// daemon spliced that live peer without a carrier boundary; the old carrier's
/// blocks held the display, and the snapshot it owed went unsent for 8 s.
///
/// Here the phone sleeps while a burst is in flight on the relay. The
/// incident's trigger was the dead *direct* connection's block, which a
/// relay-only simulation cannot create: with the splice's carrier boundary
/// reverted, this scenario still passes (the ledger records that control). It
/// guards the invariant, a returning client's screen within an attempt, until
/// the direct path joins the simulator.
fn returning_client(seed: u64) -> Returned {
    let (_, returned) = merkur_sim::run(seed, move || {
        let mut world = World::new(seed, LATENCY, Duration::from_secs(120));
        let transcript = world.transcript.clone();
        let returned = Arc::new(Mutex::new(Returned::default()));
        let server = world.server();
        let observed = Arc::clone(&returned);
        world.client(CLIENT_HOST, async move {
            let mut first = world::connect(&server, true).await;
            first
                .until(|presented| client::shows(presented, PROMPT.trim_end()))
                .await;
            // A burst the display is still delivering when the phone sleeps:
            // preparation, rows and repairs in flight on carriers about to die.
            first.type_text(FLOOD);
            first
                .until(|presented| client::shows(presented, &format!("{PROMPT}{FLOOD}")))
                .await;
            first.press(Key::Enter);
            // Enter reaches the program two links away; the burst's first
            // frames are then one link out of the daemon.
            tokio::time::sleep(3 * LATENCY).await;
            // The phone sleeps: its carriers die unannounced, and its process
            // is gone by the time it returns, inside the daemon's rebind window.
            turmoil::partition(CLIENT_HOST, EDGE_HOST);
            let node = first.browser_node_id().to_owned();
            first.close().await;
            tokio::time::sleep(Duration::from_secs(20)).await;
            turmoil::repair(CLIENT_HOST, EDGE_HOST);

            let connected = tokio::time::Instant::now();
            server.edge_ready().await;
            let mut back = Client::connect_as(Arc::clone(&server), server.account(), true, node);
            let tail = flood_tail();
            let wait = back.until(|presented| {
                client::shows(presented, &tail)
                    && presented
                        .rows
                        .last()
                        .is_some_and(|row| row == PROMPT.trim_end())
            });
            let shown = tokio::time::timeout(Duration::from_secs(30), wait).await;
            *observed.lock().expect("returned") = Returned {
                to_screen: shown.is_ok().then(|| connected.elapsed()),
                issued: server.issued(),
                rows: back.presented().rows,
                daemon_rows: Vec::new(),
            };
            back.close().await;
            Ok(())
        });
        world.sim.run().expect("the simulation completes");
        let mut returned = returned.lock().expect("returned").clone();
        returned.daemon_rows =
            oracle::screen(&transcript.read().output, client::COLS, client::ROWS);
        returned
    });
    returned
}

#[derive(Debug, Default, Clone)]
struct Hinted {
    /// Simulated time from the last hint to the client's grid showing what
    /// was typed after it.
    after_hints: Option<Duration>,
    issued: u64,
    cancelled: u64,
    statuses: Vec<String>,
    rows: Vec<String>,
    input: Vec<u8>,
    daemon_rows: Vec<String>,
    /// Rebind outcomes the daemon reported.
    rebinds: usize,
    /// Endpoints the client dialed: three lanes per authentication, plus one
    /// candidate per hint the session acted on.
    dials: u64,
}

/// Path hints arrive while the client is up, or while it recovers from an
/// outage of `outage`: `hints` of them, `spacing` apart, starting at the
/// repair (or at once, with no outage).
fn hinted(seed: u64, outage: Option<Duration>, hints: u32, spacing: Duration) -> Hinted {
    let (_, hinted) = merkur_sim::run(seed, move || {
        let mut world = World::new(seed, LATENCY, Duration::from_secs(240));
        let transcript = world.transcript.clone();
        let events = world.events.clone();
        let hinted = Arc::new(Mutex::new(Hinted::default()));
        let server = world.server();
        let observed = Arc::clone(&hinted);
        world.client(CLIENT_HOST, async move {
            let mut client = world::connect(&server, true).await;
            client
                .until(|presented| client::shows(presented, PROMPT.trim_end()))
                .await;
            client.type_text("before");
            client
                .until(|presented| client::shows(presented, "$ before"))
                .await;
            if let Some(outage) = outage {
                turmoil::partition(CLIENT_HOST, EDGE_HOST);
                tokio::time::sleep(outage).await;
                turmoil::repair(CLIENT_HOST, EDGE_HOST);
            }
            client.type_text(" after");
            for _ in 0..hints {
                merkur_client_native::network_changed();
                tokio::time::sleep(spacing).await;
            }
            let hinted_until = tokio::time::Instant::now();
            let wait = client.until(|presented| client::shows(presented, "$ before after"));
            let shown = tokio::time::timeout(Duration::from_secs(60), wait).await;
            let state = client.presented();
            *observed.lock().expect("hinted") = Hinted {
                after_hints: shown.is_ok().then(|| hinted_until.elapsed()),
                issued: server.issued(),
                cancelled: server.cancelled(),
                statuses: state.statuses,
                rows: state.rows,
                dials: merkur_sim::hosts::binds(CLIENT_HOST),
                ..Hinted::default()
            };
            client.close().await;
            Ok(())
        });
        world.sim.run().expect("the simulation completes");
        let mut hinted = hinted.lock().expect("hinted").clone();
        hinted.rebinds = events.count(merkur_dataplane::sim::event::SESSION_REBIND);
        let transcript = transcript.read();
        hinted.input = transcript.input;
        hinted.daemon_rows = oracle::screen(&transcript.output, client::COLS, client::ROWS);
        hinted
    });
    hinted
}

/// 2026-09-21: the page's `online`/`visibilitychange` handlers cancelled the
/// live issuance once a first re-issuance had armed them, and every later
/// event destroyed a healthy session for a full re-issuance. In the client
/// core a hint adds a probe and races a candidate; the incumbent serves on.
#[test]
fn path_hints_never_cancel_or_reissue_a_healthy_session() {
    let hinted = hinted(42, None, 10, Duration::from_millis(500));
    eprintln!("2026-09-21: {hinted:?}");
    assert!(hinted.after_hints.is_some(), "{hinted:?}");
    assert!(hinted.dials > 3, "the hints raced candidates: {hinted:?}");
    assert_eq!(hinted.issued, 1, "no hint re-issues a healthy session");
    assert_eq!(hinted.cancelled, 0, "no hint cancels a healthy session");
    assert_eq!(
        hinted.statuses,
        ["Connecting", "Authenticating", "Ready"],
        "the session never left Ready"
    );
    assert_eq!(hinted.input, b"before after");
    assert_eq!(hinted.rows, hinted.daemon_rows);
}

/// 2026-09-23: hints restarted the recovery attempt in flight, and 22
/// issuances in 43 s never reached `session_auth`. A hint must never
/// interrupt an attempt: past the rebind window, one fresh issuance recovers
/// however many hints arrive while it runs.
#[test]
fn path_hints_during_recovery_never_restart_the_attempt() {
    let hinted = hinted(
        43,
        Some(Duration::from_secs(75)),
        20,
        Duration::from_millis(300),
    );
    eprintln!("2026-09-23: {hinted:?}");
    assert!(hinted.after_hints.is_some(), "{hinted:?}");
    assert_eq!(hinted.issued, 2, "exactly one fresh issuance");
    assert_eq!(
        hinted.cancelled, 1,
        "only the superseded session is cancelled"
    );
    assert_eq!(hinted.input, b"before after");
    assert_eq!(hinted.rows, hinted.daemon_rows);
}

#[test]
fn a_client_that_reauthenticates_while_its_peer_is_held_gets_its_screen() {
    let returned = returning_client(41);
    eprintln!("2026-09-30: {returned:?}");
    let to_screen = returned
        .to_screen
        .expect("the returning client shows its screen");
    assert!(
        to_screen <= ATTEMPT,
        "the screen took {to_screen:?}: the snapshot a re-authentication owes waited"
    );
    assert_eq!(returned.issued, 2, "the return is a full issuance");
    assert_eq!(returned.rows, returned.daemon_rows);
}
