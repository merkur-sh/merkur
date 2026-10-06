//! A process restarts under a live session. A bounced edge comes back with an
//! empty splice registry, under its old identity or, when its identity
//! directory was lost, a new one; a bounced daemon host comes back as a fresh
//! dataplane with no peers and a new program on its PTY. Every way, the client
//! must converge on the daemon's screen with every key once.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use merkur_sim::client;
use merkur_sim::scenario::{ATTEMPT, CLIENT_HOST, LATENCY, converged};
use merkur_sim::server::EDGE_HOST;
use merkur_sim::shell::PROMPT;
use merkur_sim::world::{self, DAEMON_HOST, World};

/// The restart lands here, while the client idles after typing.
const BOUNCE_AT: Duration = Duration::from_secs(3);

#[derive(Debug, Default, Clone)]
struct Bounced {
    /// Simulated time from the restart to convergence.
    converged: Option<Duration>,
    issued: u64,
    cancelled: u64,
    boots: u32,
    statuses: Vec<String>,
    /// Endpoints the client bound, one per dial.
    dials: u64,
}

#[derive(Clone, Copy, Debug)]
enum Restart {
    /// The edge restarts with its identity directory intact.
    Edge,
    /// The edge restarts as a new identity: its identity directory was lost.
    RotatedEdge,
    Dataplane,
}

fn bounce(seed: u64, restart: Restart) -> Bounced {
    let (summary, bounced) = merkur_sim::run(seed, move || {
        let mut world = World::new(seed, LATENCY, Duration::from_secs(240));
        let transcript = world.transcript.clone();
        let bounced = Arc::new(Mutex::new(Bounced::default()));
        let server = world.server();
        let observed = Arc::clone(&bounced);
        world.client(CLIENT_HOST, async move {
            let mut client = world::connect(&server, true).await;
            client
                .until(|presented| client::shows(presented, PROMPT.trim_end()))
                .await;
            client.type_text("before");
            client
                .until(|presented| client::shows(presented, "$ before"))
                .await;
            tokio::time::sleep_until(tokio::time::Instant::now() + BOUNCE_AT * 2).await;
            client.type_text(" after");
            let wait = converged(&mut client, &transcript, b"before after");
            let done = tokio::time::timeout(Duration::from_secs(120), wait).await;
            let since_bounce = turmoil::elapsed().saturating_sub(BOUNCE_AT);
            *observed.lock().expect("bounced") = Bounced {
                converged: done.is_ok().then_some(since_bounce),
                issued: server.issued(),
                cancelled: server.cancelled(),
                boots: transcript.read().boots,
                statuses: client.presented().statuses,
                dials: merkur_sim::hosts::binds(CLIENT_HOST),
            };
            client.close().await;
            Ok(())
        });
        match restart {
            Restart::Edge => world.run_bouncing(EDGE_HOST, BOUNCE_AT),
            Restart::RotatedEdge => world.run_rotating_edge(BOUNCE_AT),
            Restart::Dataplane => world.run_bouncing(DAEMON_HOST, BOUNCE_AT),
        }
        .expect("the simulation completes");
        let bounced = bounced.lock().expect("bounced").clone();
        bounced
    });
    eprintln!(
        "{restart:?} at {BOUNCE_AT:?}: {summary:?}, {} dials, {bounced:?}",
        bounced.dials
    );
    bounced
}

/// The client types again `BOUNCE_AT` after the restart, and every restart is
/// recovered by then: what it types lands within one attempt. A recovery that
/// waited out a dead process's connection at the edge (its 30 s idle timeout)
/// converged half a minute later.
fn assert_converged(bounced: &Bounced) {
    assert!(
        bounced
            .converged
            .is_some_and(|converged| converged <= BOUNCE_AT + ATTEMPT),
        "{bounced:?}"
    );
    assert_eq!(
        bounced.statuses.last().map(String::as_str),
        Some("Ready"),
        "{bounced:?}"
    );
}

/// The edge's stateless resets are keyed by the secret it kept, so the client
/// learns at its next packet that its carrier is gone; the restarted dataplane
/// leg and the client's candidate both attach under their tickets, and the
/// lineage rebinds without the server.
#[test]
fn a_bounced_edge_keeps_the_session_without_an_issuance() {
    let bounced = bounce(71, Restart::Edge);
    assert_converged(&bounced);
    assert_eq!(bounced.boots, 1, "the daemon's program lives on");
    assert_eq!(bounced.issued, 1, "the lineage rebinds: {bounced:?}");
    assert_eq!(bounced.cancelled, 0);
}

/// No pin the client holds names the certificate a new identity serves, so its
/// candidate's dial fails. The client asks the server through a renewal, whose
/// answer carries the hashes the restarted edge registered; the next candidate
/// reaches it, finds no tunnel there (the dataplane's tunnels died with the
/// edge's reset secret), and the client issues once. Before the renewal
/// carried hashes, the client retried the certificate it pinned forever.
#[test]
fn an_edge_bounced_as_a_new_identity_costs_one_issuance() {
    let bounced = bounce(73, Restart::RotatedEdge);
    assert_converged(&bounced);
    assert_eq!(bounced.issued, 2, "{bounced:?}");
    assert_eq!(bounced.cancelled, 1, "only the superseded session is cancelled");
}

/// A fresh dataplane knows no lineage, so the client recovers through one
/// issuance. The restarted process states its incarnation to the edge with its
/// first lease, the edge retires every session the dead process held and closes
/// their clients' attachments, and the client issues at once instead of
/// waiting out the dead tunnel's idle timeout.
#[test]
fn a_bounced_dataplane_costs_one_issuance_and_keeps_every_key() {
    let bounced = bounce(72, Restart::Dataplane);
    assert_converged(&bounced);
    assert_eq!(bounced.boots, 2, "the daemon host restarted its program");
    assert_eq!(bounced.issued, 2, "{bounced:?}");
    assert_eq!(
        bounced.cancelled, 1,
        "only the superseded session is cancelled"
    );
}
