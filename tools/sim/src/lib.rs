//! Merkur's network simulator: production code on turmoil's simulated network
//! and clock, where a seed replays a run exactly.
//!
//! Everything here is compiled only in the generated workspace
//! `scripts/sim-tests.ts` builds, with `--cfg merkur_sim`; the production
//! workspace never links it. See `tools/sim/README.md`.

pub mod client;
pub mod clock;
pub mod daemon;
pub mod entropy;
pub mod faults;
pub mod hosts;
pub mod oracle;
pub mod runtime;
pub mod scenario;
pub mod server;
pub mod shell;
pub mod socket;
pub mod trace;
pub mod world;

use std::net::SocketAddr;
use std::sync::Arc;

pub use trace::Summary;

/// The only bind in a simulated process: every wtransport endpoint gets a
/// turmoil socket on the current host and a seed from the run's stream.
fn bind(address: SocketAddr) -> std::io::Result<wtransport::endpoint::sim::Bound> {
    let mut rng_seed = [0; 32];
    assert!(
        entropy::fill(&mut rng_seed),
        "endpoints bind only inside a run"
    );
    Ok(wtransport::endpoint::sim::Bound {
        socket: Arc::new(socket::SimSocket::bind(address)?),
        runtime: Arc::new(runtime::SimRuntime),
        rng_seed,
    })
}

/// Runs `scenario`, which builds and drives one turmoil simulation, under
/// simulated clocks and the entropy stream `seed` names, and returns its
/// datagram trace with the scenario's result.
///
/// Each run gets a fresh thread: `std` draws a thread's hash keys once and
/// then steps them, so a second run on one thread would iterate its maps in
/// another order.
pub fn run<T: Send + 'static>(
    seed: u64,
    scenario: impl FnOnce() -> T + Send + 'static,
) -> (Summary, T) {
    wtransport::endpoint::sim::install(bind);
    std::thread::spawn(move || {
        let entropy = entropy::Entropy::start(seed);
        let clocks = clock::Clocks::start();
        faults::reset();
        hosts::reset();
        trace::start();
        let result = scenario();
        let summary = trace::finish();
        drop(clocks);
        drop(entropy);
        (summary, result)
    })
    .join()
    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}
