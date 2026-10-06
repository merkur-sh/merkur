//! One simulated deployment: an edge, a daemon host, and the server between
//! them. A scenario adds its client hosts and drives them.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use crate::client::{self, Client};
use crate::daemon::{self, EventLog};
use crate::server::{Account, Control, EDGE_HOST, EDGE_PORT, Server};
use crate::shell::Transcript;

pub const DAEMON_HOST: &str = "daemon";

pub struct World<'a> {
    pub sim: turmoil::Sim<'a>,
    pub account: Arc<Account>,
    /// Every event the dataplane wrote, across every boot of its host.
    pub events: EventLog,
    /// Every byte that crossed the daemon's PTY.
    pub transcript: Transcript,
    /// What the edge's identity directory holds; each boot binds it, and a
    /// running edge reloads it when it rotates in place.
    edge_identity: Arc<watch::Sender<Arc<merkur_edge::sim::Identity>>>,
    edge_cert: watch::Receiver<Option<[[u8; 32]; 2]>>,
    control: mpsc::Sender<Control>,
}

/// The links every host shares.
#[derive(Clone, Copy, Debug)]
pub struct Network {
    /// One-way latency, drawn per datagram between these.
    pub min_latency: Duration,
    pub max_latency: Duration,
    /// The probability any one datagram is lost (`faults::set_loss`).
    pub loss: f64,
}

impl Network {
    pub fn fixed(latency: Duration) -> Self {
        Self {
            min_latency: latency,
            max_latency: latency,
            loss: 0.0,
        }
    }
}

impl<'a> World<'a> {
    /// An edge and a daemon on links of fixed one-way `latency`, simulated for
    /// at most `duration`. Builds inside [`crate::run`].
    pub fn new(seed: u64, latency: Duration, duration: Duration) -> Self {
        Self::on(seed, Network::fixed(latency), duration)
    }

    /// An edge and a daemon on `network`, simulated for at most `duration`.
    pub fn on(seed: u64, network: Network, duration: Duration) -> Self {
        let account = Arc::new(Account::new());
        let events = EventLog::default();
        crate::faults::set_loss(network.loss);
        let mut sim = turmoil::Builder::new()
            .simulation_duration(duration)
            .min_message_latency(network.min_latency)
            .max_message_latency(network.max_latency)
            .udp_capacity(4096)
            .rng_seed(seed)
            .build();

        // The edge boots as whatever identity its directory holds, and the
        // server reads the pair of certificates each boot and rotation
        // registers, as the registry states them.
        let edge_identity = Arc::new(watch::channel(Arc::new(edge_identity())).0);
        let (cert_tx, edge_cert) = watch::channel(None);
        let edge_key = *account.edge_ticket_key();
        let identities = Arc::clone(&edge_identity);
        sim.host(EDGE_HOST, move || {
            let cert_tx = cert_tx.clone();
            let mut identity = identities.subscribe();
            async move {
                crate::hosts::register(EDGE_HOST);
                let booted = Arc::clone(&identity.borrow_and_update());
                let edge = merkur_edge::sim::Edge::bind(EDGE_PORT, &edge_key, &booted)?;
                cert_tx.send_replace(Some(booted.cert_hashes()));
                // A rotation in place: the endpoint serves the published next
                // certificate, then the registry states the new pair.
                let rotations = async {
                    while identity.changed().await.is_ok() {
                        let rotated = Arc::clone(&identity.borrow_and_update());
                        edge.reload(&rotated).expect("the edge reloads its certificate");
                        cert_tx.send_replace(Some(rotated.cert_hashes()));
                    }
                };
                tokio::select! {
                    () = edge.serve() => {}
                    () = rotations => {}
                }
                Ok(())
            }
        });

        let (control, control_rx) = mpsc::channel(8);
        let control_rx = Arc::new(tokio::sync::Mutex::new(control_rx));
        let daemon_account = Arc::clone(&account);
        let daemon_events = events.clone();
        let transcript = Transcript::default();
        let daemon_transcript = transcript.clone();
        let leased_edge = edge_cert.clone();
        sim.host(DAEMON_HOST, move || {
            let account = Arc::clone(&daemon_account);
            let events = daemon_events.clone();
            let transcript = daemon_transcript.clone();
            let control_rx = Arc::clone(&control_rx);
            let edge = leased_edge.clone();
            async move {
                crate::hosts::register(DAEMON_HOST);
                daemon::serve(
                    account,
                    edge,
                    control_rx,
                    events,
                    transcript,
                    client::COLS,
                    client::ROWS,
                )
                .await
            }
        });

        Self {
            sim,
            account,
            events,
            transcript,
            edge_identity,
            edge_cert,
            control,
        }
    }

    /// The server's issuance and renewal routes.
    pub fn server(&self) -> Arc<Server> {
        Arc::new(Server::new(
            Arc::clone(&self.account),
            self.edge_cert.clone(),
            self.control.clone(),
        ))
    }

    /// Runs the simulation, restarting host `host` once `at` has elapsed: its
    /// software is dropped mid-flight, as a crashed and restarted process is,
    /// and boots again. A restarted edge keeps its identity.
    pub fn run_bouncing(&mut self, host: &str, at: Duration) -> turmoil::Result {
        self.run_striking(at, |world| world.sim.bounce(host))
    }

    /// Runs the simulation, restarting the edge once `at` has elapsed as a
    /// new identity, as an edge whose identity directory was lost boots.
    pub fn run_rotating_edge(&mut self, at: Duration) -> turmoil::Result {
        self.run_striking(at, |world| {
            world.edge_identity.send_replace(Arc::new(edge_identity()));
            world.sim.bounce(EDGE_HOST);
        })
    }

    /// What rotates the running edge's certificate in place, for a scenario
    /// to strike with from inside a host.
    pub fn edge_rotator(&self) -> EdgeRotator {
        EdgeRotator(Arc::clone(&self.edge_identity))
    }

    fn run_striking(&mut self, at: Duration, strike: impl FnOnce(&mut Self)) -> turmoil::Result {
        let mut strike = Some(strike);
        loop {
            if self.sim.elapsed() >= at
                && let Some(strike) = strike.take()
            {
                strike(self);
            }
            if self.sim.step()? {
                return Ok(());
            }
        }
    }

    /// A client host named `name` running `scenario`, registered for faults.
    pub fn client<F>(&mut self, name: &'static str, scenario: F)
    where
        F: Future<Output = Result<(), Box<dyn std::error::Error>>> + 'static,
    {
        self.sim.client(name, async move {
            crate::hosts::register(name);
            scenario.await
        });
    }
}

fn edge_identity() -> merkur_edge::sim::Identity {
    merkur_edge::sim::Identity::generate().expect("an edge identity")
}

/// Rotates the running edge's certificate in place, as its registration loop
/// does every rotation period: from then on its endpoint serves the
/// certificate it published as next, established connections keep theirs, and
/// the registry states the new pair.
#[derive(Clone)]
pub struct EdgeRotator(Arc<watch::Sender<Arc<merkur_edge::sim::Identity>>>);

impl EdgeRotator {
    pub fn rotate(&self) {
        self.0.send_modify(|identity| {
            *identity = Arc::new(identity.rotated().expect("a rotated edge identity"));
        });
    }
}

/// Connects a client of `server`'s account from the current host once the
/// edge is up.
pub async fn connect(server: &Arc<Server>, relay_only: bool) -> Client {
    server.edge_ready().await;
    Client::connect(Arc::clone(server), server.account(), relay_only)
}
