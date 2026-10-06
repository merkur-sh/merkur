//! T2: the real client, edge and dataplane in one simulation. A session is
//! issued, attaches through the edge, authenticates, and a keystroke's echo
//! reaches the client's grid; the same seed replays every datagram.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use merkur_sim::Summary;
use merkur_sim::client::{self, Key};
use merkur_sim::oracle;
use merkur_sim::shell::PROMPT;
use merkur_sim::world::{self, World};

const LATENCY: Duration = Duration::from_millis(15);

#[derive(Debug, Default, Clone)]
struct Observed {
    /// Simulated time from connect to the prompt, and from a keystroke to its
    /// echo on the client's grid.
    prompt: Duration,
    echo: Duration,
    rows: Vec<String>,
    statuses: Vec<String>,
    issued: u64,
    /// Every byte the daemon's terminal wrote to its program.
    input: Vec<u8>,
    /// The daemon's screen, rebuilt from what its program wrote.
    daemon_rows: Vec<String>,
}

fn run(seed: u64) -> (Summary, Observed) {
    merkur_sim::run(seed, move || scenario(seed))
}

fn scenario(seed: u64) -> Observed {
    let mut world = World::new(seed, LATENCY, Duration::from_secs(60));
    let transcript = world.transcript.clone();
    let observed = Arc::new(Mutex::new(Observed::default()));
    let server = world.server();
    let client_observed = Arc::clone(&observed);
    world.client("browser", async move {
        let connected = tokio::time::Instant::now();
        let mut client = world::connect(&server, true).await;
        client
            .until(|presented| client::shows(presented, PROMPT.trim_end()))
            .await;
        let prompt = connected.elapsed();

        let typed = tokio::time::Instant::now();
        client.type_text("echo merkur");
        client
            .until(|presented| client::shows(presented, "$ echo merkur"))
            .await;
        let echo = typed.elapsed();
        client.press(Key::Enter);
        let presented = client
            .until(|presented| {
                presented
                    .rows
                    .iter()
                    .filter(|row| row.starts_with(PROMPT.trim_end()))
                    .count()
                    >= 2
            })
            .await;

        *client_observed.lock().expect("observed") = Observed {
            prompt,
            echo,
            rows: presented.rows,
            statuses: presented.statuses,
            issued: server.issued(),
            input: Vec::new(),
            daemon_rows: Vec::new(),
        };
        client.close().await;
        Ok(())
    });

    world.sim.run().expect("the simulation completes");
    let mut observed = observed.lock().expect("observed").clone();
    let transcript = transcript.read();
    observed.input = transcript.input;
    observed.daemon_rows = oracle::screen(&transcript.output, client::COLS, client::ROWS);
    observed
}

#[test]
fn a_session_types_and_echoes_on_simulated_time_and_replays() {
    let started = std::time::Instant::now();
    let (first, observed) = run(11);
    eprintln!(
        "seed 11: {first:?} prompt {:?} echo {:?}, {:?} real\nstatuses {:?}\n{}",
        observed.prompt,
        observed.echo,
        started.elapsed(),
        observed.statuses,
        observed.rows.join("\n").trim_end()
    );
    assert!(
        observed.rows[0].starts_with("$ echo merkur"),
        "{observed:?}"
    );
    assert_eq!(observed.rows[1], PROMPT.trim_end(), "{observed:?}");
    assert_eq!(observed.issued, 1, "one issuance for one session");
    assert_eq!(
        observed.input, b"echo merkur\r",
        "every key reaches the PTY once, in order, Enter as CR"
    );
    assert_eq!(
        observed.rows, observed.daemon_rows,
        "the client presents the daemon's grid"
    );
    // A keystroke reaches the daemon and its echo comes back over the relay:
    // two edge legs each way at least.
    assert!(observed.echo >= 4 * LATENCY, "{observed:?}");

    for replay in 0..19 {
        assert_eq!(run(11).0, first, "replay {replay} diverged");
    }
    assert_ne!(run(12).0, first, "another seed is another run");
}
