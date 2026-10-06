//! T0: the patched WebTransport stack on simulated time. A real session echoes
//! a datagram and a stream, survives a two-second partition, and closes on its
//! idle timeout at the simulated instant; the same seed replays every datagram.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use merkur_sim::Summary;
use tokio::io::AsyncReadExt;
use wtransport::error::ConnectionError;
use wtransport::{ClientConfig, Endpoint, Identity, ServerConfig};

const PORT: u16 = 4433;
const IDLE: Duration = Duration::from_secs(10);
const LATENCY: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, Debug, Default)]
struct Observed {
    /// Simulated time from the long partition to the idle close.
    idle_close: Duration,
    /// Packets quinn declared lost across the short partition.
    lost_packets: u64,
    /// `std` clocks across a five-second simulated sleep inside a host.
    std_monotonic: Duration,
    std_wall: Duration,
}

fn run(seed: u64) -> (Summary, Observed) {
    merkur_sim::run(seed, move || scenario(seed))
}

fn scenario(seed: u64) -> Observed {
    let identity = Identity::self_signed(["server"]).expect("a self-signed identity");
    let hash = identity.certificate_chain().as_slice()[0].hash();
    let observed = Arc::new(Mutex::new(Observed::default()));

    let mut sim = turmoil::Builder::new()
        .simulation_duration(Duration::from_secs(120))
        .min_message_latency(LATENCY)
        .max_message_latency(LATENCY)
        .udp_capacity(4096)
        .rng_seed(seed)
        .build();

    sim.host("server", move || {
        let identity = identity.clone_identity();
        async move {
            let config = ServerConfig::builder()
                .with_bind_default(PORT)
                .with_identity(identity)
                .max_idle_timeout(Some(IDLE))?
                .build();
            let server = Endpoint::server(config)?;
            loop {
                let connection = server.accept().await.await?.accept().await?;
                // An echo only; the client asserts what arrived. The idle
                // partition ends the connection under whatever is in flight.
                tokio::spawn(async move {
                    let Ok(datagram) = connection.receive_datagram().await else {
                        return;
                    };
                    let _ = connection.send_datagram(datagram.payload());
                    while let Ok((mut send, mut recv)) = connection.accept_bi().await {
                        let mut body = Vec::new();
                        if recv.read_to_end(&mut body).await.is_err()
                            || send.write_all(&body).await.is_err()
                            || send.finish().await.is_err()
                        {
                            return;
                        }
                    }
                });
            }
        }
    });

    let client_observed = Arc::clone(&observed);
    sim.client("client", async move {
        let mut observed = Observed::default();

        let std_monotonic = std::time::Instant::now();
        let std_wall = SystemTime::now();
        tokio::time::sleep(Duration::from_secs(5)).await;
        observed.std_monotonic = std_monotonic.elapsed();
        observed.std_wall = SystemTime::now().duration_since(std_wall)?;

        let config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([hash])
            .max_idle_timeout(Some(IDLE))?
            .build();
        let endpoint = Endpoint::client(config)?;
        let url = format!("https://{}:{PORT}", turmoil::lookup("server"));
        let connection = endpoint.connect(url).await?;

        connection.send_datagram(b"ping")?;
        assert_eq!(connection.receive_datagram().await?.payload(), &b"ping"[..]);

        // Data sent into a partition is lost, then repaired once it heals.
        turmoil::partition("client", "server");
        let (mut send, mut recv) = connection.open_bi().await?.await?;
        let body = vec![7u8; 64 * 1024];
        let writer = tokio::spawn(async move {
            send.write_all(&body).await.expect("a written body");
            send.finish().await.expect("a finished stream");
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        turmoil::repair("client", "server");
        writer.await?;
        let mut echoed = Vec::new();
        recv.read_to_end(&mut echoed).await?;
        assert_eq!(echoed.len(), 64 * 1024);
        observed.lost_packets = connection.quic_connection().stats().path.lost_packets;

        // A partition longer than the idle timeout closes at that instant.
        turmoil::partition("client", "server");
        let partitioned = tokio::time::Instant::now();
        let closed = connection.closed().await;
        observed.idle_close = partitioned.elapsed();
        assert!(matches!(closed, ConnectionError::TimedOut), "{closed:?}");

        *client_observed.lock().expect("observation lock") = observed;
        Ok(())
    });

    sim.run().expect("the simulation completes");
    *observed.lock().expect("observation lock")
}

#[test]
fn webtransport_runs_on_simulated_time_and_replays() {
    let started = std::time::Instant::now();
    let (first, observed) = run(7);
    let real = started.elapsed();
    eprintln!("seed 7: {first:?} {observed:?}, {real:?} real");

    // std clocks inside a host read simulated time.
    assert!(observed.std_monotonic >= Duration::from_secs(5));
    assert!(observed.std_wall >= Duration::from_secs(5));
    // The idle timer fires on simulated time, faster than real time could.
    assert!(observed.idle_close >= IDLE, "{observed:?}");
    assert!(
        observed.idle_close < IDLE + Duration::from_secs(1),
        "{observed:?}"
    );
    assert!(real < IDLE + Duration::from_secs(5), "{real:?}");
    assert!(observed.lost_packets > 0, "{observed:?}");

    for replay in 0..19 {
        assert_eq!(run(7).0, first, "replay {replay} diverged");
    }
    assert_ne!(run(8).0, first, "another seed is another run");
}
