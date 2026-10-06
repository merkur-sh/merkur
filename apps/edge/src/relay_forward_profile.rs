//! Opt-in authenticated relay profile. The existing liveness fixture owns the
//! real accept loop and signed attach tickets. Endpoints validate opaque bytes;
//! the relay observes only ownership, lengths, task polls and admission times.
//! Run the emitted release test binary with --ignored --nocapture --test-threads=1.
//! Task instrumentation is test-only and identical on both comparison binaries.

use super::*;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Wake, Waker};

pub(in crate::relay) static ACTIVE: AtomicBool = AtomicBool::new(false);
static POLLS: AtomicUsize = AtomicUsize::new(0);
static WAKES: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
static RESIDENCE: std::sync::LazyLock<parking_lot::Mutex<Vec<u64>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(Vec::new()));

struct TaskWake(parking_lot::Mutex<Waker>);

impl Wake for TaskWake {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        WAKES.fetch_add(1, Ordering::Relaxed);
        self.0.lock().wake_by_ref();
    }
}

pub(in crate::relay) async fn instrument<T>(future: impl Future<Output = T>) -> T {
    if !ACTIVE.load(Ordering::Relaxed) {
        return future.await;
    }
    let wake = Arc::new(TaskWake(parking_lot::Mutex::new(Waker::noop().clone())));
    let waker = Waker::from(Arc::clone(&wake));
    tokio::pin!(future);
    std::future::poll_fn(|cx| {
        *wake.0.lock() = cx.waker().clone();
        POLLS.fetch_add(1, Ordering::Relaxed);
        let (result, tally) = super::super::ownership_tests::measured(|| {
            future.as_mut().poll(&mut Context::from_waker(&waker))
        });
        ALLOCS.fetch_add(tally.allocations, Ordering::Relaxed);
        BYTES.fetch_add(tally.bytes, Ordering::Relaxed);
        result
    })
    .await
}

pub(in crate::relay) fn spawn(
    future: impl Future<Output = ()> + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(instrument(future))
}

pub(in crate::relay) fn residence(received: Instant) {
    if ACTIVE.load(Ordering::Relaxed) {
        let residence_ns = received.elapsed().as_nanos() as u64;
        let mut samples = RESIDENCE.lock();
        assert!(samples.len() < samples.capacity(), "profile sample bound");
        samples.push(residence_ns);
    }
}

fn distribution(values: &mut [u64]) -> serde_json::Value {
    values.sort_unstable();
    assert!(!values.is_empty());
    serde_json::json!({
        "n": values.len(),
        "p50_ns": values[(values.len() - 1) / 2],
        "p95_ns": values[(values.len() - 1) * 95 / 100],
        "p99_ns": values[(values.len() - 1) * 99 / 100],
        "max_ns": values[values.len() - 1],
    })
}

#[test]
fn profile_distribution_sorts_and_uses_lower_rank_quantiles() {
    let mut samples: Vec<u64> = (1..=100).rev().collect();
    assert_eq!(
        distribution(&mut samples),
        serde_json::json!({
            "n": 100, "p50_ns": 50, "p95_ns": 95, "p99_ns": 99, "max_ns": 100,
        }),
    );
}

async fn receive(connection: &Connection, expected: &[u8]) {
    let received = tokio::time::timeout(Duration::from_secs(10), connection.receive_datagram())
        .await
        .expect("datagram delivered")
        .expect("live connection");
    assert_eq!(&received[..], expected);
}

async fn closed_loop(
    source: &Connection,
    destination: &Connection,
    bytes: usize,
    count: usize,
) -> Vec<u64> {
    let mut samples = Vec::with_capacity(count);
    for index in 0..count {
        let mut payload = vec![0x5a; bytes];
        payload[..8].copy_from_slice(&(index as u64).to_be_bytes());
        let started = Instant::now();
        source
            .send_datagram_owned(Bytes::from(payload.clone()))
            .unwrap();
        receive(destination, &payload).await;
        samples.push(started.elapsed().as_nanos() as u64);
    }
    samples
}

async fn bursts(source: &Connection, destination: &Connection, count: usize) -> Vec<u64> {
    let mut samples = Vec::with_capacity(count * 32);
    // Closed-loop bursts fix equal completed work and preserve missing-packet
    // failures. There is no received-only timing comparison after dropped work.
    for burst in 0..count {
        let mut payloads = Vec::with_capacity(32);
        let started = Instant::now();
        {
            let _hold = source.hold_egress();
            for index in 0..32 {
                let mut payload = vec![0x5a; if index == 0 { 57 } else { 1100 }];
                payload[..8].copy_from_slice(&((burst * 32 + index) as u64).to_be_bytes());
                source
                    .send_datagram_owned(Bytes::from(payload.clone()))
                    .unwrap();
                payloads.push(payload);
            }
        }
        for payload in payloads {
            receive(destination, &payload).await;
            samples.push(started.elapsed().as_nanos() as u64);
        }
    }
    samples
}

async fn slow_receiver(
    source: &Connection,
    destination: &Connection,
    leg: &wtransport::quinn::Connection,
) -> Vec<u64> {
    let mut input = source.open_uni().await.unwrap().await.unwrap();
    input.write_all(&[0x57]).await.unwrap();
    let body = Bytes::from(vec![0x33; 64 * 1024]);
    let writer = tokio::spawn(async move {
        for _ in 0..256 {
            input
                .write_all(&(body.len() as u32).to_be_bytes())
                .await
                .unwrap();
            input
                .quic_stream_mut()
                .write_all_chunks(&mut [body.clone()])
                .await
                .unwrap();
        }
        input
    });
    let mut output = destination.accept_uni().await.unwrap();
    output.read_exact(&mut [0; 9]).await.unwrap();
    let stream = output.quic_stream().id();
    // The real flow-control event defines the measurement start. No delay or
    // byte-volume guess stands in for the destination becoming blocked.
    eventually("destination stream flow control", || {
        leg.is_blocked_by_stream_credit(stream)
            .expect("destination stream remains open")
    })
    .await;
    let samples = closed_loop(source, destination, 57, 512).await;
    assert!(
        !writer.is_finished(),
        "slow reader must backpressure its writer"
    );
    let mut record = vec![0; 4 + 64 * 1024];
    for _ in 0..256 {
        output.read_exact(&mut record).await.unwrap();
        assert_eq!(&record[..4], &(65536u32).to_be_bytes());
        assert!(record[4..].iter().all(|byte| *byte == 0x33));
    }
    let _input = writer.await.unwrap();
    samples
}

#[test]
#[ignore = "authenticated forwarding profile; run alone in release mode"]
fn authenticated_forwarding_profile() {
    let workers = std::env::var("EDGE_PROFILE_WORKERS").unwrap_or_else(|_| "default".into());
    let mut builder = if workers == "current" {
        tokio::runtime::Builder::new_current_thread()
    } else {
        let mut builder = tokio::runtime::Builder::new_multi_thread();
        if workers != "default" {
            builder.worker_threads(workers.parse().expect("positive worker count"));
        }
        builder
    };
    builder.enable_all().build().unwrap().block_on(profile());
}

async fn profile() {
    let workload = std::env::var("EDGE_PROFILE_WORKLOAD").unwrap_or_else(|_| "typing".into());
    let sessions = if workload == "concurrent" { 8 } else { 1 };
    RESIDENCE.lock().reserve(100_000);
    for counter in [&POLLS, &WAKES, &ALLOCS, &BYTES] {
        counter.store(0, Ordering::Relaxed);
    }
    RESIDENCE.lock().clear();
    ACTIVE.store(true, Ordering::Relaxed);
    let relay = Relay::new();
    let mut peers = Vec::new();
    let mut endpoints = Vec::new();
    for index in 0..sessions {
        let (daemon, browser) = (relay.client(), relay.client());
        let label = format!("forward-profile-{index}");
        let pair = attach_pair((&daemon, &relay.url()), (&browser, &relay.url()), &label).await;
        endpoints.push((daemon, browser));
        peers.push((pair, relay.browser_leg(&label)));
    }
    for ((source, destination), _) in &peers {
        closed_loop(&source.0, &destination.0, 57, 32).await;
    }
    for counter in [&POLLS, &WAKES, &ALLOCS, &BYTES] {
        counter.store(0, Ordering::Relaxed);
    }
    RESIDENCE.lock().clear();
    DATAGRAM_EGRESS_DROPS.store(0, Ordering::Relaxed);
    let mut tasks = tokio::task::JoinSet::new();
    let started = Instant::now();
    for ((source, destination), leg) in peers {
        let workload = workload.clone();
        tasks.spawn(async move {
            // Keep lifecycle and advisory receive halves alive for the whole
            // workload, including the final reliable drain.
            let samples = match workload.as_str() {
                "typing" | "concurrent" => closed_loop(&source.0, &destination.0, 57, 4096).await,
                "burst" => bursts(&source.0, &destination.0, 128).await,
                "slow" => slow_receiver(&source.0, &destination.0, &leg).await,
                _ => panic!("unknown profile workload"),
            };
            source.0.close(VarInt::from_u32(0), b"profile-ended");
            destination.0.close(VarInt::from_u32(0), b"profile-ended");
            samples
        });
    }
    let mut samples = Vec::new();
    while let Some(result) = tasks.join_next().await {
        samples.extend(result.unwrap());
    }
    let elapsed = started.elapsed();
    ACTIVE.store(false, Ordering::Relaxed);
    assert_eq!(RESIDENCE.lock().len(), samples.len(), "every admission sampled");
    let residence = distribution(&mut RESIDENCE.lock());
    println!(
        "@@edge-forward-profile {}",
        serde_json::json!({
            "workload": workload, "sessions": sessions,
            "delivery": distribution(&mut samples), "residence": residence,
            "elapsed_ns": elapsed.as_nanos(),
            "pump_polls": POLLS.load(Ordering::Relaxed),
            "pump_wakes": WAKES.load(Ordering::Relaxed),
            "pump_allocations": ALLOCS.load(Ordering::Relaxed),
            "pump_allocated_bytes": BYTES.load(Ordering::Relaxed),
            "egress_drops": DATAGRAM_EGRESS_DROPS.load(Ordering::Relaxed),
        })
    );
    drop(endpoints);
}
