//! A session outlives its capability. The server signs session capabilities
//! for 5 minutes; the client renews at half the stated lifetime through the
//! renewal route and the daemon's lineage proof, all on simulated wall time,
//! so a session typed into for seven minutes never re-issues and never leaves
//! `Ready`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use merkur_sim::client;
use merkur_sim::oracle;
use merkur_sim::scenario::{CLIENT_HOST, LATENCY};
use merkur_sim::shell::PROMPT;
use merkur_sim::world::{self, World};

#[derive(Debug, Default, Clone)]
struct Lived {
    typed: String,
    shown: bool,
    issued: u64,
    renewed: u64,
    statuses: Vec<String>,
    rows: Vec<String>,
    input: Vec<u8>,
    daemon_rows: Vec<String>,
}

#[test]
fn a_session_renews_past_its_capability_and_stays_ready() {
    const MINUTES: u32 = 7;
    let (summary, lived) = merkur_sim::run(51, move || {
        let mut world = World::new(51, LATENCY, Duration::from_secs(60 * 10));
        let transcript = world.transcript.clone();
        let lived = Arc::new(Mutex::new(Lived::default()));
        let server = world.server();
        let observed = Arc::clone(&lived);
        world.client(CLIENT_HOST, async move {
            let mut client = world::connect(&server, true).await;
            client
                .until(|presented| client::shows(presented, PROMPT.trim_end()))
                .await;
            let mut typed = String::new();
            for minute in 0..MINUTES {
                let key = char::from(b'a' + minute as u8);
                typed.push(key);
                client.type_text(&key.to_string());
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            let expected = format!("{}{typed}", PROMPT);
            let wait = client.until(|presented| client::shows(presented, &expected));
            let shown = tokio::time::timeout(Duration::from_secs(10), wait)
                .await
                .is_ok();
            let state = client.presented();
            *observed.lock().expect("lived") = Lived {
                typed,
                shown,
                issued: server.issued(),
                renewed: server.renewed(),
                statuses: state.statuses,
                rows: state.rows,
                ..Lived::default()
            };
            client.close().await;
            Ok(())
        });
        world.sim.run().expect("the simulation completes");
        let mut lived = lived.lock().expect("lived").clone();
        let transcript = transcript.read();
        lived.input = transcript.input;
        lived.daemon_rows = oracle::screen(&transcript.output, client::COLS, client::ROWS);
        lived
    });
    eprintln!("seven minutes: {summary:?} {lived:?}");
    assert!(lived.shown, "every key shows: {lived:?}");
    assert_eq!(lived.issued, 1, "renewal keeps the session it renews");
    assert!(
        lived.renewed >= 2,
        "a capability renews at half its 5 minute lifetime: {lived:?}"
    );
    assert_eq!(
        lived.statuses,
        ["Connecting", "Authenticating", "Ready"],
        "the session never left Ready"
    );
    assert_eq!(lived.input, lived.typed.as_bytes());
    assert_eq!(lived.rows, lived.daemon_rows);
}
