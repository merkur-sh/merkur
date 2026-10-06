//! The link misbehaving in ways other than a clean two-way cut: one direction
//! lost while the other still delivers, a link that loses and reorders, and a
//! NAT that maps the client to a new port under a live session.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use merkur_sim::client::{self, Key};
use merkur_sim::faults;
use merkur_sim::scenario::{
    self, AtRepair, CLIENT_HOST, Direction, LATENCY, assert_recovered, converged, report,
};
use merkur_sim::shell::PROMPT;
use merkur_sim::world::{self, Network, World};

fn one_way(direction: Direction, seeds: [u64; 2]) {
    for (seed, outage) in seeds.into_iter().zip([10, 75]) {
        let partition = Duration::from_secs(outage);
        let (summary, recovered) =
            scenario::outage_in(seed, direction, partition, AtRepair::Nothing);
        report(&format!("{direction:?} {outage} s"), &summary, &recovered);
        assert_recovered(&recovered, Duration::ZERO);
    }
}

#[test]
fn an_outage_of_the_uplink_alone_recovers() {
    one_way(Direction::Uplink, [61, 62]);
}

#[test]
fn an_outage_of_the_downlink_alone_recovers() {
    one_way(Direction::Downlink, [63, 64]);
}

#[derive(Debug, Default, Clone)]
struct Rebound {
    /// Simulated time from the rebinding to the client presenting what was
    /// typed after it.
    converged: Option<Duration>,
    issued: u64,
    cancelled: u64,
    statuses: Vec<String>,
}

/// The client's NAT drops its mapping while the session idles, and the client
/// types on: its next datagrams reach the edge from a new port, and what the
/// edge sends to the old one is lost. The edge must follow the connection to
/// its new address, so the session keeps its carrier and its issuance.
#[test]
fn a_nat_rebinding_keeps_the_session_and_its_carrier() {
    let (summary, rebound) = merkur_sim::run(66, || {
        let mut world = World::new(66, LATENCY, Duration::from_secs(120));
        let transcript = world.transcript.clone();
        let rebound = Arc::new(Mutex::new(Rebound::default()));
        let server = world.server();
        let observed = Arc::clone(&rebound);
        world.client(CLIENT_HOST, async move {
            let mut client = world::connect(&server, true).await;
            client
                .until(|presented| client::shows(presented, PROMPT.trim_end()))
                .await;
            client.type_text("before");
            client
                .until(|presented| client::shows(presented, "$ before"))
                .await;
            tokio::time::sleep(Duration::from_secs(1)).await;
            faults::rebind_nat(CLIENT_HOST);
            let rebinding = tokio::time::Instant::now();
            client.type_text(" after");
            let wait = converged(&mut client, &transcript, b"before after");
            let done = tokio::time::timeout(Duration::from_secs(60), wait).await;
            *observed.lock().expect("rebound") = Rebound {
                converged: done.is_ok().then(|| rebinding.elapsed()),
                issued: server.issued(),
                cancelled: server.cancelled(),
                statuses: client.presented().statuses,
            };
            client.close().await;
            Ok(())
        });
        world.sim.run().expect("the simulation completes");
        let rebound = rebound.lock().expect("rebound").clone();
        rebound
    });
    eprintln!("NAT rebinding: {summary:?} {rebound:?}");
    assert!(rebound.converged.is_some(), "{rebound:?}");
    assert_eq!(rebound.issued, 1, "{rebound:?}");
    assert_eq!(rebound.cancelled, 0);
    assert!(
        !rebound
            .statuses
            .iter()
            .any(|status| status == "Reconnecting"),
        "a new source port never costs the carrier: {rebound:?}"
    );
}

#[derive(Debug, Default, Clone)]
struct Lossy {
    converged: Option<Duration>,
    issued: u64,
    cancelled: u64,
    statuses: Vec<String>,
}

/// 2% of datagrams lost, latency drawn between 10 and 40 ms per datagram so
/// datagrams reorder: typing, a line, and more typing converge on the
/// daemon's screen with every key once, on the session issued at the start.
#[test]
fn a_session_on_a_lossy_reordering_link_converges() {
    const LINE: &str = "the quick brown fox jumps over the lazy dog";
    const MORE: &str = "and back";
    let network = Network {
        min_latency: Duration::from_millis(10),
        max_latency: Duration::from_millis(40),
        loss: 0.02,
    };
    let (summary, lossy) = merkur_sim::run(65, move || {
        let mut world = World::on(65, network, Duration::from_secs(180));
        let transcript = world.transcript.clone();
        let lossy = Arc::new(Mutex::new(Lossy::default()));
        let server = world.server();
        let observed = Arc::clone(&lossy);
        world.client(CLIENT_HOST, async move {
            let mut client = world::connect(&server, true).await;
            client
                .until(|presented| client::shows(presented, PROMPT.trim_end()))
                .await;
            let started = tokio::time::Instant::now();
            for key in LINE.chars() {
                client.type_text(&key.to_string());
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.press(Key::Enter);
            for key in MORE.chars() {
                client.type_text(&key.to_string());
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let typed = format!("{LINE}\r{MORE}");
            let wait = converged(&mut client, &transcript, typed.as_bytes());
            let done = tokio::time::timeout(Duration::from_secs(60), wait).await;
            *observed.lock().expect("lossy") = Lossy {
                converged: done.is_ok().then(|| started.elapsed()),
                issued: server.issued(),
                cancelled: server.cancelled(),
                statuses: client.presented().statuses,
            };
            client.close().await;
            Ok(())
        });
        world.sim.run().expect("the simulation completes");
        let lossy = lossy.lock().expect("lossy").clone();
        lossy
    });
    eprintln!("2% loss, 10-40 ms: {summary:?} {lossy:?}");
    assert!(lossy.converged.is_some(), "{lossy:?}");
    assert_eq!(
        lossy.issued, 1,
        "loss alone never costs the session: {lossy:?}"
    );
    assert_eq!(lossy.cancelled, 0);
    assert!(
        !lossy.statuses.iter().any(|status| status == "Reconnecting"),
        "loss alone never costs the carrier: {lossy:?}"
    );
}
