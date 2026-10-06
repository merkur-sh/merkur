//! Per-packet profile of the Binding responder.
//!
//! Two views of the same work. The first runs the real `serve` loop on loopback
//! sockets and replays one prepared datagram per scenario: allocation requests
//! are counted on the serve thread only, its user and system CPU is read
//! through Mach, and the client times each round trip. Completion is exact —
//! the reply for answered scenarios, the scenario's own drop counter for silent
//! ones — so no packet is timed against a guess. The second times the steps
//! `serve` runs for each datagram, one production function at a time, beside
//! the reply-socket selection it ran per datagram before resolving it once per
//! thread, and the daemon's half of one probe.
//!
//! The responder table aliases a second loopback IPv4 onto the change-only
//! socket, which is how the two-address box-host deployment looks to `serve`:
//! OTHER-ADDRESS and CHANGE-IP both become reachable on a
//! machine with one loopback address. Only the table key is aliased; every
//! reply still leaves a real socket.
//!
//! macOS only: the serve-thread CPU is read with `thread_info`.
//!
//! ```sh
//! cargo test --release --locked -p merkur-stun \
//!   packet_profile::stun_packet_path_profile -- --ignored --exact --nocapture --test-threads=1
//! cargo test --release --locked -p merkur-stun \
//!   packet_profile::stun_packet_steps_benchmark -- --ignored --exact --nocapture --test-threads=1
//! ```

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::HashMap;
use std::hint::black_box;
use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use merkur_stun_protocol::message::{self, ResponseWriter, parse_binding_request};
use ring::hmac;
use ring::rand::SystemRandom;

use super::{
    ATTR_OTHER_ADDRESS, ATTR_XOR_MAPPED_ADDRESS, Config, Counters, Responders,
    alternate_address_addr, alternate_port_addr, now_unix_secs, serve, ticket,
};
use crate::ticket::TicketKey;

// ---------------------------------------------------------------------------
// Allocation requests, counted only on threads that opt in.

thread_local! {
    static COUNTED: Cell<bool> = const { Cell::new(false) };
}
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);

struct CountingAllocator;
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn count(size: usize) {
    if COUNTED.try_with(Cell::get).unwrap_or(false) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        ALLOCATED_BYTES.fetch_add(size, Ordering::Relaxed);
    }
}

// SAFETY: every method hands its arguments unchanged to `System` and returns
// `System`'s answer, so `System`'s own `GlobalAlloc` guarantees hold. `count`
// only reads a const thread-local `Cell` and adds to wrapping atomics, so it
// neither re-enters the allocator nor unwinds.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forward the unchanged allocator contract to System.
        let result = unsafe { System.alloc(layout) };
        if !result.is_null() {
            count(layout.size());
        }
        result
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forward the unchanged allocator contract to System.
        let result = unsafe { System.alloc_zeroed(layout) };
        if !result.is_null() {
            count(layout.size());
        }
        result
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: return the original pointer/layout to its allocator.
        unsafe { System.dealloc(ptr, layout) };
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        // SAFETY: preserve the original allocation and requested new size.
        let result = unsafe { System.realloc(ptr, layout, size) };
        if !result.is_null() {
            count(size);
        }
        result
    }
}

fn allocation_snapshot() -> (usize, usize) {
    (
        ALLOCATIONS.load(Ordering::Relaxed),
        ALLOCATED_BYTES.load(Ordering::Relaxed),
    )
}

// ---------------------------------------------------------------------------
// Another thread's CPU time, through Mach.

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct TimeValue {
    seconds: i32,
    microseconds: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ThreadBasicInfo {
    user_time: TimeValue,
    system_time: TimeValue,
    cpu_usage: i32,
    policy: i32,
    run_state: i32,
    flags: i32,
    suspend_count: i32,
    sleep_time: i32,
}

const THREAD_BASIC_INFO: u32 = 3;
const THREAD_BASIC_INFO_COUNT: u32 = (size_of::<ThreadBasicInfo>() / size_of::<u32>()) as u32;

unsafe extern "C" {
    fn mach_thread_self() -> u32;
    fn thread_info(target: u32, flavor: u32, info: *mut ThreadBasicInfo, count: *mut u32) -> i32;
}

fn micros(value: TimeValue) -> u64 {
    value.seconds as u64 * 1_000_000 + value.microseconds as u64
}

/// (user, system) microseconds consumed so far by the thread behind `port`.
fn thread_cpu_micros(port: u32) -> (u64, u64) {
    let mut info = ThreadBasicInfo::default();
    let mut count = THREAD_BASIC_INFO_COUNT;
    // SAFETY: `info` is a writable THREAD_BASIC_INFO buffer of `count` words.
    let status = unsafe { thread_info(port, THREAD_BASIC_INFO, &mut info, &mut count) };
    assert_eq!(status, 0, "thread_info");
    (micros(info.user_time), micros(info.system_time))
}

// ---------------------------------------------------------------------------
// Fixture: the real serve loop on two loopback sockets.

const ALIAS_IP: [u8; 4] = [127, 0, 0, 2];

struct Responder {
    observer: SocketAddr,
    counters: Arc<Counters>,
    config: Arc<Config>,
    serve_thread: Arc<AtomicU32>,
}

impl Responder {
    fn start() -> Self {
        let observer_socket = Arc::new(UdpSocket::bind("127.0.0.1:0").expect("bind observer"));
        let change_socket = Arc::new(UdpSocket::bind("127.0.0.1:0").expect("bind change-only"));
        let observer = observer_socket.local_addr().expect("observer addr");
        let change = change_socket.local_addr().expect("change addr");
        let alias = SocketAddr::from((ALIAS_IP, change.port()));
        let config = Arc::new(Config {
            ports: vec![observer.port()],
            change_ports: vec![change.port()],
            bind_addresses: Vec::new(),
            ticket_key: TicketKey::new(&[9u8; super::TICKET_KEY_BYTES]),
        });
        let responders: Arc<Responders> = Arc::new(
            [
                (observer, Arc::clone(&observer_socket)),
                (change, Arc::clone(&change_socket)),
                (alias, Arc::clone(&change_socket)),
            ]
            .into_iter()
            .collect(),
        );
        let counters = Arc::new(Counters::default());
        let serve_thread = Arc::new(AtomicU32::new(0));
        {
            let config = Arc::clone(&config);
            let counters = Arc::clone(&counters);
            let serve_thread = Arc::clone(&serve_thread);
            std::thread::Builder::new()
                .name("stun-profile-serve".to_string())
                .spawn(move || {
                    COUNTED.with(|counted| counted.set(true));
                    // SAFETY: returns this thread's own Mach port.
                    serve_thread.store(unsafe { mach_thread_self() }, Ordering::Release);
                    serve(observer_socket, observer, config, counters, responders)
                })
                .expect("spawn serve");
        }
        while serve_thread.load(Ordering::Acquire) == 0 {
            std::thread::yield_now();
        }
        Self {
            observer,
            counters,
            config,
            serve_thread,
        }
    }

    fn serve_cpu(&self) -> (u64, u64) {
        thread_cpu_micros(self.serve_thread.load(Ordering::Acquire))
    }
}

/// What tells the client that `serve` finished one datagram.
#[derive(Clone, Copy)]
enum Completion {
    Served,
    Unparsed,
    BadTicket,
    BadIntegrity,
}

impl Completion {
    fn read(self, responder: &Responder) -> u64 {
        let counters = &responder.counters;
        match self {
            Self::Served => counters.served.load(Ordering::Acquire),
            Self::Unparsed => counters.dropped_unparsed.load(Ordering::Acquire),
            Self::BadTicket => counters.dropped_bad_ticket.load(Ordering::Acquire),
            Self::BadIntegrity => counters.dropped_bad_integrity.load(Ordering::Acquire),
        }
    }
}

struct Scenario {
    name: &'static str,
    datagram: Vec<u8>,
    reply: bool,
    completion: Completion,
}

struct Credentials {
    username: Vec<u8>,
    key: hmac::Key,
}

fn credentials(ticket_key: &TicketKey, expiry: u64) -> (Credentials, [u8; ticket::TICKET_LEN]) {
    let ticket = ticket_key
        .issue(expiry, &SystemRandom::new())
        .expect("issue ticket");
    // An expired ticket still carries its genuine derived key; derive it from
    // a clock inside the ticket's window so the request is otherwise valid.
    let key = ticket_key
        .verify(&ticket, expiry.min(now_unix_secs()))
        .expect("derive integrity key");
    (
        Credentials {
            username: URL_SAFE_NO_PAD.encode(ticket).into_bytes(),
            key,
        },
        ticket,
    )
}

fn request(credentials: &Credentials, change: u8) -> Vec<u8> {
    message::binding_request(&[7; 12], &credentials.username, change, &credentials.key)
        .expect("encode request")
        .as_bytes()
        .to_vec()
}

fn scenarios(responder: &Responder) -> Vec<Scenario> {
    let now = now_unix_secs();
    let ticket_key = &responder.config.ticket_key;
    let (valid, _) = credentials(ticket_key, now + 300);
    let (expired, _) = credentials(ticket_key, now - 3_600);
    let (_, mut forged_ticket) = credentials(ticket_key, now + 300);
    forged_ticket[ticket::TICKET_LEN - 1] ^= 1;
    let forged = Credentials {
        username: URL_SAFE_NO_PAD.encode(forged_ticket).into_bytes(),
        key: hmac::Key::new(hmac::HMAC_SHA256, &[1; 32]),
    };
    let wrong_key = Credentials {
        username: valid.username.clone(),
        key: hmac::Key::new(hmac::HMAC_SHA256, b"not the derived key"),
    };
    let mut not_stun = vec![0xffu8; 116];
    not_stun[1] = 0x01;

    vec![
        Scenario {
            name: "valid binding",
            datagram: request(&valid, 0),
            reply: true,
            completion: Completion::Served,
        },
        Scenario {
            name: "valid change-port",
            datagram: request(&valid, 0x02),
            reply: true,
            completion: Completion::Served,
        },
        Scenario {
            name: "valid change-ip",
            datagram: request(&valid, 0x04),
            reply: true,
            completion: Completion::Served,
        },
        Scenario {
            name: "forged ticket tag",
            datagram: request(&forged, 0),
            reply: false,
            completion: Completion::BadTicket,
        },
        Scenario {
            name: "expired ticket",
            datagram: request(&expired, 0),
            reply: false,
            completion: Completion::BadTicket,
        },
        Scenario {
            name: "valid ticket, bad integrity",
            datagram: request(&wrong_key, 0),
            reply: false,
            completion: Completion::BadIntegrity,
        },
        Scenario {
            name: "not stun",
            datagram: not_stun,
            reply: false,
            completion: Completion::Unparsed,
        },
    ]
}

fn percentile(sorted: &[u64], fraction: f64) -> u64 {
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index]
}

/// Send one datagram and wait for the exact signal that `serve` finished it.
fn exchange(client: &UdpSocket, responder: &Responder, scenario: &Scenario, buffer: &mut [u8]) {
    let before = scenario.completion.read(responder);
    client
        .send_to(&scenario.datagram, responder.observer)
        .expect("send");
    if scenario.reply {
        let (len, _) = client.recv_from(buffer).expect("reply");
        assert!(len <= scenario.datagram.len(), "reply larger than request");
    }
    while scenario.completion.read(responder) == before {
        std::hint::spin_loop();
    }
}

#[test]
#[ignore = "profiling harness; run explicitly with --ignored --nocapture"]
fn stun_packet_path_profile() {
    let packets: usize = std::env::var("STUN_PROFILE_PACKETS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(20_000);
    let warmup = 500;
    let responder = Responder::start();
    let client = UdpSocket::bind("127.0.0.1:0").expect("bind client");
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    let mut buffer = [0u8; 512];

    println!(
        "stun serve loop: {packets} packets per scenario after {warmup} warm-up, ping-pong on loopback"
    );
    println!(
        "{:<30} {:>6} {:>10} {:>9} {:>9} {:>9} {:>9} {:>9}",
        "scenario", "bytes", "allocs/pkt", "bytes/pkt", "usr ns", "sys ns", "rtt p50", "rtt p95"
    );
    for scenario in &scenarios(&responder) {
        for _ in 0..warmup {
            exchange(&client, &responder, scenario, &mut buffer);
        }
        let mut rtts = Vec::with_capacity(packets);
        let (allocations_before, bytes_before) = allocation_snapshot();
        let (user_before, system_before) = responder.serve_cpu();
        for _ in 0..packets {
            let started = Instant::now();
            exchange(&client, &responder, scenario, &mut buffer);
            rtts.push(started.elapsed().as_nanos() as u64);
        }
        let (user_after, system_after) = responder.serve_cpu();
        let (allocations_after, bytes_after) = allocation_snapshot();
        rtts.sort_unstable();
        println!(
            "{:<30} {:>6} {:>10.3} {:>9.1} {:>9.0} {:>9.0} {:>9} {:>9}",
            scenario.name,
            scenario.datagram.len(),
            (allocations_after - allocations_before) as f64 / packets as f64,
            (bytes_after - bytes_before) as f64 / packets as f64,
            (user_after - user_before) as f64 * 1_000.0 / packets as f64,
            (system_after - system_before) as f64 * 1_000.0 / packets as f64,
            percentile(&rtts, 0.5),
            percentile(&rtts, 0.95),
        );
    }
    let counters = &responder.counters;
    println!(
        "counters: served={} unparsed={} bad_ticket={} bad_integrity={} unsupported_change={}",
        counters.served.load(Ordering::Relaxed),
        counters.dropped_unparsed.load(Ordering::Relaxed),
        counters.dropped_bad_ticket.load(Ordering::Relaxed),
        counters.dropped_bad_integrity.load(Ordering::Relaxed),
        counters.dropped_unsupported_change.load(Ordering::Relaxed),
    );
}

// ---------------------------------------------------------------------------
// The per-datagram steps of `serve`, one production function at a time. Rows
// marked `before hoist` time the reply-socket selection `serve` ran per
// datagram before it resolved every alternate socket once per thread; they stay
// as the baseline for the hoisted row. Rows marked `daemon` are the client side.

/// A named per-datagram step, timed as a black box.
type Step<'a> = (&'static str, Box<dyn FnMut() + 'a>);

struct Samples {
    name: &'static str,
    ns: Vec<f64>,
}

impl Samples {
    fn report(&mut self) {
        self.ns.sort_by(f64::total_cmp);
        let at = |fraction: f64| {
            let index = ((self.ns.len() - 1) as f64 * fraction).round() as usize;
            self.ns[index]
        };
        println!(
            "{:<44} {:>9.1} {:>9.1} {:>5}",
            self.name,
            at(0.5),
            at(0.95),
            self.ns.len()
        );
    }
}

fn time_per_op(iterations: usize, mut operation: impl FnMut()) -> f64 {
    let started = Instant::now();
    for _ in 0..iterations {
        operation();
    }
    started.elapsed().as_nanos() as f64 / iterations as f64
}

#[test]
#[ignore = "profiling harness; run explicitly with --ignored --nocapture"]
fn stun_packet_steps_benchmark() {
    let samples: usize = std::env::var("STUN_PROFILE_SAMPLES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(41);
    let iterations = 20_000;
    let ticket_key = TicketKey::new(&[9u8; super::TICKET_KEY_BYTES]);
    let now = now_unix_secs();
    let (valid, ticket) = credentials(&ticket_key, now + 300);
    let datagram = request(&valid, 0);
    let change_datagram = request(&valid, 0x02);
    let peer: SocketAddr = "198.51.100.7:40000".parse().expect("peer");
    let observer: SocketAddr = "203.0.113.1:3478".parse().expect("observer");
    let change: SocketAddr = "203.0.113.1:3490".parse().expect("change");
    let other_ip: SocketAddr = "203.0.113.2:3490".parse().expect("other ip");
    let sockets: Vec<Arc<UdpSocket>> = (0..3)
        .map(|_| Arc::new(UdpSocket::bind("127.0.0.1:0").expect("bind")))
        .collect();
    let responders: Responders = [observer, change, other_ip]
        .into_iter()
        .zip(sockets.iter().cloned())
        .collect::<HashMap<_, _>>();
    let mut local_addrs: Vec<SocketAddr> = responders.keys().copied().collect();
    local_addrs.sort_unstable();
    let change_ports = [change.port()];
    let other_address = alternate_address_addr(&local_addrs, &change_ports, observer, true);
    let parsed = parse_binding_request(&datagram).expect("parse");
    let integrity_key = ticket_key.verify(&ticket, now).expect("verify");
    let hoisted_port = alternate_port_addr(&local_addrs, &change_ports, observer)
        .and_then(|alternate| responders.get(&alternate));
    // The daemon's half of one probe: the answer it authenticates and parses.
    let mut answer = ResponseWriter::new(parsed.transaction_id);
    assert!(
        answer.push_address(ATTR_XOR_MAPPED_ADDRESS, peer, parsed.transaction_id, true)
            && other_address.is_some_and(|other| {
                answer.push_address(ATTR_OTHER_ADDRESS, other, parsed.transaction_id, false)
            })
            && answer.finish_in_place(&integrity_key)
    );
    let answer = answer.as_bytes().to_vec();
    assert!(message::verify_integrity(&answer, &integrity_key));
    assert!(message::parse_success(&answer, parsed.transaction_id).is_some());

    // Every step is checked once so the timed loops time the success path.
    assert!(parsed.verify_integrity(&datagram, &integrity_key));
    assert!(hoisted_port.is_some());
    let mut ticket_bytes = [0u8; ticket::TICKET_LEN];
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode_slice(parsed.username, &mut ticket_bytes)
            .expect("decode"),
        ticket::TICKET_LEN
    );

    let mut steps: Vec<Step<'_>> = vec![
        (
            "parse_binding_request (116 B)",
            Box::new(|| {
                black_box(parse_binding_request(black_box(&datagram)).is_ok());
            }),
        ),
        (
            "base64url decode_slice (55 B)",
            Box::new(|| {
                let mut out = [0u8; ticket::TICKET_LEN];
                black_box(URL_SAFE_NO_PAD.decode_slice(black_box(parsed.username), &mut out))
                    .expect("decode");
            }),
        ),
        (
            "TicketKey::verify (tag + derive + Key::new)",
            Box::new(|| {
                black_box(ticket_key.verify(black_box(&ticket), now).is_ok());
            }),
        ),
        (
            "TicketKey::verify, forged tag",
            Box::new(|| {
                let mut forged = ticket;
                forged[ticket::TICKET_LEN - 1] ^= 1;
                black_box(ticket_key.verify(black_box(&forged), now).is_err());
            }),
        ),
        (
            "BindingRequest::verify_integrity",
            Box::new(|| {
                black_box(parsed.verify_integrity(black_box(&datagram), &integrity_key));
            }),
        ),
        (
            "response: XOR-MAPPED + OTHER + integrity",
            Box::new(|| {
                let mut writer = ResponseWriter::new(parsed.transaction_id);
                let pushed = writer.push_address(
                    ATTR_XOR_MAPPED_ADDRESS,
                    black_box(peer),
                    parsed.transaction_id,
                    true,
                ) && other_address.is_none_or(|other| {
                    writer.push_address(ATTR_OTHER_ADDRESS, other, parsed.transaction_id, false)
                }) && writer.finish_in_place(&integrity_key);
                black_box(pushed && writer.as_bytes().len() <= datagram.len());
            }),
        ),
        (
            "before hoist: change-port scan + map + Arc",
            Box::new(|| {
                let respond_from = alternate_port_addr(
                    black_box(&local_addrs),
                    black_box(&change_ports),
                    black_box(observer),
                )
                .and_then(|alternate| responders.get(&alternate))
                .map(Arc::clone);
                black_box(respond_from.is_some());
            }),
        ),
        (
            "change-port select: hoisted socket",
            Box::new(|| {
                black_box(black_box(&hoisted_port).is_some());
            }),
        ),
        (
            "before hoist: plain reply Arc::clone + drop",
            Box::new(|| {
                black_box(Arc::clone(black_box(&sockets[0])));
            }),
        ),
        (
            "parse change-port request (120 B)",
            Box::new(|| {
                black_box(parse_binding_request(black_box(&change_datagram)).is_ok());
            }),
        ),
        (
            "daemon: message::binding_request (build + MI)",
            Box::new(|| {
                black_box(
                    message::binding_request(
                        black_box(&[7; 12]),
                        black_box(&valid.username),
                        0,
                        &valid.key,
                    )
                    .is_some(),
                );
            }),
        ),
        (
            "daemon: message::verify_integrity (80 B)",
            Box::new(|| {
                black_box(message::verify_integrity(
                    black_box(&answer),
                    &integrity_key,
                ));
            }),
        ),
        (
            "daemon: message::parse_success (80 B)",
            Box::new(|| {
                black_box(
                    message::parse_success(black_box(&answer), parsed.transaction_id).is_some(),
                );
            }),
        ),
    ];

    let mut results: Vec<Samples> = steps
        .iter()
        .map(|(name, _)| Samples {
            name,
            ns: Vec::with_capacity(samples),
        })
        .collect();
    for (_, step) in steps.iter_mut() {
        time_per_op(iterations / 4, &mut **step);
    }
    COUNTED.with(|counted| counted.set(true));
    let (allocations_before, _) = allocation_snapshot();
    for round in 0..samples {
        // Rotate the start so no step always runs first after a context switch.
        let count = steps.len();
        for offset in 0..count {
            let index = (round + offset) % count;
            let ns = time_per_op(iterations, &mut *steps[index].1);
            results[index].ns.push(ns);
        }
    }
    let (allocations_after, _) = allocation_snapshot();
    COUNTED.with(|counted| counted.set(false));
    let measured_operations = (samples * iterations * steps.len()) as u64;

    println!("stun per-datagram steps: {samples} samples x {iterations} iterations, rotated order");
    println!("{:<44} {:>9} {:>9} {:>5}", "step", "p50 ns", "p95 ns", "n");
    for result in results.iter_mut() {
        result.report();
    }
    let allocations = (allocations_after - allocations_before) as u64;
    println!("allocation requests across {measured_operations} timed operations: {allocations}");
}
